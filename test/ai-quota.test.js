// Kuota AI (B3): DB SQLite sementara (nyata, bukan mock DB), waktu diinjeksi. Tidak ada jaringan.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-aiquota-'));
process.env.DATA_DIR = dir;
process.env.AMNAN_NO_BG = '1';
process.env.AMNAN_NO_BACKUP = '1';
const D = await import('../src/db.js');
const Q = await import('../src/ai-quota.js');
// Windows tidak bisa menghapus berkas SQLite yang masih terbuka (EPERM); folder sementara boleh tersisa.
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* dibiarkan */ } });

const MIN = 60_000;
const T0 = Date.parse('2026-11-10T05:00:00Z'); // 12:00 WIB
let clock = T0;
let S;
const mk = () => Q.createQuota({ getDb: D.getDb, now: () => clock, getSettings: () => S });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  clock = T0;
  S = { timezone: 'Asia/Jakarta', ai: { monthlyQuota: 1000, perCustomerDailyLimit: 20 } };
  const q = mk();
  q.usage(); // memastikan tabel ada
  D.getDb().exec('DELETE FROM ai_usage');
});

test('reserve idempoten per key: dua kali = satu slot, tetap ok setelah commit', () => {
  const q = mk();
  assert.deepEqual(q.reserve({ key: 'k1', customerKey: 'c1' }), { ok: true });
  assert.deepEqual(q.reserve({ key: 'k1', customerKey: 'c1' }), { ok: true });
  assert.equal(q.usage().month.reserved, 1);
  q.commit('k1', { inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(q.reserve({ key: 'k1', customerKey: 'c1' }), { ok: true });
  const u = q.usage();
  assert.deepEqual([u.month.used, u.month.reserved], [1, 0]);
});

test('batas bulanan: slot ke-(limit+1) ditolak dengan reason monthly; reserved ikut dihitung', () => {
  S.ai.monthlyQuota = 3;
  const q = mk();
  assert.equal(q.reserve({ key: 'a', customerKey: 'c1' }).ok, true);
  assert.equal(q.reserve({ key: 'b', customerKey: 'c2' }).ok, true);
  q.commit('a', {});
  assert.equal(q.reserve({ key: 'c', customerKey: 'c3' }).ok, true);
  assert.deepEqual(q.reserve({ key: 'd', customerKey: 'c4' }), { ok: false, reason: 'monthly' });
  // key yang sudah punya slot tetap ok (idempoten) walau batas penuh
  assert.deepEqual(q.reserve({ key: 'b', customerKey: 'c2' }), { ok: true });
  const u = q.usage();
  assert.deepEqual([u.month.used, u.month.reserved, u.month.limit, u.month.remaining], [1, 2, 3, 0]);
});

test('batas harian per customer: customer lain tidak terpengaruh; ganti hari me-reset', () => {
  S.ai.perCustomerDailyLimit = 2;
  const q = mk();
  assert.equal(q.reserve({ key: 'a1', customerKey: 'A' }).ok, true);
  assert.equal(q.reserve({ key: 'a2', customerKey: 'A' }).ok, true);
  assert.deepEqual(q.reserve({ key: 'a3', customerKey: 'A' }), { ok: false, reason: 'customer_daily' });
  assert.equal(q.reserve({ key: 'b1', customerKey: 'B' }).ok, true);
  clock += 24 * 60 * MIN; // hari berikutnya
  assert.equal(q.reserve({ key: 'a3', customerKey: 'A' }).ok, true);
});

test('commit/refund: refund melepas slot, commit idempoten, refund setelah commit dan commit setelah refund tidak berefek', () => {
  S.ai.monthlyQuota = 2;
  const q = mk();
  q.reserve({ key: 'x', customerKey: 'c' });
  q.reserve({ key: 'y', customerKey: 'c' });
  assert.equal(q.reserve({ key: 'z', customerKey: 'c' }).ok, false);

  q.refund('x');
  assert.equal(q.usage().month.reserved, 1);
  q.commit('x', { inputTokens: 99, outputTokens: 99 }); // sudah dilepas: abaikan
  assert.deepEqual([q.usage().month.used, q.usage().tokens], [0, { input: 0, output: 0 }]);
  assert.equal(q.reserve({ key: 'z', customerKey: 'c' }).ok, true);

  q.commit('y', { inputTokens: 100, outputTokens: 20 });
  q.commit('y', { inputTokens: 1, outputTokens: 1 }); // idempoten: token pertama dipertahankan
  q.refund('y'); // setelah commit: tidak berefek
  q.refund('tak-dikenal');
  q.commit('tak-dikenal', {});
  const u = q.usage();
  assert.deepEqual([u.month.used, u.month.reserved, u.today.used], [1, 1, 1]);
  assert.deepEqual(u.tokens, { input: 100, output: 20 });

  // kunci yang pernah dilepas boleh dipakai lagi (percobaan ulang)
  q.refund('z');
  assert.equal(q.reserve({ key: 'z', customerKey: 'c' }).ok, true);
  assert.equal(q.usage().month.reserved, 1);
});

test('token null/tak valid disimpan sebagai kosong dan dihitung 0', () => {
  const q = mk();
  q.reserve({ key: 't', customerKey: 'c' });
  q.commit('t', { inputTokens: null, outputTokens: NaN });
  assert.deepEqual(q.usage().tokens, { input: 0, output: 0 });
  assert.equal(q.usage().month.used, 1);
});

test('50 reserve paralel (customer berbeda) lolos tepat sebesar batas bulanan', async () => {
  S.ai.monthlyQuota = 20;
  const q = mk();
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => q.reserve({ key: `p${i}`, customerKey: `c${i}` }))));
  assert.equal(rs.filter((r) => r.ok).length, 20);
  assert.ok(rs.filter((r) => !r.ok).every((r) => r.reason === 'monthly'));
  assert.equal(q.usage().month.reserved, 20);
});

