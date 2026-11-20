import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, parseBirth, validate, formMessage, FORBIDDEN, monthLabel } from '../src/crm-form.js';
import { processIncoming } from '../src/bot-pipeline.js';
import { due } from '../src/crm-followup.js';
import { AGENT_DEFAULTS } from '../src/crm-agent.js';

const NOW = 1_700_000_000_000;

test('parseReply: baris berlabel, satu kolom, urut tanpa label', () => {
  const miss = ['name', 'gender', 'birth_date', 'occupation', 'domicile'];
  const r = parseReply('Nama: Budi Santoso\nJenis kelamin (Laki-laki / Perempuan): pria\nTanggal lahir: 5 Maret 1990\nPekerjaan: Guru\nDomisili: Bekasi', miss, NOW);
  assert.deepEqual(r.values, { name: 'Budi Santoso', gender: 'L', birth_date: '05/03/1990', occupation: 'Guru', domicile: 'Bekasi' });
  assert.deepEqual(parseReply('Perempuan', ['gender'], NOW).values, { gender: 'P' });
  assert.deepEqual(parseReply('Ani\nP\n1/2/1995', ['name', 'gender', 'birth_date'], NOW).values, { name: 'Ani', gender: 'P', birth_date: '01/02/1995' });
  const bad = parseReply('Tanggal lahir: 31/02/1990', ['birth_date'], NOW);
  assert.equal(bad.touched, true); assert.match(bad.errors.birth_date, /contoh 31\/12\/1990/);
  assert.equal(parseReply('berapa DP nya?', miss, NOW).touched, false, 'pertanyaan biasa bukan jawaban form');
  assert.deepEqual(parseReply('Nama: Budi', ['gender'], NOW).values, {}, 'hanya kolom yang masih kosong');
});

test('validasi tanggal/nama dan larangan kolom', () => {
  assert.equal(parseBirth('12-03-1990', NOW), '12/03/1990');
  assert.equal(parseBirth('2090-01-01', NOW), null);
  assert.equal(validate('name', 'R2D2', NOW).ok, false);
  for (const f of ['rm_no', 'soap', 'medical_note']) assert.ok(FORBIDDEN.includes(f));
  const t = formMessage(['name', 'gender']);
  assert.ok(!/rm|soap/i.test(t));
  assert.match(monthLabel(Date.UTC(2026, 10, 19, 5)), /^November 2026$/);
});

