// CRM: dashboard analytics (dari /api/leads/stats) + tabel lead (filter, sort, paginasi di server).
// Hanya memakai ekspor lib.js yang ada. Tanpa Font Awesome dan tanpa atribut inline handler (CSP).
import { $, api, send, esc, field, INP, BTN, BTN_DARK, BTN_LIGHT, modal, toast } from '../lib.js';

const PERIOD = { day: 'Hari Ini', week: '7 Hari Terakhir', month: 'Bulan Ini', year: 'Tahun Ini' };
const ST = { 'Cold Leads': 'bg-blue-50 text-blue-700', 'Warm Leads': 'bg-amber-50 text-amber-700', 'Hot Leads': 'bg-red-50 text-red-700' };
const DT = { New: 'bg-brand-50 text-brand-800', Existing: 'bg-gray-100 text-gray-600' };
const TIP = {
  total: 'Total = lead yang DIBUAT pada periode ini.',
  cold: 'Cold = lead yang masuk status Cold pada periode ini.',
  warm: 'Warm = lead yang masuk status Warm pada periode ini.',
  hot: 'Hot = lead yang menjadi Hot pada periode ini (termasuk lead yang dibuat pada periode sebelumnya).',
  rate: 'Rate Konversi = lead yang dibuat pada periode ini dan SEKARANG berstatus Hot, dibagi total lead yang dibuat pada periode ini.',
};
const SORT_OPTS = [
  ['lastContactAt', 'desc', 'Kontak terakhir (terbaru)'], ['lastContactAt', 'asc', 'Kontak terakhir (terlama)'],
  ['createdAt', 'desc', 'Tanggal masuk (terbaru)'], ['createdAt', 'asc', 'Tanggal masuk (terlama)'],
  ['name', 'asc', 'Nama (A-Z)'], ['name', 'desc', 'Nama (Z-A)'],
  ['status', 'desc', 'Status (Hot dulu)'], ['status', 'asc', 'Status (Cold dulu)'],
  ['platform', 'asc', 'Sumber (A-Z)'], ['platform', 'desc', 'Sumber (Z-A)'],
];
const PAGE_SIZE = 25;
const DEFAULT_F = { q: '', status: '', platform: '', dataType: '', awaiting: false, overdue: false, blocked: false, sort: 'lastContactAt', dir: 'desc', page: 1 };

// Format nomor untuk TAMPILAN saja (salinan sederhana dari kontrak formatPhone; data kanonik tetap angka).
export function formatPhone(phone, mode = 'digits') {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (!d || mode !== 'international') return d;
  if (d.startsWith('62')) {
    const rest = d.slice(2);
    return '+62 ' + [rest.slice(0, 3), rest.slice(3, 7), rest.slice(7)].filter(Boolean).join('-');
  }
  return '+' + d;
}

// Kelengkapan data untuk Acesio: pakai acesioReadiness dari server; cadangan lokal bila belum ada.
const MISSING_LABEL = { phone: 'Nomor WhatsApp', referensi: 'Referensi', name: 'Nama' };
export function readinessOf(l) {
  if (l.acesioReadiness && Array.isArray(l.acesioReadiness.missing)) return l.acesioReadiness;
  const missing = [];
  if (!/\d/.test(String(l.phone || ''))) missing.push('phone');
  if (!String(l.referensi || '').trim()) missing.push('referensi');
  const nm = String(l.name || '').trim();
  if (nm.length < 2 || nm === 'Tanpa Nama') missing.push('name');
  const eligible = l.status === 'Hot Leads' && l.hotStage === 'Won';
  return { eligible, ready: eligible && !missing.length, missing };
}

let alive = false, phoneFmt = 'digits', meta = { statuses: [], dataTypes: [], hotStages: [], platforms: [] }, tz = 'Asia/Jakarta', period = 'day', me = { name: '', role: '' }, labels = {};
let data = { leads: [], total: 0, page: 1, pageSize: PAGE_SIZE };
let acsQ = null, acsBusy = false, acsSeq = 0;
let listTimer = null, statsTimer = null, searchTimer = null, listSeq = 0, statsSeq = 0, lastKey = '', lastStatsKey = '';
const f = { ...DEFAULT_F };
const observers = new Set();

// ---------- format tanggal (pakai timezone dari server) ----------
function fmtDT(ts) {
  if (!ts) return '-';
  try { return new Intl.DateTimeFormat('id-ID', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts)); } catch { return new Date(ts).toLocaleString('id-ID'); }
}
function fmtDay(s) {
  if (!s) return '-';
  const [y, m, d] = String(s).split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(Date.UTC(y, m - 1, d)));
}

const card = (label, id, color, sub, tip) => `<div class="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
  <p class="text-sm font-medium text-gray-500">${label}<span class="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-gray-100 text-[10px] text-gray-500 cursor-help" tabindex="0" role="img" aria-label="Definisi: ${esc(tip)}" title="${esc(tip)}">?</span></p>
  <p id="${id}" class="text-3xl font-bold mt-2 ${color}">0</p><p ${id === 'k-total' ? 'id="k-delta"' : ''} class="text-xs text-gray-400 mt-1">${sub}</p></div>`;
const chartBox = (title, id, empty) => `<div class="bg-white p-6 rounded-xl border border-gray-200 shadow-sm min-h-64 flex flex-col">
  <h3 class="text-sm font-bold text-gray-700" ${id === 'c-funnel' ? 'id="funnel-title"' : ''}>${title}</h3>
  <div id="${id}" class="flex-1 flex items-center justify-center text-sm text-gray-400 mt-4">${empty}</div></div>`;
const check = (id, text) => `<label class="flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" id="${id}"> ${text}</label>`;

