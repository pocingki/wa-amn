// Uji S6 (MOCK, tanpa jaringan/Convia nyata): pilihan koneksi WhatsApp waProvider, publicView Convia, restartRequired.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-set-convia-'));
// nilai env PALSU: tes memastikan tidak satu pun bocor ke respons
const SECRETS = { CONVIA_API_KEY: 'KEY-RAHASIA-123', CONVIA_WEBHOOK_SECRET: 'SECRET-WEBHOOK-456', CONVIA_SIGNING_SECRET: 'SIGNING-789' };
const ENV_KEYS = ['CONVIA_API_KEY', 'CONVIA_WEBHOOK_SECRET', 'CONVIA_SIGNING_SECRET', 'WA_PROVIDER', 'PUBLIC_URL'];
for (const k of ENV_KEYS) delete process.env[k];

const s = await import('../src/settings.js');
const { handle } = await import('../src/api/settings.js');
const pengaturan = await import('../public/assets/js/pages/pengaturan.js');

async function call(method, p, { role = 'admin', body, headers = {} } = {}) {
  const out = { code: 0, body: null };
  const ctx = {
    user: { name: 'u-' + role, role },
    sendJSON: (_r, code, b) => { out.code = code; out.body = b; },
    readBody: async () => body,
    audit: () => {},
    requireRole: (r) => { if (role === r) return true; out.code = 403; return false; },
  };
  out.handled = await handle({ method, headers }, {}, new URL(p, 'http://x'), ctx);
  return out;
}

// 1. default 'baileys'; publicView: convia belum dikonfigurasi, tanpa nilai env
{
  assert.equal(s.DEFAULTS.waProvider, 'baileys');
  assert.equal(s.get().waProvider, 'baileys');
  const v = s.publicView(s.get());
  assert.equal(v.waProvider, 'baileys');
  assert.deepEqual(v.convia, { configured: false, webhookPath: '/webhooks/convia', publicUrl: '', envOverride: '' });
}

// 2. nilai tidak valid ditolak (VALIDATION) dan tidak mengubah apa pun; riwayat tidak bertambah
{
  const v0 = s.get().version;
  for (const bad of ['whatsapp', '', 'BAILEYS', null, 1, true, ['convia'], { a: 1 }]) {
    assert.throws(() => s.update({ waProvider: bad }), (e) => e.code === 'VALIDATION', JSON.stringify(bad));
  }
  assert.equal(s.get().version, v0);
  assert.equal(s.get().waProvider, 'baileys');
  const r = await call('PUT', '/api/settings', { body: { waProvider: 'telegram' } });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /tidak valid/);
  assert.equal(s.get().waProvider, 'baileys');
}

// 3. agent tidak boleh mengubah (403); GET oleh agent tetap memuat waProvider + convia (tanpa notify)
{
  const v0 = s.get().version;
  const r = await call('PUT', '/api/settings', { role: 'agent', body: { waProvider: 'convia' } });
  assert.equal(r.code, 403);
  assert.equal(s.get().waProvider, 'baileys');
  assert.equal(s.get().version, v0);
  const g = await call('GET', '/api/settings', { role: 'agent' });
  assert.equal(g.code, 200);
  assert.equal(g.body.waProvider, 'baileys');
  assert.equal(typeof g.body.convia.configured, 'boolean');
  assert.equal('notify' in g.body, false);
}

