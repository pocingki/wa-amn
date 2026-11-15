// Uji fasad bot, mesin balasan (decide) dan Bot Tester. Intent diganti balasan AI (ditandai needsAi oleh plan,
// diselesaikan pipeline/B6); tanpa AI bot memakai fallback ber-cooldown. Satu pertanyaan data wajib: referensi.
// Balasan lewat jalur pipeline yang sama dengan WhatsApp asli.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-bot-'));
const kw = JSON.parse(fs.readFileSync('config/keywords.json', 'utf8'));
process.env.KEYWORDS_FILE = path.join(process.env.DATA_DIR, 'keywords.test.json');
fs.writeFileSync(process.env.KEYWORDS_FILE, JSON.stringify({ ...kw, leadRule: 'platform' }));

const bot = await import('../src/bot.js');
const { createTester } = await import('../src/bot-tester.js');
const C = await import('../src/conversations.js');

const S = {
  botEnabled: true, botName: 'Sari', adminName: 'Dewi', openingMessage: 'Halo {nama}, saya {bot}.',
  fallbackMessage: 'Admin akan segera membalas.', handoverMessage: 'Dilanjutkan {admin}.', completionMessage: 'Terima kasih.',
  botDurationMinutes: 0, staleMinutes: 10, fallbackCooldownMinutes: 30, autoTakeoverOnPhoneReply: true,
  requiredFields: [{ id: 'referensi', label: 'Referensi', question: 'Boleh tahu, Kakak mengetahui kami dari mana?', enabled: true, type: 'text' }],
};
let cur = S; // pengaturan tester bisa diganti per tes
const tester = () => createTester({ settings: { get: () => cur } });
const mkConv = (name = 'Budi') => C.newConv('628111', '628111@s.whatsapp.net', name, 1000);
const A = '6281200000001';

