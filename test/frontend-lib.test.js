// Uji fungsi murni frontend (lib.js + helper di pages/*). Tanpa browser: DOM yang dibutuhkan di-stub seperlunya.
import test from 'node:test';
import assert from 'node:assert/strict';

const lib = await import('../public/assets/js/lib.js');
const platform = await import('../public/assets/js/platform.js');
const percakapan = await import('../public/assets/js/pages/percakapan.js');
const pesan = await import('../public/assets/js/pages/pesan.js');
const pengaturan = await import('../public/assets/js/pages/pengaturan.js');
const tester = await import('../public/assets/js/pages/tester.js');

const ts = new Date('2026-10-31T10:05:00').getTime();

test('esc melepas karakter HTML', () => {
  assert.equal(lib.esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(lib.esc(null), '');
});

test('detectOs: iPhone, iPad, Android, dan desktop', () => {
  assert.equal(platform.detectOs('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone', 5), 'ios');
  assert.equal(platform.detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 5), 'ios');
  assert.equal(platform.detectOs('Mozilla/5.0 (Linux; Android 14)', 'Linux armv8l', 5), 'android');
  assert.equal(platform.detectOs('Mozilla/5.0 (Windows NT 10.0)', 'Win32', 0), 'other');
});

test('waStatusView: nonaktif bukan terputus', () => {
  assert.equal(lib.waStatusView('disabled').long, 'WA Nonaktif');
  assert.equal(lib.waStatusView('disconnected').long, 'WA Terputus');
  assert.equal(lib.waStatusView('disabled').label, 'NONAKTIF');
  assert.equal(lib.waStatusView('entah').long, 'WA Tidak tersedia');
});

test('halaman tersimpan: refresh kembali ke rute yang sama, selain itu diabaikan', () => {
  const mem = new Map();
  const box = { setItem: (k, v) => mem.set(k, v), getItem: (k) => mem.get(k) ?? null };
  assert.equal(lib.rememberPage('#/pengaturan', box), '#/pengaturan');
  assert.equal(lib.savedPage(box), '#/pengaturan');
  assert.equal(lib.rememberPage('#/tidak-ada', box), '');
  assert.equal(lib.savedPage(box), '#/pengaturan');
  assert.equal(lib.rememberPage('#/percakapan?x=1', box), '#/percakapan');
  assert.equal(lib.pageFromHash(''), '');
});

test('readCookie + friendlyMessage', () => {
  assert.equal(lib.readCookie('csrf', 'a=1; csrf=tok%20en; b=2'), 'tok en');
  assert.equal(lib.readCookie('x', 'a=1'), '');
  assert.match(lib.friendlyMessage(413, null), /413/);
  assert.match(lib.friendlyMessage(403, { error: 'CSRF' }), /Muat ulang/);
  assert.match(lib.friendlyMessage(403, { error: 'Forbidden' }), /izin/);
  assert.equal(lib.friendlyMessage(400, { error: 'Pesan kosong' }), 'Pesan kosong');
  assert.match(lib.friendlyMessage(502, null), /502/);
});

test('api(): CSRF hanya pada non-GET, error jaringan ramah (bukan "Failed to fetch")', async () => {
  const calls = [];
  globalThis.fetch = async (path, o) => { calls.push({ path, o }); return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
  lib.setCsrfToken('T0K');
  await lib.api('/api/x');
  await lib.send('/api/x', { a: 1 });
  await lib.send('/api/x', {}, 'PUT', { 'If-Match': '3' });
  assert.equal(calls[0].o.headers['X-CSRF-Token'], undefined);
  assert.equal(calls[1].o.headers['X-CSRF-Token'], 'T0K');
  assert.equal(calls[2].o.headers['If-Match'], '3');
  assert.equal(calls[2].o.headers['X-CSRF-Token'], 'T0K');

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(lib.api('/api/x'), (e) => !/Failed to fetch/.test(e.message) && e.status === 0);

  globalThis.fetch = async () => ({ ok: false, status: 413, text: async () => '<html>too large</html>' });
  await assert.rejects(lib.send('/api/settings', {}, 'PUT'), (e) => e.status === 413 && /413/.test(e.message));
});

test('saveSettings: antrean menghitung patch dari data terbaru + If-Match naik', async () => {
  const el = () => ({ appendChild() {}, setAttribute() {}, remove() {}, set textContent(v) {} });
  globalThis.document = { getElementById: () => el(), createElement: el, body: el() };
  const st = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms) => { const t = st(f, ms); if (ms >= 1000) t.unref?.(); return t; }; // hanya timer toast yang di-unref
  let server = { version: 1, knowledge: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }] };
  const seen = [];
  globalThis.fetch = async (path, o) => {
    if (o.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify(server) };
    seen.push(o.headers['If-Match']);
    await new Promise((r) => setTimeout(r, 5));
    server = { ...server, ...JSON.parse(o.body), version: server.version + 1 };
    return { ok: true, status: 200, text: async () => JSON.stringify(server) };
  };
  await lib.loadSettings();
  const t = (id) => (c) => ({ knowledge: c.knowledge.map((i) => (i.id === id ? { ...i, enabled: false } : i)) });
  await Promise.all([lib.saveSettings(t('a')), lib.saveSettings(t('b'))]); // toggle cepat
  assert.deepEqual(seen, ['1', '2']);
  assert.deepEqual(server.knowledge.map((i) => i.enabled), [false, false]); // tidak saling menimpa
  globalThis.setTimeout = st;
  delete globalThis.document;
});

