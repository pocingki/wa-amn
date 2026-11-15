import test from 'node:test';
import assert from 'node:assert/strict';
import { processIncoming, onStatusUpdate, resendMessage, handleIncoming, makeRealDeps, customerKeyOf, cleanWaName } from '../src/bot-pipeline.js';
import { createTester } from '../src/bot-tester.js';

const NOW = 1_700_000_000_000;
const S = {
  botEnabled: true, botName: 'Sari', adminName: 'Dewi', openingMessage: 'Halo', fallbackMessage: '', handoverMessage: '',
  completionMessage: 'Terima kasih', botDurationMinutes: 0, staleMinutes: 10, fallbackCooldownMinutes: 30,
  autoTakeoverOnPhoneReply: true, slangMap: {}, intents: [],
  requiredFields: [
    { id: 'referensi', label: 'Referensi', question: 'Kakak tahu kami dari mana?', enabled: true, type: 'text' },
  ],
};
let seq = 0;
const M = (o = {}) => ({
  waId: 'in' + ++seq, jid: '6281@s.whatsapp.net', phone: '6281', lid: null, name: '', ts: NOW, kind: 'text', text: 'halo',
  caption: '', mediaId: null, mediaError: null, fromMe: false, fromPhone: false, source: {}, ...o,
});
// deps palsu: Map in-memory yang meniru API conversations D4.
function mk({ send, leads = [], S: Sx = S, ai, quota, plan, createLead = false } = {}) {
  const st = new Map(), events = [], sleeps = [], ingests = [], sent = [];
  let n = 0;
  const d = {
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
    send: send || (async (jid, text) => (sent.push(text), { waId: 'out' + sent.length })),
    settings: { get: () => Sx },
    emit: (type, payload) => events.push({ type, payload }),
    ingest: (p) => {
      ingests.push(p);
      if (createLead && !leads.some((l) => (p.phone && l.phone === p.phone) || (p.lid && l.lid === p.lid))) {
        const lead = { id: 'L' + (leads.length + 1), phone: p.phone || '', lid: p.lid || null, name: 'Tanpa Nama', data: {} };
        leads.push(lead);
        return { created: true, ignored: false, lead, changes: ['x'] };
      }
      return { created: false, ignored: false, lead: null, changes: ['x'] };
    },
    leads: {
      findByPhone: (p) => leads.find((l) => l.phone === p),
      findByLid: (l) => leads.find((x) => x.lid === l),
      update: (id, patch) => Object.assign(leads.find((l) => l.id === id), patch),
      remove: (id) => void leads.splice(leads.findIndex((l) => l.id === id), 1),
    },
    convs: {
      newConv: (key, jid, name, now = NOW) => ({
        phone: key, jid, name: name || '', mode: 'bot', createdAt: now, botStartedAt: now, lastMessageAt: now, unread: 0,
        openingSent: false, pending: null, skipped: [], retries: {}, data: {}, messages: [],
      }),
      getOrCreate: (key, jid, name) => {
        if (st.has(key)) return { conv: st.get(key), created: false };
        st.set(key, d.convs.newConv(key, jid, name));
        return { conv: st.get(key), created: true };
      },
      get: (k) => st.get(k),
      remove: (k) => void st.delete(k),
      save() {},
      addMessage(c, by, text, ts = NOW) {
        const m = { id: 'm' + ++n, by, text, ts };
        c.messages.push(m);
        c.lastMessageAt = Math.max(c.lastMessageAt || 0, ts);
        return m;
      },
      list: () => [...st.values()].map((c) => ({ phone: c.phone })),
      totalUnread: () => [...st.values()].reduce((a, c) => a + c.unread, 0),
    },
  };
  if (ai) d.ai = ai;
  if (quota) d.quota = quota;
  if (plan) d.plan = plan;
  return { d, st, events, sleeps, ingests, sent, leads, ai, quota };
}
const fail = (retryable) => Object.assign(new Error('gagal'), { code: 'SEND_FAILED', retryable });
const botMsgs = (c) => c.messages.filter((m) => m.by === 'bot');

