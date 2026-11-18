// Pesan: SATU tempat untuk semua pesan bot (pembuka, kata salam, referensi, penutup, serah-terima, respons default) + Basis Pengetahuan AI.
import {
  $, esc, field, icon, INP, BTN_DARK, BTN_LIGHT, modal, toast, debounce, confirmDialog, getMe, isAdminRole,
  loadSettings, getSettings, saveSettings, onSettingsChange, fmtNum,
  KNOWLEDGE_LIMITS, knowledgeStats, knowledgeLimitError, validateKnowledgeEntry, filterKnowledge,
  knowledgeFromText, previewKnowledgeImport, knowledgeToMarkdown, newKnowledgeId,
} from '../lib.js';
import { cleanGreeting, normalizeGreetings, DEFAULT_GREETINGS } from './pengaturan.js';

let S, root, canEdit = true, off = null, query = '', greet = [];
const GREET_MAX = 100;
const VARS = 'Variabel: {nama} {bot} {admin}';
const MAX_FILE = 2 * 1024 * 1024;
const STATE_LABEL = { baru: ['Baru', 'tag-ok', 'plus'], duplikat: ['Duplikat', 'tag-info', 'info'], error: ['Error', 'tag-warn', 'alert'] };

export async function mount(el) {
  root = el;
  query = '';
  const [, me] = await Promise.all([loadSettings(), getMe().catch(() => null)]);
  S = getSettings();
  canEdit = isAdminRole(me);
  greet = Array.isArray(S.greetingWords) ? normalizeGreetings(S.greetingWords) : [...DEFAULT_GREETINGS];
  off = onSettingsChange((s, src) => { if (src !== 'save') { S = s; greet = Array.isArray(S.greetingWords) ? normalizeGreetings(S.greetingWords) : [...DEFAULT_GREETINGS]; render(); } });
  render();
}
export function unmount() { off?.(); off = null; }

/** Simpan lewat antrean; setelah selesai/konflik gambar ulang halaman supaya selalu cocok dengan server. */
async function commit(patchOrFn, opt) {
  try { await saveSettings(patchOrFn, opt); } catch (e) {
    if (!e.conflict) toast(e.message, true);
  }
  S = getSettings();
  greet = Array.isArray(S.greetingWords) ? normalizeGreetings(S.greetingWords) : [...DEFAULT_GREETINGS];
  render();
}

const gone = () => { throw new Error('Data ini sudah dihapus oleh orang lain. Halaman dimuat ulang.'); };
const knowledgeOf = (s) => (Array.isArray(s?.knowledge) ? s.knowledge : []);

/* ---------- pertanyaan referensi (satu butir data wajib) ---------- */
export const REFERENSI_DEFAULT = { id: 'referensi', type: 'text', enabled: true, question: 'Boleh tahu, Kakak mengetahui kami dari mana?' };

/** Butir referensi dari daftar requiredFields (bawaan bila belum ada). Selalu tepat { id, type, enabled, question }. */
export function referensiField(list) {
  const f = (Array.isArray(list) ? list : []).find((x) => x && x.id === 'referensi');
  return {
    id: 'referensi', type: 'text',
    enabled: f ? f.enabled !== false : REFERENSI_DEFAULT.enabled,
    question: f && typeof f.question === 'string' && f.question.trim() ? f.question : REFERENSI_DEFAULT.question,
  };
}

/** Daftar requiredFields baru (tepat satu butir). Melempar Error ramah bila pertanyaan tidak valid. */
export function buildReferensi({ enabled, question }) {
  const q = String(question ?? '').trim();
  if (!q) throw new Error('Pertanyaan tidak boleh kosong.');
  if (q.length > 500) throw new Error('Pertanyaan maksimal 500 karakter.');
  return [{ id: 'referensi', type: 'text', enabled: !!enabled, question: q }];
}

