// Uji webhook Convia (MOCK: payload buatan sendiri, bukan dari Convia nyata; tanpa jaringan).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { verifySignature, parseWebhook, toEnvelope, toStatusUpdate } from '../src/wa-convia-webhook.js';

const SECRET = 'rahasia-uji';
const NOW = 1_700_000_000_000;
const now = () => NOW;
const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');

const payload = (event, data = {}, extra = {}) => JSON.stringify({
  event,
  timestamp: '2024-01-02T03:04:05Z',
  data: { message_id: 'm1', channel: 'whatsapp', message_type: 'text', content: 'halo', customer_phone: '628123456789', customer_name: 'Budi', ...data },
  ...extra,
});
const env = (event, data, extra) => toEnvelope(parseWebhook(payload(event, data, extra)), { now });

test('verifySignature: valid', () => {
  const body = payload('message.received');
  assert.equal(verifySignature(body, sign(body), SECRET), true);
  assert.equal(verifySignature(Buffer.from(body), sign(body).toUpperCase(), SECRET), true); // hex huruf besar & Buffer
});

test('verifySignature: salah / panjang beda / kosong / format lain', () => {
  const body = payload('message.received');
  assert.equal(verifySignature(body, sign(body, 'lain'), SECRET), false);
  assert.equal(verifySignature(body + ' ', sign(body), SECRET), false); // body berubah satu byte
  assert.equal(verifySignature(body, 'abcd', SECRET), false); // panjang beda: tidak melempar
  assert.equal(verifySignature(body, sign(body) + '00', SECRET), false);
  assert.equal(verifySignature(body, '', SECRET), false);
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, null, SECRET), false);
  assert.equal(verifySignature(body, 'sha256=' + sign(body), SECRET), false); // hanya hex polos
  assert.equal(verifySignature(body, 'z'.repeat(64), SECRET), false);
  assert.equal(verifySignature(body, sign(body), ''), false); // secret kosong
  assert.equal(verifySignature(undefined, sign(body), SECRET), false);
});

test('verifySignature: memakai byte asli, bukan JSON.parse ulang', () => {
  const body = '{"event":"message.received",  "data":{}}'; // spasi ganda
  const reserialized = JSON.stringify(JSON.parse(body));
  assert.equal(verifySignature(body, sign(body), SECRET), true);
  assert.equal(verifySignature(body, sign(reserialized), SECRET), false);
});

test('parseWebhook: payload rusak', () => {
  assert.deepEqual(parseWebhook(''), { ok: false, reason: 'empty_body' });
  assert.deepEqual(parseWebhook(undefined), { ok: false, reason: 'empty_body' });
  assert.deepEqual(parseWebhook('{rusak'), { ok: false, reason: 'invalid_json' });
  assert.deepEqual(parseWebhook('[1]'), { ok: false, reason: 'invalid_payload' });
  assert.deepEqual(parseWebhook('null'), { ok: false, reason: 'invalid_payload' });
  assert.deepEqual(parseWebhook('{"data":{}}'), { ok: false, reason: 'missing_event' });
  assert.deepEqual(parseWebhook('{"event":"message.read"}'), { ok: false, reason: 'invalid_data' });
  assert.deepEqual(parseWebhook('{"event":"message.read","data":[]}'), { ok: false, reason: 'invalid_data' });
});

test('parseWebhook: bentuk hasil', () => {
  const p = parseWebhook(payload('message.received'));
  assert.equal(p.ok, true);
  assert.equal(p.event, 'message.received');
  assert.equal(p.timestamp, '2024-01-02T03:04:05Z');
  assert.equal(p.data.message_id, 'm1');
});

test('message.received -> envelope teks', () => {
  const e = env('message.received');
  assert.deepEqual(e, {
    waId: 'convia:m1',
    jid: '628123456789@s.whatsapp.net',
    phone: '628123456789',
    lid: null,
    name: 'Budi',
    ts: Date.parse('2024-01-02T03:04:05Z'),
    kind: 'text',
    text: 'halo',
    caption: '',
    mediaId: null,
    mediaError: null,
    fromMe: false,
    fromPhone: false,
    source: { platform: '', adId: '', ctwaClid: '', sourceUrl: '', referralCode: '' },
    provider: 'convia',
    mediaUrl: null,
    bsuid: null,
    identityUnresolved: false,
  });
});

test('message.app_sent -> fromMe true', () => {
  const e = env('message.app_sent', { message_id: 'm2' });
  assert.equal(e.waId, 'convia:m2');
  assert.equal(e.fromMe, true);
  assert.equal(e.fromPhone, true);
  assert.equal(e.phone, '628123456789');
});

