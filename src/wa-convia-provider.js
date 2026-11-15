// Provider WhatsApp API resmi (Convia): merangkai API (S1), pengarah webhook (S8), inbound (S3)
// dan pengirim (wa-send.js). Membuat instans TIDAK memulai koneksi dan tidak menyentuh jaringan.
// Modul default dimuat lazy (dynamic import) supaya tes cukup memakai dependensi palsu.
//
// ASUMSI (tidak ada di dokumen Convia yang dilampirkan):
//  - Convia mungkin mengirim ulang webhook bila kita balas 5xx; belum diketahui. Kebijakan 500 hanya agar ada kesempatan itu.
//  - Nama header tanda tangan dibaca oleh webhook.verifyRequest (S8); provider hanya meneruskan header apa adanya.
//  - Status 'connected' berarti health() ok; tidak ada sinyal "sesi" lain dari Convia.
import * as waSend from './wa-send.js';

const DEFAULT_POLL_MS = 60_000;
const NOT_RETRYABLE = new Set(['window_closed', 'auth', 'validation', 'config', 'not_found']);

const fail = (code, message, retryable, cause) => {
  const e = new Error(message);
  e.code = code;
  e.retryable = retryable;
  if (cause) e.cause = cause;
  return e;
};

// Samarkan nomor: hanya 4 digit terakhir yang tampil di log.
export const maskPhone = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length > 4 ? `***${d.slice(-4)}` : '***';
};

// Header tanpa membedakan huruf besar/kecil: simpan kunci asli + salinan huruf kecil.
export function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' && typeof headers.get === 'function'
    ? [...headers.entries()]
    : Object.entries(headers);
  for (const [k, v] of entries) {
    const val = Array.isArray(v) ? v[0] : v;
    out[k] = val;
    out[String(k).toLowerCase()] = val;
  }
  return out;
}

// Tujuan kirim dari jid: bsuid bila berakhiran @convia, selain itu digit nomor.
export function destinationFromJid(jid) {
  const s = String(jid || '');
  const at = s.indexOf('@');
  const local = at >= 0 ? s.slice(0, at) : s;
  if (s.endsWith('@convia')) {
    if (!local) throw fail('INVALID_JID', 'Tujuan WhatsApp tidak valid.', false);
    return local;
  }
  const digits = local.replace(/\D/g, '');
  if (!digits) throw fail('INVALID_JID', 'Tujuan WhatsApp tidak valid.', false);
  return digits;
}

