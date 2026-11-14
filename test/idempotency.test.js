// Idempotensi API (F-05/F-06): validasi kunci, reservasi atomik di SQLite, replay, konflik isi, kedaluwarsa,
// restart, isolasi antar-klien/endpoint, dan keserentakan (dalam proses dan lintas proses).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, Client } from './helpers/server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-idem-'));
process.env.DATA_DIR = dir;
process.env.AMNAN_NO_BG = '1';
process.env.AMNAN_NO_BACKUP = '1';
const C = await import('../src/connect.js');
const D = await import('../src/db.js');
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const opt = (body, endpoint = 'POST /api/v1/messages') => ({ endpoint, fingerprint: C.requestFingerprint('POST', '/api/v1/messages', body) });
const rows = () => D.getDb().prepare('SELECT * FROM idempotency_keys').all();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- validasi kunci ----
test('kunci valid diterima; kosong = null; format/panjang salah ditolak; header vs body berbeda ditolak', () => {
  for (const k of ['konfirmasi-BK-1', '3f2b8c1e-9a4d-4e7b-8c11-0a1b2c3d4e5f', 'booking:123:confirm', 'A'.repeat(120), 'abcdefgh']) {
    assert.equal(C.idemKeyFrom({ headers: { 'idempotency-key': k } }, {}), k);
  }
  assert.equal(C.idemKeyFrom({ headers: {} }, {}), null);
  assert.equal(C.idemKeyFrom({ headers: { 'idempotency-key': '   ' } }, {}), null);
  assert.equal(C.idemKeyFrom({ headers: {} }, { idempotencyKey: 'dari-body-123' }), 'dari-body-123');
  for (const bad of ['pendek', 'A'.repeat(121), 'ada spasi di sini', 'kunci;drop-table', 'kunci/slash/aja', 'tab\tkunci-1234', 'éééééééé']) {
    assert.throws(() => C.idemKeyFrom({ headers: { 'idempotency-key': bad } }, {}), /8-120/, bad);
  }
  assert.throws(() => C.idemKeyFrom({ headers: { 'idempotency-key': 'kunci-header-1' } }, { idempotencyKey: 'kunci-body-0001' }), /berbeda/);
});

test('sidik jari stabil terhadap urutan properti dan mengabaikan idempotencyKey di body', () => {
  const a = C.requestFingerprint('POST', '/p', { phone: '1', text: 'x', nested: { b: 1, a: [1, 2] } });
  const b = C.requestFingerprint('POST', '/p', { nested: { a: [1, 2], b: 1 }, text: 'x', phone: '1', idempotencyKey: 'abc12345' });
  assert.equal(a, b);
  assert.notEqual(a, C.requestFingerprint('POST', '/p', { phone: '1', text: 'y', nested: { b: 1, a: [1, 2] } }));
  assert.notEqual(a, C.requestFingerprint('PUT', '/p', { phone: '1', text: 'x', nested: { b: 1, a: [1, 2] } }));
});

// ---- perilaku inti ----
test('duplikat berurutan: efek sekali, replay identik, tanpa menyimpan kunci klien mentah', async () => {
  let runs = 0;
  const body = { phone: '1', text: 'a' };
  const fn = async () => ({ status: 200, body: { n: ++runs } });
  const a = await C.withIdempotency('app1', 'kunci-berurutan-1', fn, opt(body));
  const b = await C.withIdempotency('app1', 'kunci-berurutan-1', fn, opt(body));
  assert.deepEqual([a.replay, b.replay], [false, true]);
  assert.deepEqual([a.body, b.body], [{ n: 1 }, { n: 1 }]);
  assert.equal(runs, 1);
  assert.ok(!JSON.stringify(rows()).includes('kunci-berurutan-1'), 'kunci mentah tidak tersimpan (hanya hash)');
});

