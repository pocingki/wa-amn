// Uji rencana balasan (plan) dan fungsi murni bot-validate. Tanpa jaringan, tanpa DB, tanpa modul AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, decide, fill, applyReplyEffect, adminReturnMs } from '../src/bot-plan.js';
import { normalizeText, normPhone, isSkip, isQuestion, isGreeting, isGreetingOnly, validateAnswer } from '../src/bot-validate.js';

const NOW = 1_700_000_000_000;
const MIN = 60000;
const REF_Q = 'Boleh tahu, Kakak mengetahui kami dari mana?';
const S0 = (over = {}) => ({
  botEnabled: true, botName: 'Sari', adminName: 'Dewi', openingMessage: 'Halo, saya {bot}.',
  fallbackMessage: 'Maaf kurang paham.', handoverMessage: 'Dilanjut {admin}.', completionMessage: 'Terima kasih {nama}.',
  botDurationMinutes: 0, staleMinutes: 10, fallbackCooldownMinutes: 30,
  ai: { enabled: true },
  requiredFields: [{ id: 'referensi', type: 'text', enabled: true, question: REF_Q }],
  ...over,
});
// Percakapan nomor lama: pembuka sudah terkirim, belum ada pertanyaan menggantung.
const C0 = (o = {}) => ({ mode: 'bot', name: '', botStartedAt: NOW, openingSent: true, pending: null, skipped: [], retries: {}, data: {}, ...o });
const T = (text, o = {}) => ({ text, kind: 'text', ts: NOW, ...o });
const IMG = (caption, o = {}) => ({ text: caption ? `[Gambar] ${caption}` : '[Gambar]', caption, kind: 'image', ts: NOW, ...o });
const CTX = (o = {}) => ({ isNewNumber: false, crm: { referensi: '', name: '', phone: '' }, ...o });
const kinds = (p) => p.replies.map((r) => r.kind);
const commitAll = (p, c) => p.replies.forEach((r) => r.commit(c));

// ---------- Pembuka, AI, dan urutan balasan ----------

