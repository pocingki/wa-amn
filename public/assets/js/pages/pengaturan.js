// Pengaturan dengan sub menu (tab): Umum, WhatsApp (QR Baileys + serah-terima), Balasan AI (kuota, pemakaian), Integrasi (Acesio, Booking Live),
// Notifikasi & data (Telegram, retensi). Mode API resmi (Convia) disembunyikan dari UI; kode backend tidak berubah.
import { checkBase, normalizeHex, paletteFrom, DEFAULT_PALETTE } from '../brand-color.js';
import * as booking from './integrasi.js';
import {
  $, api, send, esc, icon, field, INP, BTN_DARK, BTN_LIGHT, toast, poll, onEvent, confirmDialog, getMe, isAdminRole, waStatusView,
  loadSettings, getSettings, saveSettings, onSettingsChange,
} from '../lib.js';

let stopPoll = null, stopUsage = null, off = null, offEv = null, lastQr = null, canEdit = true, root, brandInfo = null;
const TAB_LIST = [['umum', 'Umum'], ['whatsapp', 'WhatsApp'], ['ai', 'Balasan AI'], ['agen', 'Agen CRM'], ['integrasi', 'Integrasi'], ['notif', 'Notifikasi & data']];
const TAB_KEY = 'amn-pengaturan-tab';
const SAVE_TABS = ['umum', 'whatsapp', 'notif', 'agen']; // tab yang memakai tombol Simpan pengaturan
let tab = 'umum';
let acesio = null, keyState = null, keyEdit = false, usageState = { data: null, error: '' };


const RANGES = [
  ['botDurationMinutes', 'Batas durasi bot aktif', 0, 10080], ['adminAutoReturnMinutes', 'Bot aktif kembali otomatis', 0, 10080], ['staleMinutes', 'Batas pesan basi', 1, 1440],
  ['fallbackCooldownMinutes', 'Jeda respons default', 0, 1440], ['sendRateLimitPerMinute', 'Batas kirim per menit', 1, 600],
  ['retentionDays', 'Retensi data', 0, 3650],
];
const NOTIFY_RANGE = ['attentionMinutes', 'Menit sebelum pengingat perlu perhatian', 0, 1440];

/** Validasi + susun patch dari nilai form (murni, diuji). values: objek nama->string (checkbox: 'on' / tidak ada). */
export function buildSettingsPatch(v, cur = {}) {
  const errors = [], p = {};
  const txt = (k, max) => { p[k] = String(v[k] ?? '').trim().slice(0, max); };
  txt('brandName', 60); txt('brandTagline', 100); txt('botName', 60); txt('adminName', 60);
  if ('brandColor' in v) { // kosong = palet bawaan; selain itu harus #RRGGBB yang cukup gelap untuk teks putih
    const c = String(v.brandColor ?? '').trim();
    const bad = c ? checkBase(c) : null;
    if (bad) errors.push({ field: 'brandColor', msg: bad });
    else p.brandColor = c ? normalizeHex(c) : '';
  }
  for (const k of ['openingMessage', 'handoverMessage']) if (k in v) txt(k, 2000); // dikelola di halaman Pesan
  p.botEnabled = v.botEnabled === 'on';
  p.autoTakeoverOnPhoneReply = v.autoTakeoverOnPhoneReply === 'on';
  const num = (k, label, min, max, target = p) => {
    const raw = String(v[k] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < min || n > max) errors.push({ field: k, msg: `${label} harus bilangan bulat ${min}-${max}.` });
    else target[k] = n;
  };
  for (const [k, l, a, b] of RANGES) num(k, l, a, b);
  const n = { ...(cur.notify || {}) };
  for (const k of ['telegramBotToken', 'telegramChatId']) n[k] = String(v[k] ?? '').trim();
  if ((n.telegramBotToken && !n.telegramChatId) || (!n.telegramBotToken && n.telegramChatId)) errors.push({ field: 'telegramChatId', msg: 'Telegram butuh token bot DAN chat ID, atau kosongkan keduanya.' });
  n.onHot = v.onHot === 'on';
  n.onDisconnected = v.onDisconnected === 'on';
  num(NOTIFY_RANGE[0], NOTIFY_RANGE[1], NOTIFY_RANGE[2], NOTIFY_RANGE[3], n);
  p.notify = n;
  // Bagian baru: hanya diproses bila ada di form (pemanggil lama tanpa kunci ini tetap valid).
  if ('phoneFormat' in v) {
    const f = String(v.phoneFormat ?? '').trim();
    if (!PHONE_FORMATS.includes(f)) errors.push({ field: 'phoneFormat', msg: 'Pilih salah satu format nomor telepon.' });
    else p.phoneFormat = f;
  }
  if ('greetingWords' in v) {
    const g = normalizeGreetings(v.greetingWords);
    if (!g.length) errors.push({ field: 'g-add', msg: 'Daftar kata salam tidak boleh kosong.' });
    else p.greetingWords = g;
  }
  if ('referensiQuestion' in v) {
    const q = String(v.referensiQuestion ?? '').replace(/\s+/g, ' ').trim().slice(0, REF_Q_MAX);
    if (!q) errors.push({ field: 'referensiQuestion', msg: 'Teks pertanyaan referensi wajib diisi.' });
    else {
      const old = (Array.isArray(cur.requiredFields) ? cur.requiredFields : []).find((f) => f?.id === 'referensi');
      p.requiredFields = [{ id: 'referensi', type: 'text', enabled: old?.enabled !== false, question: q }]; // tepat satu butir
    }
  }
  if ('crmAgentForm' in v) { // tab Agen CRM
    const clip = (k, max) => String(v[k] ?? '').trim().slice(0, max);
    const delays = [];
    for (const [i, k] of ['crmDelay1', 'crmDelay2'].entries()) {
      const n = Number(String(v[k] ?? '').trim());
      if (!Number.isInteger(n) || n < 5 || n > 10080) errors.push({ field: k, msg: `Jeda follow up ke-${i + 1} harus bilangan bulat 5-10080 menit.` });
      else delays.push(n);
    }
    p.crmAgent = {
      enabled: v.crmEnabled === 'on', askBooking: v.crmAskBooking === 'on', autoSubmit: v.crmAutoSubmit === 'on',
      formIntro: clip('crmFormIntro', 1000), doneMessage: clip('crmDoneMessage', 1000),
      followUpDelaysMinutes: delays, followUpMessages: [clip('crmFollow1', 1000), clip('crmFollow2', 1000)],
    };
  }
  return { patch: p, errors };
}

// ---- Format nomor, kata salam, pertanyaan referensi (murni, bisa diuji) ----
const PHONE_FORMATS = ['digits', 'international'];
const SAMPLE_PHONE = '6281381688802';
const REF_Q_MAX = 300;
// Bawaan sama dengan kontrak aturan bisnis (pemilik: B7). Dipakai tombol "Kembalikan bawaan" dan bila server belum mengirim daftar.
export const DEFAULT_GREETINGS = ['halo', 'hallo', 'hai', 'hi', 'hello', 'hey', 'permisi', 'assalamualaikum', "assalamu'alaikum", 'salam', 'selamat pagi', 'selamat siang', 'selamat sore', 'selamat malam', 'pagi', 'siang', 'sore', 'malam', 'p'];
const GREET_MAX = 100;

/** Rapikan satu kata salam: huruf kecil, spasi tunggal, maks 40 karakter dan 3 kata (aturan isGreeting memeriksa 3 kata pertama). */
export function cleanGreeting(w) {
  return String(w ?? '').toLowerCase().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ').slice(0, 40);
}

/** Daftar kata salam bersih: tanpa kosong/ganda, maks 100 butir. Bukan larik -> []. */
export function normalizeGreetings(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(cleanGreeting).filter(Boolean))].slice(0, GREET_MAX);
}