test('50 reserve paralel (satu customer) lolos tepat sebesar batas harian', async () => {
  S.ai.perCustomerDailyLimit = 7;
  const q = mk();
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => q.reserve({ key: `s${i}`, customerKey: 'sama' }))));
  assert.equal(rs.filter((r) => r.ok).length, 7);
  assert.ok(rs.filter((r) => !r.ok).every((r) => r.reason === 'customer_daily'));
});

test('lintas proses: 4 proses x 25 reserve ke DB yang sama lolos tepat sebesar batas (BEGIN IMMEDIATE)', async () => {
  S.ai.monthlyQuota = 60;
  const src = pathToFileURL(path.resolve(import.meta.dirname, '../src/ai-quota.js')).href;
  const dbSrc = pathToFileURL(path.resolve(import.meta.dirname, '../src/db.js')).href;
  const code = `
    const D = await import(${JSON.stringify(dbSrc)});
    const Q = await import(${JSON.stringify(src)});
    const q = Q.createQuota({ getDb: D.getDb, now: () => ${T0}, getSettings: () => ({ timezone: 'Asia/Jakarta', ai: { monthlyQuota: 60, perCustomerDailyLimit: 1000 } }) });
    let ok = 0;
    for (let i = 0; i < 25; i++) if (q.reserve({ key: process.argv[1] + '-' + i, customerKey: 'c' + i }).ok) ok++;
    process.stdout.write(JSON.stringify({ ok }));
  `;
  const run = (id) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', code, id], { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error(`anak keluar ${c}: ${err}`))));
  });
  const rs = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(run));
  assert.equal(rs.reduce((a, r) => a + r.ok, 0), 60);
  assert.equal(mk().usage().month.reserved, 60);
});

