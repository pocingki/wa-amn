// Kotak "Pengajuan ke Acesio" di CRM: antrean, ajukan satu, ajukan semua. [MOCK] Acesio palsu (server HTTP lokal).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-queue-'));
process.env.KEYWORDS_FILE = path.join(process.env.DATA_DIR, 'keywords.test.json');
const baseCfg = JSON.parse(fs.readFileSync('config/keywords.json', 'utf8'));
fs.writeFileSync(process.env.KEYWORDS_FILE, JSON.stringify({ ...baseCfg, leadRule: 'all', timezone: 'Asia/Jakarta' }));
for (const k of ['ACESIO_URL', 'ACESIO_BOT_KEY', 'ACESIO_API_KEY', 'BOT_API_KEY']) delete process.env[k];

const link = await import('../src/acesio-link.js');
const store = await import('../src/store.js');
const { handle } = await import('../src/api/crm.js');

const KEY = 'acb_' + 'q'.repeat(32);
const seen = [];
let failPhone = ''; let replayPhone = '';
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    seen.push(body);
    const json = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (body.phone === failPhone) return json(500, { error: 'galat uji' });
    json(201, { id: seen.length, ...(body.phone === replayPhone ? { replayed: true } : {}) });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
test.after(() => fake.close());

async function call(method, urlPath, { user = { name: 'Rina', role: 'admin' } } = {}) {
  const out = { status: 0, json: null, audits: [] };
  const ctx = { sendJSON(r, c, b) { out.status = c; out.json = b; }, readBody: async () => ({}), user, ip: '127.0.0.1', audit: (a, d) => out.audits.push({ a, d }), requireRole: () => true };
  await handle({ method, headers: {}, url: urlPath }, {}, new URL(urlPath, 'http://x'), ctx);
  return out;
}
const lead = (o) => store.add({
  phone: '62811' + Math.floor(Math.random() * 1e7), name: 'Tes Satu', platform: 'Instagram', keyword: 'harga', status: 'Hot Leads', hotStage: 'Won', dataType: 'New',
  referensi: 'Instagram', createdAt: Date.now(), lastMessageAt: Date.now(), ...o,
});
const reset = () => { for (const l of [...store.all()]) store.remove(l.id); seen.length = 0; failPhone = ''; replayPhone = ''; };

test('antrean: hanya Hot+Won yang belum terkirim; menandai data kurang; belum dikonfigurasi', async () => {
  reset();
  lead({ phone: '628111000001', name: 'Ayu Siap' });
  lead({ phone: '628111000002', name: 'Budi Kurang', referensi: '' });
  lead({ phone: '628111000003', name: 'Cici Cold', status: 'Cold Leads', hotStage: null });
  lead({ phone: '628111000004', name: 'Dedi Terkirim', acesioStatus: 'sent' });
  lead({ phone: '628111000005', name: 'Eka Hot Belum Won', hotStage: 'Follow Up' });
  const q = (await call('GET', '/api/leads/acesio/queue')).json;
  assert.equal(q.configured, false);
  assert.deepEqual(q.items.map((i) => i.name), ['Ayu Siap', 'Budi Kurang']);
  assert.deepEqual(q.counts, { total: 2, ready: 1, incomplete: 1, failed: 0 });
  assert.deepEqual(q.items[1].missing, ['Referensi']);
  assert.equal((await call('POST', '/api/leads/acesio/queue')).status, 405);
  const all = await call('POST', '/api/leads/acesio/submit-all');
  assert.equal(all.status, 503);
  assert.equal(seen.length, 0);
});

test('ajukan semua: hanya yang lengkap; satu gagal tidak menghentikan yang lain; ringkasan dan status benar', async () => {
  link.setLink({ url: `http://127.0.0.1:${fake.address().port}`, key: KEY });
  reset();
  const a = lead({ phone: '628122000001', name: 'Ayu' });
  const b = lead({ phone: '628122000002', name: 'Budi' });
  const c = lead({ phone: '628122000003', name: 'Cici' });
  const d = lead({ phone: '628122000004', name: 'Dedi', referensi: '' });
  failPhone = b.phone; replayPhone = c.phone;
  const r = await call('POST', '/api/leads/acesio/submit-all');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.total, r.json.sent, r.json.replayed, r.json.failed, r.json.skippedIncomplete], [3, 1, 1, 1, 1]);
  assert.equal(r.json.ok, false);
  assert.equal(seen.length, 3, 'lead tidak lengkap tidak dikirim');
  assert.equal(seen.some((x) => x.phone === d.phone), false);
  const st = (l) => store.all().find((x) => x.id === l.id);
  assert.equal(st(a).acesioStatus, 'sent');
  assert.equal(st(b).acesioStatus, 'failed');
  assert.equal(st(c).acesioStatus, 'sent');
  assert.equal(st(d).acesioStatus ?? null, null);
  assert.equal(r.json.results.find((x) => x.id === b.id).ok, false);
  assert.equal(r.json.queue.counts.failed, 1);
  assert.equal(r.json.queue.items.some((i) => i.id === a.id), false, 'yang terkirim keluar dari antrean');
  assert.ok(r.audits.some((x) => x.a === 'lead.send_to_acesio_all'));
});

test('ajukan satu: memakai rute lama; Coba lagi setelah gagal berhasil; kirim ulang semua tidak menggandakan', async () => {
  reset();
  const b = lead({ phone: '628133000002', name: 'Budi' });
  failPhone = b.phone;
  assert.equal((await call('POST', `/api/leads/${b.id}/send-to-acesio`)).status, 502);
  assert.equal((await call('GET', '/api/leads/acesio/queue')).json.items[0].acesioStatus, 'failed');
  failPhone = '';
  const ok = await call('POST', `/api/leads/${b.id}/send-to-acesio`);
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/leads/acesio/queue')).json.items.length, 0);
  seen.length = 0;
  const again = await call('POST', '/api/leads/acesio/submit-all');
  assert.equal(again.json.total, 0);
  assert.equal(seen.length, 0);
});
