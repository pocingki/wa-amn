// Amnan Connect v1 (docs/INTEGRASI.md): API key aplikasi, webhook keluar bertanda tangan + antrean
// percobaan ulang, idempotensi, dan tautan prefill bertanda tangan. Tanpa dependensi tambahan.
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import * as events from './events.js';
import fs from 'node:fs';
import path from 'node:path';
import * as D from './db.js';
import { load, save, dataDir } from './jsonfile.js';
import { HttpError, limiter, ipKey, audit } from './auth.js';

export const CONTRACT = '1';
export const SCOPES = ['leads:read', 'leads:write', 'leads:delete', 'messages:send', 'events:write'];
export const WEBHOOK_EVENTS = ['ping', 'lead.created', 'lead.hot', 'message.received', 'conversation.attention', 'wa.status'];

const KEYS_FILE = 'connect-keys.json';
const HOOKS_FILE = 'connect-webhooks.json';
const OUTBOX_FILE = 'connect-outbox.json';
const IDEM_FILE = 'connect-idem.json';

const RETRY_MS = [5_000, 30_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000]; // 6 percobaan total
const DELIVER_TIMEOUT_MS = 10_000;
const AUTO_DISABLE_AFTER = 50;
const OUTBOX_MAX = 1000;
const IDEM_TTL_MS = 24 * 3600_000;
const LOG_MAX = 100;
const DEFAULT_MESSAGES_PER_DAY = 300;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const envOn = (name) => process.env[name] === '1';

const verr = (message, code = 'VALIDATION', status = 400) => Object.assign(new HttpError(status, message), { code });

// ---------------------------------------------------------------- Dependensi yang bisa diganti di tes

const DEFAULT_FETCH = (...a) => globalThis.fetch(...a);
let fetchFn = DEFAULT_FETCH;
let lookupFn = (host) => dns.promises.lookup(host, { all: true });
export const setFetch = (f) => { fetchFn = f || DEFAULT_FETCH; };
export const usingDefaultFetch = () => fetchFn === DEFAULT_FETCH;
export const setLookup = (f) => { lookupFn = f || ((host) => dns.promises.lookup(host, { all: true })); };

// ---------------------------------------------------------------- API key

const arr = (v) => (Array.isArray(v) ? v : []);
// Kunci & webhook boleh diubah CLI (scripts/integrations.js) saat server jalan: baca ulang tiap 2 dtk, seperti users.json.
const FILE_TTL_MS = 2000;
let keysCache = null;
let keysAt = 0;
const readKeys = () => {
  const t = Date.now();
  if (!keysCache || t - keysAt > FILE_TTL_MS) { keysCache = arr(load(KEYS_FILE, { keys: [] })?.keys); keysAt = t; }
  return keysCache;
};
const writeKeys = (list) => { save(KEYS_FILE, { keys: list }); keysCache = list; keysAt = Date.now(); };
export const _resetCaches = () => { keysCache = null; hooksCache = null; outbox = null; inflight.clear(); lastPurge = 0; legacyDone = false; lastTouch.clear(); };

const APP_RE = /^[a-z][a-z0-9-]{1,23}$/;
const publicKey = (k) => ({
  id: k.id, name: k.name, app: k.app, scopes: k.scopes, createdAt: k.createdAt, createdBy: k.createdBy,
  lastUsedAt: k.lastUsedAt || null, revokedAt: k.revokedAt || null, messagesPerDay: k.messagesPerDay,
});

export function createKey({ name, app, scopes, messagesPerDay, createdBy = '-' } = {}) {
  const n = str(name, 60);
  if (!n) throw verr('Nama kunci wajib diisi');
  const a = str(app, 24).toLowerCase();
  if (!APP_RE.test(a)) throw verr('app harus huruf kecil/angka/minus, 2-24 karakter, diawali huruf');
  const sc = [...new Set(Array.isArray(scopes) ? scopes : String(scopes ?? '').split(/[,\s]+/).filter(Boolean))];
  if (!sc.length) throw verr(`Pilih minimal satu scope: ${SCOPES.join(', ')}`);
  const bad = sc.filter((s) => !SCOPES.includes(s));
  if (bad.length) throw verr(`Scope tidak dikenal: ${bad.join(', ')}`);
  const perDay = messagesPerDay === undefined ? DEFAULT_MESSAGES_PER_DAY : Math.floor(Number(messagesPerDay));
  if (!Number.isFinite(perDay) || perDay < 0 || perDay > 100_000) throw verr('messagesPerDay tidak valid (0-100000)');
  const id = crypto.randomBytes(4).toString('hex');
  const secret = b64u(crypto.randomBytes(32));
  const rec = { id, name: n, app: a, scopes: sc, secretHash: sha256(secret), createdAt: new Date().toISOString(), createdBy, messagesPerDay: perDay, usage: { day: '', n: 0 } };
  writeKeys([...readKeys(), rec]);
  return { key: publicKey(rec), token: `amk_${id}.${secret}` };
}

