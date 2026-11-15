// Basis pengetahuan AI: pemilih konteks (tanpa embedding) dan validasi entri. Fungsi murni, tanpa jaringan/DB.
// Normalisasi teks adalah SALINAN sendiri dari gaya src/bot-intent.js (file itu dihapus sesi B5, jangan diimpor).

import { randomUUID } from 'node:crypto';

/** Batas dari kontrak Setting (S.knowledge). Batas judul adalah ASUMSI sesi ini (tidak ada di kontrak). */
export const KNOWLEDGE_LIMITS = Object.freeze({
  maxEntries: 200,
  maxContentChars: 20000, // per entri (isi)
  maxTotalChars: 200000, // total isi semua entri
  maxTitleChars: 200,
  maxIdChars: 64,
});

const DEFAULT_MAX_CHARS = 12000;
const CHUNK_MAX = 1000; // ukuran potongan paragraf maksimal (karakter)
const MIN_PIECE = 20; // sisa ruang minimal untuk isi potongan
const MAX_QUERY_CHARS = 2000;
const HEADER = '### ';
const SEP = '\n\n';

// ---------- Normalisasi teks Indonesia (salinan ringkas gaya bot-intent.js) ----------

const SLANG = {
  hrg: 'harga', brp: 'berapa', tlg: 'tolong',
  gk: 'tidak', ga: 'tidak', gak: 'tidak', nggak: 'tidak', ngga: 'tidak', tdk: 'tidak',
  udh: 'sudah', sdh: 'sudah', udah: 'sudah', bsk: 'besok', jd: 'jadi',
  gmn: 'bagaimana', bgmn: 'bagaimana', dmn: 'dimana', knp: 'kenapa',
  yg: 'yang', dgn: 'dengan', utk: 'untuk', kpn: 'kapan',
  trims: 'terima kasih', tks: 'terima kasih', thx: 'thanks',
};

const base = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // buang aksen
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/([a-z])\1{2,}/g, '$1') // "hargaaa" -> "harga"; "aa" tetap
    .trim();

/** Normalisasi: huruf kecil, tanpa aksen/tanda baca, huruf berulang dipadatkan, singkatan umum diganti. */
export function normalizeText(text) {
  return base(text)
    .split(' ')
    .filter(Boolean)
    .map((t) => (Object.hasOwn(SLANG, t) ? SLANG[t] : t))
    .filter(Boolean)
    .join(' ');
}

// Kata henti sederhana (sudah dalam bentuk ternormalisasi); hanya dibuang dari query.
const STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'ini', 'itu', 'apa', 'apakah', 'adalah', 'akan',
  'ada', 'atau', 'saya', 'aku', 'kami', 'kita', 'anda', 'kamu', 'kak', 'kakak', 'min', 'admin', 'mau', 'bisa',
  'boleh', 'tidak', 'ya', 'iya', 'dong', 'deh', 'sih', 'nih', 'tolong', 'mohon', 'pada', 'sudah', 'belum',
  'juga', 'saja', 'aja', 'lagi', 'kalau', 'kalo', 'jika', 'agar', 'supaya', 'oleh', 'para', 'the', 'bagaimana',
  'gimana', 'kenapa', 'halo', 'hai', 'hi', 'selamat', 'pagi', 'siang', 'sore', 'malam', 'makasih', 'thanks',
  'terima', 'kasih', 'ok', 'oke', 'sama', 'lah', 'kok', 'ga', 'gak',
]);

// ---------- Pemadanan kata berimbuhan (stem sederhana) ----------

const PARTICLES = ['lah', 'kah', 'pun'];
const POSSESSIVES = ['nya', 'ku', 'mu'];
const DERIVATIVES = ['kan', 'an', 'i'];
// [awalan, kemungkinan huruf awal kata dasar yang luluh]
const PREFIXES = [
  ['meng', ['', 'k']], ['meny', ['s']], ['men', ['', 't']], ['mem', ['', 'p']], ['me', ['']],
  ['peng', ['', 'k']], ['peny', ['s']], ['pen', ['', 't']], ['pem', ['', 'p']], ['pe', ['']],
  ['ber', ['']], ['ter', ['']], ['per', ['']], ['di', ['']], ['ke', ['']], ['se', ['']],
];
const MIN_ROOT = 4; // kata dasar kandidat minimal 4 huruf, supaya tidak ada kecocokan sembarang

function stripSuffixes(token) {
  let set = new Set([token]);
  for (const list of [PARTICLES, POSSESSIVES, DERIVATIVES]) {
    const next = new Set(set);
    for (const s of set) {
      for (const suf of list) {
        if (s.endsWith(suf) && s.length - suf.length >= MIN_ROOT) next.add(s.slice(0, -suf.length));
      }
    }
    set = next;
  }
  return set;
}

