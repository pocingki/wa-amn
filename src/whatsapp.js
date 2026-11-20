// Fasad WhatsApp: merangkai koneksi, pengirim, ekstraksi pesan, identitas, media, dan bot.
// Membuat instans TIDAK memulai koneksi dan tidak memuat Baileys (dimuat lazy di BaileysAdapter).
import { createConnection as realCreateConnection } from './wa-connection.js';
import * as waSend from './wa-send.js';
import * as waMessage from './wa-message.js';
import * as waIdentity from './wa-identity.js';
import * as mediaMod from './media.js';
import * as convsMod from './conversations.js';
import * as settingsMod from './settings.js';
import * as botMod from './bot.js';
import * as eventsMod from './events.js';

const IGNORED_JID = /@(g\.us|broadcast|newsletter)$/;

const withTimeout = (promise, ms, label) => {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
};

export function createWhatsApp(deps = {}) {
  const createConnection = deps.createConnection || realCreateConnection;
  const extractMessage = deps.extractMessage || ((r) => waMessage.extractMessage(r));
  const resolveIdentity = deps.resolveIdentity || ((k, o) => waIdentity.resolveIdentity(k, o));
  const saveMedia = deps.saveMedia || ((b, o) => mediaMod.saveMedia(b, o));
  const convs = deps.convs || { seenMessage: (id) => convsMod.seenMessage(id), markSeen: (id) => convsMod.markSeen(id) };
  const handleIncoming = deps.handleIncoming || ((m, s) => botMod.handleIncoming(m, s));
  const onStatusUpdate = deps.onStatusUpdate || ((u) => botMod.onStatusUpdate(u));
  const emit = deps.emit || ((t, p) => eventsMod.emit(t, p));
  const now = deps.now || Date.now;
  const mediaTimeoutMs = deps.mediaTimeoutMs ?? 20000;
  const retryDelaysMs = deps.retryDelaysMs ?? [1000, 4000]; // percobaan ulang setelah gagal proses
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const connection =
    deps.connection ||
    createConnection({
      onStatus: (w) => emit('wa:status', { status: w.status, number: w.number }),
      onMessages: async (raws) => { for (const r of raws || []) await handleMessage(r); }, // berurutan
      onReceipts: (list) => {
        for (const u of list || []) {
          try { Promise.resolve(onStatusUpdate(u)).catch((e) => console.error('[wa] receipt gagal:', e)); }
          catch (e) { console.error('[wa] receipt gagal:', e); }
        }
      },
    });

  const getAdapter = () => connection.adapter();

  const sender =
    deps.sender ||
    waSend.createSender({
      transport: {
        sendText: (j, t) => connection.adapter().sendText(j, t),
        sendImage: (j, b, c) => connection.adapter().sendImage(j, b, c),
        sendPresence: (j, s) => connection.adapter().sendPresence(j, s),
        isConnected: () => connection.wa.status === 'connected',
      },
      getSettings: () => settingsMod.get(),
    });

  const sendText = (jid, text) => sender.sendText(jid, text);
  const sendImage = (jid, buf, caption) => sender.sendImage(jid, buf, caption);
  const inflight = new Set(); // id yang sedang diproses; gagal tidak masuk seen supaya bisa dicoba lagi

  async function handleMessage(raw) {
    let waId = null;
    let held = false; // hanya pemilik slot inflight yang boleh melepasnya
    let commit = false; // true = sengaja selesai (tersimpan atau memang diabaikan); gagal proses tidak menandai seen
    try {
      const key = raw?.key || {};
      const rjid = key.remoteJid || '';
      if (!rjid || IGNORED_JID.test(rjid)) return; // grup, broadcast, status, newsletter
      waId = key.id || null;
      const fromMe = !!key.fromMe;
      if (fromMe && waId && sender.wasSentBySystem(waId)) return; // gema pesan sistem
      if (waId) {
        if (convs.seenMessage(waId) || inflight.has(waId)) return;
        inflight.add(waId);
        held = true;
      }

      // Seluruh langkah (parse -> identitas -> media -> simpan/proses) diulang bila gagal.
      // Aman diulang: pipeline mengenali id WA yang sama dan tidak menggandakan pesan atau balasan.
      let lastErr;
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
        if (attempt) await sleep(retryDelaysMs[attempt - 1]);
        try {
          commit = await processOnce(raw, key, rjid, waId, fromMe);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          console.error(`[wa] gagal memproses pesan (percobaan ${attempt + 1}/${retryDelaysMs.length + 1}):`, e);
        }
      }
      if (lastErr) {
        // Tidak ditandai seen: bila WhatsApp mengirim ulang, pesan diproses lagi. Dicatat agar tidak hilang diam-diam.
        emit('wa:process_failed', { waId, error: String(lastErr?.message || lastErr).slice(0, 200) });
      }
    } catch (err) {
      console.error('[wa] gagal memproses pesan:', err);
    } finally {
      if (held) {
        if (commit) convs.markSeen(waId);
        inflight.delete(waId);
      }
    }
  }

  // Satu percobaan. Mengembalikan true bila selesai dengan sengaja (diproses atau memang diabaikan).
  async function processOnce(raw, key, rjid, waId, fromMe) {
    {
      const ext = extractMessage(raw);
      if (!ext) return true;
      if (fromMe && (ext.kind === 'reaction' || ext.kind === 'system')) return true;

      const id = await resolveIdentity(
        { remoteJid: key.remoteJid, remoteJidAlt: key.remoteJidAlt, participant: key.participant, participantAlt: key.participantAlt },
        { lidToPhone: (l) => getAdapter()?.lidToPhone(l) },
      );
      const sec = Number(raw.messageTimestamp);
      const ts = sec > 0 ? sec * 1000 : now();

      let mediaId = null;
      let mediaError = null;
      if (ext.hasMedia) {
        try {
          const buf = await withTimeout(Promise.resolve().then(() => getAdapter().downloadMedia(raw)), mediaTimeoutMs, 'Unduh media melewati batas waktu');
          ({ mediaId } = await saveMedia(buf, { mime: ext.mime, kind: ext.kind, name: ext.fileName }));
        } catch (e) {
          mediaId = null;
          mediaError = e?.message || String(e);
        }
      }

      if (ext.kind === 'text' && !String(ext.text || '').trim()) return true;

      const envelope = {
        waId,
        jid: id.jid || rjid,
        phone: id.phone || null,
        lid: id.lid || null,
        name: raw.pushName || '',
        ts,
        kind: ext.kind,
        text: ext.text || '',
        caption: ext.caption || '',
        mediaId,
        mediaError,
        fromMe,
        fromPhone: fromMe,
        source: { platform: '', adId: '', ctwaClid: '', sourceUrl: '', referralCode: '', ...(ext.source || {}) },
      };
      await Promise.resolve(handleIncoming(envelope, sendText));
      return true;
    }
  }

  return {
    wa: connection.wa,
    start: () => connection.start(),
    stop: () => connection.stop(),
    logout: () => connection.logout(),
    sendText,
    sendImage,
    handleMessage,
    getAdapter,
  };
}

