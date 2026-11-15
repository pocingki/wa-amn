// Adaptor penyedia AI (B1). SEMUA tes memakai fetch MOCK: tidak ada panggilan jaringan nyata,
// jadi lulus di sini BUKAN bukti berhasil dengan layanan penyedia nyata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat, testConnection, AiError, PROVIDERS } from '../src/ai-providers.js';

const KEY = 'sk-RAHASIA-1234567890abcdef';
const TEXT = 'Halo, saya mau tanya harga paket premium untuk nomor 081234567890';
const SYSTEM = 'Kamu asisten toko. Rahasia internal: JANGAN-BOCOR-987';
const MSGS = [{ role: 'user', content: TEXT }];

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

const okAnthropic = (extra = {}) => json(200, { content: [{ type: 'text', text: 'Halo kak' }], usage: { input_tokens: 11, output_tokens: 5 }, ...extra });
const okOpenai = (extra = {}) => json(200, { choices: [{ message: { role: 'assistant', content: 'Halo kak' } }], usage: { prompt_tokens: 12, completion_tokens: 4 }, ...extra });
const okGemini = (extra = {}) => json(200, { candidates: [{ content: { parts: [{ text: 'Halo kak' }] } }], usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 3 }, ...extra });

const base = (provider, fetchImpl, extra = {}) => ({
  provider, apiKey: KEY, model: 'model-uji', system: SYSTEM, messages: MSGS, fetchImpl, ...extra,
});

async function rejects(p) {
  try { await p; } catch (e) { return e; }
  assert.fail('seharusnya melempar');
}

// Semua yang tidak boleh bocor di galat (pesan, stack, serialisasi, properti).
function assertNoLeak(e) {
  const blob = [e.message, e.stack, JSON.stringify(e), String(e.cause ?? ''), Object.values(e).join(' ')].join(' ');
  for (const secret of [KEY, TEXT, SYSTEM, '081234567890', 'JANGAN-BOCOR-987']) {
    assert.ok(!blob.includes(secret), `bocor: ${secret}`);
  }
}

test('PROVIDERS dan AiError sesuai kontrak', () => {
  assert.deepEqual(PROVIDERS, ['anthropic', 'openai', 'gemini', 'openai-compatible']);
  const e = new AiError('rate_limit', { http: 429, retryAfterMs: 2000 });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'AiError');
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.http, 429);
  assert.equal(e.retryAfterMs, 2000);
  assert.ok(e.message.length > 0);
});

// ---------- bentuk permintaan ----------

test('[MOCK] anthropic: URL, header, body; system terpisah dari messages', async () => {
  const f = mockFetch(okAnthropic());
  await chat(base('anthropic', f, { maxTokens: 300 }));
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['x-api-key'], KEY);
  assert.equal(c.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.equal(c.init.headers.Authorization, undefined);
  assert.ok(c.init.signal instanceof AbortSignal);
  assert.equal(c.init.redirect, 'error');
  assert.deepEqual(c.body, { model: 'model-uji', max_tokens: 300, system: SYSTEM, messages: MSGS });
});

test('[MOCK] anthropic: tanpa system kuncinya tidak ada; maxTokens bawaan terisi', async () => {
  const f = mockFetch(okAnthropic());
  await chat(base('anthropic', f, { system: '' }));
  assert.equal('system' in f.calls[0].body, false);
  assert.equal(f.calls[0].body.max_tokens, 1024);
});

test('[MOCK] openai: URL, Bearer, system sebagai pesan pertama, max_completion_tokens', async () => {
  const f = mockFetch(okOpenai());
  await chat(base('openai', f, { maxTokens: 250, messages: [...MSGS, { role: 'assistant', content: 'Baik' }, { role: 'user', content: 'Lanjut' }] }));
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(c.body, {
    model: 'model-uji',
    max_completion_tokens: 250,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: TEXT },
      { role: 'assistant', content: 'Baik' },
      { role: 'user', content: 'Lanjut' },
    ],
  });
});

