// E2E Convia (MOCK): server Convia PALSU lokal + server WA-AMN sungguhan (server.js) dengan WA_PROVIDER=convia.
// Semua skenario di sini MOCK: payload/respons dibuat sendiri berdasarkan kontrak sesi, BUKAN dari Convia nyata.
// Lulusnya tes ini TIDAK membuktikan kecocokan dengan Convia sungguhan (lihat docs/E2E-CONVIA.md, uji REAL = BLOCKED).
//
// ASUMSI yang dipakai server palsu (tidak ada di dokumen Convia): bentuk respons {data:{message_id,status,timestamp}},
// bentuk galat {error:{code}}, kode galat 'WINDOW_CLOSED'/'RATE_LIMIT_EXCEEDED'/'UNAUTHORIZED', header Retry-After detik.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { startServer, Client } from './helpers/server.js';

const API_KEY = 'kunci-api-mock-e2e';
const SECRET = 'secret-webhook-mock-e2e';
const MSG_TEXT = 'Halo kak dari Instagram, mau tanya harga paket';
const BSUID = 'US.13491208655302741918';

// ---------------------------------------------------------------- server Convia palsu
function makeFakeConvia() {
  const state = { mode: 'ok', requests: [], seq: 0 };
  const sockets = new Set();
  let server = null;
  let port = 0;

  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body });
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith('/health')) return send(200, { ok: true });
      const isSend = req.method === 'POST' && req.url.endsWith('/messages/send');
      if (!isSend) return send(200, { data: {} }); // typing / read
      switch (state.mode) {
        case 'timeout': return; // sengaja tidak menjawab: klien harus timeout
        case 'destroy': return req.socket.destroy();
        case '401': return send(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
        case '429': return send(429, { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'x' } }, { 'Retry-After': '1' });
        case 'window_closed': return send(400, { error: { code: 'WINDOW_CLOSED', message: 'x' } });
        default: {
          const id = `out_${++state.seq}`;
          return send(200, { data: { message_id: id, status: 'sent', timestamp: new Date().toISOString() } });
        }
      }
    });
  };

  return {
    state,
    get baseUrl() { return `http://127.0.0.1:${port}/api/v1/public`; },
    sends: (phone) => state.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/messages/send') && (!phone || r.body?.phone_number === phone)),
    reset() { state.mode = 'ok'; },
    async listen(p = 0) {
      server = http.createServer(handler);
      server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      await new Promise((r) => server.listen(p, '127.0.0.1', r));
      port = server.address().port;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

// Server Acesio palsu: hanya menghitung permintaan (BSUID harus ditolak sebelum menyentuh jaringan).
function makeFakeAcesio() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}'); });
  return {
    hits,
    async listen() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; },
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------- pembuat webhook
const sign = (raw, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
let seqId = 0;
const uid = () => `${Date.now().toString(36)}${++seqId}`;

// Format A: {event,timestamp,data}, header X-Webhook-Signature
function formatA({ phone, text = MSG_TEXT, channel = 'whatsapp', messageId = `a_${uid()}`, event = 'message.received' }) {
  const raw = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    data: { message_id: messageId, channel, message_type: 'text', content: text, customer_phone: phone, customer_name: 'Pelanggan Uji' },
  });
  return { raw, header: 'x-webhook-signature', messageId };
}

// Format B: {id,eventType,channel,occurredAt,payload}, header X-Convia-Signature
function formatB({ phone, text = MSG_TEXT, channel = 'whatsapp', messageId = `b_${uid()}`, eventId = `evt_${uid()}` }) {
  const raw = JSON.stringify({
    id: eventId,
    eventType: 'message.received',
    channel,
    occurredAt: new Date().toISOString(),
    payload: { messageId, from: phone, type: 'text', text: { body: text }, timestamp: Math.floor(Date.now() / 1000) },
  });
  return { raw, header: 'x-convia-signature', messageId, eventId };
}

let srv;
let fake;
let acesio;
let c;
let acesioUrl;
let phoneSeq = 0;
const newPhone = () => `62812345${String(10000 + ++phoneSeq).slice(-5)}`;