/** Format nomor untuk TAMPILAN. 'international': 62 -> "+62 813-8168-8802"; kode negara lain -> "+" + angka. */
export function formatPhone(raw, fmt = 'digits') {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (!d || fmt !== 'international') return d;
  if (d.startsWith('62') && d.length > 2) {
    const r = d.slice(2);
    return '+62 ' + [r.slice(0, 3), r.slice(3, 7), r.slice(7)].filter(Boolean).join('-');
  }
  return '+' + d;
}

// ---- Balasan AI: validasi form (murni, bisa diuji) ----
export const AI_PROVIDERS = [
  ['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI'], ['gemini', 'Google Gemini'], ['openai-compatible', 'OpenAI-compatible (alamat sendiri)'],
];
export const AI_DEFAULTS = {
  enabled: false, provider: 'anthropic', baseUrl: '', model: '', persona: '', rules: '', maxHistory: 10, maxReplyChars: 600, timeoutMs: 20000,
  monthlyQuota: 1000, perCustomerDailyLimit: 20, quotaExhaustedMessage: 'Terima kasih, pesan Anda kami teruskan ke admin.', errorMessage: '',
};
// ASUMSI: batas panjang/angka di bawah adalah pilihan B8 (kontrak tidak menyebut angka); B7 bebas memperketat.
const AI_LIMITS = { model: 100, baseUrl: 300, persona: 2000, rules: 4000, message: 1000, monthly: [1, 1000000], daily: [1, 10000] };

/** Susun patch { ai: {...} } dari form. maxHistory/maxReplyChars/timeoutMs tidak ada di UI: nilai tersimpan dipertahankan. */
export function buildAiPatch(v, cur = {}) {
  const errors = [];
  const old = { ...AI_DEFAULTS, ...(cur.ai && typeof cur.ai === 'object' ? cur.ai : {}) };
  const a = { maxHistory: old.maxHistory, maxReplyChars: old.maxReplyChars, timeoutMs: old.timeoutMs };
  const one = (x, max) => String(x ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  a.enabled = v.aiEnabled === 'on';
  const provider = String(v.aiProvider ?? '').trim();
  if (!AI_PROVIDERS.some(([k]) => k === provider)) errors.push({ field: 'aiProvider', msg: 'Pilih salah satu penyedia AI.' });
  else a.provider = provider;
  a.model = String(v.aiModel ?? '').replace(/\s+/g, ' ').trim().slice(0, AI_LIMITS.model);
  if (a.enabled && !a.model) errors.push({ field: 'aiModel', msg: 'Isi nama model sebelum mengaktifkan balasan AI.' });
  const base = String(v.aiBaseUrl ?? '').trim().slice(0, AI_LIMITS.baseUrl);
  let baseOk = '';
  if (base) {
    try {
      const u = new URL(base);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('x');
      baseOk = base;
    } catch { baseOk = ''; }
  }
  if (a.provider === 'openai-compatible' && !baseOk) errors.push({ field: 'aiBaseUrl', msg: 'Alamat dasar wajib diisi untuk OpenAI-compatible, berawalan http:// atau https:// dan tanpa nama pengguna/kata sandi.' });
  a.baseUrl = baseOk;
  a.persona = one(v.aiPersona, AI_LIMITS.persona);
  a.rules = one(v.aiRules, AI_LIMITS.rules);
  const num = (k, label, [min, max], target) => {
    const raw = String(v[k] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < min || n > max) errors.push({ field: k, msg: `${label} harus bilangan bulat ${min}-${max}.` });
    else a[target] = n;
  };
  num('aiMonthlyQuota', 'Batas bulanan', AI_LIMITS.monthly, 'monthlyQuota');
  num('aiDailyLimit', 'Batas per customer per hari', AI_LIMITS.daily, 'perCustomerDailyLimit');
  a.quotaExhaustedMessage = one(v.aiQuotaMessage, AI_LIMITS.message);
  if (!a.quotaExhaustedMessage) errors.push({ field: 'aiQuotaMessage', msg: 'Pesan kuota habis wajib diisi.' });
  a.errorMessage = one(v.aiErrorMessage, AI_LIMITS.message); // kosong = pakai respons default
  return { patch: { ai: a }, errors };
}

/** Validasi kunci API sebelum dikirim (murni). Tidak pernah memuat isi kunci di pesan. */
export function validateKeyInput(k) {
  const key = String(k ?? '').trim();
  if (!key) return { key: '', error: 'Tempel kunci API terlebih dahulu.' };
  if (/\s/.test(key)) return { key: '', error: 'Kunci API tidak boleh mengandung spasi atau baris baru.' };
  if (key.length > 500) return { key: '', error: 'Kunci API terlalu panjang.' };
  return { key, error: '' };
}

// ---- Pemakaian AI: normalisasi respons GET /api/ai/usage (murni, bisa diuji) ----
const nz = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0);
export const fmtNum = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n).toLocaleString('id-ID') : '-');

/** 'YYYY-MM-DD' -> "15 Nov" (tanpa pergeseran zona waktu). */
export function dayShort(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
}

/**
 * Tanggal reset kuota dari month.to. ASUMSI (B3 belum terverifikasi): `to` = akhir periode (epoch ms atau ISO),
 * jadi reset = to + 1 md; tanggal 'YYYY-MM-DD' dianggap hari terakhir (inklusif) sehingga reset = hari berikutnya.
 */
export function resetLabel(to, tz = 'Asia/Jakarta') {
  let d, zone = tz;
  if (typeof to === 'number' && Number.isFinite(to)) d = new Date(to + 1);
  else if (typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to)) { const [y, m, dd] = to.split('-').map(Number); d = new Date(Date.UTC(y, m - 1, dd + 1)); zone = 'UTC'; }
  else if (typeof to === 'string' && !Number.isNaN(Date.parse(to))) d = new Date(Date.parse(to) + 1);
  else return '';
  const opt = { day: 'numeric', month: 'long', year: 'numeric' };
  try { return d.toLocaleDateString('id-ID', { ...opt, timeZone: zone }); } catch { return d.toLocaleDateString('id-ID', { ...opt, timeZone: 'Asia/Jakarta' }); }
}

/** Ubah respons usage() B3 menjadi data siap tampil. Tahan terhadap field yang hilang. */
export function usageView(u, tz = 'Asia/Jakarta') {
  const m = u?.month || {};
  const used = nz(m.used), reserved = nz(m.reserved), limit = nz(m.limit);
  const remaining = Number.isFinite(Number(m.remaining)) ? Math.max(0, Math.floor(Number(m.remaining))) : Math.max(0, limit - used - reserved);
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const reservedPct = limit ? Math.min(100 - pct, Math.round((reserved / limit) * 100)) : 0;
  const level = limit && used + reserved >= limit ? 'full' : pct >= 80 ? 'warn' : 'ok';
  const rows = (Array.isArray(u?.daily) ? u.daily : []).slice(-30).map((r) => ({ date: String(r?.date ?? ''), used: nz(r?.used) }));
  const max = rows.reduce((a, r) => Math.max(a, r.used), 0);
  const peak = rows.find((r) => r.used === max && max > 0);
  const bars = rows.map((r) => ({ ...r, label: dayShort(r.date), h: r.used > 0 ? Math.max(4, Math.round((r.used / max) * 100)) : 0 }));
  const ti = u?.tokens?.input, to = u?.tokens?.output;
  const hasTokens = (Number.isFinite(Number(ti)) && ti !== null) || (Number.isFinite(Number(to)) && to !== null);
  return {
    used, reserved, limit, remaining, pct, reservedPct, level, today: nz(u?.today?.used),
    bars, max, peak: peak ? { date: peak.date, label: dayShort(peak.date), used: peak.used } : null, total30: rows.reduce((a, r) => a + r.used, 0),
    tokens: { has: hasTokens, input: nz(ti), output: nz(to) }, reset: resetLabel(m.to, tz),
  };
}

