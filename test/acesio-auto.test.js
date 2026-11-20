// Ajukan otomatis saat Won, retry, sinkron keputusan Acesio, edit booking. [MOCK] Acesio palsu (server HTTP lokal).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-auto-'));
process.env.KEYWORDS_FILE = path.join(process.env.DATA_DIR, 'keywords.test.json');
const baseCfg = JSON.parse(fs.readFileSync('config/keywords.json', 'utf8'));
fs.writeFileSync(process.env.KEYWORDS_FILE, JSON.stringify({ ...baseCfg, leadRule: 'all', timezone: 'Asia/Jakarta' }));
for (const k of ['ACESIO_URL', 'ACESIO_BOT_KEY', 'ACESIO_API_KEY', 'BOT_API_KEY']) delete process.env[k];

const link = await import('../src/acesio-link.js');
const store = await import('../src/store.js');
const settings = await import('../src/settings.js');
const { handle, autoSubmitLead } = await import('../src/api/crm.js');
const { createSync } = await import('../src/acesio-sync.js');
const { fetchStatuses, fetchSlots, fetchServices } = await import('../src/acesio-booking.js');

const KEY = 'acb_' + 'a'.repeat(32);
const posted = []; let mode = 'ok'; let decision = { status: 'pending' };
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const json = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/api/bot/incoming-leads/status')) {
      const ids = new URL(req.url, 'http://x').searchParams.get('ids').split(',');
      return json(200, { leads: ids.map((id) => ({ wa_lead_id: id, ...decision })) });
    }
    if (req.url.startsWith('/api/bot/services')) return json(200, { services: [{ id: 1, name: 'Fisioterapi' }] });
    if (req.url.startsWith('/api/bot/slots')) return json(200, { supported: true, step_minutes: 60, slots: [{ time: '10:00', free: 1, available: true }] });
    if (mode === 'fail') return json(500, { error: 'galat uji' });
    posted.push(JSON.parse(raw)); json(201, { id: posted.length });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
test.after(() => fake.close());
link.setLink({ url: `http://127.0.0.1:${fake.address().port}`, key: KEY });

const lead = (o) => store.add({
  phone: '628133' + Math.floor(Math.random() * 1e6), name: 'Tes', platform: 'Instagram', keyword: 'k', status: 'Hot Leads', hotStage: 'Follow Up', dataType: 'New',
  referensi: 'Instagram', createdAt: Date.now(), lastMessageAt: Date.now(), data: { booking_day: '2099-01-02', booking_time: '10:00', booking_services: 'Fisioterapi' }, ...o,
});
async function call(method, urlPath, body = {}) {
  const out = { status: 0, json: null };
  const ctx = { sendJSON(r, c, b) { out.status = c; out.json = b; }, readBody: async () => body, user: { name: 'Rina', role: 'admin' }, ip: '1', audit() {}, requireRole: () => true };
  await handle({ method, headers: {}, url: urlPath }, {}, new URL(urlPath, 'http://x'), ctx);
  return out;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Won -> otomatis diajukan beserta data booking; kegagalan -> perlu perhatian + ditandai auto', async () => {
  settings.update({ crmAgent: { enabled: true, autoSubmit: true } });
  const l = lead({});
  const r = await call('PATCH', `/api/leads/${l.id}`, { hotStage: 'Won' });
  assert.equal(r.status, 200);
  await wait(200);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].data.booking_day, '2099-01-02');
  assert.equal(store.all().find((x) => x.id === l.id).acesioStatus, 'sent');

  mode = 'fail';
  const l2 = lead({ hotStage: 'Follow Up' });
  await call('PATCH', `/api/leads/${l2.id}`, { hotStage: 'Won' });
  await wait(200);
  const cur = store.all().find((x) => x.id === l2.id);
  assert.equal(cur.acesioStatus, 'failed'); assert.equal(cur.acesioAuto, true);
  mode = 'ok';
});

test('autoSubmit mati atau data belum lengkap: tidak mengirim', async () => {
  posted.length = 0;
  settings.update({ crmAgent: { enabled: true, autoSubmit: false } });
  const l = lead({ hotStage: 'Won' });
  assert.equal(await autoSubmitLead(l.id), null);
  settings.update({ crmAgent: { enabled: true, autoSubmit: true } });
  const bad = lead({ hotStage: 'Won', referensi: '' });
  const r = await autoSubmitLead(bad.id);
  assert.equal(r.status, 400); assert.equal(posted.length, 0);
});

