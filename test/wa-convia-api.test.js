// Klien API Convia (S1). SEMUA tes memakai fetch MOCK: tidak ada panggilan jaringan nyata,
// jadi lulus di sini BUKAN bukti berhasil dengan Convia nyata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConviaApi, ConviaError } from '../src/wa-convia-api.js';

const KEY = 'ck_live_RAHASIA_1234567890';
const TEXT = 'Halo, pesanan Anda dikirim besok pagi';
const PHONE = '6281234567890';

const json = (status, body, headers = {}) =>
  new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// fetch mock: antrean respons/fungsi; mencatat tiap panggilan.
function mockFetch(...queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next(url, init) : next.clone();
  };
  fn.calls = calls;
  return fn;
}

const make = (fetchImpl, extra = {}) => createConviaApi({ apiKey: KEY, fetchImpl, ...extra });
const okSend = () => json(200, { data: { message_id: 'm1', status: 'queued', timestamp: '2026-11-15T00:00:00Z' } });

const namedError = (msg, name) => Object.assign(new Error(msg), { name });

async function rejects(p) {
  try { await p; } catch (e) { return e; }
  assert.fail('seharusnya melempar');
}

test('[MOCK] sendText: URL, metode, dan header benar', async () => {
  const f = mockFetch(okSend());
  await make(f).sendText(PHONE, TEXT);
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.convia.id/api/v1/public/messages/send');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.ok(c.init.signal instanceof AbortSignal);
});

test('[MOCK] sendText: body lengkap dengan phoneNumberId dan reply; tanpa opsional kuncinya tidak ada', async () => {
  const f = mockFetch(okSend());
  const api = make(f, { phoneNumberId: 'pn_9' });
  const r = await api.sendText(PHONE, TEXT, { replyToMessageId: 'wamid.X' });
  assert.deepEqual(f.calls[0].body, {
    phone_number: PHONE, channel: 'whatsapp', message_type: 'text', content: TEXT,
    whatsapp_phone_number_id: 'pn_9', reply_to_message_id: 'wamid.X',
  });
  assert.deepEqual(r, { messageId: 'm1', status: 'queued', timestamp: '2026-11-15T00:00:00Z' });

  const f2 = mockFetch(okSend());
  await make(f2).sendText(PHONE, TEXT);
  assert.deepEqual(Object.keys(f2.calls[0].body).sort(), ['channel', 'content', 'message_type', 'phone_number']);
});

test('[MOCK] baseUrl kustom: garis miring di ujung dibuang', async () => {
  const f = mockFetch(okSend());
  await make(f, { baseUrl: 'https://x.test/api/' }).sendText(PHONE, TEXT);
  assert.equal(f.calls[0].url, 'https://x.test/api/messages/send');
});

test('[MOCK] sendText: respons 2xx tanpa data tidak melempar (hindari kirim ganda)', async () => {
  const r = await make(mockFetch(json(200, {}))).sendText(PHONE, TEXT);
  assert.deepEqual(r, { messageId: null, status: null, timestamp: null });
  const r2 = await make(mockFetch(new Response('bukan json', { status: 200 }))).sendText(PHONE, TEXT);
  assert.equal(r2.messageId, null);
});

test('[MOCK] validasi lokal: tujuan/isi kosong ditolak tanpa memanggil fetch', async () => {
  const f = mockFetch(okSend());
  const api = make(f);
  assert.equal((await rejects(api.sendText('', TEXT))).kind, 'validation');
  assert.equal((await rejects(api.sendText(PHONE, ''))).kind, 'validation');
  assert.equal((await rejects(api.markRead(''))).kind, 'validation');
  assert.equal(f.calls.length, 0);
});

test('[MOCK] konfigurasi: tanpa apiKey gagal dengan kind config', () => {
  for (const bad of [undefined, '', '   ']) {
    let err;
    try { createConviaApi({ apiKey: bad, fetchImpl: async () => {} }); } catch (e) { err = e; }
    assert.ok(err instanceof ConviaError);
    assert.equal(err.kind, 'config');
  }
});

test('[MOCK] markRead: POST /messages/:id/read dengan id di-encode', async () => {
  const f = mockFetch(json(200, { data: {} }));
  const r = await make(f).markRead('wamid.A/B c');
  assert.equal(r, undefined);
  assert.equal(f.calls[0].url, 'https://api.convia.id/api/v1/public/messages/wamid.A%2FB%20c/read');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
});

test('[MOCK] sendTyping: POST /conversations/:to/typing', async () => {
  const f = mockFetch(json(200, {}));
  await make(f).sendTyping(PHONE);
  assert.equal(f.calls[0].url, `https://api.convia.id/api/v1/public/conversations/${PHONE}/typing`);
  assert.equal(f.calls[0].init.method, 'POST');
});