test('[MOCK] openai-compatible: baseUrl kustom (garis miring akhir dihapus), max_tokens, wajib baseUrl', async () => {
  const f = mockFetch(okOpenai());
  await chat(base('openai-compatible', f, { baseUrl: 'https://llm.contoh.id/v1///', maxTokens: 123 }));
  const c = f.calls[0];
  assert.equal(c.url, 'https://llm.contoh.id/v1/chat/completions');
  assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.body.max_tokens, 123);
  assert.equal('max_completion_tokens' in c.body, false);
  assert.equal(c.body.messages[0].role, 'system');

  const g = mockFetch(okOpenai());
  const e = await rejects(chat(base('openai-compatible', g)));
  assert.equal(e.kind, 'bad_request');
  assert.match(e.message, /Base URL/);
  assert.equal(g.calls.length, 0);
});

test('[MOCK] openai-compatible: boleh tanpa kunci (header Authorization tidak dikirim)', async () => {
  const f = mockFetch(okOpenai());
  await chat(base('openai-compatible', f, { baseUrl: 'http://localhost:11434/v1', apiKey: '' }));
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.equal(f.calls[0].url, 'http://localhost:11434/v1/chat/completions');
});

test('[MOCK] gemini: kunci di header (bukan URL), systemInstruction, peran model, generationConfig', async () => {
  const f = mockFetch(okGemini());
  await chat(base('gemini', f, {
    model: 'gemini-uji-1',
    maxTokens: 200,
    messages: [...MSGS, { role: 'assistant', content: 'Baik' }, { role: 'user', content: 'Lanjut' }],
  }));
  const c = f.calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-uji-1:generateContent');
  assert.ok(!c.url.includes(KEY));
  assert.equal(c.init.headers['x-goog-api-key'], KEY);
  assert.deepEqual(c.body, {
    contents: [
      { role: 'user', parts: [{ text: TEXT }] },
      { role: 'model', parts: [{ text: 'Baik' }] },
      { role: 'user', parts: [{ text: 'Lanjut' }] },
    ],
    generationConfig: { maxOutputTokens: 200 },
    systemInstruction: { parts: [{ text: SYSTEM }] },
  });
});