test('formatTitle & debounce', async () => {
  assert.equal(lib.formatTitle('CRM', 0), 'CRM');
  assert.equal(lib.formatTitle('CRM', 3), '(3) CRM');
  assert.equal(lib.formatTitle('CRM', 150), '(99+) CRM');
  let n = 0;
  const d = lib.debounce(() => n++, 10);
  d(); d(); d();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 1);
});

test('event: parseEventData + emitEvent/onEvent', () => {
  assert.deepEqual(lib.parseEventData('{"phone":"62"}'), { payload: { phone: '62' } });
  assert.deepEqual(lib.parseEventData('{"type":"unread","payload":{"total":2}}'), { type: 'unread', payload: { total: 2 } });
  assert.equal(lib.parseEventData('bukan json').payload && Object.keys(lib.parseEventData('x').payload).length, 0);
  const got = [];
  const off = lib.onEvent('lead:hot', (p) => got.push(p));
  lib.emitEvent('lead:hot', { phone: '1' });
  off();
  lib.emitEvent('lead:hot', { phone: '2' });
  assert.deepEqual(got, [{ phone: '1' }]);
});

test('bubble: status nyata, bukan ✓✓ tetap', () => {
  const m = (status, by = 'admin') => ({ id: '1', by, text: 'Halo', ts, status });
  const own = (x, o = {}) => lib.bubble(x, { own: true, ...o });
  assert.ok(!own(m('sent')).includes('✓') && !own(m('sent')).includes('&#10003;'));
  assert.match(own(m('sending')), /Mengirim/);
  assert.match(own(m('sent')), /Terkirim/);
  assert.match(own(m('delivered')), /Diterima/);
  assert.match(own(m('read')), /st-read/);
  assert.match(own(m('failed'), { canRetry: true }), /data-a="retry"[^>]*data-id="1"/);
  assert.doesNotMatch(own(m('failed')), /data-a="retry"/);
  assert.match(own(m(undefined)), /Terkirim/); // data lama tanpa status
  assert.equal(lib.statusKey({ by: 'customer', text: 'x' }, { own: true }), null);
  assert.equal(lib.statusKey({ by: 'bot', status: 'failed' }, { own: false }), 'failed');
  assert.equal(lib.statusKey({ by: 'bot', status: 'read' }, { own: false }), null);
});

test('bubble: teks di-escape, media lewat /api/media/:id dengan alt/label', () => {
  assert.match(lib.bubble({ id: 'x', by: 'customer', text: '<img onerror=1>', ts }), /&lt;img onerror=1&gt;/);
  const img = lib.mediaHTML({ type: 'image', mediaId: 'ab/12', by: 'customer' });
  assert.match(img, /src="\/api\/media\/ab%2F12"/);
  assert.match(img, /alt="Gambar dari pelanggan"/);
  assert.match(img, /data-zoom=/);
  assert.match(lib.mediaHTML({ type: 'audio', mediaId: 'a1' }), /<audio[^>]+controls/);
  const doc = lib.mediaHTML({ type: 'document', mediaId: 'd1', fileName: 'hasil.pdf' });
  assert.match(doc, /href="\/api\/media\/d1" download/);
  assert.match(doc, /hasil\.pdf/);
  assert.match(lib.mediaHTML({ type: 'image', by: 'customer' }), /tidak tersedia/);
  assert.equal(lib.mediaHTML({ type: 'text' }), '');
  assert.equal(lib.messageText({ type: 'image', text: '[Gambar]' }), '');
  assert.equal(lib.messageText({ type: 'image', caption: 'sakit lutut' }), 'sakit lutut');
  assert.equal(lib.previewText({ by: 'customer', type: 'audio', text: '' }), 'Pesan suara');
});