test('fasad mengekspor semua nama', () => {
  for (const n of ['fill', 'remainingMs', 'setMode', 'decide', 'normPhone', 'handleIncoming', 'onStatusUpdate', 'resendMessage',
    'testerView', 'testerSend', 'testerReset', 'testerMode', 'testerAdvance', 'testerPhoneReply', 'testerTransactionDone', 'view'])
    assert.equal(typeof bot[n], 'function', n);
  assert.equal(bot.matchIntent, undefined); // intent sudah dihapus dari fasad
  assert.equal(bot.normPhone('0812-0000-0003'), '6281200000003');
  assert.equal(bot.normPhone('12'), null);
});
test('view: awaitingReply dan remainingMs', () => {
  const c = mkConv(); C.addMessage(c, 'customer', 'hai');
  assert.equal(bot.view(c).awaitingReply, true);
  C.addMessage(c, 'bot', 'ya');
  assert.equal(bot.view(c).awaitingReply, false);
});
test('decide: pembuka + pertanyaan referensi (tanpa AI, fallback ditahan); jawaban referensi; penutup sekali', () => {
  const c = mkConv();
  const r = bot.decide(c, 'Halo, berapa harga?', S, 2000);
  assert.deepEqual(r, ['Halo Budi, saya Sari.', 'Boleh tahu, Kakak mengetahui kami dari mana?']);
  assert.deepEqual(bot.decide(c, 'Instagram', S, 3000), ['Terima kasih.']);
  assert.equal(c.data.referensi, 'Instagram');
  // referensi sudah dijawab: tidak ditanya lagi, penutup tidak berulang; fallback ber-cooldown tetap jalan
  assert.deepEqual(bot.decide(c, 'xyz', S, 1_700_000_000_000), ['Admin akan segera membalas.']);
});
test('decide: balasan AI (needsAi) dilewati dan tidak mengubah state keluaran', () => {
  const c = mkConv(); c.openingSent = true;
  const s = { ...S, ai: { enabled: true } };
  assert.deepEqual(bot.decide(c, 'Berapa harganya?', s, 2000), ['Boleh tahu, Kakak mengetahui kami dari mana?']);
  assert.ok(!c.lastFallbackAt); // commit AI baru dijalankan pipeline setelah balasan terkirim
});
test('durasi habis -> sesi baru: durasi dihitung ulang, mode tetap bot, pembuka ulang hanya untuk salam', () => {
  const c = mkConv(); c.openingSent = true;
  const s = { ...S, botDurationMinutes: 5 };
  assert.equal(bot.remainingMs(c, s, 1000 + 60000), 4 * 60000);
  const r = bot.decide(c, 'xyz', s, 1000 + 6 * 60000);
  assert.ok(r.every((t) => !/^Halo/.test(t))); assert.equal(c.mode, 'bot');
  assert.equal(bot.remainingMs(c, s, 1000 + 7 * 60000), 4 * 60000);
  assert.match(bot.decide(c, 'halo', s, 1000 + 7 * 60000)[0], /^Halo/); // salam dari nomor lama -> pembuka
});
test('fallback ber-cooldown dan bot nonaktif', () => {
  const c = mkConv(); c.openingSent = true;
  const s = { ...S, requiredFields: [] };
  const t0 = 1_700_000_000_000; c.botStartedAt = t0;
  assert.deepEqual(bot.decide(c, 'xyz', s, t0), ['Admin akan segera membalas.']);
  assert.deepEqual(bot.decide(c, 'xyz', s, t0 + 2000), []); // tertahan cooldown
  assert.deepEqual(bot.decide(c, 'xyz', { ...s, botEnabled: false }, t0 + 3000), []);
});
test('tester: gagal kirim -> pesan failed, state keluaran tidak maju, attention', async () => {
  cur = S;
  const r = await tester().testerSend(A, 'halo', { simulate: { sendFail: true } });
  assert.equal(r.replies[0].status, 'failed'); assert.equal(r.needsAttention, true);
  assert.equal(r.replies.length, 1);
});
test('tester: pesan basi tanpa balasan + attention; media berlabel', async () => {
  cur = S;
  const t = tester();
  const a = await t.testerSend(A, 'halo', { simulate: { stale: true } });
  assert.equal(a.replies.length, 0); assert.equal(a.needsAttention, true);
  const m = await t.testerSend('6281200000002', 'foto bukti', { kind: 'image' });
  assert.equal(m.message.text, '[Gambar] foto bukti'); assert.equal(m.message.type, 'image'); assert.equal(m.needsAttention, true);
});
test('tester: phone-reply -> takeover, bot diam setelahnya', async () => {
  cur = S;
  const t = tester();
  await t.testerSend(A, 'halo');
  const r = await t.testerPhoneReply(A, 'Halo kak, admin di sini');
  assert.equal(r.status.mode, 'admin');
  assert.ok(t.testerView(A).messages.some((m) => m.by === 'system' && /Bot dinonaktifkan/.test(m.text)));
  assert.equal((await t.testerSend(A, 'ada promo?')).replies.length, 0);
});
test('tester: durasi habis lewat jam simulasi -> tanpa pembuka ulang (kecuali salam); nomor terpisah; tidak menyentuh CRM asli', async () => {
  cur = { ...S, botDurationMinutes: 5 };
  const t = tester();
  await t.testerSend(A, 'Halo dari Instagram');
  t.testerAdvance(A, 1);
  const r0 = await t.testerSend(A, 'ada promo?');
  assert.ok(r0.replies.every((m) => !/^Halo/.test(m.text))); assert.equal(r0.status.mode, 'bot');
  const r = await t.testerSend(A, 'halo lagi');
  assert.match(r.replies[0].text, /^Halo/); assert.equal(r.status.mode, 'bot');
  assert.equal(t.testerView('6281200000009').status.mode, 'bot');
  assert.equal(C.get(A), undefined);
  t.testerReset(); assert.equal(t.testerView(A).numbers.length, 0);
});
test('tester: lead virtual dari platform; jawaban referensi tersimpan di data percakapan', async () => {
  cur = S;
  const t = tester();
  const a = await t.testerSend(A, 'Halo dari TikTok, tanya harga');
  assert.equal(a.lead.platform, 'TikTok'); assert.equal(a.lead.status, 'Cold Leads');
  const b = await t.testerSend(A, 'Teman');
  assert.equal(b.data.referensi, 'Teman');
  assert.equal(t.testerView(A).leads.length, 1);
});
test('tester: admin membalas dari HP lalu diam > batas -> bot aktif kembali (jam simulasi)', async () => {
  cur = { ...S, adminAutoReturnMinutes: 60 };
  const t = tester();
  await t.testerSend(A, 'Halo dari Instagram');
  await t.testerPhoneReply(A, 'Halo kak, admin di sini');
  assert.equal(t.testerView(A).status.mode, 'admin');
  assert.ok(t.testerView(A).status.adminReturnMs > 0);
  assert.equal((await t.testerSend(A, 'ada promo?')).replies.length, 0); // masih dalam batas -> diam
  t.testerAdvance(A, 2); // +2 jam > 60 menit
  const r = await t.testerSend(A, 'halo lagi');
  assert.equal(r.status.mode, 'bot'); assert.match(r.replies[0].text, /^Halo/);
  assert.ok(t.testerView(A).messages.some((m) => m.by === 'system' && /Bot aktif kembali/.test(m.text)));
});
test('tester: balasan admin berikutnya mengulang hitungan batas', async () => {
  cur = { ...S, adminAutoReturnMinutes: 60 };
  const t = tester();
  await t.testerSend(A, 'Halo dari Instagram');
  await t.testerPhoneReply(A, 'admin 1');
  t.testerAdvance(A, 0.75); // 45 menit
  await t.testerPhoneReply(A, 'admin 2'); // hitungan mulai lagi
  t.testerAdvance(A, 0.75); // 45 menit sejak balasan terakhir (< 60)
  assert.equal((await t.testerSend(A, 'halo')).replies.length, 0);
  assert.equal(t.testerView(A).status.mode, 'admin');
});
test('tester: adminAutoReturnMinutes = 0 -> tetap admin walau 7 hari', async () => {
  cur = { ...S, adminAutoReturnMinutes: 0 };
  const t = tester();
  await t.testerSend(A, 'Halo dari Instagram');
  await t.testerPhoneReply(A, 'admin di sini');
  t.testerAdvance(A, 168);
  assert.equal((await t.testerSend(A, 'halo')).replies.length, 0);
  assert.equal(t.testerView(A).status.mode, 'admin');
  assert.equal(t.testerView(A).status.adminReturnMs, null);
});