test('[MOCK] gemini: awalan "models/" pada nama model tidak digandakan', async () => {
  const f = mockFetch(okGemini());
  await chat(base('gemini', f, { model: 'models/gemini-uji-2' }));
  assert.equal(f.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-uji-2:generateContent');
});

test('[MOCK] model teks bebas diteruskan apa adanya ke tiap penyedia', async () => {
  const model = 'Nama-Model_Aneh.v9:latest@2026';
  for (const [provider, ok, extra] of [
    ['anthropic', okAnthropic(), {}],
    ['openai', okOpenai(), {}],
    ['openai-compatible', okOpenai(), { baseUrl: 'https://x.test/v1' }],
    ['gemini', okGemini(), {}],
  ]) {
    const f = mockFetch(ok);
    await chat(base(provider, f, { model, ...extra }));
    const c = f.calls[0];
    if (provider === 'gemini') assert.ok(c.url.includes(encodeURIComponent(model)), provider);
    else assert.equal(c.body.model, model, provider);
  }
});

test('[MOCK] baseUrl kustom dipakai oleh anthropic, openai, dan gemini', async () => {
  const cases = [
    ['anthropic', okAnthropic(), 'https://proxy.test/anthropic/v1/', 'https://proxy.test/anthropic/v1/messages'],
    ['openai', okOpenai(), 'https://proxy.test/openai/v1', 'https://proxy.test/openai/v1/chat/completions'],
    ['gemini', okGemini(), 'https://proxy.test/gem/', 'https://proxy.test/gem/models/model-uji:generateContent'],
  ];
  for (const [provider, ok, baseUrl, expected] of cases) {
    const f = mockFetch(ok);
    await chat(base(provider, f, { baseUrl }));
    assert.equal(f.calls[0].url, expected, provider);
  }
});

test('[MOCK] pesan kosong/spasi dibuang; semua kosong -> bad_request tanpa panggilan jaringan', async () => {
  const f = mockFetch(okOpenai());
  await chat(base('openai', f, { messages: [{ role: 'user', content: '   ' }, ...MSGS] }));
  assert.equal(f.calls[0].body.messages.length, 2); // system + 1 pesan
  const g = mockFetch(okOpenai());
  const e = await rejects(chat(base('openai', g, { messages: [{ role: 'user', content: ' ' }] })));
  assert.equal(e.kind, 'bad_request');
  assert.equal(g.calls.length, 0);
});

// ---------- parsing respons dan usage ----------

test('[MOCK] anthropic: teks dari beberapa blok + usage (cache dijumlahkan ke input)', async () => {
  const f = mockFetch(json(200, {
    content: [{ type: 'text', text: 'Halo ' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'kak  ' }],
    usage: { input_tokens: 10, output_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 2 },
  }));
  const r = await chat(base('anthropic', f));
  assert.equal(r.text, 'Halo kak');
  assert.deepEqual(r.usage, { inputTokens: 15, outputTokens: 7 });
});

test('[MOCK] openai: teks string dan array bagian; usage', async () => {
  const r1 = await chat(base('openai', mockFetch(okOpenai())));
  assert.deepEqual(r1, { text: 'Halo kak', usage: { inputTokens: 12, outputTokens: 4 } });
  const arr = json(200, { choices: [{ message: { content: [{ type: 'text', text: 'Satu ' }, { type: 'text', text: 'dua' }] } }] });
  const r2 = await chat(base('openai-compatible', mockFetch(arr), { baseUrl: 'https://x.test/v1' }));
  assert.equal(r2.text, 'Satu dua');
});

test('[MOCK] gemini: teks, abaikan bagian "thought", usage termasuk thoughtsTokenCount', async () => {
  const f = mockFetch(json(200, {
    candidates: [{ content: { parts: [{ text: 'pikir', thought: true }, { text: 'Jawab ' }, { text: 'ya' }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6, thoughtsTokenCount: 4 },
  }));
  const r = await chat(base('gemini', f));
  assert.equal(r.text, 'Jawab ya');
  assert.deepEqual(r.usage, { inputTokens: 20, outputTokens: 10 });
});

test('[MOCK] usage bernilai null bila penyedia tidak mengirimnya', async () => {
  const a = await chat(base('anthropic', mockFetch(json(200, { content: [{ type: 'text', text: 'ok' }] }))));
  assert.deepEqual(a.usage, { inputTokens: null, outputTokens: null });
  const o = await chat(base('openai', mockFetch(json(200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 'x' } }))));
  assert.deepEqual(o.usage, { inputTokens: null, outputTokens: null });
  const g = await chat(base('gemini', mockFetch(json(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }))));
  assert.deepEqual(g.usage, { inputTokens: null, outputTokens: null });
  const part = await chat(base('gemini', mockFetch(json(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 5 } }))));
  assert.deepEqual(part.usage, { inputTokens: 5, outputTokens: null });
});

test('[MOCK] jawaban kosong -> empty (tiap penyedia, termasuk diblokir/tanpa kandidat)', async () => {
  const cases = [
    ['anthropic', json(200, { content: [], usage: { input_tokens: 1, output_tokens: 0 } })],
    ['anthropic', json(200, { content: [{ type: 'text', text: '   ' }] })],
    ['openai', json(200, { choices: [{ message: { content: '' } }] })],
    ['openai', json(200, { choices: [] })],
    ['openai-compatible', json(200, { choices: [{ message: { content: null, refusal: 'tidak' } }] })],
    ['gemini', json(200, { candidates: [] })],
    ['gemini', json(200, { promptFeedback: { blockReason: 'SAFETY' } })],
  ];
  for (const [provider, res] of cases) {
    const e = await rejects(chat(base(provider, mockFetch(res), { baseUrl: 'https://x.test/v1' })));
    assert.ok(e instanceof AiError);
    assert.equal(e.kind, 'empty', provider);
    assertNoLeak(e);
  }
});

test('[MOCK] 200 dengan badan bukan JSON/kosong -> server', async () => {
  for (const res of [new Response('<html>oops</html>', { status: 200 }), new Response('', { status: 200 })]) {
    const e = await rejects(chat(base('openai', mockFetch(res))));
    assert.equal(e.kind, 'server');
    assert.equal(e.http, 200);
  }
});

