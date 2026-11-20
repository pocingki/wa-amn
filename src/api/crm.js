// API CRM: daftar lead, statistik, export CSV, detail, ubah, hapus, catatan, tindak lanjut, blokir.
// Dipanggil dispatcher: handle(req, res, url, ctx) -> true bila sudah menangani.
// Fungsi baru milik F1 (src/leads.js) dipanggil lewat namespace agar modul ini tetap termuat
// walau ekspornya belum ada; bila hilang, endpoint terkait menjawab 501.
import { createHash, randomUUID } from 'node:crypto';
import * as store from '../store.js';
import * as C from '../conversations.js';
import * as L from '../leads.js';
import * as settings from '../settings.js';
import { getLink as getAcesioLink } from '../acesio-link.js';
import * as events from '../events.js';
import { agentCfg } from '../crm-agent.js';
import { parseDay, parseTime, todayYmd } from '../crm-form.js';

const DEFAULT_TZ = 'Asia/Jakarta';
const SORTS = ['createdAt', 'lastContactAt', 'name', 'status', 'platform'];
const PERIODS = ['day', 'week', 'month', 'year'];
const MAX_NOTES = 200;
const REFERENSI_MAX = 50; // panjang maksimal referensi (juga dikirim sebagai platform ke Acesio)
const KEYWORD_MAX = 100; // panjang maksimal keyword yang dikirim ke Acesio
const SUB_ROUTE = /^\/api\/leads\/([\w-]+)(?:\/(notes|followup|transaction-done|send-to-acesio|block|unblock)(?:\/([\w-]+))?)?$/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const truthy = (v) => v === true || v === 'on' || v === 'true' || v === 1 || v === '1';
const pad = (n) => String(n).padStart(2, '0');

// ---------- integrasi Acesio: log aman ----------
const acesioInflight = new Set(); // lead yang sedang dikirim (cegah klik ganda)
const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length > 4 ? `${'*'.repeat(d.length - 4)}${d.slice(-4)}` : d ? '****' : ''; };
const safeOrigin = (u) => { try { return new URL(u).origin; } catch { return 'url-tidak-valid'; } };
const acesioLog = (o) => console.log('[acesio] ' + JSON.stringify({ ts: new Date().toISOString(), ...o }));