test('nomor baru + pertanyaan teknis: pembuka -> AI -> pertanyaan referensi (state maju hanya setelah commit)', () => {
  const c = C0({ openingSent: false }), p = plan(c, T('Berapa lama durasi terapinya?'), S0(), NOW, CTX({ isNewNumber: true }));
  assert.deepEqual(kinds(p), ['opening', 'ai', 'question']);
  assert.equal(p.replies[0].text, 'Halo, saya Sari.');
  assert.equal(p.replies[1].needsAi, true); assert.equal(p.replies[1].text, '');
  assert.equal(p.replies[2].text, REF_Q); assert.equal(p.replies[2].fieldId, 'referensi');
  assert.equal(c.openingSent, false); assert.equal(c.pending, null); assert.equal(c.lastFallbackAt, undefined); assert.equal(c.refAsked, undefined);
  commitAll(p, c);
  assert.equal(c.openingSent, true); assert.equal(c.pending, 'referensi'); assert.equal(c.refAsked, 1); assert.equal(c.lastFallbackAt, NOW);
  assert.equal(p.attention, null);
});
test('nomor baru + salam saja: pembuka + pertanyaan, tanpa AI', () => {
  const p = plan(C0({ openingSent: false }), T('Halo kak'), S0(), NOW, CTX({ isNewNumber: true }));
  assert.deepEqual(kinds(p), ['opening', 'question']);
});
test('nomor baru yang pembukanya sudah terkirim: tidak dikirim lagi', () => {
  const p = plan(C0({ openingSent: true }), T('Berapa harganya?'), S0(), NOW, CTX({ isNewNumber: true }));
  assert.deepEqual(kinds(p), ['ai', 'question']);
});
test('nomor lama + salam saja: pembuka tanpa AI; pertanyaan hanya bila referensi kosong', () => {
  assert.deepEqual(kinds(plan(C0(), T('Halo kak!'), S0(), NOW, CTX())), ['opening', 'question']);
  const filled = plan(C0(), T('Selamat pagi'), S0(), NOW, CTX({ crm: { referensi: 'Instagram', name: '', phone: '' } }));
  assert.deepEqual(kinds(filled), ['opening']);
});
test('nomor lama + salam + pertanyaan: pembuka, AI, pertanyaan', () => {
  const p = plan(C0(), T('Halo, berapa harga paketnya?'), S0(), NOW, CTX());
  assert.deepEqual(kinds(p), ['opening', 'ai', 'question']);
});
test('nomor lama + pertanyaan teknis tanpa salam: tanpa pembuka', () => {
  const p = plan(C0(), T('Berapa lama durasi terapinya?'), S0(), NOW, CTX());
  assert.deepEqual(kinds(p), ['ai', 'question']);
  assert.ok(!kinds(p).includes('opening'));
});
test('pernyataan biasa (bukan pertanyaan) tanpa pertanyaan menggantung tetap ke AI', () => {
  assert.deepEqual(kinds(plan(C0(), T('saya mau booking besok'), S0(), NOW, CTX())), ['ai', 'question']);
});
test('pembuka kosong pada nomor baru -> openingSent langsung, tanpa balasan pembuka', () => {
  const c = C0({ openingSent: false }), p = plan(c, T('Berapa harga?'), S0({ openingMessage: '' }), NOW, CTX({ isNewNumber: true }));
  assert.equal(c.openingSent, true); assert.deepEqual(kinds(p), ['ai', 'question']);
});
test('tanpa ctx: nomor dianggap baru bila pembuka belum terkirim; referensi dibaca dari conv.data', () => {
  const a = plan(C0({ openingSent: false }), T('Berapa harga?'), S0(), NOW);
  assert.deepEqual(kinds(a), ['opening', 'ai', 'question']);
  const b = plan(C0({ data: { referensi: 'Teman' } }), T('Berapa harga?'), S0(), NOW);
  assert.deepEqual(kinds(b), ['ai']);
});

// ---------- Pertanyaan referensi ----------

