// Uji basis pengetahuan AI (fungsi murni, tanpa jaringan, DB, atau berkas sementara).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, validateEntries, normalizeText, KNOWLEDGE_LIMITS } from '../src/ai-knowledge.js';

const E = (id, title, content, o = {}) => ({ id, title, content, enabled: true, ...o });
const seqGen = () => {
  let n = 0;
  return () => `gen${++n}`;
};

// ---------- normalizeText ----------

test('normalizeText: huruf kecil, tanda baca, singkatan umum, huruf berulang', () => {
  for (const [inp, out] of [
    ['HRG paketnyaaa??', 'harga paketnya'], ['Café  Müller', 'cafe muller'], ['gk bsk trims', 'tidak besok terima kasih'],
    ['', ''], [null, ''], [undefined, ''],
  ]) assert.equal(normalizeText(inp), out, String(inp));
});

// ---------- buildContext ----------

test('buildContext: semua entri aktif muat -> semua dipakai, tidak terpotong', () => {
  const entries = [E('1', 'Alamat', 'Jl. Melati 5, Depok.'), E('2', 'Jam buka', 'Senin-Sabtu 09.00-17.00.')];
  const r = buildContext(entries, 'jam berapa buka', { maxChars: 5000 });
  assert.equal(r.used, 2);
  assert.equal(r.truncated, false);
  assert.ok(r.text.includes('Alamat') && r.text.includes('Jl. Melati 5'));
  assert.ok(r.text.includes('Jam buka') && r.text.includes('09.00-17.00'));
  assert.ok(r.text.indexOf('Alamat') < r.text.indexOf('Jam buka')); // urutan asli
});

test('buildContext: opsi dan query boleh tidak diberikan; masukan aneh tidak melempar', () => {
  assert.deepEqual(buildContext([], 'x'), { text: '', used: 0, truncated: false });
  assert.deepEqual(buildContext(null, 'x'), { text: '', used: 0, truncated: false });
  assert.equal(buildContext([E('1', 'A', 'isi')]).used, 1);
  assert.equal(buildContext([E('1', 'A', 'isi')], undefined, { maxChars: -5 }).used, 1); // jatuh ke bawaan
  assert.equal(buildContext([null, 5, 'x', E('1', 'A', 'isi')], 'a').used, 1);
});

test('buildContext: terlalu besar -> potongan relevan duluan, batas maxChars dihormati', () => {
  const filler = (k) => Array.from({ length: 6 }, (_, i) => `Catatan umum nomor ${k}-${i} tentang hal lain yang tidak terkait.`).join('\n\n');
  const entries = [
    E('a', 'Profil', filler('a')),
    E('b', 'Harga paket', 'Paket hemat Rp 50.000 per bulan.\n\nPaket premium Rp 120.000 per bulan.'),
    E('c', 'Lainnya', filler('c')),
  ];
  const r = buildContext(entries, 'berapa harga paket premium?', { maxChars: 300 });
  assert.ok(r.text.length <= 300, `panjang ${r.text.length}`);
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes('Rp 120.000'));
  assert.ok(!r.text.includes('Catatan umum nomor a'));
  assert.ok(!r.text.includes('Catatan umum nomor c'));
  assert.equal(r.used, 1);
});

test('buildContext: judul melekat pada tiap potongan', () => {
  const entries = [E('b', 'Harga paket', 'Paket hemat Rp 50.000.\n\nPaket premium Rp 120.000.'), E('x', 'Lain', 'z '.repeat(400))];
  const r = buildContext(entries, 'harga premium hemat', { maxChars: 250 });
  const heads = r.text.split('\n\n').filter((p) => p.startsWith('### '));
  assert.ok(heads.length >= 2);
  assert.ok(heads.every((h) => h.startsWith('### Harga paket\n')));
});