export const listKeys = () => readKeys().map(publicKey);

export function revokeKey(id) {
  const k = readKeys().find((x) => x.id === id);
  if (!k) throw verr('Kunci tidak ditemukan', 'NOT_FOUND', 404);
  if (!k.revokedAt) writeKeys(readKeys().map((x) => (x === k ? { ...x, revokedAt: new Date().toISOString() } : x)));
  return publicKey(readKeys().find((x) => x.id === id));
}

const TOKEN_RE = /^amk_([0-9a-f]{8})\.([A-Za-z0-9_-]{43})$/;
const lastTouch = new Map();

/**
 * -> { ok:true, app:{id,name,app,scopes} } | { ok:false, status:401|429, retryAfter? }
 * Pembatas dihitung per (IP, id kunci): kunci lama yang masih dipakai setelah dicabut tidak boleh mengunci
 * aplikasi lain di IP yang sama (mis. beberapa aplikasi di satu server). Id tak dikenal berbagi satu bucket per IP.
 */
export function authenticateKey(req, ip) {
  const m = TOKEN_RE.exec(/^bearer /i.test(req.headers.authorization || '') ? req.headers.authorization.slice(7).trim() : '');
  const k = m && readKeys().find((x) => x.id === m[1]);
  const lk = [`ak:${ipKey(ip)}:${k ? k.id : '-'}`];
  const wait = limiter.check(lk);
  if (wait) return { ok: false, status: 429, retryAfter: wait };
  const want = k ? Buffer.from(k.secretHash, 'hex') : Buffer.alloc(32);
  const got = Buffer.from(sha256(m ? m[2] : ''), 'hex');
  const good = !!k && !k.revokedAt && want.length === got.length && crypto.timingSafeEqual(want, got);
  if (!good) {
    const lock = limiter.fail(lk);
    audit({ user: `key:${m ? m[1] : '-'}`, ip, action: 'v1.auth.gagal', detail: { dikunci: lock || undefined } });
    return { ok: false, status: 401 };
  }
  const now = Date.now();
  if (now - (lastTouch.get(k.id) || 0) > 60_000) { // jangan menulis berkas di tiap permintaan
    lastTouch.set(k.id, now);
    try { writeKeys(readKeys().map((x) => (x === k ? { ...x, lastUsedAt: new Date(now).toISOString() } : x))); } catch { /* best-effort */ }
  }
  return { ok: true, app: { id: k.id, name: k.name, app: k.app, scopes: k.scopes } };
}

/** Hitung 1 pesan terhadap batas harian kunci. false bila batas terlampaui. */
export function takeMessageQuota(keyId, now = new Date()) {
  const list = readKeys();
  const k = list.find((x) => x.id === keyId);
  if (!k) return false;
  const day = now.toISOString().slice(0, 10);
  const u = k.usage?.day === day ? k.usage : { day, n: 0 };
  if (k.messagesPerDay > 0 && u.n >= k.messagesPerDay) return false;
  writeKeys(list.map((x) => (x === k ? { ...x, usage: { day, n: u.n + 1 } } : x)));
  return true;
}

/** Kembalikan 1 kuota bila pengiriman gagal (kegagalan WA tidak boleh menghabiskan batas harian). */
export function refundMessageQuota(keyId, now = new Date()) {
  const list = readKeys();
  const k = list.find((x) => x.id === keyId);
  const day = now.toISOString().slice(0, 10);
  if (!k || k.usage?.day !== day || !(k.usage.n > 0)) return;
  writeKeys(list.map((x) => (x === k ? { ...x, usage: { day, n: k.usage.n - 1 } } : x)));
}