test('[MOCK] sendTyping: 429 diabaikan (tidak melempar)', async () => {
  const f = mockFetch(json(429, { error: { code: 'RateLimitExceeded', message: 'x' } }, { 'Retry-After': '3' }));
  assert.equal(await make(f).sendTyping(PHONE), undefined);
  assert.equal(f.calls.length, 1);
});

test('[MOCK] sendTyping: galat selain 429 tetap dilempar', async () => {
  const e = await rejects(make(mockFetch(json(401, { error: { code: 'Unauthorized', message: 'x' } }))).sendTyping(PHONE));
  assert.equal(e.kind, 'auth');
});

test('[MOCK] sendTyping: dibatasi lokal 1 per 3 dtk per customer', async () => {
  let t = 1_000_000;
  const f = mockFetch(json(200, {}));
  const api = make(f, { now: () => t });
  await api.sendTyping(PHONE);
  t += 2999;
  await api.sendTyping(PHONE); // dilewati
  assert.equal(f.calls.length, 1);
  await api.sendTyping('6280000000001'); // customer lain tidak terpengaruh
  assert.equal(f.calls.length, 2);
  t += 1;
  await api.sendTyping(PHONE); // sudah 3000 ms
  assert.equal(f.calls.length, 3);
});

test('[MOCK] health: GET /health; ok true/false; tidak pernah melempar', async () => {
  const f = mockFetch(json(200, { status: 'ok' }));
  assert.deepEqual(await make(f).health(), { ok: true, http: 200 });
  assert.equal(f.calls[0].url, 'https://api.convia.id/api/v1/public/health');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.body, undefined);
  assert.deepEqual(await make(mockFetch(json(503, {}))).health(), { ok: false, http: 503 });
  const down = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await make(down).health(), { ok: false, http: null });
});

// ---- pemetaan galat ----
const CASES = [
  // [http, error.code, kind]
  [400, 'ValidationError', 'validation'],
  [401, 'Unauthorized', 'auth'],
  [403, 'Forbidden', 'auth'],
  [422, 'WindowClosed', 'window_closed'],
  [400, 'WindowClosed', 'window_closed'],
  [400, 'ConfigurationError', 'config'],
  [404, 'NotFound', 'not_found'],
  [429, 'RateLimitExceeded', 'rate_limit'],
];
for (const [http, code, kind] of CASES) {
  test(`[MOCK] galat ${http} ${code} -> ${kind}`, async () => {
    const f = mockFetch(json(http, { error: { code, message: 'pesan server' } }));
    const e = await rejects(make(f).sendText(PHONE, TEXT));
    assert.ok(e instanceof ConviaError);
    assert.equal(e.kind, kind);
    assert.equal(e.code, code);
    assert.equal(e.http, http);
    assert.ok(e.message.length > 0);
  });
}

test('[MOCK] pemetaan dari HTTP saat tubuh bukan {error:{code}}', async () => {
  const mk = (res) => rejects(make(mockFetch(res)).sendText(PHONE, TEXT));
  assert.equal((await mk(new Response('<html>Bad Gateway</html>', { status: 502 }))).kind, 'server');
  assert.equal((await mk(json(500, {}))).kind, 'server');
  assert.equal((await mk(json(503, { error: { code: 'Whatever', message: 'x' } }))).kind, 'server');
  assert.equal((await mk(new Response('', { status: 404 }))).kind, 'not_found');
  assert.equal((await mk(new Response('', { status: 401 }))).kind, 'auth');
  assert.equal((await mk(new Response('', { status: 429 }))).kind, 'rate_limit');
  assert.equal((await mk(json(418, {}))).kind, 'validation');
});

test('[MOCK] kode galat dinormalisasi (VALIDATION_ERROR) dan kode tak aman tidak disimpan', async () => {
  const e1 = await rejects(make(mockFetch(json(400, { error: { code: 'VALIDATION_ERROR' } }))).sendText(PHONE, TEXT));
  assert.equal(e1.kind, 'validation');
  const e2 = await rejects(make(mockFetch(json(400, { error: { code: `bad code ${TEXT}` } }))).sendText(PHONE, TEXT));
  assert.equal(e2.code, null);
  assert.ok(!e2.message.includes(TEXT));
});

test('[MOCK] 429 dengan Retry-After detik -> retryAfterMs', async () => {
  const f = mockFetch(json(429, { error: { code: 'RateLimitExceeded', message: 'x' } }, { 'Retry-After': '7' }));
  const e = await rejects(make(f).sendText(PHONE, TEXT));
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.retryAfterMs, 7000);
  assert.match(e.message, /7 detik/);
});