// ---------------------------------------------------------------- Pemilih provider (baileys | convia)
// Mode: env WA_PROVIDER menang atas settings.waProvider; keduanya kosong -> 'baileys'.
// Mode 'convia' dengan konfigurasi tidak lengkap GAGAL TEGAS (status 'misconfigured'), tidak jatuh diam-diam ke Baileys.
// Jaringan: server mendengarkan BIND_HOST (default 127.0.0.1). Webhook Convia butuh URL HTTPS publik lewat
// reverse proxy/tunnel yang meneruskan ke POST /webhooks/convia (BIND_HOST sengaja tidak diubah).

const MODES = ['baileys', 'convia'];
const clean = (v) => String(v ?? '').trim();

/** Tentukan mode. Nilai tak dikenal -> mode 'invalid' (gagal tegas), nilainya tidak dicetak. */
export function resolveProviderMode({ env = process.env, getSettings = () => settingsMod.get() } = {}) {
  let raw = clean(env.WA_PROVIDER).toLowerCase();
  let source = 'env';
  if (!raw) {
    source = 'setting';
    try { raw = clean(getSettings()?.waProvider).toLowerCase(); } catch { raw = ''; }
  }
  if (!raw) return { mode: 'baileys', source: 'default' };
  if (MODES.includes(raw)) return { mode: raw, source };
  const where = source === 'env' ? 'WA_PROVIDER' : 'setting waProvider';
  return { mode: 'invalid', source, error: `Nilai provider WhatsApp tidak dikenal (${where}). Pakai 'baileys' atau 'convia'.` };
}

/** Baca konfigurasi Convia dari env. `missing` hanya berisi NAMA env, tidak pernah nilainya. */
export function conviaConfigFromEnv(env = process.env) {
  const apiKey = clean(env.CONVIA_API_KEY);
  const webhookSecret = clean(env.CONVIA_WEBHOOK_SECRET) || clean(env.CONVIA_SIGNING_SECRET); // alias diterima
  const missing = [];
  if (!apiKey) missing.push('CONVIA_API_KEY');
  if (!webhookSecret) missing.push('CONVIA_WEBHOOK_SECRET (atau CONVIA_SIGNING_SECRET)');
  const config = { apiKey, webhookSecret };
  const phoneNumberId = clean(env.CONVIA_PHONE_NUMBER_ID);
  if (phoneNumberId) config.phoneNumberId = phoneNumberId;
  const baseUrl = clean(env.CONVIA_BASE_URL);
  if (baseUrl) config.baseUrl = baseUrl; // kosong -> biarkan default milik provider
  return { ok: missing.length === 0, missing, config };
}