test('buildContext: query kosong atau hanya kata henti -> ambil dari awal sesuai urutan', () => {
  const entries = Array.from({ length: 10 }, (_, i) => E(`e${i}`, `Entri ${i}`, `Isi entri ${i} `.repeat(10).trim()));
  for (const q of ['', '   ', null, undefined, 'apa yang dan di']) {
    const r = buildContext(entries, q, { maxChars: 450 });
    assert.ok(r.text.length <= 450);
    assert.equal(r.truncated, true);
    assert.ok(r.used >= 1 && r.used < 10);
    assert.ok(r.text.startsWith('### Entri 0\n'), String(q));
    const nums = [...r.text.matchAll(/### Entri (\d+)\n/g)].map((m) => Number(m[1]));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b)); // berurutan dari awal
    assert.equal(nums[0], 0);
  }
});

test('buildContext: entri nonaktif diabaikan (juga bila cocok dengan query)', () => {
  const entries = [E('1', 'Rahasia diskon', 'Diskon 90 persen khusus.', { enabled: false }), E('2', 'Alamat', 'Jl. Melati 5.')];
  const r = buildContext(entries, 'diskon', { maxChars: 5000 });
  assert.equal(r.used, 1);
  assert.ok(!r.text.includes('Diskon 90'));
  assert.ok(!r.text.includes('Rahasia'));
  // juga di jalur potongan
  const big = [...entries, E('3', 'Panjang', 'kata '.repeat(500))];
  const r2 = buildContext(big, 'diskon', { maxChars: 300 });
  assert.ok(!r2.text.includes('Diskon 90'));
  assert.deepEqual(buildContext([E('1', 'A', 'b', { enabled: false })], 'a'), { text: '', used: 0, truncated: false });
});

test('buildContext: bobot judul lebih tinggi dari isi', () => {
  const entries = [
    E('1', 'Lainnya', 'Catatan: soal garansi tanyakan teknisi.'),
    E('2', 'Garansi', 'Berlaku satu tahun sejak pembelian.'),
  ];
  const r = buildContext(entries, 'garansi', { maxChars: 75 });
  assert.equal(r.truncated, true);
  assert.equal(r.used, 1);
  assert.ok(r.text.includes('Berlaku satu tahun'));
  assert.ok(!r.text.includes('teknisi'));
});

test('buildContext: urutan stabil dan hasil deterministik; potongan terpilih tampil sesuai urutan asli', () => {
  const entries = [
    E('1', 'Satu', 'Pengiriman memakai kurir A.'),
    E('2', 'Dua', 'Pengiriman memakai kurir B.'),
    E('3', 'Tiga', 'Pengiriman memakai kurir C.'),
    E('4', 'Empat', 'Teks panjang tidak terkait. '.repeat(30)),
  ];
  const a = buildContext(entries, 'pengiriman kurir', { maxChars: 90 });
  const b = buildContext(entries, 'pengiriman kurir', { maxChars: 90 });
  assert.deepEqual(a, b);
  // skor sama -> yang awal menang bila hanya muat dua; tampilan tetap urut asli
  assert.equal(a.used, 2);
  assert.ok(a.text.indexOf('kurir A') >= 0 && a.text.indexOf('kurir B') > a.text.indexOf('kurir A'));
  assert.ok(!a.text.includes('kurir C'));
});

test('buildContext: teks Indonesia berimbuhan dan singkatan cocok dengan kata dasar', () => {
  const pad = E('pad', 'Tentang kami', 'Kami toko perlengkapan rumah tangga. '.repeat(15));
  const target = (title, body) => E('t', title, body);
  const cases = [
    ['bagaimana pengiriman barangnya?', target('Ongkos', 'Kami kirim memakai kurir reguler.'), 'kurir reguler'],
    ['cara membayar gimana', target('Metode', 'Pembayaran lewat transfer bank.'), 'transfer bank'],
    ['harganya berapa', target('Daftar', 'Harga mulai Rp 25.000.'), 'Rp 25.000'],
    ['sudah dikirimkan belum', target('Resi', 'Barang kami kirim setiap hari.'), 'setiap hari'],
    ['hrg paketnya brp', target('Paket', 'Harga paket Rp 90.000.'), 'Rp 90.000'],
    ['bisa pesanan lewat wa?', target('Cara pesan', 'Memesan cukup chat WhatsApp.'), 'chat WhatsApp'],
    ['pembayarannya kapan', target('Bayar', 'Anda bisa bayar saat barang tiba.'), 'saat barang tiba'],
  ];
  for (const [q, entry, expected] of cases) {
    const r = buildContext([pad, entry], q, { maxChars: 200 });
    assert.ok(r.text.includes(expected), `${q} -> ${r.text}`);
    assert.ok(!r.text.includes('Kami toko'), `${q}: konteks tidak relevan ikut terpilih`);
  }
});

test('buildContext: tidak cocok dengan kata yang hanya mirip secara kebetulan', () => {
  const entries = [E('1', 'Alamat', 'Jl. Melati 5.'), E('2', 'Panjang', 'kata lain '.repeat(100))];
  // tidak ada kecocokan -> jatuh ke urutan awal, bukan memilih entri acak berdasarkan kebetulan
  const r = buildContext(entries, 'xyzzy plugh', { maxChars: 200 });
  assert.ok(r.text.startsWith('### Alamat\n'));
});

test('buildContext: paragraf panjang dipecah di batas kalimat dan tetap muat', () => {
  const sentence = 'Kalimat contoh yang cukup panjang untuk diuji pemecahan.';
  const para = Array.from({ length: 40 }, (_, i) => `${sentence} ${i}.`).join(' ');
  const r = buildContext([E('1', 'Panjang', para), E('2', 'Kedua', para)], 'pemecahan', { maxChars: 400 });
  assert.ok(r.text.length <= 400);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length > 0);
  for (const piece of r.text.split('\n\n')) assert.ok(piece.startsWith('### '));
  // satu kata tanpa spasi yang sangat panjang tetap dipotong keras dan tidak melampaui batas
  const r2 = buildContext([E('1', 'X', 'a'.repeat(5000)), E('2', 'Y', 'b'.repeat(5000))], 'a', { maxChars: 300 });
  assert.ok(r2.text.length <= 300);
});

test('buildContext: maxChars terlalu kecil untuk apa pun -> kosong dan terpotong', () => {
  const r = buildContext([E('1', 'Judul', 'Isi cukup panjang untuk tidak muat.')], 'isi', { maxChars: 10 });
  assert.deepEqual(r, { text: '', used: 0, truncated: true });
});

test('buildContext: karakter kontrol dan akhir baris CRLF tidak mengganggu', () => {
  const entries = [E('1', 'Jam\u0000 buka', 'Senin\r\nSelasa\u0007\r\n\r\nRabu')];
  const r = buildContext(entries, 'jam', { maxChars: 5000 });
  assert.equal(r.text, '### Jam buka\nSenin\nSelasa\n\nRabu');
  assert.ok(!/[\u0000-\u0008\r]/.test(r.text));
});

test('buildContext: tidak mengubah masukan', () => {
  const entries = [E('1', 'A', 'isi a\r\n\r\nisi b'), E('2', 'B', 'x '.repeat(300))];
  const snapshot = JSON.stringify(entries);
  buildContext(entries, 'isi', { maxChars: 120 });
  assert.equal(JSON.stringify(entries), snapshot);
});

// ---------- validateEntries ----------

test('validateEntries: entri sah dirapikan; id dibuat bila kosong; enabled bawaan true; kolom lain dibuang', () => {
  const input = [
    { id: 'k1', title: '  Alamat  ', content: ' Jl. Melati 5 ', extra: 'x' },
    { title: 'Jam', content: 'Senin-Sabtu', enabled: false },
    { id: '', title: 'Retur', content: '7 hari', enabled: null },
  ];
  const r = validateEntries(input, { genId: seqGen() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.entries, [
    { id: 'k1', title: 'Alamat', content: 'Jl. Melati 5', enabled: true },
    { id: 'gen1', title: 'Jam', content: 'Senin-Sabtu', enabled: false },
    { id: 'gen2', title: 'Retur', content: '7 hari', enabled: true },
  ]);
  assert.equal(input[0].title, '  Alamat  '); // masukan tidak diubah
});

test('validateEntries: id bawaan acak unik dan tidak bertabrakan dengan id yang sudah ada', () => {
  const r = validateEntries([E('', 'A', 'a'), E('', 'B', 'b'), E('kb_tetap', 'C', 'c')]);
  assert.equal(r.ok, true);
  const ids = r.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((id) => /^[\w.:-]+$/.test(id)));
  // generator yang bertabrakan dengan id sah tetap menghasilkan id unik
  const r2 = validateEntries([E('gen1', 'A', 'a'), E('', 'B', 'b')], { genId: seqGen() });
  assert.deepEqual(r2.entries.map((e) => e.id), ['gen1', 'gen2']);
});

test('validateEntries: id ganda dan id tidak valid ditolak', () => {
  const dup = validateEntries([E('x', 'A', 'a'), E('x', 'B', 'b')]);
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((m) => m.includes('#2') && m.includes('id')));
  assert.equal(dup.entries.length, 1);
  for (const id of ['a b', 'a/b', 'x'.repeat(65), 42, {}]) {
    const r = validateEntries([E(id, 'A', 'a')]);
    assert.equal(r.ok, false, JSON.stringify(id));
  }
});

