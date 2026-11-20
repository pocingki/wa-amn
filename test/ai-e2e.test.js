// E2E balasan AI (MOCK): server WA-AMN sungguhan (server.js) + server penyedia AI PALSU lokal
// + jalur WhatsApp PALSU (Convia palsu: webhook masuk bertanda tangan, pengiriman keluar ke server palsu)
// + server Acesio PALSU. Semua skenario di sini MOCK.
//
// Lulusnya tes ini TIDAK membuktikan integrasi dengan penyedia AI, WhatsApp, atau Acesio nyata (lihat docs/E2E-AI.md).
//
// ASUMSI (belum terverifikasi dengan layanan nyata):
// - Bentuk API 'openai-compatible' di server palsu: POST {base}/chat/completions, jawaban choices[0].message.content,
//   usage.prompt_tokens/completion_tokens, galat HTTP 401/429/500 dengan badan {error:{message}}.
// - Server Acesio palsu: POST /api/bot/incoming-leads, header X-API-Key, 'name' wajib, nomor dinormalkan jadi angka
//   (awalan 0 -> 62, tanda + dibuang), wa_lead_id yang sama -> 200 { replayed:true } tanpa memperbarui, 'platform' disimpan
//   sebagai referensi. Perilaku ini ditiru dari kontrak sesi, BUKAN dari Acesio nyata.
// - Jalur WhatsApp palsu memakai format webhook Convia "A" yang sama dengan test/convia-e2e.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, Client, basicAuth } from './helpers/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_KEY_AI = 'sk-kunci-ai-mock-e2e-9f3a71c2';
const API_KEY_AI_BARU = 'sk-kunci-ai-baru-mock-e2e-5b8d04e1';
const WH_SECRET = 'secret-webhook-mock-e2e';
const CONVIA_KEY = 'kunci-convia-mock-e2e';
const ACESIO_KEY = 'kunci-acesio-mock-e2e';
const DATA_KEY = 'kunci-data-mock-e2e-ai';
const AI_TEXT = 'Paket Basic Rp100.000 per bulan. Ada yang ingin ditanyakan lagi?';
const AGENT = { name: 'agen-uji', password: 'sandi-agen-uji-12345' };

// ---------------------------------------------------------------- server AI palsu
function makeFakeAi() {
  const state = { mode: 'ok', hits: [], delayMs: 0, text: AI_TEXT };
  const sockets = new Set();
  let server = null;
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      state.hits.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body, raw });
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      const answer = () => {
        switch (state.mode) {
          case 'timeout': return; // sengaja tidak menjawab: klien harus timeout
          // Galat sengaja mengutip kunci untuk memeriksa bahwa pesan ke browser dibersihkan.
          case '401': return send(401, { error: { message: `Incorrect API key provided: ${(req.headers.authorization || '').replace(/^Bearer /, '')}` } });
          case '429': return send(429, { error: { message: 'rate limit' } }, { 'Retry-After': '1' });
          case '500': return send(500, { error: { message: 'boom' } });
          case 'empty': return send(200, { choices: [{ message: { content: '' } }], usage: { prompt_tokens: 5, completion_tokens: 0 } });
          default: return send(200, { choices: [{ message: { content: state.text } }], usage: { prompt_tokens: 120, completion_tokens: 15 } });
        }
      };
      if (state.delayMs > 0) setTimeout(answer, state.delayMs);
      else answer();
    });
  };
  return {
    state,
    get baseUrl() { return `http://127.0.0.1:${server.address().port}/v1`; },
    reset() { state.mode = 'ok'; state.delayMs = 0; state.text = AI_TEXT; },
    async listen() {
      server = http.createServer(handler);
      server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

// ---------------------------------------------------------------- WhatsApp palsu (Convia palsu)
function makeFakeWa() {
  const state = { requests: [], seq: 0, failContains: null };
  const sockets = new Set();
  let server = null;
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const isSend = req.method === 'POST' && req.url.endsWith('/messages/send');
      // Gagal hanya untuk balasan yang memuat penanda tertentu (galat tidak bisa diulang: WINDOW_CLOSED).
      const failed = isSend && !!state.failContains && String(body?.content || '').includes(state.failContains);
      state.requests.push({ method: req.method, url: req.url, body, failed });
      if (req.url.endsWith('/health')) return send(200, { ok: true });
      if (!isSend) return send(200, { data: {} });
      if (failed) return send(400, { error: { code: 'WINDOW_CLOSED', message: 'x' } });
      return send(200, { data: { message_id: `out_${++state.seq}`, status: 'sent', timestamp: new Date().toISOString() } });
    });
  };
  return {
    state,
    get baseUrl() { return `http://127.0.0.1:${server.address().port}/api/v1/public`; },
    // Hanya pengiriman yang BERHASIL; percobaan yang ditolak ada di attempts().
    texts: (phone) => state.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/messages/send') && !r.failed && r.body?.phone_number === phone).map((r) => String(r.body.content)),
    attempts: (phone) => state.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/messages/send') && r.body?.phone_number === phone).map((r) => String(r.body.content)),
    async listen() {
      server = http.createServer(handler);
      server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

// ---------------------------------------------------------------- Acesio palsu
function makeFakeAcesio() {
  const state = { requests: [], byLead: new Map(), seq: 0 };
  let server = null;
  const normPhone = (v) => {
    let d = String(v ?? '').replace(/\D/g, '');
    if (d.startsWith('0')) d = '62' + d.slice(1);
    return d;
  };
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      state.requests.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] || '', body });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || req.url !== '/api/bot/incoming-leads') return send(404, { error: 'tidak ada' });
      if (req.headers['x-api-key'] !== ACESIO_KEY) return send(401, { error: 'kunci salah' });
      if (!body || typeof body.name !== 'string' || !body.name.trim()) return send(400, { error: 'name wajib' });
      const phone = normPhone(body.phone);
      if (phone.length < 8) return send(400, { error: 'phone tidak valid' });
      const lid = String(body.wa_lead_id || '');
      if (lid && state.byLead.has(lid)) return send(200, { id: state.byLead.get(lid).id, replayed: true }); // tidak diperbarui
      const rec = { id: `ac_${++state.seq}`, name: body.name.trim(), phone, referensi: String(body.platform || '') };
      if (lid) state.byLead.set(lid, rec);
      return send(201, { id: rec.id });
    });
  };
  return {
    state,
    async listen() {
      server = http.createServer(handler);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------- pembantu
let srv;
let c;
let ai;
let wa;
let acesio;
let phoneSeq = 0;
let msgSeq = 0;
const newPhone = () => `62813${String(70000 + ++phoneSeq).padStart(7, '0')}`;
const sign = (raw) => crypto.createHmac('sha256', WH_SECRET).update(raw).digest('hex');

/** Webhook masuk format A bertanda tangan. Mengembalikan { status, json }. */
async function inbound(phone, text, { name = 'Budi Uji', messageId = `m_${Date.now().toString(36)}${++msgSeq}` } = {}) {
  const raw = JSON.stringify({
    event: 'message.received',
    timestamp: new Date().toISOString(),
    data: { message_id: messageId, channel: 'whatsapp', message_type: 'text', content: text, customer_phone: phone, customer_name: name },
  });
  const res = await fetch(srv.base + '/webhooks/convia', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sign(raw) },
    body: raw,
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* bukan JSON */ }
  return { status: res.status, json, text: body };
}

async function setSettings(patch) {
  const cur = (await c.get('/api/settings')).json;
  const r = await c.put('/api/settings', patch, { headers: { 'If-Match': String(cur.version) } });
  assert.equal(r.status, 200, r.text);
  return r.json;
}
const usage = async () => (await c.get('/api/ai/usage')).json;
const conv = async (phone) => (await c.get(`/api/conversations/${phone}`)).json;
const leadOf = async (phone) => (await c.get('/api/leads')).json.leads.find((l) => l.phone === phone);
const aiHits = () => ai.state.hits.length;
const isBlank = (v) => !String(v ?? '').trim() || /^tanpa nama$/i.test(String(v).trim());

async function waitFor(fn, { timeoutMs = 15000, stepMs = 100, label = 'kondisi' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor gagal: ${label}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Semua isi berkas di dalam folder data (untuk memeriksa kunci tidak tersimpan sebagai teks biasa). */
function readAllFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { out.push({ file: path.relative(dir, p), text: fs.readFileSync(p).toString('latin1') }); } catch { /* berkas hilang */ }
      }
    }
  };
  walk(dir);
  return out;
}