// Fasad untuk mode yang tidak bisa jalan: status 'misconfigured', pesan jelas, tidak melempar saat start/logout.
function misconfiguredFacade(mode, message, now) {
  const wa = { status: 'misconfigured', qr: null, number: null, error: message, since: now(), reconnectAttempts: 0 };
  return {
    wa,
    start: async () => { console.error('[wa]', message); },
    stop: async () => {},
    logout: async () => ({ message }),
    sendText: async () => { throw new Error(message); },
    handleMessage: async () => {},
    getAdapter: () => null,
    handleWebhook: async () => ({ status: 503, body: { error: 'Provider WhatsApp belum dikonfigurasi' } }), // ASUMSI: Convia boleh mengirim ulang
    provider: null,
    mode,
  };
}

/**
 * Rakit fasad sesuai mode. Semua dependensi bisa diinjeksi (tes memakai provider palsu).
 * Mode 'baileys' memakai createWhatsApp() apa adanya; perilakunya tidak berubah.
 */
export function createWhatsAppFacade({
  env = process.env,
  getSettings,
  createWa = createWhatsApp,
  createConviaProvider = null,
  conviaLoadError = null,
  now = Date.now,
} = {}) {
  const sel = resolveProviderMode({ env, ...(getSettings ? { getSettings } : {}) });

  if (sel.mode === 'baileys') {
    return {
      ...createWa(),
      handleWebhook: async () => ({ status: 404, body: { error: 'Tidak ditemukan' } }), // webhook hanya ada di mode convia
      provider: null,
      mode: 'baileys',
    };
  }
  if (sel.mode === 'invalid') return misconfiguredFacade('invalid', sel.error, now);

  const cfg = conviaConfigFromEnv(env);
  if (!cfg.ok) {
    return misconfiguredFacade('convia', `Mode Convia butuh env: ${cfg.missing.join(', ')}. Lengkapi lalu restart; tidak beralih ke Baileys.`, now);
  }
  if (conviaLoadError || typeof createConviaProvider !== 'function') {
    return misconfiguredFacade('convia', 'Modul provider Convia (src/wa-convia-provider.js) tidak bisa dimuat. Tidak beralih ke Baileys.', now);
  }
  let provider;
  try {
    provider = createConviaProvider(cfg.config);
  } catch (e) {
    console.error('[wa] provider Convia gagal dibuat:', e?.code || e?.name || 'Error'); // tanpa pesan galat: bisa memuat nilai konfigurasi
    return misconfiguredFacade('convia', 'Provider Convia gagal dibuat dari konfigurasi env. Periksa nilai CONVIA_*. Tidak beralih ke Baileys.', now);
  }
  return {
    wa: provider.wa,
    start: () => provider.start(),
    stop: () => provider.stop(),
    logout: () => provider.logout(),
    sendText: (jid, text) => provider.sendText(jid, text),
    handleMessage: async () => {}, // khusus Baileys; di Convia pesan masuk lewat handleWebhook
    getAdapter: () => provider.getAdapter(),
    handleWebhook: (rawBody, headers) => provider.handleWebhook(rawBody, headers),
    provider,
    mode: 'convia',
  };
}

// Modul provider Convia dimuat hanya bila mode convia dan env lengkap, supaya mode baileys tidak bergantung padanya.
let conviaFactory = null;
let conviaLoadError = null;
if (resolveProviderMode().mode === 'convia' && conviaConfigFromEnv().ok) {
  try {
    ({ createConviaProvider: conviaFactory } = await import('./wa-convia-provider.js'));
  } catch (e) {
    conviaLoadError = e;
    console.error('[wa] modul provider Convia gagal dimuat:', e?.code || e?.name || 'Error');
  }
}

const inst = createWhatsAppFacade({ createConviaProvider: conviaFactory, conviaLoadError });
export const { wa, start, stop, logout, sendText, handleMessage, getAdapter, handleWebhook, provider, mode } = inst;
/** Kirim gambar: hanya jalur Baileys. Convia/Meta: belum didukung (melempar NOT_SUPPORTED). */
export const sendImage = (jid, buf, caption) => {
  if (typeof inst.sendImage === 'function') return inst.sendImage(jid, buf, caption);
  const e = new Error('Pengiriman gambar belum didukung pada koneksi ini.'); e.code = 'NOT_SUPPORTED'; e.retryable = false;
  return Promise.reject(e);
};