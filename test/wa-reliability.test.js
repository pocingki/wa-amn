// Regresi F-01: pesan WA tidak boleh ditandai seen sebelum benar-benar tersimpan dan diproses.
// Memakai fasad WhatsApp asli + pipeline asli dengan dependensi palsu (tanpa WhatsApp sungguhan).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AMNAN_NO_BACKUP = '1';
process.env.AMNAN_NO_BG = '1';
process.env.BOT_NO_DELAY = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rel-'));

const { createWhatsApp } = await import('../src/whatsapp.js');
const { processIncoming, handleIncoming } = await import('../src/bot-pipeline.js');
const D = await import('../src/db.js');
const C = await import('../src/conversations.js');

const NOW = 1_700_000_000_000;
const S = {
  botEnabled: true, botName: 'Sari', adminName: 'Dewi', openingMessage: 'Halo', fallbackMessage: '', handoverMessage: '',
  completionMessage: 'Terima kasih', botDurationMinutes: 0, staleMinutes: 10, fallbackCooldownMinutes: 30,
  autoTakeoverOnPhoneReply: true, slangMap: {}, intents: [], requiredFields: [],
};

// Dependensi pipeline palsu (in-memory) dengan titik gagal yang bisa disuntikkan.
function pipelineDeps(o = {}) {
  const st = new Map(), sent = [], ingests = [], saves = [];
  let n = 0;
  const d = {
    now: () => NOW,
    sleep: async () => {},
    send: async (jid, text) => {
      if (o.sendFail) throw Object.assign(new Error('kirim gagal'), { retryable: false });
      if (o.sendSlow) await new Promise((r) => setTimeout(r, o.sendSlow));
      sent.push(text);
      return { waId: 'out' + sent.length };
    },
    settings: { get: () => o.S || S },
    emit: () => {},
    ingest: (p) => {
      if (o.ingestFail?.()) throw new Error('ingest rusak');
      ingests.push(p);
      return { created: false, ignored: false, lead: null, changes: [] };
    },
    leads: {
      findByPhone: (p) => { if (o.findFail?.()) throw new Error('lead rusak'); return undefined; },
      findByLid: () => undefined, update() {}, remove() {},
    },
    convs: {
      getOrCreate: (key, jid, name) => {
        if (!st.has(key)) {
          st.set(key, { phone: key, jid, name: name || '', mode: 'bot', createdAt: NOW, botStartedAt: NOW, lastMessageAt: NOW, unread: 0, openingSent: false, pending: null, skipped: [], retries: {}, data: {}, messages: [] });
        }
        return { conv: st.get(key), created: false };
      },
      get: (k) => st.get(k), remove: (k) => void st.delete(k),
      save() { if (o.saveFail?.()) throw new Error('save akhir gagal'); },
      saveNow(conv) {
        if (o.storeFail?.()) throw new Error('Pesan gagal disimpan ke database');
        saves.push(conv.messages.length);
      },
      addMessage(c, by, text, ts = NOW) { const m = { id: 'm' + ++n, by, text, ts }; c.messages.push(m); return m; },
      list: () => [...st.values()].map((c) => ({ phone: c.phone })),
      totalUnread: () => 0,
    },
  };
  if (o.ai) d.ai = o.ai;
  if (o.quota) d.quota = o.quota;
  if (o.plan) d.plan = o.plan;
  return { d, st, sent, ingests, saves };
}

// Fasad nyata + pipeline palsu. `seen` mencatat urutan agar bisa membuktikan seen tidak mendahului proses.
function harness(o = {}) {
  const p = pipelineDeps(o);
  const seen = new Set(), timeline = [], emits = [];
  const f = createWhatsApp({
    createConnection: () => ({ wa: { status: 'connected' }, adapter: () => ({}), start() {}, stop() {}, logout() {} }),
    sender: { sendText: async () => ({ waId: 'x' }), wasSentBySystem: () => false },
    convs: {
      seenMessage: (id) => seen.has(id),
      markSeen: (id) => {
        const conv = p.st.get('6281');
        timeline.push({ ev: 'seen', id, handled: !!conv?.messages.find((m) => m.waId === id)?.handled, sent: p.sent.length });
        seen.add(id);
      },
    },
    extractMessage: () => ({ kind: 'text', text: 'halo', caption: '', hasMedia: false, source: {} }),
    resolveIdentity: async (k) => ({ jid: k.remoteJid, phone: k.remoteJid.split('@')[0], lid: null }),
    handleIncoming: (env) => processIncoming(env, p.d),
    emit: (t, pl) => emits.push([t, pl]),
    now: () => NOW,
    retryDelaysMs: o.retryDelaysMs ?? [1, 1],
    sleep: async () => {},
  });
  const raw = (id = 'W1') => ({ messageTimestamp: NOW / 1000, pushName: 'Budi', key: { remoteJid: '6281@s.whatsapp.net', id, fromMe: false } });
  return { f, raw, seen, timeline, emits, ...p };
}