test('edit booking oleh admin: valid disimpan, lampau/format salah ditolak', async () => {
  const l = lead({});
  let r = await call('PATCH', `/api/leads/${l.id}`, { booking: { day: '2099-03-04', time: '14.30', services: 'Fisioterapi, Pijat' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.lead.data.booking_day, '2099-03-04'); assert.equal(r.json.lead.data.booking_time, '14:30');
  r = await call('PATCH', `/api/leads/${l.id}`, { booking: { day: '2000-01-01' } });
  assert.equal(r.status, 400);
  r = await call('PATCH', `/api/leads/${l.id}`, { booking: { time: '99:99' } });
  assert.equal(r.status, 400);
});

test('sinkron: ditolak -> lead + perhatian; diterima -> jadwal tersimpan; ajukan ulang hanya yang auto & gagal', async () => {
  const flags = [];
  const a = lead({ hotStage: 'Won', acesioStatus: 'sent' });
  const b = lead({ hotStage: 'Won', acesioStatus: 'sent' });
  const dead = lead({ hotStage: 'Won', acesioStatus: 'failed', acesioAuto: true, acesioLastAttemptAt: 0 });
  const legacy = lead({ hotStage: 'Won', acesioStatus: 'failed' }); // bukan auto: tidak boleh dikirim ulang diam-diam
  const submitted = [];
  const sync = createSync({
    leads: () => store.all(), submit: async (id) => submitted.push(id), update: (id, p) => store.update(id, p), flag: (l, why) => flags.push([l.id, why]),
    statuses: async (ids) => Object.fromEntries(ids.map((id) => [id, id === a.id ? { status: 'rejected', rejection_reason: 'Jadwal penuh' } : id === b.id ? { status: 'accepted', schedule: { day: '2099-01-02', start_time: '10:00', worker: 'Sari' } } : { status: 'pending' }])),
  });
  await sync.tick();
  assert.ok(submitted.includes(dead.id));
  const A = store.all().find((x) => x.id === a.id), B = store.all().find((x) => x.id === b.id);
  assert.equal(A.acesioDecision, 'rejected'); assert.equal(A.acesioRejectReason, 'Jadwal penuh');
  assert.match(flags[0][1], /ditolak Acesio: Jadwal penuh/);
  assert.equal(B.acesioDecision, 'accepted'); assert.equal(B.acesioSchedule.worker, 'Sari');
  assert.ok(!submitted.includes(legacy.id));
});

test('klien Acesio: layanan, slot, status lewat HTTP', async () => {
  assert.deepEqual(await fetchServices(), ['Fisioterapi']);
  assert.equal((await fetchSlots('2099-01-02')).slots[0].available, true);
  assert.equal(await fetchSlots('bukan-tanggal'), null);
  const s = await fetchStatuses(['x1']);
  assert.equal(s.x1.status, 'pending');
});

test('keputusan admin atas bukti bayar: Sudah masuk -> Won + terajukan ke Acesio; Belum masuk -> customer diberi tahu, bot kembali', async () => {
  const C = await import('../src/conversations.js');
  const botApi = await import('../src/api/bot.js');
  settings.update({ crmAgent: { enabled: true, autoSubmit: true } });
  const callDp = async (phone, action, sent) => {
    const out = { status: 0, json: null };
    const ctx = { sendJSON(r, c, b) { out.status = c; out.json = b; }, readBody: async () => ({ action }), user: { name: 'Rina', role: 'admin' }, audit() {}, requireRole: () => true, sendText: async (j, t) => (sent.push(t), { waId: 'w' }) };
    await botApi.handle({ method: 'POST', headers: {} }, {}, new URL(`/api/conversations/${phone}/dp`, 'http://x'), ctx);
    return out;
  };
  posted.length = 0;
  const l = lead({ hotStage: 'Follow Up' });
  const c = C.getOrCreate(l.phone, l.phone + '@s.whatsapp.net', 'Tes').conv;
  const sent = [];
  assert.equal((await callDp(l.phone, 'paid', sent)).status, 409, 'tanpa bukti bayar ditolak');
  c.mode = 'admin'; c.form = { stage: 'done', dpState: 'proof' }; c.needsAttention = true; c.attentionReason = 'Bukti';
  let r = await callDp(l.phone, 'not_received', sent);
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1); assert.match(sent[0], /belum kami terima/);
  assert.equal(c.mode, 'bot'); assert.equal(c.form.dpState, 'awaiting'); assert.equal(c.needsAttention, false);
  assert.equal(posted.length, 0, 'belum masuk: tidak diajukan');
  c.mode = 'admin'; c.form.dpState = 'proof';
  r = await callDp(l.phone, 'paid', sent);
  assert.equal(r.status, 200); assert.equal(r.json.acesio, 'sent');
  assert.equal(store.all().find((x) => x.id === l.id).hotStage, 'Won');
  assert.equal(posted.length, 1, 'data booking terkirim ke Acesio');
  assert.equal(c.form.dpState, 'paid');
  assert.equal((await callDp(l.phone, 'paid', sent)).status, 409, 'tidak bisa diputuskan dua kali');
});
