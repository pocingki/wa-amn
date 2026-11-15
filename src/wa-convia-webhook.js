// Webhook Convia (Format A): verifikasi tanda tangan, parse, lalu ubah jadi envelope/status yang dipakai pipeline.
// Modul murni: tanpa jaringan, tanpa log. Nomor/isi pesan/secret tidak pernah dimasukkan ke alasan skip atau error.
//
// ASUMSI (tidak ada di dokumen Convia yang dilampirkan; kontrak sesi hanya menyebut bentuk {event,timestamp,data}):
//  - Tanda tangan = HMAC-SHA256 hex (huruf besar/kecil diterima) atas byte asli body, dikirim di header X-Webhook-Signature.
//    Awalan seperti "sha256=" atau base64 TIDAK diterima; bila Convia memakainya, verifySignature perlu diubah.
//  - Nama field data: message_id, channel, message_type, content, media_url, customer_phone, customer_name, timestamp.
//    Hanya customer_name yang namanya ditebak (tidak disebut di tugas); bila beda, name jatuh ke ''.
//  - Nilai message_type di luar daftar di KIND_BY_TYPE ditebak (mis. 'voice', 'file', 'contacts', 'button_reply').
//  - data.content untuk media dianggap caption.
//  - Format timestamp tidak diketahui: diterima epoch detik/milidetik (angka atau string angka) dan string ISO-8601.
//  - Untuk message.app_sent, customer_phone dianggap tetap nomor pelanggan (bukan nomor bisnis).
//  - Event status tanpa field channel tetap diproses (hanya channel non-whatsapp yang dibuang); event pesan tanpa channel dilewati.
//  - Masa berlaku media_url, retry/duplikasi webhook dan urutan event tidak diketahui (ditangani S3/S4).

import crypto from 'node:crypto';

const EVENTS = new Set(['message.received', 'message.sent', 'message.app_sent', 'message.delivered', 'message.read', 'message.failed']);
const STATUS_BY_EVENT = { 'message.delivered': 'delivered', 'message.read': 'read', 'message.failed': 'failed' };

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
const PHONE_RE = /^\+?\d+$/;
const BSUID_RE = /^[A-Z]{2}(\.ENT)?\.\d+$/;
const REF_RE = /\[(?:kode:\s*)?([A-Za-z0-9_-]{2,20})\]/i; // sama dengan src/wa-message.js
const MEDIA_LABEL = { image: '[Gambar]', video: '[Video]', audio: '[Pesan suara]', sticker: '[Stiker]', document: '[Dokumen]' };

// message_type Convia -> kind (nilai kind sama dengan hasil src/wa-message.js)
const KIND_BY_TYPE = {
  text: 'text', button: 'text', interactive: 'text', button_reply: 'text', list_reply: 'text',
  image: 'image', video: 'video', audio: 'audio', voice: 'audio', sticker: 'sticker', document: 'document', file: 'document',
  location: 'location', contact: 'contact', contacts: 'contact', reaction: 'reaction',
};

