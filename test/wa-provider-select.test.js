// Uji S5 (MOCK): pemilih provider WhatsApp, api/wa, dan rute POST /webhooks/convia.
// Semua provider Convia di sini PALSU; tidak ada panggilan ke Convia nyata dan tidak ada koneksi WhatsApp nyata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-s5-'));
const { createWhatsAppFacade, resolveProviderMode, conviaConfigFromEnv } = await import('../src/whatsapp.js');
const { makeHandle } = await import('../src/api/wa.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL = { CONVIA_API_KEY: 'KUNCI-RAHASIA-1', CONVIA_WEBHOOK_SECRET: 'SECRET-RAHASIA-2' };

// Provider Convia palsu: mencatat konfigurasi dan pemanggilan.
function fakeProvider() {
  const calls = { created: [], start: 0, stop: 0, logout: 0, sendText: [], webhook: [] };
  const create = (cfg) => {
    calls.created.push(cfg);
    return {
      wa: { status: 'connected', number: '62811' },
      start: async () => { calls.start++; },
      stop: async () => { calls.stop++; },
      logout: async () => { calls.logout++; return { message: 'Tidak ada QR di mode Convia.' }; },
      sendText: async (j, t) => { calls.sendText.push([j, t]); return { messageId: 'm1' }; },
      getAdapter: () => 'ADAPTER',
      handleWebhook: async (raw, headers) => { calls.webhook.push([raw, headers]); return { status: 200, body: { ok: true } }; },
    };
  };
  return { create, calls };
}
const noBaileys = () => { throw new Error('createWa (Baileys) tidak boleh dipanggil'); };
const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

// ---------------------------------------------------------------- pemilih mode

test('mode: default baileys; setting dipakai; env menang atas setting; nilai aneh -> invalid', () => {
  assert.equal(resolveProviderMode({ env: {}, getSettings: () => ({}) }).mode, 'baileys');
  assert.equal(resolveProviderMode({ env: {}, getSettings: () => ({ waProvider: 'convia' }) }).mode, 'convia');
  assert.equal(resolveProviderMode({ env: { WA_PROVIDER: 'baileys' }, getSettings: () => ({ waProvider: 'convia' }) }).mode, 'baileys');
  assert.equal(resolveProviderMode({ env: { WA_PROVIDER: ' CONVIA ' }, getSettings: () => ({ waProvider: 'baileys' }) }).mode, 'convia');
  assert.equal(resolveProviderMode({ env: { WA_PROVIDER: '' }, getSettings: () => ({ waProvider: 'convia' }) }).mode, 'convia'); // env kosong = tidak diisi
  assert.equal(resolveProviderMode({ env: {}, getSettings: () => { throw new Error('x'); } }).mode, 'baileys'); // settings rusak -> default
  const bad = resolveProviderMode({ env: { WA_PROVIDER: 'rahasia-aneh' }, getSettings: () => ({}) });
  assert.equal(bad.mode, 'invalid');
  assert.ok(!bad.error.includes('rahasia-aneh'), 'nilai env tidak boleh dicetak');
});

test('env convia: secret boleh salah satu dari dua nama; yang hilang hanya disebut namanya', () => {
  assert.equal(conviaConfigFromEnv({ CONVIA_API_KEY: 'k', CONVIA_WEBHOOK_SECRET: 's' }).config.webhookSecret, 's');
  assert.equal(conviaConfigFromEnv({ CONVIA_API_KEY: 'k', CONVIA_SIGNING_SECRET: 'alias' }).config.webhookSecret, 'alias');
  assert.equal(conviaConfigFromEnv({ CONVIA_API_KEY: 'k', CONVIA_WEBHOOK_SECRET: 's', CONVIA_SIGNING_SECRET: 'alias' }).config.webhookSecret, 's');
  const miss = conviaConfigFromEnv({ CONVIA_API_KEY: '   ' });
  assert.equal(miss.ok, false);
  assert.equal(miss.missing.length, 2);
  const opt = conviaConfigFromEnv({ ...FULL, CONVIA_PHONE_NUMBER_ID: '123', CONVIA_BASE_URL: 'https://x.test/v1' }).config;
  assert.equal(opt.phoneNumberId, '123');
  assert.equal(opt.baseUrl, 'https://x.test/v1');
  assert.ok(!('baseUrl' in conviaConfigFromEnv(FULL).config), 'baseUrl kosong tidak dikirim (default milik provider)');
});

// ---------------------------------------------------------------- fasad

test('fasad default (baileys): perilaku lama; provider convia tidak disentuh; webhook 404', async () => {
  const fp = fakeProvider();
  const baileys = { wa: { status: 'disconnected' }, start: () => 'S', stop: () => 'T', logout: () => 'L', sendText: () => 'X', handleMessage: () => 'H', getAdapter: () => 'A' };
  const f = createWhatsAppFacade({ env: {}, getSettings: () => ({}), createWa: () => baileys, createConviaProvider: fp.create });
  assert.equal(f.mode, 'baileys');
  assert.equal(f.provider, null);
  assert.equal(f.start(), 'S');
  assert.equal(f.handleMessage(), 'H');
  assert.equal(f.wa.status, 'disconnected');
  assert.equal(fp.calls.created.length, 0);
  assert.equal((await f.handleWebhook(Buffer.from('{}'), {})).status, 404);
});

test('fasad convia: provider dibuat dari env (alias secret), semua panggilan diteruskan', async () => {
  const fp = fakeProvider();
  const env = { WA_PROVIDER: 'convia', CONVIA_API_KEY: 'k1', CONVIA_SIGNING_SECRET: 's1', CONVIA_PHONE_NUMBER_ID: 'p1', CONVIA_BASE_URL: 'https://x.test' };
  const f = createWhatsAppFacade({ env, getSettings: () => ({}), createWa: noBaileys, createConviaProvider: fp.create });
  assert.equal(f.mode, 'convia');
  assert.deepEqual(fp.calls.created, [{ apiKey: 'k1', webhookSecret: 's1', phoneNumberId: 'p1', baseUrl: 'https://x.test' }]);
  assert.equal(f.provider.wa, f.wa);
  await f.start(); await f.stop();
  assert.equal(await f.sendText('62811@s.whatsapp.net', 'hai').then((r) => r.messageId), 'm1');
  assert.equal(f.getAdapter(), 'ADAPTER');
  assert.equal((await f.logout()).message, 'Tidak ada QR di mode Convia.');
  const raw = Buffer.from([0xff, 0xfe, 0x7b]);
  const hdr = { 'x-convia-signature': 'abc' };
  assert.deepEqual(await f.handleWebhook(raw, hdr), { status: 200, body: { ok: true } });
  assert.equal(fp.calls.webhook[0][0], raw); // objek yang sama: tidak disalin/diubah
  assert.equal(fp.calls.webhook[0][1], hdr);
  assert.deepEqual([fp.calls.start, fp.calls.stop, fp.calls.logout], [1, 1, 1]);
});

test('fasad convia dari settings.waProvider (env WA_PROVIDER kosong)', () => {
  const fp = fakeProvider();
  const f = createWhatsAppFacade({ env: FULL, getSettings: () => ({ waProvider: 'convia' }), createWa: noBaileys, createConviaProvider: fp.create });
  assert.equal(f.mode, 'convia');
});

test('env convia hilang -> misconfigured, tegas, tidak jatuh ke Baileys, tanpa membocorkan nilai', async () => {
  for (const env of [
    { WA_PROVIDER: 'convia' },
    { WA_PROVIDER: 'convia', CONVIA_API_KEY: FULL.CONVIA_API_KEY }, // secret hilang
    { WA_PROVIDER: 'convia', CONVIA_WEBHOOK_SECRET: FULL.CONVIA_WEBHOOK_SECRET }, // API key hilang
  ]) {
    const fp = fakeProvider();
    const f = createWhatsAppFacade({ env, getSettings: () => ({}), createWa: noBaileys, createConviaProvider: fp.create });
    assert.equal(f.mode, 'convia');
    assert.equal(f.wa.status, 'misconfigured');
    assert.equal(f.wa.qr, null);
    assert.match(f.wa.error, /CONVIA_/);
    assert.ok(!f.wa.error.includes('RAHASIA'), 'pesan tidak boleh memuat nilai env');
    assert.equal(fp.calls.created.length, 0);
    await quiet(async () => {
      await f.start(); // tidak melempar
      await f.stop();
      assert.ok((await f.logout()).message);
      await assert.rejects(() => f.sendText('1@s.whatsapp.net', 'x'), /Convia/);
    });
    assert.equal(f.getAdapter(), null);
    assert.equal((await f.handleWebhook(Buffer.from('{}'), {})).status, 503);
  }
});

test('modul provider gagal dimuat / provider gagal dibuat / nilai mode aneh -> misconfigured', async () => {
  const fp = fakeProvider();
  const miss = createWhatsAppFacade({ env: { WA_PROVIDER: 'convia', ...FULL }, getSettings: () => ({}), createWa: noBaileys, createConviaProvider: null, conviaLoadError: new Error('x') });
  assert.equal(miss.wa.status, 'misconfigured');
  const boom = await quiet(() => createWhatsAppFacade({
    env: { WA_PROVIDER: 'convia', ...FULL }, getSettings: () => ({}), createWa: noBaileys,
    createConviaProvider: () => { throw new Error(`gagal dengan ${FULL.CONVIA_API_KEY}`); },
  }));
  assert.equal(boom.wa.status, 'misconfigured');
  assert.ok(!boom.wa.error.includes('RAHASIA'));
  const odd = createWhatsAppFacade({ env: { WA_PROVIDER: 'foo', ...FULL }, getSettings: () => ({}), createWa: noBaileys, createConviaProvider: fp.create });
  assert.equal(odd.wa.status, 'misconfigured');
  assert.equal(odd.mode, 'invalid');
  assert.equal(fp.calls.created.length, 0);
});

test('tidak ada rahasia di log (console) saat memilih, memulai, dan gagal', async () => {
  const lines = [];
  const orig = { e: console.error, l: console.log, w: console.warn };
  console.error = console.log = console.warn = (...a) => lines.push(a.map(String).join(' '));
  try {
    const fp = fakeProvider();
    const ok = createWhatsAppFacade({ env: { WA_PROVIDER: 'convia', ...FULL }, getSettings: () => ({}), createWa: noBaileys, createConviaProvider: fp.create });
    await ok.start();
    const bad = createWhatsAppFacade({ env: { WA_PROVIDER: 'convia', CONVIA_API_KEY: FULL.CONVIA_API_KEY }, getSettings: () => ({}), createWa: noBaileys, createConviaProvider: fp.create });
    await bad.start();
    createWhatsAppFacade({ env: { WA_PROVIDER: 'convia', ...FULL }, getSettings: () => ({}), createWa: noBaileys, createConviaProvider: () => { throw new Error(FULL.CONVIA_API_KEY); } });
  } finally {
    Object.assign(console, { error: orig.e, log: orig.l, warn: orig.w });
  }
  assert.ok(lines.length > 0);
  assert.ok(!lines.join('\n').match(/RAHASIA/), 'log memuat nilai rahasia');
});

// ---------------------------------------------------------------- api/wa

function callApi(handle, method, p, role) {
  let out = null;
  const audits = [];
  const ctx = {
    sendJSON: (_r, code, body) => (out = { code, body }),
    user: { role },
    audit: (a) => audits.push(a),
    requireRole: (r) => { if (role === r) return true; out = { code: 403 }; return false; },
  };
  return handle({ method }, {}, new URL('http://x' + p), ctx).then((handled) => ({ handled, out, audits }));
}

test('api/wa: mode convia menampilkan mode, tanpa QR (admin pun), logout tidak melempar dan memberi pesan', async () => {
  const wa = { status: 'connected', number: '62811' }; // objek wa provider: tanpa qr/error/since
  const handle = makeHandle({ wa, logout: async () => ({ message: 'Tidak ada QR di mode Convia.' }), unread: () => 2, mode: 'convia' });
  let r = await callApi(handle, 'GET', '/api/wa/status', 'admin');
  assert.equal(r.out.body.mode, 'convia');
  assert.equal(r.out.body.status, 'connected');
  assert.equal(r.out.body.qr, null);
  assert.equal(r.out.body.error, null);
  assert.equal(r.out.body.reconnectAttempts, 0);
  assert.equal(r.out.body.unread, 2);
  r = await callApi(handle, 'POST', '/api/wa/logout', 'agent');
  assert.equal(r.out.code, 403);
  r = await callApi(handle, 'POST', '/api/wa/logout', 'admin');
  assert.equal(r.out.code, 200);
  assert.equal(r.out.body.loggedOut, false);
  assert.equal(r.out.body.message, 'Tidak ada QR di mode Convia.');
  assert.deepEqual(r.audits, ['wa.logout']);
});

test('api/wa: status misconfigured tampil apa adanya dengan pesan galat', async () => {
  const wa = { status: 'misconfigured', qr: null, number: null, error: 'Mode Convia butuh env: CONVIA_API_KEY', since: 1, reconnectAttempts: 0 };
  const handle = makeHandle({ wa, logout: async () => ({ message: 'm' }), unread: () => 0, mode: () => 'convia' });
  const r = await callApi(handle, 'GET', '/api/wa/status', 'admin');
  assert.equal(r.out.body.status, 'misconfigured');
  assert.match(r.out.body.error, /CONVIA_API_KEY/);
});

test('api/wa: mode baileys tidak berubah (QR hanya admin, logout {ok:true})', async () => {
  const wa = { status: 'qr', qr: 'data:qr', number: null, error: null, since: 5, reconnectAttempts: 2 };
  const handle = makeHandle({ wa, logout: async () => {}, unread: () => 3 }); // mode bawaan baileys
  let r = await callApi(handle, 'GET', '/api/wa/status', 'admin');
  assert.equal(r.out.body.qr, 'data:qr');
  assert.equal(r.out.body.mode, 'baileys');
  r = await callApi(handle, 'GET', '/api/wa/status', 'agent');
  assert.equal(r.out.body.qr, null);
  r = await callApi(handle, 'POST', '/api/wa/logout', 'admin');
  assert.deepEqual(r.out.body, { ok: true });
});

// ---------------------------------------------------------------- rute server (server.js asli, provider PALSU)
// Salinan kerja sementara (server.js + src) dengan src/wa-convia-provider.js palsu, supaya tes tidak bergantung
// pada modul S4 dan tidak ada jaringan nyata. Provider palsu hanya melaporkan apa yang diterimanya.

const FAKE_PROVIDER = `
import crypto from 'node:crypto';
export function createConviaProvider(cfg) {
  return {
    wa: { status: 'connected', number: '62811' },
    async start() {}, async stop() {}, async logout() { return { message: 'x' }; }, async sendText() {}, getAdapter: () => null,
    async handleWebhook(raw, headers) {
      if (headers['x-paksa-status']) return { status: Number(headers['x-paksa-status']), body: { error: 'paksa' } };
      if (headers['x-paksa-lempar']) throw new Error('RAHASIA-DI-GALAT');
      return { status: 200, body: {
        isBuffer: Buffer.isBuffer(raw), len: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex'),
        sigMixed: headers['X-Convia-Signature'] ?? null, sigLower: headers['x-convia-signature'] ?? null,
        secretOk: cfg.webhookSecret === 'secret-alias-uji',
      } };
    },
  };
}
`;

function copyApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-s5app-'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'config'), path.join(dir, 'config'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(dir, 'src', 'wa-convia-provider.js'), FAKE_PROVIDER);
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startApp(dir, env) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-s5data-'));
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith('CONVIA_') || k === 'WA_PROVIDER') delete clean[k];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...clean, APP_DIR: dir, ENV_FILE: path.join(dir, 'tidak-ada.env'), PORT: String(port), DATA_DIR: dataDir, DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD: 'sandi-uji-12345', BOT_NO_DELAY: '1', TZ: 'Asia/Jakarta', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  let exited = null;
  child.on('exit', (c) => (exited = c ?? 'signal'));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (exited !== null) throw new Error(`server berhenti (${exited}):\n${log.slice(-1500)}`);
    try { if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) })).status === 200) break; } catch { /* belum siap */ }
    if (Date.now() - t0 > 20000) { child.kill('SIGKILL'); throw new Error(`server tidak siap:\n${log.slice(-1500)}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    base, logs: () => log,
    async stop() {
      if (exited === null) {
        child.kill('SIGTERM');
        await new Promise((r) => { const t = setTimeout(() => (child.kill('SIGKILL'), r()), 8000); child.once('exit', () => (clearTimeout(t), r())); });
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('server: rute webhook HANYA di mode convia; byte asli sampai; tanpa sesi/CSRF; tanpa log rahasia (MOCK provider)', async () => {
  const dir = copyApp();
  let off; let on;
  try {
    // Mode non-convia (WA dimatikan): rute tidak ada -> 404 walau tanpa login (bukan 401).
    off = await startApp(dir, { DISABLE_WA: '1' });
    let r = await fetch(off.base + '/webhooks/convia', { method: 'POST', body: '{}' });
    assert.equal(r.status, 404);
    await off.stop(); off = null;

    // Mode convia dengan provider palsu (secret lewat nama alias).
    on = await startApp(dir, { WA_PROVIDER: 'convia', CONVIA_API_KEY: 'API-KEY-RAHASIA', CONVIA_SIGNING_SECRET: 'secret-alias-uji' });
    const body = Buffer.concat([Buffer.from('{"pesan":"PESAN-RAHASIA"}'), Buffer.from([0xff, 0xfe, 0x00, 0x80])]); // byte bukan UTF-8 valid
    r = await fetch(on.base + '/webhooks/convia', { method: 'POST', headers: { 'X-Convia-Signature': 'SIG-RAHASIA', 'Content-Type': 'application/json' }, body }); // tanpa cookie/CSRF
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.isBuffer, true);
    assert.equal(j.len, body.length);
    assert.equal(j.sha256, crypto.createHash('sha256').update(body).digest('hex'), 'byte harus sama persis');
    assert.equal(j.sigMixed, 'SIG-RAHASIA');
    assert.equal(j.sigLower, 'SIG-RAHASIA');
    assert.equal(j.secretOk, true);

    // Status dari handler diteruskan apa adanya (mis. 401 tanda tangan salah).
    r = await fetch(on.base + '/webhooks/convia', { method: 'POST', headers: { 'x-paksa-status': '401' }, body: '{}' });
    assert.equal(r.status, 401);
    // Handler melempar -> 500 generik, tanpa pesan galat.
    r = await fetch(on.base + '/webhooks/convia', { method: 'POST', headers: { 'x-paksa-lempar': '1' }, body: '{}' });
    assert.equal(r.status, 500);
    assert.ok(!(await r.text()).includes('RAHASIA'));
    // Metode lain -> 405; body > 1 MB -> 413.
    r = await fetch(on.base + '/webhooks/convia');
    assert.equal(r.status, 405);
    r = await fetch(on.base + '/webhooks/convia', { method: 'POST', body: Buffer.alloc(1024 * 1024 + 10, 0x61) });
    assert.equal(r.status, 413);
    // Rute lain tetap butuh login.
    assert.equal((await fetch(on.base + '/api/wa/status')).status, 401);

    const logs = on.logs();
    for (const s of ['PESAN-RAHASIA', 'SIG-RAHASIA', 'API-KEY-RAHASIA', 'secret-alias-uji', 'RAHASIA-DI-GALAT']) assert.ok(!logs.includes(s), `log memuat ${s}`);
  } finally {
    await off?.stop();
    await on?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server: mode convia dengan env kurang -> rute ada tapi 503, status misconfigured di /healthz (MOCK)', async () => {
  const dir = copyApp();
  let srv;
  try {
    srv = await startApp(dir, { WA_PROVIDER: 'convia', CONVIA_API_KEY: 'API-KEY-RAHASIA' }); // secret hilang
    const r = await fetch(srv.base + '/webhooks/convia', { method: 'POST', body: '{}' });
    assert.equal(r.status, 503);
    const h = await (await fetch(srv.base + '/healthz')).json();
    assert.equal(h.wa.status, 'misconfigured');
    assert.ok(!srv.logs().includes('API-KEY-RAHASIA'));
  } finally {
    await srv?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
