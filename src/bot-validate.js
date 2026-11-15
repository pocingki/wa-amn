// Validasi jawaban pelanggan, normalisasi teks, dan deteksi salam/pertanyaan. Fungsi murni tanpa I/O.

const DEFAULT_SLANG = {
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

/** Normalisasi: huruf kecil, tanpa aksen/tanda baca, huruf berulang dipadatkan, slang diganti. */
export function normalizeText(text, slangMap = {}) {
  const slang = { ...DEFAULT_SLANG };
  for (const [k, v] of Object.entries(slangMap || {})) {
    const key = base(k);
    if (key) slang[key] = String(v ?? '').toLowerCase().trim(); // slangMap menang
  }
  return base(text)
    .split(' ')
    .filter(Boolean)
    .map((t) => (Object.hasOwn(slang, t) ? slang[t] : t))
    .filter(Boolean)
    .join(' ');
}

/** Nomor telepon: digit saja, awalan 0 -> 62, 8-15 digit; selain itu null. */
export function normPhone(p) {
  let d = String(p ?? '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

const SKIP = new Set(['lewati', 'skip', 'nanti', 'nanti dulu', 'tidak mau', 'gak mau', 'ga mau', 'nggak mau', 'ga usah', 'gak usah', 'nggak usah']);

export function isSkip(text) {
  const t = String(text ?? '').toLowerCase().trim().replace(/[\s.!?,;:]+$/, '').replace(/\s+/g, ' ');
  return SKIP.has(t);
}

const QUESTION_WORDS = new Set(['apa', 'apakah', 'bagaimana', 'gimana', 'berapa', 'dimana', 'kapan', 'bisa', 'boleh', 'ada', 'kenapa', 'mengapa', 'siapa']);

/** Pesan tampak seperti pertanyaan: ada tanda tanya, atau kata tanya di awal. Hanya dari teks. */
export function isQuestion(text) {
  if (String(text ?? '').includes('?')) return true;
  const tokens = normalizeText(text).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  return QUESTION_WORDS.has(tokens[0]) || (tokens[0] === 'di' && tokens[1] === 'mana');
}

// ---- Salam (pembuka) ----
// Bawaan sama dengan S.greetingWords bawaan (settings.js, B7); dipakai bila daftar tidak diberikan.
export const DEFAULT_GREETING_WORDS = [
  'halo', 'hallo', 'hai', 'hi', 'hello', 'hey', 'permisi', 'assalamualaikum', "assalamu'alaikum", 'salam',
  'selamat pagi', 'selamat siang', 'selamat sore', 'selamat malam', 'pagi', 'siang', 'sore', 'malam', 'p',
];

// Sapaan pendamping yang tidak dihitung sebagai isi pertanyaan ("halo kak" = salam saja).
const ADDRESS_WORDS = new Set(['kak', 'kakak', 'ka', 'kk', 'min', 'admin', 'mas', 'mba', 'mbak', 'bu', 'ibu', 'pak', 'bapak', 'om', 'tante', 'sis', 'ya', 'dong', 'nih', 'semua', 'semuanya']);

// Daftar kata salam -> frasa token ternormalisasi (tanpa duplikat; kosong dibuang).
function greetingPhrases(words) {
  const list = Array.isArray(words) && words.length ? words : DEFAULT_GREETING_WORDS;
  const seen = new Set();
  const out = [];
  for (const w of list) {
    const tokens = base(w).split(' ').filter(Boolean);
    const key = tokens.join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(tokens);
  }
  return out;
}

const startsWithAt = (tokens, i, phrase) => i + phrase.length <= tokens.length && phrase.every((w, j) => tokens[i + j] === w);

/**
 * Pesan berisi salam: salah satu kata/frasa salam muncul seluruhnya di 3 kata pertama.
 * "p" hanya dihitung bila seluruh pesan hanya "p". Teks dinormalkan dulu (huruf kecil, tanpa tanda baca).
 */
export function isGreeting(text, greetingWords) {
  const tokens = base(text).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  const head = tokens.slice(0, 3);
  for (const phrase of greetingPhrases(greetingWords)) {
    if (phrase.length === 1 && phrase[0] === 'p') {
      if (tokens.length === 1 && tokens[0] === 'p') return true;
      continue;
    }
    for (let i = 0; i < head.length; i++) if (startsWithAt(head, i, phrase)) return true;
  }
  return false;
}

/** Pesan HANYA salam (boleh dengan sapaan seperti "kak"/"min"), tanpa isi lain. */
export function isGreetingOnly(text, greetingWords) {
  const tokens = base(text).split(' ').filter(Boolean);
  if (!tokens.length || !isGreeting(text, greetingWords)) return false;
  const phrases = greetingPhrases(greetingWords).filter((p) => !(p.length === 1 && p[0] === 'p'));
  if (tokens.length === 1 && tokens[0] === 'p') return true;
  let i = 0;
  let sawGreeting = false;
  while (i < tokens.length) {
    // frasa terpanjang lebih dulu supaya "selamat pagi" tidak terbaca "selamat" + sisa
    const hit = phrases.filter((p) => startsWithAt(tokens, i, p)).sort((a, b) => b.length - a.length)[0];
    if (hit) {
      sawGreeting = true;
      i += hit.length;
    } else if (ADDRESS_WORDS.has(tokens[i])) i++;
    else return false;
  }
  return sawGreeting;
}

const no = (reason) => ({ ok: false, value: null, reason });
const yes = (value) => ({ ok: true, value, reason: null });

const NAME_PREFIX = /^(nama saya|panggil saja|panggil aja|nama|saya|aku)(?=\s|[:,-]|$)[\s:,-]*/i;
const MONTHS = new Set(['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'agu', 'agt', 'ags', 'agus', 'sep', 'sept', 'okt', 'nov', 'des',
  'january', 'february', 'march', 'may', 'june', 'july', 'august', 'october', 'december', 'aug', 'oct', 'dec']);
const DAYS = new Set(['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu', 'ahad']);

function validName(text) {
  let t = text.trim();
  for (let i = 0; i < 3 && NAME_PREFIX.test(t); i++) t = t.replace(NAME_PREFIX, '');
  t = t.replace(/[\s.,!]+$/, '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 60) return no('Nama harus 2-60 karakter. Boleh tulis nama Anda?');
  if (!/\p{L}/u.test(t)) return no('Nama harus berisi huruf. Boleh tulis nama Anda?');
  if (t.split(' ').length > 6) return no('Nama terlalu panjang. Cukup tulis nama panggilan Anda.');
  if (isQuestion(t)) return no('Sepertinya itu pertanyaan. Boleh kami tahu nama Anda dulu?');
  return yes(t);
}

function validDate(t) {
  if (!t) return no('Tanggal belum terbaca. Contoh: besok, Senin, atau 12/5.');
  if (t.length > 100) return no('Jawaban terlalu panjang. Cukup tulis tanggal atau harinya.');
  const low = t.toLowerCase();
  const tokens = normalizeText(low).split(' ');
  const ok =
    tokens.some((w) => MONTHS.has(w) || DAYS.has(w) || w === 'besok' || w === 'lusa') ||
    /hari\s*ini/.test(low) || /jum'?at/.test(low) ||
    /\b\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?\b/.test(low);
  return ok ? yes(t) : no('Tanggal belum terbaca. Contoh: besok, Senin, atau 12/5.');
}

function validChoice(field, t) {
  const opts = (field.options || []).map(String);
  if (!opts.length) return no('Pilihan belum tersedia.');
  const list = `Silakan pilih salah satu: ${opts.map((o, i) => `${i + 1}. ${o}`).join(', ')}.`;
  const num = t.match(/^(\d+)[\s.)]*$/);
  if (num) {
    const n = Number(num[1]);
    return n >= 1 && n <= opts.length ? yes(opts[n - 1]) : no(`Nomor tidak tersedia. ${list}`);
  }
  const low = t.toLowerCase();
  const exact = opts.find((o) => o.toLowerCase() === low);
  if (exact) return yes(exact);
  const contained = opts.filter((o) => low.includes(o.toLowerCase())).sort((a, b) => b.length - a.length);
  if (contained.length) return yes(contained[0]);
  if (low.length >= 3) { // jawaban singkat yang termuat di tepat satu opsi
    const part = opts.filter((o) => o.toLowerCase().includes(low));
    if (part.length === 1) return yes(part[0]);
  }
  return no(list);
}

/** Validasi jawaban sesuai field.type -> {ok, value, reason}. */
export function validateAnswer(field, text) {
  const t = String(text ?? '').trim();
  switch (field?.type) {
    case 'name': return validName(t);
    case 'phone': { const p = normPhone(t); return p ? yes(p) : no('Nomor telepon belum valid. Contoh: 081234567890.'); }
    case 'date': return validDate(t);
    case 'choice': return validChoice(field, t);
    default:
      if (!t) return no('Jawaban tidak boleh kosong.');
      return t.length > 500 ? no('Jawaban terlalu panjang (maksimal 500 karakter).') : yes(t);
  }
}