test('berhasil: pesan tersimpan, dibalas, baru ditandai seen setelah selesai', async () => {
  const h = harness();
  await h.f.handleMessage(h.raw('W1'));
  assert.deepEqual(h.sent, ['Halo']);
  const conv = h.st.get('6281');
  assert.equal(conv.messages.filter((m) => m.by === 'customer').length, 1);
  assert.equal(h.timeline.length, 1);
  assert.deepEqual(h.timeline[0], { ev: 'seen', id: 'W1', handled: true, sent: 1 }); // seen SETELAH handled + balasan
  assert.equal(h.saves[0], 1); // disimpan durable saat baru ada pesan pelanggan, sebelum balasan bot
});

test('gagal disimpan: bot tidak berjalan, tidak ada balasan/CRM, tidak seen, dicatat; pulih saat dikirim ulang', async () => {
  let down = true;
  const h = harness({ storeFail: () => down });
  await h.f.handleMessage(h.raw('W2'));
  assert.equal(h.seen.has('W2'), false);
  assert.deepEqual(h.sent, []);
  assert.equal(h.ingests.length, 0);
  assert.equal(h.emits.filter(([t]) => t === 'wa:process_failed').length, 1);
  assert.match(h.emits.find(([t]) => t === 'wa:process_failed')[1].error, /gagal disimpan/);
  down = false; // WhatsApp mengirim ulang pesan yang sama
  await h.f.handleMessage(h.raw('W2'));
  assert.equal(h.seen.has('W2'), true);
  assert.deepEqual(h.sent, ['Halo']);
  assert.equal(h.st.get('6281').messages.filter((m) => m.by === 'customer').length, 1); // tidak ganda
});

test('galat pipeline sesaat: diulang otomatis, hasil akhir satu pesan, satu CRM, satu balasan', async () => {
  let fails = 1;
  const h = harness({ ingestFail: () => fails-- > 0 });
  await h.f.handleMessage(h.raw('W3'));
  assert.equal(h.seen.has('W3'), true);
  assert.equal(h.ingests.length, 1);
  assert.deepEqual(h.sent, ['Halo']);
  assert.equal(h.st.get('6281').messages.filter((m) => m.by === 'customer').length, 1);
  assert.equal(h.st.get('6281').unread, 1);
});

test('galat pipeline permanen: tidak seen, tidak ada balasan, tercatat', async () => {
  const h = harness({ ingestFail: () => true });
  await h.f.handleMessage(h.raw('W4'));
  assert.equal(h.seen.has('W4'), false);
  assert.deepEqual(h.sent, []);
  assert.equal(h.emits.filter(([t]) => t === 'wa:process_failed').length, 1);
  assert.equal(h.st.get('6281').messages.filter((m) => m.by === 'customer').length, 1); // pesan tetap tersimpan, tidak hilang
});

test('kirim balasan gagal: pesan pelanggan tetap ada, balasan bertanda failed + perlu perhatian (bukan hilang diam-diam)', async () => {
  const h = harness({ sendFail: true });
  await h.f.handleMessage(h.raw('W5'));
  const conv = h.st.get('6281');
  assert.equal(conv.messages.find((m) => m.by === 'customer').handled, true);
  assert.equal(conv.messages.find((m) => m.by === 'bot').status, 'failed');
  assert.equal(conv.needsAttention, true);
  assert.equal(conv.attentionReason, 'send_failed');
  assert.equal(h.seen.has('W5'), true); // sudah tersimpan; pengiriman ulang lewat tombol resend, bukan pesan ulang
});

test('retry setelah balasan terkirim tetapi langkah akhir gagal: tidak ada balasan ganda', async () => {
  let calls = 0;
  const h = harness({ findFail: () => ++calls === 4 }); // panggilan ke-4 = sinkron lead setelah balasan terkirim (1 nomor baru, 2 ctx, 3 setelah kirim)
  await h.f.handleMessage(h.raw('W6'));
  assert.deepEqual(h.sent, ['Halo']); // hanya satu kali
  assert.equal(h.st.get('6281').messages.filter((m) => m.by === 'bot').length, 1);
  assert.equal(h.st.get('6281').messages.filter((m) => m.by === 'customer').length, 1);
  assert.equal(h.seen.has('W6'), true);
});