// ---------- pemetaan galat ----------

test('[MOCK] 401 dan 403 -> auth', async () => {
  for (const status of [401, 403]) {
    for (const p of PROVIDERS) {
      const e = await rejects(chat(base(p, mockFetch(json(status, { error: { message: 'x' } })), { baseUrl: 'https://x.test/v1' })));
      assert.equal(e.kind, 'auth', `${p} ${status}`);
      assert.equal(e.http, status);
      assertNoLeak(e);
    }
  }
});

test('[MOCK] 429 -> rate_limit dengan Retry-After detik', async () => {
  const f = mockFetch(json(429, { error: { type: 'rate_limit_error' } }, { 'retry-after': '7' }));
  const e = await rejects(chat(base('anthropic', f)));
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.http, 429);
  assert.equal(e.retryAfterMs, 7000);
  assert.match(e.message, /7 detik/);
});

test('[MOCK] 429 -> rate_limit dengan Retry-After tanggal HTTP memakai jam injeksi; tanpa header = null', async () => {
  const now = () => Date.parse('2026-11-15T10:00:00Z');
  const f = mockFetch(json(429, {}, { 'retry-after': 'Sun, 15 Nov 2026 10:00:30 GMT' }));
  const e = await rejects(chat(base('openai', f, { now })));
  assert.equal(e.retryAfterMs, 30000);
  const e2 = await rejects(chat(base('openai', mockFetch(json(429, {})))));
  assert.equal(e2.kind, 'rate_limit');
  assert.equal(e2.retryAfterMs, null);
  const e3 = await rejects(chat(base('openai', mockFetch(json(429, {}, { 'retry-after': 'bukan-angka' })))));
  assert.equal(e3.retryAfterMs, null);
});

test('[MOCK] saldo/kuota penyedia habis -> quota_provider (bukan rate_limit)', async () => {
  const cases = [
    ['openai', json(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } })],
    ['openai', json(429, { error: { code: 'billing_hard_limit_reached' } })],
    ['openai-compatible', json(402, { error: { message: 'Insufficient credits' } })],
    ['anthropic', json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } })],
    ['gemini', json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.' } })],
  ];
  for (const [provider, res] of cases) {
    const e = await rejects(chat(base(provider, mockFetch(res), { baseUrl: 'https://x.test/v1' })));
    assert.equal(e.kind, 'quota_provider', provider);
    assert.equal(e.retryAfterMs, null);
    assertNoLeak(e);
  }
});