test('event lain dilewati: sent, delivered, read, failed, tak dikenal', () => {
  assert.deepEqual(env('message.sent'), { skip: true, reason: 'own_api_message' });
  for (const ev of ['message.delivered', 'message.read', 'message.failed']) {
    assert.deepEqual(env(ev), { skip: true, reason: 'status_event' });
  }
  assert.deepEqual(env('contact.created'), { skip: true, reason: 'unknown_event' });
});

test('toEnvelope: input parsed tidak valid', () => {
  assert.deepEqual(toEnvelope({ ok: false, reason: 'invalid_json' }, { now }), { skip: true, reason: 'invalid_parsed' });
  assert.deepEqual(toEnvelope(null, { now }), { skip: true, reason: 'invalid_parsed' });
  assert.equal(toEnvelope(parseWebhook(payload('message.received'))).kind, 'text'); // opsi now boleh dihilangkan
});

test('channel instagram dan tanpa channel dilewati', () => {
  assert.deepEqual(env('message.received', { channel: 'instagram' }), { skip: true, reason: 'channel_not_whatsapp' });
  assert.deepEqual(env('message.app_sent', { channel: 'instagram' }), { skip: true, reason: 'channel_not_whatsapp' });
  assert.deepEqual(env('message.received', { channel: undefined }), { skip: true, reason: 'channel_not_whatsapp' });
  assert.equal(env('message.received', { channel: 'WhatsApp' }).kind, 'text'); // huruf besar diterima
});

test('nomor dengan "+" -> phone digit saja', () => {
  const e = env('message.received', { customer_phone: '+628123456789' });
  assert.equal(e.phone, '628123456789');
  assert.equal(e.jid, '628123456789@s.whatsapp.net');
  assert.equal(e.lid, null);
  assert.equal(e.identityUnresolved, false);
});

test('BSUID: phone null, bsuid dan lid terisi, identityUnresolved', () => {
  for (const b of ['US.13491208655302741918', 'ID.ENT.123456']) {
    const e = env('message.received', { customer_phone: b });
    assert.equal(e.phone, null);
    assert.equal(e.bsuid, b);
    assert.equal(e.lid, b);
    assert.equal(e.jid, `${b}@convia`);
    assert.equal(e.identityUnresolved, true);
    assert.equal(e.waId, 'convia:m1');
  }
});

test('customer_phone tidak dikenali / kosong dilewati', () => {
  for (const v of ['abc', '', undefined, null, '62 812-3456', 'us.123', 'US.']) {
    assert.deepEqual(env('message.received', { customer_phone: v }), { skip: true, reason: 'invalid_customer' }, String(v));
  }
});

test('message_id hilang dilewati', () => {
  assert.deepEqual(env('message.received', { message_id: '' }), { skip: true, reason: 'missing_message_id' });
  assert.deepEqual(env('message.received', { message_id: undefined }), { skip: true, reason: 'missing_message_id' });
});

test('media: kind, label, caption, mediaUrl', () => {
  const url = 'https://media.example.test/a.jpg';
  const img = env('message.received', { message_type: 'image', content: 'foto', media_url: url });
  assert.equal(img.kind, 'image');
  assert.equal(img.text, '[Gambar] foto');
  assert.equal(img.caption, 'foto');
  assert.equal(img.mediaUrl, url);
  assert.equal(img.mediaId, null);
  assert.equal(img.mediaError, null);

  const noCap = env('message.received', { message_type: 'document', content: '', media_url: url });
  assert.equal(noCap.kind, 'document');
  assert.equal(noCap.text, '[Dokumen]');
  assert.equal(noCap.caption, '');

  assert.equal(env('message.received', { message_type: 'voice', media_url: url }).kind, 'audio');
  assert.equal(env('message.received', { message_type: 'audio', content: '', media_url: url }).text, '[Pesan suara]');
  assert.equal(env('message.received', { message_type: 'video', content: '', media_url: url }).text, '[Video]');
  assert.equal(env('message.received', { message_type: 'sticker', content: '', media_url: url }).text, '[Stiker]');
  assert.equal(env('message.received', { message_type: 'image' }).mediaUrl, null); // tanpa media_url
  assert.equal(env('message.received', { message_type: 'image', media_url: 'javascript:x' }).mediaUrl, null); // skema bukan http(s)
});

