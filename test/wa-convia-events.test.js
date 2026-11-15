// Uji S8 (MOCK): webhook Convia Format B + pengarah. Tanpa jaringan; bukan bukti uji dengan Convia nyata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as B from '../src/wa-convia-events.js';
import { createWebhookCompat } from '../src/wa-convia-webhook-compat.js';

const SECRET = 'rahasia-uji';
const hmac = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const SAMPLE = '{ "id":"evt_clx123abc456","eventType":"message.received","channel":"whatsapp","externalId":"wamid.HBgLMTIzNDU...","occurredAt":"2026-09-17T10:30:00.000Z",\n  "payload":{"phoneNumberId":"100982348572","from":"628123456789","messageId":"wamid.HBgLMTIzNDU...","type":"text","text":{"body":"Halo, saya ingin menanyakan status pesanan #1234"},"timestamp":1789641000}}';
const mk = (over = {}, pover = {}) => {
  const o = JSON.parse(SAMPLE);
  Object.assign(o, over);
  Object.assign(o.payload, pover);
  return JSON.stringify(o);
};
const env = (body, now) => B.toEnvelope(B.parseWebhook(body), now ? { now } : undefined);

// Format A palsu (MOCK): HMAC hex juga, tapi header & kunci berbeda.
const fakeA = {
  verifySignature: (raw, sig, secret) => sig === hmac(raw, secret),
  parseWebhook: (raw) => ({ ok: true, event: JSON.parse(raw).event, timestamp: 0, data: {} }),
  toEnvelope: () => ({ waId: 'convia:A1', from: 'A' }),
  toStatusUpdate: () => ({ status: 'A' }),
};
const compat = createWebhookCompat({ formatA: fakeA });
const BODY_A = JSON.stringify({ event: 'message.received', data: { message_id: 'A1' } });

test('MOCK verifySignature: contoh persis dengan tanda tangan benar', () => {
  assert.equal(B.verifySignature(SAMPLE, hmac(SAMPLE), SECRET), true);
  assert.equal(B.verifySignature(Buffer.from(SAMPLE), hmac(SAMPLE).toUpperCase(), SECRET), true);
});

test('MOCK verifySignature: salah / panjang beda / kosong / body diubah 1 byte / secret salah', () => {
  const good = hmac(SAMPLE);
  assert.equal(B.verifySignature(SAMPLE, good.replace(/.$/, good.endsWith('0') ? '1' : '0'), SECRET), false);
  assert.equal(B.verifySignature(SAMPLE, good.slice(0, -2), SECRET), false);
  assert.equal(B.verifySignature(SAMPLE, good + '00', SECRET), false);
  assert.equal(B.verifySignature(SAMPLE, '', SECRET), false);
  assert.equal(B.verifySignature(SAMPLE, undefined, SECRET), false);
  assert.equal(B.verifySignature(SAMPLE.replace('Halo', 'Hala'), good, SECRET), false);
  assert.equal(B.verifySignature(SAMPLE, good, 'lain'), false);
  assert.equal(B.verifySignature(SAMPLE, good, ''), false);
});

test('MOCK toEnvelope: contoh persis -> envelope teks', () => {
  const e = env(SAMPLE);
  assert.equal(e.waId, 'convia:wamid.HBgLMTIzNDU...');
  assert.equal(e.jid, '628123456789@s.whatsapp.net');
  assert.equal(e.phone, '628123456789');
  assert.equal(e.lid, null);
  assert.equal(e.kind, 'text');
  assert.equal(e.text, 'Halo, saya ingin menanyakan status pesanan #1234');
  assert.equal(e.ts, 1789641000 * 1000);
  assert.equal(e.fromMe, false);
  assert.equal(e.fromPhone, false);
  assert.equal(e.provider, 'convia');
  assert.equal(e.mediaUrl, null);
  assert.equal(e.mediaId, null);
  assert.equal(e.mediaError, null);
  assert.equal(e.identityUnresolved, false);
  assert.equal(e.bsuid, null);
});

test('MOCK toEnvelope: nomor berawalan + -> digit saja', () => {
  const e = env(mk({}, { from: '+628123456789' }));
  assert.equal(e.phone, '628123456789');
  assert.equal(e.jid, '628123456789@s.whatsapp.net');
});

test('MOCK toEnvelope: BSUID -> phone null, lid & bsuid terisi', () => {
  for (const b of ['ID.13491208655302741918', 'US.ENT.11815799212886844830']) {
    const e = env(mk({}, { from: b }));
    assert.equal(e.phone, null);
    assert.equal(e.lid, b);
    assert.equal(e.bsuid, b);
    assert.equal(e.identityUnresolved, true);
    assert.equal(e.jid, `${b}@convia`);
  }
});

test('MOCK toEnvelope: pengirim aneh / messageId hilang / teks kosong -> skip', () => {
  assert.equal(env(mk({}, { from: 'abc' })).skip, true);
  assert.equal(env(mk({}, { from: '' })).skip, true);
  assert.equal(env(mk({}, { messageId: '' })).skip, true);
  assert.equal(env(mk({}, { text: { body: '   ' } })).skip, true);
});

test('MOCK toEnvelope: timestamp detik -> ms; fallback occurredAt lalu now()', () => {
  assert.equal(env(mk({}, { timestamp: 1700000000 })).ts, 1700000000000);
  assert.equal(env(mk({}, { timestamp: 0 })).ts, Date.parse('2026-09-17T10:30:00.000Z'));
  assert.equal(env(mk({}, { timestamp: '1700000000' })).ts, Date.parse('2026-09-17T10:30:00.000Z'));
  assert.equal(env(mk({ occurredAt: 'bukan-tanggal' }, { timestamp: -5 }), () => 42).ts, 42);
});