export async function mount(el) {
  alive = true;
  Object.assign(f, DEFAULT_F);
  acsQ = null; acsBusy = false; acsSeq++;
  period = 'day'; lastKey = ''; lastStatsKey = ''; tz = 'Asia/Jakarta'; phoneFmt = 'digits';
  meta = { statuses: [], dataTypes: [], hotStages: [], platforms: [] };
  data = { leads: [], total: 0, page: 1, pageSize: PAGE_SIZE };
  try {
    const st = await api('/api/settings');
    labels = Object.fromEntries((st.requiredFields || []).map((x) => [x.id, x.label || (x.id === 'referensi' ? 'Referensi' : x.id)]));
    phoneFmt = st.phoneFormat === 'international' ? 'international' : 'digits';
  } catch { /* abaikan: format nomor kembali ke angka */ }
  try {
    const m = await api('/api/me');
    me = { role: m.role || m.user?.role || '', name: m.name || m.user?.name || (typeof m.user === 'string' ? m.user : '') };
  } catch { /* peran tidak diketahui: tombol admin disembunyikan */ }
  if (!alive) return;

  el.innerHTML = `<div class="space-y-8">
  <section class="space-y-6" aria-label="Statistik lead">
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-gray-200 pb-4">
      <div><h2 class="text-2xl font-bold tracking-tight">Dashboard Laporan Analytics</h2><p class="text-sm text-gray-500">Ringkasan lead otomatis dari percakapan WhatsApp</p><p id="range" class="text-xs text-gray-400 mt-1"></p></div>
      <div id="period" class="seg" role="group" aria-label="Periode statistik">
        ${Object.entries({ day: 'Hari ini', week: '7 hari', month: 'Bulan ini', year: 'Tahun ini' })
          .map(([k, v]) => `<button type="button" data-p="${k}" aria-pressed="${k === 'day'}" class="seg-btn">${v}</button>`).join('')}
      </div>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
      ${card('Total Leads', 'k-total', 'text-brand-800', '0% vs periode lalu', TIP.total)}
      ${card('Cold Leads', 'k-cold', 'text-sky-600', 'Masuk status Cold', TIP.cold)}
      ${card('Warm Leads', 'k-warm', 'text-amber-500', 'Masuk status Warm', TIP.warm)}
      ${card('Hot Leads', 'k-hot', 'text-red-600', 'Menjadi Hot pada periode', TIP.hot)}
      ${card('Rate Konversi', 'k-rate', 'text-brand-700', 'Lead periode ini yang kini Hot', TIP.rate)}
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      ${chartBox('Funnel Konversi Status Lead', 'c-funnel', 'Progres lead dari pesan pertama hingga closing (Menunggu data...)')}
      ${chartBox('Sumber Leads', 'c-source', 'Berdasarkan pencocokan kata kunci (Menunggu data...)')}
    </div>
  </section>

  <section id="acs-queue" class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" aria-labelledby="acs-q-h">
    <div class="acs-head">
      <div><h3 id="acs-q-h" class="font-bold text-lg text-gray-900">Pengajuan ke Acesio</h3><p class="text-sm text-gray-500">Hot Leads tahap Won yang belum diajukan. Ajukan satu per satu atau semua yang datanya lengkap sekaligus.</p></div>
      <button type="button" id="acs-all" class="${BTN} bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40" disabled>Ajukan semua</button>
    </div>
    <div id="acs-body" aria-live="polite"><p class="acs-empty">Memuat…</p></div>
  </section>

  <section class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" aria-label="Daftar lead">
    <div class="p-6 border-b border-gray-200 space-y-4">
      <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div><h3 class="font-bold text-lg text-gray-900">Lead Terbaru Masuk</h3><p class="text-sm text-gray-500">Otomatis terdeteksi dari WhatsApp listener</p></div>
        <button type="button" id="btn-export" class="${BTN} bg-brand-800 text-white hover:bg-brand-900 self-start lg:self-auto"><svg aria-hidden="true" viewBox="0 0 20 20" class="inline w-4 h-4 mr-1 -mt-0.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v10m0 0l-4-4m4 4l4-4M4 17h12"/></svg>Export CSV</button>
      </div>
      <div id="filters" class="flex flex-wrap items-center gap-2">
        <input id="f-q" type="search" class="${INP} !w-56" placeholder="Cari nama, nomor, keyword" aria-label="Cari nama, nomor, atau keyword" autocomplete="off">
        <select id="f-source" class="${INP} !w-auto" aria-label="Filter sumber"><option value="">Semua Sumber Leads</option></select>
        <select id="f-status" class="${INP} !w-auto" aria-label="Filter status"><option value="">Semua Status Leads</option></select>
        <select id="f-data" class="${INP} !w-auto" aria-label="Filter data leads"><option value="">Semua Data</option></select>
        <select id="f-sort" class="${INP} !w-auto" aria-label="Urutkan">${SORT_OPTS.map(([s, d, t]) => `<option value="${s}:${d}">${t}</option>`).join('')}</select>
        ${check('f-awaiting', 'Perlu dibalas')}${check('f-overdue', 'Follow-up lewat')}${check('f-blocked', 'Tampilkan terblokir')}
      </div>
    </div>
    <div id="list-area" aria-live="polite"></div>
  </section>
  </div>`;

  bindAcsQueue();
  $('#period').onclick = (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    period = b.dataset.p;
    document.querySelectorAll('#period [data-p]').forEach((x) => {
      const on = x === b;
      x.setAttribute('aria-pressed', on);
    });
    lastStatsKey = '';
    loadStats();
  };

  const refilter = () => { f.page = 1; lastKey = ''; loadList(); };
  const fl = $('#filters');
  fl.addEventListener('input', (e) => {
    if (e.target.id !== 'f-q') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { f.q = e.target.value.trim(); refilter(); }, 300);
  });
  fl.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'f-source') f.platform = t.value;
    else if (t.id === 'f-status') f.status = t.value;
    else if (t.id === 'f-data') f.dataType = t.value;
    else if (t.id === 'f-sort') [f.sort, f.dir] = t.value.split(':');
    else if (t.id === 'f-awaiting') f.awaiting = t.checked;
    else if (t.id === 'f-overdue') f.overdue = t.checked;
    else if (t.id === 'f-blocked') f.blocked = t.checked;
    else return;
    refilter();
  });
  $('#btn-export').onclick = () => {
    const a = document.createElement('a');
    a.href = '/api/leads/export.csv?' + qs(false);
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('#list-area').onclick = onListClick;

  await Promise.all([loadList(), loadStats(), loadAcsQueue()]);
  if (!alive) return;
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('copy', onCopy);
  if (!document.hidden) startTimers();
}