export function createConviaProvider({ apiKey, webhookSecret, phoneNumberId, baseUrl, deps = {} } = {}) {
  const log = deps.log || ((...a) => console.error(...a));
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const setIntervalFn = deps.setInterval || setInterval; // timer diinjeksi supaya tes tanpa waktu nyata
  const clearIntervalFn = deps.clearInterval || clearInterval;

  const wa = { status: 'disconnected', qr: null, number: null, error: null, since: now(), reconnectAttempts: 0 };
  const setStatus = (s, error = null) => {
    if (s !== wa.status) { wa.status = s; wa.since = now(); }
    wa.error = error;
  };

  let ready = null; // promise inisialisasi lazy
  let api = null;
  let webhook = null;
  let inbound = null;
  let sender = null;
  let timer = null;
  let stopped = false;

  async function build() {
    const emit = deps.emit || (await import('./events.js')).emit;
    const convsMod = deps.convs ? null : await import('./conversations.js');
    const convs = deps.convs || { seenMessage: (id) => convsMod.seenMessage(id), markSeen: (id) => convsMod.markSeen(id) };
    const botMod = deps.handleIncoming && deps.onStatusUpdate ? null : await import('./bot.js');
    const handleIncoming = deps.handleIncoming || ((m, s) => botMod.handleIncoming(m, s));
    const onStatusUpdate = deps.onStatusUpdate || ((u) => botMod.onStatusUpdate(u));
    const mediaMod = deps.saveMedia ? null : await import('./media.js');
    const saveMedia = deps.saveMedia || ((b, o) => mediaMod.saveMedia(b, o));
    const settingsMod = deps.getSettings ? null : await import('./settings.js');
    const getSettings = deps.getSettings || (() => settingsMod.get());

    if (deps.api) api = deps.api;
    else {
      const createApi = deps.createConviaApi || (await import('./wa-convia-api.js')).createConviaApi;
      api = createApi({ apiKey, baseUrl, phoneNumberId, fetchImpl: deps.fetchImpl });
    }
    webhook = deps.webhook || (await import('./wa-convia-webhook-compat.js')).createWebhookCompat({});

    // Transport untuk pengirim: bentuk sama dengan jalur Baileys.
    const transport = {
      sendText: async (jid, text) => {
        try {
          const res = await api.sendText(destinationFromJid(jid), text);
          return { waId: res?.messageId ? `convia:${res.messageId}` : undefined }; // sama dengan waId envelope masuk (anti-gema)
        } catch (err) {
          if (err && typeof err === 'object' && err.retryable === undefined) err.retryable = !NOT_RETRYABLE.has(err.kind);
          throw err;
        }
      },
      sendPresence: async (jid, state) => {
        if (state === 'composing') await api.sendTyping(destinationFromJid(jid));
      },
      isConnected: () => wa.status === 'connected',
    };
    sender = deps.sender || waSend.createSender({ transport, getSettings, sleep, now });

    const sendTextForInbound = (jid, text) => providerSendText(jid, text);
    if (deps.inbound) inbound = deps.inbound;
    else {
      const createIn = deps.createInbound || (await import('./wa-convia-inbound.js')).createInbound;
      inbound = createIn({
        handleIncoming, saveMedia, convs, emit, now, fetchImpl: deps.fetchImpl,
        retryDelaysMs: deps.retryDelaysMs ?? [1000, 4000], sleep,
        mediaTimeoutMs: deps.mediaTimeoutMs ?? 20000, sendText: sendTextForInbound,
      });
    }
    return { onStatusUpdate };
  }

  const init = () => (ready ||= build().catch((e) => { ready = null; throw e; }));

  async function providerSendText(jid, text) {
    await init();
    try {
      return await sender.sendText(jid, text);
    } catch (e) {
      const kind = e?.kind || e?.cause?.kind;
      if (kind === 'window_closed') {
        // Tidak jatuh ke template: pesan bebas ditolak, laporkan jelas.
        throw fail('WINDOW_CLOSED', 'Jendela percakapan WhatsApp sudah tertutup; pesan tidak dikirim (template tidak dikirim otomatis).', false, e);
      }
      throw e;
    }
  }

  async function checkHealth() {
    try {
      const h = await api.health();
      if (stopped) return;
      if (h?.ok) { wa.reconnectAttempts = 0; setStatus('connected'); }
      else { wa.reconnectAttempts++; setStatus('disconnected', `Convia tidak sehat (http ${h?.http ?? '?'})`); }
    } catch (e) {
      if (stopped) return;
      wa.reconnectAttempts++;
      setStatus('disconnected', `Health check gagal (${e?.kind || 'error'})`); // tanpa isi error mentah
    }
  }

  async function start() {
    stopped = false;
    setStatus('connecting');
    try { await init(); } catch (e) {
      setStatus('disconnected', `Provider Convia gagal dimulai (${e?.kind || e?.code || 'error'})`);
      log('[convia] gagal inisialisasi:', e?.kind || e?.code || 'error');
      return;
    }
    await checkHealth();
    if (pollIntervalMs > 0 && !timer && !stopped) {
      timer = setIntervalFn(() => { checkHealth().catch(() => {}); }, pollIntervalMs);
      timer?.unref?.();
    }
  }

  async function stop() {
    stopped = true;
    if (timer) { clearIntervalFn(timer); timer = null; }
    setStatus('disconnected');
  }

  async function logout() {
    // Tidak ada QR/sesi di mode API resmi; tidak melempar.
    return { ok: false, message: 'Mode API resmi tidak memakai QR; tidak ada sesi untuk logout. Ubah kunci API di pengaturan/env bila perlu.' };
  }

  const reply = (status, body) => ({ status, body });

  async function handleWebhook(rawBody, headers) {
    let ctx;
    try { ctx = await init(); } catch (e) {
      log('[convia] webhook: init gagal:', e?.kind || e?.code || 'error');
      return reply(500, { ok: false, error: 'provider_unavailable' });
    }
    // 1) Tanda tangan atas byte asli. Tanpa secret -> tolak (tidak pernah menerima tanpa verifikasi).
    let valid = false;
    try { valid = !!webhookSecret && webhook.verifyRequest(rawBody, normalizeHeaders(headers), webhookSecret) === true; } catch { valid = false; }
    if (!valid) return reply(401, { ok: false, error: 'invalid_signature' });

    // 2) Parse
    let parsed;
    try { parsed = webhook.parseWebhook(rawBody); } catch { parsed = { ok: false, reason: 'parse_error' }; }
    if (!parsed?.ok) return reply(400, { ok: false, error: 'invalid_payload', reason: String(parsed?.reason || 'unknown').slice(0, 80) });

    // 3) Status update (receipt) -> onStatusUpdate; kegagalan di sini tidak memicu kirim ulang.
    let status;
    let env;
    try {
      status = webhook.toStatusUpdate(parsed);
      if (!status) env = webhook.toEnvelope(parsed, { now });
    } catch { return reply(400, { ok: false, error: 'invalid_payload', reason: 'map_error' }); }
    if (status) {
      try { await ctx.onStatusUpdate(status); } catch (e) { log('[convia] status update gagal:', e?.message ? String(e.message).slice(0, 80) : 'error'); }
      return reply(200, { ok: true, handled: 'status' });
    }

    // 4) Pesan masuk
    if (!env || env.skip) return reply(200, { ok: true, skipped: String(env?.reason || 'skipped').slice(0, 80) });
    let result;
    try { result = await inbound.processEnvelope(env); } catch (e) {
      log(`[convia] proses pesan error (${env.waId}, ${maskPhone(env.phone)}):`, e?.code || 'error');
      return reply(500, { ok: false, error: 'process_failed' });
    }
    if (result === 'processed') return reply(200, { ok: true, result });
    if (result === 'duplicate' || result === 'skipped') return reply(200, { ok: true, result });
    return reply(500, { ok: false, error: 'process_failed' }); // 'failed' atau nilai tak dikenal
  }

  // Adapter minimal untuk pemanggil yang memakai getAdapter() (jalur Baileys): tanpa LID/unduh media via sesi.
  const adapter = {
    provider: 'convia',
    sendText: (jid, text) => providerSendText(jid, text),
    sendPresence: async (jid, state) => { if (state === 'composing') { await init(); await api.sendTyping(destinationFromJid(jid)); } },
    lidToPhone: async () => null,
    downloadMedia: async () => { throw fail('NOT_SUPPORTED', 'Media diunduh lewat mediaUrl pada inbound Convia.', false); },
  };

  return { wa, start, stop, logout, sendText: providerSendText, getAdapter: () => adapter, handleWebhook };
}
