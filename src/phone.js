// Pembantu nomor telepon: fungsi murni tanpa efek samping dan tanpa dependensi.
// Nomor kanonik = angka saja berawalan kode negara (mis. 6281381688802). ID pengganti (LID/BSUID) bukan nomor.

const MIN_DIGITS = 9;
const MAX_DIGITS = 15;
// Huruf atau "@" = ID pengganti (mis. "123@lid", BSUID "US.1349..."), bukan nomor telepon.
const SURROGATE_RE = /[a-z@]/i;
// ASUMSI: awalan 8 tanpa 0/62 dianggap nomor lokal Indonesia (813… -> 62813…) hanya bila digit kedua
// 1/2/3/5/7/8/9 (awalan seluler Indonesia) dan panjang <= 12. Ini mencegah 84…/86… (Vietnam/Tiongkok)
// salah diberi 62. Awalan 81/82 (Jepang/Korea) tetap ambigu dan dibaca sebagai Indonesia.
// Belum terverifikasi sama persis dengan normalisasi di Acesio.
const LOCAL_ID = /^8[1235789]\d*$/;
const LOCAL_ID_MAX = 12;

/** Angka saja (buang spasi, +, -, kurung, dll.); awalan tidak diubah. null/undefined -> ''. */
export function digitsOf(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\D/g, '');
}

/** Angka kanonik berawalan kode negara, atau '' bila tidak masuk akal / ID pengganti. */
export function canonicalPhone(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  if (SURROGATE_RE.test(raw)) return '';
  let d = digitsOf(raw);
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2); // 0062… / 0044… -> buang awalan internasional
  if (d.startsWith('620')) d = '62' + d.slice(3); // "+62 (0)813…" -> 62813…
  else if (d.startsWith('0')) d = '62' + d.slice(1); // 0813… -> 62813…
  else if (LOCAL_ID.test(d) && d.length <= LOCAL_ID_MAX) d = '62' + d; // 813… -> 62813…
  return d.length >= MIN_DIGITS && d.length <= MAX_DIGITS ? d : '';
}

/** Format tampilan. 'digits' (bawaan/tak dikenal) = angka saja; 'international' = "+62 813-8168-8802". */
export function formatPhone(digits, format = 'digits') {
  if (digits === null || digits === undefined) return '';
  if (SURROGATE_RE.test(String(digits))) return ''; // ID pengganti tidak ditampilkan sebagai nomor
  if (format !== 'international') return digitsOf(digits);
  const c = canonicalPhone(digits);
  if (!c) return digitsOf(digits); // tidak bisa dikanonikkan: tampilkan apa adanya (angka saja)
  if (!c.startsWith('62')) return `+${c}`;
  const rest = c.slice(2);
  const parts = [rest.slice(0, 3), rest.slice(3, 7), rest.slice(7)].filter(Boolean);
  return `+62 ${parts.join('-')}`;
}

/** Dua nomor sama bila kanoniknya sama. Bila salah satu tidak valid/kosong -> false. */
export function samePhone(a, b) {
  const ca = canonicalPhone(a);
  return ca !== '' && ca === canonicalPhone(b);
}