export function unmount() {
  alive = false;
  stopTimers();
  clearTimeout(searchTimer);
  document.removeEventListener('visibilitychange', onVisibility);
  document.removeEventListener('copy', onCopy);
  observers.forEach((o) => o.disconnect());
  observers.clear();
}

// Salin-tempel nomor tetap angka kanonik walau tampilan berformat.
function onCopy(e) {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.anchorNode) return;
  const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  const span = node?.closest?.('[data-phone]');
  if (!span || !span.contains(sel.focusNode) || sel.toString().trim() !== span.textContent.trim()) return;
  e.clipboardData.setData('text/plain', span.dataset.phone);
  e.preventDefault();
}

// ---------- polling ----------
function startTimers() {
  if (!listTimer) listTimer = setInterval(() => loadList(), 5000);
  if (!statsTimer) statsTimer = setInterval(() => { loadStats(); loadAcsQueue(); }, 15000);
}
function stopTimers() {
  clearInterval(listTimer); clearInterval(statsTimer);
  listTimer = statsTimer = null;
}
function onVisibility() {
  if (!alive) return;
  if (document.hidden) { stopTimers(); return; }
  startTimers(); loadList(); loadStats(); loadAcsQueue();
}

function qs(withPage = true) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.status) p.set('status', f.status);
  if (f.platform) p.set('platform', f.platform);
  if (f.dataType) p.set('dataType', f.dataType);
  if (f.awaiting) p.set('awaiting', '1');
  if (f.overdue) p.set('overdue', '1');
  if (f.blocked) p.set('blocked', '1');
  p.set('sort', f.sort); p.set('dir', f.dir);
  if (withPage) { p.set('page', f.page); p.set('pageSize', PAGE_SIZE); }
  return p.toString();
}

async function loadList() {
  if (!alive) return;
  const seq = ++listSeq;
  try {
    const d = await api('/api/leads?' + qs());
    if (!alive || seq !== listSeq) return;
    tz = d.tz || tz;
    f.page = d.page;
    meta = { statuses: d.statuses, dataTypes: d.dataTypes, hotStages: d.hotStages || [], platforms: d.platforms };
    fillSelect('#f-source', d.platforms, f.platform);
    fillSelect('#f-status', d.statuses, f.status);
    fillSelect('#f-data', d.dataTypes, f.dataType);
    const sortSel = $('#f-sort');
    if (sortSel) sortSel.value = `${f.sort}:${f.dir}`;
    const key = JSON.stringify(d);
    if (key === lastKey) return; // tidak ada perubahan: jangan render ulang
    lastKey = key;
    data = d;
    renderList();
  } catch (e) { console.error(e); }
}

async function loadStats() {
  if (!alive) return;
  const seq = ++statsSeq;
  try {
    const s = await api('/api/leads/stats?period=' + period);
    if (!alive || seq !== statsSeq) return;
    tz = s.tz || tz;
    const key = JSON.stringify(s);
    if (key === lastStatsKey) return;
    lastStatsKey = key;
    renderStats(s);
  } catch (e) { console.error(e); }
}

function fillSelect(id, arr, cur) {
  const sel = $(id);
  if (!sel) return;
  const k = (arr || []).join('|');
  if (sel.dataset.k === k) return;
  sel.dataset.k = k;
  const first = sel.options[0].outerHTML;
  sel.innerHTML = first + (arr || []).map((x) => `<option>${esc(x)}</option>`).join('');
  sel.value = cur || '';
}