// ---------------------------------------------------------------- Idempotensi (24 jam, SQLite)
//
// Kebijakan:
//  - Ruang kunci = (id kunci API/aplikasi, endpoint, Idempotency-Key). Klien atau endpoint lain tidak pernah berbagi kunci.
//  - Reservasi = INSERT ke tabel idempotency_keys (PRIMARY KEY) di dalam transaksi BEGIN IMMEDIATE: atomik, tanpa jeda tulis,
//    dan aman bila ada lebih dari satu proses. Disimpan sebelum efek dijalankan.
//  - Selesai 2xx/4xx tetap -> respons disimpan dan diputar ulang (Idempotent-Replay). 5xx/429/503 atau exception -> kunci dilepas,
//    boleh dicoba lagi dengan kunci yang sama.
//  - Kunci sama + isi berbeda -> 422 IDEMPOTENCY_KEY_REUSED (tidak mengeksekusi, tidak memutar ulang).
//  - Sedang berjalan di proses ini -> permintaan serentak menunggu hasil yang sama. Proses mati di tengah -> baris 'pending' tetap
//    ada dan dibalas 409 IDEMPOTENCY_INTERRUPTED (efek mungkin sudah terjadi; periksa dulu, lalu pakai kunci baru bila perlu).
//  - Masa berlaku 24 jam sejak dibuat; baris kedaluwarsa dibuang otomatis.
export const IDEM_TTL = IDEM_TTL_MS;
const IDEM_KEY_RE = /^[A-Za-z0-9._:+=~-]{8,120}$/;
const inflight = new Map(); // k -> Promise hasil (hanya proses ini)
let lastPurge = 0;
let legacyDone = false;

const idemHash = (keyId, endpoint, key) => sha256(`${keyId}\0${endpoint}\0${key}`);

/** Urutan kunci objek distabilkan supaya sidik jari tidak bergantung urutan properti JSON. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export const requestFingerprint = (method, endpoint, body) => {
  const { idempotencyKey, ...rest } = body && typeof body === 'object' && !Array.isArray(body) ? body : { _: body ?? null };
  return sha256(`${method}\n${endpoint}\n${canonicalJson(rest)}`);
};

/** Ambil kunci dari header (atau body.idempotencyKey). null bila tidak ada; lempar 400 bila format salah. */
export const idemKeyFrom = (req, body) => {
  const h = req.headers['idempotency-key'];
  const fromBody = body && typeof body === 'object' ? body.idempotencyKey : undefined;
  const hv = h === undefined ? '' : String(h).trim();
  const bv = fromBody === undefined || fromBody === null ? '' : String(fromBody).trim();
  if (hv && bv && hv !== bv) throw verr('Idempotency-Key di header dan body berbeda');
  const k = hv || bv;
  if (!k) return null;
  if (!IDEM_KEY_RE.test(k)) throw verr('Idempotency-Key harus 8-120 karakter dari A-Z a-z 0-9 . _ : + = ~ -');
  return k;
};

const iErr = (status, code, error) => ({ status, body: { error, code }, replay: true });

function purgeIdem(now) {
  if (now - lastPurge < 60_000) return;
  lastPurge = now;
  try { D.getDb().prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now); } catch (e) { D.noteWriteError(e); }
}

/** Impor sekali dari berkas lama connect-idem.json (kunci "<keyId>:<kunci>", tanpa endpoint) lalu ganti namanya. */
function importLegacy(now) {
  if (legacyDone) return;
  legacyDone = true;
  const raw = load(IDEM_FILE, null);
  if (!raw?.entries || typeof raw.entries !== 'object') return;
  const rows = Object.entries(raw.entries).filter(([, v]) => v && now - v.ts <= IDEM_TTL_MS);
  const db = D.getDb();
  D.tx(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO idempotency_keys(k, app_id, endpoint, fp, state, status, body, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const [k, v] of rows) {
      const i = k.indexOf(':');
      const app = k.slice(0, i), key = k.slice(i + 1);
      ins.run(idemHash(app, '*legacy*', key), app, '*legacy*', null, v.pending ? 'pending' : 'done', v.pending ? null : v.status, v.pending ? null : D.encodeBlob(v.body), v.ts, v.ts + IDEM_TTL_MS);
    }
  });
  try { fs.renameSync(path.join(dataDir(), IDEM_FILE), path.join(dataDir(), `${IDEM_FILE}.migrated`)); } catch { /* sudah dipindah */ }
}

