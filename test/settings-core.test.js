// Uji inti pengaturan: default, versi/riwayat, konflik, restore, validasi, masking, pengaturan AI,
// basis pengetahuan, kata salam, format nomor, dan data wajib (hanya 'referensi').
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-set-c-'));
delete process.env.AI_API_KEY;
delete process.env.DATA_KEY;
const s = await import('../src/settings.js');
const secret = await import('../src/ai-secret.js');
const code = (c) => (e) => e.code === c;
const fail = (c, re) => (e) => e.code === c && (!re || re.test(e.message));
const readJson = (f) => fs.readFileSync(path.join(process.env.DATA_DIR, f), 'utf8');

// 1. default: skema baru lengkap, skema lama (intents/slangMap) tidak ada
{
  const c = s.get();
  assert.equal(c.version, 1);
  assert.ok(!('intents' in c) && !('slangMap' in c));
  assert.deepEqual(c.requiredFields, [{ id: 'referensi', type: 'text', enabled: true, question: 'Boleh tahu, Kakak mengetahui kami dari mana?' }]);
  assert.deepEqual(c.ai, {
    enabled: false, provider: 'anthropic', baseUrl: '', model: '', persona: '', rules: '', maxHistory: 10, maxReplyChars: 600,
    timeoutMs: 20000, monthlyQuota: 1000, perCustomerDailyLimit: 20,
    quotaExhaustedMessage: 'Terima kasih, pesan Anda kami teruskan ke admin.', errorMessage: '',
  });
  assert.deepEqual(c.knowledge, []);
  assert.equal(c.phoneFormat, 'digits');
  assert.equal(c.greetingWords.length, 19);
  for (const w of ['halo', "assalamu'alaikum", 'selamat malam', 'p']) assert.ok(c.greetingWords.includes(w), w);
  assert.ok(!/asisten virtual.*asisten virtual/i.test(c.openingMessage));
}

// 2. versi naik, riwayat menyimpan snapshot LAMA, by/updatedBy tercatat
{
  const r = s.update({ brandName: 'B2' }, { by: 'budi' });
  assert.equal(r.version, 2);
  assert.equal(r.updatedBy, 'budi');
  assert.deepEqual(s.history().map((h) => h.version), [1]);
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'settings.history.json'), 'utf8'));
  assert.equal(raw[0].settings.brandName, s.DEFAULTS.brandName);
}

// 3. riwayat maks 20 (menyimpan yang terbaru)
{
  for (let i = 0; i < 25; i++) s.update({ brandName: 'n' + i }, { by: 'x' });
  const h = s.history();
  assert.equal(h.length, 20);
  assert.equal(h.at(-1).version, s.get().version - 1);
}

// 4. konflik: expectedVersion salah -> CONFLICT + current; tidak berubah; null = tanpa cek
{
  const v = s.get().version;
  assert.throws(() => s.update({ brandName: 'zzz' }, { expectedVersion: v - 1 }), (e) => e.code === 'CONFLICT' && e.current.version === v);
  assert.notEqual(s.get().brandName, 'zzz');
  assert.equal(s.update({ brandName: 'ok' }, { expectedVersion: v }).version, v + 1);
}

// 5. restore -> versi BARU berisi isi snapshot
{
  s.update({ brandName: 'Awal', adminName: 'A1' }, { by: 'x' });
  const target = s.get().version;
  s.update({ brandName: 'Akhir', adminName: 'A2' }, { by: 'x' });
  const before = s.get().version;
  const r = s.restore(target, { by: 'adm' });
  assert.equal(r.version, before + 1);
  assert.equal(r.brandName, 'Awal');
  assert.equal(r.updatedBy, 'adm');
  assert.throws(() => s.restore(99999, { by: 'adm' }), code('NOT_FOUND'));
}