test('referensi sudah terisi di CRM: tidak ditanyakan; pertanyaan menggantung dibersihkan', () => {
  const c = C0({ pending: 'referensi' }), ctx = CTX({ crm: { referensi: 'Instagram', name: '', phone: '' } });
  const p = plan(c, T('Berapa harga?'), S0(), NOW, ctx);
  assert.deepEqual(kinds(p), ['ai']); assert.equal(c.pending, null);
  // pesan non-pertanyaan juga bukan jawaban bila CRM sudah terisi
  const c2 = C0({ pending: 'referensi' }), q = plan(c2, T('Tiktok'), S0(), NOW, ctx);
  assert.ok(!('referensi' in c2.data)); assert.equal(q.referensi, undefined);
});
test('field referensi nonaktif / tidak ada (skema lama) -> tidak ada pertanyaan', () => {
  const off = S0({ requiredFields: [{ id: 'referensi', type: 'text', enabled: false, question: REF_Q }] });
  assert.deepEqual(kinds(plan(C0(), T('Berapa harga?'), off, NOW, CTX())), ['ai']);
  const lama = S0({ requiredFields: [{ id: 'nama', type: 'name', enabled: true, question: 'Siapa nama Kakak?' }] });
  const c = C0({ pending: 'nama' });
  assert.deepEqual(kinds(plan(c, T('Budi'), lama, NOW, CTX())), ['ai']);
  assert.equal(c.pending, null); assert.ok(!('nama' in c.data)); assert.equal(c.name, '');
});
test('jawaban referensi: tersimpan di conv.data dan out.referensi, tanpa AI; penutup lewat commit', () => {
  const c = C0({ pending: 'referensi' }), p = plan(c, T('  Instagram   kak  '), S0(), NOW, CTX());
  assert.equal(c.data.referensi, 'Instagram kak'); assert.equal(p.referensi, 'Instagram kak');
  assert.equal(c.pending, null); assert.equal(c.refDone, 'answered');
  assert.deepEqual(kinds(p), ['completion']); assert.equal(p.replies[0].text, 'Terima kasih Kak.');
  assert.equal(c.completedAt, undefined); commitAll(p, c); assert.equal(c.completedAt, NOW);
  // sesudah dijawab: tidak ditanyakan lagi pada sesi yang sama, walau CRM belum terisi
  assert.deepEqual(kinds(plan(c, T('Berapa harga?', { ts: NOW + 1 }), S0(), NOW + 1, CTX())), ['ai']);
});
test('jawaban referensi dipotong 50 karakter (emoji tidak terbelah)', () => {
  const c = C0({ pending: 'referensi' }), p = plan(c, T('😀'.repeat(60)), S0(), NOW, CTX());
  assert.equal(Array.from(p.referensi).length, 50); assert.equal(c.data.referensi, p.referensi);
  const d = C0({ pending: 'referensi' }), q = plan(d, T('a'.repeat(80)), S0(), NOW, CTX());
  assert.equal(q.referensi.length, 50);
});
test('pertanyaan saat pending bukan jawaban data: ke AI lalu ditanyakan ulang', () => {
  const c = C0({ pending: 'referensi', refAsked: 1 }), p = plan(c, T('Berapa lama durasi terapinya'), S0(), NOW, CTX());
  assert.ok(!('referensi' in c.data)); assert.equal(p.referensi, undefined);
  assert.deepEqual(kinds(p), ['ai', 'question']);
});
test('salam saja saat pending bukan jawaban', () => {
  const c = C0({ pending: 'referensi', refAsked: 1 }), p = plan(c, T('halo'), S0(), NOW, CTX());
  assert.ok(!('referensi' in c.data)); assert.deepEqual(kinds(p), ['opening', 'question']);
});
test('ulang maksimal 2 kali lalu berhenti (1 awal + 2 ulang = 3 penanyaan)', () => {
  const c = C0(), S = S0({ fallbackCooldownMinutes: 0 });
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const p = plan(c, T('Berapa harganya?', { ts: NOW + i }), S, NOW + i, CTX());
    commitAll(p, c);
    seen.push(kinds(p));
  }
  assert.deepEqual(seen, [['ai', 'question'], ['ai', 'question'], ['ai', 'question'], ['ai'], ['ai']]);
  assert.equal(c.refAsked, 3);
});
test('penanyaan yang gagal terkirim (tanpa commit) tidak dihitung', () => {
  const c = C0();
  plan(c, T('Berapa harganya?'), S0(), NOW, CTX());
  assert.equal(c.refAsked, undefined);
});
test('skip menghentikan pertanyaan pada sesi ini', () => {
  const c = C0({ pending: 'referensi' }), p = plan(c, T('lewati'), S0(), NOW, CTX());
  assert.deepEqual(c.skipped, ['referensi']); assert.equal(c.refDone, 'skipped'); assert.equal(c.pending, null);
  assert.ok(!('referensi' in c.data)); assert.equal(p.referensi, undefined); assert.deepEqual(kinds(p), ['completion']);
  assert.deepEqual(kinds(plan(c, T('Berapa harga?', { ts: NOW + 1 }), S0(), NOW + 1, CTX())), ['ai']);
});
test('sesi baru (durasi bot habis) mengulang pertanyaan, tanpa pembuka ulang', () => {
  const S = S0({ botDurationMinutes: 5 });
  const c = C0({ botStartedAt: NOW - 6 * MIN, skipped: ['referensi'], refDone: 'skipped', refAsked: 3, pending: 'referensi' });
  const p = plan(c, T('Berapa harga?'), S, NOW, CTX());
  assert.equal(c.botStartedAt, NOW); assert.equal(c.mode, 'bot'); assert.deepEqual(c.skipped, []);
  assert.equal(c.refDone, undefined); assert.equal(c.refAsked, 0);
  assert.deepEqual(kinds(p), ['ai', 'question']);
  commitAll(p, c); assert.equal(c.refAsked, 1); assert.equal(c.pending, 'referensi');
  // belum habis -> hitungan sesi tidak diubah
  const c2 = C0({ botStartedAt: NOW - 4 * MIN, refDone: 'skipped', refAsked: 3 });
  assert.deepEqual(kinds(plan(c2, T('Berapa harga?'), S, NOW, CTX())), ['ai']);
  assert.equal(c2.botStartedAt, NOW - 4 * MIN); assert.equal(c2.refAsked, 3);
});
test('sesi baru: jawaban lama pada pertanyaan sesi sebelumnya tidak dianggap jawaban', () => {
  const S = S0({ botDurationMinutes: 5 }), c = C0({ botStartedAt: NOW - 6 * MIN, pending: 'referensi', refAsked: 1 });
  const p = plan(c, T('oke'), S, NOW, CTX());
  assert.ok(!('referensi' in c.data)); assert.deepEqual(kinds(p), ['ai', 'question']);
});
test('penutup hanya sekali', () => {
  const c = C0({ pending: 'referensi', completedAt: NOW - 1 }), p = plan(c, T('Instagram'), S0(), NOW, CTX());
  assert.equal(c.data.referensi, 'Instagram'); assert.deepEqual(kinds(p), []); assert.deepEqual(p.attention, { reason: 'no_reply' });
  const d = C0({ pending: 'referensi' }), q = plan(d, T('Instagram'), S0({ completionMessage: '' }), NOW, CTX());
  assert.deepEqual(kinds(q), []); assert.equal(d.completedAt, NOW);
});