/** Jalankan fn sekali per (keyId, endpoint, idemKey). fn -> { status, body }.
 *  opts: { endpoint, fingerprint }. Tanpa idemKey, fn dijalankan apa adanya. */
export async function withIdempotency(keyId, idemKey, fn, { endpoint = '', fingerprint = null } = {}) {
  if (!idemKey) return { ...(await fn()), replay: false };
  const now = Date.now();
  const k = idemHash(keyId, endpoint, idemKey);
  const db = D.getDb();
  importLegacy(now);
  purgeIdem(now);

  // Reservasi atomik: baca + putuskan + sisipkan dalam satu transaksi tulis.
  const decision = D.tx(() => {
    let row = db.prepare('SELECT * FROM idempotency_keys WHERE k=?').get(k);
    if (row && row.expires_at <= now) { db.prepare('DELETE FROM idempotency_keys WHERE k=?').run(k); row = null; }
    if (!row) {
      const old = db.prepare('SELECT * FROM idempotency_keys WHERE k=? AND expires_at>?').get(idemHash(keyId, '*legacy*', idemKey), now);
      if (old) row = old;
    }
    if (row) return { row };
    db.prepare('INSERT INTO idempotency_keys(k, app_id, endpoint, fp, state, created_at, expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(k, String(keyId), endpoint, fingerprint, 'pending', now, now + IDEM_TTL_MS);
    return { reserved: true };
  });

  if (!decision.reserved) {
    const { row } = decision;
    if (row.fp && fingerprint && row.fp !== fingerprint) {
      return iErr(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key ini sudah dipakai untuk permintaan dengan isi berbeda. Gunakan kunci baru untuk permintaan baru.');
    }
    if (row.state === 'done') return { status: row.status, body: D.decodeBlob(row.body), replay: true };
    if (inflight.has(k)) return { ...(await inflight.get(k)), replay: true }; // permintaan serentak: tunggu hasil yang sama
    return iErr(409, 'IDEMPOTENCY_INTERRUPTED', 'Permintaan dengan Idempotency-Key ini terputus saat diproses (mis. server restart) dan hasilnya tidak diketahui. Periksa dulu apakah efeknya sudah terjadi; jika belum, kirim ulang dengan Idempotency-Key baru.');
  }

  let finish;
  const gate = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  gate.catch(() => {}); // penolakan sampai ke penunggu; tanpa ini proses melihat unhandledRejection
  inflight.set(k, gate);
  const release = () => D.getDb().prepare('DELETE FROM idempotency_keys WHERE k=? AND state=?').run(k, 'pending');
  try {
    const r = await fn();
    if (r.status < 500 && r.status !== 429 && r.status !== 503) {
      D.tx(() => D.getDb().prepare("UPDATE idempotency_keys SET state='done', status=?, body=? WHERE k=?").run(r.status, D.encodeBlob(r.body), k));
    } else {
      release(); // gagal sementara: boleh dicoba lagi dengan kunci yang sama
    }
    finish.resolve(r);
    return { ...r, replay: false };
  } catch (e) {
    try { release(); } catch (e2) { D.noteWriteError(e2); }
    finish.reject(e);
    throw e;
  } finally {
    inflight.delete(k);
  }
}

// ---------------------------------------------------------------- Penandatanganan

export const signPayload = (secret, ts, body) => `v1=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

/** Untuk penerima webhook (dan tes). */
export function verifySignature(secret, ts, body, header, { toleranceSec = 300, now = Date.now() } = {}) {
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const a = Buffer.from(signPayload(secret, t, body));
  const b = Buffer.from(String(header ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- Tautan prefill {booking}

// Sambungan Booking dari menu Integrasi disimpan di data/connect-booking.json (ikut terenkripsi bila DATA_KEY aktif)
// dan menang atas .env; .env (BOOKING_URL / BOOKING_LINK_SECRET) tetap bekerja sebagai cadangan.
const BOOKING_FILE = 'connect-booking.json';
const readBooking = () => { try { return load(BOOKING_FILE, null) || null; } catch { return null; } };
const linkSecret = () => readBooking()?.linkSecret || process.env.BOOKING_LINK_SECRET || '';
const bookingBase = () => String(readBooking()?.url || process.env.BOOKING_URL || '').replace(/\/+$/, '');

export function signLink(secret, { phone, name = '', ttlHours = 12, now = Date.now() }) {
  const payload = b64u(JSON.stringify({ p: String(phone), n: String(name).slice(0, 60), exp: Math.floor(now / 1000) + Math.round(ttlHours * 3600) }));
  const mac = b64u(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${mac}`;
}

/** Tautan booking untuk satu percakapan, atau null bila belum dikonfigurasi. */
export function bookingLink(conv) {
  const base = bookingBase();
  const secret = linkSecret();
  if (!/^https?:\/\//i.test(base) || secret.length < 16 || !conv?.phone || !/^\d{8,15}$/.test(String(conv.phone))) return null;
  const ttl = Math.min(Number(process.env.BOOKING_LINK_TTL_HOURS) > 0 ? Number(process.env.BOOKING_LINK_TTL_HOURS) : 12, 24); // bawaan 12 jam, maks 24 (Booking menolak > 24 jam)
  return `${base}/?c=${signLink(secret, { phone: conv.phone, name: conv.name || '', ttlHours: ttl })}`;
}

/** URL http(s) tanpa query/hash -> tanpa "/" akhir, selain itu galat validasi. */
function cleanBase(raw, label) {
  const s = str(raw, 300);
  let u;
  try { u = new URL(s); } catch { throw verr(`${label} tidak valid (contoh: https://book.klinik.com)`); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.search || u.hash || u.username || u.password) throw verr(`${label} harus berupa alamat http(s) tanpa tambahan apa pun di belakangnya`);
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

export function bookingStatus() {
  const b = readBooking();
  const key = b?.keyId ? readKeys().find((k) => k.id === b.keyId) : null;
  const hook = b?.webhookId ? readHooks().find((w) => w.id === b.webhookId) : null;
  return {
    connected: !!(b && key && !key.revokedAt),
    bookingUrl: b?.url || '', connectedAt: b?.connectedAt || null,
    key: key ? { id: key.id, lastUsedAt: key.lastUsedAt || null, revokedAt: key.revokedAt || null } : null,
    webhook: hook ? { id: hook.id, active: hook.active, lastStatus: hook.lastStatus || null, lastAt: hook.lastAt || null, failures: hook.failures || 0 } : null,
    fromEnv: !b && !!(process.env.BOOKING_URL && process.env.BOOKING_LINK_SECRET),
  };
}

/**
 * Hubungkan Booking Live dengan satu langkah: membuat API key (scope lengkap), webhook ke Booking, dan rahasia tautan,
 * lalu mengembalikan SATU kode sambungan yang tinggal ditempel di menu Integrasi Booking. Memutus sambungan lama lebih dulu.
 */
export function connectBooking({ bookingUrl, amnanUrl, createdBy = '-' } = {}) {
  const bUrl = cleanBase(bookingUrl, 'Alamat Booking');
  const aUrl = cleanBase(amnanUrl, 'Alamat Amnan');
  const hookUrl = checkWebhookUrl(`${bUrl}/api/integrations/amnan/webhook`); // gagal lebih awal (mis. bukan https) sebelum membuat apa pun
  disconnectBooking();
  const { key, token } = createKey({ name: 'Booking Live', app: 'booking', scopes: ['leads:read', 'leads:write', 'leads:delete', 'messages:send', 'events:write'], createdBy });
  let webhook, secret;
  try {
    ({ webhook, secret } = createWebhook({ name: 'Booking Live', url: hookUrl, events: ['lead.created', 'lead.hot'] }));
  } catch (e) { revokeKey(key.id); throw e; }
  const link = b64u(crypto.randomBytes(32));
  save(BOOKING_FILE, { url: bUrl, linkSecret: link, keyId: key.id, webhookId: webhook.id, connectedAt: new Date().toISOString() });
  const code = 'AMN1.' + b64u(JSON.stringify({ u: aUrl, k: token, w: secret, l: link }));
  return { code, status: bookingStatus() };
}

/** Putuskan: cabut key, hapus webhook, lupakan alamat Booking. Aman dipanggil walau belum tersambung. */
export function disconnectBooking() {
  const b = readBooking();
  if (!b) return false;
  try { if (b.keyId && readKeys().some((k) => k.id === b.keyId && !k.revokedAt)) revokeKey(b.keyId); } catch { /* sudah tidak ada */ }
  try { if (b.webhookId && readHooks().some((w) => w.id === b.webhookId)) removeWebhook(b.webhookId); } catch { /* sudah tidak ada */ }
  save(BOOKING_FILE, null);
  return true;
}

// ---------------------------------------------------------------- Langganan webhook

let hooksCache = null;
let hooksAt = 0;
const readHooks = () => {
  const t = Date.now();
  if (!hooksCache || t - hooksAt > FILE_TTL_MS) { hooksCache = arr(load(HOOKS_FILE, { webhooks: [] })?.webhooks); hooksAt = t; }
  return hooksCache;
};
const writeHooks = (list) => { save(HOOKS_FILE, { webhooks: list }); hooksCache = list; hooksAt = Date.now(); };
const publicHook = (w) => ({
  id: w.id, name: w.name, url: w.url, events: w.events, active: w.active, createdAt: w.createdAt,
  failures: w.failures || 0, lastStatus: w.lastStatus || null, lastAt: w.lastAt || null,
});

function ipBlocked(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || a === 0 || a >= 224 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('::ffff:')) return ipBlocked(s.slice(7)); // IPv4-mapped
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return true;
}

/** Validasi URL saat dibuat (tanpa DNS). Alamat privat hanya bila operator mengizinkan lewat env. */
export function checkWebhookUrl(raw) {
  const s = str(raw, 500);
  let u;
  try { u = new URL(s); } catch { throw verr('URL webhook tidak valid'); }
  const allowPrivate = envOn('CONNECT_ALLOW_PRIVATE_URLS');
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw verr('URL webhook harus https');
  if (u.username || u.password) throw verr('URL webhook tidak boleh memuat kredensial');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!allowPrivate) {
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw verr('URL webhook harus ke alamat publik');
    if (net.isIP(host) && ipBlocked(host)) throw verr('URL webhook harus ke alamat publik');
  }
  return s;
}

/** Periksa ulang saat pengiriman: semua alamat hasil DNS harus publik (kecuali operator mengizinkan privat). */
async function assertDeliverable(urlStr) {
  if (envOn('CONNECT_ALLOW_PRIVATE_URLS')) return;
  const host = new URL(urlStr).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookupFn(host);
  if (!addrs.length || addrs.some((a) => ipBlocked(a.address))) throw new Error('alamat tujuan bukan alamat publik');
}

/**
 * POST ke URL luar dengan IP hasil DNS DIKUNCI: alamat divalidasi publik lalu soket dibuka ke alamat itu juga, jadi DNS
 * rebinding antara "cek" dan "kirim" tidak mungkin. Pengalihan (redirect) tidak diikuti. -> { status }
 */
export async function pinnedPost(urlStr, { headers = {}, body = '', timeoutMs = DELIVER_TIMEOUT_MS } = {}) {
  const u = new URL(urlStr);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookupFn(host);
  if (!envOn('CONNECT_ALLOW_PRIVATE_URLS') && (!addrs.length || addrs.some((a) => ipBlocked(a.address)))) throw new Error('alamat tujuan bukan alamat publik');
  const pick = addrs[0];
  const family = pick.family || net.isIP(pick.address);
  const payload = Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request({
      hostname: host, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', timeout: timeoutMs,
      headers: { ...headers, host: u.host, 'content-length': payload.length },
      servername: net.isIP(host) ? undefined : host,
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: pick.address, family }]) : cb(null, pick.address, family)),
    }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); res.on('error', reject); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

