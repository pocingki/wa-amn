import test from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, createRunner } from '../src/crm-followup.js';
import { AGENT_DEFAULTS } from '../src/crm-agent.js';

const S = { botName: 'Sari', adminName: 'Dewi', waProvider: 'baileys', crmAgent: { ...AGENT_DEFAULTS, enabled: true } };
const at = (iso) => Date.parse(iso + '+07:00');
const conv = (o = {}) => ({ phone: '6281', jid: 'j', name: 'Budi', mode: 'admin', messages: [{ by: 'customer', ts: at('2026-11-20T10:00:00') }], ...o });
const won = (o = {}) => ({ hotStage: 'Won', data: { booking_day: '2026-11-25', booking_time: '14:00', booking_services: 'Fisioterapi' }, ...o });
const run = (c, l, iso, S2 = S) => dueReminders({ convs: [c], findLead: () => l, S: S2, now: at(iso) });

test('pengingat H-1 pukul 09:00 dan hari H pukul 07:00, masing-masing sekali, isi sesuai booking', () => {
  assert.equal(run(conv(), won(), '2026-11-24T08:59:00').length, 0);
  const h1 = run(conv(), won(), '2026-11-24T09:00:00');
  assert.equal(h1.length, 1); assert.equal(h1[0].kind, 'h1');
  assert.match(h1[0].text, /Fisioterapi/); assert.match(h1[0].text, /14:00/); assert.match(h1[0].text, /Rabu, 25 November 2026/); assert.match(h1[0].text, /Budi/);
  assert.equal(run(conv({ reminders: { day: '2026-11-25', h1: 1 } }), won(), '2026-11-24T20:00:00').length, 0, 'tidak diulang');
  const h0 = run(conv({ reminders: { day: '2026-11-25', h1: 1 } }), won(), '2026-11-25T07:00:00');
  assert.deepEqual(h0.map((x) => x.kind), ['h0']);
  assert.equal(run(conv({ reminders: { day: '2026-11-25', h1: 1 } }), won(), '2026-11-25T14:30:00').length, 0, 'booking sudah lewat');
});

test('pengingat hanya untuk DP lunas (Won), bukan ditolak Acesio, agen & pengingat aktif', () => {
  assert.equal(run(conv(), won({ hotStage: 'Follow Up' }), '2026-11-24T10:00:00').length, 0);
  assert.equal(run(conv(), won({ acesioDecision: 'rejected' }), '2026-11-24T10:00:00').length, 0);
  assert.equal(run(conv(), won({ data: {} }), '2026-11-24T10:00:00').length, 0, 'tanpa data booking');
  assert.equal(run(conv(), won(), '2026-11-24T10:00:00', { ...S, crmAgent: { ...S.crmAgent, remindersEnabled: false } }).length, 0);
  assert.equal(run(conv(), won(), '2026-11-24T10:00:00', { ...S, crmAgent: { ...S.crmAgent, enabled: false } }).length, 0);
});

test('booking diubah admin ke tanggal lain: pengingat dihitung ulang; booking dibuat sesudah jam H-1: langsung terkirim', () => {
  const c = conv({ reminders: { day: '2026-11-25', h1: 1, h0: 1 } });
  assert.equal(run(c, won({ data: { booking_day: '2026-11-27', booking_time: '10:00' } }), '2026-11-26T12:00:00')[0].kind, 'h1');
});

test('Convia lewat 24 jam: tidak dikirim, ditandai perlu perhatian sekali; Baileys dikirim dan dicatat', async () => {
  const sent = [], emitted = [];
  const mk = (provider) => {
    const c = conv();
    const convs = { _all: () => [c], addMessage: (cc, by, text, ts) => { const m = { by, text, ts }; cc.messages.push(m); return m; }, save() {} };
    const now = at('2026-11-24T09:05:00');
    const r = createRunner({ convs, findLead: () => won(), getSettings: () => ({ ...S, waProvider: provider }), send: async (j, t) => (sent.push(t), { waId: 'w' }), now: () => now, emit: (...a) => emitted.push(a) });
    return { c, r };
  };
  const a = mk('convia'); await a.r.tick(); await a.r.tick();
  assert.equal(sent.length, 0); assert.equal(a.c.needsAttention, true); assert.match(a.c.attentionReason, /24 jam/); assert.equal(a.c.reminders.h1 > 0, true);
  const b = mk('baileys'); await b.r.tick(); await b.r.tick();
  assert.equal(sent.length, 1, 'terkirim sekali walau tick berulang'); assert.equal(b.c.reminders.day, '2026-11-25');
});