/* ---------- tampilan ---------- */
function statsHTML() {
  const st = knowledgeStats(knowledgeOf(S));
  const near = st.count >= KNOWLEDGE_LIMITS.entries * 0.9 || st.chars >= KNOWLEDGE_LIMITS.totalChars * 0.9;
  return `<span class="${near ? 'warn-text' : ''}">${near ? icon('alert', 'icon-xs') + ' ' : ''}${fmtNum(st.count)} / ${fmtNum(KNOWLEDGE_LIMITS.entries)} entri &middot; ${fmtNum(st.chars)} / ${fmtNum(KNOWLEDGE_LIMITS.totalChars)} karakter &middot; ${fmtNum(st.enabled)} aktif</span>`;
}

function listHTML() {
  const all = knowledgeOf(S);
  const list = filterKnowledge(all, query);
  const dis = canEdit ? '' : 'disabled';
  if (!all.length) return '<tr><td colspan="5" class="p-8 text-center text-gray-600 italic">Belum ada entri. Tambahkan informasi (harga, jam buka, aturan, dll.) agar AI bisa menjawab.</td></tr>';
  if (!list.length) return `<tr><td colspan="5" class="p-8 text-center text-gray-600 italic">Tidak ada entri yang cocok dengan "${esc(query)}".</td></tr>`;
  return list.map((e) => `<tr>
    <td class="p-3" data-label="Aktif"><input type="checkbox" data-ktoggle="${esc(e.id)}" aria-label="Aktifkan entri ${esc(e.title)}" ${e.enabled !== false ? 'checked' : ''} ${dis}></td>
    <td class="p-3 font-medium" data-label="Judul">${esc(e.title)}${e.enabled === false ? ' <span class="tag">Nonaktif</span>' : ''}</td>
    <td class="p-3 text-gray-700 max-w-md" data-label="Isi"><div class="line-clamp-2 whitespace-pre-wrap">${esc(e.content)}</div></td>
    <td class="p-3 whitespace-nowrap" data-label="Karakter">${fmtNum(String(e.content ?? '').length)}</td>
    <td class="p-3 whitespace-nowrap text-right" data-label="Aksi">${canEdit ? `<button type="button" data-kedit="${esc(e.id)}" class="link-btn mr-2" aria-label="Edit entri ${esc(e.title)}">Edit</button><button type="button" data-kdel="${esc(e.id)}" class="link-btn danger" aria-label="Hapus entri ${esc(e.title)}">Hapus</button>` : '-'}</td></tr>`).join('');
}

function greetChips(dis) {
  if (!greet.length) return '<p class="text-sm text-amber-800">Belum ada kata salam.</p>';
  return greet.map((w, i) => `<span class="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-white py-1 text-sm" style="padding-left:.75rem;padding-right:.25rem">${esc(w)}${dis ? '' : `<button type="button" data-g-del="${i}" class="icon-btn" style="min-width:1.75rem;min-height:1.75rem" aria-label="Hapus kata salam ${esc(w)}">${icon('x', 'icon-xs')}</button>`}</span>`).join('');
}

function bindGreetings() {
  if (!canEdit) return;
  const list = $('#g-list'), inp = $('#g-add');
  const paint = () => { list.innerHTML = greetChips(''); };
  const add = () => {
    const w = cleanGreeting(inp.value);
    if (!w) { inp.value = ''; return; }
    if (greet.includes(w)) toast('Kata salam itu sudah ada', true);
    else if (greet.length >= GREET_MAX) toast(`Maksimal ${GREET_MAX} kata salam`, true);
    else { greet.push(w); paint(); }
    inp.value = '';
    inp.focus();
  };
  $('#g-add-btn').onclick = add;
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  list.onclick = (e) => {
    const b = e.target.closest('[data-g-del]');
    if (!b) return;
    greet.splice(Number(b.dataset.gDel), 1);
    paint();
  };
  $('#g-reset').onclick = () => { greet = [...DEFAULT_GREETINGS]; paint(); };
}

function paintKnowledge() {
  const body = $('#k-rows'), st = $('#k-stats');
  if (body) body.innerHTML = listHTML();
  if (st) st.innerHTML = statsHTML();
  const n = $('#k-shown');
  if (n) n.textContent = query.trim() ? `Menampilkan ${fmtNum(filterKnowledge(knowledgeOf(S), query).length)} dari ${fmtNum(knowledgeOf(S).length)} entri` : '';
}