export function createWebhook({ name, url, events: evs } = {}) {
  const list = Array.isArray(evs) ? evs : String(evs ?? '').split(/[,\s]+/).filter(Boolean);
  const chosen = [...new Set(list.length ? list : WEBHOOK_EVENTS.filter((e) => e !== 'ping'))];
  const bad = chosen.filter((e) => !WEBHOOK_EVENTS.includes(e));
  if (bad.length) throw verr(`Tipe kejadian tidak dikenal: ${bad.join(', ')}`);
  const n = str(name, 60);
  if (!n) throw verr('Nama webhook wajib diisi');
  if (readHooks().length >= 20) throw verr('Maksimal 20 langganan webhook', 'VALIDATION');
  const rec = {
    id: crypto.randomBytes(4).toString('hex'), name: n, url: checkWebhookUrl(url), events: chosen, active: true,
    secret: `whsec_${b64u(crypto.randomBytes(24))}`, createdAt: new Date().toISOString(), failures: 0,
  };
  writeHooks([...readHooks(), rec]);
  return { webhook: publicHook(rec), secret: rec.secret };
}

export const listWebhooks = () => readHooks().map(publicHook);

export function updateWebhook(id, patch = {}) {
  const w = readHooks().find((x) => x.id === id);
  if (!w) throw verr('Webhook tidak ditemukan', 'NOT_FOUND', 404);
  const next = { ...w };
  if ('url' in patch) next.url = checkWebhookUrl(patch.url);
  if ('active' in patch) { next.active = !!patch.active; if (next.active) next.failures = 0; }
  if ('events' in patch) {
    const list = [...new Set(Array.isArray(patch.events) ? patch.events : [])];
    if (!list.length || list.some((e) => !WEBHOOK_EVENTS.includes(e))) throw verr('events tidak valid');
    next.events = list;
  }
  writeHooks(readHooks().map((x) => (x === w ? next : x)));
  return publicHook(next);
}