// ---------- Salam: "p" dan batas tiga kata ----------

test('"p" saja = salam; "p" di dalam kalimat bukan salam', () => {
  const a = plan(C0(), T('p'), S0(), NOW, CTX());
  assert.deepEqual(kinds(a), ['opening', 'question']);
  const b = plan(C0(), T('p mau tanya harga'), S0(), NOW, CTX());
  assert.deepEqual(kinds(b), ['ai', 'question']);
  const c = plan(C0(), T('mau tanya harga p'), S0(), NOW, CTX());
  assert.deepEqual(kinds(c), ['ai', 'question']);
});
test('S.greetingWords kustom dipakai; kosong -> bawaan', () => {
  assert.deepEqual(kinds(plan(C0(), T('hola, berapa harga?'), S0({ greetingWords: ['hola'] }), NOW, CTX())), ['opening', 'ai', 'question']);
  assert.deepEqual(kinds(plan(C0(), T('halo, berapa harga?'), S0({ greetingWords: ['hola'] }), NOW, CTX())), ['ai', 'question']);
  assert.deepEqual(kinds(plan(C0(), T('halo, berapa harga?'), S0({ greetingWords: [] }), NOW, CTX())), ['opening', 'ai', 'question']);
});

// ---------- Media ----------

test('media bercaption: bukan jawaban data, caption pertanyaan -> AI, attention media', () => {
  const c = C0({ pending: 'referensi', refAsked: 1 }), p = plan(c, IMG('berapa harga ini?'), S0(), NOW, CTX());
  assert.equal(c.pending, 'referensi'); assert.ok(!('referensi' in c.data));
  assert.deepEqual(kinds(p), ['ai']); assert.equal(p.replies[0].needsAi, true); assert.deepEqual(p.attention, { reason: 'media' });
});
test('media bercaption salam / nomor baru: pembuka mengikuti aturan yang sama', () => {
  assert.deepEqual(kinds(plan(C0(), IMG('halo'), S0(), NOW, CTX())), ['opening']); // salam saja: tanpa AI
  assert.deepEqual(kinds(plan(C0(), IMG('halo, ini berapa?'), S0(), NOW, CTX())), ['opening', 'ai']);
  assert.deepEqual(kinds(plan(C0({ openingSent: false }), IMG('berapa harga ini?'), S0(), NOW, CTX({ isNewNumber: true }))), ['opening', 'ai']);
});
test('media tanpa caption: tidak ke AI; stiker nomor baru hanya pembuka', () => {
  const p = plan(C0(), IMG(''), S0(), NOW, CTX());
  assert.deepEqual(kinds(p), ['fallback']); assert.deepEqual(p.attention, { reason: 'media' });
  const q = plan(C0({ openingSent: false }), { text: '[Stiker]', kind: 'sticker', ts: NOW }, S0(), NOW, CTX({ isNewNumber: true }));
  assert.deepEqual(kinds(q), ['opening']);
});
test('media bercaption dengan AI nonaktif -> fallback ber-cooldown', () => {
  const p = plan(C0(), IMG('berapa harga ini?'), S0({ ai: { enabled: false } }), NOW, CTX());
  assert.deepEqual(kinds(p), ['fallback']);
});