test('pergantian bulan/hari mengikuti zona waktu (waktu injeksi)', () => {
  const q = mk();
  clock = Date.parse('2026-11-30T16:59:00Z'); // 23:59 WIB, 30 Nov
  q.reserve({ key: 'n1', customerKey: 'c' });
  q.commit('n1', {});
  let u = q.usage();
  assert.deepEqual([u.month.from, u.month.to, u.month.used, u.today.used], ['2026-11-01', '2026-11-30', 1, 1]);
  assert.equal(u.daily.at(-1).date, '2026-11-30');

  clock = Date.parse('2026-11-30T17:01:00Z'); // 00:01 WIB, 1 Des
  u = q.usage();
  assert.deepEqual([u.month.from, u.month.to, u.month.used, u.month.remaining, u.today.used], ['2026-12-01', '2026-12-31', 0, 1000, 0]);
  assert.equal(u.daily.at(-1).date, '2026-12-01');
  assert.equal(u.daily.at(-2).used, 1); // pemakaian kemarin tercatat di 30 Nov

  S.timezone = 'America/New_York'; // pada waktu yang sama masih 30 Nov 12:01 di sana
  u = q.usage();
  assert.deepEqual([u.month.from, u.today.used], ['2026-11-01', 0 + 1]);
  assert.equal(u.daily.at(-1).date, '2026-11-30');

  S.timezone = 'Zona/Tidak-Ada'; // tak valid: kembali ke Asia/Jakarta, tidak melempar
  assert.equal(q.usage().month.from, '2026-12-01');
  delete S.timezone;
  assert.equal(q.usage().month.from, '2026-12-01');
});

test('batas bulanan dihitung per bulan: bulan baru mulai dari nol', () => {
  S.ai.monthlyQuota = 1;
  const q = mk();
  assert.equal(q.reserve({ key: 'm1', customerKey: 'c1' }).ok, true);
  assert.equal(q.reserve({ key: 'm2', customerKey: 'c2' }).reason, 'monthly');
  clock = Date.parse('2026-12-01T05:00:00Z');
  assert.equal(q.reserve({ key: 'm2', customerKey: 'c2' }).ok, true);
});

test('usage(): 30 hari berurutan terisi nol, hari di luar jendela tidak ikut, token bulan ini dijumlahkan', () => {
  const q = mk();
  const put = (dayOffset, key, tin, tout) => {
    clock = T0 + dayOffset * 24 * 60 * MIN;
    q.reserve({ key, customerKey: 'c' + key });
    q.commit(key, { inputTokens: tin, outputTokens: tout });
  };
  put(-9, 'd1', 10, 1);   // 1 Nov
  put(-9, 'd2', 20, 2);
  put(-5, 'd3', 30, 3);   // 5 Nov
  put(0, 'd4', 40, 4);    // 10 Nov
  put(0, 'd5', 50, 5);
  put(0, 'd6', 60, 6);
  clock = T0;
  q.reserve({ key: 'pending', customerKey: 'cp' }); // reserved: tidak masuk daily/used
  const u = q.usage();
  assert.equal(u.daily.length, 30);
  assert.equal(u.daily.at(-1).date, '2026-11-10');
  assert.equal(u.daily[0].date, '2026-10-12');
  for (let i = 1; i < 30; i++) assert.ok(u.daily[i - 1].date < u.daily[i].date, 'urut naik');
  const byDate = Object.fromEntries(u.daily.map((d) => [d.date, d.used]));
  assert.deepEqual([byDate['2026-11-01'], byDate['2026-11-05'], byDate['2026-11-10'], byDate['2026-11-02']], [2, 1, 3, 0]);
  assert.equal(u.today.used, 3);
  assert.deepEqual([u.month.used, u.month.reserved], [6, 1]);
  assert.deepEqual(u.tokens, { input: 210, output: 21 });

  // pemakaian 31 hari lalu tidak muncul di daily
  clock = T0 + 40 * 24 * 60 * MIN; // 20 Des
  const far = q.usage();
  assert.equal(far.daily.reduce((a, d) => a + d.used, 0), 0);
});