test('duplikat bersamaan (dalam proses): 20 permintaan identik = satu efek, semua menerima hasil yang sama', async () => {
  let runs = 0;
  const body = { phone: '2', text: 'b' };
  const fn = async () => { runs++; await sleep(40); return { status: 200, body: { n: runs } }; };
  const rs = await Promise.all(Array.from({ length: 20 }, () => C.withIdempotency('app1', 'kunci-serentak-1', fn, opt(body))));
  assert.equal(runs, 1);
  assert.ok(rs.every((r) => r.status === 200 && r.body.n === 1));
  assert.equal(rs.filter((r) => !r.replay).length, 1);
});

test('kunci sama dengan isi berbeda: 422 tanpa efek dan tanpa memutar ulang respons lama', async () => {
  let runs = 0;
  const fn = async () => ({ status: 200, body: { n: ++runs } });
  await C.withIdempotency('app1', 'kunci-konflik-1', fn, opt({ text: 'asli' }));
  const r = await C.withIdempotency('app1', 'kunci-konflik-1', fn, opt({ text: 'diubah' }));
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(runs, 1);
  // juga saat permintaan pertama masih berjalan
  const slow = C.withIdempotency('app1', 'kunci-konflik-2', async () => { runs++; await sleep(40); return { status: 200, body: {} }; }, opt({ text: 'p' }));
  const conflict = await C.withIdempotency('app1', 'kunci-konflik-2', fn, opt({ text: 'q' }));
  assert.equal(conflict.status, 422);
  await slow;
  assert.equal(runs, 2);
});

test('permintaan pertama gagal: 5xx/429/503/exception melepas kunci; 4xx tetap disimpan', async () => {
  const body = { text: 'g' };
  let n = 0;
  const flaky = async () => (++n < 3 ? { status: 503, body: { error: 'x' } } : { status: 200, body: { ok: n } });
  const r1 = await C.withIdempotency('app1', 'kunci-gagal-001', flaky, opt(body));
  const r2 = await C.withIdempotency('app1', 'kunci-gagal-001', flaky, opt(body));
  assert.deepEqual([r1.status, r2.status], [503, 503]);
  assert.equal(rows().filter((r) => r.state === 'pending').length, 0, 'tidak ada reservasi menggantung');
  const r3 = await C.withIdempotency('app1', 'kunci-gagal-001', flaky, opt(body));
  assert.equal(r3.status, 200);
  assert.equal(r3.replay, false);
  // exception
  let t = 0;
  await assert.rejects(C.withIdempotency('app1', 'kunci-throw-001', async () => { t++; throw new Error('boom'); }, opt(body)), /boom/);
  const ok = await C.withIdempotency('app1', 'kunci-throw-001', async () => { t++; return { status: 200, body: {} }; }, opt(body));
  assert.equal(ok.replay, false);
  assert.equal(t, 2);
  // 422 dari validasi bersifat deterministik: disimpan dan diputar ulang
  let v = 0;
  const bad = async () => (++v, { status: 400, body: { error: 'validasi' } });
  await C.withIdempotency('app1', 'kunci-4xx-0001', bad, opt(body));
  const again = await C.withIdempotency('app1', 'kunci-4xx-0001', bad, opt(body));
  assert.equal(v, 1);
  assert.equal(again.replay, true);
});

test('kedaluwarsa: setelah 24 jam kunci bisa dipakai lagi dan baris lama dibuang', async () => {
  let runs = 0;
  const fn = async () => ({ status: 200, body: { n: ++runs } });
  const body = { text: 'e' };
  await C.withIdempotency('app1', 'kunci-kedaluwarsa-1', fn, opt(body));
  D.getDb().prepare('UPDATE idempotency_keys SET expires_at = ? WHERE app_id = ?').run(Date.now() - 1, 'app1');
  const r = await C.withIdempotency('app1', 'kunci-kedaluwarsa-1', fn, opt(body));
  assert.equal(r.replay, false);
  assert.equal(runs, 2);
  assert.equal(C.IDEM_TTL, 24 * 3600_000);
  // pembersihan berkala menghapus baris kedaluwarsa
  D.getDb().prepare("INSERT INTO idempotency_keys(k, app_id, endpoint, state, status, body, created_at, expires_at) VALUES('x','z','e','done',200,'{}',1,2)").run();
  C._resetCaches();
  await C.withIdempotency('app1', 'kunci-pemicu-purge', fn, opt(body));
  assert.equal(D.getDb().prepare("SELECT COUNT(*) c FROM idempotency_keys WHERE k='x'").get().c, 0);
});