// ---- alur pipeline ----
const S = {
  botEnabled: true, botName: 'Sari', adminName: 'Dewi', openingMessage: 'Halo', fallbackMessage: '', handoverMessage: 'Dilanjutkan Dewi',
  completionMessage: 'Terima kasih', botDurationMinutes: 0, staleMinutes: 10, fallbackCooldownMinutes: 30, autoTakeoverOnPhoneReply: true,
  slangMap: {}, intents: [], requiredFields: [],
  crmAgent: { ...AGENT_DEFAULTS, enabled: true, askBooking: false },
};
function mk(form) {
  const st = new Map(), sent = [], leads = [{ id: 'L1', phone: '6281', name: 'Nama WA', waName: 'Nama WA', status: 'Hot Leads', hotStage: 'Follow Up', data: {} }];
  let n = 0;
  const d = {
    now: () => NOW, sleep: async () => {}, send: async (j, t) => (sent.push(t), { waId: 'o' + sent.length }),
    settings: { get: () => S }, emit() {}, acesioForm: async () => form,
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
  return { d, sent, leads, st };
}
let seq = 0;
const M = (text) => ({ waId: 'w' + ++seq, jid: '6281@s.whatsapp.net', phone: '6281', lid: null, name: 'Nama WA', ts: NOW, kind: 'text', text, caption: '', mediaId: null, mediaError: null, fromMe: false, fromPhone: false, source: {} });
const NEW = { ok: true, exists: false, values: {}, missing: ['name', 'gender', 'birth_date', 'occupation', 'domicile'] };

test('lead Hot baru: bot kirim formulir, jawab bertahap, lengkap -> admin, nama form menimpa nama WA', async () => {
  const t = mk(NEW);
  await processIncoming(M('mau booking dong'), t.d);
  const form = t.sent.find((x) => /Nama:/.test(x));
  assert.ok(form, 'formulir terkirim');
  assert.match(form, /Tahu kami dari mana/);
  assert.ok(!/RM|SOAP/i.test(form));
  let r = await processIncoming(M('Nama: Budi Santoso\nJenis kelamin: pria\nTanggal lahir: 05/03/1990'), t.d);
  assert.equal(r.conv.mode, 'bot');
  assert.match(t.sent.at(-1), /masih kurang/i);
  assert.match(t.sent.at(-1), /Pekerjaan/);
  r = await processIncoming(M('Pekerjaan: Guru\nDomisili: Bekasi\nTahu kami dari mana: Instagram'), t.d);
  assert.equal(r.conv.mode, 'admin', 'dialihkan ke admin setelah form lengkap');
  assert.match(t.sent.at(-1), /DP/);
  const lead = t.leads[0];
  assert.equal(lead.name, 'Budi Santoso');
  assert.equal(lead.waName, 'Nama WA', 'nama WA tetap tersimpan');
  assert.equal(lead.data.occupation, 'Guru'); assert.equal(lead.data.gender, 'L');
  assert.equal(lead.data.birth_date, '05/03/1990'); assert.equal(lead.data.month, 'November 2023');
  assert.equal(lead.referensi, 'Instagram');
  assert.equal(r.conv.needsAttention, true);
  assert.equal(r.conv.form.stage, 'done');
});

test('customer lama: hanya kolom kosong yang ditanya, nama dari Acesio dipakai', async () => {
  const t = mk({ ok: true, exists: true, values: { name: 'Dewi Lama', gender: 'P', occupation: 'Dokter', reference: 'Instagram' }, missing: ['birth_date', 'domicile'] });
  await processIncoming(M('halo'), t.d);
  const form = t.sent.find((x) => /Tanggal lahir/.test(x));
  assert.ok(form && !/Pekerjaan|Nama:|Jenis kelamin/.test(form) && !/dari mana/.test(form));
  const r = await processIncoming(M('Tanggal lahir: 1/2/1985\nDomisili: Depok'), t.d);
  assert.equal(r.conv.mode, 'admin');
  assert.equal(t.leads[0].name, 'Dewi Lama');
  assert.equal(t.leads[0].data.month, undefined, 'bulan customer lama tidak diubah');
});

test('pertanyaan di tengah formulir dijawab biasa dan formulir tetap menunggu', async () => {
  const t = mk(NEW);
  await processIncoming(M('halo'), t.d);
  const before = t.sent.length;
  const r = await processIncoming(M('berapa dp nya?'), t.d);
  assert.equal(r.conv.form.stage, 'collecting'); assert.equal(r.conv.mode, 'bot');
  assert.equal(t.sent.slice(before).some((x) => /masih kurang/.test(x)), false);
});

test('agen mati atau lead belum Hot: tidak ada formulir', async () => {
  const off = mk(NEW); off.d.settings = { get: () => ({ ...S, crmAgent: { ...AGENT_DEFAULTS, enabled: false } }) };
  await processIncoming(M('halo'), off.d);
  assert.equal(off.sent.some((x) => /Nama:/.test(x)), false);
  const warm = mk(NEW); warm.leads[0].status = 'Warm Leads';
  await processIncoming(M('halo'), warm.d);
  assert.equal(warm.sent.some((x) => /Nama:/.test(x)), false);
});

test('Acesio tidak terjangkau: formulir lengkap dipakai (bukan galat)', async () => {
  const t = mk({ ok: false, exists: false, values: {}, missing: ['name', 'gender', 'birth_date', 'occupation', 'domicile'] });
  await processIncoming(M('halo'), t.d);
  assert.ok(t.sent.some((x) => /Nama:/.test(x)));
});

// ---- follow up ----
const conv = (o = {}) => ({ phone: '6281', jid: 'j', mode: 'admin', messages: [{ by: 'customer', ts: NOW - 3 * 3600_000 - 60_000 }], form: { stage: 'done', completedAt: NOW - 3 * 3600_000, followUpsSent: 0 }, ...o });
const lead = (o = {}) => ({ hotStage: 'Follow Up', ...o });
const run = (c, l, S2 = S, now = NOW) => due({ convs: [c], findLead: () => l, S: S2, now });

test('follow up: jatuh tempo 3 jam, lalu 1 hari, maksimal 2', () => {
  assert.equal(run(conv(), lead()).length, 1);
  assert.equal(run(conv(), lead(), S, NOW - 3600_000).length, 0, 'belum waktunya');
  const c2 = conv({ form: { stage: 'done', completedAt: NOW - 25 * 3600_000, followUpsSent: 1 }, messages: [{ by: 'customer', ts: NOW - 25 * 3600_000 - 1 }] });
  assert.equal(run(c2, lead()).length, 1);
  c2.form.followUpsSent = 2;
  assert.equal(run(c2, lead()).length, 0);
});

test('follow up berhenti: DP lunas (Won), Lost, customer membalas, agen mati', () => {
  assert.equal(run(conv(), lead({ hotStage: 'Won' })).length, 0);
  assert.equal(run(conv(), lead({ hotStage: 'Lost' })).length, 0);
  const replied = conv(); replied.messages.push({ by: 'customer', ts: NOW - 1000 });
  assert.equal(run(replied, lead()).length, 0);
  assert.equal(run(conv(), lead(), { ...S, crmAgent: { ...AGENT_DEFAULTS, enabled: false } }).length, 0);
});

test('Convia: lewat 24 jam dari pesan customer -> tidak dikirim, ditandai', () => {
  const c = conv({ form: { stage: 'done', completedAt: NOW - 25 * 3600_000, followUpsSent: 1 }, messages: [{ by: 'customer', ts: NOW - 26 * 3600_000 }] });
  const r = run(c, lead(), { ...S, waProvider: 'convia' });
  assert.equal(r[0].blocked, 'convia_window');
  assert.equal(run(c, lead(), { ...S, waProvider: 'baileys' })[0].blocked, null);
});

test('Pengaturan: patch Agen CRM valid dan menolak jeda tidak masuk akal', async () => {
  const { buildSettingsPatch } = await import('../public/assets/js/pages/pengaturan.js');
  const base = { brandName: 'A', botName: 'B', adminName: 'C', retentionDays: '0', botDurationMinutes: '0', adminAutoReturnMinutes: '0', staleMinutes: '10', fallbackCooldownMinutes: '30', sendRateLimitPerMinute: '20', attentionMinutes: '30' };
  const ok = buildSettingsPatch({ ...base, crmAgentForm: '1', crmEnabled: 'on', crmAskBooking: '', crmAutoSubmit: '', crmFormIntro: 'Isi ya', crmDoneMessage: 'Selesai', crmDelay1: '180', crmDelay2: '1440', crmFollow1: 'f1', crmFollow2: 'f2' }, {});
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.patch.crmAgent, { enabled: true, askBooking: false, autoSubmit: false, formIntro: 'Isi ya', doneMessage: 'Selesai', followUpDelaysMinutes: [180, 1440], followUpMessages: ['f1', 'f2'] });
  const bad = buildSettingsPatch({ ...base, crmAgentForm: '1', crmDelay1: '1', crmDelay2: 'x' }, {});
  assert.equal(bad.errors.filter((e) => /^crmDelay/.test(e.field)).length, 2);
  assert.equal('crmAgent' in buildSettingsPatch(base, {}).patch, false, 'form lain tidak menyentuh agen');
});