export function removeWebhook(id) {
  if (!readHooks().some((x) => x.id === id)) throw verr('Webhook tidak ditemukan', 'NOT_FOUND', 404);
  writeHooks(readHooks().filter((x) => x.id !== id));
  if (outbox) { outbox = outbox.filter((o) => o.webhookId !== id); persistOutbox(); }
}

// ---------------------------------------------------------------- Antrean pengiriman

let outbox = null; // [{ id, webhookId, eventId, type, body, attempt, nextAt, createdAt }]
const log = []; // 100 hasil terakhir (memori)
let outTimer = null;
let ticker = null;
let busy = false;

const getOutbox = () => (outbox ||= arr(load(OUTBOX_FILE, { items: [] })?.items));
function persistOutbox() {
  if (outTimer) return;
  outTimer = setTimeout(() => { outTimer = null; flushOutbox(); }, 200);
  outTimer.unref?.();
}
function flushOutbox() {
  if (!outbox) return;
  try { save(OUTBOX_FILE, { items: outbox }); } catch (e) { console.warn('[connect] antrean webhook gagal disimpan:', e.message); }
}
export const deliveries = () => log.slice(-50).reverse();
const pushLog = (e) => { log.push({ at: Date.now(), ...e }); if (log.length > LOG_MAX) log.shift(); };