const WA_PROVIDER_VALUES = ['baileys', 'convia'];

/** Validasi pilihan koneksi WhatsApp (murni, diuji). Tidak dipakai UI sejak mode API resmi disembunyikan; backend dan tes tetap memakainya. */
export function buildWaProviderPatch(value, cur = {}) {
  const v = String(value ?? '').trim();
  if (!WA_PROVIDER_VALUES.includes(v)) return { patch: null, changed: false, errors: [{ field: 'waProvider', msg: 'Pilih salah satu jenis koneksi WhatsApp.' }] };
  return { patch: { waProvider: v }, changed: v !== (cur.waProvider || 'baileys'), errors: [] };
}

/** Alamat webhook Convia (tidak ditampilkan di UI; dipertahankan untuk tes). */
export function webhookAddress(convia) {
  const path = convia?.webhookPath || '/webhooks/convia';
  const base = String(convia?.publicUrl || '').replace(/\/+$/, '');
  return { url: base + path, complete: !!base };
}

const chk = (name, on, label, hint = '', dis = '') => `<label class="flex items-start gap-2 text-sm font-medium"><input type="checkbox" name="${name}" class="mt-1" ${on ? 'checked' : ''} ${dis}><span>${label}${hint ? `<span class="block text-xs text-gray-600 font-normal">${hint}</span>` : ''}</span></label>`;

export async function mount(el) {
  root = el;
  lastQr = null;
  const [, me, bi] = await Promise.all([loadSettings(), getMe().catch(() => null), api('/api/brand').catch(() => null)]);
  brandInfo = bi;
  canEdit = isAdminRole(me);
  acesio = null; keyState = null; keyEdit = false; usageState = { data: null, error: '' };
  off = onSettingsChange((s, src) => { if (src !== 'save') render(); });
  render();
  offEv = onEvent('wa:status', () => pollWA());
  stopPoll = poll(pollWA, 3000);
  stopUsage = poll(loadUsage, 60000); // muat ulang ringan tiap menit (hanya saat tab terlihat)
}

export function unmount() { booking.unmount(); stopPoll?.(); stopUsage?.(); off?.(); offEv?.(); stopPoll = stopUsage = off = offEv = null; }

/** Warna utama: pemilih warna + kode hex + pratinjau palet (rumus sama dengan server). */
function colorField(S, dis) {
  const c = S.brandColor || '';
  return field('Warna utama brand', `<div class="flex items-center gap-2">
      <input type="color" id="b-color-pick" value="${esc(c || DEFAULT_PALETTE[800])}" class="h-10 w-14 p-1 border border-gray-300 rounded-lg bg-white" aria-label="Pilih warna" ${dis}>
      <input name="brandColor" id="b-color" class="${INP}" value="${esc(c)}" placeholder="Kosong = biru bawaan, contoh #0b5fa5" maxlength="7" autocomplete="off" spellcheck="false" ${dis}>
      ${dis ? '' : `<button type="button" id="b-color-reset" class="${BTN_LIGHT} shrink-0">Bawaan</button>`}
    </div>
    <div id="b-palette" class="rounded overflow-hidden mt-2" style="display:flex;height:12px" aria-hidden="true">${paletteStrip(c)}</div>
    <p id="b-color-msg" class="text-xs text-red-800 mt-1" role="status" hidden></p>`, 'Dipakai untuk judul, tombol, dan lencana di dashboard dan halaman login. Klik Simpan pengaturan untuk menerapkan.');
}

function paletteStrip(c) {
  const p = paletteFrom(checkBase(c) ? '' : c);
  return Object.entries(p).map(([k, v]) => `<span title="${k}" style="flex:1;background:${esc(v)}"></span>`).join('');
}

/** Logo dan favicon: diunggah langsung (tidak lewat tombol Simpan). */
function assetRows(BI, dis) {
  const kb = (n) => (n >= 1024 ? `${+(n / 1024).toFixed(1)} MB` : `${n} KB`);
  const lim = BI?.limits || { logoKB: 1024, faviconKB: 256 };
  const row = (kind, label, hint, accept, info, preview) => `<div class="flex items-center gap-3 flex-wrap">
      ${preview}
      <div class="min-w-0 flex-1"><div class="text-sm font-medium">${label}</div><div class="text-xs text-gray-600">${hint}</div></div>
      ${dis ? '' : `<div class="flex gap-2"><button type="button" data-up="${kind}" class="${BTN_LIGHT}">${info ? 'Ganti' : 'Unggah'}</button>${info ? `<button type="button" data-del="${kind}" class="${BTN_LIGHT}">Hapus</button>` : ''}<input type="file" data-file="${kind}" accept="${accept}" hidden></div>`}
    </div>`;
  const box = 'border border-gray-200 rounded-lg bg-white p-1';
  const logoPrev = BI?.logo
    ? `<img src="/brand/logo?v=${BI.logo.updatedAt}" alt="Logo saat ini" class="h-12 max-w-[9rem] object-contain ${box}">`
    : `<div class="h-12 w-20 flex items-center justify-center text-xs text-gray-500 ${box}">Belum ada</div>`;
  const icoPrev = `<img src="/brand/favicon?v=${BI?.favicon?.updatedAt || 0}" alt="Favicon saat ini" class="h-10 w-10 object-contain ${box}">`;
  return row('logo', 'Logo', `PNG, JPG, atau WebP, maks ${kb(lim.logoKB)}. Latar transparan lebih baik. Tampil di header dan halaman login.`, 'image/png,image/jpeg,image/webp', BI?.logo, logoPrev)
    + row('favicon', 'Favicon (ikon tab browser)', `PNG persegi (64x64 atau lebih) atau ICO, maks ${kb(lim.faviconKB)}.`, 'image/png,.ico,image/x-icon', BI?.favicon, icoPrev);
}

function bindBrand() {
  const pick = $('#b-color-pick'), txt = $('#b-color');
  if (txt && canEdit) {
    const sync = (fromPicker) => {
      const v = txt.value.trim();
      const bad = v ? checkBase(v) : null;
      const msg = $('#b-color-msg');
      msg.hidden = !bad;
      msg.textContent = bad || '';
      $('#b-palette').innerHTML = paletteStrip(bad ? '' : v);
      if (!fromPicker && !bad && v) pick.value = normalizeHex(v);
    };
    pick.oninput = () => { txt.value = pick.value; sync(true); };
    txt.oninput = () => sync(false);
    $('#b-color-reset').onclick = () => { txt.value = ''; pick.value = DEFAULT_PALETTE[800]; sync(true); };
  }
  const box = $('#b-assets');
  if (!box || !canEdit) return;
  const run = async (fn, okMsg) => {
    try {
      brandInfo = await fn();
      box.innerHTML = assetRows(brandInfo, false);
      window.dispatchEvent(new Event('brand-changed'));
      toast(okMsg);
    } catch (err) { toast(err.message, true); }
  };
  box.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.up) box.querySelector(`[data-file="${b.dataset.up}"]`)?.click();
    else if (b.dataset.del) {
      const label = b.dataset.del === 'logo' ? 'logo' : 'favicon';
      if (!(await confirmDialog(`Hapus ${label}?`, `Tampilan kembali ke ${label === 'logo' ? 'ikon bawaan' : 'favicon bawaan'}.`, { okText: 'Hapus', danger: true }))) return;
      await run(() => api(`/api/brand/${b.dataset.del}`, { method: 'DELETE' }), `${label} dihapus`);
    }
  };
  box.onchange = async (e) => {
    const input = e.target;
    const kind = input.dataset?.file;
    const f = input.files?.[0];
    if (!kind || !f) return;
    input.value = '';
    const maxKB = kind === 'logo' ? (brandInfo?.limits?.logoKB ?? 1024) : (brandInfo?.limits?.faviconKB ?? 256);
    if (f.size > maxKB * 1024) { toast(`Berkas terlalu besar (maks ${maxKB} KB).`, true); return; }
    await run(() => api(`/api/brand/${kind}`, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f }), `${kind === 'logo' ? 'Logo' : 'Favicon'} diperbarui`);
  };
}

