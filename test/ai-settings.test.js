// Uji backend pengaturan AI (B7): kunci API tidak bocor (respons, riwayat, audit, log, berkas), hak akses admin vs agent,
// If-Match, validasi lewat API, dan endpoint /api/ai/* dengan MOCK (tanpa jaringan, tanpa database).
// Catatan: mock penyedia/kuota di sini BUKAN bukti berhasil dengan layanan AI nyata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-ai-'));
process.env.DATA_DIR = DIR;
delete process.env.AI_API_KEY;
delete process.env.DATA_KEY;

// tangkap semua keluaran konsol: kunci/pesan sensitif tidak boleh ada di log
const logs = [];
for (const m of ['log', 'error', 'warn', 'info']) console[m] = (...a) => logs.push(a.map(String).join(' '));

const settings = await import('../src/settings.js');
const secret = await import('../src/ai-secret.js');
const settingsApi = await import('../src/api/settings.js');
const aiApi = await import('../src/api/ai.js');

const K1 = 'sk-ant-uji-rahasia-AAAA1111';
const K2 = 'sk-ant-uji-rahasia-BBBB2222';
const SECRETS = [K1, K2];
const file = (f) => path.join(DIR, f);
const readIf = (f) => (fs.existsSync(file(f)) ? fs.readFileSync(file(f), 'utf8') : '');
const allAudits = [];

// ctx tiruan: requireRole meniru server (admin boleh semua, agent hanya yang bukan admin)
async function call(handler, method, pathname, { role = 'admin', body, headers = {} } = {}) {
  const res = { status: 0, body: undefined };
  const audits = [];
  const user = { name: `${role}1`, role };
  const ctx = {
    user,
    ip: '127.0.0.1',
    sendJSON: (r, code, b) => { r.status = code; r.body = b; },
    readBody: async () => body,
    audit: (action, detail) => { audits.push({ action, detail }); allAudits.push({ action, detail }); },
    requireRole(r) {
      if (user.role === 'admin' || user.role === r) return true;
      audits.push({ action: 'akses.ditolak', detail: { path: pathname, butuh: r } });
      res.status = 403;
      res.body = { error: `Akses ditolak: perlu peran ${r}` };
      return false;
    },
  };
  const handled = await handler({ method, headers }, res, new URL(`http://x${pathname}`), ctx);
  return { handled, status: res.status, json: res.body, text: JSON.stringify(res.body ?? null), audits };
}

// penyedia/kuota palsu
function fakes({ quota = null, providers = null } = {}) {
  const calls = { test: [] };
  const prov = providers ?? { testConnection: async () => ({ ok: true, message: 'Koneksi berhasil.' }) };
  const wrapped = prov && {
    testConnection: async (cfg) => { calls.test.push(cfg); return prov.testConnection(cfg); },
  };
  const handler = aiApi.createHandler({ loadQuota: async () => quota, loadProviders: async () => wrapped });
  return { handler, calls };
}

const reset = () => {
  secret.clearAiKey();
  delete process.env.AI_API_KEY;
  delete process.env.DATA_KEY;
};

