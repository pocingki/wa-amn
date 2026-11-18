// Alamat + kunci Acesio diisi dari dashboard: /api/acesio dan pemakaiannya oleh send-to-acesio. [MOCK] Acesio palsu.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-link-'));
process.env.KEYWORDS_FILE = path.join(process.env.DATA_DIR, 'keywords.test.json');
const baseCfg = JSON.parse(fs.readFileSync('config/keywords.json', 'utf8'));
fs.writeFileSync(process.env.KEYWORDS_FILE, JSON.stringify({ ...baseCfg, leadRule: 'all', timezone: 'Asia/Jakarta' }));
for (const k of ['ACESIO_URL', 'ACESIO_BOT_KEY', 'ACESIO_API_KEY', 'BOT_API_KEY']) delete process.env[k];

const link = await import('../src/acesio-link.js');
const { handle } = await import('../src/api/acesio.js');
const store = await import('../src/store.js');
const crm = await import('../src/api/crm.js');

const KEY = 'acb_' + 'k'.repeat(32);
const seen = [];
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    seen.push({ path: req.url, key: req.headers['x-api-key'], body: raw ? JSON.parse(raw) : null });
    if (req.headers['x-api-key'] !== KEY) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"API key salah"}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 7, services: [] }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${fake.address().port}`;
test.after(() => fake.close());

async function call(handler, method, urlPath, { body, user = { name: 'Rina', role: 'admin' } } = {}) {
  const out = { status: 0, json: null, text: '' };
  const res = {};
  const ctx = {
    sendJSON(r, code, b) { out.status = code; out.text = JSON.stringify(b); out.json = b; },
    readBody: async () => body, user, ip: '127.0.0.1', audit: () => {},
    requireRole(role) { if (user.role === role) return true; ctx.sendJSON(res, 403, { error: 'Akses ditolak' }); return false; },
  };
  await handler(new (class { constructor() { this.method = method; this.headers = {}; this.url = urlPath; } })(), res, new URL(urlPath, 'http://x'), ctx);
  return out;
}
const api = (m, p, o) => call(handle, m, p, o);

test('awal: belum ada kunci; hanya admin yang boleh', async () => {
  const r = await api('GET', '/api/acesio');
  assert.deepEqual(r.json, { url: 'http://127.0.0.1:3000', hasKey: false, keySource: 'none' });
  assert.equal((await api('GET', '/api/acesio', { user: { name: 'B', role: 'agent' } })).status, 403);
  assert.equal((await api('POST', '/api/acesio/test')).json.ok, false);
});

test('simpan alamat + kunci: kunci tidak pernah dikembalikan; validasi alamat dan kunci', async () => {
  assert.equal((await api('PUT', '/api/acesio', { body: { url: 'ftp://x' } })).status, 400);
  assert.equal((await api('PUT', '/api/acesio', { body: { url: BASE, key: 'ada spasi' } })).status, 400);
  const r = await api('PUT', '/api/acesio', { body: { url: BASE + '/', key: KEY } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { url: BASE, hasKey: true, keySource: 'dashboard' });
  assert.equal(r.text.includes(KEY), false);
  assert.equal((await api('GET', '/api/acesio')).text.includes(KEY), false);
  const keep = await api('PUT', '/api/acesio', { body: { url: BASE, key: '' } }); // kosong = kunci tetap
  assert.equal(keep.json.hasKey, true);
});

test('tes sambungan memakai alamat/kunci tersimpan; kunci salah ditolak dengan pesan jelas', async () => {
  seen.length = 0;
  const ok = await api('POST', '/api/acesio/test');
  assert.equal(ok.json.ok, true, ok.text);
  assert.equal(seen[0].key, KEY);
  await api('PUT', '/api/acesio', { body: { key: 'acb_salah' + 'x'.repeat(20) } });
  const bad = await api('POST', '/api/acesio/test');
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.message, /ditolak/);
  await api('PUT', '/api/acesio', { body: { key: KEY } });
});

test('send-to-acesio memakai alamat dan kunci dari dashboard (tanpa env)', async () => {
  for (const l of [...store.all()]) store.remove(l.id);
  const lead = store.add({
    phone: '628111222333', name: 'Rina', platform: 'Instagram', keyword: 'harga', status: 'Hot Leads', hotStage: 'Won', dataType: 'New',
    referensi: 'Instagram', createdAt: Date.now(), lastMessageAt: Date.now(),
  });
  seen.length = 0;
  const r = await call(crm.handle, 'POST', `/api/leads/${lead.id}/send-to-acesio`, { body: {} });
  assert.equal(r.status, 200, r.text);
  const hit = seen.find((x) => x.path === '/api/bot/incoming-leads');
  assert.ok(hit, 'Acesio palsu dipanggil di alamat dari dashboard');
  assert.equal(hit.key, KEY);
  assert.equal(hit.body.wa_lead_id, lead.id);
});

test('hapus kunci: kembali ke belum dikonfigurasi', async () => {
  const r = await api('DELETE', '/api/acesio');
  assert.equal(r.json.hasKey, false);
  assert.equal(link.getLink().key, '');
  const lead = store.all().find((l) => l.hotStage === 'Won');
  const send = await call(crm.handle, 'POST', `/api/leads/${lead.id}/send-to-acesio`, { body: {} });
  assert.equal(send.status, 503);
  assert.match(send.json.error, /Pengaturan/);
});
