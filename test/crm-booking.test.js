import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDay, parseTime, validate, parseReply } from '../src/crm-form.js';
import { processIncoming } from '../src/bot-pipeline.js';
import { AGENT_DEFAULTS } from '../src/crm-agent.js';

const NOW = 1_700_000_000_000; // 2023-11-14 WIB
test('parseDay/parseTime/validate booking', () => {
  assert.equal(parseDay('29/11/2023', NOW), '2023-11-29');
  assert.equal(parseDay('29 Nov 2023', NOW), '2023-11-29');
  assert.equal(parseDay('31/02/2023', NOW), null);
  assert.equal(parseTime('14.00'), '14:00'); assert.equal(parseTime('jam 9'), '09:00'); assert.equal(parseTime('25:00'), null);
  assert.equal(validate('booking_day', '01/11/2023', NOW).ok, false, 'lampau ditolak');
  assert.equal(validate('booking_day', '20/11/2023', NOW).value, '2023-11-20');
  const sv = { services: ['Pijat Refleksi', 'Fisioterapi'] };
  assert.equal(validate('booking_services', 'fisioterapi, pijat refleksi', NOW, sv).value, 'Fisioterapi, Pijat Refleksi');
  assert.match(validate('booking_services', 'cuci mobil', NOW, sv).why, /Pilihan: Pijat Refleksi/);
  assert.deepEqual(parseReply('Layanan: Fisioterapi\nTanggal booking: 20/11/2023\nJam booking: 14:00', ['booking_services', 'booking_day', 'booking_time'], NOW, sv).values,
    { booking_services: 'Fisioterapi', booking_day: '2023-11-20', booking_time: '14:00' });
});

const S = {
  botEnabled: true, botName: 'Sari', adminName: 'Dewi', openingMessage: 'Halo', fallbackMessage: '', handoverMessage: 'x', completionMessage: 'ok',
  botDurationMinutes: 0, staleMinutes: 10, fallbackCooldownMinutes: 30, autoTakeoverOnPhoneReply: true, slangMap: {}, intents: [], requiredFields: [],
  crmAgent: { ...AGENT_DEFAULTS, enabled: true },
};
function mk(slotImpl) {
  const st = new Map(), sent = [], leads = [{ id: 'L1', phone: '6281', name: 'WA', waName: 'WA', status: 'Hot Leads', hotStage: 'Follow Up', data: {} }];
  let n = 0;
  const d = {
    now: () => NOW, sleep: async () => {}, send: async (j, t) => (sent.push(t), { waId: 'o' + sent.length }),
    settings: { get: () => S }, emit() {},
    acesioForm: async () => ({ ok: true, exists: true, values: { name: 'Budi', gender: 'L', birth_date: '01/01/1990', occupation: 'Guru', domicile: 'Bekasi', reference: 'IG' }, missing: [] }),
    acesioServices: async () => ['Pijat Refleksi', 'Fisioterapi'],
    acesioSlots: slotImpl,
    ingest: () => ({ created: false, ignored: false, lead: null, changes: [] }),
    leads: { findByPhone: (p) => leads.find((l) => l.phone === p), findByLid: () => null, update: (id, patch) => Object.assign(leads.find((l) => l.id === id), patch), remove() {} },
    convs: {
      newConv: (key, jid, name) => ({ phone: key, jid, name: name || '', mode: 'bot', createdAt: NOW, botStartedAt: NOW, lastMessageAt: NOW, unread: 0, openingSent: true, pending: null, skipped: [], retries: {}, data: {}, messages: [] }),
      getOrCreate(k, j, nm) { if (st.has(k)) return { conv: st.get(k), created: false }; st.set(k, d.convs.newConv(k, j, nm)); return { conv: st.get(k), created: true }; },
      get: (k) => st.get(k), remove() {}, save() {},
      addMessage(c, by, text, ts = NOW) { const m = { id: 'm' + ++n, by, text, ts }; c.messages.push(m); return m; },
      list: () => [], totalUnread: () => 0,
    },
  };
  return { d, sent, leads };
}
let seq = 0;
const M = (text) => ({ waId: 'w' + ++seq, jid: '6281@s.whatsapp.net', phone: '6281', lid: null, name: 'WA', ts: NOW, kind: 'text', text, caption: '', mediaId: null, mediaError: null, fromMe: false, fromPhone: false, source: {} });
const slots = async (day) => ({ day, step: 60, slots: [{ time: '09:00', available: false }, { time: '10:00', available: true }, { time: '11:00', available: true }] });

test('booking: jam penuh ditolak dengan alternatif, jam tersedia diterima dan masuk lead.data', async () => {
  const t = mk(slots);
  await processIncoming(M('mau booking'), t.d);
  assert.match(t.sent.find((x) => /Layanan/.test(x)), /pilih: Pijat Refleksi, Fisioterapi/);
  let r = await processIncoming(M('Layanan: Fisioterapi\nTanggal booking: 20/11/2023\nJam booking: 09:00'), t.d);
  assert.equal(r.conv.mode, 'bot');
  assert.match(t.sent.at(-1), /sudah penuh.*10:00, 11:00/s);
  r = await processIncoming(M('10:00'), t.d);
  assert.equal(r.conv.form.stage, 'done');
  assert.equal(r.conv.form.dpState, 'awaiting');
  assert.equal(t.leads[0].data.booking_day, '2023-11-20');
  assert.equal(t.leads[0].data.booking_time, '10:00');
  assert.equal(t.leads[0].data.booking_services, 'Fisioterapi');
});

test('booking: Acesio tidak terjangkau -> diterima, ditandai perlu dicek admin', async () => {
  const t = mk(async () => null);
  await processIncoming(M('mau booking'), t.d);
  const r = await processIncoming(M('Layanan: Fisioterapi\nTanggal booking: 20/11/2023\nJam booking: 09:00'), t.d);
  assert.equal(r.conv.form.stage, 'done');
  assert.match(r.conv.attentionReason, /belum diverifikasi/);
});

test('DP: info rekening + gambar QRIS terkirim; QRIS tidak bisa dikirim (Convia/Meta) -> admin diminta kirim manual', async () => {
  const run = async (sendQris) => {
    const t = mk(slots);
    t.d.settings = { get: () => ({ ...S, crmAgent: { ...S.crmAgent, askBooking: false, bankAccounts: 'BCA 123 a.n. Klinik', dpAmount: 'Rp 100.000' } }) };
    t.d.qris = () => true; t.d.sendQris = sendQris;
    await processIncoming(M('mau booking'), t.d);
    return t;
  };
  let sentImg = 0;
  const ok = await run(async () => { sentImg++; return { waId: 'q' }; });
  assert.equal(sentImg, 1);
  assert.match(ok.sent.at(-1), /Rp 100\.000/); assert.match(ok.sent.at(-1), /BCA 123/);
  assert.ok(!ok.d.convs.get('6281').needsAttention, String(ok.d.convs.get('6281').attentionReason));
  const bad = await run(async () => { const e = new Error('x'); e.code = 'NOT_SUPPORTED'; throw e; });
  assert.equal(bad.d.convs.get('6281').needsAttention, true);
  assert.match(bad.d.convs.get('6281').attentionReason, /QRIS/);
});
