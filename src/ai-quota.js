// Kuota pemakaian balasan AI (SESI B3): batas bulanan global dan batas harian per customer, di SQLite.
// Tabel dibuat di sini (CREATE TABLE IF NOT EXISTS) lewat getDb(); db.js tidak diubah.
//
// Alur: reserve(key) menahan 1 slot -> commit(key, tokens) bila panggilan AI sukses, atau refund(key) bila gagal.
// Semua penulisan yang membaca-lalu-memutuskan berjalan dalam BEGIN IMMEDIATE (pola proyek, lihat db.tx),
// sehingga dua balasan bersamaan (juga lintas proses) tidak bisa sama-sama lolos di batas.
//
// Privasi: nomor/kunci customer TIDAK disimpan polos. `key` dan `customerKey` di-HMAC-SHA256 dengan rahasia
// acak per-database (disimpan di tabel ai_quota_meta) yang dicampur dengan env DATA_KEY bila ada.
// Isi pesan dan API key tidak pernah menyentuh modul ini.
import crypto from 'node:crypto';

const STALE_MS = 10 * 60_000;       // reserved yang tertinggal (proses mati) dibebaskan setelah 10 menit
const DEFAULT_TZ = 'Asia/Jakarta';
const DEFAULT_MONTHLY = 1000;
const DEFAULT_DAILY = 20;
const DAYS = 30;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_usage (
  key TEXT PRIMARY KEY,            -- HMAC dari kunci reservasi (bukan nomor mentah)
  customer_hash TEXT NOT NULL,     -- HMAC dari customerKey
  state TEXT NOT NULL,             -- 'reserved' | 'used' | 'released'
  created_at INTEGER NOT NULL,     -- ms epoch saat reservasi dibuat/dibuka ulang
  day TEXT NOT NULL,               -- YYYY-MM-DD menurut zona waktu
  month TEXT NOT NULL,             -- YYYY-MM menurut zona waktu
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS ai_usage_month ON ai_usage (month, state);
CREATE INDEX IF NOT EXISTS ai_usage_customer_day ON ai_usage (customer_hash, day, state);
CREATE INDEX IF NOT EXISTS ai_usage_day ON ai_usage (day, state);
CREATE TABLE IF NOT EXISTS ai_quota_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

// ---------- tanggal menurut zona waktu ----------
const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

/** { day:'YYYY-MM-DD', month:'YYYY-MM' } untuk waktu ms di zona tz; zona tak valid -> Asia/Jakarta. */
function dayParts(ms, tz) {
  let parts;
  try {
    parts = formatter(tz).formatToParts(new Date(ms));
  } catch {
    parts = formatter(DEFAULT_TZ).formatToParts(new Date(ms));
  }
  const g = (t) => parts.find((p) => p.type === t).value;
  const month = `${g('year')}-${g('month')}`;
  return { day: `${month}-${g('day')}`, month };
}

/** Geser tanggal 'YYYY-MM-DD' sebanyak n hari (aritmetika kalender murni, tanpa zona waktu). */
function shiftDay(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

// ---------- pembantu ----------
const limitOr = (v, def) => (Number.isFinite(Number(v)) && v !== '' && v !== null && Number(v) >= 0 ? Math.floor(Number(v)) : def);
const tokenOrNull = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

export function createQuota({ getDb, now = Date.now, getSettings } = {}) {
  if (typeof getDb !== 'function') throw new TypeError('createQuota: getDb wajib');
  const ready = new WeakMap(); // db -> { secret } (skema dan rahasia disiapkan sekali per koneksi)

  const settings = () => {
    let s = null;
    try { s = getSettings?.() ?? null; } catch { /* pengaturan gagal dibaca: pakai bawaan */ }
    return {
      tz: typeof s?.timezone === 'string' && s.timezone ? s.timezone : DEFAULT_TZ,
      monthly: limitOr(s?.ai?.monthlyQuota, DEFAULT_MONTHLY),
      daily: limitOr(s?.ai?.perCustomerDailyLimit, DEFAULT_DAILY),
    };
  };

  function prep() {
    const db = getDb();
    let r = ready.get(db);
    if (!r) {
      db.exec(SCHEMA);
      // Rahasia acak per-database; INSERT OR IGNORE + SELECT aman bila dua proses menyiapkan bersamaan.
      db.prepare('INSERT OR IGNORE INTO ai_quota_meta(k, v) VALUES(?, ?)').run('salt', crypto.randomBytes(32).toString('hex'));
      const salt = db.prepare('SELECT v FROM ai_quota_meta WHERE k=?').get('salt').v;
      r = { secret: `${salt}\0${process.env.DATA_KEY || ''}` };
      ready.set(db, r);
    }
    return { db, secret: r.secret };
  }

  const hmac = (secret, tag, v) => crypto.createHmac('sha256', secret).update(`${tag}\0${String(v)}`).digest('hex');

  function tx(db, fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* sudah dibatalkan */ }
      throw e;
    }
  }

  const releaseStale = (db, t) => db.prepare("UPDATE ai_usage SET state='released' WHERE state='reserved' AND created_at < ?").run(t - STALE_MS);
  const n = (v) => Number(v) || 0;

  function reserve({ key, customerKey } = {}) {
    if (key === undefined || key === null || key === '') throw new TypeError('reserve: key wajib');
    if (customerKey === undefined || customerKey === null || customerKey === '') throw new TypeError('reserve: customerKey wajib');
    const { db, secret } = prep();
    const cfg = settings();
    const t = now();
    const { day, month } = dayParts(t, cfg.tz);
    const k = hmac(secret, 'k', key);
    const c = hmac(secret, 'c', customerKey);
    return tx(db, () => {
      releaseStale(db, t);
      const row = db.prepare('SELECT state FROM ai_usage WHERE key=?').get(k);
      if (row && (row.state === 'reserved' || row.state === 'used')) return { ok: true }; // idempoten: tidak dihitung dua kali
      const m = db.prepare("SELECT COUNT(*) AS c FROM ai_usage WHERE month=? AND state IN ('reserved','used')").get(month);
      if (n(m.c) >= cfg.monthly) return { ok: false, reason: 'monthly' };
      const d = db.prepare("SELECT COUNT(*) AS c FROM ai_usage WHERE customer_hash=? AND day=? AND state IN ('reserved','used')").get(c, day);
      if (n(d.c) >= cfg.daily) return { ok: false, reason: 'customer_daily' };
      if (row) { // pernah dilepas (refund/basi): buka lagi untuk percobaan ulang dengan kunci yang sama
        db.prepare("UPDATE ai_usage SET state='reserved', customer_hash=?, created_at=?, day=?, month=?, input_tokens=NULL, output_tokens=NULL WHERE key=?")
          .run(c, t, day, month, k);
      } else {
        db.prepare("INSERT INTO ai_usage(key, customer_hash, state, created_at, day, month) VALUES(?,?,'reserved',?,?,?)").run(k, c, t, day, month);
      }
      return { ok: true };
    });
  }

  /** reserved -> used. Idempoten; tidak berefek bila kunci tak dikenal, sudah used, atau sudah dilepas. */
  function commit(key, { inputTokens, outputTokens } = {}) {
    const { db, secret } = prep();
    db.prepare("UPDATE ai_usage SET state='used', input_tokens=?, output_tokens=? WHERE key=? AND state='reserved'")
      .run(tokenOrNull(inputTokens), tokenOrNull(outputTokens), hmac(secret, 'k', key));
  }

  /** reserved -> released. Tidak berefek bila sudah commit. */
  function refund(key) {
    const { db, secret } = prep();
    db.prepare("UPDATE ai_usage SET state='released' WHERE key=? AND state='reserved'").run(hmac(secret, 'k', key));
  }

  /** reserved ATAU used -> released. Dipakai bila pengiriman WhatsApp gagal setelah AI sukses (1 kuota = balasan yang terkirim). */
  function release(key) {
    const { db, secret } = prep();
    db.prepare("UPDATE ai_usage SET state='released' WHERE key=? AND state IN ('reserved','used')").run(hmac(secret, 'k', key));
  }

  function usage() {
    const { db } = prep();
    const cfg = settings();
    const t = now();
    const { day, month } = dayParts(t, cfg.tz);
    try { releaseStale(db, t); } catch { /* database baca-saja/sibuk: hitung apa adanya */ }
    const stale = t - STALE_MS; // reserved yang sudah basi tidak dihitung walau pelepasan gagal ditulis
    const m = db.prepare(`SELECT
        COALESCE(SUM(state='used'), 0) AS used,
        COALESCE(SUM(state='reserved' AND created_at >= ?), 0) AS reserved,
        COALESCE(SUM(CASE WHEN state='used' THEN input_tokens END), 0) AS tin,
        COALESCE(SUM(CASE WHEN state='used' THEN output_tokens END), 0) AS tout
      FROM ai_usage WHERE month=?`).get(stale, month);
    const used = n(m.used);
    const reserved = n(m.reserved);
    const start = shiftDay(day, -(DAYS - 1));
    const perDay = new Map(
      db.prepare("SELECT day, COUNT(*) AS c FROM ai_usage WHERE state='used' AND day>=? AND day<=? GROUP BY day").all(start, day)
        .map((r) => [r.day, n(r.c)]),
    );
    const daily = [];
    for (let i = 0; i < DAYS; i++) {
      const date = shiftDay(start, i);
      daily.push({ date, used: perDay.get(date) || 0 });
    }
    return {
      month: { used, reserved, limit: cfg.monthly, remaining: Math.max(0, cfg.monthly - used - reserved), ...monthRange(month) },
      today: { used: perDay.get(day) || 0 },
      daily,
      tokens: { input: n(m.tin), output: n(m.tout) },
    };
  }

  return { reserve, commit, refund, release, usage };
}