async function post(wh, { signature = sign(wh.raw), header = wh.header, extraHeaders = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (signature !== null) headers[header] = signature;
  const res = await fetch(srv.base + '/webhooks/convia', { method: 'POST', headers, body: wh.raw, signal: AbortSignal.timeout(90000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  return { status: res.status, json, text };
}

const leads = async () => (await c.get('/api/leads')).json.leads;
const leadOf = async (phone) => (await leads()).find((l) => l.phone === phone);
const convs = async () => (await c.get('/api/conversations')).json.conversations;

async function waitFor(fn, { timeoutMs = 15000, stepMs = 100, label = 'kondisi' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor gagal: ${label}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

before(async () => {
  fake = makeFakeConvia();
  await fake.listen();
  acesio = makeFakeAcesio();
  acesioUrl = await acesio.listen();
  srv = await startServer({
    env: {
      DISABLE_WA: '',
      WA_PROVIDER: 'convia',
      CONVIA_API_KEY: API_KEY,
      CONVIA_WEBHOOK_SECRET: SECRET,
      CONVIA_BASE_URL: fake.baseUrl,
      ACESIO_URL: acesioUrl,
      ACESIO_BOT_KEY: 'kunci-acesio-mock',
    },
  });
  c = new Client(srv.base, { mode: 'basic' });
  // Tunggu provider melapor 'connected' (health ke server palsu) sebelum webhook pertama.
  await waitFor(async () => (await c.get('/api/wa/status')).json?.status === 'connected', { label: 'wa.status connected' });
});

after(async () => {
  await srv?.stop();
  await fake?.close();
  await acesio?.close();
});

// ---------------------------------------------------------------- skenario
test('[MOCK] status: mode convia, connected, tanpa QR', async () => {
  const s = (await c.get('/api/wa/status')).json;
  assert.equal(s.mode, 'convia');
  assert.equal(s.status, 'connected');
  assert.equal(s.qr, null);
  assert.ok(fake.state.requests.some((r) => r.url.endsWith('/health') && r.auth === `Bearer ${API_KEY}`), 'health memakai Bearer');
});

for (const [name, make] of [['A (X-Webhook-Signature)', formatA], ['B (X-Convia-Signature, eventType/payload)', formatB]]) {
  test(`[MOCK] format ${name}: tanda tangan benar -> lead masuk CRM, bot membalas lewat API palsu dengan Bearer`, async () => {
    const phone = newPhone();
    const wh = make({ phone });
    const r = await post(wh); // tanpa sesi/CSRF
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.result, 'processed');

    const lead = await leadOf(phone);
    assert.ok(lead, 'lead harus ada di CRM');
    assert.equal(lead.status, 'Cold Leads');
    assert.equal(lead.platform, 'Instagram'); // dari kata "Instagram" di teks, lewat pipeline yang sama

    const sends = fake.sends(phone);
    assert.ok(sends.length >= 1, 'bot harus membalas lewat API palsu');
    for (const s of sends) {
      assert.equal(s.auth, `Bearer ${API_KEY}`);
      assert.equal(s.body.channel, 'whatsapp');
      assert.equal(s.body.message_type, 'text');
      assert.ok(String(s.body.content).length > 0);
    }
    assert.match(sends[0].body.content, /selamat datang/i, 'balasan pertama = pesan pembuka');

    const conv = (await c.get(`/api/conversations/${phone}`)).json;
    assert.ok(JSON.stringify(conv).includes('mau tanya harga'), 'pesan pelanggan tersimpan di percakapan');
  });
}

test('[MOCK] tanda tangan salah / hilang / header format lain -> 401 dan tidak ada data', async () => {
  const before = (await leads()).length;
  const convBefore = (await convs()).length;
  const sendsBefore = fake.sends().length;
  const phone = newPhone();
  const a = formatA({ phone });
  const b = formatB({ phone });
  assert.equal((await post(a, { signature: sign(a.raw, 'secret-lain') })).status, 401);
  assert.equal((await post(b, { signature: sign(b.raw, 'secret-lain') })).status, 401);
  assert.equal((await post(a, { signature: null })).status, 401);
  assert.equal((await post(b, { signature: '' })).status, 401);
  assert.equal((await post(a, { signature: 'bukan-hex' })).status, 401);
  assert.equal((await post(a, { header: 'x-convia-signature' })).status, 401, 'tanda tangan A di header milik B ditolak');
  assert.equal((await post(b, { header: 'x-webhook-signature' })).status, 401, 'tanda tangan B di header milik A ditolak');
  const tampered = { ...a, raw: a.raw.replace('mau tanya', 'mau beli ') };
  assert.equal((await post(tampered, { signature: sign(a.raw) })).status, 401, 'body diubah setelah ditandatangani');
  assert.equal((await leads()).length, before, 'tidak ada lead baru');
  assert.equal((await convs()).length, convBefore, 'tidak ada percakapan baru');
  assert.equal(await leadOf(phone), undefined);
  assert.equal(fake.sends().length, sendsBefore, 'tidak ada balasan terkirim');
});

test('[MOCK] payload rusak -> 400; event tak dikenal -> 200 dilewati', async () => {
  const sigFor = (raw, header = 'x-webhook-signature') => ({ raw, header });
  // Format terdeteksi (kunci event) tetapi data hilang, tanda tangan benar -> 400.
  const noData = sigFor(JSON.stringify({ event: 'message.received', timestamp: new Date().toISOString() }));
  assert.equal((await post(noData)).status, 400);
  const noDataB = sigFor(JSON.stringify({ id: 'evt_x', eventType: 'message.received' }), 'x-convia-signature');
  const rB = await post(noDataB);
  assert.equal(rB.status, 200); // format B tanpa payload: dilewati (skip 'payload kosong')
  assert.ok(rB.json.skipped);
  // Body bukan JSON / bentuk tak dikenal: format tak terdeteksi sehingga tanda tangan tidak bisa diverifikasi -> 401 (kebijakan S8/S4, dicatat sebagai temuan).
  assert.equal((await post(sigFor('{rusak'))).status, 401);
  assert.equal((await post(sigFor(JSON.stringify({ foo: 'bar' })))).status, 401);
  // Event yang tidak ditangani -> 200 + skipped
  const unknown = sigFor(JSON.stringify({ event: 'contact.created', timestamp: new Date().toISOString(), data: { x: 1 } }));
  const r = await post(unknown);
  assert.equal(r.status, 200);
  assert.ok(r.json.skipped);
});

test('[MOCK] pesan duplikat (message_id sama) -> satu balasan (format A)', async () => {
  const phone = newPhone();
  const wh = formatA({ phone });
  const r1 = await post(wh);
  assert.equal(r1.json.result, 'processed');
  const n = fake.sends(phone).length;
  assert.ok(n >= 1);
  const r2 = await post(wh);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.result, 'duplicate');
  assert.equal(fake.sends(phone).length, n, 'duplikat tidak memicu balasan baru');
  const conv = (await convs()).filter((x) => x.phone === phone);
  assert.equal(conv.length, 1);
});

test('[MOCK] retry: event id yang sama dikirim dua kali -> satu balasan (format B)', async () => {
  const phone = newPhone();
  const wh = formatB({ phone, eventId: 'evt_retry_sama' + uid() });
  const r1 = await post(wh);
  assert.equal(r1.json.result, 'processed');
  const n = fake.sends(phone).length;
  const r2 = await post(wh); // body identik = pengiriman ulang
  assert.equal(r2.status, 200);
  assert.equal(r2.json.result, 'duplicate');
  assert.equal(fake.sends(phone).length, n);
  // Kunci dedupe = messageId, bukan event id: event id baru dengan messageId sama juga duplikat.
  const again = formatB({ phone, messageId: wh.messageId });
  assert.equal((await post(again)).json.result, 'duplicate');
  assert.equal(fake.sends(phone).length, n);
});

test('[MOCK] dedupe lintas format: message_id sama di format A lalu B -> satu balasan', async () => {
  const phone = newPhone();
  const id = `lintas_${uid()}`;
  assert.equal((await post(formatA({ phone, messageId: id }))).json.result, 'processed');
  const n = fake.sends(phone).length;
  assert.equal((await post(formatB({ phone, messageId: id }))).json.result, 'duplicate');
  assert.equal(fake.sends(phone).length, n);
});

// Pesan masuk tidak boleh hilang walau API Convia gagal; galat terlapor lewat status pesan bot + perhatian percakapan.
const failureCases = [
  ['API mati (koneksi ditolak)', 'down'],
  ['API memutus koneksi', 'destroy'],
  ['API timeout', 'timeout'],
  ['API 401 (kunci ditolak)', '401'],
  ['API 429 (batas laju)', '429'],
  ['API window_closed (jendela 24 jam)', 'window_closed'],
];
for (const [label, mode] of failureCases) {
  test(`[MOCK] ${label}: pesan masuk tetap tersimpan dan galat terlapor`, { timeout: 150000 }, async () => {
    const phone = newPhone();
    if (mode === 'down') await fake.close();
    else fake.state.mode = mode;
    try {
      const r = await post(formatA({ phone }));
      assert.equal(r.status, 200, r.text); // pesan masuk diproses; yang gagal hanya balasan
      assert.equal(r.json.result, 'processed');
    } finally {
      if (mode === 'down') await fake.listen(Number(new URL(fake.baseUrl).port));
      fake.reset();
    }
    const lead = await leadOf(phone);
    assert.ok(lead, 'lead tetap terbentuk walau API gagal');
    const conv = (await c.get(`/api/conversations/${phone}`)).json;
    const body = JSON.stringify(conv);
    assert.ok(body.includes('mau tanya harga'), 'pesan pelanggan tidak hilang');
    const row = (await convs()).find((x) => x.phone === phone);
    assert.equal(row.needsAttention, true, 'galat harus terlapor sebagai perlu perhatian');
    assert.equal(row.attentionReason, 'send_failed');
    const botMsgs = (conv.messages || []).filter((m) => m.by === 'bot');
    assert.ok(botMsgs.length >= 1, 'balasan bot yang gagal tetap dicatat di percakapan');
    assert.ok(botMsgs.every((m) => m.status === 'failed'), 'balasan bot berstatus failed, bukan terkirim');
    assert.ok(!srv.logs().includes(API_KEY), 'log tidak memuat API key');
  });
}

test('[MOCK] setelah API pulih, kirim ulang (resend) berhasil', { timeout: 60000 }, async () => {
  const phone = newPhone();
  fake.state.mode = '401';
  await post(formatA({ phone }));
  fake.reset();
  const conv = (await c.get(`/api/conversations/${phone}`)).json;
  const failed = (conv.messages || []).find((m) => m.by === 'bot' && m.status === 'failed');
  assert.ok(failed, 'harus ada balasan gagal untuk dikirim ulang');
  const n = fake.sends(phone).length;
  const r = await c.post(`/api/conversations/${phone}/resend`, { messageId: failed.id });
  assert.equal(r.status, 200, r.text);
  assert.equal(fake.sends(phone).length, n + 1, 'kirim ulang masuk ke API palsu');
  const after = (await c.get(`/api/conversations/${phone}`)).json;
  const m = after.messages.find((x) => x.id === failed.id);
  assert.equal(m.status, 'sent');
  assert.match(m.waId, /^convia:out_/, 'waId balasan memakai id pesan dari Convia');
});

test('[MOCK] BSUID tanpa nomor -> diproses, lead phone kosong, kirim ke Acesio ditolak 400', { timeout: 60000 }, async () => {
  const wh = formatA({ phone: BSUID, text: 'Halo kak dari Instagram, sudah transfer ya' });
  const r = await post(wh);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.result, 'processed');

  const lead = (await leads()).find((l) => l.lid === BSUID);
  assert.ok(lead, 'lead BSUID harus dibuat');
  assert.ok(!lead.phone, 'phone harus kosong; BSUID tidak boleh masuk field phone');
  assert.ok(!(await leads()).some((l) => l.phone === BSUID));

  // balasan dikirim ke BSUID sebagai tujuan
  assert.ok(fake.sends(BSUID).length >= 1, 'bot membalas ke tujuan BSUID');

  // naikkan ke Hot + Won lalu coba kirim ke Acesio
  if (lead.status !== 'Hot Leads') {
    const p = await c.patch('/api/leads/' + lead.id, { status: 'Hot Leads' });
    assert.equal(p.status, 200, p.text);
  }
  const w = await c.patch('/api/leads/' + lead.id, { hotStage: 'Won' });
  assert.equal(w.status, 200, w.text);
  const s = await c.post(`/api/leads/${lead.id}/send-to-acesio`, {});
  assert.equal(s.status, 400, s.text);
  assert.match(s.json.error, /nomor telepon/i);
  assert.equal(acesio.hits.length, 0, 'Acesio tidak boleh dihubungi untuk lead tanpa nomor');
});

test('[MOCK] BSUID format B juga diproses (phone kosong)', async () => {
  const bsuid = 'ID.ENT.987654321';
  const r = await post(formatB({ phone: bsuid }));
  assert.equal(r.json.result, 'processed');
  const lead = (await leads()).find((l) => l.lid === bsuid);
  assert.ok(lead && !lead.phone);
});

test('[MOCK] pesan Instagram diabaikan (kedua format)', async () => {
  const before = (await leads()).length;
  const sendsBefore = fake.sends().length;
  const phone = newPhone();
  const a = await post(formatA({ phone, channel: 'instagram' }));
  const b = await post(formatB({ phone, channel: 'instagram' }));
  for (const r of [a, b]) {
    assert.equal(r.status, 200);
    assert.ok(r.json.skipped, 'harus dilewati');
  }
  assert.equal((await leads()).length, before);
  assert.equal(await leadOf(phone), undefined);
  assert.equal(fake.sends().length, sendsBefore);
});

test('[MOCK] log server tidak memuat API key, secret, atau isi pesan', () => {
  const log = srv.logs();
  assert.ok(!log.includes(API_KEY));
  assert.ok(!log.includes(SECRET));
  assert.ok(!log.includes('mau tanya harga'));
});

// ---------------------------------------------------------------- server lain
test('[MOCK] mode baileys tidak membuka /webhooks/convia (404)', async () => {
  // DISABLE_WA=1 supaya Baileys tidak membuka koneksi nyata ke WhatsApp. Catatan: rute tertutup di sini juga karena
  // modul WA tidak dimuat; logika pemilihan mode baileys ditutup tes fasad di test/wa-provider-select.test.js.
  const s = await startServer({ env: { DISABLE_WA: '1', WA_PROVIDER: 'baileys' } });
  try {
    const wh = formatA({ phone: newPhone() });
    const res = await fetch(s.base + '/webhooks/convia', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sign(wh.raw) }, body: wh.raw });
    assert.equal(res.status, 404);
  } finally {
    await s.stop();
  }
});

test('[MOCK] mode convia tanpa API key/secret: gagal tegas (503), tidak jatuh ke Baileys', async () => {
  const s = await startServer({ env: { DISABLE_WA: '', WA_PROVIDER: 'convia', CONVIA_API_KEY: '', CONVIA_WEBHOOK_SECRET: '', CONVIA_SIGNING_SECRET: '' } });
  try {
    const cl = new Client(s.base, { mode: 'basic' });
    const st = (await cl.get('/api/wa/status')).json;
    assert.equal(st.status, 'misconfigured');
    assert.equal(st.mode, 'convia');
    const wh = formatA({ phone: newPhone() });
    const res = await fetch(s.base + '/webhooks/convia', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sign(wh.raw) }, body: wh.raw });
    assert.equal(res.status, 503);
  } finally {
    await s.stop();
  }
});