test('kunci: simpan, baca, hapus; hanya { hasKey } yang keluar; berkas 0600; berkas .bak tidak menyisakan kunci lama', async () => {
  reset();
  const { handler } = fakes();
  assert.equal(secret.hasAiKey(), false);
  assert.equal(secret.getAiKey(), '');

  const r1 = await call(handler, 'PUT', '/api/ai/key', { body: { key: `  ${K1}  ` } });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.json, { hasKey: true });
  assert.equal(secret.getAiKey(), K1); // dipangkas
  assert.ok(!r1.text.includes(K1));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file('ai-secret.json')).mode & 0o777, 0o600);

  const r2 = await call(handler, 'PUT', '/api/ai/key', { body: { key: K2 } }); // ganti kunci
  assert.deepEqual(r2.json, { hasKey: true });
  assert.equal(secret.getAiKey(), K2);
  assert.ok(!readIf('ai-secret.json.bak').includes(K1), 'kunci lama tidak tertinggal di .bak');
  assert.equal(fs.existsSync(file('ai-secret.json.bak')), false);

  // kunci tidak pernah bisa dibaca lewat API: GET tidak ditangani
  const g = await call(handler, 'GET', '/api/ai/key');
  assert.equal(g.handled, false);

  const d = await call(handler, 'DELETE', '/api/ai/key');
  assert.equal(d.status, 200);
  assert.deepEqual(d.json, { hasKey: false });
  assert.equal(secret.getAiKey(), '');
  assert.equal(fs.existsSync(file('ai-secret.json')), false);
  assert.equal(fs.existsSync(file('ai-secret.json.bak')), false);

  // audit: ada catatan, tanpa nilai kunci
  assert.deepEqual(allAudits.filter((a) => a.action.startsWith('ai.key')).map((a) => a.action), ['ai.key.set', 'ai.key.set', 'ai.key.delete']);
});

test('kunci tidak valid ditolak 400 tanpa mengulang isinya', async () => {
  reset();
  const { handler } = fakes();
  for (const body of [{ key: '' }, { key: '   ' }, { key: 'ada spasi' }, { key: 'baris\nbaru' }, { key: 'x'.repeat(513) }, { key: 123 }, { key: null }, {}, null, [], 'teks']) {
    const r = await call(handler, 'PUT', '/api/ai/key', { body });
    assert.equal(r.status, 400, JSON.stringify(body)?.slice(0, 40));
    assert.ok(!r.text.includes('ada spasi') && !r.text.includes('baris'));
  }
  assert.equal(secret.hasAiKey(), false);
  assert.throws(() => secret.setAiKey('a b'), (e) => e.code === 'VALIDATION' && !e.message.includes('a b'));
});

test('cadangan env AI_API_KEY dipakai bila tidak ada kunci tersimpan; kunci tersimpan menang', async () => {
  reset();
  const { handler } = fakes();
  process.env.AI_API_KEY = ' sk-env-uji-777 ';
  assert.equal(secret.getAiKey(), 'sk-env-uji-777');
  assert.equal(secret.hasAiKey(), true);
  await call(handler, 'PUT', '/api/ai/key', { body: { key: K1 } });
  assert.equal(secret.getAiKey(), K1);
  const d = await call(handler, 'DELETE', '/api/ai/key');
  assert.deepEqual(d.json, { hasKey: true }); // env masih ada
  assert.equal(secret.getAiKey(), 'sk-env-uji-777');
  delete process.env.AI_API_KEY;
  assert.equal(secret.hasAiKey(), false);
});

test('DATA_KEY aktif: kunci terenkripsi di disk (berkas dan .bak), tetap terbaca; DATA_KEY hilang -> tidak jatuh, tidak bocor', async () => {
  reset();
  process.env.DATA_KEY = '0123456789abcdef'.repeat(4);
  secret.setAiKey(K1);
  secret.setAiKey(K2);
  const raw = readIf('ai-secret.json');
  assert.equal(JSON.parse(raw).__enc, 'e1');
  for (const f of fs.readdirSync(DIR)) assert.ok(!fs.readFileSync(file(f), 'utf8').includes(K2), `${f} tidak boleh memuat kunci polos`);
  assert.equal(secret.getAiKey(), K2);

  // DATA_KEY hilang: berkas tidak bisa dibaca -> '' (atau env), bukan galat yang menjatuhkan balasan; log tanpa kunci
  delete process.env.DATA_KEY;
  assert.equal(secret.getAiKey(), '');
  assert.equal(secret.hasAiKey(), false);
  process.env.AI_API_KEY = 'sk-env-cadangan';
  assert.equal(secret.getAiKey(), 'sk-env-cadangan');
  delete process.env.AI_API_KEY;
  assert.ok(logs.some((l) => l.includes('[ai-secret]')), 'masalah kunci data dicatat');

  process.env.DATA_KEY = '0123456789abcdef'.repeat(4);
  assert.equal(secret.getAiKey(), K2);
  reset();
});