// ---------- statistik ----------
function bars(rows) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="w-full space-y-3">${rows.map((r) => `<div>
    <div class="flex justify-between text-xs text-gray-600 mb-1"><span>${esc(r.label)}</span><span class="font-medium">${r.value}</span></div>
    <div class="h-2.5 bg-gray-100 rounded-full overflow-hidden"><div class="h-full ${r.color} rounded-full" style="width:${(r.value / max) * 100}%"></div></div></div>`).join('')}</div>`;
}

function renderStats(s) {
  if (!$('#k-total')) return;
  $('#k-total').textContent = s.total; $('#k-cold').textContent = s.cold; $('#k-warm').textContent = s.warm; $('#k-hot').textContent = s.hot;
  $('#k-rate').textContent = Number(s.cohortHotRate || 0).toFixed(1) + '%';
  // perbandingan disembunyikan bila periode lalu kosong (perilaku lama)
  $('#k-delta').textContent = !s.prevTotal ? (s.total === 0 ? '0% vs periode lalu' : 'Belum ada data periode lalu')
    : `${s.deltaPct >= 0 ? '+' : ''}${s.deltaPct}% vs periode lalu`;
  $('#funnel-title').textContent = `Funnel Konversi Status Lead (${PERIOD[s.period] || ''})`;
  $('#range').textContent = `Periode: ${fmtDay(s.fromDate)}${s.toDate !== s.fromDate ? ' - ' + fmtDay(s.toDate) : ''} (${s.tz})`;

  const empty = (id, t) => { $(id).className = 'flex-1 flex items-center justify-center text-sm text-gray-400 mt-4'; $(id).textContent = t; };
  if (!s.total) {
    empty('#c-funnel', 'Progres lead dari pesan pertama hingga closing (Menunggu data...)');
    empty('#c-source', 'Berdasarkan pencocokan kata kunci (Menunggu data...)');
    return;
  }
  const colors = ['bg-brand-300', 'bg-brand-500', 'bg-brand-800'];
  $('#c-funnel').className = 'flex-1 flex items-center mt-4';
  $('#c-funnel').innerHTML = bars(s.funnel.map((r, i) => ({ ...r, color: colors[i] || 'bg-brand-600' })));
  $('#c-source').className = 'flex-1 flex items-center mt-4';
  $('#c-source').innerHTML = bars(s.bySource.map((r) => ({ ...r, color: 'bg-brand-600' })));
}

// ---------- tabel + kartu ----------
const SORTABLE = [['name', 'Nama / No WA'], ['platform', 'Sumber'], ['status', 'Status Lead'], [null, 'Data Leads'], ['lastContactAt', 'Kontak Terakhir'], [null, 'Follow-up'], [null, 'Aksi']];

function head() {
  return SORTABLE.map(([key, text]) => {
    if (!key) return `<th scope="col" class="p-4">${text}</th>`;
    const on = f.sort === key;
    const arrow = on ? (f.dir === 'asc' ? '&#9650;' : '&#9660;') : '';
    return `<th scope="col" class="p-4" aria-sort="${on ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${key}" class="font-medium hover:text-gray-900">${text} <span aria-hidden="true" class="text-[10px]">${arrow}</span></button></th>`;
  }).join('');
}

const label = (l) => l.name || l.phone || 'tanpa nama';
const fmtPhone = (p) => formatPhone(p, phoneFmt);
const phoneSpan = (p) => `<span data-phone="${esc(p)}">${esc(fmtPhone(p))}</span>`;
const hotCand = (l) => l.hotCandidate && l.status !== 'Hot Leads';
const pill = (text, cls, title = '') => `<span ${title ? `title="${esc(title)}"` : ''} class="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${cls}">${esc(text)}</span>`;

function nameCell(l) {
  const badges = [
    l.awaitingReply && pill('Perlu dibalas', 'bg-amber-100 text-amber-800'),
    l.followUpOverdue && pill('Tindak lanjut lewat', 'bg-red-100 text-red-700'),
    hotCand(l) && pill('Kandidat Hot', 'bg-orange-100 text-orange-800', l.hotCandidate.reason),
    l.blocked && pill('Terblokir', 'bg-gray-200 text-gray-700'),
    !l.phone && pill('Nomor belum terbaca', 'bg-gray-200 text-gray-700', 'Lead hanya punya LID/BSUID: nomor WhatsApp belum diketahui'),
  ].filter(Boolean).join(' ');
  return `<div class="font-medium text-gray-900">${esc(l.name || 'Tanpa nama')}</div><div class="text-xs text-gray-500">${l.phone ? phoneSpan(l.phone) : esc(l.lid ? 'LID ' + l.lid : '-')}</div>
    ${badges ? `<div class="flex flex-wrap gap-1 mt-1">${badges}</div>` : ''}
    ${hotCand(l) ? `<button type="button" data-act="confirm-hot" data-id="${esc(l.id)}" aria-label="Konfirmasi ${esc(label(l))} sebagai Hot" class="mt-1 text-xs font-medium text-red-700 underline hover:text-red-900">Konfirmasi Hot</button>` : ''}`;
}

const STAGE_CLS = {
  'Follow Up': 'bg-amber-100 text-amber-800',
  'Negosiasi / Kirim Rekening': 'bg-purple-100 text-purple-800',
  'Won': 'bg-emerald-100 text-emerald-800 font-bold',
  'Lost': 'bg-gray-200 text-gray-700',
};

function statusCell(l) {
  const tip = [l.statusReason, l.warmScore > 0 ? `Skor warm: ${l.warmScore}` : '', ...(l.warmReasons || [])].filter(Boolean).join(' | ');
  let extra = '';
  if (l.status === 'Hot Leads') {
    const stg = l.hotStage || 'Follow Up';
    extra += `<div class="mt-1">${pill(stg, STAGE_CLS[stg] || 'bg-red-100 text-red-800')}</div>`;
    if (l.acesioStatus === 'sent') {
      extra += `<div class="mt-0.5"><span class="inline-flex items-center text-[10px] text-emerald-700 font-medium">${l.acesioReplayed ? 'Sudah ada di Acesio' : '✓ Diajukan ke Acesio'}</span></div>`;
    } else if (l.acesioStatus === 'failed') {
      extra += `<div class="mt-0.5"><span class="inline-flex items-center text-[10px] text-red-700 font-medium">Gagal diajukan ke Acesio</span></div>`;
    }
  }
  return `<span ${tip ? `title="${esc(tip)}"` : ''} class="px-2.5 py-1 rounded-full text-xs font-medium ${ST[l.status] || ''}">${esc(l.status)}</span>${extra}${l.statusManual ? '<div class="text-[10px] text-gray-400 mt-1">manual</div>' : ''}`;
}

const dataCell = (l) => `<span title="${esc(l.dataReason || '')}" class="px-2.5 py-1 rounded-full text-xs font-medium ${DT[l.dataType] || ''}">${esc(l.dataType)}</span>${l.dataTypeManual ? '<div class="text-[10px] text-gray-400 mt-1">manual</div>' : ''}`;
const contactCell = (l) => `${esc(fmtDT(l.lastContactAt))}<div class="text-[11px] text-gray-400">Masuk ${esc(fmtDT(l.createdAt))}</div>`;
const followCell = (l) => (l.followUpDate
  ? `<span class="${l.followUpOverdue ? 'text-red-700 font-medium' : ''}">${esc(fmtDay(l.followUpDate))}${l.followUpOverdue ? ' (terlewat)' : ''}</span>${l.followUpNote ? `<div class="text-[11px] text-gray-500">${esc(l.followUpNote)}</div>` : ''}`
  : '<span class="text-gray-400">-</span>');
const actionCell = (l) => `<div class="flex flex-wrap gap-2 items-center">
  ${l.phone ? `<a href="#/percakapan?phone=${encodeURIComponent(l.phone)}" aria-label="Buka percakapan dengan ${esc(label(l))}" class="text-xs font-medium text-brand-700 underline hover:text-brand-900">Buka percakapan</a>` : ''}
  <button type="button" data-act="edit" data-id="${esc(l.id)}" aria-label="Edit lead ${esc(label(l))}" class="text-xs font-medium px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Edit</button></div>`;

const filtersActive = () => !!(f.q || f.status || f.platform || f.dataType || f.awaiting || f.overdue);