/** Sub menu (tab): hanya satu bagian tampil. Semua bagian tetap ada di halaman, jadi satu tombol Simpan tetap membaca semua kolom. */
function pickTab(k) {
  const keys = TAB_LIST.map(([x]) => x).filter((x) => canEdit || x !== 'integrasi');
  tab = keys.includes(k) ? k : 'umum';
  try { sessionStorage.setItem(TAB_KEY, tab); } catch { /* penyimpanan tidak tersedia: tab tetap jalan */ }
  document.querySelectorAll('#view [data-panel]').forEach((el) => { el.hidden = el.dataset.panel !== tab; });
  document.querySelectorAll('#view [data-tab]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  const save = $('#s-save');
  if (save) save.hidden = !SAVE_TABS.includes(tab);
  if (tab === 'integrasi') booking.mount($('#booking-box')).catch((e) => toast(e.message, true));
}

function bindTabs() {
  let want = tab;
  try { want = sessionStorage.getItem(TAB_KEY) || tab; } catch { /* abaikan */ }
  const list = document.querySelector('#view [role=tablist]');
  list.onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) pickTab(b.dataset.tab); };
  list.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const bs = [...list.querySelectorAll('[data-tab]')];
    const i = bs.findIndex((b) => b.dataset.tab === tab);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length;
    e.preventDefault(); pickTab(bs[n].dataset.tab); bs[n].focus();
  };
  pickTab(want);
}