function render() {
  const dis = canEdit ? '' : 'disabled';
  const ref = referensiField(S.requiredFields);
  const full = knowledgeOf(S).length >= KNOWLEDGE_LIMITS.entries;
  root.innerHTML = `<h1 class="sr-only">Pesan</h1><div class="space-y-8">
  ${canEdit ? '' : `<div class="attn-banner" role="note">${icon('info')}<span>Anda masuk sebagai Agen. Halaman ini hanya bisa dilihat; hanya Admin yang dapat mengubah pengaturan.</span></div>`}

  <section class="card space-y-5" aria-labelledby="h-msg">
    <div><h2 id="h-msg" class="text-xl font-bold">Pesan Otomatis Bot</h2><p class="text-sm text-gray-600">Semua pesan yang dikirim bot diatur di sini, satu tombol simpan.</p></div>
    <form id="msg-form" class="space-y-4" novalidate>
      ${field('1. Pesan pembuka', `<textarea name="openingMessage" rows="3" maxlength="2000" class="${INP}" ${dis}>${esc(S.openingMessage)}</textarea>`, 'Sapaan pertama. Dikirim ke nomor baru, dan ke nomor lama bila pesannya berisi salam. ' + VARS)}
      <div class="space-y-2">
        <p class="text-sm font-medium">Kata salam <span class="font-normal text-gray-600">(pemicu pesan pembuka untuk nomor lama)</span></p>
        <div id="g-list" class="flex flex-wrap gap-2">${greetChips(dis)}</div>
        ${canEdit ? `<div class="flex gap-2 flex-wrap items-center">
          <input id="g-add" class="${INP} flex-1" style="min-width:8rem" maxlength="40" placeholder="Tambah kata salam" aria-label="Kata salam baru" autocomplete="off">
          <button type="button" id="g-add-btn" class="${BTN_LIGHT} shrink-0">Tambah</button>
          <button type="button" id="g-reset" class="${BTN_LIGHT} shrink-0">Kembalikan bawaan</button>
        </div>` : ''}
      </div>
      <div class="space-y-2 border-t border-gray-100 pt-4">
        <label class="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="refEnabled" ${ref.enabled ? 'checked' : ''} ${dis}> 2. Tanya dari mana pelanggan mengenal Anda (referensi CRM)</label>
        ${field('Pertanyaan referensi', `<textarea name="refQuestion" rows="2" maxlength="500" class="${INP}" ${dis}>${esc(ref.question)}</textarea>`, 'Jawaban disimpan sebagai referensi lead (maks. 50 karakter). ' + VARS)}
      </div>
      <div class="border-t border-gray-100 pt-4 space-y-4">
        ${field('3. Pesan setelah semua data terkumpul', `<textarea name="completionMessage" rows="2" maxlength="2000" class="${INP}" ${dis}>${esc(S.completionMessage)}</textarea>`, VARS)}
        ${field('4. Pesan serah-terima ke admin', `<textarea name="handoverMessage" rows="2" maxlength="2000" class="${INP}" ${dis}>${esc(S.handoverMessage)}</textarea>`, 'Dikirim saat percakapan dialihkan dari bot ke admin. ' + VARS)}
        ${field('5. Respons default (bila AI nonaktif atau belum diatur)', `<textarea name="fallbackMessage" rows="2" maxlength="2000" class="${INP}" ${dis}>${esc(S.fallbackMessage)}</textarea>`, 'Kosongkan agar bot diam.')}
      </div>
      <div id="msg-err" class="form-error" role="alert" hidden></div>
      ${canEdit ? `<button class="${BTN_DARK}">Simpan semua pesan</button>` : ''}
    </form>
    <details class="text-sm text-gray-700 border-t border-gray-100 pt-3">
      <summary class="cursor-pointer font-medium">Aturan singkat: kapan bot mengirim apa</summary>
      <ul class="list-disc pl-5 space-y-1 mt-2">
        <li>Nomor baru: pembuka selalu dikirim. Nomor lama: pembuka hanya bila pesan diawali kata salam (3 kata pertama; "p" hanya bila seluruh pesan).</li>
        <li>Pesan yang hanya salam dibalas pembuka saja. Bila disertai pertanyaan: pembuka, jawaban AI, lalu pertanyaan referensi.</li>
        <li>Referensi ditanyakan hanya bila belum terisi di CRM, maksimal 3 kali per sesi; pelanggan bisa membalas "lewati".</li>
        <li>Pembuka dan pertanyaan referensi tidak memakai kuota AI. Lama sesi bot diatur di Pengaturan.</li>
      </ul>
    </details>
  </section>

  <section class="card space-y-4" aria-labelledby="h-kb">
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <div><h2 id="h-kb" class="text-xl font-bold">Basis Pengetahuan</h2><p class="text-sm text-gray-600">AI menjawab hanya dari basis pengetahuan; bila tidak ada, akan diteruskan ke admin.</p></div>
      <div class="flex flex-wrap gap-2">
        ${canEdit ? `<button type="button" id="k-add" class="${BTN_DARK}" ${full ? 'disabled title="Batas jumlah entri tercapai"' : ''}>Tambah entri</button><button type="button" id="k-import" class="${BTN_LIGHT}">Impor</button>` : ''}
        <button type="button" id="k-export" class="${BTN_LIGHT}">Ekspor .md</button>
      </div>
    </div>
    <div class="warn-box" role="note">${icon('info')}<span>Isi basis pengetahuan dikirim ke penyedia AI sebagai bahan jawaban. Jangan menulis data pribadi pelanggan, kata sandi, atau kunci API di sini.</span></div>
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
      <div class="text-sm font-medium" id="k-stats" role="status"></div>
      <input id="k-search" type="search" class="${INP} sm:max-w-xs" placeholder="Cari judul atau isi" aria-label="Cari entri basis pengetahuan" value="${esc(query)}">
    </div>
    <div class="text-xs text-gray-600" id="k-shown" role="status" aria-live="polite"></div>
    <div class="overflow-x-auto"><table class="w-full text-left text-sm border-collapse rtable">
      <caption class="sr-only">Daftar entri basis pengetahuan</caption>
      <thead><tr class="bg-gray-50 border-b border-gray-200 text-gray-600 font-medium"><th scope="col" class="p-3">Aktif</th><th scope="col" class="p-3">Judul</th><th scope="col" class="p-3">Isi</th><th scope="col" class="p-3">Karakter</th><th scope="col" class="p-3">Aksi</th></tr></thead>
      <tbody id="k-rows" class="divide-y divide-gray-200"></tbody></table></div>
  </section>
</div>`;
  paintKnowledge();
  bind();
}