test('hak akses: agent boleh /usage, tidak boleh /test, PUT/DELETE /key; tanpa efek', async () => {
  reset();
  const quota = { usage: () => ({ month: { used: 3, reserved: 1, limit: 1000, remaining: 996, from: 'a', to: 'b' }, today: { used: 1 }, daily: [], tokens: { input: 10, output: 5 } }) };
  const { handler, calls } = fakes({ quota });
  secret.setAiKey(K1);

  const u = await call(handler, 'GET', '/api/ai/usage', { role: 'agent' });
  assert.equal(u.status, 200);
  assert.equal(u.json.month.used, 3);
  assert.equal((await call(handler, 'GET', '/api/ai/usage', { role: 'admin' })).status, 200);

  for (const [m, p, body] of [['POST', '/api/ai/test', {}], ['PUT', '/api/ai/key', { key: K2 }], ['DELETE', '/api/ai/key']]) {
    const r = await call(handler, m, p, { role: 'agent', body });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.ok(!SECRETS.some((s) => r.text.includes(s)));
  }
  assert.equal(secret.getAiKey(), K1, 'agent tidak bisa mengganti/menghapus kunci');
  assert.equal(calls.test.length, 0, 'agent tidak memicu panggilan ke penyedia');

  // garis miring akhir tidak membuka jalan pintas
  assert.equal((await call(handler, 'PUT', '/api/ai/key/', { role: 'agent', body: { key: K2 } })).status, 403);
  assert.equal((await call(handler, 'POST', '/api/ai/test/', { role: 'agent', body: {} })).status, 403);
  reset();
});