/** Pengaturan AI standar untuk tes: penyedia palsu, cooldown dimatikan, batas longgar. */
const aiOn = (extra = {}) => ({
  ai: { enabled: true, provider: 'openai-compatible', baseUrl: ai.baseUrl, model: 'model-uji', timeoutMs: 3000, monthlyQuota: 1000, perCustomerDailyLimit: 50, errorMessage: '', ...extra },
});

before(async () => {
  ai = makeFakeAi();
  await ai.listen();
  wa = makeFakeWa();
  await wa.listen();
  acesio = makeFakeAcesio();
  const acesioUrl = await acesio.listen();
  srv = await startServer({
    env: {
      DISABLE_WA: '',
      WA_PROVIDER: 'convia',
      CONVIA_API_KEY: CONVIA_KEY,
      CONVIA_WEBHOOK_SECRET: WH_SECRET,
      CONVIA_BASE_URL: wa.baseUrl,
      ACESIO_URL: acesioUrl,
      ACESIO_BOT_KEY: ACESIO_KEY,
      DATA_KEY,
      AI_API_KEY: '',
    },
  });
  c = new Client(srv.base, { mode: 'basic' });
  await waitFor(async () => (await c.get('/api/wa/status')).json?.status === 'connected', { label: 'wa.status connected' });
  await setSettings({
    knowledge: [
      { id: 'harga', title: 'Harga paket', content: 'Paket Basic Rp100.000 per bulan. Paket Pro Rp250.000 per bulan.', enabled: true },
      { id: 'jam', title: 'Jam layanan', content: 'Layanan buka Senin sampai Jumat pukul 09.00-17.00 WIB.', enabled: true },
    ],
    sendRateLimitPerMinute: 600,
  });
});

after(async () => {
  await srv?.stop();
  await ai?.close();
  await wa?.close();
  await acesio?.close();
});

// ================================================================ 1. AI nonaktif / tanpa kunci
test('[MOCK] AI nonaktif -> perilaku lama: fallback (dengan cooldown), tanpa panggilan AI, kuota 0', async () => {
  const before0 = aiHits();
  const phone = newPhone();
  await inbound(phone, 'Halo'); // pembuka dulu (fallback lama tidak dikirim bersama pembuka)
  await inbound(phone, 'Berapa harga paket basic?');
  const FB = /pesan Anda sudah kami terima/;
  const n1 = wa.texts(phone).filter((t) => FB.test(t)).length;
  assert.equal(n1, 1, `fallback lama harus terkirim satu kali: ${JSON.stringify(wa.texts(phone))}`);
  // Pesan berikutnya masih dalam cooldown fallback: tidak ada fallback kedua.
  await inbound(phone, 'Dan paket pro berapa?');
  assert.equal(wa.texts(phone).filter((t) => FB.test(t)).length, n1, 'cooldown fallback lama tetap berlaku');
  assert.equal(aiHits(), before0, 'AI nonaktif: tidak ada panggilan ke penyedia');
  assert.equal((await usage()).month.used, 0);
});