function bind() {
  $('#k-add')?.addEventListener('click', () => knowledgeModal());
  $('#k-import')?.addEventListener('click', () => importModal());
  $('#k-export').onclick = () => {
    const list = knowledgeOf(S);
    if (!list.length) return toast('Belum ada entri untuk diekspor.', true);
    download('basis-pengetahuan.md', knowledgeToMarkdown(list));
  };
  $('#k-search').oninput = debounce((e) => { query = e.target.value; paintKnowledge(); }, 200);
  $('#msg-form').onsubmit = (e) => {
    e.preventDefault();
    if (!canEdit) return;
    const v = new FormData(e.target), box = $('#msg-err');
    try {
      if (!greet.length) throw new Error('Daftar kata salam tidak boleh kosong.');
      const requiredFields = buildReferensi({ enabled: v.get('refEnabled') === 'on', question: v.get('refQuestion') });
      box.hidden = true;
      commit({
        openingMessage: String(v.get('openingMessage') ?? ''), completionMessage: String(v.get('completionMessage') ?? ''),
        handoverMessage: String(v.get('handoverMessage') ?? ''), fallbackMessage: String(v.get('fallbackMessage') ?? ''),
        greetingWords: [...greet], requiredFields,
      });
    } catch (err) { box.textContent = err.message; box.hidden = false; }
  };
  bindGreetings();

  root.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.kedit) knowledgeModal(d.kedit);
    else if (d.kdel) {
      const it = knowledgeOf(S).find((x) => x.id === d.kdel);
      if (await confirmDialog('Hapus entri?', `Hapus entri "${it?.title ?? ''}" dari basis pengetahuan?`, { okText: 'Hapus', danger: true })) commit((c) => ({ knowledge: knowledgeOf(c).filter((x) => x.id !== d.kdel) }));
    }
  };
  root.onchange = (e) => {
    const d = e.target.dataset, on = e.target.checked;
    if (d.ktoggle) commit((c) => ({ knowledge: knowledgeOf(c).map((x) => (x.id === d.ktoggle ? { ...x, enabled: on } : x)) }));
  };
}