test('MOCK toEnvelope: channel selain whatsapp & eventType tak dikenal -> skip', () => {
  const c = env(mk({ channel: 'instagram' }));
  assert.equal(c.skip, true);
  assert.ok(c.reason);
  const t = env(mk({ eventType: 'message.delivered' }));
  assert.equal(t.skip, true);
  assert.equal(env(mk({ eventType: 'sesuatu.baru' })).skip, true);
});

test('MOCK toEnvelope: type non-teks -> mediaUrl null + mediaError, tanpa menebak field', () => {
  const e = env(mk({}, { type: 'image', image: { id: 'x', url: 'https://contoh/x' } }));
  assert.equal(e.kind, 'image');
  assert.equal(e.mediaUrl, null);
  assert.equal(e.mediaError, 'format media Convia belum diketahui');
  assert.equal(e.caption, '');
  assert.equal(env(mk({}, { type: 'contacts' })).kind, 'contact');
  assert.equal(env(mk({}, { type: 'aneh' })).kind, 'document');
});

test('MOCK toStatusUpdate: selalu null', () => {
  assert.equal(B.toStatusUpdate(B.parseWebhook(SAMPLE)), null);
  assert.equal(B.toStatusUpdate(B.parseWebhook(mk({ eventType: 'message.delivered' }))), null);
});

test('MOCK parseWebhook: rusak / bukan objek / tanpa eventType', () => {
  assert.equal(B.parseWebhook('{rusak').ok, false);
  assert.equal(B.parseWebhook('[]').ok, false);
  assert.equal(B.parseWebhook('{"event":"x"}').ok, false);
  const p = B.parseWebhook(SAMPLE);
  assert.equal(p.ok, true);
  assert.equal(p.event, 'message.received');
  assert.equal(p.eventId, 'evt_clx123abc456');
});

test('MOCK compat: deteksi format A / B / rusak', () => {
  assert.equal(compat.parseWebhook(SAMPLE).format, 'B');
  assert.equal(compat.parseWebhook(BODY_A).format, 'A');
  assert.deepEqual(compat.parseWebhook('{x'), { ok: false, reason: 'JSON rusak' });
  assert.equal(compat.parseWebhook('{"foo":1}').ok, false);
  assert.equal(compat.parseWebhook('null').ok, false);
  // Dua kunci sekaligus: eventType menang
  assert.equal(compat.parseWebhook('{"eventType":"a","event":"b"}').format, 'B');
});

test('MOCK compat: verifyRequest memakai header sesuai format (case-insensitive)', () => {
  assert.equal(compat.verifyRequest(SAMPLE, { 'X-Convia-Signature': hmac(SAMPLE) }, SECRET), true);
  assert.equal(compat.verifyRequest(SAMPLE, { 'x-convia-signature': hmac(SAMPLE) }, SECRET), true);
  assert.equal(compat.verifyRequest(SAMPLE, new Headers({ 'X-CONVIA-SIGNATURE': hmac(SAMPLE) }), SECRET), true);
  assert.equal(compat.verifyRequest(BODY_A, { 'X-Webhook-Signature': hmac(BODY_A) }, SECRET), true);
  assert.equal(compat.verifyRequest(BODY_A, { 'x-webhook-signature': hmac(BODY_A) }, SECRET), true);
});

test('MOCK compat: tanda tangan silang format ditolak', () => {
  assert.equal(compat.verifyRequest(SAMPLE, { 'X-Webhook-Signature': hmac(SAMPLE) }, SECRET), false);
  assert.equal(compat.verifyRequest(BODY_A, { 'X-Convia-Signature': hmac(BODY_A) }, SECRET), false);
  // Header benar milik format lain berisi tanda tangan yang valid untuk body ini tetap tidak membantu
  assert.equal(compat.verifyRequest(SAMPLE, { 'X-Webhook-Signature': hmac(SAMPLE), 'X-Convia-Signature': 'salah' }, SECRET), false);
  assert.equal(compat.verifyRequest('{rusak', { 'X-Convia-Signature': hmac('{rusak') }, SECRET), false);
  assert.equal(compat.verifyRequest(SAMPLE, null, SECRET), false);
});

test('MOCK compat: waId sama untuk dua pengiriman ulang; event id tidak ikut', () => {
  const again = mk({ id: 'evt_lain' });
  const e1 = compat.toEnvelope(compat.parseWebhook(SAMPLE));
  const e2 = compat.toEnvelope(compat.parseWebhook(again));
  assert.equal(e1.waId, e2.waId);
  assert.equal(e1.waId, 'convia:wamid.HBgLMTIzNDU...');
});

test('MOCK compat: toEnvelope/toStatusUpdate diarahkan menurut format', () => {
  assert.equal(compat.toEnvelope(compat.parseWebhook(BODY_A)).from, 'A');
  assert.deepEqual(compat.toStatusUpdate(compat.parseWebhook(BODY_A)), { status: 'A' });
  assert.equal(compat.toStatusUpdate(compat.parseWebhook(SAMPLE)), null);
  assert.equal(compat.toEnvelope({ ok: true }).skip, true);
  assert.equal(compat.toStatusUpdate(null), null);
});

test('MOCK compat: tanpa formatA dan S2 belum ada -> error jelas', () => {
  // Hanya relevan bila S2 belum digabung; bila ada, default dipakai.
  try {
    createWebhookCompat();
  } catch (e) {
    assert.match(e.message, /formatA/);
  }
});
