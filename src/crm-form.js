// Formulir data customer untuk agen CRM. Fungsi murni: tanpa I/O.
// Kolom mengikuti Acesio (GET /api/bot/customer-form). No RM dan SOAP TIDAK PERNAH ditanyakan.
// "Bulan" diisi otomatis oleh sistem (bulan customer pertama kali memakai layanan), bukan ditanyakan.

export const FORM_FIELDS = [
  { id: 'name', label: 'Nama', hint: '' },
  { id: 'gender', label: 'Jenis kelamin', hint: ' (Laki-laki / Perempuan)' },
  { id: 'birth_date', label: 'Tanggal lahir', hint: ' (contoh 31/12/1990)' },
  { id: 'occupation', label: 'Pekerjaan', hint: '' },
  { id: 'domicile', label: 'Domisili', hint: ' (kota/kecamatan)' },
  { id: 'referensi', label: 'Tahu kami dari mana', hint: ' (Instagram, TikTok, teman, dll.)' },
  // Booking: ditanyakan hanya bila agen diatur menanyakannya (lihat crm-agent.js).
  { id: 'booking_services', label: 'Layanan', hint: '' },
  { id: 'booking_day', label: 'Tanggal booking', hint: ' (contoh 29/11/2026)' },
  { id: 'booking_time', label: 'Jam booking', hint: ' (contoh 14:00)' },
];
export const BOOKING_IDS = ['booking_services', 'booking_day', 'booking_time'];
const BY_ID = Object.fromEntries(FORM_FIELDS.map((f) => [f.id, f]));
export const FORM_IDS = FORM_FIELDS.map((f) => f.id);
// Kolom yang tidak boleh ditanyakan ke customer, apa pun yang dikirim server.
export const FORBIDDEN = ['rm_no', 'medical_note', 'soap', 'reimburse', 'note'];