test('[MOCK] AI aktif tetapi tanpa kunci -> fallback lama, tanpa panggilan AI', async () => {
  await setSettings(aiOn());
  assert.equal((await c.get('/api/settings')).json.ai.hasKey, false);
  const before0 = aiHits();
  const phone = newPhone();
  await inbound(phone, 'Jam buka toko kapan?');
  assert.ok(wa.texts(phone).some((t) => /pesan Anda sudah kami terima/.test(t)), 'fallback lama terkirim');
  assert.equal(aiHits(), before0);
  assert.equal((await usage()).month.used, 0);
});

// ================================================================ 2. Balasan AI sukses + isi prompt
test('[MOCK] pertanyaan bebas -> balasan AI terkirim, kuota +1, urutan pembuka -> AI -> pertanyaan referensi', async () => {
  const k = await c.put('/api/ai/key', { key: API_KEY_AI });
  assert.equal(k.status, 200, k.text);
  assert.deepEqual(k.json, { hasKey: true });
  await setSettings(aiOn({ fallbackCooldownMinutes: undefined }));
  await setSettings({ fallbackCooldownMinutes: 0 });
  const u0 = (await usage()).month.used;
  const h0 = aiHits();
  const phone = newPhone();
  await inbound(phone, 'Halo kak, berapa harga paket basic?', { name: 'Budi Uji' });

  assert.equal(aiHits(), h0 + 1, 'tepat satu panggilan AI');
  const texts = wa.texts(phone);
  assert.equal(texts.length, 3, JSON.stringify(texts));
  assert.match(texts[0], /selamat datang/i);
  assert.equal(texts[1], AI_TEXT);
  assert.match(texts[2], /mengetahui kami dari mana/);
  const u1 = await usage();
  assert.equal(u1.month.used, u0 + 1, 'kuota bertambah 1');
  assert.equal(u1.month.reserved, 0);
  assert.equal(u1.today.used >= 1, true);
  assert.ok(u1.tokens.input >= 120 && u1.tokens.output >= 15, 'token dicatat dari usage penyedia');

  const msgs = (await conv(phone)).messages.filter((m) => m.by === 'bot');
  assert.deepEqual(msgs.map((m) => m.replyKind), ['opening', 'ai', 'question']);
  assert.ok(msgs.every((m) => m.status === 'sent'));
});

test('[MOCK] prompt ke penyedia: memuat basis pengetahuan dan aturan keras, TANPA nomor telepon/nama; kunci hanya di header', async () => {
  const phone = newPhone();
  const h0 = aiHits();
  await inbound(phone, 'Halo kak, tolong info harga paket pro', { name: 'Siti Rahasia' });
  assert.equal(aiHits(), h0 + 1);
  const hit = ai.state.hits[ai.state.hits.length - 1];
  assert.equal(hit.method, 'POST');
  assert.equal(hit.url, '/v1/chat/completions');
  assert.equal(hit.auth, `Bearer ${API_KEY_AI}`);
  assert.equal(hit.body.model, 'model-uji');
  const system = hit.body.messages.find((m) => m.role === 'system')?.content || '';
  assert.match(system, /ATURAN KERAS/);
  assert.match(system, /HANYA berdasarkan basis pengetahuan/);
  assert.match(system, /diteruskan ke admin/);
  assert.match(system, /Jangan mengarang harga/);
  assert.match(system, /Paket Pro Rp250\.000/, 'isi basis pengetahuan ikut terkirim');
  assert.match(system, /Jam layanan/);
  const flat = hit.raw;
  const digits = phone.replace(/\D/g, '');
  for (const needle of [phone, digits.slice(2), '+' + digits, digits.slice(-8)]) {
    assert.equal(flat.includes(needle), false, `nomor telepon bocor ke penyedia AI: ${needle}`);
  }
  assert.equal(flat.includes('Siti Rahasia'), false, 'nama customer tidak dikirim');
  assert.equal(flat.includes(API_KEY_AI), false, 'kunci tidak boleh ada di badan permintaan');
  assert.ok(hit.body.messages.some((m) => m.role === 'user' && /harga paket pro/.test(m.content)), 'pesan customer dikirim');
});

test('[MOCK] salam saja tidak memakai AI; pesan nomor lama tanpa salam tidak memicu pembuka; salam di nomor lama memicu pembuka', async () => {
  const phone = newPhone();
  await inbound(phone, 'Halo'); // nomor baru: pembuka + pertanyaan referensi, tanpa AI
  const h0 = aiHits();
  const t1 = wa.texts(phone);
  assert.match(t1[0], /selamat datang/i);
  assert.equal(t1.length, 2, JSON.stringify(t1)); // pembuka + pertanyaan referensi, tanpa balasan AI
  assert.equal(t1.includes(AI_TEXT), false);
  assert.equal(h0, aiHits());

  await inbound(phone, 'Berapa jam layanan kalian?'); // nomor lama, bukan salam: tanpa pembuka, ada AI
  const t2 = wa.texts(phone).slice(t1.length);
  assert.equal(t2.some((t) => /selamat datang/i.test(t)), false, 'tidak ada pembuka ulang');
  assert.ok(t2.includes(AI_TEXT));
  assert.equal(aiHits(), h0 + 1);

  const h1 = aiHits();
  await inbound(phone, 'Selamat pagi'); // salam di nomor lama: pembuka lagi, tanpa AI
  const t3 = wa.texts(phone).slice(t1.length + t2.length);
  assert.ok(t3.some((t) => /selamat datang/i.test(t)), 'salam memicu pembuka');
  assert.equal(aiHits(), h1, 'salam saja tanpa AI');
});