function renderList() {
  const area = $('#list-area');
  if (!area) return;
  const act = document.activeElement;
  const keep = act && area.contains(act) ? { sel: act.dataset.act ? `[data-act="${act.dataset.act}"][data-id="${CSS.escape(act.dataset.id || '')}"]` : act.dataset.sort ? `[data-sort="${act.dataset.sort}"]` : act.dataset.page ? `[data-page="${act.dataset.page}"]` : '' } : null;

  const { leads, total, page, pageSize } = data;
  const emptyMsg = filtersActive() ? 'Tidak ada lead yang cocok dengan filter.' : 'Belum ada data lead masuk. Aktifkan listener WA untuk memindai pesan secara otomatis.';
  const rows = leads.map((l) => `<tr class="hover:bg-gray-50 align-top">
      <td class="p-4">${nameCell(l)}</td><td class="p-4">${esc(l.platform)}</td><td class="p-4">${statusCell(l)}</td><td class="p-4">${dataCell(l)}</td>
      <td class="p-4 text-gray-600 whitespace-nowrap">${contactCell(l)}</td><td class="p-4 text-gray-600">${followCell(l)}</td><td class="p-4">${actionCell(l)}</td></tr>`).join('');
  const cards = leads.map((l) => `<li class="p-4 space-y-2">
      <div class="flex justify-between gap-3"><div>${nameCell(l)}</div><div class="text-right shrink-0">${statusCell(l)}</div></div>
      <div class="text-xs text-gray-600 flex flex-wrap gap-x-4 gap-y-1"><span>Sumber: ${esc(l.platform)}</span><span>Data: ${dataCell(l)}</span></div>
      <div class="text-xs text-gray-600">Kontak terakhir: ${contactCell(l)}</div>
      <div class="text-xs text-gray-600">Follow-up: ${followCell(l)}</div>${actionCell(l)}</li>`).join('');
  const from = total ? (page - 1) * pageSize + 1 : 0, to = Math.min(page * pageSize, total);

  area.innerHTML = `<div class="hidden md:block overflow-x-auto"><table class="w-full text-left border-collapse text-sm">
      <caption class="sr-only">Daftar lead</caption>
      <thead><tr class="bg-gray-50 border-b border-gray-200 text-gray-500 font-medium">${head()}</tr></thead>
      <tbody class="divide-y divide-gray-200">${rows || `<tr><td colspan="7" class="p-10 text-center text-gray-400 italic">${emptyMsg}</td></tr>`}</tbody></table></div>
    <ul class="md:hidden divide-y divide-gray-200">${cards || `<li class="p-8 text-center text-gray-400 italic text-sm">${emptyMsg}</li>`}</ul>
    <div class="p-4 border-t border-gray-200 flex items-center justify-between gap-3 text-sm text-gray-600">
      <span>${total ? `${from}-${to} dari ${total}` : '0 dari 0'}</span>
      <div class="flex gap-2">
        <button type="button" data-page="prev" class="${BTN_LIGHT} disabled:opacity-40" ${page <= 1 ? 'disabled' : ''}>Sebelumnya</button>
        <button type="button" data-page="next" class="${BTN_LIGHT} disabled:opacity-40" ${page * pageSize >= total ? 'disabled' : ''}>Berikutnya</button>
      </div></div>`;
  if (keep?.sel) area.querySelector(keep.sel)?.focus();
}

async function onListClick(e) {
  const sortBtn = e.target.closest('[data-sort]');
  if (sortBtn) {
    const k = sortBtn.dataset.sort;
    f.dir = f.sort === k ? (f.dir === 'asc' ? 'desc' : 'asc') : (k === 'name' || k === 'platform' ? 'asc' : 'desc');
    f.sort = k; f.page = 1; lastKey = ''; loadList();
    return;
  }
  const pg = e.target.closest('[data-page]');
  if (pg && !pg.disabled) {
    f.page = Math.max(1, f.page + (pg.dataset.page === 'next' ? 1 : -1));
    lastKey = ''; loadList();
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'edit') openEdit(b.dataset.id, b);
  else if (b.dataset.act === 'confirm-hot') {
    try {
      await send('/api/leads/' + encodeURIComponent(b.dataset.id), { confirmHot: true }, 'PATCH');
      toast('Lead dikonfirmasi sebagai Hot');
      refreshAll();
    } catch (err) { toast(err.message, true); }
  }
}

// ---------- kotak pengajuan ke Acesio ----------
async function loadAcsQueue() {
  if (!alive || acsBusy) return;
  const seq = ++acsSeq;
  try {
    const q = await api('/api/leads/acesio/queue');
    if (!alive || seq !== acsSeq) return;
    acsQ = q;
  } catch (e) {
    if (!alive || seq !== acsSeq) return;
    acsQ = { error: e.message, items: [], counts: { ready: 0, incomplete: 0, failed: 0, total: 0 }, configured: true };
  }
  paintAcsQueue();
}

function paintAcsQueue() {
  const body = $('#acs-body'), allBtn = $('#acs-all');
  if (!body || !allBtn || !acsQ) return;
  const { items, counts, configured, error } = acsQ;
  allBtn.disabled = acsBusy || !configured || counts.ready === 0;
  allBtn.textContent = counts.ready ? `Ajukan semua (${counts.ready})` : 'Ajukan semua';
  const note = error ? `<p class="acs-note text-red-700" role="alert">${esc(error)}</p>`
    : !configured ? '<p class="acs-note text-amber-800" role="status">Sambungan Acesio belum diisi. Isi alamat dan kunci di <a class="underline font-medium" href="#/pengaturan">Pengaturan, tab Integrasi</a>.</p>'
      : counts.incomplete ? `<p class="acs-note text-gray-600">${counts.incomplete} lead belum bisa diajukan karena datanya kurang. "Ajukan semua" hanya mengirim yang lengkap.</p>` : '';
  if (!items.length) { body.innerHTML = `${note}<p class="acs-empty">Tidak ada lead yang menunggu pengajuan.</p>`; return; }
  body.innerHTML = `${note}<ul class="acs-list">${items.map((i) => {
    const badge = i.ready
      ? (i.acesioStatus === 'failed' ? `<span class="text-xs font-medium text-red-700">Gagal diajukan${i.acesioLastError ? ': ' + esc(i.acesioLastError) : ''}</span>` : '<span class="text-xs font-medium text-emerald-700">Siap diajukan</span>')
      : `<span class="text-xs font-medium text-amber-700">Data kurang: ${esc(i.missing.join(', '))}</span>`;
    return `<li class="acs-row">
      <div class="acs-who"><p class="acs-name">${esc(i.name || 'Tanpa nama')}</p>
      <p class="acs-meta">${esc(fmtPhone(i.phone))}${i.referensi ? ' &middot; ' + esc(i.referensi) : ''}</p>${badge}</div>
      <div class="acs-act">
        <button type="button" data-acs-open="${esc(i.id)}" class="${BTN} bg-white border border-gray-300 text-gray-700 hover:bg-gray-50">${i.ready ? 'Lihat' : 'Lengkapi'}</button>
        <button type="button" data-acs-one="${esc(i.id)}" class="${BTN} bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40" ${i.ready && configured && !acsBusy ? '' : 'disabled'}>${i.acesioStatus === 'failed' ? 'Coba lagi' : 'Ajukan'}</button>
      </div></li>`;
  }).join('')}</ul>`;
}