const ALIASES = {
  name: ['nama', 'nama lengkap'],
  gender: ['jenis kelamin', 'jk', 'gender', 'kelamin'],
  birth_date: ['tanggal lahir', 'tgl lahir', 'ttl', 'lahir'],
  occupation: ['pekerjaan', 'profesi', 'kerja'],
  domicile: ['domisili', 'alamat', 'kota', 'tinggal'],
  booking_services: ['layanan', 'jenis layanan', 'treatment', 'terapi'],
  booking_day: ['tanggal booking', 'tgl booking', 'tanggal', 'tgl', 'hari'],
  booking_time: ['jam booking', 'jam', 'waktu', 'pukul'],
  referensi: ['tahu kami dari mana', 'referensi', 'tau dari mana', 'tahu dari mana', 'sumber'],
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const LABELS = Object.entries(ALIASES).flatMap(([id, list]) => list.map((a) => [a, id])).sort((a, b) => b[0].length - a[0].length);
const labelToId = (raw) => LABELS.find(([a]) => a === norm(raw))?.[1] || null;

const MONTHS = { januari: 1, jan: 1, februari: 2, feb: 2, maret: 3, mar: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7, agustus: 8, agu: 8, agt: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11, desember: 12, des: 12 };
const pad = (n) => String(n).padStart(2, '0');

function dmy(d, m, y, nowYear) {
  if (y < 100) y += y > nowYear % 100 ? 1900 : 2000;
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > nowYear) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${pad(d)}/${pad(m)}/${y}`;
}

export function parseBirth(text, now = Date.now()) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  const ny = new Date(now).getUTCFullYear();
  let m;
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s))) return dmy(+m[1], +m[2], +m[3], ny);
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) return dmy(+m[3], +m[2], +m[1], ny);
  if ((m = /^(\d{1,2}) ([a-zA-Z]+)\.? (\d{4})$/.exec(s)) && MONTHS[m[2].toLowerCase()]) return dmy(+m[1], MONTHS[m[2].toLowerCase()], +m[3], ny);
  return null;
}

export function parseGenderText(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/[^a-z-]/g, '');
  if (['l', 'lk', 'laki', 'lakilaki', 'laki-laki', 'pria', 'cowok', 'male'].includes(s)) return 'L';
  if (['p', 'pr', 'perempuan', 'wanita', 'cewek', 'female'].includes(s)) return 'P';
  return null;
}

const WIB = 7 * 3600_000;
/** Tanggal hari ini (WIB) sebagai YYYY-MM-DD. */
export function todayYmd(now = Date.now()) { return new Date(now + WIB).toISOString().slice(0, 10); }

/** Tanggal booking -> YYYY-MM-DD, atau null. Menerima 29/11/2026, 29-11-26, 29 Nov 2026, 2026-11-29. */
export function parseDay(text, now = Date.now()) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  let y, mo, d, m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  else if ((m = /^(\d{1,2}) ([a-zA-Z]+)\.? (\d{4})$/.exec(s)) && MONTHS[m[2].toLowerCase()]) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** Jam booking -> HH:MM, atau null. Menerima 14:00, 14.00, jam 14, 9. */
export function parseTime(text) {
  const m = /^(?:jam|pukul)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:wib)?$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = +m[1], mi = m[2] === undefined ? 0 : +m[2];
  return h > 23 || mi > 59 ? null : `${pad(h)}:${pad(mi)}`;
}

const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Validasi satu nilai. Kembalikan { ok:true, value } atau { ok:false, why }. */
export function validate(id, raw, now = Date.now(), ctx = {}) {
  const v = oneLine(raw, 200);
  if (!v) return { ok: false, why: 'kosong' };
  if (/[?]$/.test(v) && v.length > 20) return { ok: false, why: 'pertanyaan' };
  switch (id) {
    case 'name': {
      const n = oneLine(v, 60);
      if (n.length < 2 || /\d/.test(n)) return { ok: false, why: 'Nama harus berupa huruf, minimal 2 karakter' };
      return { ok: true, value: n };
    }
    case 'gender': {
      const g = parseGenderText(v);
      return g ? { ok: true, value: g } : { ok: false, why: 'Jenis kelamin: tulis Laki-laki atau Perempuan' };
    }
    case 'birth_date': {
      const b = parseBirth(v, now);
      return b ? { ok: true, value: b } : { ok: false, why: 'Tanggal lahir belum sesuai, contoh 31/12/1990' };
    }
    case 'occupation': return v.length >= 2 ? { ok: true, value: oneLine(v, 100) } : { ok: false, why: 'Pekerjaan terlalu pendek' };
    case 'domicile': return v.length >= 2 ? { ok: true, value: oneLine(v, 150) } : { ok: false, why: 'Domisili terlalu pendek' };
    case 'referensi': return v.length >= 2 ? { ok: true, value: oneLine(v, 50) } : { ok: false, why: 'Sumber terlalu pendek' };
    case 'booking_day': {
      const d = parseDay(v, now);
      if (!d) return { ok: false, why: 'Tanggal booking belum sesuai, contoh 29/11/2026' };
      if (d < todayYmd(now)) return { ok: false, why: 'Tanggal booking sudah lewat, pilih tanggal mendatang' };
      return { ok: true, value: d };
    }
    case 'booking_time': {
      const t = parseTime(v);
      return t ? { ok: true, value: t } : { ok: false, why: 'Jam booking belum sesuai, contoh 14:00' };
    }
    case 'booking_services': {
      const parts = v.split(/[,;\n]|\bdan\b/i).map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return { ok: false, why: 'Layanan belum diisi' };
      const list = Array.isArray(ctx.services) ? ctx.services : [];
      if (!list.length) return { ok: true, value: parts.join(', ').slice(0, 200) }; // daftar tidak diketahui: terima apa adanya
      const hit = [], bad = [];
      for (const p of parts) {
        const lo = p.toLowerCase();
        const f = list.find((n) => n.toLowerCase() === lo) || list.find((n) => n.toLowerCase().includes(lo) || lo.includes(n.toLowerCase()));
        if (f) { if (!hit.includes(f)) hit.push(f); } else bad.push(p);
      }
      if (bad.length) return { ok: false, why: `Layanan "${bad[0]}" tidak ditemukan. Pilihan: ${list.slice(0, 15).join(', ')}` };
      return { ok: true, value: hit.join(', ') };
    }
    default: return { ok: false, why: 'kolom tidak dikenal' };
  }
}

/**
 * Membaca balasan customer terhadap formulir.
 * - baris "Label: nilai" dipetakan ke kolom bernama itu (hanya kolom yang masih kosong);
 * - tanpa label: satu kolom tersisa -> seluruh pesan adalah jawabannya; jumlah baris = jumlah kolom -> urut.
 * Hasil: { values:{id:nilai}, errors:{id:alasan}, touched:boolean }.
 */
export function parseReply(text, missing, now = Date.now(), ctx = {}) {
  const want = new Set(missing.filter((id) => BY_ID[id]));
  const out = { values: {}, errors: {}, touched: false };
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const take = (id, raw) => {
    if (!want.has(id) || id in out.values) return;
    const r = validate(id, raw, now, ctx);
    if (r.ok) { out.values[id] = r.value; delete out.errors[id]; out.touched = true; }
    else if (r.why !== 'kosong' && r.why !== 'pertanyaan') { out.errors[id] = r.why; out.touched = true; }
  };
  let labelled = 0;
  for (const line of lines) {
    const m = /^([^:=]{2,60}?)\s*[:=]\s*(.+)$/.exec(line) || /^([^:=]{2,40}?)\s+[-–]\s+(.+)$/.exec(line);
    const id = m && labelToId(m[1]);
    if (id) { labelled++; take(id, m[2]); }
  }
  if (labelled) return out;
  const list = [...want];
  if (list.length === 1 && lines.length === 1 && lines[0].length <= 150) take(list[0], lines[0]);
  else if (list.length > 1 && lines.length === list.length) list.forEach((id, i) => take(id, lines[i]));
  return out;
}

let extraHints = {};
const tmpl = (ids) => ids.map((id) => `${BY_ID[id].label}${extraHints[id] ?? BY_ID[id].hint}:`).join('\n');
/** Petunjuk tambahan per kolom (mis. daftar layanan dari Acesio). Dipanggil sebelum membuat pesan. */
export function withHints(hints, fn) { const o = extraHints; extraHints = hints || {}; try { return fn(); } finally { extraHints = o; } }

export function formMessage(missing, intro = '') {
  const ids = missing.filter((id) => BY_ID[id]);
  const head = String(intro || '').trim() || 'Agar bisa kami proses, mohon lengkapi data berikut. Salin lalu isi di sebelah titik dua:';
  return `${head}\n\n${tmpl(ids)}`;
}

export function remainingMessage(missing, errors = {}) {
  const ids = missing.filter((id) => BY_ID[id]);
  const notes = Object.values(errors).map((e) => `- ${e}`).join('\n');
  return `${notes ? `Mohon dicek lagi:\n${notes}\n\n` : 'Terima kasih. '}Data yang masih kurang:\n\n${tmpl(ids)}`;
}

/** Bulan pertama menjadi customer, mis. "November 2026" (zona waktu Jakarta). */
export function monthLabel(now = Date.now(), tz = 'Asia/Jakarta') {
  const s = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric', timeZone: tz }).format(new Date(now));
  return s.charAt(0).toUpperCase() + s.slice(1);
}