/* ---------- tambah / ubah entri ---------- */
function knowledgeModal(id) {
  const it = id != null ? knowledgeOf(S).find((x) => x.id === id) : null;
  if (id != null && !it) { toast('Entri tidak ditemukan; halaman dimuat ulang.', true); render(); return; }
  const e0 = it || { title: '', content: '', enabled: true };
  const others = knowledgeStats(knowledgeOf(S).filter((x) => x.id !== it?.id)).chars;
  const d = modal(it ? 'Edit entri' : 'Tambah entri', `
    ${field('Judul', `<input name="title" required class="${INP}" value="${esc(e0.title)}" placeholder="Contoh: Harga paket">`)}
    ${field('Isi', `<textarea name="content" required rows="10" class="${INP}" aria-describedby="kc-count" placeholder="Tulis informasi selengkap dan sejelas mungkin.">${esc(e0.content)}</textarea>`)}
    <div id="kc-count" class="text-xs text-gray-600" role="status" aria-live="polite"></div>
    <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" ${e0.enabled !== false ? 'checked' : ''}> Aktif (dipakai AI)</label>`,
  async (f) => {
    const v = new FormData(f);
    const title = String(v.get('title')).trim(), content = String(v.get('content')).trim();
    const bad = validateKnowledgeEntry({ title, content });
    if (bad) throw new Error(bad + '.');
    await saveSettings((c) => {
      const list = knowledgeOf(c);
      let out;
      if (!it) out = [...list, { id: newKnowledgeId(), title, content, enabled: v.get('enabled') === 'on' }];
      else {
        if (!list.some((x) => x.id === it.id)) gone();
        out = list.map((x) => (x.id === it.id ? { ...x, title, content, enabled: v.get('enabled') === 'on' } : x));
      }
      const lim = knowledgeLimitError(out);
      if (lim) throw new Error(lim + '. Hapus atau persingkat entri lain.');
      return { knowledge: out };
    });
    S = getSettings();
    render();
  }, 'Simpan', { wide: true });
  const count = d.form.querySelector('#kc-count');
  const paint = () => {
    const n = d.form.content.value.trim().length;
    const over = n > KNOWLEDGE_LIMITS.entryChars || others + n > KNOWLEDGE_LIMITS.totalChars;
    count.className = 'text-xs ' + (over ? 'warn-text' : 'text-gray-600');
    count.textContent = `Isi: ${fmtNum(n)} / ${fmtNum(KNOWLEDGE_LIMITS.entryChars)} karakter. Total basis pengetahuan: ${fmtNum(others + n)} / ${fmtNum(KNOWLEDGE_LIMITS.totalChars)}.${over ? ' Melebihi batas.' : ''}`;
  };
  d.form.content.addEventListener('input', debounce(paint, 250));
  paint();
}

