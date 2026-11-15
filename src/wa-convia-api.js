// Klien API Convia (REST publik): kirim teks, tandai dibaca, indikator mengetik, health.
// Semua dependensi (fetch, waktu, timer) diinjeksi. Tidak ada logging di sini; galat TIDAK pernah memuat
// apiKey, isi pesan, nomor tujuan, maupun teks galat mentah dari server (bisa saja memantulkan isi permintaan).
//
// ASUMSI (tidak ada di dokumen yang tersedia; verifikasi dengan Convia nyata):
// - Bentuk galat server {error:{code,message}}; nilai code dinormalisasi (huruf kecil, tanpa simbol) sebelum dipetakan.
// - Header Retry-After berupa detik (bilangan bulat) atau tanggal HTTP; selain itu retryAfterMs = null.
// - markRead dan sendTyping dikirim dengan body '{}' (bukan kosong) supaya server tidak menolak JSON kosong.
// - Format nomor tujuan (E.164 dengan/tanpa '+') diteruskan apa adanya; normalisasi menjadi tugas pemanggil.
// - Respons 2xx tanpa data.message_id dianggap terkirim (id/status/timestamp = null) agar tidak memicu kirim ganda.
// - Kode HTTP 4xx yang tak dikenal dipetakan ke 'validation'; 5xx ke 'server'.
// - /health boleh dipanggil dengan header Authorization yang sama.

const DEFAULT_BASE_URL = 'https://api.convia.id/api/v1/public';
const TYPING_MIN_GAP_MS = 3000; // batas Convia: 1 permintaan mengetik per 3 dtk per customer
const TYPING_MAP_MAX = 1000;

// Kode galat Convia (dinormalisasi) -> kind
const CODE_KIND = {
  validationerror: 'validation',
  unauthorized: 'auth',
  forbidden: 'auth',
  windowclosed: 'window_closed',
  configurationerror: 'config',
  notfound: 'not_found',
  ratelimitexceeded: 'rate_limit',
};

const MESSAGES = {
  auth: 'Kunci API Convia ditolak. Periksa CONVIA_API_KEY.',
  window_closed: 'Jendela 24 jam percakapan sudah tertutup. Tunggu pelanggan membalas atau gunakan template.',
  rate_limit: 'Batas permintaan Convia tercapai. Coba lagi beberapa saat.',
  validation: 'Permintaan ke Convia tidak valid. Periksa nomor tujuan dan isi pesan.',
  config: 'Konfigurasi Convia belum lengkap atau salah. Periksa pengaturan nomor WhatsApp di Convia.',
  not_found: 'Data tidak ditemukan di Convia (pesan atau percakapan tidak ada).',
  server: 'Server Convia bermasalah. Coba lagi nanti.',
  timeout: 'Convia tidak menjawab tepat waktu. Coba lagi.',
  unreachable: 'Tidak bisa menjangkau Convia. Periksa koneksi internet dan CONVIA_BASE_URL.',
};

export class ConviaError extends Error {
  constructor(kind, { message, code = null, http = null, retryAfterMs = null } = {}) {
    super(message || MESSAGES[kind] || 'Galat Convia.');
    this.name = 'ConviaError';
    this.kind = kind;
    this.code = code;
    this.http = http;
    this.retryAfterMs = retryAfterMs;
  }
}

const normCode = (c) => String(c).toLowerCase().replace(/[^a-z0-9]/g, '');

// Kode dari server hanya disimpan bila berbentuk token aman (bukan teks bebas).
const safeCode = (c) => (typeof c === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(c) ? c : null);

function parseRetryAfter(headers, now) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, t - now());
  return null;
}

function kindFromHttp(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'validation';
}