test('retry setelah save akhir gagal: pesan sudah handled, tidak diproses ulang', async () => {
  let fail = true;
  const h = harness({ saveFail: () => fail && !(fail = false) });
  await h.f.handleMessage(h.raw('W7'));
  assert.deepEqual(h.sent, ['Halo']);
  assert.equal(h.ingests.length, 1);
  assert.equal(h.seen.has('W7'), true);
});

test('pesan duplikat: id sama (sudah seen, sedang diproses, atau pengiriman ulang pipeline) tidak diproses dua kali', async () => {
  const h = harness({ sendSlow: 20 });
  await Promise.all([h.f.handleMessage(h.raw('W8')), h.f.handleMessage(h.raw('W8'))]); // bersamaan
  await h.f.handleMessage(h.raw('W8')); // setelah seen
  assert.deepEqual(h.sent, ['Halo']);
  assert.equal(h.st.get('6281').messages.filter((m) => m.by === 'customer').length, 1);
  // pipeline langsung (seen hilang, mis. restart): id yang sudah handled dilewati
  const r = await processIncoming({ waId: 'W8', jid: '6281@s.whatsapp.net', phone: '6281', lid: null, name: '', ts: NOW, kind: 'text', text: 'halo', caption: '', mediaId: null, source: {} }, h.d);
  assert.equal(r.duplicate, true);
  assert.deepEqual(h.sent, ['Halo']);
  assert.equal(h.st.get('6281').unread, 1);
});

// ---- AI lewat fasad + pipeline asli (MOCK AI; bukan bukti berhasil dengan penyedia nyata) ----
const SAI = { ...S, fallbackMessage: 'Diteruskan ke admin.', ai: { enabled: true, quotaExhaustedMessage: 'Kuota habis.', errorMessage: 'Maaf, ada gangguan.' } };
const aiPlan = () => ({ replies: [{ kind: 'ai', needsAi: true, text: '', commit: () => {} }], attention: null, ignored: false });
const mkAi = (results = [{ ok: true, text: 'Jawaban AI', usage: {} }]) => {
  const calls = [], q = [...results];
  return { calls, reply: async (a) => { calls.push(a); return q.length > 1 ? q.shift() : q[0]; } };
};
const mkQuota = () => { const refunds = []; return { refunds, refund: (k) => void refunds.push(k) }; };

test('AI berhasil: dibalas, baru ditandai seen setelah handled; AI dipanggil sekali', async () => {
  const ai = mkAi(), h = harness({ S: SAI, ai, plan: aiPlan });
  await h.f.handleMessage(h.raw('A1'));
  assert.deepEqual(h.sent, ['Jawaban AI']);
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(h.timeline[0], { ev: 'seen', id: 'A1', handled: true, sent: 1 });
  assert.equal(h.st.get('6281').messages.find((m) => m.by === 'customer').aiText, 'Jawaban AI');
});

test('AI berhasil lalu sinkron lead gagal sesaat: retry tidak memanggil AI lagi dan tidak membalas ganda', async () => {
  let calls = 0;
  const ai = mkAi(), h = harness({ S: SAI, ai, plan: aiPlan, findFail: () => ++calls === 4 });
  await h.f.handleMessage(h.raw('A2'));
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(h.sent, ['Jawaban AI']);
  assert.equal(h.st.get('6281').messages.filter((m) => m.by === 'bot').length, 1);
  assert.equal(h.seen.has('A2'), true);
});

test('galat pipeline sebelum AI (ingest gagal sesaat): setelah pulih AI dipanggil tepat sekali', async () => {
  let fails = 1;
  const ai = mkAi(), h = harness({ S: SAI, ai, plan: aiPlan, ingestFail: () => fails-- > 0 });
  await h.f.handleMessage(h.raw('A3'));
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(h.sent, ['Jawaban AI']);
  assert.equal(h.seen.has('A3'), true);
});

test('AI galat/kuota habis tidak mengganggu F-01: pesan tetap handled, seen, dan perlu perhatian', async () => {
  for (const [res, reason, text] of [[{ ok: false, reason: 'error' }, 'ai_error', 'Maaf, ada gangguan.'], [{ ok: false, reason: 'quota' }, 'ai_quota', 'Kuota habis.']]) {
    const h = harness({ S: SAI, ai: mkAi([res]), plan: aiPlan });
    await h.f.handleMessage(h.raw('A4'));
    const conv = h.st.get('6281');
    assert.deepEqual(h.sent, [text]);
    assert.equal(conv.attentionReason, reason);
    assert.equal(conv.messages.find((m) => m.by === 'customer').handled, true);
    assert.equal(h.seen.has('A4'), true);
  }
});