async function acsSubmit(url, okMsg) {
  if (acsBusy) return;
  acsBusy = true; paintAcsQueue();
  try {
    const res = await send(url, {});
    if (res.queue) acsQ = res.queue;
    toast(okMsg(res), res.failed > 0);
  } catch (e) { toast(e.message, true); }
  acsBusy = false;
  refreshAll();
}

function bindAcsQueue() {
  $('#acs-all').onclick = () => {
    if (!acsQ?.counts.ready) return;
    if (!confirm(`Ajukan ${acsQ.counts.ready} lead ke Acesio sekarang?`)) return;
    acsSubmit('/api/leads/acesio/submit-all', (r) => (r.failed
      ? `${r.sent + r.replayed} berhasil, ${r.failed} gagal. Yang gagal tetap ada di daftar.`
      : `${r.sent + r.replayed} lead diajukan ke Acesio${r.replayed ? ` (${r.replayed} sudah ada di Acesio)` : ''}.`));
  };
  $('#acs-body').onclick = (e) => {
    const one = e.target.closest('[data-acs-one]');
    if (one) {
      const it = acsQ?.items.find((x) => x.id === one.dataset.acsOne);
      acsSubmit(`/api/leads/${encodeURIComponent(one.dataset.acsOne)}/send-to-acesio`, (r) => (r.lead?.acesioReplayed || r.replayed ? `${it?.name || 'Lead'}: sudah ada di Acesio (tidak diperbarui)` : `${it?.name || 'Lead'} diajukan ke Acesio.`));
      return;
    }
    const op = e.target.closest('[data-acs-open]');
    if (op) openEdit(op.dataset.acsOpen, op);
  };
}

function refreshAll() { lastKey = ''; lastStatsKey = ''; loadList(); loadStats(); loadAcsQueue(); }