const str = (v) => (v == null ? '' : String(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toText = (raw) => (Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : null);

// HMAC-SHA256 hex atas byte asli body. Tidak pernah melempar; hanya hex 64 karakter yang diterima.
export function verifySignature(rawBody, signature, secret) {
  try {
    if (typeof secret !== 'string' || !secret) return false;
    if (typeof signature !== 'string') return false;
    if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return false;
    const sig = signature.trim();
    if (!HEX_SHA256.test(sig)) return false; // panjang/format salah ditolak sebelum timingSafeEqual
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    const given = Buffer.from(sig, 'hex');
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

// JSON {event,timestamp,data} -> { ok:true, event, timestamp, data } | { ok:false, reason }
export function parseWebhook(rawBody) {
  const text = toText(rawBody);
  if (text === null || !text.trim()) return { ok: false, reason: 'empty_body' };
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, reason: 'invalid_json' }; }
  if (!isObj(json)) return { ok: false, reason: 'invalid_payload' };
  if (typeof json.event !== 'string' || !json.event.trim()) return { ok: false, reason: 'missing_event' };
  if (!isObj(json.data)) return { ok: false, reason: 'invalid_data' };
  return { ok: true, event: json.event.trim(), timestamp: json.timestamp ?? null, data: json.data };
}

// Timestamp -> ms epoch, atau null bila tidak bisa dibaca.
function parseTime(v) {
  if (v == null || v === '') return null;
  let ms = null;
  if (typeof v === 'number') ms = v;
  else if (typeof v === 'string') {
    const t = v.trim();
    ms = /^\d+(\.\d+)?$/.test(t) ? Number(t) : Date.parse(t);
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms < 1e12 ? Math.round(ms * 1000) : Math.round(ms); // < 1e12 dianggap detik
}

const isWhatsApp = (data) => str(data.channel).trim().toLowerCase() === 'whatsapp';

// Pelanggan: nomor -> phone digit; BSUID -> phone null; selain itu null.
function identityOf(rawPhone) {
  const v = str(rawPhone).trim();
  if (PHONE_RE.test(v)) {
    const phone = v.replace(/^\+/, '');
    return { jid: `${phone}@s.whatsapp.net`, phone, lid: null, bsuid: null, identityUnresolved: false };
  }
  if (BSUID_RE.test(v)) {
    // BSUID tidak pernah masuk field phone; lid dipakai agar kunci percakapan (phone || lid) tetap ada.
    return { jid: `${v}@convia`, phone: null, lid: v, bsuid: v, identityUnresolved: true };
  }
  return null;
}

// parsed -> envelope (bentuk sama dengan src/whatsapp.js + tambahan Convia) | { skip:true, reason }
export function toEnvelope(parsed, { now = Date.now } = {}) {
  if (!parsed || parsed.ok !== true || !isObj(parsed.data)) return { skip: true, reason: 'invalid_parsed' };
  const { event, data } = parsed;
  if (event === 'message.sent') return { skip: true, reason: 'own_api_message' };
  if (STATUS_BY_EVENT[event]) return { skip: true, reason: 'status_event' };
  if (event !== 'message.received' && event !== 'message.app_sent') {
    return { skip: true, reason: EVENTS.has(event) ? 'event_not_handled' : 'unknown_event' };
  }
  if (!isWhatsApp(data)) return { skip: true, reason: 'channel_not_whatsapp' };

  const messageId = str(data.message_id).trim();
  if (!messageId) return { skip: true, reason: 'missing_message_id' };

  const identity = identityOf(data.customer_phone);
  if (!identity) return { skip: true, reason: 'invalid_customer' };

  const fromMe = event === 'message.app_sent';
  const typeRaw = str(data.message_type).trim().toLowerCase() || 'text';
  if (typeRaw === 'system') return { skip: true, reason: 'system_message' };
  const known = KIND_BY_TYPE[typeRaw];
  const kind = known || 'document'; // tipe tak dikenal: sama seperti wa-message.js ("tidak didukung")
  if (fromMe && kind === 'reaction') return { skip: true, reason: 'reaction_from_me' };

  const content = str(data.content);
  let text = '';
  let caption = '';
  let mediaUrl = null;
  let sourceText = '';
  if (!known) {
    text = '[Pesan tidak didukung]';
  } else if (kind === 'text') {
    if (!content.trim()) return { skip: true, reason: 'empty_text' };
    text = content;
    sourceText = content;
  } else if (MEDIA_LABEL[kind]) {
    caption = content;
    text = MEDIA_LABEL[kind] + (caption ? ' ' + caption : '');
    sourceText = caption;
    const url = str(data.media_url).trim();
    if (/^https?:\/\//i.test(url)) mediaUrl = url; // hanya http(s); mediaId tetap null, diunduh S3
  } else if (kind === 'location') text = '[Lokasi]';
  else if (kind === 'contact') text = '[Kontak]';
  // reaction: text kosong

  const ref = REF_RE.exec(sourceText);
  const ts = parseTime(data.timestamp) ?? parseTime(parsed.timestamp) ?? now();

  return {
    waId: `convia:${messageId}`,
    jid: identity.jid,
    phone: identity.phone,
    lid: identity.lid,
    name: str(data.customer_name).trim(),
    ts,
    kind,
    text,
    caption,
    mediaId: null,
    mediaError: null,
    fromMe,
    fromPhone: fromMe,
    source: { platform: '', adId: '', ctwaClid: '', sourceUrl: '', referralCode: ref ? ref[1].toUpperCase() : '' },
    provider: 'convia',
    mediaUrl,
    bsuid: identity.bsuid,
    identityUnresolved: identity.identityUnresolved,
  };
}

// delivered/read/failed -> { waId, status } (bentuk yang diterima botMod.onStatusUpdate), selain itu null.
// message.sent sengaja null: kontrak hanya meminta delivered/read/failed; pesan keluar sudah berstatus 'sent' dari sendText.
export function toStatusUpdate(parsed) {
  if (!parsed || parsed.ok !== true || !isObj(parsed.data)) return null;
  const status = STATUS_BY_EVENT[parsed.event];
  if (!status) return null;
  const { data } = parsed;
  if (str(data.channel).trim() && !isWhatsApp(data)) return null;
  const messageId = str(data.message_id).trim();
  if (!messageId) return null;
  return { waId: `convia:${messageId}`, status };
}
