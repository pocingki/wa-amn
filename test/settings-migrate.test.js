// Uji migrasi file pengaturan lama: tanpa version/priority/type, intents/slangMap -> basis pengetahuan,
// requiredFields lama -> satu butir 'referensi'. Idempoten, tidak menimpa data baru, ada catatan di riwayat versi,
// dan data lead tidak tersentuh.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AMNAN_NO_BACKUP = '1';
delete process.env.AI_API_KEY;
delete process.env.DATA_KEY;
const OPENING_LAMA = 'Halo {nama}, selamat datang. Saya {bot}, asisten virtual yang membantu {admin}. Ada yang bisa kami bantu?';
const tmpDirs = [];
let n = 0;

// Siapkan folder data baru (dengan/ tanpa settings.json lama), lalu muat modul settings yang segar.
async function fresh(legacy, { before } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amnan-set-m-'));
  tmpDirs.push(dir);
  process.env.DATA_DIR = dir;
  if (legacy) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(legacy));
  if (before) await before(dir);
  const s = await import(`../src/settings.js?m=${++n}`);
  return { s, dir, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}
const reload = async (dir) => {
  process.env.DATA_DIR = dir;
  return import(`../src/settings.js?m=${++n}`);
};

// ---- 1. file lama lengkap ----
const legacy = {
  brandName: 'Klinikku',
  openingMessage: OPENING_LAMA,
  fallbackMessage: 'Kustom saya',
  version: 3,
  updatedAt: 1700000000000,
  updatedBy: 'budi',
  slangMap: { gk: 'tidak' },
  intents: [
    { id: 'harga', name: 'Tanya harga', keywords: ['harga', 'biaya'], response: 'Facial Rp 150.000', active: true, priority: 5 },
    { id: 'x', name: 'X', keywords: ['x'], response: 'jawab', active: false },
    { id: 'jadwal', name: 'Jadwal & jam buka', keywords: ['jadwal'], response: '[ISI: jadwal dan jam buka]', active: false, example: true },
    { id: 'tanpa-nama', name: '', keywords: ['lokasi', 'alamat'], response: 'Jl. Mawar 1\nLantai 2', active: true },
    { id: 'kosong', name: 'Kosong', keywords: ['k'], response: '' },
  ],
  requiredFields: [
    { id: 'nama', label: 'Nama', question: 'Siapa?', enabled: true },
    { id: 'usia', label: 'Usia', question: 'Umur?', enabled: true },
  ],
};

// data lead (bila penyimpanan lead bisa dimuat di lingkungan ini) + berkas penjaga: tidak boleh berubah
let store = null;
let lead = null;
const sentinel = JSON.stringify({ leads: [{ phone: '6281', data: { nama: 'Budi', usia: '30' } }] });
const A = await fresh(legacy, {
  before: async (dir) => {
    fs.writeFileSync(path.join(dir, 'leads-sentinel.json'), sentinel);
    try {
      store = await import('../src/store.js');
      lead = store.add({ name: 'Budi', phone: '6281', data: { nama: 'Budi', usia: '30' } });
    } catch { store = null; }
  },
});
{
  const { s } = A;
  const c = s.get();
  assert.equal(c.version, 4); // versi lama 3 -> migrasi tersimpan sebagai versi baru
  assert.equal(c.updatedBy, 'migrasi');
  assert.equal(c.brandName, 'Klinikku');
  assert.equal(c.fallbackMessage, 'Kustom saya'); // pengaturan pengguna dipertahankan
  assert.equal(c.openingMessage, s.DEFAULTS.openingMessage); // teks lama diganti baru
  assert.ok(!('intents' in c) && !('slangMap' in c));
  assert.equal(c.staleMinutes, 10);
  assert.equal(c.notify.attentionMinutes, 30);
  assert.equal(c.phoneFormat, 'digits');
  assert.equal(c.greetingWords.length, 19);
  assert.deepEqual(c.ai, s.DEFAULTS.ai);

  // intent -> knowledge: isi terjaga; contoh kosong ("[ISI: ...]") dan intent tanpa respons tidak dipindah
  assert.deepEqual(c.knowledge, [
    { id: 'intent-harga', title: 'Tanya harga', content: 'Pertanyaan: harga, biaya\nJawaban: Facial Rp 150.000', enabled: true },
    { id: 'intent-x', title: 'X', content: 'Pertanyaan: x\nJawaban: jawab', enabled: false },
    { id: 'intent-tanpa-nama', title: 'lokasi, alamat', content: 'Pertanyaan: lokasi, alamat\nJawaban: Jl. Mawar 1\nLantai 2', enabled: true },
  ]);

  // field lama keluar; hanya 'referensi'
  assert.deepEqual(c.requiredFields, s.DEFAULTS.requiredFields);

  // tersimpan di disk tanpa skema lama
  const disk = JSON.parse(A.read('settings.json'));
  assert.equal(disk.version, 4);
  assert.ok(!('intents' in disk) && !('slangMap' in disk));
  assert.equal(disk.knowledge.length, 3);

  // catatan di riwayat versi; snapshot sebelum migrasi masih memuat data lama (tidak ada yang hilang)
  const h = s.history();
  assert.equal(h.length, 1);
  assert.equal(h[0].version, 3);
  assert.equal(h[0].by, 'budi');
  assert.match(h[0].note, /3 intent lama dipindahkan ke basis pengetahuan/);
  assert.match(h[0].note, /1 contoh intent yang belum diisi dibuang/);
  assert.match(h[0].note, /data wajib disederhanakan/);
  const raw = JSON.parse(A.read('settings.history.json'));
  assert.equal(raw[0].settings.intents.length, 5);
  assert.deepEqual(raw[0].settings.slangMap, { gk: 'tidak' });
  assert.equal(raw[0].settings.requiredFields.length, 2);

  // field lama keluar TANPA menghapus data lead
  assert.equal(A.read('leads-sentinel.json'), sentinel);
  if (store) {
    const l = store.all().find((x) => x.id === lead.id);
    assert.deepEqual(l.data, { nama: 'Budi', usia: '30' });
    store.flush?.();
  } else console.log('  (penyimpanan lead tidak bisa dimuat di sini: pemeriksaan data lead hanya lewat berkas penjaga)');

  // restore ke versi sebelum migrasi tidak menghidupkan lagi skema lama dan tidak menghapus knowledge
  const r = s.restore(3, { by: 'adm' });
  assert.equal(r.version, 5);
  assert.ok(!('intents' in r) && !('slangMap' in r));
  assert.equal(r.knowledge.length, 3);
  assert.deepEqual(r.requiredFields, s.DEFAULTS.requiredFields);
  assert.equal(r.brandName, 'Klinikku');
}