test('[MOCK] gemini: batas per menit (RESOURCE_EXHAUSTED) -> rate_limit; kunci tidak valid (400) -> auth', async () => {
  const e1 = await rejects(chat(base('gemini', mockFetch(json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric requests per minute' } })))));
  assert.equal(e1.kind, 'rate_limit');
  const e2 = await rejects(chat(base('gemini', mockFetch(json(400, {
    error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] },
  })))));
  assert.equal(e2.kind, 'auth');
});

test('[MOCK] 400 lain, 404, 413, 422 -> bad_request; 404 memberi petunjuk model/Base URL', async () => {
  for (const status of [400, 413, 422]) {
    const e = await rejects(chat(base('openai', mockFetch(json(status, { error: { message: `pantulan ${TEXT}` } })))));
    assert.equal(e.kind, 'bad_request', String(status));
    assert.equal(e.http, status);
    assertNoLeak(e);
  }
  const nf = await rejects(chat(base('gemini', mockFetch(json(404, { error: { message: 'models/model-uji is not found' } })))));
  assert.equal(nf.kind, 'bad_request');
  assert.match(nf.message, /Model atau alamat tidak ditemukan/);
});

test('[MOCK] 5xx (termasuk 529) -> server; Retry-After ikut dibaca', async () => {
  for (const status of [500, 502, 503, 529]) {
    const e = await rejects(chat(base('anthropic', mockFetch(json(status, { error: { message: 'overloaded' } }, { 'retry-after': '3' })))));
    assert.equal(e.kind, 'server', String(status));
    assert.equal(e.http, status);
    assert.equal(e.retryAfterMs, 3000);
  }
  const e = await rejects(chat(base('openai', mockFetch(new Response('Bad Gateway', { status: 502 })))));
  assert.equal(e.kind, 'server');
});

test('[MOCK] galat bahasa Indonesia, badan galat server tidak pernah disalin ke pesan', async () => {
  const f = mockFetch(json(400, { error: { message: `Server memantulkan: ${KEY} ${TEXT} ${SYSTEM}` } }));
  const e = await rejects(chat(base('openai', f)));
  assertNoLeak(e);
  assert.ok(!e.message.includes('Server memantulkan'));
  assert.match(e.message, /penyedia AI/);
});

// ---------- timeout dan jaringan ----------

test('[MOCK] timeout: timer injeksi menembak, fetch di-abort, kind timeout', async () => {
  let fire;
  let cleared = 0;
  const setTimer = (fn, ms) => { fire = fn; setTimer.ms = ms; return 42; };
  const clearTimer = (t) => { if (t === 42) cleared += 1; };
  let signal;
  const f = (url, init) => { signal = init.signal; fire(); return new Promise(() => {}); }; // tidak pernah selesai
  const e = await rejects(chat(base('anthropic', f, { setTimer, clearTimer, timeoutMs: 1234 })));
  assert.equal(e.kind, 'timeout');
  assert.equal(setTimer.ms, 1234);
  assert.equal(signal.aborted, true);
  assert.equal(cleared, 1);
  assertNoLeak(e);
});

test('[MOCK] timeoutMs bawaan 20000 bila tidak diberikan', async () => {
  let ms;
  const setTimer = (fn, t) => { ms = t; return 1; };
  await chat(base('openai', mockFetch(okOpenai()), { setTimer, clearTimer: () => {} }));
  assert.equal(ms, 20000);
});

test('[MOCK] fetch melempar AbortError/TimeoutError -> timeout; timer dibersihkan saat sukses', async () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    const f = async () => { throw Object.assign(new Error('dibatalkan'), { name }); };
    const e = await rejects(chat(base('openai', f)));
    assert.equal(e.kind, 'timeout', name);
  }
  let cleared = 0;
  await chat(base('openai', mockFetch(okOpenai()), { setTimer: () => 7, clearTimer: (t) => { if (t === 7) cleared += 1; } }));
  assert.equal(cleared, 1);
});

test('[MOCK] jaringan gagal -> unreachable tanpa cause dan tanpa membocorkan URL/kunci', async () => {
  const f = async (url) => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: `connect gagal ${url} ${KEY} ${TEXT}` } });
  };
  for (const p of PROVIDERS) {
    const e = await rejects(chat(base(p, f, { baseUrl: 'https://x.test/v1' })));
    assert.equal(e.kind, 'unreachable', p);
    assert.equal(e.cause, undefined);
    assertNoLeak(e);
  }
});

// ---------- kunci tidak bocor ----------

test('[MOCK] kunci tidak ada di URL tiap penyedia dan tidak ada di galat apa pun', async () => {
  for (const p of PROVIDERS) {
    const f = mockFetch(json(500, { error: { message: KEY } }));
    const e = await rejects(chat(base(p, f, { baseUrl: 'https://x.test/v1' })));
    assert.ok(!f.calls[0].url.includes(KEY), `URL ${p}`);
    assertNoLeak(e);
  }
});

// ---------- validasi masukan ----------

test('validasi: penyedia tidak dikenal, model kosong, kunci kosong/tidak valid -> tanpa panggilan jaringan', async () => {
  const f = mockFetch(okOpenai());
  const cases = [
    [base('claude-lama', f), 'bad_request'],
    [base('openai', f, { model: '  ' }), 'bad_request'],
    [base('openai', f, { apiKey: '' }), 'auth'],
    [base('anthropic', f, { apiKey: undefined }), 'auth'],
    [base('gemini', f, { apiKey: 'kunci\r\nX-Injeksi: 1' }), 'auth'],
    [base('openai', f, { apiKey: 'kunci-é' }), 'auth'],
    [base('openai', f, { messages: 'bukan array' }), 'bad_request'],
    [base('openai', f, { messages: [{ role: 'system', content: 'x' }] }), 'bad_request'],
    [base('openai', f, { messages: [{ role: 'user', content: 123 }] }), 'bad_request'],
  ];
  for (const [cfg, kind] of cases) {
    const e = await rejects(chat(cfg));
    assert.ok(e instanceof AiError);
    assert.equal(e.kind, kind);
    assert.ok(!e.message.includes('Injeksi'));
    assertNoLeak(e);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await rejects(chat())).kind, 'bad_request');
});

