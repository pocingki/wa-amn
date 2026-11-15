// Pesan: pesan pembuka + aturan, Basis Pengetahuan AI (daftar, impor/ekspor Markdown), pertanyaan referensi CRM, penutup, fallback.
import {
  $, esc, field, icon, INP, BTN_DARK, BTN_LIGHT, modal, toast, debounce, confirmDialog, getMe, isAdminRole,
  loadSettings, getSettings, saveSettings, onSettingsChange, openSettingsHistory, fmtNum,
  KNOWLEDGE_LIMITS, knowledgeStats, knowledgeLimitError, validateKnowledgeEntry, filterKnowledge,
  knowledgeFromText, previewKnowledgeImport, knowledgeToMarkdown, newKnowledgeId,
} from '../lib.js';

let S, root, canEdit = true, off = null, query = '';
const VARS = 'Variabel: {nama} {bot} {admin}';
const MAX_FILE = 2 * 1024 * 1024;
const STATE_LABEL = { baru: ['Baru', 'tag-ok', 'plus'], duplikat: ['Duplikat', 'tag-info', 'info'], error: ['Error', 'tag-warn', 'alert'] };

export async function mount(el) {
  root = el;
  query = '';
  const [, me] = await Promise.all([loadSettings(), getMe().catch(() => null)]);
  S = getSettings();
  canEdit = isAdminRole(me);
  off = onSettingsChange((s, src) => { if (src !== 'save') { S = s; render(); } });
  render();
}
export function unmount() { off?.(); off = null; }