// 4. restartRequired: true hanya bila nilai berubah
{
  let r = await call('PUT', '/api/settings', { body: { waProvider: 'convia' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.waProvider, 'convia');
  assert.equal(r.body.restartRequired, true);
  assert.equal(s.get().waProvider, 'convia');
  r = await call('PUT', '/api/settings', { body: { waProvider: 'convia' } }); // sama
  assert.equal(r.code, 200);
  assert.notEqual(r.body.restartRequired, true);
  r = await call('PUT', '/api/settings', { body: { brandName: 'Lain' } }); // kunci lain
  assert.notEqual(r.body.restartRequired, true);
  r = await call('PUT', '/api/settings', { body: { waProvider: 'baileys' } }); // kembali
  assert.equal(r.body.restartRequired, true);
  const g = await call('GET', '/api/settings'); // GET tidak membawa restartRequired
  assert.equal('restartRequired' in g.body, false);
}

// 5. publicView tidak membocorkan nilai env; hanya boolean (key + salah satu secret)
{
  const leak = (v) => { const t = JSON.stringify(v); for (const x of Object.values(SECRETS)) assert.ok(!t.includes(x), 'bocor: ' + x); };
  Object.assign(process.env, { CONVIA_API_KEY: SECRETS.CONVIA_API_KEY });
  assert.equal(s.publicView(s.get()).convia.configured, false); // key saja belum cukup
  delete process.env.CONVIA_API_KEY;
  process.env.CONVIA_WEBHOOK_SECRET = SECRETS.CONVIA_WEBHOOK_SECRET;
  assert.equal(s.publicView(s.get()).convia.configured, false); // secret saja belum cukup
  process.env.CONVIA_API_KEY = SECRETS.CONVIA_API_KEY;
  let v = s.publicView(s.get());
  assert.equal(v.convia.configured, true);
  leak(v);
  delete process.env.CONVIA_WEBHOOK_SECRET; // alias
  process.env.CONVIA_SIGNING_SECRET = SECRETS.CONVIA_SIGNING_SECRET;
  v = s.publicView(s.get());
  assert.equal(v.convia.configured, true);
  leak(v);
  process.env.CONVIA_API_KEY = '   '; // spasi saja = kosong
  assert.equal(s.publicView(s.get()).convia.configured, false);
  process.env.CONVIA_API_KEY = SECRETS.CONVIA_API_KEY;
  leak(await call('GET', '/api/settings').then((r) => r.body));
  leak(await call('GET', '/api/settings', { role: 'agent' }).then((r) => r.body));
  leak(await call('PUT', '/api/settings', { body: { waProvider: 'convia' } }).then((r) => r.body));
  leak(await call('PUT', '/api/settings', { body: { waProvider: 'nope' } }).then((r) => r.body));
  for (const k of ENV_KEYS) delete process.env[k];
}

// 6. PUBLIC_URL (alamat publik, bukan rahasia) dan WA_PROVIDER (override) tampil; nilai aneh diabaikan
{
  process.env.PUBLIC_URL = 'https://crm.contoh.id//';
  process.env.WA_PROVIDER = ' Convia ';
  let c = s.publicView(s.get()).convia;
  assert.equal(c.publicUrl, 'https://crm.contoh.id');
  assert.equal(c.envOverride, 'convia');
  process.env.PUBLIC_URL = 'javascript:alert(1)';
  process.env.WA_PROVIDER = 'lainnya';
  c = s.publicView(s.get()).convia;
  assert.equal(c.publicUrl, '');
  assert.equal(c.envOverride, '');
  for (const k of ENV_KEYS) delete process.env[k];
}

// 7. riwayat versi tetap bekerja: snapshot lama tanpa waProvider tidak merusak; restore ke versi dengan convia -> restartRequired
{
  await call('PUT', '/api/settings', { body: { waProvider: 'convia' } });
  const vConvia = s.get().version;
  await call('PUT', '/api/settings', { body: { waProvider: 'baileys' } });
  // simulasikan snapshot lama (sebelum fitur ini): hapus waProvider dari riwayat
  const hp = path.join(process.env.DATA_DIR, 'settings.history.json');
  const hist = JSON.parse(fs.readFileSync(hp, 'utf8'));
  const old = hist.find((h) => h.version !== vConvia);
  delete old.settings.waProvider;
  fs.writeFileSync(hp, JSON.stringify(hist));
  let r = await call('POST', '/api/settings/restore', { body: { version: old.version } });
  assert.equal(r.code, 200);
  assert.ok(['baileys', 'convia'].includes(r.body.waProvider)); // tetap valid, tidak hilang
  await call('PUT', '/api/settings', { body: { waProvider: 'baileys' } });
  r = await call('POST', '/api/settings/restore', { body: { version: vConvia } }); // snapshot yang berisi convia
  assert.equal(r.code, 200);
  assert.equal(r.body.waProvider, 'convia');
  assert.equal(r.body.restartRequired, true);
  assert.ok(s.history().length >= 1);
}

// 8. berkas settings.json lama/rusak: waProvider tidak valid -> kembali ke bawaan saat dimuat
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-set-convia-b-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 3, waProvider: 'ngawur' }));
  const { spawnSync } = await import('node:child_process');
  const code = "const s = await import('./src/settings.js'); console.log(JSON.stringify([s.get().waProvider, s.get().version]));";
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim()), ['baileys', 3]);
}

// 9. frontend (fungsi murni): pilihan koneksi + alamat webhook
{
  assert.deepEqual(pengaturan.buildWaProviderPatch('convia', { waProvider: 'baileys' }), { patch: { waProvider: 'convia' }, changed: true, errors: [] });
  assert.equal(pengaturan.buildWaProviderPatch('baileys', {}).changed, false); // bawaan = baileys
  assert.equal(pengaturan.buildWaProviderPatch('baileys', { waProvider: 'baileys' }).changed, false);
  const bad = pengaturan.buildWaProviderPatch('x', {});
  assert.equal(bad.patch, null);
  assert.equal(bad.errors[0].field, 'waProvider');
  assert.deepEqual(pengaturan.webhookAddress({ webhookPath: '/webhooks/convia', publicUrl: 'https://a.id' }), { url: 'https://a.id/webhooks/convia', complete: true });
  assert.deepEqual(pengaturan.webhookAddress({ webhookPath: '/webhooks/convia', publicUrl: '' }), { url: '/webhooks/convia', complete: false });
  assert.deepEqual(pengaturan.webhookAddress(undefined), { url: '/webhooks/convia', complete: false });
}

console.log('settings-convia.test.js OK (MOCK)');