function render() {
  const S = getSettings(), N = S.notify || {};
  const A = { ...AI_DEFAULTS, ...(S.ai && typeof S.ai === 'object' ? S.ai : {}) };
  const A_CRM = { enabled: false, askBooking: true, autoSubmit: true, formIntro: '', doneMessage: '', followUpDelaysMinutes: [180, 1440], followUpMessages: ['', ''], ...(S.crmAgent && typeof S.crmAgent === 'object' ? S.crmAgent : {}) };
  const dis = canEdit ? '' : 'disabled';
  const phoneFmt = PHONE_FORMATS.includes(S.phoneFormat) ? S.phoneFormat : 'digits';
  const num = (name, label, hint, min, max) => field(label, `<input name="${name}" type="number" min="${min}" max="${max}" step="1" class="${INP}" value="${esc(S[name] ?? N[name] ?? '')}" ${dis}>`, hint);
  root.innerHTML = `<h1 class="sr-only">Pengaturan</h1>
  ${canEdit ? '' : `<div class="attn-banner mb-6" role="note">${icon('info')}<span>Anda masuk sebagai Agen: pengaturan hanya bisa dilihat. Perubahan dan pemutusan WhatsApp khusus Admin.</span></div>`}
  <div class="max-w-3xl">
  <div class="tabs" role="tablist" aria-label="Bagian pengaturan">${TAB_LIST.filter(([k]) => canEdit || k !== 'integrasi').map(([k, l]) => `<button type="button" role="tab" id="tab-${k}" data-tab="${k}" class="tab-btn" aria-selected="false" aria-controls="panel-${k}">${l}</button>`).join('')}</div>
  <form id="s-form" novalidate>
    <div data-panel="umum" class="card space-y-6">
      <div><h2 class="font-bold text-lg text-gray-900">Umum</h2><p class="text-sm text-gray-600">Berlaku untuk WhatsApp asli dan Bot Tester</p></div>

      <fieldset class="space-y-4"><legend class="font-semibold text-brand-800 mb-2">Bot &amp; brand</legend>
        ${chk('botEnabled', S.botEnabled, 'Bot aktif (membalas chat otomatis)', '', dis)}
        ${field('Nama brand', `<input name="brandName" class="${INP}" value="${esc(S.brandName)}" ${dis}>`, 'Tampil di header dan footer')}
        ${field('Tagline brand', `<input name="brandTagline" class="${INP}" value="${esc(S.brandTagline)}" ${dis}>`, 'Tampil di bawah nama brand pada header')}
        ${colorField(S, dis)}
        <div id="b-assets" class="space-y-3">${assetRows(brandInfo, !canEdit)}</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${field('Nama bot', `<input name="botName" class="${INP}" value="${esc(S.botName)}" ${dis}>`)}
          ${field('Nama admin', `<input name="adminName" class="${INP}" value="${esc(S.adminName)}" ${dis}>`)}
        </div>
        ${num('botDurationMinutes', 'Batas durasi bot aktif (menit)', '0 = tanpa batas. Menentukan satu "sesi" untuk pengulangan pertanyaan referensi. Tidak memicu pesan pembuka ulang.', 0, 10080)}
      </fieldset>


      <p class="text-sm text-gray-600">Pesan pembuka, kata salam, pertanyaan referensi, pesan serah-terima, dan respons default ada di halaman <a href="#/pesan" class="underline font-medium">Pesan</a>.</p>


      <fieldset class="space-y-3 border-t border-gray-100 pt-4"><legend class="font-semibold text-brand-800 mb-2">Format nomor telepon</legend>
        <p class="text-sm text-gray-600">Hanya mengubah tampilan. Nomor tersimpan tetap berupa angka.</p>
        ${[['digits', 'Angka saja'], ['international', 'Internasional']].map(([val, label]) => `<label class="flex items-start gap-3 border border-gray-200 rounded-lg p-3 text-sm bg-white">
          <input type="radio" name="phoneFormat" value="${val}" class="mt-1 shrink-0" ${phoneFmt === val ? 'checked' : ''} ${dis}>
          <span class="min-w-0"><span class="block font-medium text-gray-900">${label}</span><span class="block text-xs text-gray-600">Contoh: <code class="break-all">${esc(formatPhone(SAMPLE_PHONE, val))}</code></span></span></label>`).join('')}
      </fieldset>

    </div>
    <div data-panel="whatsapp" class="space-y-6" hidden>
    <div class="card space-y-4">
      <div><h2 class="font-bold text-lg text-gray-900">Koneksi WhatsApp</h2><p class="text-sm text-gray-600">Tautkan nomor WhatsApp lewat scan QR (Baileys), lalu pantau statusnya</p></div>
      <div class="border border-gray-200 rounded-xl p-4 bg-gray-50 space-y-2 text-sm" aria-live="polite">
        <p class="font-medium">Status Koneksi Saat Ini: <span id="w-label" class="font-bold inline-flex items-center gap-1 text-red-800">TERPUTUS</span></p>
        <p id="w-number" class="text-gray-700 break-words" hidden></p>
        <p id="w-error" class="text-red-800 break-words" hidden></p>
      </div>
      <div id="w-qr" class="flex-col items-center gap-3 border border-dashed border-gray-300 rounded-xl p-6" hidden>
        <img id="w-img" alt="QR code login WhatsApp" class="w-64 max-w-full h-auto aspect-square">
        <p class="text-sm text-gray-600 text-center">Scan QR ini dari WhatsApp di HP. QR diperbarui otomatis.</p>
      </div>
      ${canEdit ? '<button type="button" id="w-logout" class="text-sm font-medium px-4 py-2 rounded-lg border border-red-300 text-red-800 hover:bg-red-50" hidden>Putuskan &amp; ganti nomor</button>' : ''}
      <ol id="w-steps" class="list-decimal list-inside space-y-1 text-sm text-gray-700" ${S.waProvider === 'convia' ? 'hidden' : ''}>
        <li>Buka WhatsApp di HP, masuk ke Perangkat Tertaut.</li><li>Pilih Tautkan Perangkat, lalu scan QR di atas.</li><li>Setelah TERHUBUNG, chat masuk ke nomor tersebut diproses bot.</li>
      </ol>
    </div>
      <div class="card space-y-6">
      <fieldset class="space-y-4"><legend class="font-semibold text-brand-800 mb-2">Serah-terima &amp; ketahanan</legend>
        ${chk('autoTakeoverOnPhoneReply', S.autoTakeoverOnPhoneReply, 'Otomatis ambil alih saat admin membalas dari HP', 'Bila admin membalas langsung lewat aplikasi WhatsApp di HP, bot berhenti membalas percakapan itu.', dis)}
        ${num('adminAutoReturnMinutes', 'Bot aktif kembali otomatis setelah admin tidak membalas (menit)', '0 = mati (bot tetap diam sampai Anda mengembalikannya manual). Jika diisi, saat pelanggan chat lagi dan admin sudah tidak aktif (tidak membalas atau mengambil alih) lebih lama dari ini, percakapan kembali ke mode bot.', 0, 10080)}
        ${num('staleMinutes', 'Batas pesan basi (menit)', 'Pesan yang lebih lama dari ini (mis. terkirim saat bot mati) tidak dibalas bot dan ditandai perlu perhatian.', 1, 1440)}
        ${num('fallbackCooldownMinutes', 'Jeda respons default (menit)', 'Respons default tidak dikirim berulang ke nomor yang sama dalam rentang ini. 0 = tanpa jeda.', 0, 1440)}
        ${num('sendRateLimitPerMinute', 'Batas kirim per menit', 'Melindungi nomor WhatsApp dari pemblokiran karena mengirim terlalu cepat.', 1, 600)}
      </fieldset>

      </div>
    </div>
    <div data-panel="notif" class="card space-y-6" hidden>
      <div><h2 class="font-bold text-lg text-gray-900">Notifikasi &amp; data</h2></div>
      <fieldset class="space-y-4"><legend class="font-semibold text-brand-800 mb-2">Notifikasi operator (Telegram)</legend>
        <p class="text-sm text-gray-600">Kabar lead hot, WhatsApp putus, dan percakapan yang perlu perhatian dikirim ke Telegram. Nama dan nomor tersamar, isi pesan tidak ikut. Webhook bertanda tangan ke aplikasi lain diatur di tab Integrasi.</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${field('Token bot Telegram', `<input name="telegramBotToken" type="password" autocomplete="off" class="${INP}" value="${esc(N.telegramBotToken || '')}" ${dis}>`, 'Rahasia: jangan dibagikan.')}
          ${field('Chat ID Telegram', `<input name="telegramChatId" autocomplete="off" class="${INP}" value="${esc(N.telegramChatId || '')}" ${dis}>`)}
        </div>
        ${chk('onHot', N.onHot, 'Kabari saat ada lead Hot', '', dis)}
        ${chk('onDisconnected', N.onDisconnected, 'Kabari saat WhatsApp terputus', '', dis)}
        ${num('attentionMinutes', 'Pengingat perlu perhatian (menit)', 'Kabari bila percakapan yang butuh admin belum ditangani selama ini. 0 = mati.', 0, 1440)}
      </fieldset>


      <fieldset class="space-y-4 border-t border-gray-100 pt-4"><legend class="font-semibold text-brand-800 mb-2">Retensi data</legend>
        ${num('retentionDays', 'Hapus percakapan lama setelah (hari)', '0 = dimatikan (data disimpan selamanya). Bila diisi, percakapan yang lebih lama akan dihapus PERMANEN secara berkala.', 0, 3650)}
      </fieldset>

    </div>
    <div data-panel="agen" class="card space-y-6" hidden>
      <div><h2 class="font-bold text-lg text-gray-900">Agen CRM</h2><p class="text-sm text-gray-600">Saat lead sudah Hot, bot tetap memegang percakapan dan meminta customer mengisi formulir data. Setelah lengkap, chat dialihkan ke admin untuk pelunasan DP. Berlaku untuk Baileys dan Convia.</p></div>
      <input type="hidden" name="crmAgentForm" value="1">
      ${chk('crmEnabled', A_CRM.enabled, 'Aktifkan agen CRM', 'Kolom formulir mengikuti data Acesio (Nama, Jenis kelamin, Tanggal lahir, Pekerjaan, Domisili, dan sumber referensi). Customer lama hanya diminta kolom yang masih kosong. No RM dan SOAP tidak pernah ditanyakan.', dis)}
      ${chk('crmAskBooking', A_CRM.askBooking, 'Tanyakan booking di formulir', 'Customer diminta mengisi layanan, tanggal, dan jam. Jam dicek ke jadwal Acesio; yang penuh ditolak dengan usulan jam lain. Admin masih bisa mengoreksi di detail lead.', dis)}
      ${chk('crmAutoSubmit', A_CRM.autoSubmit, 'Ajukan otomatis ke Acesio saat DP lunas', 'Saat admin mengubah tahap lead menjadi Won, data langsung diajukan ke Acesio. Bila gagal, percakapan ditandai perlu perhatian dan dicoba ulang otomatis. Tombol Ajukan manual tetap ada.', dis)}
      ${field('Pengantar formulir', `<textarea name="crmFormIntro" rows="2" class="${INP}" maxlength="1000" ${dis}>${esc(A_CRM.formIntro)}</textarea>`, 'Teks di atas daftar kolom yang dikirim ke customer')}
      ${field('Pesan setelah formulir lengkap', `<textarea name="crmDoneMessage" rows="2" class="${INP}" maxlength="1000" ${dis}>${esc(A_CRM.doneMessage)}</textarea>`, 'Dikirim saat chat dialihkan ke admin. {admin} = nama admin')}
      <fieldset class="space-y-4 border-t border-gray-100 pt-4"><legend class="font-semibold text-brand-800 mb-2">Follow up DP (maksimal 2 kali)</legend>
        <p class="text-xs text-gray-600">Dikirim bila formulir sudah lengkap tetapi tahap Hot Lead belum Won. Berhenti otomatis bila DP lunas (Won), Lost, atau customer membalas. Di Convia, pesan hanya dikirim dalam 24 jam sejak pesan terakhir customer; di luar itu chat ditandai perlu perhatian.</p>
        ${field('Follow up 1: berapa menit setelah formulir lengkap', `<input name="crmDelay1" type="number" min="5" max="10080" class="${INP}" value="${esc(A_CRM.followUpDelaysMinutes[0])}" ${dis}>`)}
        ${field('Isi follow up 1', `<textarea name="crmFollow1" rows="2" class="${INP}" maxlength="1000" ${dis}>${esc(A_CRM.followUpMessages[0])}</textarea>`, '{nama} = nama customer')}
        ${field('Follow up 2: berapa menit setelah formulir lengkap', `<input name="crmDelay2" type="number" min="5" max="10080" class="${INP}" value="${esc(A_CRM.followUpDelaysMinutes[1])}" ${dis}>`)}
        ${field('Isi follow up 2', `<textarea name="crmFollow2" rows="2" class="${INP}" maxlength="1000" ${dis}>${esc(A_CRM.followUpMessages[1])}</textarea>`)}
      </fieldset>
    </div>
    <div id="s-save" class="space-y-3 mt-6">
      <div id="s-err" class="form-error" role="alert" hidden></div>
      ${canEdit ? `<button class="${BTN_DARK}">Simpan pengaturan</button>` : ''}
    </div>
  </form>
  <div data-panel="ai" hidden>${aiSectionHTML(A, dis)}</div>
  ${canEdit ? `<div data-panel="integrasi" hidden>${acesioSectionHTML()}<div id="booking-box" class="mt-6"></div></div>` : ''}
  </div>`;
  lastQr = null;

  bindTabs();
  bindBrand();
  bindAi();
  bindAcesio();
  paintUsage();
  $('#s-form').onsubmit = async (e) => {
    e.preventDefault();
    if (!canEdit) return;
    const v = Object.fromEntries(new FormData(e.target));
    const cur = getSettings();
    const { patch, errors } = buildSettingsPatch(v, cur);
    const box = $('#s-err');
    box.hidden = !errors.length;
    box.innerHTML = errors.map((x) => esc(x.msg)).join('<br>');
    if (errors.length) { e.target.elements[errors[0].field]?.focus(); return; }
    if (patch.retentionDays > 0 && patch.retentionDays !== (cur.retentionDays || 0)
      && !(await confirmDialog('Aktifkan penghapusan otomatis?', `Percakapan yang lebih lama dari ${patch.retentionDays} hari akan dihapus permanen secara berkala dan tidak bisa dikembalikan. Lanjutkan?`, { okText: 'Aktifkan', danger: true }))) return;
    const btn = e.target.querySelector('button:not([type=button])');
    btn.disabled = true;
    try { await saveSettings(patch, { message: 'Pengaturan tersimpan' }); render(); } catch (err) {
      if (err.conflict) render(); else { box.hidden = false; box.textContent = err.message; }
    } finally { if (btn.isConnected) btn.disabled = false; }
  };
  $('#w-logout')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Putuskan WhatsApp?', 'Putuskan nomor WhatsApp ini dan tampilkan QR baru? Bot tidak akan membalas sampai nomor terhubung lagi.', { okText: 'Putuskan', danger: true }))) return;
    try { await send('/api/wa/logout'); pollWA(); } catch (err) { toast(err.message, true); }
  });
  pollWA();
}