function stripPrefixes(words) {
  let current = new Set(words);
  const all = new Set(words);
  for (let level = 0; level < 2; level++) { // mis. "diperbaiki": di- lalu per-
    const found = new Set();
    for (const w of current) {
      for (const [pre, reps] of PREFIXES) {
        if (!w.startsWith(pre)) continue;
        const rest = w.slice(pre.length);
        for (const rep of reps) {
          const cand = rep + rest;
          if (cand.length >= MIN_ROOT && !all.has(cand)) found.add(cand);
        }
      }
    }
    for (const f of found) all.add(f);
    current = found;
    if (!found.size) break;
  }
  return all;
}

/** Kunci pemadanan sebuah token: token itu sendiri + kandidat kata dasar (>= 4 huruf). */
function keysOf(token, cache) {
  const hit = cache.get(token);
  if (hit) return hit;
  const keys = new Set([token]);
  if (token.length >= MIN_ROOT && !/\d/.test(token)) {
    for (const c of stripPrefixes(stripSuffixes(token))) keys.add(c);
  }
  cache.set(token, keys);
  return keys;
}

const intersects = (a, b) => {
  for (const k of a) if (b.has(k)) return true;
  return false;
};

// ---------- Pembersihan teks ----------

// Karakter kontrol (kecuali \n), DEL, C1, BOM, spasi lebar nol, dan kontrol arah teks (bidi).
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\uFEFF\u202A-\u202E\u2066-\u2069]/g;

function cleanContent(v) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(BAD_CHARS, '')
    .trim();
}