test('server restart saat berjalan: baris pending bertahan, ulang dijawab 409 INTERRUPTED dan tidak mengulang efek', async () => {
  let runs = 0;
  const body = { text: 'r' };
  C.withIdempotency('app1', 'kunci-restart-001', async () => { runs++; await sleep(10_000); return { status: 200, body: {} }; }, opt(body)).catch(() => {});
  await sleep(20);
  assert.equal(rows().filter((r) => r.state === 'pending').length, 1, 'reservasi sudah di disk sebelum efek selesai');
  C._resetCaches(); // meniru proses baru: memori hilang, DB tetap
  const r = await C.withIdempotency('app1', 'kunci-restart-001', async () => { runs++; return { status: 200, body: {} }; }, opt(body));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'IDEMPOTENCY_INTERRUPTED');
  assert.equal(runs, 1);
  D.getDb().prepare("DELETE FROM idempotency_keys WHERE state='pending'").run();
});

test('isolasi: aplikasi berbeda dan endpoint berbeda tidak berbagi kunci; kunci ber-":" tidak bisa bertabrakan', async () => {
  let runs = 0;
  const fn = async () => ({ status: 200, body: { n: ++runs } });
  const body = { text: 'i' };
  const a = await C.withIdempotency('appA', 'kunci-isolasi-01', fn, opt(body, 'POST /api/v1/messages'));
  const b = await C.withIdempotency('appB', 'kunci-isolasi-01', fn, opt(body, 'POST /api/v1/messages'));
  const c = await C.withIdempotency('appA', 'kunci-isolasi-01', fn, opt(body, 'POST /api/v1/events'));
  assert.deepEqual([a.replay, b.replay, c.replay], [false, false, false]);
  assert.equal(runs, 3);
  const x = await C.withIdempotency('a:b', 'cdefghij', fn, opt(body));
  const y = await C.withIdempotency('a', 'b:cdefghij', fn, opt(body));
  assert.equal(y.replay, false);
  assert.equal(x.replay, false);
  assert.equal(new Set(rows().map((r) => r.k)).size, rows().length);
});

test('impor berkas JSON lama: entri selesai diputar ulang, berkas dipindah ke .migrated', async () => {
  const legacy = path.join(dir, 'connect-idem.json');
  fs.writeFileSync(legacy, JSON.stringify({ entries: {
    'appL:kunci-lama-0001': { ts: Date.now() - 1000, status: 200, body: { dari: 'lama' } },
    'appL:kunci-lama-0002': { ts: Date.now() - 1000, pending: true, status: 409, body: {} },
    'appL:kunci-lama-basi': { ts: Date.now() - 48 * 3600_000, status: 200, body: {} },
  } }));
  C._resetCaches();
  let runs = 0;
  const fn = async () => ({ status: 200, body: { n: ++runs } });
  const r = await C.withIdempotency('appL', 'kunci-lama-0001', fn, opt({ t: 1 }));
  assert.equal(r.replay, true);
  assert.deepEqual(r.body, { dari: 'lama' });
  assert.equal((await C.withIdempotency('appL', 'kunci-lama-0002', fn, opt({ t: 1 }))).status, 409);
  assert.equal((await C.withIdempotency('appL', 'kunci-lama-basi', fn, opt({ t: 1 }))).replay, false);
  assert.equal(runs, 1);
  assert.ok(fs.existsSync(legacy + '.migrated') && !fs.existsSync(legacy));
});