/** Mode Convia hanya mungkin dari data/.env lama; UI tidak menawarkannya, tetapi tombol QR/logout tetap disembunyikan bila aktif. */
const isConvia = () => getSettings()?.waProvider === 'convia';

/* ====================================================================
   Balasan AI, Kuota AI, Pemakaian AI
   ==================================================================== */
const KIND_LABEL = {
  auth: 'Kunci API ditolak', rate_limit: 'Terlalu banyak permintaan', quota_provider: 'Kuota di penyedia habis', timeout: 'Waktu habis',
  unreachable: 'Penyedia tidak terjangkau', bad_request: 'Permintaan ditolak (cek model/alamat)', server: 'Galat di sisi penyedia', empty: 'Jawaban kosong', no_key: 'Belum ada kunci API',
};

const hasKey = () => (keyState != null ? keyState : !!(getSettings()?.ai?.hasKey ?? getSettings()?.hasAiKey)); // ASUMSI: server menaruh boolean di ai.hasKey

/** Kotak kunci API: tulis-saja. Nilai kunci tidak pernah dirender; hanya status "tersimpan". */
function keyBoxHTML() {
  const has = hasKey();
  const status = `<p class="text-sm font-medium">Kunci API: <span class="font-bold inline-flex items-center gap-1 ${has ? 'text-green-800' : 'text-amber-800'}">${icon(has ? 'ok' : 'info')} ${has ? 'tersimpan' : 'belum ada'}</span></p>`;
  if (!canEdit) return status;
  const input = `<div class="flex gap-2 flex-wrap items-center">
      <input id="ai-key" type="password" class="${INP} flex-1" style="min-width:8rem" autocomplete="off" spellcheck="false" maxlength="500" placeholder="Tempel kunci API" aria-label="Kunci API baru">
      <button type="button" id="ai-key-save" class="${BTN_DARK} shrink-0">Simpan kunci</button>
      ${has ? `<button type="button" id="ai-key-cancel" class="${BTN_LIGHT} shrink-0">Batal</button>` : ''}
    </div>`;
  if (!has || keyEdit) return `${status}${input}<p class="text-xs text-gray-600">Kunci disimpan terpisah dari pengaturan dan tidak akan ditampilkan lagi.</p>`;
  return `${status}<div class="flex gap-2 flex-wrap"><button type="button" id="ai-key-change" class="${BTN_LIGHT}">Ganti</button><button type="button" id="ai-key-del" class="${BTN_LIGHT}">Hapus</button></div>`;
}