// ================================================================ 3. Aturan referensi + lead (nama, nomor)
test('[MOCK] referensi: jawaban disimpan (maks 50), tidak ditanya lagi; lewati menghentikan pertanyaan; nama dari pushName', async () => {
  const phone = newPhone();
  await inbound(phone, 'Halo', { name: '  Andi   Wijaya  ' });
  let lead = await leadOf(phone);
  assert.equal(lead.phone, phone, 'phone = angka kanonik dari JID');
  assert.equal(lead.waName, 'Andi Wijaya', 'pushName dirapikan');
  assert.equal(lead.name, 'Andi Wijaya', 'name kosong diisi dari waName');

  const panjang = 'Instagram dari iklan ' + 'x'.repeat(80);
  await inbound(phone, panjang);
  lead = await leadOf(phone);
  assert.equal(lead.referensi, panjang.slice(0, 50));
  const q = wa.texts(phone).filter((t) => /mengetahui kami dari mana/.test(t)).length;
  await inbound(phone, 'Terima kasih');
  assert.equal(wa.texts(phone).filter((t) => /mengetahui kami dari mana/.test(t)).length, q, 'referensi terisi: tidak ditanya lagi');

  // Nomor lain: jawab "lewati" -> berhenti ditanya.
  const p2 = newPhone();
  await inbound(p2, 'Halo');
  assert.equal(wa.texts(p2).filter((t) => /mengetahui kami dari mana/.test(t)).length, 1);
  await inbound(p2, 'lewati');
  const q2 = wa.texts(p2).filter((t) => /mengetahui kami dari mana/.test(t)).length;
  await inbound(p2, 'ok baik');
  assert.equal(wa.texts(p2).filter((t) => /mengetahui kami dari mana/.test(t)).length, q2, 'tidak bertanya lagi setelah dilewati');
  assert.equal((await leadOf(p2)).referensi || '', '', 'lewati tidak mengisi referensi');
});

test('[MOCK] nama yang sudah ada tidak ditimpa pushName baru', async () => {
  const phone = newPhone();
  await inbound(phone, 'Halo', { name: 'Nama Awal' });
  const lead = await leadOf(phone);
  const r = await c.patch(`/api/leads/${lead.id}`, { name: 'Nama Admin' });
  assert.equal(r.status, 200, r.text);
  await inbound(phone, 'Halo lagi', { name: 'Nama WA Baru' });
  const after1 = await leadOf(phone);
  assert.equal(after1.name, 'Nama Admin', 'hasil edit admin tidak ditimpa');
  assert.equal(after1.waName, 'Nama WA Baru', 'waName mengikuti pushName terbaru');
});

// ================================================================ 4. Kuota
test('[MOCK] batas harian per customer: melebihi -> pesan kuota + attention ai_quota; customer lain tetap dilayani', async () => {
  await setSettings(aiOn({ perCustomerDailyLimit: 1 }));
  const a = newPhone();
  const h0 = aiHits();
  await inbound(a, 'Berapa harga paket basic?');
  assert.equal(aiHits(), h0 + 1);
  await inbound(a, 'Dan paket pro berapa?');
  assert.equal(aiHits(), h0 + 1, 'batas harian: tidak ada panggilan kedua');
  const texts = wa.texts(a);
  assert.ok(texts.includes('Terima kasih, pesan Anda kami teruskan ke admin.'), JSON.stringify(texts));
  const cv = await conv(a);
  assert.equal(cv.attentionReason, 'ai_quota');
  assert.equal(cv.needsAttention, true);
  assert.ok(cv.messages.some((m) => m.by === 'bot' && m.replyKind === 'quota'));

  const b = newPhone();
  await inbound(b, 'Berapa harga paket basic?');
  assert.equal(aiHits(), h0 + 2, 'customer lain tidak terpengaruh');
  assert.ok(wa.texts(b).includes(AI_TEXT));
  await setSettings(aiOn({ perCustomerDailyLimit: 50 }));
});

test('[MOCK] kuota bulanan habis -> pesan tetap (dapat diubah) + attention ai_quota, tanpa panggilan AI', async () => {
  const used = (await usage()).month.used;
  await setSettings(aiOn({ monthlyQuota: used, quotaExhaustedMessage: 'Kuota AI bulan ini habis, admin akan membalas.' }));
  const h0 = aiHits();
  const phone = newPhone();
  await inbound(phone, 'Berapa harga paket basic?');
  assert.equal(aiHits(), h0, 'kuota habis: penyedia tidak dipanggil');
  assert.ok(wa.texts(phone).includes('Kuota AI bulan ini habis, admin akan membalas.'), JSON.stringify(wa.texts(phone)));
  assert.equal((await conv(phone)).attentionReason, 'ai_quota');
  const u = await usage();
  assert.equal(u.month.used, used);
  assert.equal(u.month.remaining, 0);
  await setSettings(aiOn({ monthlyQuota: 1000, quotaExhaustedMessage: 'Terima kasih, pesan Anda kami teruskan ke admin.' }));
});

test('[MOCK] banyak customer bersamaan tidak melewati kuota bulanan', async () => {
  const before0 = (await usage()).month;
  const slots = 3;
  await setSettings(aiOn({ monthlyQuota: before0.used + slots, perCustomerDailyLimit: 50 }));
  ai.state.delayMs = 200; // melebarkan jendela balapan
  const h0 = aiHits();
  try {
    const phones = Array.from({ length: 12 }, () => newPhone());
    const rs = await Promise.all(phones.map((p) => inbound(p, 'Berapa harga paket basic?')));
    assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(aiHits() - h0, slots, 'panggilan AI tidak boleh melebihi sisa kuota');
    const u = await usage();
    assert.equal(u.month.used, before0.used + slots);
    assert.equal(u.month.reserved, 0);
    assert.ok(u.month.used <= u.month.limit);
    const quotaCount = phones.filter((p) => wa.texts(p).includes('Terima kasih, pesan Anda kami teruskan ke admin.')).length;
    assert.equal(quotaCount, phones.length - slots, 'sisanya mendapat pesan kuota habis');
  } finally {
    ai.state.delayMs = 0;
    await setSettings(aiOn({ monthlyQuota: 1000 }));
  }
});

