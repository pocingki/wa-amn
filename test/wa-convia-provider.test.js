// Uji provider Convia (S4). SEMUA MOCK: API, webhook, inbound, timer palsu. Tidak ada jaringan, bukan bukti dengan Convia nyata.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConviaProvider, destinationFromJid, normalizeHeaders, maskPhone } from '../src/wa-convia-provider.js';

process.env.BOT_NO_DELAY = '1';

function setup(over = {}) {
  const calls = { verify: [], sent: [], typing: [], status: [], processed: [], logs: [], intervals: [], cleared: [] };
  const apiState = { health: { ok: true, http: 200 }, sendError: null };
  const api = {
    sendText: async (to, text) => {
      if (apiState.sendError) throw apiState.sendError;
      calls.sent.push({ to, text });
      return { messageId: 'M' + calls.sent.length, status: 'accepted', timestamp: 1 };
    },
    sendTyping: async (to) => { calls.typing.push(to); },
    markRead: async () => {},
    health: async () => { if (apiState.health instanceof Error) throw apiState.health; return apiState.health; },
  };
  const webhookState = {
    sigOk: true,
    parsed: { ok: true, format: 'B', event: 'message', data: {} },
    status: null,
    envelope: { waId: 'convia:X1', jid: '6281234567890@s.whatsapp.net', phone: '6281234567890' },
    result: 'processed',
  };
  const webhook = {
    verifyRequest: (raw, headers, secret) => { calls.verify.push({ raw, headers, secret }); return webhookState.sigOk; },
    parseWebhook: () => webhookState.parsed,
    toStatusUpdate: () => webhookState.status,
    toEnvelope: () => webhookState.envelope,
  };
  const inbound = {
    processEnvelope: async (env) => {
      calls.processed.push(env);
      if (webhookState.result instanceof Error) throw webhookState.result;
      return webhookState.result;
    },
  };
  const provider = createConviaProvider({
    apiKey: 'KEY-RAHASIA', webhookSecret: 'SECRET-RAHASIA', phoneNumberId: 'P1',
    deps: {
      api, webhook, inbound,
      createInbound: () => inbound,
      emit: () => {}, convs: { seenMessage: () => false, markSeen: () => {} },
      handleIncoming: async () => {}, saveMedia: async () => ({ mediaId: null }),
      onStatusUpdate: async (u) => { calls.status.push(u); if (over.throwStatus) throw new Error('x'); },
      getSettings: () => ({ sendRateLimitPerMinute: 120 }),
      sleep: async () => {}, now: () => 1000,
      log: (...a) => calls.logs.push(a.map(String).join(' ')),
      setInterval: (fn, ms) => { const t = { fn, ms, unref() {} }; calls.intervals.push(t); return t; },
      clearInterval: (t) => calls.cleared.push(t),
      pollIntervalMs: 5000,
      ...(over.deps || {}),
    },
  });
  return { provider, calls, apiState, webhookState };
}

test('MOCK webhook: tanda tangan salah -> 401, inbound tidak dipanggil', async () => {
  const { provider, calls, webhookState } = setup();
  webhookState.sigOk = false;
  const r = await provider.handleWebhook(Buffer.from('{}'), { 'x-convia-signature': 'bad' });
  assert.equal(r.status, 401);
  assert.equal(calls.processed.length, 0);
});

test('MOCK webhook: verifikasi memakai byte asli dan header tanpa peduli huruf', async () => {
  const { provider, calls } = setup();
  const raw = Buffer.from('{"a":  1}\n'); // spasi aneh dipertahankan
  await provider.handleWebhook(raw, { 'X-Convia-Signature': 'abc' });
  assert.equal(calls.verify[0].raw, raw); // objek yang sama, bukan hasil re-serialisasi
  assert.equal(calls.verify[0].secret, 'SECRET-RAHASIA');
  assert.equal(calls.verify[0].headers['x-convia-signature'], 'abc');
  assert.equal(calls.verify[0].headers['X-Convia-Signature'], 'abc');
});

test('MOCK webhook: payload rusak -> 400', async () => {
  const { provider, webhookState } = setup();
  webhookState.parsed = { ok: false, reason: 'bad_json' };
  const r = await provider.handleWebhook('x', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'bad_json');
});

test('MOCK webhook: pesan diproses, duplikat, dilewati -> 200', async () => {
  const { provider, calls, webhookState } = setup();
  assert.equal((await provider.handleWebhook('x', {})).status, 200);
  assert.equal(calls.processed.length, 1);
  webhookState.result = 'duplicate';
  assert.equal((await provider.handleWebhook('x', {})).status, 200);
  webhookState.result = 'skipped';
  assert.equal((await provider.handleWebhook('x', {})).status, 200);
  webhookState.envelope = { skip: true, reason: 'unsupported' };
  const r = await provider.handleWebhook('x', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, 'unsupported');
  assert.equal(calls.processed.length, 3); // envelope skip tidak masuk inbound
});

test('MOCK webhook: gagal proses -> 500 (hasil failed maupun lemparan)', async () => {
  const { provider, webhookState, calls } = setup();
  webhookState.result = 'failed';
  assert.equal((await provider.handleWebhook('x', {})).status, 500);
  webhookState.result = new Error('isi pesan rahasia 081234567890');
  const r = await provider.handleWebhook('x', {});
  assert.equal(r.status, 500);
  assert.ok(!JSON.stringify(calls.logs).includes('rahasia'), 'log tidak memuat pesan error mentah');
  assert.ok(!JSON.stringify(calls.logs).includes('6281234567890'), 'nomor tidak penuh di log');
});