// ---------- AI nonaktif, cooldown ----------

test('AI nonaktif atau S.ai tidak ada -> perilaku lama tanpa intent: fallback ber-cooldown', () => {
  for (const S of [S0({ ai: { enabled: false } }), S0({ ai: undefined })]) {
    const c = C0(), p = plan(c, T('Berapa harganya?'), S, NOW, CTX());
    assert.deepEqual(kinds(p), ['fallback', 'question']); assert.ok(!p.replies.some((r) => r.needsAi));
    commitAll(p, c); assert.equal(c.lastFallbackAt, NOW);
  }
  // pembuka baru saja dikirim -> fallback ditahan (seperti perilaku lama)
  const n = plan(C0({ openingSent: false }), T('Berapa harganya?'), S0({ ai: undefined }), NOW, CTX({ isNewNumber: true }));
  assert.deepEqual(kinds(n), ['opening', 'question']);
});
test('cooldown: AI dan fallback berbagi satu cooldown; attention no_reply saat tertahan', () => {
  const S = S0({ requiredFields: [] }), c = C0();
  const a = plan(c, T('Berapa harganya?'), S, NOW, CTX()); assert.deepEqual(kinds(a), ['ai']);
  commitAll(a, c); assert.equal(c.lastFallbackAt, NOW);
  const b = plan(c, T('Kalau yang 60 menit?', { ts: NOW + MIN }), S, NOW + MIN, CTX());
  assert.equal(b.replies.length, 0); assert.deepEqual(b.attention, { reason: 'no_reply' });
  assert.deepEqual(kinds(plan(c, T('Kalau yang 60 menit?', { ts: NOW + 31 * MIN }), S, NOW + 31 * MIN, CTX())), ['ai']);
  // fallback lama setelah AI dimatikan memakai cooldown yang sama
  const off = S0({ requiredFields: [], ai: { enabled: false } }), d = C0({ lastFallbackAt: NOW });
  assert.equal(plan(d, T('asdf', { ts: NOW + MIN }), off, NOW + MIN, CTX()).replies.length, 0);
  assert.deepEqual(kinds(plan(d, T('asdf', { ts: NOW + 31 * MIN }), off, NOW + 31 * MIN, CTX())), ['fallback']);
});
test('pesan beruntun: hanya pesan pertama yang memicu AI (cooldown), pesan kedua menunggu', () => {
  const S = S0({ requiredFields: [] }), c = C0();
  const first = plan(c, T('Berapa harga?'), S, NOW, CTX()); commitAll(first, c);
  const second = plan(c, T('dan jadwalnya?', { ts: NOW + 1000 }), S, NOW + 1000, CTX());
  assert.deepEqual([kinds(first), kinds(second)], [['ai'], []]);
});
test('teks kosong tidak memicu AI', () => {
  assert.deepEqual(kinds(plan(C0(), T('   '), S0({ requiredFields: [] }), NOW, CTX())), ['fallback']);
});