test('validasi: baseUrl tidak valid, protokol salah, memuat kredensial/query -> bad_request', async () => {
  for (const baseUrl of ['bukan url', 'ftp://x.test/v1', 'https://user:pass@x.test/v1', 'https://x.test/v1?key=abc', 'https://x.test/v1#frag']) {
    const f = mockFetch(okOpenai());
    const e = await rejects(chat(base('openai', f, { baseUrl })));
    assert.equal(e.kind, 'bad_request', baseUrl);
    assert.ok(!e.message.includes('pass'));
    assert.equal(f.calls.length, 0);
  }
});

// ---------- testConnection ----------

test('[MOCK] testConnection: sukses dengan permintaan sangat kecil', async () => {
  const f = mockFetch(okOpenai());
  const r = await testConnection({ provider: 'openai', apiKey: KEY, model: 'm', fetchImpl: f });
  assert.equal(r.ok, true);
  assert.match(r.message, /berhasil/i);
  assert.equal(f.calls.length, 1);
  const body = f.calls[0].body;
  assert.ok(body.max_completion_tokens <= 32);
  assert.equal(body.messages.length, 2);
});

test('[MOCK] testConnection: tidak pernah melempar; kind dan pesan ramah untuk tiap galat', async () => {
  const cases = [
    [json(401, {}), 'auth'],
    [json(429, { error: { code: 'insufficient_quota' } }), 'quota_provider'],
    [json(429, {}), 'rate_limit'],
    [json(404, {}), 'bad_request'],
    [json(503, {}), 'server'],
  ];
  for (const [res, kind] of cases) {
    const r = await testConnection({ provider: 'openai', apiKey: KEY, model: 'm', fetchImpl: mockFetch(res) });
    assert.equal(r.ok, false);
    assert.equal(r.kind, kind);
    assert.ok(r.message.length > 0);
    assert.ok(!r.message.includes(KEY));
  }
  const net = await testConnection({ provider: 'gemini', apiKey: KEY, model: 'm', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual([net.ok, net.kind], [false, 'unreachable']);
  const inv = await testConnection({ provider: 'tidak-ada' });
  assert.deepEqual([inv.ok, inv.kind], [false, 'bad_request']);
  const none = await testConnection();
  assert.equal(none.ok, false);
});

test('[MOCK] testConnection: tidak membocorkan system/pesan pengguna dari cfg dan mengabaikannya', async () => {
  const f = mockFetch(okAnthropic());
  await testConnection({ provider: 'anthropic', apiKey: KEY, model: 'm', fetchImpl: f, system: SYSTEM, messages: MSGS, maxTokens: 5000 });
  const sent = JSON.stringify(f.calls[0].body);
  assert.ok(!sent.includes(TEXT));
  assert.ok(!sent.includes('JANGAN-BOCOR-987'));
  assert.ok(f.calls[0].body.max_tokens <= 32);
});

test('[MOCK] testConnection: jawaban kosong (model berpikir) dianggap koneksi berhasil', async () => {
  const f = mockFetch(json(200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }], usageMetadata: { promptTokenCount: 4, thoughtsTokenCount: 16 } }));
  const r = await testConnection({ provider: 'gemini', apiKey: KEY, model: 'm', fetchImpl: f });
  assert.equal(r.ok, true);
  assert.match(r.message, /kosong/);
});

test('[MOCK] testConnection: timeout dipetakan ke kind timeout', async () => {
  let fire;
  const f = () => { fire(); return new Promise(() => {}); };
  const r = await testConnection({
    provider: 'anthropic', apiKey: KEY, model: 'm', fetchImpl: f,
    setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {},
  });
  assert.deepEqual([r.ok, r.kind], [false, 'timeout']);
});