test('MOCK webhook: status update diteruskan ke onStatusUpdate, galatnya tidak jadi 500', async () => {
  const { provider, calls, webhookState } = setup({ throwStatus: true });
  webhookState.status = { waId: 'convia:S1', status: 'delivered' };
  const r = await provider.handleWebhook('x', {});
  assert.equal(r.status, 200);
  assert.deepEqual(calls.status, [{ waId: 'convia:S1', status: 'delivered' }]);
  assert.equal(calls.processed.length, 0);
});

test('MOCK webhook: tanpa secret selalu 401', async () => {
  const p = createConviaProvider({ apiKey: 'k', deps: { api: {}, webhook: { verifyRequest: () => true }, inbound: {}, emit() {}, convs: {}, handleIncoming() {}, onStatusUpdate() {}, saveMedia() {}, getSettings: () => ({}), sender: {} } });
  assert.equal((await p.handleWebhook('x', {})).status, 401);
});

test('MOCK sendText ke nomor: digit saja, waId = convia:<id>', async () => {
  const { provider, calls } = setup();
  provider.wa.status = 'connected';
  const res = await provider.sendText('6281234567890@s.whatsapp.net', 'halo');
  assert.deepEqual(calls.sent, [{ to: '6281234567890', text: 'halo' }]);
  assert.equal(res.waId, 'convia:M1');
  assert.deepEqual(calls.typing, ['6281234567890']);
});

test('MOCK sendText ke bsuid (@convia)', async () => {
  const { provider, calls } = setup();
  provider.wa.status = 'connected';
  await provider.sendText('ID.ABC123@convia', 'hai');
  assert.deepEqual(calls.sent, [{ to: 'ID.ABC123', text: 'hai' }]);
});

test('MOCK sendText: window_closed dilaporkan jelas, tidak ada kirim ulang/template', async () => {
  const { provider, calls, apiState } = setup();
  provider.wa.status = 'connected';
  const err = new Error('closed'); err.kind = 'window_closed';
  apiState.sendError = err;
  await assert.rejects(() => provider.sendText('6281234567890@s.whatsapp.net', 'x'), (e) => {
    assert.equal(e.code, 'WINDOW_CLOSED');
    assert.equal(e.retryable, false);
    assert.match(e.message, /jendela/i);
    return true;
  });
  assert.equal(calls.sent.length, 0);
});

test('MOCK sendText: saat belum terhubung ditolak (WA_NOT_CONNECTED)', async () => {
  const { provider } = setup();
  await assert.rejects(() => provider.sendText('6281234567890@s.whatsapp.net', 'x'), (e) => e.code === 'WA_NOT_CONNECTED');
});

test('MOCK sendText: jid tidak valid ditolak', () => {
  assert.throws(() => destinationFromJid('@s.whatsapp.net'), (e) => e.code === 'INVALID_JID');
  assert.throws(() => destinationFromJid('@convia'), (e) => e.code === 'INVALID_JID');
});

test('MOCK status: connected / disconnected berdasar health()', async () => {
  const { provider, apiState } = setup();
  assert.equal(provider.wa.status, 'disconnected');
  await provider.start();
  assert.equal(provider.wa.status, 'connected');
  assert.equal(provider.wa.error, null);
  apiState.health = { ok: false, http: 503 };
  await provider.start();
  assert.equal(provider.wa.status, 'disconnected');
  assert.match(provider.wa.error, /503/);
  apiState.health = Object.assign(new Error('boom'), { kind: 'timeout' });
  await provider.start();
  assert.equal(provider.wa.status, 'disconnected');
  assert.ok(!provider.wa.error.includes('boom'));
  await provider.stop();
});

test('MOCK polling: jalan berkala dan berhenti di stop()', async () => {
  const { provider, calls, apiState } = setup();
  await provider.start();
  assert.equal(calls.intervals.length, 1);
  assert.equal(calls.intervals[0].ms, 5000);
  apiState.health = { ok: false, http: 500 };
  await calls.intervals[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(provider.wa.status, 'disconnected');
  await provider.start(); // start ulang tidak menggandakan timer
  assert.equal(calls.intervals.length, 1);
  await provider.stop();
  assert.deepEqual(calls.cleared, [calls.intervals[0]]);
  assert.equal(provider.wa.status, 'disconnected');
  apiState.health = { ok: true, http: 200 };
  await calls.intervals[0].fn(); // callback lama setelah stop tidak mengubah status
  await new Promise((r) => setImmediate(r));
  assert.equal(provider.wa.status, 'disconnected');
});

test('MOCK logout: tidak melempar, mengembalikan pesan jelas', async () => {
  const { provider } = setup();
  const r = await provider.logout();
  assert.equal(r.ok, false);
  assert.match(r.message, /QR/);
});

test('MOCK log tidak memuat API key / secret', async () => {
  const { provider, calls, apiState } = setup();
  apiState.health = Object.assign(new Error('KEY-RAHASIA bocor'), { kind: 'auth' });
  await provider.start();
  await provider.handleWebhook('x', {});
  const all = JSON.stringify(calls.logs) + String(provider.wa.error);
  assert.ok(!all.includes('KEY-RAHASIA') && !all.includes('SECRET-RAHASIA'));
});

test('util: normalizeHeaders dan maskPhone', () => {
  assert.equal(normalizeHeaders({ 'X-A': 'v' })['x-a'], 'v');
  assert.equal(normalizeHeaders(new Headers({ 'X-B': 'w' }))['x-b'], 'w');
  assert.equal(maskPhone('6281234567890'), '***7890');
});