/** Simpan lewat antrean; setelah selesai/konflik gambar ulang halaman supaya selalu cocok dengan server. */
async function commit(patchOrFn, opt) {
  try { await saveSettings(patchOrFn, opt); } catch (e) {
    if (!e.conflict) toast(e.message, true);
  }
  S = getSettings();
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
  const greet = Array.isArray(S.greetingWords) && S.greetingWords.length
    ? `<p class="text-xs text-gray-600">Kata salam yang dikenali: ${esc(S.greetingWords.join(', '))}.</p>` : '';
  root.innerHTML = `<h1 class="sr-only">Pesan</h1><div class="space-y-8">
  ${canEdit ? '' : `<div class="attn-banner" role="note">${icon('info')}<span>Anda masuk sebagai Agen. Halaman ini hanya bisa dilihat; hanya Admin yang dapat mengubah pengaturan.</span></div>`}

  <section class="card space-y-4" aria-labelledby="h-open">
    <div><h2 id="h-open" class="text-xl font-bold">Pesan Pembuka</h2><p class="text-sm text-gray-600">Sapaan pertama bot kepada pelanggan.</p></div>
    <div class="text-sm text-gray-700 space-y-1" id="open-rules">
      <p class="font-medium">Kapan pesan pembuka dikirim</p>
      <ul class="list-disc pl-5 space-y-1">
        <li><b>Nomor baru</b> (belum ada data lead dan belum pernah mengirim pesan): pembuka selalu dikirim.</li>
        <li><b>Nomor lama</b>: pembuka hanya dikirim bila pesan berisi salam, misalnya "halo" atau "selamat pagi" (di 3 kata pertama). Kata "p" dihitung hanya bila seluruh pesan.</li>
        <li>Pesan yang <b>hanya salam</b> dibalas pembuka saja, tanpa AI.</li>
        <li>Bila salam disertai pertanyaan, urutan balasan: pembuka, jawaban AI, lalu pertanyaan referensi.</li>
        <li>Pembuka dan pertanyaan referensi tidak memakai kuota AI.</li>
        <li>Lama sesi bot di Pengaturan hanya menentukan "sesi" untuk pengulangan pertanyaan referensi; tidak lagi memicu pembuka ulang.</li>
      </ul>
      ${greet}
    </div>
    <form id="op-form" class="space-y-2">
      ${field('Pesan pembuka', `<textarea name="openingMessage" rows="3" maxlength="2000" class="${INP}" ${dis}>${esc(S.openingMessage)}</textarea>`, VARS)}
      ${canEdit ? `<button class="${BTN_LIGHT}">Simpan pesan pembuka</button>` : ''}
    </form>
  </section>

  <section class="card space-y-4" aria-labelledby="h-kb">
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <div><h2 id="h-kb" class="text-xl font-bold">Basis Pengetahuan</h2><p class="text-sm text-gray-600">AI menjawab hanya dari basis pengetahuan; bila tidak ada, akan diteruskan ke admin.</p></div>
      <div class="flex flex-wrap gap-2">
        ${canEdit ? `<button type="button" id="k-add" class="${BTN_DARK}" ${full ? 'disabled title="Batas jumlah entri tercapai"' : ''}>Tambah entri</button><button type="button" id="k-import" class="${BTN_LIGHT}">Impor</button>` : ''}
        <button type="button" id="k-export" class="${BTN_LIGHT}">Ekspor .md</button>
        <button type="button" id="k-history" class="${BTN_LIGHT}">Riwayat versi</button>
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
    <form id="fb-form" class="space-y-2 border-t border-gray-100 pt-4">
      ${field('Respons default (jika AI nonaktif atau belum diatur)', `<textarea name="fallbackMessage" rows="2" class="${INP}" ${dis}>${esc(S.fallbackMessage)}</textarea>`, VARS + '. Dikirim dengan jeda ulang yang sama seperti sebelumnya. Kosongkan agar bot diam.')}
      ${canEdit ? `<button class="${BTN_LIGHT}">Simpan respons default</button>` : ''}
    </form>
  </section>

  <section class="card space-y-4" aria-labelledby="h-field">
    <div><h2 id="h-field" class="text-xl font-bold">Pertanyaan Referensi untuk CRM</h2><p class="text-sm text-gray-600">Bot menanyakan dari mana pelanggan mengetahui bisnis Anda. Jawabannya tersimpan sebagai referensi lead (maksimal 50 karakter).</p></div>
    <ul class="list-disc pl-5 text-sm text-gray-700 space-y-1">
      <li>Ditanyakan hanya bila referensi lead masih kosong. Bila sudah terisi di CRM, tidak ditanyakan lagi.</li>
      <li>Maksimal 3 kali per sesi (1 awal + 2 ulang). Jawaban pelanggan yang bukan pertanyaan disimpan sebagai referensi.</li>
      <li>Pelanggan bisa membalas "lewati" untuk menghentikan pertanyaan pada sesi itu.</li>
      <li>Referensi dibutuhkan agar lead bisa diajukan ke Acesio.</li>
    </ul>
    <form id="rf-form" class="space-y-2">
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" ${ref.enabled ? 'checked' : ''} ${dis}> Aktifkan pertanyaan referensi</label>
      ${field('Pertanyaan bot', `<textarea name="question" rows="2" maxlength="500" class="${INP}" ${dis}>${esc(ref.question)}</textarea>`, VARS)}
      <div id="rf-err" class="form-error" role="alert" hidden></div>
      ${canEdit ? `<button class="${BTN_LIGHT}">Simpan pertanyaan referensi</button>` : ''}
    </form>
    <form id="cm-form" class="space-y-2 border-t border-gray-100 pt-4">
      ${field('Pesan setelah semua data terkumpul', `<textarea name="completionMessage" rows="2" class="${INP}" ${dis}>${esc(S.completionMessage)}</textarea>`, VARS)}
      ${canEdit ? `<button class="${BTN_LIGHT}">Simpan pesan penutup</button>` : ''}
    </form>
  </section></div>`;
  paintKnowledge();
  bind();
}

function bind() {
  $('#k-add')?.addEventListener('click', () => knowledgeModal());
  $('#k-import')?.addEventListener('click', () => importModal());
  $('#k-history').onclick = openSettingsHistory;
  $('#k-export').onclick = () => {
    const list = knowledgeOf(S);
    if (!list.length) return toast('Belum ada entri untuk diekspor.', true);
    download('basis-pengetahuan.md', knowledgeToMarkdown(list));
  };
  $('#k-search').oninput = debounce((e) => { query = e.target.value; paintKnowledge(); }, 200);
  $('#op-form').onsubmit = (e) => { e.preventDefault(); commit({ openingMessage: String(new FormData(e.target).get('openingMessage') ?? '') }); };
  $('#fb-form').onsubmit = (e) => { e.preventDefault(); commit({ fallbackMessage: String(new FormData(e.target).get('fallbackMessage') ?? '') }); };
  $('#cm-form').onsubmit = (e) => { e.preventDefault(); commit({ completionMessage: String(new FormData(e.target).get('completionMessage') ?? '') }); };
  $('#rf-form').onsubmit = (e) => {
    e.preventDefault();
    const v = new FormData(e.target), box = $('#rf-err');
    try {
      const requiredFields = buildReferensi({ enabled: v.get('enabled') === 'on', question: v.get('question') });
      box.hidden = true;
      commit({ requiredFields });
    } catch (err) { box.textContent = err.message; box.hidden = false; }
  };

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