test('customerKey dan key tidak tersimpan polos: tidak ada nomor di DB, hash hex', () => {
  const q = mk();
  const phone = '6281234567890';
  q.reserve({ key: phone, customerKey: phone });
  q.commit(phone, { inputTokens: 1, outputTokens: 1 });
  const db = D.getDb();
  const dump = JSON.stringify([db.prepare('SELECT * FROM ai_usage').all(), db.prepare('SELECT * FROM ai_quota_meta').all()]);
  assert.ok(!dump.includes(phone), 'nomor lengkap tidak boleh ada');
  assert.ok(!dump.includes('81234567890'), 'potongan nomor tidak boleh ada');
  const row = db.prepare('SELECT * FROM ai_usage').get();
  assert.match(row.key, /^[0-9a-f]{64}$/);
  assert.match(row.customer_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.key, row.customer_hash); // domain hash dipisah
  // hash stabil: reserve ulang dengan key sama tetap satu baris
  q.reserve({ key: phone, customerKey: phone });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ai_usage').get().c, 1);
});

test('reserved basi (>10 menit) dibebaskan saat reserve() dan usage(); commit sesudahnya tidak berefek', () => {
  S.ai.monthlyQuota = 1;
  const q = mk();
  assert.equal(q.reserve({ key: 'lama', customerKey: 'c' }).ok, true);
  clock += 10 * MIN; // tepat 10 menit: belum basi
  assert.equal(q.reserve({ key: 'baru', customerKey: 'c2' }).ok, false);
  assert.equal(q.usage().month.reserved, 1);

  clock += 1; // lewat 10 menit
  assert.equal(q.usage().month.reserved, 0);
  assert.equal(q.usage().month.remaining, 1);
  q.commit('lama', { inputTokens: 5, outputTokens: 5 }); // sudah dilepas
  assert.equal(q.usage().month.used, 0);
  assert.equal(q.reserve({ key: 'baru', customerKey: 'c2' }).ok, true);
  assert.equal(q.usage().month.reserved, 1);
});

test('reserved basi dibebaskan oleh reserve() sendiri (tanpa usage() lebih dulu)', () => {
  S.ai.monthlyQuota = 1;
  const q = mk();
  q.reserve({ key: 'mati', customerKey: 'c' });
  clock += 11 * MIN;
  assert.equal(q.reserve({ key: 'hidup', customerKey: 'c2' }).ok, true);
  assert.deepEqual([q.usage().month.reserved, q.usage().month.used], [1, 0]);
});

test('pengaturan kosong/rusak memakai bawaan 1000/20; batas 0 berarti tidak ada slot; kunci wajib', () => {
  S = {};
  let q = mk();
  let u = q.usage();
  assert.deepEqual([u.month.limit], [1000]);
  for (let i = 0; i < 20; i++) assert.equal(q.reserve({ key: `b${i}`, customerKey: 'c' }).ok, true);
  assert.equal(q.reserve({ key: 'b20', customerKey: 'c' }).reason, 'customer_daily');

  S = { ai: { monthlyQuota: 'abc', perCustomerDailyLimit: -5 } };
  q = mk();
  u = q.usage();
  assert.equal(u.month.limit, 1000);

  S = { ai: { monthlyQuota: 0, perCustomerDailyLimit: 20 } };
  q = mk();
  assert.equal(q.reserve({ key: 'nol', customerKey: 'c9' }).reason, 'monthly');

  assert.throws(() => q.reserve({ key: '', customerKey: 'c' }), TypeError);
  assert.throws(() => q.reserve({ key: 'k', customerKey: '' }), TypeError);
  assert.throws(() => q.reserve(), TypeError);
});

test('getSettings melempar: memakai bawaan, tidak ikut melempar', async () => {
  const q = Q.createQuota({ getDb: D.getDb, now: () => clock, getSettings: () => { throw new Error('rusak'); } });
  assert.equal(q.reserve({ key: 'e1', customerKey: 'c' }).ok, true);
  await sleep(0);
  assert.equal(q.usage().month.limit, 1000);
});