test('validateEntries: entri kosong dibuang tanpa error; judul atau isi saja -> error', () => {
  const r = validateEntries([
    E('1', 'A', 'a'), { id: '2', title: '   ', content: '\n\t ' }, {}, { id: '3', title: '\u0000', content: '\u0007' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);

  const noTitle = validateEntries([{ id: '1', title: '', content: 'isi' }]);
  assert.equal(noTitle.ok, false);
  assert.ok(noTitle.errors[0].includes('judul'));
  const noContent = validateEntries([{ id: '1', title: 'Judul', content: '  ' }]);
  assert.equal(noContent.ok, false);
  assert.ok(noContent.errors[0].includes('isi'));
  assert.deepEqual(noContent.entries, []);
});

test('validateEntries: karakter kontrol dihilangkan, akhir baris dinormalkan, judul satu baris', () => {
  const r = validateEntries([{ id: '1', title: 'Jam\u0000\n buka\u202E', content: 'A\u0001B\r\nC\rD\u200Bz\tz' }]);
  assert.equal(r.ok, true);
  assert.equal(r.entries[0].title, 'Jam buka');
  assert.equal(r.entries[0].content, 'AB\nC\nDz z');
});

test('validateEntries: batas jumlah, ukuran isi, ukuran judul, dan total', () => {
  const L = KNOWLEDGE_LIMITS;
  assert.deepEqual([L.maxEntries, L.maxContentChars, L.maxTotalChars], [200, 20000, 200000]);

  const many = Array.from({ length: 201 }, (_, i) => E(`e${i}`, `T${i}`, 'x'));
  assert.equal(validateEntries(many).ok, false);
  assert.equal(validateEntries(many.slice(0, 200)).ok, true);

  assert.equal(validateEntries([E('1', 'A', 'x'.repeat(20000))]).ok, true);
  const tooLong = validateEntries([E('1', 'A', 'x'.repeat(20001))]);
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.errors[0].includes('20000'));
  assert.equal(validateEntries([E('1', 'T'.repeat(201), 'x')]).ok, false);

  const okTotal = Array.from({ length: 10 }, (_, i) => E(`e${i}`, `T${i}`, 'x'.repeat(20000)));
  assert.equal(validateEntries(okTotal).ok, true); // tepat 200.000
  const overTotal = [...okTotal, E('z', 'Z', 'x')];
  const r = validateEntries(overTotal);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes('Total')));

  // entri kosong tidak dihitung sebagai entri
  const withEmpty = [...many.slice(0, 200), {}, { title: '', content: '' }];
  assert.equal(validateEntries(withEmpty).ok, true);
});