function cleanTitle(v) {
  return cleanContent(v).replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// ---------- Memotong isi jadi potongan ----------

function hardSplit(s, room) {
  const out = [];
  let rest = s;
  while (rest.length > room) {
    let cut = rest.lastIndexOf(' ', room);
    if (cut < room * 0.5) cut = room;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--; // jangan memutus pasangan surrogate
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function packSentences(paragraph, room) {
  const sentences = paragraph.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    for (const piece of s.length > room ? hardSplit(s, room) : [s]) {
      if (cur && cur.length + 1 + piece.length <= room) cur += ' ' + piece;
      else {
        if (cur) out.push(cur);
        cur = piece;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Potongan = paragraf (dipisah baris kosong); paragraf terlalu panjang dipecah di batas kalimat.
function splitBody(content, room) {
  const out = [];
  for (const para of content.split(/\n[ \t]*\n+/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= room) out.push(p);
    else out.push(...packSentences(p, room));
  }
  return out;
}

// ---------- Pemberian skor ----------

function scoreChunks(chunks, query) {
  const cache = new Map();
  const qTokens = [...new Set(
    normalizeText(String(query ?? '').slice(0, MAX_QUERY_CHARS)).split(' ').filter((t) => t && !STOPWORDS.has(t)),
  )];
  for (const c of chunks) c.score = 0;
  if (!qTokens.length) return false;

  const qKeys = qTokens.map((q) => keysOf(q, cache));
  const titleKeys = new Map(); // per entri
  for (const c of chunks) {
    if (!titleKeys.has(c.ei)) titleKeys.set(c.ei, normalizeText(c.title).split(' ').filter(Boolean).map((t) => keysOf(t, cache)));
    const bodyKeys = normalizeText(c.body).split(' ').filter(Boolean).map((t) => keysOf(t, cache));
    c.hits = qKeys.map((qk) => ({
      occ: bodyKeys.reduce((n, k) => n + (intersects(k, qk) ? 1 : 0), 0),
      title: titleKeys.get(c.ei).some((k) => intersects(k, qk)),
    }));
  }
  // Bobot kata: kata yang jarang muncul di potongan lain lebih berharga.
  const weights = qTokens.map((_, i) => {
    const df = chunks.reduce((n, c) => n + (c.hits[i].occ || c.hits[i].title ? 1 : 0), 0);
    return Math.log(1 + (chunks.length + 1) / (df + 1));
  });
  let any = false;
  for (const c of chunks) {
    let s = 0;
    c.hits.forEach((h, i) => {
      s += weights[i] * (Math.min(h.occ, 3) + (h.title ? 3 : 0)); // judul berbobot lebih tinggi
    });
    c.score = s;
    if (s > 0) any = true;
    delete c.hits;
  }
  return any;
}

// ---------- API ----------

/**
 * Susun konteks basis pengetahuan untuk satu pesan customer.
 * Semua entri aktif dipakai bila muat; bila tidak, potongan terbaik menurut kata kunci query.
 * @returns {{ text: string, used: number, truncated: boolean }} used = jumlah entri yang terwakili
 */
export function buildContext(entries, query, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;

  const active = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object' || e.enabled === false) continue;
    const content = cleanContent(e.content);
    if (!content) continue;
    active.push({ title: cleanTitle(e.title) || 'Info', content });
  }
  if (!active.length) return { text: '', used: 0, truncated: false };

  // Jalur 1: semua entri utuh bila muat.
  const whole = active.map((a) => `${HEADER}${a.title}\n${a.content}`);
  const wholeLen = whole.reduce((n, s) => n + s.length, 0) + SEP.length * (whole.length - 1);
  if (wholeLen <= limit) return { text: whole.join(SEP), used: active.length, truncated: false };

  // Jalur 2: potongan (judul melekat di tiap potongan), dipilih menurut skor.
  const chunks = [];
  let skipped = false;
  active.forEach((a, ei) => {
    const shortTitle = a.title.length > 100 ? a.title.slice(0, 99) + '…' : a.title;
    const header = `${HEADER}${shortTitle}\n`;
    const room = Math.min(CHUNK_MAX, limit - header.length);
    if (room < MIN_PIECE) {
      skipped = true;
      return;
    }
    splitBody(a.content, room).forEach((piece, ci) => {
      chunks.push({ ei, ci, title: a.title, body: piece, text: header + piece, score: 0 });
    });
  });

  const anyScore = scoreChunks(chunks, query);
  // Ada yang cocok: hanya potongan yang cocok (hemat token). Tidak ada: ambil dari awal menurut urutan.
  const pool = anyScore ? chunks.filter((c) => c.score > 0) : chunks.slice();
  pool.sort((x, y) => (y.score - x.score) || (x.ei - y.ei) || (x.ci - y.ci));

  const picked = [];
  let used = 0;
  for (const c of pool) {
    const need = c.text.length + (picked.length ? SEP.length : 0);
    if (used + need > limit) continue; // coba potongan lain yang lebih kecil
    picked.push(c);
    used += need;
  }
  picked.sort((x, y) => (x.ei - y.ei) || (x.ci - y.ci)); // tampilkan dalam urutan asli

  return {
    text: picked.map((c) => c.text).join(SEP),
    used: new Set(picked.map((c) => c.ei)).size,
    truncated: skipped || picked.length < chunks.length,
  };
}

const defaultGenId = () => `kb_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/**
 * Validasi dan rapikan entri basis pengetahuan (batas di KNOWLEDGE_LIMITS).
 * Entri yang judul dan isinya sama-sama kosong dibuang diam-diam. Pesan error tidak memuat isi entri.
 * @returns {{ ok: boolean, errors: string[], entries: Array<{id:string,title:string,content:string,enabled:boolean}> }}
 */
export function validateEntries(entries, { genId = defaultGenId } = {}) {
  const L = KNOWLEDGE_LIMITS;
  if (!Array.isArray(entries)) return { ok: false, errors: ['Basis pengetahuan harus berupa daftar.'], entries: [] };
  if (entries.length > L.maxEntries * 5) {
    return { ok: false, errors: [`Terlalu banyak entri (maksimal ${L.maxEntries}).`], entries: [] };
  }

  const errors = [];
  const out = [];
  const ids = new Set();
  const pending = []; // entri tanpa id; id dibuat setelah semua id yang ada diketahui
  let total = 0;

  entries.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`Entri #${n}: format tidak valid.`);
      return;
    }
    const title = cleanTitle(raw.title);
    const content = cleanContent(raw.content);
    if (!title && !content) return; // entri kosong dibuang

    let bad = false;
    const fail = (msg) => {
      errors.push(`Entri #${n}: ${msg}`);
      bad = true;
    };
    if (!title) fail('judul wajib diisi.');
    else if (title.length > L.maxTitleChars) fail(`judul maksimal ${L.maxTitleChars} karakter.`);
    if (!content) fail('isi wajib diisi.');
    else if (content.length > L.maxContentChars) fail(`isi maksimal ${L.maxContentChars} karakter.`);

    let enabled = true;
    if (raw.enabled !== undefined && raw.enabled !== null) {
      if (typeof raw.enabled === 'boolean') enabled = raw.enabled;
      else fail('status aktif harus true atau false.');
    }

    let id = '';
    if (raw.id !== undefined && raw.id !== null && raw.id !== '') {
      id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!id || id.length > L.maxIdChars || !/^[\w.:-]+$/.test(id)) {
        fail('id tidak valid (huruf, angka, titik, titik dua, garis; maksimal 64 karakter).');
        id = '';
      } else if (ids.has(id)) {
        fail('id dipakai entri lain.');
      } else {
        ids.add(id);
      }
    }
    if (bad) return;

    const entry = { id, title, content, enabled };
    total += content.length;
    out.push(entry);
    if (!id) pending.push(entry);
  });

  if (out.length > L.maxEntries) errors.push(`Terlalu banyak entri (maksimal ${L.maxEntries}).`);
  if (total > L.maxTotalChars) errors.push(`Total isi melebihi ${L.maxTotalChars} karakter.`);

  for (const e of pending) {
    let id = genId();
    for (let tries = 0; ids.has(id) && tries < 20; tries++) id = genId();
    if (ids.has(id)) id = `${id}_${ids.size}`;
    ids.add(id);
    e.id = id;
  }

  return { ok: errors.length === 0, errors, entries: out };
}