// 6. SSRF webhook (tabel)
{
  const ok = ['', 'https://hooks.example.com/x?a=1', 'http://example.org', 'https://8.8.8.8/x', 'https://172.32.0.1/x', 'https://[2606:4700::1111]/x'];
  const bad = ['http://localhost:3000', 'http://LOCALHOST./x', 'http://foo.local/x', 'http://a.b.internal', 'http://127.0.0.1', 'http://127.1/', 'http://2130706433/', 'http://10.1.2.3', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.1', 'http://169.254.169.254/latest', 'http://0.0.0.0', 'http://[::1]/', 'http://[::]/', 'http://[fc00::1]/', 'http://[fd12:3::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:8.8.8.8]/', 'ftp://example.com', 'javascript:alert(1)', 'bukan url'];
  for (const u of ok) assert.doesNotThrow(() => s.update({ notify: { webhookUrl: u } }, { by: 'x' }), u);
  for (const u of bad) assert.throws(() => s.update({ notify: { webhookUrl: u } }, { by: 'x' }), code('VALIDATION'), u);
}

// 7. token: masking di publicView; nilai berawalan •••• = tidak diubah; kosong = hapus
{
  s.update({ notify: { telegramBotToken: '123456:ABCDEFwxyz9876' } }, { by: 'x' });
  const v = s.publicView(s.get());
  assert.equal(v.notify.telegramBotToken, '••••9876');
  assert.equal(s.get().notify.telegramBotToken, '123456:ABCDEFwxyz9876'); // asli tidak ikut termask
  s.update({ notify: { telegramBotToken: v.notify.telegramBotToken, telegramChatId: '77' } }, { by: 'x' });
  assert.equal(s.get().notify.telegramBotToken, '123456:ABCDEFwxyz9876');
  s.update({ notify: { telegramBotToken: '' } }, { by: 'x' });
  assert.equal(s.publicView(s.get()).notify.telegramBotToken, '');
}

// 8. clamp angka
{
  const r = s.update({ staleMinutes: 0, fallbackCooldownMinutes: -5, sendRateLimitPerMinute: 999, maxMediaMB: 500, retentionDays: 99999, botDurationMinutes: 'abc', notify: { attentionMinutes: 0 } }, { by: 'x' });
  assert.deepEqual([r.staleMinutes, r.fallbackCooldownMinutes, r.sendRateLimitPerMinute, r.maxMediaMB, r.retentionDays, r.botDurationMinutes, r.notify.attentionMinutes], [1, 0, 120, 64, 3650, 0, 1]);
}

// 9. pengaturan AI: validasi, rentang angka, penggabungan sebagian, kunci tidak ikut
{
  const v0 = s.get().version;
  const r = s.update({ ai: { persona: '  Ramah dan sopan  ', maxHistory: 999, maxReplyChars: 1, timeoutMs: 'abc', monthlyQuota: -5, perCustomerDailyLimit: 5000, errorMessage: 'Maaf, ada gangguan.' } }, { by: 'x' });
  assert.equal(r.version, v0 + 1);
  assert.deepEqual(
    [r.ai.persona, r.ai.maxHistory, r.ai.maxReplyChars, r.ai.timeoutMs, r.ai.monthlyQuota, r.ai.perCustomerDailyLimit, r.ai.errorMessage],
    ['Ramah dan sopan', 30, 50, 20000, 0, 1000, 'Maaf, ada gangguan.']
  );
  assert.equal(r.ai.provider, 'anthropic'); // field yang tidak dikirim tetap
  assert.equal(s.update({ ai: { quotaExhaustedMessage: '   ' } }, { by: 'x' }).ai.quotaExhaustedMessage, s.DEFAULTS.ai.quotaExhaustedMessage);

  for (const p of s.AI_PROVIDERS) assert.equal(s.update({ ai: { provider: p } }, { by: 'x' }).ai.provider, p);
  const before = s.get().version;
  for (const bad of ['', 'claude', 'OpenAI ', null, 5, ['openai']]) {
    assert.throws(() => s.update({ ai: { provider: bad } }, { by: 'x' }), code('VALIDATION'), String(bad));
  }
  assert.equal(s.get().version, before, 'galat validasi tidak mengubah apa pun');

  // model = teks bebas (bukan daftar tetap); karakter kontrol dibuang
  assert.equal(s.update({ ai: { provider: 'openai', model: 'gpt-5-mini-2026\n' } }, { by: 'x' }).ai.model, 'gpt-5-mini-2026');
  assert.equal(s.update({ ai: { model: 'x'.repeat(300) } }, { by: 'x' }).ai.model.length, 100);
  s.update({ ai: { model: 'model-uji' } }, { by: 'x' });

  // aktif butuh model; 'openai-compatible' butuh URL dasar
  s.update({ ai: { provider: 'anthropic', model: '' } }, { by: 'x' });
  assert.throws(() => s.update({ ai: { enabled: true } }, { by: 'x' }), fail('VALIDATION', /model/i));
  assert.equal(s.update({ ai: { enabled: true, model: 'm1' } }, { by: 'x' }).ai.enabled, true);
  assert.throws(() => s.update({ ai: { provider: 'openai-compatible' } }, { by: 'x' }), fail('VALIDATION', /URL dasar/));
  assert.equal(s.update({ ai: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1/' } }, { by: 'x' }).ai.baseUrl, 'http://localhost:11434/v1');
  assert.equal(s.update({ ai: { enabled: false, provider: 'anthropic', baseUrl: '' } }, { by: 'x' }).ai.enabled, false);

  // URL dasar: http(s) saja, tanpa kredensial/parameter/fragmen
  for (const bad of ['ftp://x.com', 'bukan url', 'https://user:pass@x.com/v1', 'https://x.com/v1?key=abc', 'https://x.com/v1#a', 'javascript:alert(1)', 'https://x.com/' + 'a'.repeat(300)]) {
    assert.throws(() => s.update({ ai: { baseUrl: bad } }, { by: 'x' }), fail('VALIDATION', /URL dasar AI/), bad.slice(0, 40));
  }
  assert.equal(s.update({ ai: { baseUrl: 'https://api.contoh.id/v1' } }, { by: 'x' }).ai.baseUrl, 'https://api.contoh.id/v1');
  s.update({ ai: { baseUrl: '' } }, { by: 'x' });

  // kunci yang terselip di body tidak pernah tersimpan (settings.json, riwayat, publicView)
  const SECRET = 'sk-rahasia-terselip-123456';
  const r2 = s.update({ ai: { apiKey: SECRET, key: SECRET, hasKey: true, persona: 'p2' }, apiKey: SECRET, aiKey: SECRET }, { by: 'x' });
  assert.deepEqual(Object.keys(r2.ai).sort(), Object.keys(s.DEFAULTS.ai).sort());
  assert.ok(!('apiKey' in r2) && !('aiKey' in r2));
  for (const text of [readJson('settings.json'), readJson('settings.history.json'), JSON.stringify(s.publicView(s.get()))]) assert.ok(!text.includes(SECRET));
}

// 10. basis pengetahuan
{
  const long = (n, ch = 'a') => ch.repeat(n);
  const r = s.update({
    knowledge: [
      { id: 'Jam Buka', title: '  Jam   buka  ', content: 'Senin–Sabtu 09.00–17.00\r\nMinggu tutup\u0000' },
      { title: 'Harga', content: 'Facial Rp 150.000', enabled: false },
      { id: 'jam-buka', title: 'Duplikat id', content: 'isi lain' },
    ],
  }, { by: 'x' });
  assert.equal(r.knowledge.length, 3);
  assert.deepEqual(r.knowledge.map((k) => k.title), ['Jam buka', 'Harga', 'Duplikat id']);
  assert.equal(r.knowledge[0].content, 'Senin–Sabtu 09.00–17.00\nMinggu tutup'); // baris baru terjaga, CRLF -> LF, NUL dibuang
  assert.deepEqual(r.knowledge.map((k) => k.enabled), [true, false, true]);
  assert.equal(new Set(r.knowledge.map((k) => k.id)).size, 3);
  assert.equal(r.knowledge[0].id, 'jam-buka');
  assert.ok(r.knowledge.every((k) => /^[a-z0-9-]+$/.test(k.id)));

  const keep = s.get().knowledge;
  const bad = (list, re) => {
    assert.throws(() => s.update({ knowledge: list }, { by: 'x' }), fail('VALIDATION', re));
    assert.deepEqual(s.get().knowledge, keep, 'galat validasi tidak mengubah basis pengetahuan');
  };
  bad('bukan daftar', /daftar/);
  bad([{ title: '', content: 'isi' }], /judul wajib/);
  bad([{ title: 'J', content: '   ' }], /isi wajib/);
  bad([{ title: long(121), content: 'isi' }], /judul maksimal 120/);
  bad([{ title: 'J', content: long(20001) }], /isi maksimal 20\.000/);
  bad(Array.from({ length: 201 }, (_, i) => ({ title: 'T' + i, content: 'c' })), /Maksimal 200 entri/);
  bad(Array.from({ length: 10 }, (_, i) => ({ title: 'T' + i, content: long(20000) })), /Total basis pengetahuan maksimal 200\.000/);
  // pesan galat tidak mengulang isi entri
  try { s.update({ knowledge: [{ title: 'J', content: long(20001, 'Z') }] }, { by: 'x' }); } catch (e) { assert.ok(!e.message.includes('ZZZZZZZZ')); }

  // tepat di batas: 200 entri, 20.000 karakter, total di bawah 200.000
  assert.equal(s.update({ knowledge: Array.from({ length: 200 }, (_, i) => ({ title: 'T' + i, content: 'c' })) }, { by: 'x' }).knowledge.length, 200);
  assert.equal(s.update({ knowledge: [{ title: 'J', content: long(20000) }] }, { by: 'x' }).knowledge[0].content.length, 20000);
  assert.equal(s.update({ knowledge: Array.from({ length: 9 }, (_, i) => ({ title: 'T' + i, content: long(20000) })) }, { by: 'x' }).knowledge.length, 9);
  assert.deepEqual(s.update({ knowledge: [] }, { by: 'x' }).knowledge, []);
}

// 11. kata salam, format nomor, data wajib, skema lama diabaikan
{
  let r = s.update({ greetingWords: [' Halo ', 'HALO', 'selamat   pagi', '', 'x'.repeat(60), null] }, { by: 'x' });
  assert.deepEqual(r.greetingWords, ['halo', 'selamat pagi', 'x'.repeat(40)]);
  r = s.update({ greetingWords: Array.from({ length: 150 }, (_, i) => 'kata' + i) }, { by: 'x' });
  assert.equal(r.greetingWords.length, 100);
  assert.deepEqual(s.update({ greetingWords: 'a, b;c\nd' }, { by: 'x' }).greetingWords, ['a', 'b', 'c', 'd']);
  assert.deepEqual(s.update({ greetingWords: 5 }, { by: 'x' }).greetingWords, ['a', 'b', 'c', 'd']); // bukan daftar/teks: diabaikan
  assert.deepEqual(s.update({ greetingWords: [] }, { by: 'x' }).greetingWords, []);

  assert.equal(s.update({ phoneFormat: 'international' }, { by: 'x' }).phoneFormat, 'international');
  assert.equal(s.update({ phoneFormat: ' digits ' }, { by: 'x' }).phoneFormat, 'digits');
  for (const bad of ['', 'intl', 'DIGITS', 5, null]) assert.throws(() => s.update({ phoneFormat: bad }, { by: 'x' }), code('VALIDATION'), String(bad));
  assert.equal(s.get().phoneFormat, 'digits');

  // requiredFields: selalu tepat satu butir 'referensi'
  const ref = (o) => [{ id: 'referensi', type: 'text', ...o }];
  r = s.update({ requiredFields: [{ id: 'nama', label: 'Nama', question: 'Siapa?', enabled: true }, { id: 'referensi', question: '  Tahu dari mana?  ', enabled: false, type: 'choice', options: ['a'], label: 'X' }] }, { by: 'x' });
  assert.deepEqual(r.requiredFields, ref({ enabled: false, question: 'Tahu dari mana?' }));
  assert.deepEqual(s.update({ requiredFields: [{ id: 'nama', label: 'Nama', question: 'Siapa?' }, { id: 'usia', label: 'U', question: 'Umur?' }] }, { by: 'x' }).requiredFields, ref({ enabled: false, question: 'Tahu dari mana?' })); // tanpa 'referensi': tak berubah
  assert.deepEqual(s.update({ requiredFields: [] }, { by: 'x' }).requiredFields, ref({ enabled: false, question: 'Tahu dari mana?' }));
  assert.deepEqual(s.update({ requiredFields: [{ id: 'referensi', question: '   ' }] }, { by: 'x' }).requiredFields, s.DEFAULTS.requiredFields);

  // intents/slangMap lama di body diabaikan (tidak muncul lagi)
  r = s.update({ intents: [{ name: 'A', response: 'r' }], slangMap: { gk: 'tidak' }, brandName: 'Tetap' }, { by: 'x' });
  assert.ok(!('intents' in r) && !('slangMap' in r));
  assert.ok(!('intents' in JSON.parse(readJson('settings.json'))));
}

// 12. publicView: hanya boolean kunci; kunci tak pernah ikut; riwayat tanpa catatan untuk perubahan biasa
{
  const KEY = 'sk-uji-kunci-tersimpan-98765';
  assert.equal(s.publicView(s.get()).ai.hasKey, false);
  process.env.AI_API_KEY = 'sk-uji-env-111222';
  assert.equal(s.publicView(s.get()).ai.hasKey, true); // cadangan env dihitung
  delete process.env.AI_API_KEY;
  assert.equal(s.publicView(s.get()).ai.hasKey, false);
  const v = s.get().version;
  secret.setAiKey(KEY);
  assert.equal(s.get().version, v, 'menyimpan kunci tidak mengubah pengaturan');
  const view = s.publicView(s.get());
  assert.equal(view.ai.hasKey, true);
  assert.ok(!JSON.stringify(view).includes(KEY));
  s.update({ brandName: 'Setelah Kunci' }, { by: 'x' });
  for (const f of ['settings.json', 'settings.history.json']) assert.ok(!readJson(f).includes(KEY), f);
  assert.ok(s.history().every((h) => !('note' in h)));
  secret.clearAiKey();
  assert.equal(s.publicView(s.get()).ai.hasKey, false);
}

try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* Windows bisa menahan berkas sebentar */ }
console.log('settings-core.test.js OK');