/** Antrekan satu kejadian ke semua langganan yang memintanya (force: abaikan filter tipe, untuk ping). Mengembalikan jumlah pengiriman. */
export function enqueueEvent(type, data = {}, { webhookId = null, force = false } = {}) {
  const hooks = readHooks().filter((w) => w.active && (force || w.events.includes(type)) && (!webhookId || w.id === webhookId));
  if (!hooks.length) return 0;
  const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  const body = JSON.stringify({ id: eventId, type, client: process.env.CLIENT_ID || '', ts: now, data });
  const q = getOutbox();
  for (const w of hooks) q.push({ id: crypto.randomUUID(), webhookId: w.id, eventId, type, body, attempt: 0, nextAt: now, createdAt: now });
  while (q.length > OUTBOX_MAX) { const d = q.shift(); console.warn(`[connect] antrean penuh, pengiriman ${d.type} dibuang`); }
  persistOutbox();
  kick();
  return hooks.length;
}

async function attempt(item) {
  const w = readHooks().find((x) => x.id === item.webhookId);
  if (!w || !w.active) return { drop: true };
  try {
    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      'content-type': 'application/json', 'user-agent': 'Amnan-Connect/1',
      'x-amnan-event': item.type, 'x-amnan-delivery': item.id, 'x-amnan-timestamp': String(ts),
      'x-amnan-signature': signPayload(w.secret, ts, item.body),
    };
    let res;
    if (fetchFn === DEFAULT_FETCH) {
      res = await pinnedPost(w.url, { headers, body: item.body }); // produksi: IP terkunci (anti DNS rebinding)
    } else {
      await assertDeliverable(w.url); // jalur fetch yang diganti (tes)
      res = await fetchFn(w.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS), headers, body: item.body });
      try { await res.arrayBuffer?.(); } catch { /* badan respons tidak dipakai */ }
    }
    return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