test('validateEntries: bukan daftar / bukan objek / enabled bukan boolean', () => {
  for (const bad of [null, undefined, {}, 'x', 5]) {
    const r = validateEntries(bad);
    assert.equal(r.ok, false);
    assert.deepEqual(r.entries, []);
    assert.equal(r.errors.length, 1);
  }
  const r = validateEntries(['teks', null, [], E('1', 'A', 'a')]);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
  assert.equal(r.entries.length, 1);
  assert.equal(validateEntries([E('1', 'A', 'a', { enabled: 'false' })]).ok, false);
});

test('validateEntries: pesan error tidak memuat isi entri', () => {
  const secret = 'RAHASIA-INTERNAL-12345';
  const r = validateEntries([{ id: 'bad id', title: secret, content: secret.repeat(2000) }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.every((m) => !m.includes(secret)));
});

test('validateEntries -> buildContext: hasil validasi bisa langsung dipakai', () => {
  const v = validateEntries([E('', 'Harga', 'Rp 10.000'), E('', 'Retur', 'Tujuh hari', { enabled: false })], { genId: seqGen() });
  assert.equal(v.ok, true);
  const r = buildContext(v.entries, 'harga', { maxChars: 1000 });
  assert.equal(r.used, 1);
  assert.ok(r.text.includes('Rp 10.000'));
});