// ================================================================ 5. Galat penyedia
for (const mode of ['401', '429', '500', 'empty', 'timeout']) {
  test(`[MOCK] AI ${mode === 'timeout' ? 'timeout' : mode === 'empty' ? 'jawaban kosong' : `HTTP ${mode}`} -> fallback, attention ai_error, kuota tidak terpakai`, async () => {
    const u0 = (await usage()).month;
    ai.state.mode = mode;
    try {
      const phone = newPhone();
      await inbound(phone, 'Berapa harga paket basic?');
      const texts = wa.texts(phone);
      assert.ok(texts.some((t) => /pesan Anda sudah kami terima/.test(t)), `fallback harus terkirim: ${JSON.stringify(texts)}`);
      assert.equal(texts.includes(AI_TEXT), false);
      assert.equal((await conv(phone)).attentionReason, 'ai_error');
      const u1 = (await usage()).month;
      assert.equal(u1.used, u0.used, 'kuota tidak terpakai');
      assert.equal(u1.reserved, 0, 'tidak ada reservasi tersisa');
    } finally {
      ai.reset();
    }
  });
}

test('[MOCK] galat AI memakai errorMessage bila diisi', async () => {
  await setSettings(aiOn({ errorMessage: 'Maaf, sistem sedang sibuk. Admin akan membalas.' }));
  ai.state.mode = '500';
  try {
    const phone = newPhone();
    await inbound(phone, 'Berapa harga paket basic?');
    assert.ok(wa.texts(phone).includes('Maaf, sistem sedang sibuk. Admin akan membalas.'), JSON.stringify(wa.texts(phone)));
    assert.equal((await conv(phone)).attentionReason, 'ai_error');
  } finally {
    ai.reset();
    await setSettings(aiOn({ errorMessage: '' }));
  }
});

// ================================================================ 6. Gagal kirim WhatsApp, retry, duplikat
/** Jalankan skenario: AI sukses, tetapi pengiriman WhatsApp balasan AI ditolak. WhatsApp dipulihkan di akhir. */
async function runFailedSend() {
  const MARK = 'JAWABAN-UJI-GAGAL-KIRIM';
  const phone = newPhone();
  await inbound(phone, 'Halo'); // pembuka + referensi terkirim normal
  const u0 = (await usage()).month;
  const h0 = aiHits();
  ai.state.text = `${MARK} Paket Basic Rp100.000.`;
  wa.state.failContains = MARK;
  try {
    await inbound(phone, 'Berapa harga paket basic?');
    const cv = await conv(phone);
    const failed = cv.messages.filter((m) => m.by === 'bot' && m.status === 'failed');
    const u1 = (await usage()).month;
    wa.state.failContains = null;
    return { MARK, phone, u0, u1, h0, cv, failed };
  } finally {
    wa.state.failContains = null;
    ai.reset();
  }
}

test('[MOCK] kirim WhatsApp gagal setelah AI sukses -> balasan failed + attention send_failed; AI dipanggil sekali', async () => {
  const r = await runFailedSend();
  assert.equal(aiHits(), r.h0 + 1, 'AI dipanggil sekali');
  assert.equal(wa.texts(r.phone).some((t) => t.includes(r.MARK)), false, 'pengiriman palsu menolak balasan ini');
  assert.ok(wa.attempts(r.phone).some((t) => t.includes(r.MARK)), 'bot sempat mencoba mengirim');
  assert.equal(r.failed.length, 1, JSON.stringify(r.cv.messages.map((m) => [m.by, m.replyKind, m.status])));
  assert.equal(r.cv.attentionReason, 'send_failed');
  assert.equal(r.u1.reserved, 0, 'tidak ada reservasi tersisa');
});

// TEMUAN (FAIL, bukan MOCK-vs-REAL): kontrak meminta kuota dilepas bila kirim gagal setelah AI sukses.
// Kenyataannya B4 (ai-reply.js) sudah commit saat AI sukses, dan refund B3 (ai-quota.js) hanya melepas baris 'reserved',
// sehingga refund dari pipeline (B6) tidak berefek: kuota terpakai walau balasan tidak sampai.
// DIPERBAIKI saat penggabungan: ai-quota.release() melepas kuota yang sudah commit; pipeline memakainya bila kirim gagal.
test('[MOCK] kirim WhatsApp gagal setelah AI sukses -> kuota dilepas (refund)', async () => {
  const r = await runFailedSend();
  assert.equal(r.u1.used, r.u0.used, 'kuota dilepas karena balasan tidak terkirim');
});

test('[MOCK] retry balasan gagal -> teks AI dipakai ulang: satu panggilan AI, satu balasan, tanpa kuota ganda', async () => {
  const r = await runFailedSend();
  assert.equal(r.failed.length, 1);
  const hAfterFail = aiHits();
  const rr = await c.post(`/api/conversations/${r.phone}/resend`, { messageId: r.failed[0].id });
  assert.equal(rr.status, 200, rr.text);
  assert.equal(aiHits(), hAfterFail, 'retry TIDAK memanggil AI lagi');
  const sent = wa.texts(r.phone).filter((t) => t.includes(r.MARK));
  assert.equal(sent.length, 1, 'tepat satu balasan terkirim');
  assert.equal(sent[0], `${r.MARK} Paket Basic Rp100.000.`, 'teks sama dipakai ulang');
  const u2 = (await usage()).month;
  assert.equal(u2.used, r.u1.used, 'retry tidak menambah kuota');
  assert.equal(u2.reserved, 0);
  const cv = await conv(r.phone);
  assert.equal(cv.messages.filter((m) => m.by === 'bot' && m.status === 'failed').length, 0, 'tidak ada pesan failed tersisa');
});