function aiSectionHTML(A, dis) {
  const num = (name, label, hint, [min, max], val) => field(label, `<input name="${name}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" class="${INP}" value="${esc(val)}" ${dis}>`, hint);
  const compat = A.provider === 'openai-compatible';
  return `<form id="ai-form" class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start" style="margin-top:1.5rem" novalidate>
    <div class="space-y-6 min-w-0">
      <section class="card space-y-4" aria-labelledby="ai-h">
        <div><h2 id="ai-h" class="font-bold text-lg text-gray-900">Balasan AI</h2><p class="text-sm text-gray-600">Menjawab pertanyaan customer dari basis pengetahuan (diatur di halaman Pesan). Bila nonaktif, bot memakai respons default.</p></div>
        ${chk('aiEnabled', A.enabled, 'Aktifkan balasan AI', '', dis)}
        ${field('Penyedia AI', `<select name="aiProvider" id="ai-provider" class="${INP}" ${dis}>${AI_PROVIDERS.map(([k, l]) => `<option value="${k}" ${A.provider === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
        <div id="ai-base-wrap" ${compat ? '' : 'hidden'}>${field('Alamat dasar (base URL)', `<input name="aiBaseUrl" type="url" class="${INP}" value="${esc(A.baseUrl)}" maxlength="${AI_LIMITS.baseUrl}" placeholder="https://..." autocomplete="off" spellcheck="false" ${dis}>`, 'Wajib untuk OpenAI-compatible. Jangan menaruh kunci API di alamat.')}</div>
        ${field('Nama model', `<input name="aiModel" class="${INP}" value="${esc(A.model)}" maxlength="${AI_LIMITS.model}" autocomplete="off" spellcheck="false" ${dis}>`, 'Teks bebas. Tulis persis seperti di dokumentasi penyedia.')}
        <div id="ai-key-box" class="space-y-2 border border-gray-200 rounded-xl p-3 bg-gray-50">${keyBoxHTML()}</div>
        ${field('Persona', `<textarea name="aiPersona" rows="3" class="${INP}" maxlength="${AI_LIMITS.persona}" ${dis}>${esc(A.persona)}</textarea>`, 'Gaya dan peran bot, mis. ramah dan singkat.')}
        ${field('Aturan tambahan', `<textarea name="aiRules" rows="4" class="${INP}" maxlength="${AI_LIMITS.rules}" ${dis}>${esc(A.rules)}</textarea>`, 'Aturan keras sudah otomatis: jawab hanya dari basis pengetahuan, tidak mengarang harga/janji/diskon, dan tidak membuka instruksi.')}
        ${field('Pesan saat kuota habis', `<textarea name="aiQuotaMessage" rows="2" class="${INP}" maxlength="${AI_LIMITS.message}" ${dis}>${esc(A.quotaExhaustedMessage)}</textarea>`)}
        ${field('Pesan saat AI galat', `<textarea name="aiErrorMessage" rows="2" class="${INP}" maxlength="${AI_LIMITS.message}" ${dis}>${esc(A.errorMessage)}</textarea>`, 'Kosong = memakai respons default.')}
        <p class="text-xs text-gray-600">Isi pesan customer dan basis pengetahuan dikirim ke penyedia yang dipilih. Nomor telepon dan nama customer tidak dikirim.</p>
        ${canEdit ? `<div class="space-y-2">
          <div class="flex gap-2 flex-wrap items-center"><button type="button" id="ai-test" class="${BTN_LIGHT}">Uji koneksi</button><span id="ai-dirty" class="text-xs text-amber-800" hidden>Uji memakai pengaturan yang sudah disimpan. Simpan dulu bila baru mengubahnya.</span></div>
          <div id="ai-test-result" class="text-sm break-words" role="status" aria-live="polite" hidden></div>
        </div>` : ''}
      </section>

      <section class="card space-y-4" aria-labelledby="aiq-h">
        <div><h2 id="aiq-h" class="font-bold text-lg text-gray-900">Kuota AI</h2><p class="text-sm text-gray-600">1 balasan AI = 1 kuota; gagal tidak dihitung.</p></div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${num('aiMonthlyQuota', 'Batas bulanan', 'Balasan AI per bulan.', AI_LIMITS.monthly, A.monthlyQuota)}
          ${num('aiDailyLimit', 'Batas per customer per hari', 'Balasan AI per customer.', AI_LIMITS.daily, A.perCustomerDailyLimit)}
        </div>
        <div id="ai-err" class="form-error" role="alert" hidden></div>
        ${canEdit ? `<button class="${BTN_DARK}">Simpan pengaturan AI</button>` : '<p class="text-xs text-gray-600">Hanya Admin yang dapat mengubah pengaturan AI.</p>'}
      </section>
    </div>

    <section class="card space-y-4 min-w-0" aria-labelledby="aiu-h">
      <div class="flex items-start justify-between gap-3"><div><h2 id="aiu-h" class="font-bold text-lg text-gray-900">Pemakaian AI</h2><p class="text-sm text-gray-600">Bulan ini dan 30 hari terakhir</p></div>
        <button type="button" id="ai-usage-refresh" class="icon-btn shrink-0" aria-label="Muat ulang pemakaian" title="Muat ulang">${icon('refresh')}</button></div>
      <div id="ai-usage" class="space-y-4" aria-live="polite"></div>
    </section>
  </form>`;
}

function usageHTML() {
  const { data, error } = usageState;
  const note = error ? `<p class="text-sm text-red-800 break-words" role="alert">${esc(error)}</p>` : '';
  if (!data) return error ? note : '<p class="text-sm text-gray-600">Memuat pemakaian...</p>';
  const tz = getSettings()?.timezone || 'Asia/Jakarta';
  const u = usageView(data, tz);
  const fill = { ok: '', warn: 'background:#b45309', full: 'background:#b91c1c' }[u.level];
  const levelText = { ok: '', warn: 'Hampir habis', full: 'Kuota habis' }[u.level];
  const bars = u.bars.length
    ? `<div role="img" aria-label="Grafik batang pemakaian ${u.bars.length} hari terakhir. Total ${fmtNum(u.total30)} balasan${u.peak ? `, tertinggi ${fmtNum(u.peak.used)} pada ${esc(u.peak.label)}` : ''}." style="display:flex;align-items:flex-end;gap:2px;height:80px;border-bottom:1px solid #d1d5db">
        ${u.bars.map((b) => `<span title="${esc(b.label)}: ${fmtNum(b.used)} balasan" class="${b.used ? 'bg-brand-600' : 'bg-gray-200'}" style="flex:1 1 0;min-width:0;height:${b.used ? b.h : 2}%;border-radius:2px 2px 0 0"></span>`).join('')}
      </div>
      <div class="flex justify-between text-xs text-gray-600"><span>${esc(u.bars[0].label)}</span><span>${u.peak ? `Tertinggi ${fmtNum(u.peak.used)} (${esc(u.peak.label)})` : 'Belum ada pemakaian'}</span><span>${esc(u.bars[u.bars.length - 1].label)}</span></div>`
    : '<p class="text-sm text-gray-600">Belum ada data harian.</p>';
  return `${note}
    <div>
      <div class="flex justify-between gap-2 flex-wrap" style="align-items:baseline"><p class="text-sm text-gray-700"><span class="text-2xl font-bold text-gray-900">${fmtNum(u.used)}</span> dari ${fmtNum(u.limit)} terpakai</p><p class="text-sm font-medium text-gray-900">Sisa ${fmtNum(u.remaining)}</p></div>
      <div class="rounded-full bg-gray-200 overflow-hidden mt-2" style="display:flex;height:10px" role="progressbar" aria-label="Kuota bulan ini terpakai" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${u.pct}">
        <span class="${u.level === 'ok' ? 'bg-brand-600' : ''}" style="width:${u.pct}%;${fill}"></span>
        <span style="width:${u.reservedPct}%;background:#9ca3af"></span>
      </div>
      <p class="text-xs text-gray-600 mt-1">${u.pct}%${u.reserved ? ` &middot; ${fmtNum(u.reserved)} sedang diproses` : ''}${levelText ? ` &middot; <strong>${levelText}</strong>` : ''}${u.reset ? ` &middot; reset ${esc(u.reset)}` : ''}</p>
    </div>
    <p class="text-sm text-gray-700">Hari ini: <strong>${fmtNum(u.today)}</strong> balasan AI</p>
    <div class="space-y-1"><h3 class="text-sm font-semibold text-gray-900">30 hari terakhir</h3>${bars}</div>
    ${u.tokens.has ? `<p class="text-sm text-gray-700">Token bulan ini: masuk <strong>${fmtNum(u.tokens.input)}</strong> &middot; keluar <strong>${fmtNum(u.tokens.output)}</strong></p>` : ''}`;
}

function paintUsage() {
  const box = $('#ai-usage');
  if (box) box.innerHTML = usageHTML();
}

async function loadUsage() {
  try { usageState = { data: await api('/api/ai/usage'), error: '' }; } catch (err) {
    usageState = { data: usageState.data, error: 'Pemakaian AI belum bisa dimuat' + (err?.message ? ': ' + err.message : '.') };
  }
  paintUsage();
}

function paintKeyBox() {
  const box = $('#ai-key-box');
  if (box) box.innerHTML = keyBoxHTML();
}

function showTest(r) {
  const el = $('#ai-test-result');
  if (!el) return;
  el.hidden = !r;
  if (!r) return;
  const kind = !r.ok && r.kind ? KIND_LABEL[r.kind] || '' : '';
  el.className = 'text-sm break-words ' + (r.ok ? 'text-green-800' : 'text-red-800');
  el.innerHTML = `<span class="inline-flex items-center gap-1 font-medium">${icon(r.ok ? 'ok' : 'x-circle')} ${r.ok ? 'Koneksi berhasil' : esc(kind || 'Koneksi gagal')}</span>${r.message ? `<span class="block">${esc(r.message)}</span>` : ''}`;
}

/* ====================================================================
   Koneksi Acesio: alamat + kunci diisi di sini (bukan .env). Kunci tulis-saja, tidak pernah ditampilkan lagi.
   ==================================================================== */
function acesioSectionHTML() {
  return `<section class="card space-y-3" style="margin-top:1.5rem" aria-labelledby="acs-h">
    <div><h2 id="acs-h" class="font-bold text-lg text-gray-900">Koneksi Acesio</h2>
    <p class="text-sm text-gray-600">Dipakai tombol "Kirim Data ke Acesio" pada Hot Lead tahap Won. Buat kunci di Acesio (menu Integrasi, bagian "Kunci untuk server WhatsApp"), lalu tempel di sini.</p></div>
    <div id="acs-box" class="space-y-3"><p class="text-sm text-gray-600">Memuat…</p></div>
  </section>`;
}

function paintAcesio() {
  const box = $('#acs-box');
  if (!box) return;
  if (!acesio) { box.innerHTML = '<p class="text-sm text-gray-600">Memuat…</p>'; return; }
  const dis = canEdit ? '' : 'disabled';
  const src = acesio.keySource === 'dashboard' ? 'tersimpan' : acesio.keySource === 'env' ? 'dari berkas .env' : 'belum ada';
  const tone = acesio.hasKey ? 'text-green-800' : 'text-amber-800';
  box.innerHTML = `
    ${field('Alamat Acesio', `<input id="acs-url" class="${INP}" value="${esc(acesio.url)}" maxlength="200" placeholder="https://acesio.contoh.id" autocomplete="off" spellcheck="false" ${dis}>`, 'Bila Acesio satu server dengan WhatsApp, biarkan http://127.0.0.1:3000.')}
    ${field('Kunci Acesio', `<input id="acs-key" type="password" class="${INP}" maxlength="512" autocomplete="off" spellcheck="false" placeholder="${acesio.hasKey ? 'Biarkan kosong untuk tetap memakai kunci sekarang' : 'Tempel kunci dari Acesio'}" ${dis}>`, '')}
    <p class="text-sm font-medium">Kunci: <span class="font-bold ${tone}">${esc(src)}</span></p>
    <div id="acs-msg" class="text-sm" role="status" hidden></div>
    ${canEdit ? `<div class="flex gap-2 flex-wrap"><button type="button" id="acs-save" class="${BTN_DARK}">Simpan</button><button type="button" id="acs-test" class="${BTN_LIGHT}">Tes sambungan</button>${acesio.keySource === 'dashboard' ? `<button type="button" id="acs-del" class="${BTN_LIGHT}">Hapus kunci</button>` : ''}</div>` : ''}`;
}

function bindAcesio() {
  api('/api/acesio').then((r) => { acesio = r; paintAcesio(); }).catch(() => { acesio = { url: '', hasKey: false, keySource: 'none' }; paintAcesio(); });
  const box = $('#acs-box');
  if (!box || !canEdit) return;
  const say = (text, ok) => { const m = $('#acs-msg'); if (!m) return; m.textContent = text; m.className = `text-sm ${ok ? 'text-green-800' : 'text-red-800'}`; m.hidden = false; };
  box.onclick = async (e) => {
    const id = e.target.closest('button')?.id;
    if (!id) return;
    const btn = e.target.closest('button');
    try {
      if (id === 'acs-save') {
        const body = { url: $('#acs-url').value };
        const k = $('#acs-key').value.trim();
        if (k) body.key = k;
        btn.disabled = true;
        acesio = await send('/api/acesio', body, 'PUT');
        paintAcesio(); toast('Sambungan Acesio tersimpan');
      } else if (id === 'acs-test') {
        btn.disabled = true;
        const r = await send('/api/acesio/test', {}, 'POST');
        say(r.message, r.ok); btn.disabled = false;
      } else if (id === 'acs-del') {
        if (!(await confirmDialog('Hapus kunci Acesio?', 'Tombol "Kirim Data ke Acesio" berhenti bekerja sampai kunci diisi lagi.', { okText: 'Hapus', danger: true }))) return;
        acesio = await api('/api/acesio', { method: 'DELETE' });
        paintAcesio(); toast('Kunci Acesio dihapus');
      }
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  };
}

function bindAi() {
  $('#ai-usage-refresh').onclick = () => loadUsage();
  const form = $('#ai-form');
  const sel = $('#ai-provider');
  sel.onchange = () => { $('#ai-base-wrap').hidden = sel.value !== 'openai-compatible'; };
  if (!canEdit) return;
  form.addEventListener('input', (e) => { if (e.target.id !== 'ai-key') $('#ai-dirty').hidden = false; });

  // Kunci API: tombol bertipe button supaya tidak ikut tersimpan lewat form pengaturan; Enter di kolom kunci = simpan kunci.
  const box = $('#ai-key-box');
  const saveKey = async () => {
    const inp = $('#ai-key');
    const { key, error } = validateKeyInput(inp?.value);
    if (error) { toast(error, true); inp?.focus(); return; }
    const btn = $('#ai-key-save');
    btn.disabled = true;
    inp.value = ''; // buang dari DOM segera
    try {
      const res = await send('/api/ai/key', { key }, 'PUT');
      keyState = res?.hasKey !== false;
      keyEdit = false;
      toast('Kunci API tersimpan');
    } catch (err) { toast(err.message, true); }
    paintKeyBox();
  };
  box.onkeydown = (e) => { if (e.key === 'Enter' && e.target.id === 'ai-key') { e.preventDefault(); saveKey(); } };
  box.onclick = async (e) => {
    const id = e.target.closest('button')?.id;
    if (id === 'ai-key-save') await saveKey();
    else if (id === 'ai-key-change') { keyEdit = true; paintKeyBox(); $('#ai-key')?.focus(); }
    else if (id === 'ai-key-cancel') { keyEdit = false; paintKeyBox(); }
    else if (id === 'ai-key-del') {
      if (!(await confirmDialog('Hapus kunci API?', 'Balasan AI berhenti berjalan sampai kunci baru disimpan. Bot memakai respons default.', { okText: 'Hapus', danger: true }))) return;
      try {
        const res = await api('/api/ai/key', { method: 'DELETE' });
        keyState = res?.hasKey === true;
        keyEdit = false;
        toast('Kunci API dihapus');
      } catch (err) { toast(err.message, true); }
      paintKeyBox();
    }
  };

  $('#ai-test').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const out = $('#ai-test-result');
    out.hidden = false;
    out.className = 'text-sm text-gray-700';
    out.textContent = 'Menguji koneksi...';
    try { showTest(await send('/api/ai/test', {})); } catch (err) { showTest({ ok: false, message: err.message }); }
    btn.disabled = false;
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form)); // kolom kunci tidak bernama, jadi tidak ikut
    const { patch, errors } = buildAiPatch(v, getSettings());
    const err = $('#ai-err');
    err.hidden = !errors.length;
    err.innerHTML = errors.map((x) => esc(x.msg)).join('<br>');
    if (errors.length) { form.elements[errors[0].field]?.focus(); return; }
    const btn = form.querySelector('button:not([type=button])');
    btn.disabled = true;
    try {
      await saveSettings(patch, { message: 'Pengaturan AI tersimpan' });
      render();
      loadUsage(); // batas baru langsung terlihat
    } catch (ex) {
      if (ex.conflict) render(); else { err.hidden = false; err.textContent = ex.message; }
    } finally { if (btn.isConnected) btn.disabled = false; }
  };
}