test('alur normal: pembuka + pertanyaan terkirim, commit berjalan', async () => {
  const t = mk(), r = await processIncoming(M(), t.d);
  assert.deepEqual(t.sent, ['Halo', 'Kakak tahu kami dari mana?']);
  assert.equal(r.conv.openingSent, true); assert.equal(r.conv.pending, 'referensi'); assert.equal(r.conv.unread, 1);
  assert.deepEqual(r.replies.map((m) => [m.status, m.replyKind, m.fieldId]), [['sent', 'opening', undefined], ['sent', 'question', 'referensi']]);
  assert.equal(t.ingests.length, 1); assert.equal(r.attention, null);
  assert.deepEqual(t.events.map((e) => e.type), ['message:new', 'unread']);
});
test('gagal di balasan ke-1: state tidak maju, failed, attention, berhenti', async () => {
  const t = mk({ send: async () => { throw fail(false); } }), r = await processIncoming(M(), t.d);
  assert.equal(r.conv.openingSent, false); assert.equal(r.conv.pending, null);
  assert.deepEqual(botMsgs(r.conv).map((m) => m.status), ['failed']);
  assert.equal(r.conv.attentionReason, 'send_failed'); assert.equal(r.conv.needsAttention, true);
  assert.ok(t.events.some((e) => e.type === 'conversation:attention' && e.payload.reason === 'send_failed'));
});
test('gagal di balasan ke-2: pembuka ter-commit, pertanyaan tidak', async () => {
  let n = 0;
  const t = mk({ send: async () => { if (++n === 2) throw fail(false); return { waId: 'w' + n }; } }), r = await processIncoming(M(), t.d);
  assert.equal(r.conv.openingSent, true); assert.equal(r.conv.pending, null);
  assert.deepEqual(botMsgs(r.conv).map((m) => m.status), ['sent', 'failed']);
});
test('retry sukses pada percobaan ke-2; retryable:false tanpa retry; retryable habis 3x', async () => {
  let n = 0;
  const a = mk({ send: async () => { if (++n === 1) throw fail(true); return { waId: 'w' }; } });
  await processIncoming(M(), a.d); assert.equal(a.sleeps[0], 1000); assert.equal(a.sleeps.length, 1);
  let c1 = 0;
  const b = mk({ send: async () => { c1++; throw fail(false); } });
  await processIncoming(M(), b.d); assert.equal(c1, 1); assert.deepEqual(b.sleeps, []);
  let c2 = 0;
  const c = mk({ send: async () => { c2++; throw fail(true); } });
  await processIncoming(M(), c.d); assert.equal(c2, 3); assert.deepEqual(c.sleeps, [1000, 3000]);
});
test('fromPhone: auto takeover, tanpa ingest dan tanpa kirim', async () => {
  const lead = { id: 'L', phone: '6281' }, t = mk({ leads: [lead] });
  const { conv } = t.d.convs.getOrCreate('6281', 'j', ''); conv.needsAttention = true;
  const r = await processIncoming(M({ fromMe: true, fromPhone: true, text: 'Halo kak' }), t.d);
  assert.equal(r.conv.mode, 'admin'); assert.equal(t.ingests.length, 0); assert.equal(t.sent.length, 0);
  assert.deepEqual(r.conv.messages.map((m) => [m.by, m.sender]), [['admin', 'HP'], ['system', undefined]]);
  assert.match(r.conv.messages[1].text, /Bot dinonaktifkan/);
  assert.equal(r.conv.needsAttention, false); assert.equal(lead.lastReplyAt, NOW);
});
test('reaksi/sistem -> null tanpa efek; tanpa key -> null', async () => {
  const t = mk();
  assert.equal(await processIncoming(M({ kind: 'reaction' }), t.d), null);
  assert.equal(await processIncoming(M({ kind: 'system' }), t.d), null);
  assert.equal(await processIncoming(M({ phone: null, lid: null }), t.d), null);
  assert.equal(t.st.size, 0); assert.equal(t.events.length, 0);
});
test('media: tercatat + attention media', async () => {
  const t = mk(), r = await processIncoming(M({ kind: 'image', text: '[Gambar]', mediaId: 'mid1' }), t.d);
  assert.equal(r.message.type, 'image'); assert.equal(r.message.mediaId, 'mid1');
  assert.equal(r.conv.attentionReason, 'media'); assert.equal(r.attention.reason, 'media');
});
test('customerCount tidak menghitung reaction/system', async () => {
  const t = mk(), { conv } = t.d.convs.getOrCreate('6281', 'j', '');
  conv.openingSent = true;
  for (const ty of ['reaction', 'system', 'text']) Object.assign(t.d.convs.addMessage(conv, 'customer', 'x'), { type: ty });
  await processIncoming(M(), t.d);
  assert.equal(t.ingests[0].customerCount, 2);
});
test('sinkron nama WhatsApp dan referensi ke lead (nama dari teks tidak dipakai)', async () => {
  const lead = { id: 'L', phone: '6281', name: 'Tanpa Nama', data: {} }, t = mk({ leads: [lead] });
  await processIncoming(M({ name: 'Andi Wijaya' }), t.d);
  assert.equal(lead.name, 'Andi Wijaya'); assert.equal(lead.waName, 'Andi Wijaya');
  const r = await processIncoming(M({ text: 'Facebook', name: 'Andi Wijaya' }), t.d);
  assert.equal(lead.referensi, 'Facebook'); assert.equal(lead.name, 'Andi Wijaya'); assert.equal(r.lead, lead);
  assert.equal(lead.phone, '6281');
});
test('rekonsiliasi lid->phone: pindah', async () => {
  const t = mk(), { conv: old } = t.d.convs.getOrCreate('lid1', 'j', 'Lid');
  t.d.convs.addMessage(old, 'customer', 'lama', 5); old.phoneKnown = false;
  const r = await processIncoming(M({ lid: 'lid1' }), t.d);
  assert.equal(t.st.has('lid1'), false); assert.equal(r.conv.phone, '6281'); assert.equal(r.conv.phoneKnown, true);
  assert.ok(r.conv.messages.some((m) => m.text === 'lama')); assert.equal(r.conv.lid, 'lid1');
});
test('rekonsiliasi lid+phone: gabung', async () => {
  const t = mk(), { conv: old } = t.d.convs.getOrCreate('lid1', 'j', '');
  const { conv: cur } = t.d.convs.getOrCreate('6281', 'j', '');
  Object.assign(old, { createdAt: 1, unread: 2, data: { a: 1, b: 'old' } }); t.d.convs.addMessage(old, 'customer', 'o', 5);
  Object.assign(cur, { createdAt: 9, unread: 1, data: { b: 'cur' } }); t.d.convs.addMessage(cur, 'customer', 'c', 3);
  const r = await processIncoming(M({ lid: 'lid1', ts: NOW }), t.d);
  assert.equal(t.st.has('lid1'), false); assert.equal(r.conv.createdAt, 1); assert.equal(r.conv.unread, 4);
  assert.deepEqual(r.conv.data, { a: 1, b: 'cur' });
  assert.deepEqual(r.conv.messages.slice(0, 2).map((m) => m.text), ['c', 'o']);
});
test('lead ganda: pertahankan yang lebih lama, salin field kosong', async () => {
  const a = { id: 'a', lid: 'lid1', createdAt: 2, name: 'Baru', tag: 't', note: '' };
  const b = { id: 'b', phone: '6281', createdAt: 1, name: '' };
  const t = mk({ leads: [a, b] });
  await processIncoming(M({ lid: 'lid1' }), t.d);
  assert.deepEqual(t.leads.map((l) => l.id), ['b']);
  assert.equal(b.name, 'Baru'); assert.equal(b.tag, 't'); assert.equal(b.phone, '6281'); assert.equal(b.lid, 'lid1');
});
test('onStatusUpdate tidak menurunkan status; failed -> attention', async () => {
  const t = mk(), r = await processIncoming(M(), t.d), [m1, m2] = r.replies;
  onStatusUpdate({ waId: m1.waId, status: 'read' }, t.d);
  onStatusUpdate({ waId: m1.waId, status: 'delivered' }, t.d);
  onStatusUpdate({ waId: m1.waId, status: 'sent' }, t.d);
  assert.equal(m1.status, 'read');
  onStatusUpdate({ waId: m2.waId, status: 'failed' }, t.d);
  assert.equal(m2.status, 'failed'); assert.equal(r.conv.attentionReason, 'send_failed');
  onStatusUpdate({ waId: 'tidak-ada', status: 'read' }, t.d);
});
test('resendMessage menerapkan efek keluaran; NOT_FAILED', async () => {
  let n = 0;
  const t = mk({ send: async () => { if (++n === 1) throw fail(false); return { waId: 'ok' + n }; } });
  const r = await processIncoming(M(), t.d), failed = r.replies[0];
  assert.equal(r.conv.openingSent, false);
  const m = await resendMessage(r.conv, failed.id, t.d.send, t.d);
  assert.equal(m.status, 'sent'); assert.equal(m.waId, 'ok2'); assert.equal(r.conv.openingSent, true);
  assert.equal(r.conv.needsAttention, false);
  await assert.rejects(() => resendMessage(r.conv, failed.id, t.d.send, t.d), { code: 'NOT_FAILED' });
});
// ---------- AI di pipeline (MOCK: bukan bukti berhasil dengan penyedia AI nyata) ----------
const SAI = {
  ...S, requiredFields: [], fallbackMessage: 'Diteruskan ke admin ya.',
  ai: { enabled: true, quotaExhaustedMessage: 'Kuota AI habis, pesan diteruskan ke admin.', errorMessage: 'Maaf, ada gangguan.' },
};
const aiSlot = () => ({ kind: 'ai', needsAi: true, text: '', commit: (c) => void (c.committed = [...(c.committed || []), 'ai']) });
const textSlot = (kind, text, fieldId) => () => ({
  kind, text, ...(fieldId ? { fieldId } : {}), commit: (c) => void (c.committed = [...(c.committed || []), kind]),
});
const planOf = (...slots) => () => ({ replies: slots.map((f) => f()), attention: null, ignored: false });
function fakeAi(results) {
  const calls = [], queue = [...results];
  return {
    calls,
    async reply(a) {
      calls.push(a);
      const r = queue.length > 1 ? queue.shift() : queue[0];
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(a) : r;
    },
  };
}
const fakeQuota = () => {
  const refunds = [];
  return { refunds, refund: (k) => void refunds.push(k) };
};
const okAi = (text = 'Jawaban AI.') => ({ ok: true, text, usage: { inputTokens: 10, outputTokens: 5 } });
const withFinalSaveFailOnce = (t) => {
  let fail = true;
  const orig = t.d.convs.save;
  t.d.convs.save = (c) => {
    if (c === undefined && fail) { fail = false; throw new Error('save akhir gagal'); } // save() tanpa argumen = langkah akhir
    return orig(c);
  };
};