export function createConviaApi({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  phoneNumberId,
  fetchImpl = fetch,
  timeoutMs = 10000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new ConviaError('config', { message: 'CONVIA_API_KEY belum diisi.' });
  }
  if (typeof fetchImpl !== 'function') {
    throw new ConviaError('config', { message: 'Implementasi fetch tidak tersedia.' });
  }
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = apiKey.trim();
  const typingAt = new Map(); // to -> waktu permintaan mengetik terakhir

  // Satu permintaan HTTP. Mengembalikan { status, headers, json } atau melempar ConviaError (timeout/unreachable).
  async function exchange(method, path, body) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => {
        controller.abort();
        reject(new ConviaError('timeout'));
      }, timeoutMs);
    });
    timeout.catch(() => {}); // cegah unhandled rejection bila fetch selesai lebih dulu
    const work = (async () => {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, headers: res.headers, json };
    })();
    work.catch(() => {}); // fetch yang di-abort menolak belakangan; sudah ditangani oleh race
    try {
      return await Promise.race([work, timeout]);
    } catch (e) {
      if (e instanceof ConviaError) throw e;
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new ConviaError('timeout');
      // Sengaja tanpa cause/teks asli: galat jaringan bisa memuat URL (yang berisi nomor tujuan).
      throw new ConviaError('unreachable');
    } finally {
      clearTimer(timer);
    }
  }

  // Ubah respons non-2xx menjadi ConviaError.
  function toError(res) {
    const errObj = res.json && typeof res.json === 'object' ? res.json.error : null;
    const rawCode = errObj && typeof errObj === 'object' ? errObj.code : null;
    const mapped = rawCode != null ? CODE_KIND[normCode(rawCode)] : null;
    const kind = mapped || kindFromHttp(res.status);
    const retryAfterMs = kind === 'rate_limit' ? parseRetryAfter(res.headers, now) : null;
    let message = MESSAGES[kind];
    if (kind === 'rate_limit' && retryAfterMs != null) {
      message = `${message} Coba lagi dalam ${Math.max(1, Math.ceil(retryAfterMs / 1000))} detik.`;
    }
    return new ConviaError(kind, { message, code: safeCode(rawCode), http: res.status, retryAfterMs });
  }

  const isOk = (res) => res.status >= 200 && res.status < 300;

  async function call(method, path, body) {
    const res = await exchange(method, path, body);
    if (!isOk(res)) throw toError(res);
    return res;
  }

  const needStr = (v, nama) => {
    if (typeof v !== 'string' || !v.trim()) {
      throw new ConviaError('validation', { message: `${nama} wajib diisi.` });
    }
    return v.trim();
  };

  return {
    // Kirim pesan teks. replyToMessageId opsional.
    async sendText(to, text, { replyToMessageId } = {}) {
      const phone = needStr(to, 'Nomor tujuan');
      if (typeof text !== 'string' || !text.length) {
        throw new ConviaError('validation', { message: 'Isi pesan wajib diisi.' });
      }
      const body = { phone_number: phone, channel: 'whatsapp', message_type: 'text', content: text };
      if (phoneNumberId) body.whatsapp_phone_number_id = String(phoneNumberId);
      if (replyToMessageId) body.reply_to_message_id = String(replyToMessageId);
      const res = await call('POST', '/messages/send', body);
      const d = res.json && typeof res.json === 'object' && res.json.data && typeof res.json.data === 'object' ? res.json.data : {};
      return {
        messageId: d.message_id ?? null,
        status: d.status ?? null,
        timestamp: d.timestamp ?? null,
      };
    },

    // Tandai pesan masuk sudah dibaca.
    async markRead(messageId) {
      const id = needStr(messageId, 'ID pesan');
      await call('POST', `/messages/${encodeURIComponent(id)}/read`, {});
    },

    // Indikator mengetik. Dibatasi 1 per 3 dtk per customer (lokal); 429 dari server diabaikan.
    async sendTyping(to) {
      const phone = needStr(to, 'Nomor tujuan');
      const t = now();
      const last = typingAt.get(phone);
      if (last !== undefined && t - last < TYPING_MIN_GAP_MS) return;
      if (typingAt.size >= TYPING_MAP_MAX) {
        for (const [k, v] of typingAt) { if (t - v >= TYPING_MIN_GAP_MS) typingAt.delete(k); }
        if (typingAt.size >= TYPING_MAP_MAX) typingAt.clear();
      }
      typingAt.set(phone, t);
      try {
        await call('POST', `/conversations/${encodeURIComponent(phone)}/typing`, {});
      } catch (e) {
        if (e instanceof ConviaError && e.kind === 'rate_limit') return;
        throw e;
      }
    },

    // Cek kesehatan; tidak pernah melempar. http = null bila tak terjangkau/timeout.
    async health() {
      try {
        const res = await exchange('GET', '/health');
        return { ok: isOk(res), http: res.status };
      } catch {
        return { ok: false, http: null };
      }
    },
  };
}