test('tipe lain: lokasi, kontak, reaksi, tak dikenal, system', () => {
  assert.equal(env('message.received', { message_type: 'location', content: '' }).text, '[Lokasi]');
  assert.equal(env('message.received', { message_type: 'contacts' }).kind, 'contact');
  assert.equal(env('message.received', { message_type: 'contacts' }).text, '[Kontak]');
  const r = env('message.received', { message_type: 'reaction', content: '👍' });
  assert.equal(r.kind, 'reaction');
  assert.equal(r.text, '');
  assert.deepEqual(env('message.app_sent', { message_type: 'reaction' }), { skip: true, reason: 'reaction_from_me' });
  const u = env('message.received', { message_type: 'hologram', content: 'x', media_url: 'https://a.test/x' });
  assert.equal(u.kind, 'document');
  assert.equal(u.text, '[Pesan tidak didukung]');
  assert.equal(u.mediaUrl, null);
  assert.deepEqual(env('message.received', { message_type: 'system' }), { skip: true, reason: 'system_message' });
});

test('teks kosong dilewati; message_type hilang dianggap teks', () => {
  assert.deepEqual(env('message.received', { content: '   ' }), { skip: true, reason: 'empty_text' });
  assert.equal(env('message.received', { message_type: undefined }).kind, 'text');
});

test('kode referral diambil dari teks/caption', () => {
  assert.equal(env('message.received', { content: 'halo [kode: abc12]' }).source.referralCode, 'ABC12');
  assert.equal(env('message.received', { message_type: 'image', content: 'ini [xy99]' }).source.referralCode, 'XY99');
});

test('timestamp: data, event, detik/ms, hilang, rusak', () => {
  const iso = Date.parse('2024-01-02T03:04:05Z');
  assert.equal(env('message.received', { timestamp: '2025-05-05T00:00:00Z' }).ts, Date.parse('2025-05-05T00:00:00Z')); // data menang
  assert.equal(env('message.received', { timestamp: 1_700_000_100 }).ts, 1_700_000_100_000); // detik
  assert.equal(env('message.received', { timestamp: '1700000100' }).ts, 1_700_000_100_000); // string detik
  assert.equal(env('message.received', { timestamp: 1_700_000_100_123 }).ts, 1_700_000_100_123); // ms
  assert.equal(env('message.received').ts, iso); // tanpa data.timestamp: pakai timestamp event
  assert.equal(env('message.received', { timestamp: 'bukan-tanggal' }).ts, iso); // data rusak: jatuh ke event
  assert.equal(env('message.received', {}, { timestamp: undefined }).ts, NOW); // keduanya hilang -> now()
  assert.equal(env('message.received', { timestamp: 'x' }, { timestamp: 'y' }).ts, NOW); // keduanya rusak -> now()
  assert.equal(env('message.received', { timestamp: -5 }, { timestamp: null }).ts, NOW);
});

test('toStatusUpdate: delivered/read/failed', () => {
  const st = (ev, data) => toStatusUpdate(parseWebhook(payload(ev, data)));
  assert.deepEqual(st('message.delivered', { message_id: 'abc' }), { waId: 'convia:abc', status: 'delivered' });
  assert.deepEqual(st('message.read', { message_id: 'abc' }), { waId: 'convia:abc', status: 'read' });
  assert.deepEqual(st('message.failed', { message_id: 'abc' }), { waId: 'convia:abc', status: 'failed' });
  assert.deepEqual(Object.keys(st('message.read')).sort(), ['status', 'waId']);
});

test('toStatusUpdate: null untuk yang lain', () => {
  const st = (ev, data) => toStatusUpdate(parseWebhook(payload(ev, data)));
  assert.equal(st('message.received'), null);
  assert.equal(st('message.sent'), null);
  assert.equal(st('message.app_sent'), null);
  assert.equal(st('message.read', { message_id: '' }), null);
  assert.equal(st('message.read', { channel: 'instagram' }), null);
  assert.equal(st('message.read', { channel: undefined }).status, 'read'); // tanpa channel tetap diproses
  assert.equal(toStatusUpdate({ ok: false, reason: 'invalid_json' }), null);
  assert.equal(toStatusUpdate(null), null);
});

test('waId envelope dan status memakai kunci yang sama (dedupe/pencocokan)', () => {
  const e = env('message.received', { message_id: 'zzz' });
  const s = toStatusUpdate(parseWebhook(payload('message.read', { message_id: 'zzz' })));
  assert.equal(e.waId, s.waId);
});

test('tidak ada data sensitif di alasan skip', () => {
  const r = env('message.received', { customer_phone: '08123456789x', content: 'rahasia isi' });
  assert.equal(r.skip, true);
  assert.ok(!JSON.stringify(r).includes('0812'));
  assert.ok(!JSON.stringify(r).includes('rahasia'));
});