test('[MOCK] 429 dengan Retry-After tanggal HTTP memakai waktu injeksi; tanpa header = null', async () => {
  const base = Date.parse('2026-11-15T00:00:00Z');
  const f = mockFetch(json(429, {}, { 'Retry-After': new Date(base + 12_000).toUTCString() }));
  const e = await rejects(make(f, { now: () => base }).sendText(PHONE, TEXT));
  assert.equal(e.retryAfterMs, 12_000);
  const e2 = await rejects(make(mockFetch(json(429, {}))).sendText(PHONE, TEXT));
  assert.equal(e2.retryAfterMs, null);
  const e3 = await rejects(make(mockFetch(json(429, {}, { 'Retry-After': 'abc' }))).sendText(PHONE, TEXT));
  assert.equal(e3.retryAfterMs, null);
});

test('[MOCK] retryAfterMs hanya diisi untuk rate_limit', async () => {
  const e = await rejects(make(mockFetch(json(503, {}, { 'Retry-After': '5' }))).sendText(PHONE, TEXT));
  assert.equal(e.kind, 'server');
  assert.equal(e.retryAfterMs, null);
});

// ---- timeout & jaringan ----
test('[MOCK] timeout: timer injeksi habis -> kind timeout, fetch di-abort', async () => {
  let fire;
  let signal;
  const f = (url, init) => { signal = init.signal; return new Promise(() => {}); }; // tak pernah selesai
  const api = make(f, { timeoutMs: 5000, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  const p = api.sendText(PHONE, TEXT);
  await new Promise((r) => setImmediate(r));
  fire();
  const e = await rejects(p);
  assert.equal(e.kind, 'timeout');
  assert.equal(signal.aborted, true);
});

test('[MOCK] timeout: waktu nyata singkat dengan fetch yang menghormati signal', async () => {
  const f = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(namedError('aborted', 'AbortError')));
  });
  const e = await rejects(make(f, { timeoutMs: 20 }).sendText(PHONE, TEXT));
  assert.equal(e.kind, 'timeout');
});

test('[MOCK] AbortError/TimeoutError dari fetch -> timeout', async () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    const f = async () => { throw namedError('x', name); };
    assert.equal((await rejects(make(f).sendText(PHONE, TEXT))).kind, 'timeout');
  }
});

test('[MOCK] gagal jaringan -> unreachable', async () => {
  const f = async () => { throw new TypeError('fetch failed'); };
  const e = await rejects(make(f).sendText(PHONE, TEXT));
  assert.equal(e.kind, 'unreachable');
  assert.equal(e.http, null);
});

test('[MOCK] timer dibersihkan setelah respons selesai', async () => {
  let cleared = 0;
  await make(mockFetch(okSend()), { setTimer: () => 42, clearTimer: (t) => { if (t === 42) cleared += 1; } }).sendText(PHONE, TEXT);
  assert.equal(cleared, 1);
});

// ---- kerahasiaan ----
test('[MOCK] apiKey, isi pesan, dan nomor tidak muncul di message/stack/JSON galat (semua kind)', async () => {
  // server yang memantulkan semuanya di error.message & jaringan yang memuat URL/kunci di teks galat
  const echo = `${KEY} ${TEXT} ${PHONE}`;
  const scenarios = [
    mockFetch(json(400, { error: { code: 'ValidationError', message: echo } })),
    mockFetch(json(401, { error: { code: 'Unauthorized', message: echo } })),
    mockFetch(json(422, { error: { code: 'WindowClosed', message: echo } })),
    mockFetch(json(400, { error: { code: 'ConfigurationError', message: echo } })),
    mockFetch(json(404, { error: { code: 'NotFound', message: echo } })),
    mockFetch(json(429, { error: { code: 'RateLimitExceeded', message: echo } }, { 'Retry-After': '2' })),
    mockFetch(json(500, { error: { code: 'Boom', message: echo } })),
    async () => { throw new TypeError(`fetch failed ${KEY} ${PHONE}`, { cause: new Error(echo) }); },
    async () => { throw namedError(echo, 'AbortError'); },
  ];
  for (const f of scenarios) {
    const e = await rejects(make(f).sendText(PHONE, TEXT));
    const dump = [e.message, e.stack, JSON.stringify(e), String(e.cause ?? '')].join('\n');
    for (const secret of [KEY, TEXT, PHONE]) {
      assert.ok(!dump.includes(secret), `bocor: ${secret} pada kind ${e.kind}`);
    }
  }
});

test('[MOCK] setiap kind galat punya pesan tidak kosong', async () => {
  const kinds = new Set();
  for (const [http, code] of CASES) {
    const e = await rejects(make(mockFetch(json(http, { error: { code } }))).sendText(PHONE, TEXT));
    kinds.add(e.kind);
    assert.match(e.message, /[A-Za-z]/);
  }
  assert.equal(kinds.size, 6); // validation, auth, window_closed, config, not_found, rate_limit
});