function recordResult(item, w, r) {
  if (!w) return;
  const hooks = readHooks();
  const cur = hooks.find((x) => x.id === w.id);
  if (!cur) return;
  const next = { ...cur, lastAt: new Date().toISOString(), lastStatus: r.ok ? 'ok' : (r.error || 'gagal') };
  next.failures = r.ok ? 0 : (cur.failures || 0) + 1;
  if (!r.ok && next.failures >= AUTO_DISABLE_AFTER && next.active) {
    next.active = false;
    audit({ user: 'sistem', action: 'webhook.nonaktif', detail: { id: cur.id, alasan: `${next.failures} kegagalan beruntun` } });
    console.warn(`[connect] webhook ${cur.id} dinonaktifkan setelah ${next.failures} kegagalan beruntun`);
  }
  writeHooks(hooks.map((x) => (x === cur ? next : x)));
}

export async function processDue(now = Date.now()) {
  if (busy) return 0;
  busy = true;
  let n = 0;
  try {
    const q = getOutbox();
    const due = q.filter((o) => o.nextAt <= now).slice(0, 20);
    await Promise.all(due.map(async (item) => {
      const w = readHooks().find((x) => x.id === item.webhookId);
      const r = await attempt(item);
      const idx = q.indexOf(item);
      if (r.drop) { if (idx >= 0) q.splice(idx, 1); return; }
      n++;
      item.attempt += 1;
      recordResult(item, w, r);
      if (r.ok) {
        if (idx >= 0) q.splice(idx, 1);
        pushLog({ delivery: item.id, webhookId: item.webhookId, type: item.type, status: 'ok', http: r.status, attempt: item.attempt });
      } else if (item.attempt > RETRY_MS.length) {
        if (idx >= 0) q.splice(idx, 1);
        pushLog({ delivery: item.id, webhookId: item.webhookId, type: item.type, status: 'failed', http: r.status || null, error: r.error, attempt: item.attempt });
      } else {
        item.nextAt = Date.now() + RETRY_MS[item.attempt - 1];
        pushLog({ delivery: item.id, webhookId: item.webhookId, type: item.type, status: 'retry', http: r.status || null, error: r.error, attempt: item.attempt });
      }
    }));
    if (due.length) persistOutbox();
  } finally {
    busy = false;
  }
  return n;
}

function kick() {
  if (process.env.AMNAN_NO_BG === '1') return;
  setImmediate(() => processDue().catch((e) => console.error('[connect] pengiriman:', e.message)));
}

/** Kirim `ping` ke satu langganan. */
export function pingWebhook(id) {
  const w = readHooks().find((x) => x.id === id);
  if (!w) throw verr('Webhook tidak ditemukan', 'NOT_FOUND', 404);
  if (!w.active) throw verr('Webhook nonaktif; aktifkan dulu', 'VALIDATION', 409);
  return enqueueEvent('ping', { message: 'Uji koneksi Amnan Connect' }, { webhookId: id, force: true });
}

// ---------------------------------------------------------------- Event bus -> webhook

const MAP = {
  'lead:new': (p) => ['lead.created', { phone: p.phone ?? null, name: p.name || '' }],
  'lead:hot': (p) => ['lead.hot', { phone: p.phone ?? null, name: p.name || '' }],
  'message:new': (p) => (p.by === 'customer' ? ['message.received', { phone: p.phone, by: p.by, type: p.type || 'text' }] : null),
  'conversation:attention': (p) => ['conversation.attention', { phone: p.phone, reason: p.reason || '' }],
  'wa:status': (p) => ['wa.status', { status: p.status, number: p.number ? `${String(p.number).slice(0, 4)}****${String(p.number).slice(-3)}` : '' }],
};

let unsubs = [];

export function start() {
  if (unsubs.length) return;
  for (const [src, fn] of Object.entries(MAP)) {
    unsubs.push(events.on(src, (payload) => {
      try {
        const m = fn(payload || {});
        if (m) enqueueEvent(m[0], m[1]);
      } catch (e) { console.warn('[connect] event:', e.message); }
    }));
  }
  if (process.env.AMNAN_NO_BG !== '1') {
    ticker = setInterval(() => processDue().catch((e) => console.error('[connect] pengiriman:', e.message)), 1000);
    ticker.unref?.();
    kick(); // lanjutkan antrean yang tersisa setelah restart
  }
}

export function stop() {
  unsubs.forEach((u) => u());
  unsubs = [];
  clearInterval(ticker);
  ticker = null;
}

/** Tulis sinkron semua yang tertunda (shutdown). */
export function flush() {
  clearTimeout(outTimer); outTimer = null;
  flushOutbox();
}