test('kirim gagal setelah AI sukses: kuota dilepas, balasan failed, pesan tetap seen', async () => {
  const quota = mkQuota(), h = harness({ S: SAI, ai: mkAi(), quota, plan: aiPlan, sendFail: true });
  await h.f.handleMessage(h.raw('A5'));
  assert.deepEqual(quota.refunds, ['A5']);
  const conv = h.st.get('6281');
  assert.equal(conv.messages.find((m) => m.by === 'bot').status, 'failed');
  assert.equal(conv.attentionReason, 'send_failed');
  assert.equal(h.seen.has('A5'), true);
});

// ---- DB nyata: durabilitas dan antrean pipeline asli ----
test('dua pesan berdekatan (fasad + antrean + DB nyata): berurutan, pembuka sekali, seen setelah masing-masing handled', async () => {
  const sent = [];
  const f = createWhatsApp({
    createConnection: () => ({ wa: { status: 'connected' }, adapter: () => ({}), start() {}, stop() {}, logout() {} }),
    sender: { sendText: async (jid, text) => { await new Promise((r) => setTimeout(r, 10)); sent.push(text); return { waId: 'q' + sent.length }; }, wasSentBySystem: () => false },
    extractMessage: (r) => ({ kind: 'text', text: r._t, caption: '', hasMedia: false, source: {} }),
    resolveIdentity: async (k) => ({ jid: k.remoteJid, phone: '62855', lid: null }),
    emit: () => {},
    retryDelaysMs: [],
  });
  const raw = (id, t) => ({ _t: t, messageTimestamp: Date.now() / 1000, pushName: 'Tia', key: { remoteJid: '62855@s.whatsapp.net', id, fromMe: false } });
  await Promise.all([f.handleMessage(raw('T1', 'halo')), f.handleMessage(raw('T2', 'mau tanya'))]);
  const cust = C.get('62855').messages.filter((m) => m.by === 'customer');
  assert.deepEqual(cust.map((m) => m.waId), ['T1', 'T2']); // urutan masuk terjaga
  assert.ok(cust.every((m) => m.handled && m.ingested));
  assert.equal(C.get('62855').messages.filter((m) => m.replyKind === 'opening').length, 1); // pembuka tidak ganda
  assert.ok(C.seenMessage('T1') && C.seenMessage('T2'));
  // dikirim ulang setelah seen: tidak ada pesan/balasan baru
  const before = C.get('62855').messages.length;
  await f.handleMessage(raw('T1', 'halo'));
  assert.equal(C.get('62855').messages.length, before);
});

test('DB nyata: saveNow menulis sinkron; antrean pipeline menjaga urutan dua pesan berdekatan', async () => {
  const sent = [];
  const send = async (jid, text) => { sent.push(text); return { waId: 'o' + sent.length }; };
  const env = (waId, text) => ({ waId, jid: '62899@s.whatsapp.net', phone: '62899', lid: null, name: 'Rani', ts: Date.now(), kind: 'text', text, caption: '', mediaId: null, mediaError: null, fromMe: false, fromPhone: false, source: {} });
  await Promise.all([handleIncoming(env('R1', 'halo'), send), handleIncoming(env('R2', 'tanya harga'), send)]);
  const conv = C.get('62899');
  const cust = conv.messages.filter((m) => m.by === 'customer');
  assert.deepEqual(cust.map((m) => m.waId), ['R1', 'R2']);
  assert.ok(cust.every((m) => m.handled));
  assert.equal(conv.messages.filter((m) => m.by === 'bot' && m.replyKind === 'opening').length, 1);
  // sudah ada di tabel messages tanpa menunggu debounce
  const rows = D.getDb().prepare('SELECT COUNT(*) c FROM messages').get().c;
  assert.ok(rows >= 2);
});

test('DB nyata: penulisan diblokir -> saveNow melempar dan handleIncoming menolak (tidak ditelan); antrean tidak macet', async () => {
  const conv = C.getOrCreate('62877', '62877@s.whatsapp.net', 'Dito').conv;
  C.addMessage(conv, 'customer', 'x', NOW);
  D.block('uji: disk penuh');
  assert.throws(() => C.saveNow(conv), /gagal disimpan/);
  const env = (id) => ({ waId: id, jid: '62877@s.whatsapp.net', phone: '62877', lid: null, name: '', ts: NOW, kind: 'text', text: 'hai', caption: '', mediaId: null, mediaError: null, fromMe: false, fromPhone: false, source: {} });
  await assert.rejects(handleIncoming(env('B1'), async () => ({ waId: 'z' })), /gagal disimpan/);
  await assert.rejects(handleIncoming(env('B2'), async () => ({ waId: 'z' })), /gagal disimpan/); // tidak menggantung
});