/* ---------- impor ---------- */
function importModal() {
  const d = modal('Impor basis pengetahuan', `
    <p class="text-sm">Tempel teks atau pilih berkas <b>.txt</b> / <b>.md</b>. Tiap entri diawali baris <code>"# Judul"</code>; baris di bawahnya menjadi isi. Baris lain yang diawali "# " selalu dianggap judul baru.</p>
    <div><label class="block text-sm font-medium text-gray-700" for="ki-file">Berkas (opsional)</label><input id="ki-file" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" class="${INP}"></div>
    ${field('Teks', `<textarea name="text" rows="8" class="${INP} font-mono" placeholder="# Harga paket&#10;Paket A Rp ... &#10;&#10;# Jam buka&#10;Senin-Sabtu 09.00-17.00"></textarea>`)}
    <fieldset class="space-y-1"><legend class="text-sm font-medium">Jika judul sudah ada</legend>
      <label class="flex items-center gap-2 text-sm"><input type="radio" name="mode" value="add" checked> Lewati duplikat (tambahkan yang baru saja)</label>
      <label class="flex items-center gap-2 text-sm"><input type="radio" name="mode" value="update"> Perbarui entri yang sudah ada</label>
      <label class="flex items-center gap-2 text-sm"><input type="radio" name="mode" value="replace"> Ganti seluruh basis pengetahuan dengan isi ini</label></fieldset>
    <div id="ki-warn"></div>
    <div id="ki-sum" class="text-sm font-medium" role="status" aria-live="polite"></div>
    <div class="overflow-x-auto max-h-72 overflow-y-auto border border-gray-200 rounded-lg"><table class="w-full text-left text-sm"><caption class="sr-only">Pratinjau impor per entri</caption>
      <thead><tr class="bg-gray-50 text-gray-600"><th scope="col" class="p-2">Baris</th><th scope="col" class="p-2">Status</th><th scope="col" class="p-2">Judul</th><th scope="col" class="p-2">Keterangan</th></tr></thead><tbody id="ki-rows"></tbody></table></div>`,
  async (f) => {
    const mode = f.mode.value;
    const { items } = knowledgeFromText(f.text.value);
    if (!items.length) throw new Error('Tidak ada entri. Awali tiap bagian dengan baris "# Judul".');
    const pv = previewKnowledgeImport(knowledgeOf(S), items, mode);
    const added = pv.counts.baru + pv.counts.diperbarui;
    if (!added) throw new Error('Tidak ada entri yang bisa diimpor. Perbaiki teks atau ubah pilihan di atas.');
    if (mode === 'replace' && !(await confirmDialog('Ganti seluruh basis pengetahuan?', `Semua ${knowledgeOf(S).length} entri saat ini akan diganti dengan ${pv.result.length} entri baru.`, { okText: 'Ganti', danger: true }))) throw new Error('Impor dibatalkan.');
    await saveSettings((c) => ({ knowledge: previewKnowledgeImport(knowledgeOf(c), items, mode).result }), { message: `${added} entri diimpor` });
    S = getSettings();
    render();
  }, 'Impor', { wide: true });

  const paint = () => {
    const { items, errors } = knowledgeFromText(d.form.text.value);
    const pv = previewKnowledgeImport(knowledgeOf(S), items, d.form.mode.value);
    d.form.querySelector('#ki-warn').innerHTML = errors.map((x) => `<div class="warn-box">${icon('alert')}<span>Baris ${esc(x.line)}: ${esc(x.msg)}</span></div>`).join('');
    d.form.querySelector('#ki-sum').textContent = items.length
      ? `${pv.counts.baru} baru, ${pv.counts.duplikat} duplikat${pv.counts.diperbarui ? ` (${pv.counts.diperbarui} diperbarui)` : ''}, ${pv.counts.error} error`
      : '';
    d.form.querySelector('#ki-rows').innerHTML = pv.rows.map((r) => {
      const [l, c, ic] = STATE_LABEL[r.state];
      return `<tr class="border-t border-gray-100"><td class="p-2">${esc(r.line)}</td><td class="p-2"><span class="tag ${c}">${icon(ic, 'icon-xs')} ${l}</span></td><td class="p-2">${esc(r.title || '-')}</td><td class="p-2 text-gray-700">${esc(r.reason)}</td></tr>`;
    }).join('');
  };
  const debouncedPaint = debounce(paint, 250);
  d.form.addEventListener('input', (e) => { if (e.target.name === 'text') debouncedPaint(); });
  d.form.addEventListener('change', (e) => { if (e.target.name === 'mode') paint(); });
  d.form.querySelector('#ki-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/\.(txt|md|markdown)$/i.test(file.name)) return toast('Gunakan berkas .txt atau .md.', true);
    if (file.size > MAX_FILE) return toast('File terlalu besar (maks. 2 MB). Pecah menjadi beberapa file lebih kecil.', true);
    try { d.form.text.value = await file.text(); } catch (err) { return toast('File tidak bisa dibaca: ' + err.message, true); }
    paint();
  };
  paint();
}

function download(name, text, type = 'text/markdown;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