test('[MOCK] webhook yang sama dikirim ulang (retry penyedia) -> satu panggilan AI, satu balasan', async () => {
  const phone = newPhone();
  await inbound(phone, 'Halo');
  const h0 = aiHits();
  const n0 = wa.texts(phone).length;
  const messageId = `dup_${Date.now().toString(36)}`;
  const r1 = await inbound(phone, 'Berapa harga paket basic?', { messageId });
  const r2 = await inbound(phone, 'Berapa harga paket basic?', { messageId });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(aiHits(), h0 + 1, 'satu panggilan AI');
  assert.equal(wa.texts(phone).slice(n0).filter((t) => t === AI_TEXT).length, 1, 'satu balasan AI');
});

// ================================================================ 7. Kerahasiaan kunci + peran
test('[MOCK] uji koneksi memakai kunci tersimpan; galat penyedia yang mengutip kunci dibersihkan', async () => {
  const ok = await c.post('/api/ai/test', {});
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true, ok.text);
  assert.equal(ok.text.includes(API_KEY_AI), false);
  ai.state.mode = '401';
  try {
    const bad = await c.post('/api/ai/test', {});
    assert.equal(bad.status, 200);
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.kind, 'auth');
    assert.equal(bad.text.includes(API_KEY_AI), false, 'pesan galat tidak boleh memuat kunci');
  } finally {
    ai.reset();
  }
});

test('[MOCK] kunci tidak muncul di GET /api/settings, /api/ai/*, audit, log server, maupun berkas data', async () => {
  // Ganti kunci supaya kunci lama juga diperiksa (berkas .bak harus tidak menyimpan kunci lama).
  const put = await c.put('/api/ai/key', { key: API_KEY_AI_BARU });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { hasKey: true });
  const keys = [API_KEY_AI, API_KEY_AI_BARU];
  const asString = (r) => r.text;

  const s = await c.get('/api/settings');
  assert.equal(s.json.ai.hasKey, true);
  assert.equal('apiKey' in s.json.ai, false);
  for (const k of keys) assert.equal(asString(s).includes(k), false, 'kunci di /api/settings');

  for (const r of [await c.get('/api/ai/usage'), await c.post('/api/ai/test', {}), await c.get('/api/settings/history')]) {
    for (const k of keys) assert.equal(r.text.includes(k), false, `kunci di ${r.status}`);
  }
  const audit = await c.get('/api/audit?limit=500');
  assert.equal(audit.status, 200);
  assert.ok(audit.json.entries.some((e) => e.action === 'ai.key.set'), 'perubahan kunci tercatat di audit');
  for (const k of keys) assert.equal(audit.text.includes(k), false, 'kunci di audit');

  const log = srv.logs();
  for (const k of keys) assert.equal(log.includes(k), false, 'kunci di log server');

  const files = readAllFiles(srv.dataDir);
  assert.ok(files.length > 0);
  for (const f of files) {
    for (const k of keys) assert.equal(f.text.includes(k), false, `kunci tersimpan sebagai teks biasa di ${f.file}`);
  }
});

test('[MOCK] isi pesan customer tidak muncul di log server', async () => {
  const marker = `PENANDA-ISI-PESAN-${Date.now().toString(36)}`;
  const phone = newPhone();
  await inbound(phone, `Berapa harga paket basic ${marker}?`);
  assert.equal(srv.logs().includes(marker), false, 'isi pesan customer bocor ke log');
});

test('[MOCK] nomor telepon customer utuh tidak muncul di log server', async () => {
  const phone = newPhone();
  await inbound(phone, 'Berapa harga paket pro?');
  const digits = phone.replace(/\D/g, '');
  assert.equal(srv.logs().includes(digits), false, 'nomor utuh bocor ke log');
});

// TEMUAN: pesan customer yang sedang diproses ikut di riwayat percakapan DAN ditambahkan lagi sebagai pesan terakhir,
// sehingga muncul dua kali di prompt (boros token, bisa membingungkan model). DIPERBAIKI saat penggabungan: ai-reply.js melewati pesan yang sedang dijawab (cocok id) lalu menambahkannya sekali di akhir.
test('[MOCK] pesan customer saat ini muncul tepat sekali di prompt', async () => {
  const phone = newPhone();
  const q = `Apakah ada diskon untuk paket pro ${Date.now().toString(36)}?`;
  await inbound(phone, q);
  const hit = ai.state.hits[ai.state.hits.length - 1];
  assert.equal(hit.body.messages.filter((m) => m.role === 'user' && m.content === q).length, 1);
});

test('[MOCK] agent: bisa melihat pemakaian, tidak bisa mengubah kunci/uji/pengaturan/kuota', async () => {
  const mk = await c.post('/api/users', { name: AGENT.name, password: AGENT.password, role: 'agent' });
  assert.ok(mk.status === 201 || mk.status === 200, mk.text);
  const H = { headers: { Authorization: basicAuth(AGENT.name, AGENT.password) } };
  const agent = new Client(srv.base, { mode: 'basic' });
  const before0 = await usage();

  const u = await agent.get('/api/ai/usage', H);
  assert.equal(u.status, 200, u.text);
  assert.equal(u.json.month.limit, before0.month.limit);

  assert.equal((await agent.put('/api/ai/key', { key: 'sk-penyusup-12345678' }, H)).status, 403);
  assert.equal((await agent.del('/api/ai/key', H)).status, 403);
  assert.equal((await agent.post('/api/ai/test', {}, H)).status, 403);
  const cur = (await c.get('/api/settings')).json;
  const put = await agent.put('/api/settings', { ai: { monthlyQuota: 999999 } }, { headers: { ...H.headers, 'If-Match': String(cur.version) } });
  assert.equal(put.status, 403);

  const g = await agent.get('/api/settings', H);
  assert.equal(g.status, 200);
  for (const k of [API_KEY_AI, API_KEY_AI_BARU]) assert.equal(g.text.includes(k), false);
  assert.equal((await c.get('/api/settings')).json.ai.hasKey, true, 'kunci tetap ada');
  assert.equal((await usage()).month.limit, before0.month.limit, 'kuota tidak berubah');
});