// Langkah sinkron lead gagal sekali (setelah balasan terkirim, sebelum pesan handled): memicu percobaan ulang nyata.
const failLeadSyncOnce = (t) => {
  let fail = true;
  const upd = t.d.leads.update;
  t.d.leads.update = (id, patch) => {
    if ('waName' in patch && fail) { fail = false; throw new Error('lead rusak'); }
    return upd(id, patch);
  };
};

test('AI sukses: teks terkirim, tersimpan di message.aiText, kunci panggilan tanpa nomor/nama', async () => {
  const t = mk({ S: SAI, ai: fakeAi([okAi('Harga mulai 100 ribu.')]), quota: fakeQuota(), plan: planOf(aiSlot) });
  const r = await processIncoming(M({ waId: 'W-AI1', name: 'Budi', text: 'berapa harga?' }), t.d);
  assert.deepEqual(t.sent, ['Harga mulai 100 ribu.']);
  assert.equal(t.ai.calls.length, 1);
  const a = t.ai.calls[0];
  assert.equal(a.key, 'W-AI1');
  assert.equal(a.customerKey, customerKeyOf('6281'));
  assert.match(a.customerKey, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(a.msg).sort(), ['caption', 'id', 'kind', 'text', 'ts']);
  assert.equal(a.msg.text, 'berapa harga?');
  assert.ok(!JSON.stringify([a.key, a.customerKey, a.msg]).includes('6281')); // nomor tidak ikut
  assert.ok(!JSON.stringify([a.key, a.customerKey, a.msg]).includes('Budi')); // nama tidak ikut
  assert.equal(r.message.aiText, 'Harga mulai 100 ribu.');
  assert.deepEqual(r.replies.map((m) => [m.status, m.replyKind, m.text]), [['sent', 'ai', 'Harga mulai 100 ribu.']]);
  assert.deepEqual(r.conv.committed, ['ai']);
  assert.deepEqual(t.quota.refunds, []);
  assert.equal(r.conv.needsAttention, undefined);
});
test('urutan balasan: pembuka -> AI -> pertanyaan', async () => {
  const t = mk({ S: SAI, ai: fakeAi([okAi('Jawab AI')]), plan: planOf(textSlot('opening', 'Halo'), aiSlot, textSlot('question', 'Dari mana Kakak tahu kami?', 'referensi')) });
  const r = await processIncoming(M(), t.d);
  assert.deepEqual(t.sent, ['Halo', 'Jawab AI', 'Dari mana Kakak tahu kami?']);
  assert.deepEqual(r.conv.committed, ['opening', 'ai', 'question']);
  assert.equal(r.conv.pending, null); // plan palsu tidak mengubah pending; commit hanya yang dicatat
});
test('kuota habis: pesan tetap terkirim, attention ai_quota, tanpa teks AI', async () => {
  const t = mk({ S: SAI, ai: fakeAi([{ ok: false, reason: 'quota' }]), plan: planOf(aiSlot) });
  const r = await processIncoming(M(), t.d);
  assert.deepEqual(t.sent, [SAI.ai.quotaExhaustedMessage]);
  assert.deepEqual(r.replies.map((m) => [m.status, m.replyKind]), [['sent', 'quota']]);
  assert.equal(r.conv.needsAttention, true); assert.equal(r.conv.attentionReason, 'ai_quota');
  assert.equal(r.attention.reason, 'ai_quota');
  assert.ok(t.events.some((e) => e.type === 'conversation:attention' && e.payload.reason === 'ai_quota'));
  assert.equal(r.message.aiText, undefined);
});
test('AI galat (hasil error atau melempar): errorMessage, attention ai_error', async () => {
  for (const res of [{ ok: false, reason: 'error', detail: 'x' }, new Error('putus')]) {
    const t = mk({ S: SAI, ai: fakeAi([res]), plan: planOf(aiSlot) });
    const r = await processIncoming(M(), t.d);
    assert.deepEqual(t.sent, ['Maaf, ada gangguan.']);
    assert.equal(r.replies[0].replyKind, 'ai_error');
    assert.equal(r.conv.attentionReason, 'ai_error'); assert.equal(r.conv.needsAttention, true);
  }
});
test('AI galat tanpa errorMessage: pakai fallbackMessage (cooldown); keduanya kosong: tidak ada yang dikirim', async () => {
  const a = mk({ S: { ...SAI, ai: { ...SAI.ai, errorMessage: '' } }, ai: fakeAi([{ ok: false, reason: 'error' }]), plan: planOf(aiSlot) });
  const ra = await processIncoming(M(), a.d);
  assert.deepEqual(a.sent, ['Diteruskan ke admin ya.']);
  assert.equal(ra.replies[0].replyKind, 'fallback'); assert.equal(ra.conv.lastFallbackAt, NOW);
  assert.equal(ra.conv.attentionReason, 'ai_error');
  const b = mk({ S: { ...SAI, fallbackMessage: '', ai: { ...SAI.ai, errorMessage: '' } }, ai: fakeAi([{ ok: false, reason: 'error' }]), plan: planOf(aiSlot) });
  const rb = await processIncoming(M(), b.d);
  assert.deepEqual(b.sent, []); assert.equal(rb.replies.length, 0); assert.equal(rb.conv.attentionReason, 'ai_error');
  assert.equal(rb.message.handled, true);
});
test('kirim gagal setelah AI sukses: kuota dilepas, balasan failed, attention send_failed, teks tidak dianggap terpakai', async () => {
  const t = mk({ S: SAI, send: async () => { throw fail(false); }, ai: fakeAi([okAi('Teks AI')]), quota: fakeQuota(), plan: planOf(aiSlot) });
  const r = await processIncoming(M({ waId: 'W-F1' }), t.d);
  assert.deepEqual(t.quota.refunds, ['W-F1']);
  assert.deepEqual(r.replies.map((m) => [m.status, m.replyKind, m.text]), [['failed', 'ai', 'Teks AI']]);
  assert.equal(r.conv.attentionReason, 'send_failed');
  assert.equal(r.message.aiText, undefined); assert.equal(r.message.handled, true);
  assert.equal(r.conv.committed, undefined); // efek keluaran tidak berlaku untuk balasan gagal
});
test('kirim gagal pada balasan sebelum AI: AI tidak dipanggil (tidak memakai kuota)', async () => {
  const t = mk({ S: SAI, send: async () => { throw fail(false); }, ai: fakeAi([okAi()]), quota: fakeQuota(), plan: planOf(textSlot('opening', 'Halo'), aiSlot) });
  await processIncoming(M(), t.d);
  assert.equal(t.ai.calls.length, 0); assert.deepEqual(t.quota.refunds, []);
});
test('retry setelah AI sukses dan balasan terkirim (sinkron lead gagal / save akhir gagal): tanpa panggilan AI baru, tanpa balasan ganda', async () => {
  for (const mode of ['lead', 'save']) {
    const lead = { id: 'L', phone: '6281', name: 'X', data: {} };
    const t = mk({ S: SAI, leads: [lead], ai: fakeAi([okAi('Satu kali')]), quota: fakeQuota(), plan: planOf(aiSlot) });
    if (mode === 'lead') failLeadSyncOnce(t); else withFinalSaveFailOnce(t);
    const env = M({ waId: 'W-R1', name: 'Budi' });
    await assert.rejects(processIncoming(env, t.d), /lead rusak|save akhir gagal/);
    const r = await processIncoming({ ...env }, t.d);
    assert.equal(t.ai.calls.length, 1, mode); assert.deepEqual(t.sent, ['Satu kali'], mode);
    assert.equal(r.conv.messages.filter((m) => m.by === 'bot').length, 1, mode);
    assert.equal(r.message.handled, true, mode); assert.deepEqual(t.quota.refunds, [], mode);
  }
});
test('teks AI tersimpan dipakai ulang bila balasan belum tercatat (mis. restart): tanpa panggilan AI baru', async () => {
  const t = mk({ S: SAI, ai: fakeAi([okAi('Teks sama')]), quota: fakeQuota(), plan: planOf(aiSlot) });
  const env = M({ waId: 'W-R2' });
  const r1 = await processIncoming(env, t.d);
  // meniru restart sebelum balasan tercatat: pesan pelanggan membawa aiText tetapi belum handled dan tanpa balasan bot
  r1.conv.messages = r1.conv.messages.filter((m) => m.by !== 'bot');
  r1.message.handled = false;
  const r2 = await processIncoming({ ...env }, t.d);
  assert.equal(t.ai.calls.length, 1);
  assert.deepEqual(t.sent, ['Teks sama', 'Teks sama']);
  assert.equal(r2.message.aiText, 'Teks sama');
});
test('dua pesan berdekatan lewat antrean: AI dan kirim berurutan, tidak tumpang tindih', async () => {
  let active = 0, maxActive = 0;
  const ai = {
    calls: [],
    async reply(a) {
      ai.calls.push(a); active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return okAi('jawab ' + a.msg.text);
    },
  };
  const t = mk({ S: SAI, ai, plan: planOf(aiSlot) });
  await Promise.all([
    handleIncoming(M({ waId: 'Q1', text: 'satu' }), null, t.d),
    handleIncoming(M({ waId: 'Q2', text: 'dua' }), null, t.d),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(ai.calls.map((c) => c.key), ['Q1', 'Q2']);
  assert.deepEqual(t.sent, ['jawab satu', 'jawab dua']);
});
test('AI nonaktif (disabled/no_key/tanpa d.ai) = perilaku lama: fallbackMessage ber-cooldown, tanpa AI', async () => {
  for (const ai of [fakeAi([{ ok: false, reason: 'disabled' }]), fakeAi([{ ok: false, reason: 'no_key' }]), undefined]) {
    const t = mk({ S: SAI, ai, plan: planOf(aiSlot) });
    const r1 = await processIncoming(M({ waId: 'N1' }), t.d);
    assert.deepEqual(t.sent, ['Diteruskan ke admin ya.']);
    assert.equal(r1.replies[0].replyKind, 'fallback'); assert.equal(r1.conv.lastFallbackAt, NOW);
    assert.equal(r1.conv.attentionReason ?? null, null);
    const r2 = await processIncoming(M({ waId: 'N2' }), t.d); // masih dalam cooldown
    assert.equal(t.sent.length, 1); assert.equal(r2.replies.length, 0);
    assert.equal(r2.conv.attentionReason, 'no_reply');
  }
});
test('makeRealDeps menyediakan d.ai dan d.quota; AI mati tidak memuat modul dan tidak menyentuh kuota', async () => {
  const d = makeRealDeps(null);
  assert.equal(typeof d.ai.reply, 'function'); assert.equal(typeof d.quota.refund, 'function'); assert.equal(typeof d.plan, 'function');
  assert.deepEqual(await d.ai.reply({}), { ok: false, reason: 'disabled' }); // pengaturan nyata: ai.enabled tidak aktif
  await d.quota.refund('x'); // tanpa pemuatan: aman
});

// ---------- aturan bisnis: ctx, nama WA, referensi ----------
const ctxPlan = (seen, replies = []) => (conv, msg, S, now, ctx) => (seen.push(ctx), { replies: replies.map((f) => f()), attention: null, ignored: false });

test('ctx: nomor baru true (lead dibuat setelahnya); crm dari lead; nomor lama dan pesan berikutnya false', async () => {
  const seen = [];
  const t = mk({ createLead: true, plan: ctxPlan(seen) });
  await processIncoming(M({ waId: 'C1' }), t.d);
  await processIncoming(M({ waId: 'C2' }), t.d);
  assert.deepEqual(seen.map((c) => c.isNewNumber), [true, false]);
  assert.deepEqual(seen[0].crm, { referensi: '', name: 'Tanpa Nama', phone: '6281' });
  const seen2 = [];
  const u = mk({ leads: [{ id: 'L', phone: '6281', name: 'Ani', referensi: 'TikTok', data: {} }], plan: ctxPlan(seen2) });
  await processIncoming(M({ waId: 'C3' }), u.d);
  assert.equal(seen2[0].isNewNumber, false); assert.deepEqual(seen2[0].crm, { referensi: 'TikTok', name: 'Ani', phone: '6281' });
  const seen3 = [], v = mk({ createLead: true, plan: ctxPlan(seen3) });
  const { conv } = v.d.convs.getOrCreate('6281', 'j', ''); v.d.convs.addMessage(conv, 'customer', 'lama');
  await processIncoming(M({ waId: 'C4' }), v.d);
  assert.equal(seen3[0].isNewNumber, false); // sudah ada pesan pelanggan sebelumnya
});
test('ctx: isNewNumber tetap konsisten pada percobaan ulang walau lead sudah dibuat', async () => {
  const seen = [], t = mk({ createLead: true, plan: ctxPlan(seen) });
  failLeadSyncOnce(t);
  const env = M({ waId: 'C5', name: 'Budi' });
  await assert.rejects(processIncoming(env, t.d), /lead rusak/);
  await processIncoming({ ...env }, t.d);
  assert.deepEqual(seen.map((c) => c.isNewNumber), [true, true]);
});
test('nomor baru memakai nama WhatsApp (dirapikan); waName tersimpan', async () => {
  const t = mk({ createLead: true });
  const r = await processIncoming(M({ name: '  Budi \n  Santoso ' }), t.d);
  assert.equal(r.lead.waName, 'Budi Santoso'); assert.equal(r.lead.name, 'Budi Santoso');
});
test('nama yang sudah ada tidak ditimpa; waName terbaru tetap diperbarui', async () => {
  const lead = { id: 'L', phone: '6281', name: 'Pak Haji', data: {} }, t = mk({ leads: [lead] });
  await processIncoming(M({ name: 'Budi' }), t.d);
  assert.equal(lead.name, 'Pak Haji'); assert.equal(lead.waName, 'Budi');
  await processIncoming(M({ name: 'Andi' }), t.d);
  assert.equal(lead.name, 'Pak Haji'); assert.equal(lead.waName, 'Andi');
});
test('nama kosong atau "Tanpa Nama" diisi dari waName; pushName tak valid diabaikan', async () => {
  const a = { id: 'A', phone: '6281', name: '', data: {} }, ta = mk({ S: SAI, leads: [a] });
  await processIncoming(M({ name: 'Citra' }), ta.d);
  assert.equal(a.name, 'Citra');
  const b = { id: 'B', phone: '6281', name: 'Tanpa Nama', data: {} }, tb = mk({ S: SAI, leads: [b] });
  await processIncoming(M({ name: 'Dewi' }), tb.d);
  assert.equal(b.name, 'Dewi');
  const c = { id: 'C', phone: '6281', name: 'Tanpa Nama', data: {} }, tc = mk({ S: SAI, leads: [c] });
  for (const bad of ['', 'x', 'a'.repeat(101), null, undefined, 42]) await processIncoming(M({ name: bad }), tc.d);
  assert.equal(c.waName, undefined); assert.equal(c.name, 'Tanpa Nama');
  assert.equal(cleanWaName('  Eko\t Putra  '), 'Eko Putra'); assert.equal(cleanWaName('a'.repeat(100)).length, 100);
});
test('LID tanpa nomor: lead.phone tetap kosong walau teks memuat nomor', async () => {
  const t = mk({ createLead: true });
  const r = await processIncoming(M({ phone: null, lid: 'lid9', jid: 'lid9@lid', name: 'Sari', text: 'nomor saya 6281999888777' }), t.d);
  assert.equal(r.conv.phone, 'lid9'); assert.equal(r.lead.phone, ''); assert.equal(r.lead.lid, 'lid9');
  assert.equal(r.lead.waName, 'Sari'); assert.equal(r.lead.name, 'Sari');
});
test('jawaban referensi tersimpan ke lead (dipotong 50); tanpa jawaban tidak mengubah referensi', async () => {
  const lead = { id: 'L', phone: '6281', name: 'X', data: {} }, t = mk({ leads: [lead] });
  await processIncoming(M({ waId: 'RF0' }), t.d);
  assert.equal(lead.referensi, undefined);
  t.d.plan = () => ({ replies: [], attention: null, referensi: '  ' + 'Instagram '.repeat(8) });
  await processIncoming(M({ waId: 'RF1' }), t.d);
  assert.equal(lead.referensi.length, 50); assert.match(lead.referensi, /^Instagram/);
});
test('retry tidak mengulang pertanyaan referensi dan referensi tetap tersimpan setelah sinkron lead gagal', async () => {
  const lead = { id: 'L', phone: '6281', name: 'X', data: {} };
  let plans = 0, failRef = true;
  const t = mk({
    leads: [lead],
    plan: () => (plans++, { replies: [textSlot('question', 'Dari mana Kakak tahu kami?', 'referensi')()], attention: null, referensi: 'Instagram' }),
  });
  const upd = t.d.leads.update;
  t.d.leads.update = (id, patch) => {
    if ('referensi' in patch && failRef) { failRef = false; throw new Error('lead rusak'); }
    return upd(id, patch);
  };
  const env = M({ waId: 'RF2' });
  await assert.rejects(processIncoming(env, t.d), /lead rusak/);
  const r = await processIncoming({ ...env }, t.d);
  assert.deepEqual(t.sent, ['Dari mana Kakak tahu kami?']); assert.equal(plans, 1);
  assert.equal(lead.referensi, 'Instagram'); assert.equal(r.message.handled, true);
});

// ---------- Bot Tester: jalur sama, kuota, simulate.aiFail ----------
const TP = '628130000009';
function testerWith({ results, S: Sx = SAI, plan = planOf(aiSlot) } = {}) {
  const quota = { used: 0, refunds: [], refund(k) { quota.refunds.push(k); quota.used--; } };
  const ai = fakeAi(results || [okAi('Jawaban tester')]);
  const base = ai.reply.bind(ai);
  ai.reply = async (a) => { const r = await base(a); if (r.ok) quota.used++; return r; }; // tiruan reserve+commit
  return { tester: createTester({ settings: { get: () => Sx }, ai, quota, plan }), ai, quota };
}
test('tester memakai jalur pipeline yang sama dan memakai kuota (asumsi 6)', async () => {
  const { tester, ai, quota } = testerWith();
  const r1 = await tester.testerSend(TP, 'tanya produk');
  assert.deepEqual(r1.replies.map((m) => [m.status, m.replyKind, m.text]), [['sent', 'ai', 'Jawaban tester']]);
  assert.match(ai.calls[0].key, /^tw\d+$/); assert.equal(ai.calls[0].customerKey, customerKeyOf(TP));
  assert.equal(quota.used, 1);
  await tester.testerSend(TP, 'tanya lagi');
  assert.equal(quota.used, 2);
});
test('tester: simulate.sendFail setelah AI sukses melepas kuota', async () => {
  const { tester, quota } = testerWith();
  const r = await tester.testerSend(TP, 'tanya', { simulate: { sendFail: true } });
  assert.equal(r.replies[0].status, 'failed'); assert.equal(quota.refunds.length, 1); assert.equal(quota.used, 0);
  assert.equal(r.attentionReason, 'send_failed');
});
test('tester: simulate.aiFail memaksa galat AI tanpa memanggil AI dan tanpa kuota', async () => {
  const { tester, ai, quota } = testerWith();
  const r = await tester.testerSend(TP, 'tanya', { simulate: { aiFail: true } });
  assert.equal(ai.calls.length, 0); assert.equal(quota.used, 0);
  assert.deepEqual(r.replies.map((m) => [m.status, m.replyKind, m.text]), [['sent', 'ai_error', 'Maaf, ada gangguan.']]);
  assert.equal(r.needsAttention, true); assert.equal(r.attentionReason, 'ai_error');
  const r2 = await tester.testerSend(TP, 'tanya lagi'); // simulasi tidak menempel ke pesan berikutnya
  assert.equal(ai.calls.length, 1); assert.equal(r2.replies[0].replyKind, 'ai');
});
test('tester: kuota habis -> pesan tetap + attention ai_quota', async () => {
  const { tester } = testerWith({ results: [{ ok: false, reason: 'quota' }] });
  const r = await tester.testerSend(TP, 'tanya');
  assert.equal(r.replies[0].text, SAI.ai.quotaExhaustedMessage); assert.equal(r.attentionReason, 'ai_quota');
});
test('tester tanpa AI aktif = perilaku lama (tidak memuat modul AI)', async () => {
  const tester = createTester({ settings: { get: () => ({ ...SAI, ai: { enabled: false } }) }, plan: planOf(aiSlot) });
  const r = await tester.testerSend('628130000010', 'tanya');
  assert.deepEqual(r.replies.map((m) => m.replyKind), ['fallback']);
});