// ---------- modal edit ----------
const sel = (name, opts, cur) => `<select name="${name}" class="${INP}">${opts.map((o) => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;

// Panel Acesio di detail lead: daftar periksa 3 butir, status, dan tombol ajukan.
function acesioPanel(l) {
  const rd = readinessOf(l);
  const miss = new Set(rd.missing);
  const items = ['phone', 'referensi', 'name'].map((k) => {
    const ok = !miss.has(k);
    return `<li class="flex items-center gap-2"><span aria-hidden="true" class="${ok ? 'text-emerald-700' : 'text-red-700'} font-bold">${ok ? '✓' : '✗'}</span><span>${MISSING_LABEL[k]}: <b>${ok ? 'lengkap' : 'kurang'}</b></span></li>`;
  }).join('');
  let status = 'Belum diajukan ke Acesio.';
  if (l.acesioStatus === 'sent') {
    status = l.acesioReplayed
      ? 'Sudah ada di Acesio (tidak diperbarui).'
      : `Diajukan${l.acesioSentAt ? ' pada ' + fmtDT(l.acesioSentAt) : ''} (menunggu persetujuan admin Acesio).`;
  } else if (l.acesioStatus === 'failed') {
    status = `Gagal diajukan${l.acesioLastError ? ': ' + l.acesioLastError : '.'}`;
  }
  if (l.acesioStatus === 'sent' && l.acesioDecision === 'accepted') {
    const sc = l.acesioSchedule;
    status = `Diterima admin Acesio${sc ? `, jadwal ${sc.day} ${sc.start_time}${sc.worker ? ' dengan ' + sc.worker : ''}` : ' (tanpa jadwal)'}.`;
  } else if (l.acesioDecision === 'rejected') {
    status = `Ditolak admin Acesio${l.acesioRejectReason ? ': ' + l.acesioRejectReason : '.'} Perbaiki data lalu hubungi customer.`;
  }
  const bd = l.data || {};
  const bookingBox = `<fieldset class="border border-emerald-200 rounded-lg p-2 space-y-2 bg-white"><legend class="text-xs font-bold text-emerald-900 px-1">Booking (bisa dikoreksi sebelum DP lunas)</legend>
      <input name="booking_services" maxlength="200" class="${INP}" aria-label="Layanan" placeholder="Layanan, pisahkan dengan koma" value="${esc(bd.booking_services || '')}">
      <div class="flex gap-2"><input type="date" name="booking_day" class="${INP}" aria-label="Tanggal booking" value="${esc(bd.booking_day || '')}"><input type="time" name="booking_time" class="${INP}" aria-label="Jam booking" value="${esc(bd.booking_time || '')}"></div>
    </fieldset>`;
  const hint = !rd.eligible ? 'Tombol aktif setelah tahap Hot Lead mencapai Won.'
    : rd.missing.length ? `Lengkapi dulu: ${rd.missing.map((k) => MISSING_LABEL[k] || k).join(', ')}.` : '';
  return `<div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-2" id="acesio-box">
    <p class="text-sm font-bold text-emerald-900">Pengajuan ke Acesio</p>
    <ul class="text-sm text-emerald-900 space-y-1" aria-label="Daftar periksa data Acesio">${items}</ul>
    ${bookingBox}
    <p class="text-xs ${l.acesioStatus === 'failed' || l.acesioDecision === 'rejected' ? 'text-red-700' : 'text-emerald-800'} font-medium" role="status">${esc(status)}</p>
    ${rd.eligible && l.acesioStatus !== 'sent' ? '<p class="text-xs text-emerald-800">Saat tahap diubah ke Won, data otomatis diajukan ke Acesio. Tombol di bawah untuk mencoba manual bila gagal.</p>' : ''}
    <div class="flex flex-wrap items-center gap-3">
      <button type="button" data-a="send-acesio" class="${BTN} bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40" ${rd.ready ? '' : 'disabled'} ${hint ? 'aria-describedby="acesio-hint"' : ''}>Ajukan ke Acesio</button>
      ${hint ? `<span id="acesio-hint" class="text-xs text-emerald-800">${esc(hint)}</span>` : ''}
    </div></div>`;
}

async function openEdit(id, trigger) {
  let l;
  try { l = (await api('/api/leads/' + encodeURIComponent(id))).lead; } catch (err) { toast(err.message, true); return; }
  const admin = me.role === 'admin';
  const notes = [...l.notes];
  const dataRows = Object.entries(l.data || {});
  const openCycles = (l.transactionCycles || []).filter((c) => !c.doneAt).length;
  const platforms = [...new Set([...meta.platforms, l.platform].filter(Boolean))];
  const statuses = meta.statuses.length ? meta.statuses : ['Cold Leads', 'Warm Leads', 'Hot Leads'];
  const dataTypes = meta.dataTypes.length ? meta.dataTypes : ['New', 'Existing'];
  const hotStages = meta.hotStages && meta.hotStages.length ? meta.hotStages : ['Follow Up', 'Negosiasi / Kirim Rekening', 'Won', 'Lost'];
  const act = (a, text, cls = BTN_LIGHT) => `<button type="button" data-a="${a}" class="${cls}">${text}</button>`;
  const h3 = 'font-medium text-gray-700 text-sm mb-1';

  modal('Edit lead', `<div id="lm" class="space-y-4">
    ${l.blocked ? '<p class="text-sm bg-gray-100 text-gray-700 rounded-lg p-2">Lead ini diblokir: tersembunyi dari daftar dan statistik.</p>' : ''}
    ${hotCand(l) ? `<div class="text-sm bg-orange-50 text-orange-800 rounded-lg p-3 flex items-center justify-between gap-3"><span><b>Kandidat Hot:</b> ${esc(l.hotCandidate.reason || '')}</span>${act('confirm-hot', 'Konfirmasi Hot', BTN_DARK)}</div>` : ''}
    ${field('Nama', `<input name="name" maxlength="200" class="${INP}" value="${esc(l.name)}">`, l.waName ? `Nama WhatsApp: ${esc(l.waName)}` : '')}
    <div class="block text-sm font-medium text-gray-700">No WA<div class="mt-1 font-normal flex flex-wrap items-center gap-2">${l.phone
      ? `<span class="${INP} bg-gray-100 !w-auto">${phoneSpan(l.phone)}</span><button type="button" data-a="copy-phone" data-phone="${esc(l.phone)}" aria-label="Salin nomor WhatsApp (angka)" class="text-xs font-medium px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Salin</button>`
      : `<span class="${INP} bg-gray-100 !w-auto text-gray-500">${esc(l.lid ? 'LID ' + l.lid : '-')}</span>${pill('Nomor belum terbaca', 'bg-gray-200 text-gray-700', 'Lead hanya punya LID/BSUID: nomor WhatsApp belum diketahui')}`}</div></div>
    ${field('Referensi', `<input name="referensi" maxlength="50" class="${INP}" value="${esc(l.referensi || '')}">`, 'Dari mana customer mengetahui kami (maks 50 karakter). Diisi dari jawaban customer atau diedit di sini.')}
    ${field('Sumber', sel('platform', platforms, l.platform))}
    ${field('Keyword Matched', `<input name="keyword" maxlength="200" class="${INP}" value="${esc(l.keyword)}">`)}
    ${field('Status Lead', sel('status', statuses, l.status), 'Otomatis: Cold saat pesan masuk pertama kali, Warm saat percakapan lebih dari 10 pesan, Hot saat ada transaksi/booking/transfer. Jika diubah manual, status ini dikunci.')}
    ${l.status === 'Hot Leads' ? field('Tahap Follow-Up Hot Lead', sel('hotStage', hotStages, l.hotStage || 'Follow Up'), 'Tingkatan verifikasi follow-up. Jika mencapai tahap Won, data dapat dikirim ke Acesio Dashboard.') : ''}
    ${l.status === 'Hot Leads' || l.acesioStatus === 'sent' ? acesioPanel(l) : ''}
    ${field('Data Leads', sel('dataType', dataTypes, l.dataType), 'Otomatis: New pada pesan masuk pertama kali; Existing bila customer yang pernah booking/transfer melakukannya untuk kedua kalinya (permanen). Jika diubah manual, dikunci.')}
    ${l.statusManual || l.dataTypeManual ? '<label class="flex items-center gap-2 text-sm"><input type="checkbox" name="resetAuto" value="1"> Kembalikan Status Lead &amp; Data Leads ke otomatis</label>' : ''}

    <fieldset class="border border-gray-200 rounded-lg p-3 space-y-2"><legend class="${h3} px-1">Follow-up</legend>
      <div class="flex gap-2"><input type="date" id="fu-date" class="${INP}" aria-label="Tanggal follow-up" value="${esc(l.followUpDate || '')}">${act('fu-clear', 'Kosongkan')}</div>
      <input id="fu-note" maxlength="300" class="${INP}" aria-label="Catatan follow-up" placeholder="Catatan follow-up (maks 300 karakter)" value="${esc(l.followUpNote || '')}">
    </fieldset>

    <section aria-labelledby="h-notes"><h4 id="h-notes" class="${h3}">Catatan</h4>
      <ul id="n-list" class="divide-y divide-gray-100 text-sm"></ul>
      <textarea id="n-text" maxlength="1000" rows="2" class="${INP} mt-2" aria-label="Tulis catatan baru" placeholder="Tulis catatan (maks 1000 karakter)"></textarea>
      <div class="mt-1">${act('note-add', 'Tambah catatan')}</div>
    </section>

    <section aria-labelledby="h-hist"><h4 id="h-hist" class="${h3}">Riwayat status</h4>
      <ul class="text-xs text-gray-600 space-y-1">${l.statusHistory.length
        ? [...l.statusHistory].reverse().map((h) => `<li><b>${esc(h.status)}</b> &middot; ${esc(fmtDT(h.ts))}${h.reason ? ` &middot; ${esc(h.reason)}` : ''}</li>`).join('')
        : '<li class="text-gray-400">Belum ada riwayat.</li>'}</ul>
    </section>

    ${dataRows.length ? `<section aria-labelledby="h-data"><h4 id="h-data" class="${h3}">Data wajib</h4><div class="bg-gray-50 rounded-lg p-3 space-y-1 text-sm text-gray-600">${dataRows.map(([k, v]) => `<div><b>${esc(labels[k] || k)}:</b> ${esc(v)}</div>`).join('')}</div></section>` : ''}

    <div class="flex flex-wrap gap-2 pt-1">
      ${openCycles ? act('tx-done', `Transaksi selesai (${openCycles} terbuka)`) : ''}
      ${admin ? act(l.blocked ? 'unblock' : 'block', l.blocked ? 'Buka blokir' : 'Blokir') : ''}
      ${admin ? act('del', 'Hapus', BTN + ' border border-red-300 text-red-700 hover:bg-red-50') : ''}
    </div></div>`,
  async (form) => {
    const fd = Object.fromEntries(new FormData(form));
    const body = { name: fd.name, keyword: fd.keyword, platform: fd.platform, status: fd.status, dataType: fd.dataType };
    if (fd.hotStage) body.hotStage = fd.hotStage;
    if (String(fd.referensi ?? '').trim() !== String(l.referensi || '')) body.referensi = String(fd.referensi ?? '').trim().slice(0, 50);
    if (fd.resetAuto) body.resetAuto = true;
    if ('booking_day' in fd) {
      const old = l.data || {}, bk = {};
      if (String(fd.booking_day || '') !== String(old.booking_day || '')) bk.day = fd.booking_day || '';
      if (String(fd.booking_time || '') !== String(old.booking_time || '')) bk.time = fd.booking_time || '';
      if (String(fd.booking_services || '').trim() !== String(old.booking_services || '')) bk.services = String(fd.booking_services || '').trim();
      if (Object.keys(bk).length) body.booking = bk;
    }
    await send('/api/leads/' + encodeURIComponent(id), body, 'PATCH');
    const date = $('#fu-date').value || null, note = $('#fu-note').value.trim();
    if (date !== (l.followUpDate || null) || note !== (l.followUpNote || '')) await send(`/api/leads/${encodeURIComponent(id)}/followup`, { date, note }, 'PUT');
    toast('Lead diperbarui');
    refreshAll();
  });

  const wrap = document.body.lastElementChild;
  wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Edit lead');
  const closeModal = () => wrap.querySelector('[data-x]')?.click();
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } });

  // kembalikan fokus ke pemicu setelah modal ditutup
  const mo = new MutationObserver(() => {
    if (wrap.isConnected) return;
    mo.disconnect(); observers.delete(mo);
    const back = trigger?.isConnected ? trigger : document.querySelector(`[data-act="edit"][data-id="${CSS.escape(id)}"]`);
    back?.focus();
  });
  mo.observe(document.body, { childList: true });
  observers.add(mo);

  const renderNotes = () => {
    $('#n-list').innerHTML = notes.length
      ? [...notes].reverse().map((n) => `<li class="py-2 flex gap-2 justify-between"><div class="min-w-0"><div class="text-gray-800 whitespace-pre-wrap break-words">${esc(n.text)}</div><div class="text-xs text-gray-400">${esc(n.by)} &middot; ${esc(fmtDT(n.ts))}</div></div>${admin || n.by === me.name ? `<button type="button" data-a="note-del" data-nid="${esc(n.id)}" aria-label="Hapus catatan dari ${esc(n.by)}" class="text-xs text-red-600 hover:underline shrink-0">Hapus</button>` : ''}</li>`).join('')
      : '<li class="py-2 text-gray-400">Belum ada catatan.</li>';
  };
  renderNotes();

  const base = `/api/leads/${encodeURIComponent(id)}`;
  $('#lm').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (a === 'fu-clear') { $('#fu-date').value = ''; $('#fu-note').value = ''; return; }
      if (a === 'note-add') {
        const t = $('#n-text').value.trim();
        if (!t) { toast('Catatan tidak boleh kosong', true); return; }
        notes.push((await send(base + '/notes', { text: t })).note);
        $('#n-text').value = ''; renderNotes(); lastKey = ''; loadList();
        return;
      }
      if (a === 'note-del') {
        await send(`${base}/notes/${encodeURIComponent(b.dataset.nid)}`, {}, 'DELETE');
        notes.splice(notes.findIndex((n) => n.id === b.dataset.nid), 1); renderNotes(); lastKey = ''; loadList();
        return;
      }
      if (a === 'copy-phone') {
        try { await navigator.clipboard.writeText(b.dataset.phone); toast('Nomor disalin'); } catch { toast('Gagal menyalin nomor', true); }
        return;
      }
      if (a === 'send-acesio') {
        const fm = $('#lm').closest('form');
        const dirty = fm.elements.namedItem('name').value.trim() !== String(l.name || '').trim()
          || fm.elements.namedItem('referensi').value.trim() !== String(l.referensi || '').trim();
        if (dirty) { toast('Simpan perubahan Nama/Referensi dulu sebelum mengajukan ke Acesio', true); return; }
        b.disabled = true;
        try {
          const res = await send(`${base}/send-to-acesio`, {});
          toast(res.lead?.acesioReplayed || res.replayed ? 'Sudah ada di Acesio (tidak diperbarui)' : (res.message || 'Data customer berhasil diajukan ke Acesio'));
          closeModal();
          refreshAll();
        } catch (err) {
          toast(err.message, true);
          b.disabled = false;
        }
        return;
      }
      if (a === 'confirm-hot') { await send(base, { confirmHot: true }, 'PATCH'); toast('Lead dikonfirmasi sebagai Hot'); }
      else if (a === 'tx-done') {
        if (!confirm('Tandai transaksi lead ini sebagai selesai?')) return;
        await send(base + '/transaction-done', {}); toast('Transaksi ditandai selesai');
      } else if (a === 'block' || a === 'unblock') {
        if (a === 'block' && !confirm(`Blokir ${label(l)}? Lead disembunyikan dari daftar dan statistik.`)) return;
        await send(`${base}/${a}`, {}); toast(a === 'block' ? 'Lead diblokir' : 'Blokir dibuka');
      } else if (a === 'del') {
        if (!confirm(`Hapus lead ${l.name || l.phone || ''}? Tindakan ini tidak bisa dibatalkan.`)) return;
        await send(base, {}, 'DELETE'); toast('Lead dihapus');
      } else return;
      closeModal();
      refreshAll();
    } catch (err) { toast(err.message, true); }
  });
}