// ================================================================ 8. UI: API resmi disembunyikan, backend lama tetap jalan
test('[MOCK] UI Pengaturan tidak menawarkan pilihan API resmi; backend Convia tetap aktif', async () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const assets = ['pengaturan.js', 'integrasi.js', 'tester.js', 'percakapan.js', 'pesan.js', 'crm.js'].map((f) => `/assets/js/pages/${f}`);
  const sources = [{ name: '/', text: (await c.get('/')).text }, { name: '/assets/js/lib.js', text: (await c.get('/assets/js/lib.js')).text }];
  for (const a of assets) sources.push({ name: a, text: (await c.get(a)).text });
  const pengaturan = sources.find((s) => s.name.endsWith('pengaturan.js'));
  assert.ok(pengaturan.text.length > 1000, 'pengaturan.js harus terlayani');
  for (const s of sources) {
    const t = stripComments(s.text);
    assert.equal(/<option[^>]*convia/i.test(t), false, `${s.name}: opsi Convia tampil`);
    assert.equal(/value=["']convia["']/i.test(t), false, `${s.name}: value convia di form`);
    assert.equal(/API resmi/i.test(t), false, `${s.name}: teks "API resmi" tampil`);
    assert.equal(/name=["']waProvider["']|id=["'][^"']*wa-?provider[^"']*["']/i.test(t), false, `${s.name}: kontrol pemilih penyedia WA`);
  }
  // Backend lama tetap berfungsi: mode convia aktif dan pengaturan waProvider masih dikenali API.
  const st = (await c.get('/api/wa/status')).json;
  assert.equal(st.mode, 'convia');
  assert.equal(st.status, 'connected');
  assert.ok(['baileys', 'convia'].includes((await c.get('/api/settings')).json.waProvider));
});

// ================================================================ 9. Aturan bisnis -> Acesio (server palsu)
test('[MOCK] Acesio: kesiapan data, payload (name, phone kanonik, platform=referensi), replayed tidak dianggap kiriman baru', async () => {
  const phone = newPhone();
  await inbound(phone, 'Halo', { name: 'Budi Santoso' });
  await inbound(phone, 'Instagram', { name: 'Budi Santoso' });
  const lead = await leadOf(phone);
  assert.equal(lead.referensi, 'Instagram');
  assert.equal(lead.waName, 'Budi Santoso');
  assert.equal(lead.name, 'Budi Santoso');

  // Belum Hot/Won: tidak eligible dan tidak bisa dikirim.
  const d0 = (await c.get(`/api/leads/${lead.id}`)).json;
  const rd0 = d0.lead?.acesioReadiness || d0.acesioReadiness;
  assert.equal(rd0.eligible, false);
  const no = await c.post(`/api/leads/${lead.id}/send-to-acesio`, {});
  assert.equal(no.status, 400);
  assert.equal(acesio.state.requests.length, 0, 'Acesio tidak disentuh');

  await setSettings({ crmAgent: { autoSubmit: false } }); // jalur manual diuji di sini; jalur otomatis diuji di acesio-auto.test.js
  const p = await c.patch(`/api/leads/${lead.id}`, { status: 'Hot Leads', hotStage: 'Won' });
  assert.equal(p.status, 200, p.text);
  const d1 = (await c.get(`/api/leads/${lead.id}`)).json;
  const rd1 = d1.lead?.acesioReadiness || d1.acesioReadiness;
  assert.deepEqual(rd1, { eligible: true, ready: true, missing: [] });

  const r1 = await c.post(`/api/leads/${lead.id}/send-to-acesio`, {});
  assert.equal(r1.status, 200, r1.text);
  assert.equal(acesio.state.requests.length, 1);
  const req = acesio.state.requests[0];
  assert.equal(req.key, ACESIO_KEY);
  assert.equal(req.body.name, 'Budi Santoso');
  assert.equal(req.body.phone, phone, 'nomor kanonik (angka) apa adanya dari JID');
  assert.match(req.body.phone, /^\d+$/);
  assert.equal(req.body.platform, 'Instagram', 'platform = referensi');
  assert.equal(typeof req.body.keyword, 'string');
  assert.ok(req.body.keyword.length <= 100);
  assert.equal(req.body.wa_lead_id, lead.id);
  assert.ok('note' in req.body && 'data' in req.body);
  assert.equal(acesio.state.byLead.get(lead.id).referensi, 'Instagram');
  assert.equal(acesio.state.byLead.get(lead.id).phone, phone, 'normalisasi Acesio tidak mengubah nomor kanonik');
  assert.equal((await leadOf(phone)).acesioStatus, 'sent');
  assert.equal((await leadOf(phone)).acesioReplayed, false);

  // Kirim lagi (wa_lead_id sama): Acesio menjawab replayed -> bukan pengiriman baru.
  const r2 = await c.post(`/api/leads/${lead.id}/send-to-acesio`, {});
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.replayed, true);
  assert.equal(r2.json.message, 'Sudah ada di Acesio (tidak diperbarui)');
  assert.equal(acesio.state.byLead.size, 1, 'tidak ada rekaman baru di Acesio');
  const after1 = await leadOf(phone);
  assert.equal(after1.acesioStatus, 'sent');
  assert.equal(after1.acesioSentAt, (await leadOf(phone)).acesioSentAt);
});