// ---- 2. idempoten: muat ulang folder yang sama -> tidak ada migrasi lagi ----
{
  const before = { settings: A.read('settings.json'), history: A.read('settings.history.json') };
  const s2 = await reload(A.dir);
  assert.equal(A.read('settings.json'), before.settings);
  assert.equal(A.read('settings.history.json'), before.history);
  assert.equal(s2.get().knowledge.length, 3);
  assert.equal(s2.get().version, 5);
}

// ---- 3. tidak menimpa data baru: entri knowledge dengan id sama dipertahankan ----
{
  const { s } = await fresh({
    knowledge: [{ id: 'intent-harga', title: 'Harga baru', content: 'versi baru', enabled: true }],
    intents: [
      { id: 'harga', name: 'Harga lama', keywords: ['harga'], response: 'lama', active: true },
      { id: 'lain', name: 'Lain', keywords: ['lain'], response: 'r', active: true },
    ],
  });
  const k = s.get().knowledge;
  assert.deepEqual(k.map((x) => x.id), ['intent-harga', 'intent-lain']);
  assert.equal(k[0].content, 'versi baru');
  assert.match(s.history()[0].note, /1 intent dilewati/);
}

// ---- 4. tanpa version/priority/type (file sangat lama) ----
{
  const { s } = await fresh({
    brandName: 'Klinikku',
    intents: [{ id: 'x', name: 'X', keywords: ['x'], response: 'jawab', active: true }],
    requiredFields: [{ id: 'nama', label: 'Nama', question: 'Siapa?', enabled: true }, { id: 'usia', label: 'Usia', question: 'Umur?', enabled: true }],
  });
  assert.equal(s.get().version, 2); // tanpa version dianggap 1, migrasi -> 2
  assert.deepEqual(s.get().knowledge.map((x) => x.id), ['intent-x']);
  assert.deepEqual(s.get().requiredFields, s.DEFAULTS.requiredFields);
}

// ---- 5. hanya requiredFields lama (tanpa intent): 'referensi' kustom dipertahankan ----
{
  const { s } = await fresh({
    version: 2,
    requiredFields: [{ id: 'nama', label: 'Nama', question: 'Siapa?', enabled: true }, { id: 'referensi', label: 'Ref', question: 'Dari mana?', enabled: false, type: 'text', options: [] }],
  });
  assert.deepEqual(s.get().requiredFields, [{ id: 'referensi', type: 'text', enabled: false, question: 'Dari mana?' }]);
  assert.equal(s.get().version, 3);
  assert.match(s.history()[0].note, /satu butir 'referensi'/);
  assert.ok(!/intent/.test(s.history()[0].note));
}

// ---- 6. berkas sudah skema baru / belum ada: tidak ada tulisan saat dimuat ----
{
  const { s, dir } = await fresh(null);
  assert.equal(s.get().version, 1);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'settings.history.json')), false);
  const upd = s.update({ brandName: 'Baru' }, { by: 'x' });
  const again = await reload(dir);
  assert.equal(again.get().version, upd.version);
  assert.equal(again.history().length, 1);
  assert.ok(!('note' in again.history()[0]));
}

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows bisa menahan berkas sebentar */ } }
console.log('settings-migrate.test.js OK');