test('tester: Transaksi selesai (pelunasan di lokasi) -> booking berikutnya langsung Existing', async () => {
  cur = S;
  const t = tester();
  assert.throws(() => t.testerTransactionDone(A), (e) => e.code === 'NO_OPEN'); // belum ada lead/transaksi
  await t.testerSend(A, 'Halo dari Instagram, mau booking');
  await t.testerSend(A, 'sudah dp');
  assert.equal(t.testerView(A).lead.dataType, 'New');
  const v = t.testerTransactionDone(A);
  assert.ok(v.lead.transactionCycles.every((c) => c.doneAt)); // semua siklus tertutup
  assert.equal(v.lead.dataType, 'New'); // belum berubah sampai ada sinyal transaksi berikutnya
  assert.throws(() => t.testerTransactionDone(A), (e) => e.code === 'NO_OPEN'); // tidak ada yang terbuka lagi
  const r = await t.testerSend(A, 'saya mau booking lagi');
  assert.equal(r.lead.dataType, 'Existing');
});
test('tester: Transaksi selesai tidak menyentuh nomor uji lain', async () => {
  cur = S;
  const t = tester(), B = '6281200000002';
  await t.testerSend(A, 'Halo dari Instagram, mau booking');
  await t.testerSend(B, 'Halo dari Instagram, mau booking');
  t.testerTransactionDone(A);
  assert.ok(t.testerView(B).lead.transactionCycles.some((c) => !c.doneAt));
});