test('[MOCK] Acesio: data kurang (referensi/nama) -> 400 dengan daftar yang kurang, tanpa menyentuh Acesio', async () => {
  const phone = newPhone();
  await inbound(phone, 'Halo', { name: '' }); // pushName kosong -> waName kosong, name tetap "Tanpa Nama"
  const lead = await leadOf(phone);
  const n0 = acesio.state.requests.length;
  const p = await c.patch(`/api/leads/${lead.id}`, { status: 'Hot Leads', hotStage: 'Won' });
  assert.equal(p.status, 200, p.text);
  const r = await c.post(`/api/leads/${lead.id}/send-to-acesio`, {});
  assert.equal(r.status, 400, r.text);
  assert.ok(Array.isArray(r.json.missing));
  assert.ok(r.json.missing.includes('referensi'));
  assert.ok(r.json.missing.includes('name'));
  assert.equal(r.json.missing.includes('phone'), false);
  assert.equal(acesio.state.requests.length, n0, 'Acesio tidak disentuh');
  assert.equal((await leadOf(phone)).acesioStatus === 'sent', false);
});

test('[MOCK] hotStage Won mengisi nama kosong dari waName, tanpa menimpa nama yang ada', async () => {
  const phone = newPhone();
  await inbound(phone, 'Halo', { name: 'Dewi Lestari' });
  const lead = await leadOf(phone);
  // Kosongkan nama lewat edit admin, lalu Won: nama dipulihkan dari waName.
  const e = await c.patch(`/api/leads/${lead.id}`, { name: '' });
  assert.equal(e.status, 200, e.text);
  assert.equal(isBlank((await leadOf(phone)).name), true, 'nama sudah dikosongkan');
  const w = await c.patch(`/api/leads/${lead.id}`, { status: 'Hot Leads', hotStage: 'Won' });
  assert.equal(w.status, 200, w.text);
  assert.equal((await leadOf(phone)).name, 'Dewi Lestari');
  // Nama yang sudah ada tidak ditimpa waName saat Won.
  const p2 = newPhone();
  await inbound(p2, 'Halo', { name: 'Nama WA Dua' });
  const l2 = await leadOf(p2);
  assert.equal((await c.patch(`/api/leads/${l2.id}`, { name: 'Nama Pilihan Admin' })).status, 200);
  assert.equal((await c.patch(`/api/leads/${l2.id}`, { status: 'Hot Leads', hotStage: 'Won' })).status, 200);
  assert.equal((await leadOf(p2)).name, 'Nama Pilihan Admin');
});

// ================================================================ 10. Migrasi intent lama -> basis pengetahuan (server terpisah)
test('[MOCK] migrasi intent lama -> basis pengetahuan; skema lama hilang; data wajib jadi satu butir referensi; AI memakai isinya', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-ai-mig-'));
  const legacy = {
    version: 3,
    botName: 'Bot Lama',
    intents: [
      { id: 'harga', name: 'Harga', keywords: ['harga', 'biaya'], response: 'Paket Starter Rp75.000 per bulan.', active: true },
      { id: 'lokasi', name: 'Lokasi', keywords: ['alamat', 'lokasi'], response: 'Kami di Jalan Contoh No. 1, Depok.', active: true },
    ],
    slangMap: { gmn: 'bagaimana' },
    requiredFields: [
      { id: 'nama', label: 'Nama', type: 'text', enabled: true, question: 'Siapa nama Kakak?' },
      { id: 'kebutuhan', label: 'Kebutuhan', type: 'text', enabled: true, question: 'Apa kebutuhan Kakak?' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(legacy));
  const s2 = await startServer({ env: { DATA_DIR: dir, DISABLE_WA: '1', DATA_KEY: '', AI_API_KEY: '' } });
  try {
    const c2 = new Client(s2.base, { mode: 'basic' });
    const st = (await c2.get('/api/settings')).json;
    assert.equal('intents' in st, false, 'intents dihapus dari skema');
    assert.equal('slangMap' in st, false, 'slangMap dihapus dari skema');
    assert.equal(st.botName, 'Bot Lama', 'pengaturan lain tidak hilang');
    const h = st.knowledge.find((k) => k.id === 'intent-harga');
    assert.ok(h, JSON.stringify(st.knowledge));
    assert.equal(h.title, 'Harga');
    assert.equal(h.content, 'Pertanyaan: harga, biaya\nJawaban: Paket Starter Rp75.000 per bulan.');
    assert.equal(h.enabled, true);
    assert.ok(st.knowledge.find((k) => k.id === 'intent-lokasi'));
    assert.deepEqual(st.requiredFields.map((f) => f.id), ['referensi']);

    // Jalur nyata: AI (penyedia palsu) menerima isi hasil migrasi lewat Bot Tester (pipeline yang sama).
    const k = await c2.put('/api/ai/key', { key: API_KEY_AI });
    assert.equal(k.status, 200, k.text);
    await c2.put('/api/settings', aiOn({ fallbackCooldownMinutes: 0 }), { headers: { 'If-Match': String(st.version) } }).then((r) => assert.equal(r.status, 200, r.text));
    const h0 = aiHits();
    const t = await c2.post('/api/tester/send', { phone: '628120009991', text: 'Berapa biaya paket starter?' });
    assert.equal(t.status, 200, t.text);
    assert.equal(aiHits(), h0 + 1);
    const sys = ai.state.hits[ai.state.hits.length - 1].body.messages.find((m) => m.role === 'system').content;
    assert.match(sys, /Paket Starter Rp75\.000/);
    assert.match(sys, /Jalan Contoh No\. 1/);
    assert.ok(t.json.replies.some((r) => r.text === AI_TEXT), JSON.stringify(t.json.replies));
  } finally {
    await s2.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: berkas masih terkunci */ }
  }
});

// Penjaga: modul pemilik sesi lain memang ada di proyek gabungan (bila tidak, tes di atas tidak bermakna).
test('proyek gabungan memuat modul B1-B9/C1-C3', () => {
  for (const f of ['src/ai-providers.js', 'src/ai-knowledge.js', 'src/ai-quota.js', 'src/ai-reply.js', 'src/ai-secret.js', 'src/api/ai.js', 'src/phone.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} tidak ada`);
  }
});