test('lintas proses: dua proses Node berebut kunci yang sama pada DB yang sama = tepat satu efek', async () => {
  const effect = path.join(dir, 'efek.txt');
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.resolve('test/helpers/idem-child.js')], { env: { ...process.env, DATA_DIR: dir, EFFECT_FILE: effect }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error('anak keluar ' + code))));
  });
  const res = await Promise.all([run(), run(), run()]);
  assert.equal(fs.readFileSync(effect, 'utf8').trim().split('\n').length, 1, 'efek hanya sekali');
  assert.equal(res.filter((r) => r.replay === false && r.status === 200).length, 1);
  assert.ok(res.every((r) => r.replay || r.status === 200));
});

// ---- lewat HTTP (server asli) ----
let srv, admin;
before(async () => {
  srv = await startServer({ env: { CONNECT_DRY_RUN: '1', CLIENT_ID: 'klinik-uji' } });
  admin = new Client(srv.base);
  assert.equal((await admin.login()).status, 302);
  await admin.get('/api/me');
});
after(async () => { await srv?.stop(); });

const mkKey = async (name) => (await admin.post('/api/integrations/keys', { name, app: 'booking', scopes: ['messages:send', 'events:write', 'leads:write'] })).json.token;
const post = (token, p, body, key, method = 'POST') => fetch(srv.base + p, {
  method,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key !== undefined ? { 'idempotency-key': key } : {}) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, replay: r.headers.get('idempotent-replay'), json: await r.json().catch(() => null) }));

test('HTTP: kunci kosong/tidak valid -> 400; POST messages dan events wajib berkunci; PUT kontak boleh tanpa kunci', async () => {
  const t = await mkKey('K1');
  const body = { phone: '081200001001', text: 'halo' };
  assert.equal((await post(t, '/api/v1/messages', body)).status, 400);
  assert.equal((await post(t, '/api/v1/messages', body, '')).status, 400);
  assert.equal((await post(t, '/api/v1/messages', body, 'pendek')).status, 400);
  assert.equal((await post(t, '/api/v1/messages', body, 'ada spasi di kunci')).status, 400);
  assert.equal((await post(t, '/api/v1/events', { type: 'x' })).status, 400);
  assert.equal((await post(t, '/api/v1/contacts/6281200001001', { name: 'Tanpa Kunci' }, undefined, 'PUT')).status, 201);
  assert.equal((await post(t, '/api/v1/messages', body, 'kunci-http-valid-1')).status, 200);
});

test('HTTP: duplikat berurutan dan bersamaan satu efek; isi berbeda 422; klien lain terisolasi', async () => {
  const t1 = await mkKey('K2');
  const t2 = await mkKey('K3');
  const body = { phone: '081200001002', text: 'Booking dikonfirmasi' };
  const rs = await Promise.all(Array.from({ length: 8 }, () => post(t1, '/api/v1/messages', body, 'kunci-http-serentak-1')));
  assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(new Set(rs.map((r) => r.json.waId)).size, 1, 'semua menerima respons yang sama');
  assert.equal(rs.filter((r) => r.replay !== 'true').length, 1, 'hanya satu yang benar-benar dieksekusi');
  const again = await post(t1, '/api/v1/messages', body, 'kunci-http-serentak-1');
  assert.equal(again.replay, 'true');
  const diff = await post(t1, '/api/v1/messages', { ...body, text: 'Isi lain' }, 'kunci-http-serentak-1');
  assert.equal(diff.status, 422);
  assert.equal(diff.json.code, 'IDEMPOTENCY_KEY_REUSED');
  const other = await post(t2, '/api/v1/messages', body, 'kunci-http-serentak-1'); // kunci API lain, kunci sama
  assert.equal(other.status, 200);
  assert.notEqual(other.replay, 'true');
  assert.notEqual(other.json.waId, rs[0].json.waId);
  const basic = new Client(srv.base, { mode: 'basic' });
  const conv = (await basic.get('/api/conversations/6281200001002')).json;
  assert.equal(conv.messages.filter((m) => m.by === 'bot').length, 2, 'satu pesan per klien, bukan per permintaan');
});