// ---------- Basi, mode admin, pembungkus ----------

test('reaksi diabaikan; bot nonaktif / mode admin -> ignored', () => {
  assert.deepEqual(plan(C0(), T('', { kind: 'reaction' }), S0(), NOW, CTX()), { replies: [], attention: null, ignored: true });
  assert.equal(plan(C0(), T('x'), S0({ botEnabled: false }), NOW, CTX()).ignored, true);
  assert.equal(plan(C0({ mode: 'admin' }), T('x'), S0(), NOW, CTX()).ignored, true);
});
test('pesan basi: tanpa balasan dan tanpa perubahan state', () => {
  const c = C0({ openingSent: false }), snap = JSON.stringify(c);
  const p = plan(c, T('Berapa harga?', { ts: NOW - 11 * MIN }), S0(), NOW, CTX({ isNewNumber: true }));
  assert.deepEqual(p, { replies: [], attention: { reason: 'stale' }, ignored: false }); assert.equal(JSON.stringify(c), snap);
});
test('admin diam melewati adminAutoReturnMinutes -> bot aktif kembali; pembuka hanya bila salam', () => {
  const S = S0({ adminAutoReturnMinutes: 60 });
  const mk = () => C0({ mode: 'admin', adminLastAt: NOW - 61 * MIN, pending: 'referensi', refAsked: 1 });
  const c = mk(), p = plan(c, T('halo'), S, NOW, CTX());
  assert.equal(c.mode, 'bot'); assert.equal(c.botStartedAt, NOW); assert.equal(c.pending, null);
  assert.equal(p.returnedToBot, 60); assert.equal(kinds(p)[0], 'opening');
  const d = mk(), q = plan(d, T('Berapa harganya?'), S, NOW, CTX());
  assert.equal(d.mode, 'bot'); assert.equal(q.returnedToBot, 60); assert.deepEqual(kinds(q), ['ai', 'question']);
});
test('admin masih aktif -> bot diam; adminAutoReturnMinutes = 0 -> tetap admin', () => {
  const S = S0({ adminAutoReturnMinutes: 60 });
  const c = C0({ mode: 'admin', adminLastAt: NOW - 59 * MIN }), p = plan(c, T('halo'), S, NOW, CTX());
  assert.equal(c.mode, 'admin'); assert.equal(p.ignored, true); assert.equal(p.replies.length, 0);
  assert.equal(adminReturnMs(c, S, NOW), MIN);
  const off = S0({ adminAutoReturnMinutes: 0 }), d = C0({ mode: 'admin', adminLastAt: NOW - 90 * 86400000 });
  assert.equal(plan(d, T('halo'), off, NOW, CTX()).ignored, true); assert.equal(adminReturnMs(d, off, NOW), null);
});
test('pesan basi, bot nonaktif, dan reaksi tidak membangunkan bot dari mode admin', () => {
  const S = S0({ adminAutoReturnMinutes: 60 });
  const a = C0({ mode: 'admin', adminLastAt: NOW - 120 * MIN }), p = plan(a, T('halo', { ts: NOW - 11 * MIN }), S, NOW, CTX());
  assert.equal(a.mode, 'admin'); assert.equal(p.ignored, true);
  const b = C0({ mode: 'admin', adminLastAt: 0 }); plan(b, T('halo'), { ...S, botEnabled: false }, NOW, CTX()); assert.equal(b.mode, 'admin');
  const c = C0({ mode: 'admin', adminLastAt: 0 }); plan(c, T('', { kind: 'reaction' }), S, NOW, CTX()); assert.equal(c.mode, 'admin');
});
test('adminLastAt tanpa field: dihitung dari pesan admin terakhir', () => {
  const S = S0({ adminAutoReturnMinutes: 60 });
  const c = C0({ mode: 'admin', messages: [{ by: 'admin', ts: NOW - 30 * MIN }] });
  assert.equal(adminReturnMs(c, S, NOW), 30 * MIN);
});
test('applyReplyEffect: pembuka, pertanyaan (hitung), AI/fallback/quota (cooldown), penutup, serah terima', () => {
  const c = C0();
  applyReplyEffect(c, 'opening', null, 1); assert.equal(c.openingSent, true);
  applyReplyEffect(c, 'question', 'referensi', 2); assert.equal(c.pending, 'referensi'); assert.equal(c.refAsked, 1);
  applyReplyEffect(c, 'question', 'referensi', 3); assert.equal(c.refAsked, 2);
  applyReplyEffect(c, 'ai', null, 4); assert.equal(c.lastFallbackAt, 4);
  applyReplyEffect(c, 'fallback', null, 5); assert.equal(c.lastFallbackAt, 5);
  applyReplyEffect(c, 'quota', null, 6); assert.equal(c.lastFallbackAt, 6);
  applyReplyEffect(c, 'completion', null, 7); assert.equal(c.completedAt, 7);
  applyReplyEffect(c, 'handover', null, 8); assert.equal(c.mode, 'admin'); assert.equal(c.pending, null);
});
test('decide: menjalankan commit balasan biasa dan melewati balasan AI', () => {
  const c = C0({ openingSent: false });
  assert.deepEqual(decide(c, 'Halo, berapa harga?', S0(), NOW), ['Halo, saya Sari.', REF_Q]);
  assert.equal(c.openingSent, true); assert.equal(c.pending, 'referensi'); assert.equal(c.lastFallbackAt, undefined);
  assert.deepEqual(decide(c, 'Instagram', S0(), NOW), ['Terima kasih Kak.']);
  assert.equal(c.data.referensi, 'Instagram');
});
test('fill tanpa ekspansi ganda', () => {
  assert.equal(fill('Hai {NAMA}/{bot}/{Admin}', { name: '{admin}' }, { botName: 'B', adminName: 'A' }), 'Hai {admin}/B/A');
  assert.equal(fill('{nama}', {}, {}), 'Kak');
});