// ---------- timezone ----------
const fmtCache = new Map();
function dtf(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function getTz() {
  let tz;
  try { tz = L.getConfig?.().timezone; } catch { /* config rusak: pakai bawaan */ }
  if (typeof tz !== 'string' || !tz) return DEFAULT_TZ;
  try { dtf(tz); return tz; } catch { return DEFAULT_TZ; }
}

function parts(ts, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

const offsetMs = (ts, tz) => {
  const p = parts(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
};

/** Epoch ms awal hari (00:00 lokal) untuk y-m-d di tz; m/d boleh melimpah (m=13 -> Januari berikutnya). */
function startOfDay(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  let ts = guess - offsetMs(guess, tz);
  ts = guess - offsetMs(ts, tz);
  return ts;
}

export function dayKey(ts, tz) {
  const p = parts(ts, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

const stamp = (ts, tz) => {
  if (!num(ts)) return '';
  const p = parts(ts, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
};

function periodRange(period, now, tz) {
  const { y, m, d } = parts(now, tz);
  const S = (yy, mm, dd) => startOfDay(yy, mm, dd, tz);
  switch (period) {
    case 'day': return { from: S(y, m, d), to: S(y, m, d + 1), prevFrom: S(y, m, d - 1), prevTo: S(y, m, d) };
    case 'week': return { from: S(y, m, d - 6), to: S(y, m, d + 1), prevFrom: S(y, m, d - 13), prevTo: S(y, m, d - 6) };
    case 'month': return { from: S(y, m, 1), to: S(y, m + 1, 1), prevFrom: S(y, m - 1, 1), prevTo: S(y, m, 1) };
    default: return { from: S(y, 1, 1), to: S(y + 1, 1, 1), prevFrom: S(y - 1, 1, 1), prevTo: S(y, 1, 1) };
  }
}

// ---------- nomor telepon ----------
// SALINAN RINGKAS canonicalPhone: src/phone.js (sesi C1) belum ada saat sesi ini dikerjakan.
// Setelah C1 digabung, ganti fungsi ini dengan impor dari '../phone.js' (cek bentuk keluarannya dulu).
// Aturan: hanya angka; awalan 00 dibuang; awalan 0 lokal -> 62; "620..." -> "62..."; 8-15 angka, selain itu ''.
function canonPhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('620')) d = '62' + d.slice(3);
  return d.length >= 8 && d.length <= 15 ? d : '';
}

// ---------- kesiapan kirim ke Acesio ----------
const placeholderName = (v) => { const t = String(v ?? '').trim(); return !t || /^tanpa nama$/i.test(t); };

/** Eligible = Hot Leads tahap Won. missing: 'phone' | 'referensi' | 'name'. Murni; tidak mengubah lead. */
export function acesioReadiness(lead) {
  const l = isObj(lead) ? lead : {};
  const eligible = l.status === 'Hot Leads' && l.hotStage === 'Won';
  const missing = [];
  if (!/\d/.test(String(l.phone ?? ''))) missing.push('phone'); // hanya LID/BSUID
  if (!String(l.referensi ?? '').trim()) missing.push('referensi');
  if (String(l.name ?? '').trim().length < 2 || placeholderName(l.name)) missing.push('name');
  return { eligible, ready: eligible && missing.length === 0, missing };
}

const MISSING_SHORT = { phone: 'Nomor telepon', referensi: 'Referensi', name: 'Nama' };
const MISSING_TEXT = {
  phone: 'Nomor telepon customer belum diketahui (hanya ID pengganti/LID). Isi nomor telepon di data customer',
  referensi: 'Referensi (customer tahu dari mana) belum diisi',
  name: 'Nama customer belum diisi',
};

// ---------- tampilan lead ----------
/** Salinan lead dengan default terisi; lead lama tidak pernah menyebabkan error. */
function norm(l) {
  let n;
  try { n = typeof L.normalizeLead === 'function' ? { ...L.normalizeLead(l) } : { ...l }; } catch { n = { ...l }; }
  for (const k of ['notes', 'statusHistory', 'warmReasons', 'transactionCycles']) if (!Array.isArray(n[k])) n[k] = [];
  n.data = { ...C.dataFor(n.phone), ...(isObj(n.data) ? n.data : {}) };
  n.warmScore = num(n.warmScore);
  n.hotCandidate = isObj(n.hotCandidate) ? n.hotCandidate : null;
  n.source = isObj(n.source) ? n.source : null;
  n.blocked = n.blocked === true;
  n.waName = typeof n.waName === 'string' ? n.waName : '';
  n.referensi = typeof n.referensi === 'string' ? n.referensi : '';
  // normalizeLead mengisi lastCustomerMessageAt dari lastMessageAt (lead lama); untuk "menunggu balasan" hanya nilai asli yang dipercaya.
  n.lastCustomerMessageAt = l.lastCustomerMessageAt ?? null;
  return n;
}

function derive(n, today) {
  const last = Math.max(num(n.lastCustomerMessageAt), num(n.lastReplyAt), num(n.lastMessageAt));
  return {
    noteCount: n.notes.length,
    awaitingReply: num(n.lastCustomerMessageAt) > num(n.lastReplyAt),
    lastContactAt: last || null,
    followUpOverdue: typeof n.followUpDate === 'string' && n.followUpDate < today,
  };
}

function listItem(l, today) {
  const n = norm(l);
  const { notes, statusHistory, ...rest } = n;
  return { ...rest, ...derive(n, today), acesioReadiness: acesioReadiness(n) };
}

const detailView = (l, today = dayKey(Date.now(), getTz())) => {
  const n = norm(l);
  return { ...n, ...derive(n, today), acesioReadiness: acesioReadiness(n) };
};

// ---------- query daftar ----------
function parseQuery(sp, tz) {
  const sort = sp.get('sort') || 'lastContactAt';
  if (!SORTS.includes(sort)) return { error: 'Parameter sort tidak valid' };
  const dir = sp.get('dir') || 'desc';
  if (dir !== 'asc' && dir !== 'desc') return { error: 'Parameter dir harus asc atau desc' };
  const intOr = (v, d) => (Number.isInteger(Number(v)) && Number(v) >= 1 ? Number(v) : d);
  return {
    q: (sp.get('q') || '').trim().toLowerCase(),
    status: sp.get('status') || '', platform: sp.get('platform') || '', dataType: sp.get('dataType') || '',
    awaiting: sp.get('awaiting') === '1', overdue: sp.get('overdue') === '1', blocked: sp.get('blocked') === '1',
    sort, dir,
    page: intOr(sp.get('page'), 1),
    pageSize: Math.min(100, intOr(sp.get('pageSize'), 25)),
    today: dayKey(Date.now(), tz),
  };
}

function select(o) {
  const items = [];
  for (const l of store.all()) {
    if (l.blocked === true && !o.blocked) continue;
    const it = listItem(l, o.today);
    if (o.status && it.status !== o.status) continue;
    if (o.platform && it.platform !== o.platform) continue;
    if (o.dataType && it.dataType !== o.dataType) continue;
    if (o.awaiting && !it.awaitingReply) continue;
    if (o.overdue && !it.followUpOverdue) continue;
    if (o.q && ![it.name, it.phone, it.keyword].some((v) => String(v ?? '').toLowerCase().includes(o.q))) continue;
    items.push(it);
  }
  const rank = (s) => store.STATUSES.indexOf(s);
  const text = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'id', { sensitivity: 'base' });
  const by = {
    createdAt: (a, b) => num(a.createdAt) - num(b.createdAt),
    lastContactAt: (a, b) => num(a.lastContactAt) - num(b.lastContactAt),
    name: (a, b) => text(a.name, b.name),
    status: (a, b) => rank(a.status) - rank(b.status),
    platform: (a, b) => text(a.platform, b.platform),
  }[o.sort];
  const sign = o.dir === 'asc' ? 1 : -1;
  items.sort((a, b) => sign * by(a, b) || num(b.createdAt) - num(a.createdAt) || String(a.id).localeCompare(String(b.id)));
  return items;
}

function sendCached(req, res, body) {
  const text = JSON.stringify(body);
  const etag = '"' + createHash('sha1').update(text).digest('base64url').slice(0, 22) + '"';
  const inm = String(req.headers?.['if-none-match'] || '');
  const hit = inm && inm.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === etag);
  const h = { 'Cache-Control': 'private, no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  if (hit) { res.writeHead(304, h); res.end(); return; }
  res.writeHead(200, { ...h, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

// ---------- statistik ----------
export function computeStats(period, tz, now = Date.now()) {
  const r = periodRange(period, now, tz);
  const live = store.all().filter((l) => l.blocked !== true);
  const inR = (ts, a, b) => typeof ts === 'number' && ts >= a && ts < b;
  const cohort = live.filter((l) => inR(l.createdAt, r.from, r.to));
  const prevTotal = live.filter((l) => inR(l.createdAt, r.prevFrom, r.prevTo)).length;

  const entered = { 'Cold Leads': 0, 'Warm Leads': 0, 'Hot Leads': 0 };
  for (const l of live) {
    const hist = Array.isArray(l.statusHistory) && l.statusHistory.length ? l.statusHistory : [{ status: l.status, ts: l.createdAt }];
    const seen = new Set();
    for (const h of hist) if (h && Object.hasOwn(entered, h.status) && inR(h.ts, r.from, r.to)) seen.add(h.status);
    for (const s of seen) entered[s]++;
  }

  const total = cohort.length;
  const nowHot = cohort.filter((l) => l.status === 'Hot Leads').length;
  const warmUp = cohort.filter((l) => l.status === 'Warm Leads' || l.status === 'Hot Leads').length;
  const src = new Map();
  for (const l of cohort) src.set(l.platform || 'Lainnya', (src.get(l.platform || 'Lainnya') || 0) + 1);

  return {
    period, from: r.from, to: r.to, fromDate: dayKey(r.from, tz), toDate: dayKey(r.to - 1, tz),
    total, cold: entered['Cold Leads'], warm: entered['Warm Leads'], hot: entered['Hot Leads'],
    cohortHotRate: total ? Math.round((nowHot / total) * 1000) / 10 : 0,
    prevTotal, deltaPct: prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : null,
    funnel: [{ label: 'Semua lead', value: total }, { label: 'Warm + Hot', value: warmUp }, { label: 'Hot', value: nowHot }],
    bySource: [...src].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
    tz,
  };
}

// ---------- CSV ----------
const cell = (v, guard = true) => {
  let s = String(v ?? '');
  if (guard && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // cegah formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};

function buildCSV(items, tz) {
  let labels = {};
  try { labels = Object.fromEntries((settings.get().requiredFields || []).map((f) => [f.id, f.label])); } catch { /* pakai id */ }
  const head = ['Nama', 'No WA', 'Sumber', 'Keyword', 'Status', 'Data Leads', 'Tanggal Masuk', 'Kontak Terakhir', 'Follow-up', 'Data Wajib', 'Catatan'];
  const lines = items.map((l) => {
    const full = store.all().find((x) => x.id === l.id);
    const notes = (Array.isArray(full?.notes) ? full.notes : []).map((n) => `${n.by}: ${n.text}`).join(' | ');
    const fu = l.followUpDate ? l.followUpDate + (l.followUpNote ? ` (${l.followUpNote})` : '') : '';
    const phone = String(l.phone ?? '');
    return [
      cell(l.name), cell(phone, !/^\+?\d+$/.test(phone)), cell(l.platform), cell(l.keyword), cell(l.status), cell(l.dataType),
      cell(stamp(l.createdAt, tz), false), cell(stamp(l.lastContactAt, tz), false), cell(fu, !/^\d{4}-/.test(fu)),
      cell(Object.entries(l.data || {}).map(([k, v]) => `${labels[k] || (k.charAt(0).toUpperCase() + k.slice(1))}: ${v}`).join('; ')), cell(notes),
    ].join(',');
  });
  return '\ufeff' + [head.map((h) => cell(h, false)).join(','), ...lines].join('\r\n') + '\r\n';
}

// ---------- validasi tanggal ----------
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// ---------- handler utama ----------
// ---------- pengajuan ke Acesio (satu lead; dipakai tombol per lead dan "Ajukan semua") ----------
/** Mengirim satu lead ke Acesio. Mengembalikan { status, body } (tidak menulis respons HTTP sendiri). */
async function submitToAcesio(cur, ctx) {
  const send = (status, body) => ({ status, body });
  const fail = (status, msg) => send(status, { error: msg });
  const l = norm(cur);
  const id = l.id;
  if (l.status !== 'Hot Leads') {
    return fail(400, 'Hanya Hot Leads yang dapat dikirim ke Acesio');
  }
  if (l.hotStage !== 'Won') {
    return fail(400, 'Tingkatan Hot Lead harus sudah mencapai tahap Won untuk dikirim ke Acesio');
  }

  const ready = acesioReadiness(l);
  if (!ready.ready) {
    const error = `Data customer belum lengkap untuk dikirim ke Acesio. ${ready.missing.map((k) => MISSING_TEXT[k]).join('. ')}.`;
    return send(400, { error, missing: ready.missing });
  }
  const { url: acesioUrl, key: acesioKey } = getAcesioLink(); // dari Pengaturan (dashboard), cadangan .env
  if (!acesioKey) return fail(503, 'Integrasi Acesio belum dikonfigurasi: isi alamat dan kunci Acesio di Pengaturan (atau ACESIO_BOT_KEY di .env).');
  if (acesioInflight.has(l.id)) return fail(409, 'Pengiriman ke Acesio untuk lead ini masih berjalan. Tunggu hasilnya.');

  const cid = randomUUID(); // correlation ID: dikirim ke Acesio, dicatat di log, audit, dan respons
  const timeoutMs = Math.min(60000, Math.max(1000, Number(process.env.ACESIO_TIMEOUT_MS) || 10000));
  const payload = {
    name: String(l.name).trim(),
    phone: canonPhone(l.phone) || String(l.phone).replace(/\D/g, ''),
    platform: String(l.referensi).trim().slice(0, REFERENSI_MAX), // apa adanya; normalisasi (mis. 'fb') urusan Acesio
    keyword: String(l.keyword || '').slice(0, KEYWORD_MAX),
    note: [
      l.followUpNote ? `[Follow-up] ${l.followUpNote}` : '',
      l.firstMessage ? `[Pesan Awal] ${l.firstMessage}` : '',
    ].filter(Boolean).join('\n'),
    data: l.data || {},
    wa_lead_id: l.id,
  };

  acesioInflight.add(l.id);
  const t0 = Date.now();
  let out;
  try {
    const resp = await fetch(`${acesioUrl}/api/bot/incoming-leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': acesioKey, 'X-Correlation-ID': cid },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const resJson = await resp.json().catch(() => ({}));
    out = resp.ok
      ? { ok: true, http: resp.status, acesioId: resJson.id, replayed: resJson.replayed === true }
      : { ok: false, http: resp.status, kind: 'rejected', error: `HTTP ${resp.status}${resJson.error ? ': ' + String(resJson.error).slice(0, 200) : ''}` };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    out = {
      ok: false, http: 0, kind: timedOut ? 'timeout' : 'unreachable',
      error: timedOut ? `timeout setelah ${timeoutMs} ms` : String(err?.cause?.code || err?.message || err).slice(0, 120),
    };
  } finally {
    acesioInflight.delete(l.id);
  }
  const ms = Date.now() - t0;
  const target = safeOrigin(acesioUrl);
  // Log aman: tanpa API key, tanpa isi pesan/catatan; nomor disamarkan.
  acesioLog({ cid, leadId: l.id, phone: maskPhone(l.phone), target, ok: out.ok, http: out.http, kind: out.kind || 'ok', ms, replayed: out.replayed === true, error: out.error });

  if (!out.ok) {
    // Data CRM tidak disentuh; hanya status percobaan dicatat. Status 'sent' dari pengiriman sebelumnya dipertahankan.
    const patch = { acesioLastError: out.error, acesioLastAttemptAt: Date.now() };
    if (l.acesioStatus !== 'sent') patch.acesioStatus = 'failed';
    try { store.update(id, patch); } catch (e) { acesioLog({ cid, evt: 'status_save_failed', error: String(e?.message || e).slice(0, 120) }); }
    ctx.audit('lead.send_to_acesio_failed', { id, cid, http: out.http, kind: out.kind });
    const why = out.kind === 'rejected' ? `Acesio menolak data (${out.error})` // bukan 401/403 agar UI tidak mengira sesi habis
      : out.kind === 'timeout' ? `Acesio tidak merespons: ${out.error}` : `Gagal menghubungi Acesio di ${target}: ${out.error}`;
    return fail(502, `${why}. ID pelacakan: ${cid}`);
  }
  let updated = l;
  let warning;
  const at = Date.now();
  // replayed:true = data sudah ada di Acesio dan tidak diperbarui: bukan pengiriman baru (acesioSentAt tidak diubah).
  // Penanda acesioReplayed tidak dinyalakan bila lead ini memang sudah tercatat terkirim oleh CRM sebelumnya.
  const done = out.replayed
    ? { acesioStatus: 'sent', acesioReplayed: l.acesioStatus === 'sent' ? l.acesioReplayed === true : true }
    : { acesioStatus: 'sent', acesioReplayed: false, acesioSentAt: at };
  try {
    updated = store.update(id, { ...done, acesioLastError: null, acesioLastAttemptAt: at }) || l;
  } catch (e) {
    // Acesio SUDAH menerima data. Jangan melapor gagal (memicu kirim ulang ganda); beri peringatan.
    warning = 'Data diterima Acesio tetapi status pengiriman gagal disimpan di CRM.';
    acesioLog({ cid, evt: 'status_save_failed', error: String(e?.message || e).slice(0, 120) });
  }
  ctx.audit('lead.send_to_acesio', { id, cid, phone: l.phone, name: l.name, acesioId: out.acesioId, http: out.http, ms, replayed: out.replayed === true });
  return send(200, {
    ok: true, cid, ...(out.replayed ? { replayed: true } : {}), ...(warning ? { warning } : {}), lead: detailView(updated),
    message: out.replayed ? 'Sudah ada di Acesio (tidak diperbarui)' : 'Data customer berhasil dikirim ke Acesio',
  });
}

/** Tandai percakapan lead "perlu perhatian" dengan alasan. Tidak pernah melempar galat. */
export function flagLead(lead, reason) {
  try {
    const conv = lead?.phone ? C.get(lead.phone) : null;
    if (!conv) return;
    conv.needsAttention = true; conv.attentionReason = reason; conv.attentionAt = Date.now();
    C.save(conv);
    events.emit('conversation:attention', { phone: conv.phone, reason });
  } catch { /* abaikan */ }
}

/**
 * Ajukan otomatis ke Acesio saat DP lunas (Won). Gagal/belum lengkap -> perlu perhatian; dicoba ulang oleh acesio-sync.
 * Tombol manual tetap tersedia sebagai cadangan.
 */
export async function autoSubmitLead(id, audit = () => {}) {
  const cur = store.all().find((l) => l.id === id);
  if (!cur || cur.acesioStatus === 'sent') return null;
  let A; try { A = agentCfg(settings.get()); } catch { return null; }
  if (!A.autoSubmit) return null;
  const rd = acesioReadiness(norm(cur));
  if (!rd.eligible) return null;
  store.update(id, { acesioAuto: true, acesioAutoTries: (cur.acesioAutoTries || 0) + 1 });
  if (!rd.ready) {
    flagLead(cur, `Pengajuan otomatis ke Acesio tertunda: ${rd.missing.map((k) => MISSING_SHORT[k] || k).join(', ')} belum lengkap. Lengkapi lalu ajukan.`);
    return { status: 400, body: { missing: rd.missing } };
  }
  const r = await submitToAcesio(store.all().find((l) => l.id === id) || cur, { audit });
  if (r.status !== 200) flagLead(cur, `Pengajuan otomatis ke Acesio gagal: ${r.body?.error || 'tidak diketahui'}. Dicoba ulang otomatis; atau ajukan manual.`);
  return r;
}

/** Ketergantungan untuk acesio-sync (dipasang di server.js). */
export const syncDeps = () => ({
  leads: () => store.all(),
  submit: (id) => autoSubmitLead(id),
  update: (id, patch) => store.update(id, patch),
  flag: flagLead,
  enabled: () => !!getAcesioLink().key,
});

/** Lead yang masuk antrean pengajuan: Hot Leads tahap Won yang belum tercatat terkirim. */
function acesioQueue() {
  const today = dayKey(Date.now(), getTz());
  const items = store.all().filter((l) => acesioReadiness(l).eligible && l.acesioStatus !== 'sent').map((l) => {
    const v = listItem(l, today);
    return {
      id: v.id, name: v.name || '', phone: v.phone || '', referensi: v.referensi || '', keyword: v.keyword || '', platform: v.platform || '',
      acesioStatus: v.acesioStatus || null, acesioLastError: v.acesioLastError || null, acesioLastAttemptAt: v.acesioLastAttemptAt || null,
      ready: v.acesioReadiness.ready, missing: v.acesioReadiness.missing.map((k) => MISSING_SHORT[k] || k),
    };
  }).sort((x, y) => Number(y.ready) - Number(x.ready) || String(x.name).localeCompare(String(y.name)));
  const link = getAcesioLink();
  return {
    items, configured: !!link.key,
    counts: { total: items.length, ready: items.filter((i) => i.ready).length, incomplete: items.filter((i) => !i.ready).length, failed: items.filter((i) => i.acesioStatus === 'failed').length },
  };
}

const SUBMIT_ALL_MAX = 200;

export async function handle(req, res, url, ctx) {
  const p = url.pathname;
  if (p !== '/api/leads' && !p.startsWith('/api/leads/')) return false;
  const m = req.method;
  const send = (code, body) => (ctx.sendJSON(res, code, body), true);
  const fail = (code, msg) => send(code, { error: msg });
  const notAllowed = () => fail(405, 'Metode tidak diizinkan');
  const who = ctx.user?.name || 'pengguna';

  const readJSON = async () => {
    try {
      const b = await ctx.readBody(req);
      if (isObj(b)) return b;
    } catch { /* jatuh ke 400 */ }
    fail(400, 'Isi permintaan tidak valid');
    return null;
  };

  try {
    // Rute tetap dicek SEBELUM pola :id.
    if (p === '/api/leads') {
      if (m !== 'GET') return notAllowed();
      const tz = getTz();
      const o = parseQuery(url.searchParams, tz);
      if (o.error) return fail(400, o.error);
      const items = select(o);
      const pages = Math.max(1, Math.ceil(items.length / o.pageSize));
      const page = Math.min(o.page, pages);
      const platforms = [...new Set([...L.platformNames(), ...store.all().map((l) => l.platform).filter(Boolean)])];
      sendCached(req, res, {
        leads: items.slice((page - 1) * o.pageSize, page * o.pageSize), total: items.length, page, pageSize: o.pageSize,
        statuses: store.STATUSES, dataTypes: store.DATA_TYPES, hotStages: store.HOT_STAGES, platforms, tz,
      });
      return true;
    }

    if (p === '/api/leads/stats') {
      if (m !== 'GET') return notAllowed();
      const period = url.searchParams.get('period') || 'day';
      if (!PERIODS.includes(period)) return fail(400, 'Periode tidak valid (day, week, month, year)');
      return send(200, computeStats(period, getTz()));
    }

    if (p === '/api/leads/export.csv') {
      if (m !== 'GET') return notAllowed();
      const tz = getTz();
      const o = parseQuery(url.searchParams, tz);
      if (o.error) return fail(400, o.error);
      const items = select(o);
      const csv = buildCSV(items, tz);
      ctx.audit('lead.export', { count: items.length });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="leads-${dayKey(Date.now(), tz)}.csv"`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      res.end(csv);
      return true;
    }

    if (p === '/api/leads/from-conversation') {
      if (m !== 'POST') return notAllowed();
      const b = await readJSON();
      if (!b) return true;
      const phone = String(b.phone ?? '').replace(/\D/g, '');
      if (phone.length < 6 || phone.length > 20) return fail(400, 'Nomor telepon tidak valid');
      const conv = C.get(phone);
      if (!conv) return fail(404, 'Percakapan tidak ditemukan');
      if (typeof L.createFromConversation !== 'function') return fail(501, 'Pembuatan lead dari percakapan belum tersedia');
      const mine = (Array.isArray(conv.messages) ? conv.messages : []).filter((x) => x.by === 'customer');
      const r = L.createFromConversation({
        phone, lid: conv.lid || null, name: conv.name || '', firstMessage: mine[0]?.text || '',
        ts: mine[0]?.ts || conv.createdAt || Date.now(), customerCount: mine.length, data: conv.data || {},
      });
      ctx.audit('lead.create', { id: r.lead?.id, phone, existed: !!r.existed });
      return send(r.existed ? 200 : 201, { lead: detailView(r.lead), existed: !!r.existed });
    }

    // ----- pengajuan ke Acesio: antrean + ajukan semua -----
    if (p === '/api/leads/acesio/queue') {
      if (m !== 'GET') return notAllowed();
      return send(200, acesioQueue());
    }
    if (p === '/api/leads/acesio/submit-all') {
      if (m !== 'POST') return notAllowed();
      if (!getAcesioLink().key) return fail(503, 'Integrasi Acesio belum dikonfigurasi: isi alamat dan kunci Acesio di Pengaturan (tab Integrasi).');
      const todo = acesioQueue().items.filter((i) => i.ready).slice(0, SUBMIT_ALL_MAX);
      const results = [];
      for (const it of todo) { // berurutan: tidak membebani Acesio, dan galat satu lead tidak menghentikan yang lain
        const cur = store.all().find((l) => l.id === it.id);
        if (!cur) continue;
        const r = await submitToAcesio(cur, ctx);
        results.push({ id: it.id, name: it.name, ok: r.status === 200 && r.body.ok === true, replayed: r.body.replayed === true, error: r.status === 200 ? null : r.body.error });
      }
      const sent = results.filter((r) => r.ok && !r.replayed).length, replayed = results.filter((r) => r.replayed).length, failed = results.filter((r) => !r.ok).length;
      const q = acesioQueue();
      ctx.audit('lead.send_to_acesio_all', { total: results.length, sent, replayed, failed });
      return send(200, { ok: failed === 0, total: results.length, sent, replayed, failed, skippedIncomplete: q.counts.incomplete, results, queue: q });
    }

    const mm = p.match(SUB_ROUTE);
    if (!mm) return false;
    const [, id, sub, sub2] = mm;
    if (sub2 && sub !== 'notes') return false;
    const find = () => store.all().find((l) => l.id === id);
    const gone = () => fail(404, 'Lead tidak ditemukan');

    // ----- detail / ubah / hapus -----
    if (!sub) {
      if (m === 'GET') { const l = find(); return l ? send(200, { lead: detailView(l) }) : gone(); }

      if (m === 'DELETE') {
        if (!ctx.requireRole('admin')) return true;
        const l = find();
        if (!l) return gone();
        store.remove(id);
        ctx.audit('lead.delete', { id, phone: l.phone ?? null }); // percakapan tidak ikut terhapus
        return send(200, { ok: true });
      }

      if (m === 'PATCH') {
        const cur = find();
        if (!cur) return gone();
        const b = await readJSON();
        if (!b) return true;
        const patch = {}, fields = [], now = Date.now();
        for (const k of ['name', 'keyword', 'platform']) {
          if (!(k in b)) continue;
          if (typeof b[k] !== 'string') return fail(400, `Field ${k} harus berupa teks`);
          const v = b[k].trim().slice(0, 200);
          if (k === 'platform' && !v) return fail(400, 'Sumber tidak boleh kosong');
          patch[k] = v; fields.push(k);
        }
        if ('referensi' in b) {
          if (typeof b.referensi !== 'string') return fail(400, 'Field referensi harus berupa teks');
          const v = b.referensi.replace(/\s+/g, ' ').trim();
          if (v.length > REFERENSI_MAX) return fail(400, `Referensi maksimal ${REFERENSI_MAX} karakter`);
          patch.referensi = v; fields.push('referensi');
        }
        if ('phone' in b) {
          if (typeof b.phone !== 'string' && typeof b.phone !== 'number') return fail(400, 'Field phone harus berupa teks atau angka');
          const ph = canonPhone(b.phone);
          if (!ph) return fail(400, 'Nomor telepon tidak valid (8-15 angka; boleh diawali 0 atau kode negara)');
          if (store.all().some((x) => x.id !== id && x.phone === ph)) return fail(409, 'Nomor ini sudah dipakai lead lain');
          patch.phone = ph; fields.push('phone');
        }
        if ('booking' in b) {
          const bk = b.booking;
          if (!isObj(bk)) return fail(400, 'Field booking harus berupa objek');
          const data = { ...(isObj(cur.data) ? cur.data : {}) };
          if ('day' in bk) {
            const raw = String(bk.day ?? '').trim();
            if (!raw) delete data.booking_day;
            else {
              const d = parseDay(raw, now);
              if (!d) return fail(400, 'Tanggal booking tidak valid (contoh 2026-11-29)');
              if (d < todayYmd(now)) return fail(400, 'Tanggal booking sudah lewat');
              data.booking_day = d;
            }
          }
          if ('time' in bk) {
            const raw = String(bk.time ?? '').trim();
            if (!raw) delete data.booking_time;
            else {
              const t = parseTime(raw);
              if (!t) return fail(400, 'Jam booking tidak valid (contoh 14:00)');
              data.booking_time = t;
            }
          }
          if ('services' in bk) {
            const raw = (Array.isArray(bk.services) ? bk.services.join(', ') : String(bk.services ?? '')).replace(/\s+/g, ' ').trim().slice(0, 200);
            if (!raw) delete data.booking_services; else data.booking_services = raw;
          }
          patch.data = data; fields.push('booking');
        }
        const reset = truthy(b.resetAuto), confirmHot = truthy(b.confirmHot);
        if (reset && confirmHot) return fail(400, 'resetAuto dan confirmHot tidak bisa dipakai bersamaan');

        const hist = [...norm(cur).statusHistory];
        const manualStatus = (status) => {
          if (!hist.length) hist.push({ status: cur.status, ts: num(cur.createdAt) || now, reason: 'Status awal' });
          hist.push({ status, ts: now, reason: `Diubah manual oleh ${who}` });
          Object.assign(patch, { status, statusManual: true, statusReason: 'Diubah manual', statusHistory: hist });
          if (status === 'Hot Leads') patch.hotCandidate = null;
        };
        if (reset) {
          // kembalikan ke otomatis: sistem boleh mengubah status/data leads lagi mulai pesan berikutnya
          Object.assign(patch, { statusManual: false, dataTypeManual: false });
          fields.push('resetAuto');
        } else {
          if (confirmHot) {
            if (cur.status !== 'Hot Leads') manualStatus('Hot Leads');
            Object.assign(patch, { statusManual: true, hotCandidate: null, hotStage: cur.hotStage || 'Follow Up' });
            fields.push('confirmHot');
          } else if ('status' in b) {
            if (!store.STATUSES.includes(b.status)) return fail(400, 'Status tidak valid');
            if (b.status !== cur.status) manualStatus(b.status);
            fields.push('status');
          }
          if ('dataType' in b) {
            if (!store.DATA_TYPES.includes(b.dataType)) return fail(400, 'Data Leads tidak valid');
            if (b.dataType !== cur.dataType) Object.assign(patch, { dataType: b.dataType, dataTypeManual: true, dataReason: 'Diubah manual' });
            fields.push('dataType');
          }
          if ('hotStage' in b) {
            const hs = b.hotStage;
            if (hs !== null && !store.HOT_STAGES.includes(hs)) return fail(400, 'Tahap Hot Lead tidak valid');
            patch.hotStage = hs;
            fields.push('hotStage');
            if (hs === 'Won') {
              // nama kosong dipulihkan dari nama WhatsApp; nama yang sudah ada (termasuk hasil edit admin) tidak ditimpa
              const wa = String(cur.waName ?? '').trim();
              if (wa && placeholderName('name' in patch ? patch.name : cur.name)) {
                patch.name = wa;
                if (!fields.includes('name')) fields.push('name');
              }
            }
          }
        }
        if (!fields.length) return fail(400, 'Tidak ada field yang bisa diubah');
        const wasWon = cur.hotStage === 'Won'; // cur adalah objek yang sama dengan lead di store: baca sebelum update
        const lead = store.update(id, patch);
        ctx.audit('lead.update', { id, fields });
        if (patch.hotStage === 'Won' && !wasWon) setImmediate(() => autoSubmitLead(id, ctx.audit).catch(() => {})); // DP lunas -> ajukan otomatis
        return send(200, { lead: detailView(lead) });
      }
      return notAllowed();
    }

    // ----- blokir (hanya admin) -----
    if (sub === 'block' || sub === 'unblock') {
      if (m !== 'POST') return notAllowed();
      if (!ctx.requireRole('admin')) return true;
      const l = find();
      if (!l) return gone();
      const fn = L[sub];
      if (typeof fn !== 'function') return fail(501, 'Fitur blokir belum tersedia');
      if (!l.phone && !l.lid) return fail(400, 'Lead tidak punya nomor atau LID untuk diblokir');
      fn({ phone: l.phone ?? null, lid: l.lid ?? null });
      const lead = store.update(id, { blocked: sub === 'block' });
      ctx.audit('lead.' + sub, { id });
      return send(200, { lead: detailView(lead) });
    }

    const cur = find();
    if (!cur) return gone();

    // ----- catatan -----
    if (sub === 'notes') {
      const notes = Array.isArray(cur.notes) ? cur.notes : [];
      if (m === 'POST' && !sub2) {
        const b = await readJSON();
        if (!b) return true;
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (!text) return fail(400, 'Catatan tidak boleh kosong');
        if (text.length > 1000) return fail(400, 'Catatan maksimal 1000 karakter');
        if (notes.length >= MAX_NOTES) return fail(400, `Batas ${MAX_NOTES} catatan per lead sudah tercapai`);
        const note = { id: randomUUID(), by: who, text, ts: Date.now() };
        store.update(id, { notes: [...notes, note] });
        ctx.audit('lead.note.add', { id, noteId: note.id });
        return send(201, { note, noteCount: notes.length + 1 });
      }
      if (m === 'DELETE' && sub2) {
        const note = notes.find((n) => n.id === sub2);
        if (!note) return fail(404, 'Catatan tidak ditemukan');
        if (note.by !== ctx.user?.name && ctx.user?.role !== 'admin') return fail(403, 'Hanya penulis catatan atau admin yang boleh menghapus');
        store.update(id, { notes: notes.filter((n) => n.id !== sub2) });
        ctx.audit('lead.note.delete', { id, noteId: sub2 });
        return send(200, { ok: true, noteCount: notes.length - 1 });
      }
      return notAllowed();
    }

    // ----- tindak lanjut -----
    if (sub === 'followup') {
      if (m !== 'PUT') return notAllowed();
      const b = await readJSON();
      if (!b) return true;
      if (!('date' in b)) return fail(400, 'Field date wajib diisi (YYYY-MM-DD atau null)');
      if (b.date !== null && !validDate(b.date)) return fail(400, 'Format tanggal harus YYYY-MM-DD dan tanggalnya harus valid');
      const note = b.note == null ? '' : b.note;
      if (typeof note !== 'string') return fail(400, 'Catatan tindak lanjut harus berupa teks');
      if (note.trim().length > 300) return fail(400, 'Catatan tindak lanjut maksimal 300 karakter');
      const lead = store.update(id, { followUpDate: b.date, followUpNote: b.date === null ? '' : note.trim() });
      ctx.audit('lead.followup', { id, date: b.date });
      return send(200, { lead: detailView(lead) });
    }

    // ----- transaksi selesai -----
    if (sub === 'transaction-done') {
      if (m !== 'POST') return notAllowed();
      if (typeof L.markTransactionDone !== 'function') return fail(501, 'Fitur transaksi selesai belum tersedia');
      const hasOpen = norm(cur).transactionCycles.some((c) => c && !c.doneAt);
      if (!hasOpen) return fail(400, 'Tidak ada transaksi terbuka untuk ditandai selesai');
      const patch = L.markTransactionDone(cur, Date.now());
      if (!isObj(patch) || !Object.keys(patch).length) return fail(400, 'Tidak ada transaksi terbuka untuk ditandai selesai');
      const lead = store.update(id, patch);
      ctx.audit('lead.transaction-done', { id });
      return send(200, { lead: detailView(lead) });
    }

    // ----- kirim ke acesio -----
    if (sub === 'send-to-acesio') {
      if (m !== 'POST') return notAllowed();
      const r = await submitToAcesio(cur, ctx);
      return send(r.status, r.body);
    }

    return false;
  } catch (e) {
    console.error('[crm]', e);
    return fail(500, 'Terjadi kesalahan pada server');
  }
}