test('chatHTML: chip tanggal, chip sistem, teks status hanya di pesan terakhir', () => {
  const msgs = [
    { id: '1', by: 'bot', text: 'a', ts, status: 'read' },
    { id: '2', by: 'system', text: 'Admin mengambil alih dari HP', ts: ts + 1 },
    { id: '3', by: 'admin', text: 'b', ts: ts + 2, status: 'delivered' },
  ];
  const h = lib.chatHTML(msgs, (m) => ({ own: m.by !== 'customer' }));
  assert.match(h, /sys-chip/);
  assert.match(h, /Admin mengambil alih dari HP/);
  assert.equal((h.match(/b-st-text/g) || []).length, 1);
});

test('knowledgeFromText: pisah per "# Judul", teks liar dilaporkan, escape dibuka', () => {
  const txt = '﻿catatan liar\r\n# Harga\r\nPaket A Rp 100\r\n## Sub\r\nlanjut\r\n\r\n# Jam buka #\r\n\\# bukan judul\r\n#tanpaspasi\r\n#\r\n# Kosong\r\n';
  const { items, errors } = lib.knowledgeFromText(txt);
  assert.deepEqual(items.map((x) => x.title), ['Harga', 'Jam buka', 'Kosong']);
  assert.equal(items[0].content, 'Paket A Rp 100\n## Sub\nlanjut');
  assert.equal(items[1].content, '# bukan judul\n#tanpaspasi\n#');
  assert.equal(items[2].content, '');
  assert.equal(items[0].line, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.deepEqual(lib.knowledgeFromText('tanpa judul sama sekali').items, []);
  assert.deepEqual(lib.knowledgeFromText('').errors, []);
});

test('knowledgeToMarkdown: bulat-balik (round trip) termasuk baris berawalan "# "', () => {
  const entries = [
    { id: 'a', title: 'Harga', content: 'Baris 1\n# kelihatan judul\n\\# sudah miring\nBaris 4', enabled: true },
    { id: 'b', title: 'Judul\nDua baris', content: 'Isi', enabled: false },
  ];
  const md = lib.knowledgeToMarkdown(entries);
  assert.ok(md.endsWith('\n'));
  assert.equal(lib.knowledgeToMarkdown([]), '');
  const back = lib.knowledgeFromText(md);
  assert.equal(back.errors.length, 0);
  assert.deepEqual(back.items.map((x) => [x.title, x.content]), [['Harga', entries[0].content], ['Judul Dua baris', 'Isi']]);
});

test('validateKnowledgeEntry, knowledgeStats, knowledgeLimitError, filterKnowledge', () => {
  assert.equal(lib.validateKnowledgeEntry({ title: ' ', content: 'x' }), 'Judul kosong');
  assert.equal(lib.validateKnowledgeEntry({ title: 'A', content: '  ' }), 'Isi kosong');
  assert.match(lib.validateKnowledgeEntry({ title: 'A', content: 'x'.repeat(20001) }), /20000/);
  assert.equal(lib.validateKnowledgeEntry({ title: 'A', content: 'x'.repeat(20000) }), '');
  const list = [{ id: '1', title: 'Harga', content: 'Rp 100', enabled: true }, { id: '2', title: 'Alamat', content: 'Jl. Mawar', enabled: false }];
  assert.deepEqual(lib.knowledgeStats(list), { count: 2, enabled: 1, chars: 15 });
  assert.deepEqual(lib.knowledgeStats(null), { count: 0, enabled: 0, chars: 0 });
  assert.equal(lib.knowledgeLimitError(list), '');
  assert.match(lib.knowledgeLimitError(Array.from({ length: 201 }, () => ({ content: 'a' }))), /200 entri/);
  assert.match(lib.knowledgeLimitError(Array.from({ length: 11 }, () => ({ content: 'a'.repeat(20000) }))), /200000/);
  assert.deepEqual(lib.filterKnowledge(list, 'MAWAR').map((x) => x.id), ['2']);
  assert.deepEqual(lib.filterKnowledge(list, '  ').length, 2);
  assert.deepEqual(lib.filterKnowledge(list, 'zzz'), []);
});

test('previewKnowledgeImport: baru / duplikat / error per entri + mode + batas', () => {
  let n = 0;
  const gen = () => 'id' + ++n;
  const existing = [{ id: 'h', title: 'Tanya  Harga', content: 'lama', enabled: false }];
  const items = [
    { line: 1, title: 'tanya harga', content: 'baru' },
    { line: 5, title: 'Alamat', content: 'Jl. A' },
    { line: 9, title: 'alamat', content: 'dobel' },
    { line: 12, title: 'Kosong', content: '' },
    { line: 14, title: 'Panjang', content: 'x'.repeat(20001) },
  ];
  const add = lib.previewKnowledgeImport(existing, items, 'add', gen);
  assert.deepEqual(add.rows.map((r) => r.state), ['duplikat', 'baru', 'duplikat', 'error', 'error']);
  assert.deepEqual(add.counts, { baru: 1, duplikat: 2, error: 2, diperbarui: 0 });
  assert.equal(add.result.length, 2);
  assert.equal(add.result[0].content, 'lama');
  assert.deepEqual(add.result[1], { id: 'id1', title: 'Alamat', content: 'Jl. A', enabled: true });
  assert.equal(existing.length, 1); // masukan tidak diubah
  const upd = lib.previewKnowledgeImport(existing, items, 'update', gen);
  assert.equal(upd.result[0].content, 'baru');
  assert.equal(upd.result[0].id, 'h');
  assert.equal(upd.result[0].enabled, false); // status aktif dipertahankan
  assert.equal(upd.counts.diperbarui, 1);
  assert.equal(lib.previewKnowledgeImport(existing, items, 'replace', gen).result.length, 2); // judul lama tidak dibawa
  // batas jumlah entri
  const full = Array.from({ length: 200 }, (_, i) => ({ id: 'e' + i, title: 'n' + i, content: 'r' }));
  assert.match(lib.previewKnowledgeImport(full, [items[1]], 'add', gen).rows[0].reason, /batas 200/);
  // batas total karakter
  const big = Array.from({ length: 10 }, (_, i) => ({ id: 'b' + i, title: 'b' + i, content: 'x'.repeat(19999) }));
  const tot = lib.previewKnowledgeImport(big, [{ line: 1, title: 'Baru', content: 'y'.repeat(10) }], 'add', gen);
  assert.equal(tot.rows[0].state, 'baru');
  const tot2 = lib.previewKnowledgeImport(big, [{ line: 1, title: 'Baru', content: 'y'.repeat(10) }, { line: 2, title: 'Lagi', content: 'z'.repeat(1) }], 'add', gen);
  assert.equal(tot2.rows[1].state, 'error');
  const updBig = lib.previewKnowledgeImport(big, [{ line: 1, title: 'b0', content: 'q'.repeat(20000) }], 'update', gen);
  assert.equal(updBig.rows[0].state, 'duplikat'); // masih muat: 199.990 - 19.999 + 20.000
  const noRoom = lib.previewKnowledgeImport([...big, { id: 'z', title: 'z', content: 'x'.repeat(10) }], [{ line: 1, title: 'b0', content: 'q'.repeat(20000) }], 'update', gen);
  assert.match(noRoom.rows[0].reason, /total/);
});

test('newKnowledgeId unik dan deterministik bila disuntik', () => {
  assert.equal(lib.newKnowledgeId(() => 0, () => 36), 'k10000000');
  assert.notEqual(lib.newKnowledgeId(), lib.newKnowledgeId());
});

test('parseOptions', () => {
  assert.deepEqual(lib.parseOptions('A\nB, A | C'), ['A', 'B', 'C']);
});

test('normHistory menerima beberapa bentuk', () => {
  const h = lib.normHistory({ history: [{ version: 2, updatedAt: 5, updatedBy: 'x', changes: ['a', 'b'] }, { version: 3, ts: 9 }, { foo: 1 }] });
  assert.deepEqual(h.map((x) => x.version), [3, 2]);
  assert.equal(h[1].summary, 'a, b');
  assert.equal(lib.normHistory([{ version: 1 }]).length, 1);
});

test('percakapan: filterConversations', () => {
  const l = [
    { phone: '1', name: 'Budi', needsAttention: true, last: { text: 'sakit lutut' } },
    { phone: '2', name: 'Sari', awaitingReply: true, last: { type: 'image', text: '' } },
    { phone: '628123', name: '', last: { text: 'halo' } },
  ];
  assert.equal(percakapan.filterConversations(l).length, 3);
  assert.deepEqual(percakapan.filterConversations(l, 'attn').map((c) => c.phone), ['1']);
  assert.deepEqual(percakapan.filterConversations(l, 'await').map((c) => c.phone), ['2']);
  assert.deepEqual(percakapan.filterConversations(l, 'all', 'LUTUT').map((c) => c.phone), ['1']);
  assert.deepEqual(percakapan.filterConversations(l, 'all', '6281').map((c) => c.phone), ['628123']);
  assert.deepEqual(percakapan.filterConversations(l, 'all', 'gambar').map((c) => c.phone), ['2']);
});

test('pesan: referensiField dan buildReferensi (tepat satu butir)', () => {
  assert.deepEqual(pesan.referensiField(undefined), pesan.REFERENSI_DEFAULT);
  assert.deepEqual(pesan.referensiField([{ id: 'nama', label: 'Nama', enabled: true }]), pesan.REFERENSI_DEFAULT);
  const f = pesan.referensiField([{ id: 'nama' }, { id: 'referensi', type: 'text', enabled: false, question: 'Tahu dari mana?', label: 'x' }]);
  assert.deepEqual(f, { id: 'referensi', type: 'text', enabled: false, question: 'Tahu dari mana?' });
  assert.deepEqual(pesan.buildReferensi({ enabled: true, question: '  Dari mana?  ' }), [{ id: 'referensi', type: 'text', enabled: true, question: 'Dari mana?' }]);
  assert.equal(pesan.buildReferensi({ enabled: false, question: 'x' })[0].enabled, false);
  assert.throws(() => pesan.buildReferensi({ enabled: true, question: '   ' }), /tidak boleh kosong/);
  assert.throws(() => pesan.buildReferensi({ enabled: true, question: 'x'.repeat(501) }), /500/);
});

test('pengaturan: buildSettingsPatch validasi', () => {
  const ok = { brandName: 'acesio', botName: 'Bot', adminName: 'Admin', botDurationMinutes: '0', adminAutoReturnMinutes: '0', staleMinutes: '10', fallbackCooldownMinutes: '30', sendRateLimitPerMinute: '20', retentionDays: '0', attentionMinutes: '15', botEnabled: 'on', onHot: 'on', webhookUrl: '', telegramBotToken: '', telegramChatId: '' };
  const r = pengaturan.buildSettingsPatch(ok, { notify: { x: 1 } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.patch.staleMinutes, 10);
  assert.equal(r.patch.botEnabled, true);
  assert.equal(r.patch.autoTakeoverOnPhoneReply, false);
  assert.equal(r.patch.notify.onHot, true);
  assert.equal(r.patch.notify.onDisconnected, false);
  assert.equal(r.patch.notify.attentionMinutes, 15);
  assert.equal(r.patch.notify.x, 1); // field notify lain dipertahankan
  const bad = pengaturan.buildSettingsPatch({ ...ok, staleMinutes: '0', sendRateLimitPerMinute: 'abc', webhookUrl: 'ftp://x', telegramBotToken: 't' });
  assert.deepEqual(bad.errors.map((e) => e.field).sort(), ['sendRateLimitPerMinute', 'staleMinutes', 'telegramChatId']);
  assert.equal(bad.patch.notify.webhookUrl, undefined);
});

test('tester: mergeChips, diffTesterView, attentionOf', () => {
  const msgs = [{ id: 'a' }, { id: 'b' }];
  const out = tester.mergeChips(msgs, [{ id: 'c1', after: 'a' }, { id: 'c2', after: null }, { id: 'c3', after: 'hilang' }]);
  assert.deepEqual(out.map((x) => x.id), ['c2', 'a', 'c1', 'b', 'c3']);
  const prev = { messages: [{ id: '1', by: 'bot', status: 'sending' }], status: { mode: 'bot' }, needsAttention: false };
  const next = { messages: [{ id: '1', by: 'bot', status: 'failed' }], status: { mode: 'admin' }, needsAttention: true, attentionReason: 'Gagal kirim' };
  const notes = tester.diffTesterView(prev, next);
  assert.equal(notes.length, 3);
  assert.match(notes[0], /Mengirim → Gagal terkirim/);
  assert.match(notes[1], /Perlu perhatian: Gagal kirim/);
  assert.match(notes[2], /bot → admin/);
  assert.deepEqual(tester.attentionOf({ status: { needsAttention: true, attentionReason: 'x' } }), { on: true, reason: 'x' });
  assert.deepEqual(tester.attentionOf({}), { on: false, reason: '' });
});