test('hak akses pengaturan: agent boleh membaca (tanpa notify), tidak boleh PUT/riwayat/restore', async () => {
  reset();
  secret.setAiKey(K1);
  const a = await call(settingsApi.handle, 'GET', '/api/settings', { role: 'agent' });
  assert.equal(a.status, 200);
  assert.ok(!('notify' in a.json));
  assert.equal(a.json.ai.hasKey, true);
  assert.ok(Array.isArray(a.json.knowledge));
  assert.ok(!SECRETS.some((s) => a.text.includes(s)));

  const v = settings.get().version;
  for (const [m, p, body] of [['PUT', '/api/settings', { ai: { persona: 'diretas' } }], ['GET', '/api/settings/history'], ['POST', '/api/settings/restore', { version: 1 }]]) {
    const r = await call(settingsApi.handle, m, p, { role: 'agent', body });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal(settings.get().version, v);
  assert.notEqual(settings.get().ai.persona, 'diretas');
  reset();
});

test('GET/PUT /api/settings: memuat ai dan knowledge tanpa kunci; validasi; If-Match; audit tanpa nilai', async () => {
  reset();
  secret.setAiKey(K1);
  const g = await call(settingsApi.handle, 'GET', '/api/settings');
  assert.equal(g.status, 200);
  assert.equal(g.json.ai.provider, 'anthropic');
  assert.equal(g.json.ai.hasKey, true);
  assert.ok(!('apiKey' in g.json.ai) && !('key' in g.json.ai));
  assert.ok(!('intents' in g.json) && !('slangMap' in g.json));
  assert.equal(g.json.phoneFormat, 'digits');
  assert.deepEqual(g.json.requiredFields.map((f) => f.id), ['referensi']);

  const v0 = g.json.version;
  const PERSONA = 'Persona rahasia toko Mawar yang unik';
  const ok = await call(settingsApi.handle, 'PUT', '/api/settings', {
    headers: { 'if-match': `"${v0}"` },
    body: { ai: { enabled: true, model: 'model-uji', persona: PERSONA, apiKey: K2 }, knowledge: [{ title: 'Jam buka', content: 'Isi pengetahuan rahasia 09.00' }], greetingWords: ['halo'], phoneFormat: 'international' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.version, v0 + 1);
  assert.equal(ok.json.ai.persona, PERSONA);
  assert.equal(ok.json.ai.hasKey, true);
  assert.equal(ok.json.knowledge.length, 1);
  assert.deepEqual(ok.json.greetingWords, ['halo']);
  assert.ok(!SECRETS.some((s) => ok.text.includes(s)), 'kunci yang terselip di body tidak kembali');
  assert.equal(secret.getAiKey(), K1, 'kunci di body PUT /api/settings tidak mengganti kunci');

  // audit: nama field saja, tanpa persona/isi/kunci
  const au = ok.audits.find((a) => a.action === 'settings.update');
  assert.deepEqual(au.detail.fields.sort(), ['ai', 'greetingWords', 'knowledge', 'phoneFormat']);
  assert.deepEqual(au.detail.aiFields.sort(), ['enabled', 'model', 'persona']); // apiKey bukan field AI: tidak tercatat
  assert.equal(au.detail.knowledgeCount, 1);
  const auditText = JSON.stringify(ok.audits);
  assert.ok(!auditText.includes(PERSONA) && !auditText.includes('rahasia 09.00') && !SECRETS.some((s) => auditText.includes(s)));

  // If-Match: versi usang -> 409 + current (tanpa kunci), tidak ada perubahan; format W/"n" dan tanpa header
  const stale = await call(settingsApi.handle, 'PUT', '/api/settings', { headers: { 'if-match': String(v0) }, body: { ai: { persona: 'usang' } } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.current.version, v0 + 1);
  assert.equal(stale.json.current.ai.persona, PERSONA);
  assert.ok(!SECRETS.some((s) => stale.text.includes(s)));
  const weak = await call(settingsApi.handle, 'PUT', '/api/settings', { headers: { 'if-match': `W/"${v0 + 1}"` }, body: { ai: { persona: 'lemah-ok' } } });
  assert.equal(weak.status, 200);
  assert.equal((await call(settingsApi.handle, 'PUT', '/api/settings', { body: { ai: { persona: 'tanpa-header' } } })).status, 200);
  assert.equal(settings.get().ai.persona, 'tanpa-header');

  // validasi lewat API -> 400 dengan pesan Indonesia, tidak mengulang isi, tidak ada perubahan
  const v1 = settings.get().version;
  const bads = [
    { ai: { provider: 'tidak-ada' } },
    { ai: { baseUrl: 'https://u:p@x.com' } },
    { ai: { provider: 'openai-compatible', baseUrl: '' } },
    { phoneFormat: 'nomor' },
    { knowledge: Array.from({ length: 201 }, (_, i) => ({ title: `T${i}`, content: 'c' })) },
    { knowledge: [{ title: 'J', content: 'Z'.repeat(20001) }] },
  ];
  for (const body of bads) {
    const r = await call(settingsApi.handle, 'PUT', '/api/settings', { body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 50));
    assert.equal(typeof r.json.error, 'string');
    assert.ok(!r.text.includes('ZZZZZZZZ') && !r.text.includes('u:p'));
  }
  assert.equal(settings.get().version, v1);
  assert.equal((await call(settingsApi.handle, 'PUT', '/api/settings', { body: [] })).status, 400);
  reset();
});

test('riwayat versi dan berkas pengaturan tidak memuat kunci; pemulihan tidak mengubah kunci', async () => {
  reset();
  secret.setAiKey(K1);
  settings.update({ ai: { persona: 'sebelum' } }, { by: 'adm' });
  const target = settings.get().version;
  settings.update({ ai: { persona: 'sesudah' } }, { by: 'adm' });
  const h = await call(settingsApi.handle, 'GET', '/api/settings/history');
  assert.equal(h.status, 200);
  assert.ok(h.json.length > 0);
  assert.ok(!SECRETS.some((s) => h.text.includes(s)));
  const rs = await call(settingsApi.handle, 'POST', '/api/settings/restore', { body: { version: target } });
  assert.equal(rs.status, 200);
  assert.equal(rs.json.ai.persona, 'sebelum');
  assert.ok(!SECRETS.some((s) => rs.text.includes(s)));
  assert.equal(secret.getAiKey(), K1);
  for (const f of ['settings.json', 'settings.history.json', 'settings.json.bak', 'settings.history.json.bak']) {
    assert.ok(!SECRETS.some((s) => readIf(f).includes(s)), f);
  }
  reset();
});

test('POST /api/ai/test: memakai kunci/model/penyedia tersimpan; hasil disaring; galat terklasifikasi', async () => {
  reset();
  settings.update({ ai: { enabled: false, provider: 'openai', model: 'model-uji', baseUrl: '', timeoutMs: 9000 } }, { by: 'adm' });

  // tanpa kunci / tanpa model / compatible tanpa URL: tidak menghubungi penyedia
  let f = fakes();
  let r = await call(f.handler, 'POST', '/api/ai/test', { body: {} });
  assert.deepEqual([r.status, r.json.ok, r.json.kind], [200, false, 'auth']);
  assert.equal(f.calls.test.length, 0);

  secret.setAiKey(K1);
  const noModel = aiApi.createHandler({ getSettings: () => ({ ai: { provider: 'openai', model: '', baseUrl: '' } }), loadProviders: async () => ({ testConnection: async () => { throw new Error('tidak boleh dipanggil'); } }) });
  r = await call(noModel, 'POST', '/api/ai/test', { body: {} });
  assert.deepEqual([r.json.ok, r.json.kind], [false, 'bad_request']);
  const noUrl = aiApi.createHandler({ getSettings: () => ({ ai: { provider: 'openai-compatible', model: 'm', baseUrl: '' } }), loadProviders: async () => ({ testConnection: async () => { throw new Error('tidak boleh dipanggil'); } }) });
  r = await call(noUrl, 'POST', '/api/ai/test', { body: {} });
  assert.deepEqual([r.json.ok, r.json.kind], [false, 'bad_request']);

  // sukses: argumen yang dikirim ke adaptor = pengaturan tersimpan + kunci
  f = fakes();
  r = await call(f.handler, 'POST', '/api/ai/test', { body: { provider: 'gemini', model: 'diabaikan', apiKey: 'diabaikan' } });
  assert.deepEqual(r.json, { ok: true, message: 'Koneksi berhasil.' });
  assert.equal(f.calls.test.length, 1);
  assert.deepEqual(
    { provider: f.calls.test[0].provider, model: f.calls.test[0].model, apiKey: f.calls.test[0].apiKey, timeoutMs: f.calls.test[0].timeoutMs, baseUrl: f.calls.test[0].baseUrl },
    { provider: 'openai', model: 'model-uji', apiKey: K1, timeoutMs: 9000, baseUrl: '' }
  );
  const aud = r.audits.find((a) => a.action === 'ai.test');
  assert.deepEqual(aud.detail, { ok: true, provider: 'openai' });

  // penyedia gagal dengan pesan yang mengutip kunci -> disaring; kind diteruskan
  f = fakes({ providers: { testConnection: async () => ({ ok: false, kind: 'auth', message: `Kunci salah: ${K1} dan sk-lain-abcdef123456` }) } });
  r = await call(f.handler, 'POST', '/api/ai/test', { body: {} });
  assert.deepEqual([r.json.ok, r.json.kind], [false, 'auth']);
  assert.ok(!r.text.includes(K1) && !r.text.includes('sk-lain-abcdef123456'));
  assert.ok(r.json.message.includes('[kunci]'));

  // adaptor melempar AiError-like / galat biasa / modul belum ada
  const err = Object.assign(new Error(`timeout memanggil dengan ${K1}`), { kind: 'timeout' });
  f = fakes({ providers: { testConnection: async () => { throw err; } } });
  r = await call(f.handler, 'POST', '/api/ai/test', { body: {} });
  assert.deepEqual([r.status, r.json.ok, r.json.kind], [200, false, 'timeout']);
  assert.ok(!r.text.includes(K1));
  f = fakes({ providers: { testConnection: async () => { throw new TypeError('rusak'); } } });
  assert.equal((await call(f.handler, 'POST', '/api/ai/test', { body: {} })).json.kind, 'server');
  const none = aiApi.createHandler({ loadProviders: async () => null });
  r = await call(none, 'POST', '/api/ai/test', { body: {} });
  assert.deepEqual([r.json.ok, r.json.kind], [false, 'unavailable']);

  // fetch yang disuntik diteruskan ke adaptor (tes tidak memakai jaringan)
  const fetchImpl = async () => { throw new Error('jaringan tidak boleh dipakai'); };
  let seen = null;
  const inj = aiApi.createHandler({ fetchImpl, loadProviders: async () => ({ testConnection: async (cfg) => { seen = cfg.fetchImpl; return { ok: true, message: 'ok' }; } }) });
  await call(inj, 'POST', '/api/ai/test', { body: {} });
  assert.equal(seen, fetchImpl);
  reset();
});

test('GET /api/ai/usage: meneruskan B3; fallback aman bila B3 belum ada; galat B3 -> 503 tanpa detail', async () => {
  reset();
  settings.update({ ai: { monthlyQuota: 250 } }, { by: 'adm' });
  const real = { month: { used: 7, reserved: 2, limit: 250, remaining: 241, from: '2026-11-01', to: '2026-11-30' }, today: { used: 2 }, daily: [{ date: '2026-11-15', used: 2 }], tokens: { input: 100, output: 50 } };
  let r = await call(fakes({ quota: { usage: async () => real } }).handler, 'GET', '/api/ai/usage', { role: 'agent' });
  assert.deepEqual(r.json, real);

  r = await call(fakes({ quota: null }).handler, 'GET', '/api/ai/usage', { role: 'agent' });
  assert.equal(r.status, 200);
  assert.equal(r.json.available, false);
  assert.deepEqual(r.json.month, { used: 0, reserved: 0, limit: 250, remaining: 250, from: null, to: null });
  assert.deepEqual([r.json.today, r.json.daily, r.json.tokens], [{ used: 0 }, [], { input: 0, output: 0 }]);

  r = await call(fakes({ quota: { usage: () => { throw new Error('SQLITE rusak berisi rahasia'); } } }).handler, 'GET', '/api/ai/usage');
  assert.equal(r.status, 503);
  assert.ok(!r.text.includes('rahasia'));

  // modul bawaan (impor dinamis): B3/B1 belum ada di berkas ini -> tetap aman; jalur lain tidak ditangani
  assert.equal(typeof aiApi.handle, 'function');
  assert.equal((await call(aiApi.handle, 'GET', '/api/leads')).handled, false);
  assert.equal((await call(aiApi.handle, 'POST', '/api/ai/usage')).handled, false);
});

test('server nyata (DATA_KEY aktif): admin vs agent, kunci tidak bocor di respons, audit, log server, maupun berkas di disk', async () => {
  const { startServer, Client } = await import('./helpers/server.js');
  const KEY = 'sk-http-uji-rahasia-ZZZZ9999';
  const srv = await startServer({ env: { CONNECT_DRY_RUN: '1', CLIENT_ID: 'klinik-uji', DATA_KEY: 'abcdef0123456789'.repeat(4), AI_API_KEY: '' } });
  try {
    const admin = new Client(srv.base);
    assert.equal((await admin.login()).status, 302);
    await admin.get('/api/me');
    assert.equal((await admin.post('/api/users', { name: 'agen1', password: 'sandi-agen-12345', role: 'agent' })).status, 201);
    const agent = new Client(srv.base);
    assert.equal((await agent.login('agen1', 'sandi-agen-12345')).status, 302);
    assert.equal((await agent.get('/api/me')).json.role, 'agent');

    // agent: hanya baca pemakaian; kunci/uji/pengaturan ditolak
    const au = await agent.get('/api/ai/usage');
    assert.equal(au.status, 200);
    assert.equal(typeof au.json.month, 'object');
    for (const [m, pth, body] of [['PUT', '/api/ai/key', { key: KEY }], ['DELETE', '/api/ai/key', {}], ['POST', '/api/ai/test', {}], ['PUT', '/api/settings', { ai: { persona: 'x' } }]]) {
      const r = await agent.req(m, pth, { body });
      assert.equal(r.status, 403, `${m} ${pth}`);
    }
    assert.equal((await admin.get('/api/settings')).json.ai.hasKey, false);

    // admin: simpan kunci -> hanya { hasKey:true }
    const put = await admin.req('PUT', '/api/ai/key', { body: { key: KEY } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.json, { hasKey: true });
    assert.equal((await admin.req('GET', '/api/ai/key')).status, 404);
    assert.equal((await admin.req('PUT', '/api/ai/key', { body: { key: 'ada spasi' } })).status, 400);

    // pengaturan: kunci tidak pernah ikut; kunci terselip di body diabaikan; If-Match
    const g = await admin.get('/api/settings');
    assert.equal(g.json.ai.hasKey, true);
    const v0 = g.json.version;
    const ok = await admin.req('PUT', '/api/settings', { headers: { 'If-Match': `"${v0}"` }, body: { ai: { persona: 'Ramah', apiKey: KEY }, knowledge: [{ title: 'Jam', content: 'Buka 09.00' }] } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.knowledge.length, 1);
    assert.equal((await admin.req('PUT', '/api/settings', { headers: { 'If-Match': `"${v0}"` }, body: { ai: { persona: 'usang' } } })).status, 409);
    assert.equal((await admin.req('PUT', '/api/settings', { body: { ai: { provider: 'ngawur' } } })).status, 400);
    for (const who of [admin, agent]) {
      const r = await who.get('/api/settings');
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes(KEY));
      assert.equal(r.json.ai.hasKey, true);
    }
    // uji koneksi tanpa nama model berhenti sebelum menghubungi penyedia (tanpa jaringan)
    const tst = await admin.req('POST', '/api/ai/test', { body: {} });
    assert.equal(tst.status, 200);
    assert.deepEqual([tst.json.ok, tst.json.kind], [false, 'bad_request']);

    // audit lewat API tidak memuat kunci, tetapi mencatat tindakannya
    const audit = await admin.get('/api/audit');
    assert.equal(audit.status, 200);
    assert.ok(!audit.text.includes(KEY));
    assert.ok(/ai\.key\.set/.test(audit.text) && /settings\.update/.test(audit.text));

    assert.ok(!srv.logs().includes(KEY), 'log server tidak memuat kunci');
    // di disk: tidak ada berkas (termasuk ai-secret.json, audit, cadangan) yang memuat kunci polos
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(srv.dataDir);
    assert.ok(files.some((f) => path.basename(f) === 'ai-secret.json'));
    for (const f of files) assert.ok(!fs.readFileSync(f).includes(KEY), `${path.basename(f)} memuat kunci polos`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(srv.dataDir, 'ai-secret.json')).mode & 0o777, 0o600);

    // hapus kunci
    assert.deepEqual((await admin.req('DELETE', '/api/ai/key', { body: {} })).json, { hasKey: false });
    assert.equal((await admin.get('/api/settings')).json.ai.hasKey, false);
  } finally {
    await srv.stop();
  }
});

test('tidak ada kunci di log, audit, maupun berkas pengaturan selama seluruh uji', () => {
  for (const s of SECRETS) {
    assert.ok(!logs.some((l) => l.includes(s)), 'log');
    assert.ok(!JSON.stringify(allAudits).includes(s), 'audit');
  }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* Windows bisa menahan berkas sebentar */ }
});