async function pollWA() {
  let s;
  try { s = await api('/api/wa/status'); } catch { return; }
  if (!$('#w-label')) return;
  // 'misconfigured' (Convia tanpa key/secret) belum ada di waStatusView: tampilkan jelas, bukan "tidak tersedia".
  const b = s.status === 'misconfigured' ? { icon: 'x-circle', label: 'KONFIGURASI BELUM LENGKAP', tone: 'text-red-800' } : waStatusView(s.status);
  $('#w-label').innerHTML = `${icon(b.icon)} ${b.label}`;
  $('#w-label').className = 'font-bold inline-flex items-center gap-1 ' + b.tone;
  $('#w-number').hidden = !s.number;
  $('#w-number').textContent = s.number ? 'Nomor terhubung: +' + s.number : '';
  $('#w-error').hidden = !s.error;
  $('#w-error').textContent = s.error ? 'Error: ' + s.error : '';
  const showQr = s.status === 'qr' && s.qr;
  $('#w-qr').hidden = !showQr;
  $('#w-qr').classList.toggle('flex', !!showQr);
  if (showQr && s.qr !== lastQr) { $('#w-img').src = s.qr; lastQr = s.qr; }
  const lo = $('#w-logout');
  if (lo) lo.hidden = s.status !== 'connected' || isConvia(); // mode Convia tidak punya QR/logout
}
