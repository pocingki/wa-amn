// Pipeline masuk Convia: dedupe, guard inflight, unduh media, lalu handleIncoming dengan retry.
// Meniru semantik andal handleMessage/processOnce di src/whatsapp.js (jalur Baileys).
// Tidak membuka jaringan sendiri: fetch, waktu, sleep, penyimpanan media, dan pipeline semuanya diinjeksi.
//
// ASUMSI (tidak ada di dokumen Convia yang dilampirkan):
//  - media_url bisa diunduh dengan GET biasa tanpa header Authorization (API key TIDAK dikirim ke host media).
//  - Masa berlaku media_url tidak diketahui; unduhan dicoba sekali per pesan (tidak diulang saat retry proses).
//  - Hanya URL https yang diunduh.
//  - handleIncoming idempoten terhadap waId yang sama (seperti pipeline di jalur Baileys), sehingga retry
//    tidak menggandakan pesan atau balasan. Modul ini sendiri tidak pernah mengirim balasan.

const noop = () => {};
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Samarkan deretan angka panjang (nomor telepon) di teks galat: sisakan 4 digit terakhir.
const maskDigits = (s) => String(s ?? '').replace(/\+?\d{8,}/g, (m) => '***' + m.slice(-4));
const safeError = (e) => maskDigits(e?.message || e).slice(0, 200);

// Galat unduh media yang pesannya aman ditampilkan (tanpa URL bertanda tangan).
class MediaDownloadError extends Error {}

export function createInbound({
  handleIncoming,
  saveMedia,
  convs,
  emit = noop,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  retryDelaysMs = [1000, 4000],
  sleep = defaultSleep,
  mediaTimeoutMs = 20000,
  sendText,
} = {}) {
  if (typeof handleIncoming !== 'function') throw new TypeError('createInbound: handleIncoming wajib');
  if (typeof saveMedia !== 'function') throw new TypeError('createInbound: saveMedia wajib');
  if (!convs || typeof convs.seenMessage !== 'function' || typeof convs.markSeen !== 'function') {
    throw new TypeError('createInbound: convs.seenMessage dan convs.markSeen wajib');
  }

  const inflight = new Set(); // waId yang sedang diproses; gagal tidak masuk seen supaya bisa dicoba lagi

  const safeEmit = (type, payload) => {
    try { emit(type, payload); } catch (e) { console.error(`[convia] emit ${type} gagal:`, e?.name || 'Error'); }
  };

  // Pesan yang memang tidak perlu diproses (mirip aturan di processOnce jalur Baileys).
  function shouldSkip(env) {
    const text = String(env.text ?? '').trim();
    const caption = String(env.caption ?? '').trim();
    if (env.fromMe && (env.kind === 'reaction' || env.kind === 'system')) return true;
    if (env.fromMe && !text && !caption && !env.mediaUrl && !env.mediaId) return true;
    if (env.kind === 'text' && !text) return true;
    return false;
  }

  // Unduh media dengan batas waktu. Gagal TIDAK menggagalkan pesan: kembalikan { mediaId:null, mediaError }.
  async function fetchMedia(env) {
    const { mediaUrl } = env;
    let parsedUrl;
    try { parsedUrl = new URL(String(mediaUrl)); } catch { parsedUrl = null; }
    if (!parsedUrl || parsedUrl.protocol !== 'https:') {
      return { mediaId: null, mediaError: 'URL media tidak valid' };
    }
    if (typeof fetchImpl !== 'function') return { mediaId: null, mediaError: 'Unduh media tidak tersedia' };

    const ctl = new AbortController();
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        ctl.abort();
        rej(new MediaDownloadError('Unduh media melewati batas waktu'));
      }, mediaTimeoutMs);
    });
    const work = (async () => {
      const res = await fetchImpl(String(mediaUrl), { method: 'GET', signal: ctl.signal });
      if (!res || !res.ok) throw new MediaDownloadError(`Unduh media gagal (HTTP ${res?.status ?? '?'})`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = String(res.headers?.get?.('content-type') || '').split(';')[0].trim();
      return { buffer, contentType };
    })();
    work.catch(noop); // cegah unhandled rejection bila timeout menang lebih dulu

    let got;
    try {
      got = await Promise.race([work, timeout]);
    } catch (e) {
      return { mediaId: null, mediaError: e instanceof MediaDownloadError ? e.message : 'Unduh media gagal' };
    } finally {
      clearTimeout(timer);
    }

    try {
      const saved = await saveMedia(got.buffer, {
        mime: env.mime || env.mimeType || got.contentType || '',
        kind: env.kind,
        name: env.fileName || env.filename || '',
      });
      return { mediaId: saved?.mediaId ?? null, mediaError: null };
    } catch (e) {
      return { mediaId: null, mediaError: `Simpan media gagal: ${safeError(e)}` };
    }
  }

  async function processEnvelope(envelope) {
    if (!envelope || !envelope.waId) {
      console.error('[convia] envelope tanpa waId dilewati');
      return 'skipped';
    }
    const waId = String(envelope.waId);
    if (shouldSkip(envelope)) return 'skipped';

    let held = false; // hanya pemilik slot inflight yang boleh melepasnya
    try {
      // Cek seen + inflight + ambil slot dalam satu putaran sinkron (tanpa await) agar tidak ada celah balapan.
      if (inflight.has(waId) || convs.seenMessage(waId)) return 'duplicate';
      inflight.add(waId);
      held = true;

      // Media diunduh sekali, di luar loop retry, supaya retry tidak menumpuk berkas yatim.
      let mediaId = envelope.mediaId ?? null;
      let mediaError = envelope.mediaError ?? null;
      if (envelope.mediaUrl && !mediaId) ({ mediaId, mediaError } = await fetchMedia(envelope));

      const ts = Number(envelope.ts) > 0 ? Number(envelope.ts) : now();
      // Salinan: envelope masukan tidak diubah. phone/lid diteruskan apa adanya (BSUID tetap di lid, phone tetap null).
      const env = { ...envelope, ts, mediaId, mediaError };

      if (envelope.identityUnresolved) safeEmit('wa:identity_unresolved', { waId }); // tanpa isi pesan

      let lastErr = null;
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
        if (attempt) await sleep(retryDelaysMs[attempt - 1]);
        try {
          await Promise.resolve(handleIncoming(env, sendText));
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          // Log tanpa isi pesan/nomor: hanya id, nomor percobaan, dan jenis galat.
          console.error(`[convia] gagal memproses ${waId} (percobaan ${attempt + 1}/${retryDelaysMs.length + 1}):`, e?.code || e?.name || 'Error');
        }
      }

      if (lastErr) {
        // Tidak ditandai seen: bila Convia mengirim ulang, pesan diproses lagi. Dicatat agar tidak hilang diam-diam.
        safeEmit('wa:process_failed', { waId, error: safeError(lastErr) });
        return 'failed';
      }

      try { convs.markSeen(waId); } catch (e) {
        // Pesan sudah terproses; gagal menandai seen hanya berisiko diproses ulang (pipeline idempoten).
        console.error(`[convia] markSeen ${waId} gagal:`, e?.code || e?.name || 'Error');
      }
      return 'processed';
    } catch (e) {
      console.error(`[convia] galat tak terduga ${waId}:`, e?.code || e?.name || 'Error');
      safeEmit('wa:process_failed', { waId, error: safeError(e) });
      return 'failed';
    } finally {
      if (held) inflight.delete(waId);
    }
  }

  return { processEnvelope };
}
