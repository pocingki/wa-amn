// Webhook Convia "Format B" (eventType/payload) -> envelope pipeline (kontrak S8).
// Hanya contoh message.received dari dokumen Convia yang dipakai; bentuk lain TIDAK ditebak.
// ASUMSI (tidak ada di dokumen): header tanda tangan hanya berisi hex polos (tanpa awalan "sha256="),
// huruf besar/kecil hex diterima sama; retry webhook, urutan, dan duplikasi pesan tidak dijamin;
// masa berlaku media tidak diketahui (bentuk payload media belum ada di contoh).
import crypto from 'node:crypto';

const BSUID_RE = /^[A-Z]{2}(\.ENT)?\.\d+$/;
const REF_RE = /\[(?:kode:\s*)?([A-Za-z0-9_-]{2,20})\]/i; // sama dengan src/wa-message.js
const MEDIA_ERROR = 'format media Convia belum diketahui';
const LABEL = { image: '[Gambar]', video: '[Video]', audio: '[Pesan suara]', sticker: '[Stiker]', document: '[Dokumen]', location: '[Lokasi]', contact: '[Kontak]' };
// Nama type Convia -> kind di src/wa-message.js. Type lain dianggap tidak didukung.
const KIND_OF = { text: 'text', image: 'image', video: 'video', audio: 'audio', sticker: 'sticker', document: 'document', location: 'location', contacts: 'contact', contact: 'contact', reaction: 'reaction' };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// HMAC-SHA256 hex atas raw body. Pembanding waktu-konstan setelah cek panjang sama.
export function verifySignature(rawBody, signature, secret) {
  if (typeof signature !== 'string' || !signature.trim() || !secret) return false;
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', String(secret)).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

// Urai JSON. Kunci eventType wajib (string tak kosong).
export function parseWebhook(rawBody) {
  let obj;
  try {
    obj = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    return { ok: false, reason: 'JSON rusak' };
  }
  if (!isObj(obj)) return { ok: false, reason: 'body bukan objek' };
  if (typeof obj.eventType !== 'string' || !obj.eventType) return { ok: false, reason: 'eventType tidak ada' };
  return {
    ok: true,
    event: obj.eventType,
    timestamp: typeof obj.occurredAt === 'string' ? obj.occurredAt : null,
    data: isObj(obj.payload) ? obj.payload : null,
    eventId: typeof obj.id === 'string' ? obj.id : null, // hanya untuk log, bukan kunci dedupe
    channel: typeof obj.channel === 'string' ? obj.channel : null,
  };
}

function tsOf(parsed, payload, now) {
  const sec = payload.timestamp;
  if (typeof sec === 'number' && Number.isFinite(sec) && sec > 0) return sec * 1000;
  const t = Date.parse(parsed.timestamp || '');
  if (Number.isFinite(t)) return t;
  return now();
}

// Kembalikan { phone, lid, bsuid, identityUnresolved } atau null bila "from" tak dikenali.
function identityOf(from) {
  const f = typeof from === 'string' ? from.trim() : '';
  if (BSUID_RE.test(f)) return { phone: null, lid: f, bsuid: f, identityUnresolved: true };
  const digits = f.startsWith('+') ? f.slice(1) : f;
  if (/^\d{5,20}$/.test(digits)) return { phone: digits, lid: null, bsuid: null, identityUnresolved: false };
  return null;
}

export function toEnvelope(parsed, { now = Date.now } = {}) {
  if (!parsed || parsed.ok !== true) return { skip: true, reason: 'payload tidak valid' };
  if (parsed.event !== 'message.received') return { skip: true, reason: 'eventType dilewati' };
  if (parsed.channel !== 'whatsapp') return { skip: true, reason: 'channel bukan whatsapp' };
  const p = parsed.data;
  if (!isObj(p)) return { skip: true, reason: 'payload kosong' };
  if (typeof p.messageId !== 'string' || !p.messageId) return { skip: true, reason: 'messageId tidak ada' };
  if (typeof p.type !== 'string' || !p.type) return { skip: true, reason: 'type tidak ada' };
  const id = identityOf(p.from);
  if (!id) return { skip: true, reason: 'pengirim tidak dikenali' };

  const mapped = KIND_OF[p.type.toLowerCase()];
  const kind = mapped || 'document';
  let text = '';
  if (kind === 'text') {
    text = isObj(p.text) && typeof p.text.body === 'string' ? p.text.body : '';
    if (!text.trim()) return { skip: true, reason: 'teks kosong' };
  } else if (!mapped) {
    text = '[Pesan tidak didukung]';
  } else {
    text = LABEL[kind] || '';
  }
  const ref = kind === 'text' ? REF_RE.exec(text) : null;

  return {
    waId: 'convia:' + p.messageId,
    jid: id.phone ? `${id.phone}@s.whatsapp.net` : `${id.bsuid}@convia`,
    phone: id.phone,
    lid: id.lid,
    name: '', // contoh dokumen tidak memuat nama profil
    ts: tsOf(parsed, p, now),
    kind,
    text,
    caption: '',
    mediaId: null,
    mediaError: kind === 'text' ? null : MEDIA_ERROR, // bentuk payload non-teks tidak diketahui: tidak menebak field
    fromMe: false,
    fromPhone: false,
    source: { platform: '', adId: '', ctwaClid: '', sourceUrl: '', referralCode: ref ? ref[1].toUpperCase() : '' },
    provider: 'convia',
    mediaUrl: null,
    bsuid: id.bsuid,
    identityUnresolved: id.identityUnresolved,
  };
}

// Contoh dokumen tidak memuat event status (delivered/read/failed): semua dikembalikan null.
export function toStatusUpdate() {
  return null;
}