// ---------- bot-validate (fungsi murni) ----------

test('normalizeText', () => {
  for (const [inp, slang, out] of [
    ['hargaaa!!', {}, 'harga'], ['Hrg paket brp?', {}, 'harga paket berapa'], ['Kaan', {}, 'kaan'], ['Kaaan', {}, 'kan'],
    ['Café  Müller', {}, 'cafe muller'], ['gk bsk trims', {}, 'tidak besok terima kasih'],
    ['hrg ok', { hrg: 'harga paket', ok: 'oke' }, 'harga paket oke'], ['', {}, ''], [null, {}, ''],
  ]) assert.equal(normalizeText(inp, slang), out, String(inp));
});
test('normPhone', () => {
  for (const [p, want] of [['0812-3456-7890', '6281234567890'], ['+62 812 3456 7890', '6281234567890'], ['6281234567890', '6281234567890'],
    ['0812', null], ['1234567890123456', null], ['abc', null], [null, null]]) assert.equal(normPhone(p), want, String(p));
});
test('isSkip', () => {
  for (const [t, want] of [['Lewati.', true], ['SKIP', true], ['nanti dulu!', true], ['Gak usah', true], ['nggak mau', true],
    ['ya', false], ['tidak', false], ['nanti saja ya', false], ['', false]]) assert.equal(isSkip(t), want, t);
});
test('isQuestion: hanya dari teks (tanpa intent)', () => {
  for (const [t, want] of [['harga?', true], ['berapa lama terapinya', true], ['di mana lokasinya', true], ['dimana alamat', true],
    ['gmn caranya', true], ['halo', false], ['Budi', false], ['besok jam 10', false], ['Instagram', false], ['', false], [null, false]])
    assert.equal(isQuestion(t), want, String(t));
  assert.equal(isQuestion.length, 1); // tidak lagi menerima intentMatched
});
test('isGreeting: kata salam di 3 kata pertama; "p" hanya bila seluruh pesan', () => {
  for (const [t, want] of [['halo', true], ['Halo kak, mau tanya', true], ['Selamat pagi', true], ['kak selamat siang', true],
    ['kak mau tanya selamat pagi', false], ["Assalamu'alaikum", true], ['assalamualaikum kak', true], ['haloooo', true], ['permisi', true],
    ['hai', true], ['p', true], ['P!', true], ['p mau tanya', false], ['tanya dulu p', false], ['berapa harga paket?', false], ['', false], [null, false]])
    assert.equal(isGreeting(t), want, String(t));
  assert.equal(isGreeting('hola amigo', ['hola']), true); assert.equal(isGreeting('halo', ['hola']), false);
  assert.equal(isGreeting('halo', []), true); // daftar kosong -> bawaan
});
test('isGreetingOnly: salam saja (boleh sapaan kak/min), tanpa isi lain', () => {
  for (const [t, want] of [['halo', true], ['Halo kak!', true], ['selamat pagi min', true], ['p', true], ['halo mau tanya harga', false],
    ['halo, saya Budi', false], ['berapa harga', false], ['p kak', false], ['', false]]) assert.equal(isGreetingOnly(t), want, t);
});
test('validateAnswer: name', () => {
  const name = { type: 'name' };
  for (const [t, ok, value] of [['Budi', true, 'Budi'], ['nama saya Budi', true, 'Budi'], ['Nama: Siti Aminah', true, 'Siti Aminah'], ['panggil aja Mas Joko', true, 'Mas Joko'],
    ['Berapa lama durasi terapinya', false], ['Siapa?', false], ['12345', false], ['😀', false], ['a', false], ['satu dua tiga empat lima enam tujuh', false], ['', false]]) {
    const r = validateAnswer(name, t);
    assert.equal(r.ok, ok, t); if (ok) assert.equal(r.value, value, t); else assert.match(r.reason, /\S/);
  }
});
test('validateAnswer: phone, date, choice, text', () => {
  assert.deepEqual(validateAnswer({ type: 'phone' }, '0812 3456 7890'), { ok: true, value: '6281234567890', reason: null });
  assert.equal(validateAnswer({ type: 'phone' }, 'tidak punya').ok, false);
  for (const [t, ok] of [['besok', true], ['Lusa pagi', true], ['hari ini', true], ['Senin depan', true], ["Jum'at", true], ['12 Mei', true], ['5 des 2026', true],
    ['12/5', true], ['3-6-2026', true], ['asal saja', false], ['', false], ['x'.repeat(101), false]]) assert.equal(validateAnswer({ type: 'date' }, t).ok, ok, t);
  assert.equal(validateAnswer({ type: 'date' }, ' besok sore ').value, 'besok sore');
  const ch = { type: 'choice', options: ['Nyeri punggung', 'Cedera olahraga', 'Pasca stroke'] };
  for (const [t, want] of [['2', 'Cedera olahraga'], ['3.', 'Pasca stroke'], ['nyeri punggung', 'Nyeri punggung'], ['saya mau pasca stroke kak', 'Pasca stroke'],
    ['punggung', 'Nyeri punggung'], ['4', null], ['0', null], ['lainnya', null]]) {
    const r = validateAnswer(ch, t); assert.equal(r.ok, want !== null, t); assert.equal(r.value, want, t);
  }
  assert.match(validateAnswer(ch, '9').reason, /1\. Nyeri punggung/);
  for (const [f, t, ok] of [[{}, 'keluhan lutut', true], [{ type: 'text' }, 'a', true], [{ type: 'text' }, '   ', false], [{ type: 'text' }, 'x'.repeat(501), false], [{ type: 'text' }, 'x'.repeat(500), true]])
    assert.equal(validateAnswer(f, t).ok, ok, t.slice(0, 10));
});
