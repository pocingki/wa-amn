// Uji API CRM (src/api/crm.js). Jalankan: node --test test/crm-api.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
process.env.KEYWORDS_FILE = path.join(process.env.DATA_DIR, 'keywords.test.json');
const baseCfg = JSON.parse(fs.readFileSync('config/keywords.json', 'utf8'));
const setTz = (timezone) => fs.writeFileSync(process.env.KEYWORDS_FILE, JSON.stringify({ ...baseCfg, leadRule: 'all', timezone }));
setTz('Asia/Jakarta');

const store = await import('../src/store.js');
const C = await import('../src/conversations.js');
const L = await import('../src/leads.js');
const { handle, acesioReadiness } = await import('../src/api/crm.js');

const ADMIN = { name: 'Rina', role: 'admin' };
const AGENT = { name: 'Budi', role: 'agent' };

async function call(method, urlPath, { body, user = ADMIN, headers = {} } = {}) {
  const audits = [];
  const out = { status: 0, headers: {}, text: '', audits, handled: undefined, viaSendJSON: false };
  const res = {
    writeHead(code, h = {}) { out.status = code; out.headers = { ...out.headers, ...h }; },
    end(t = '') { out.text += t; },
  };
  const ctx = {
    sendJSON(r, code, b) { out.viaSendJSON = true; out.status = code; out.text = JSON.stringify(b); },
    readBody: async () => body,
    user, ip: '127.0.0.1',
    audit: (action, detail) => audits.push({ action, detail }),
    requireRole(role) {
      if (user.role === role) return true;
      ctx.sendJSON(res, 403, { error: 'Akses ditolak' });
      return false;
    },
  };
  const req = { method, headers, url: urlPath };
  out.handled = await handle(req, res, new URL(urlPath, 'http://x'), ctx);
  try { out.json = JSON.parse(out.text); } catch { out.json = null; }
  return out;
}

const reset = () => { for (const l of [...store.all()]) store.remove(l.id); };
const mk = (o = {}) => store.add({
  phone: '62811' + Math.floor(Math.random() * 1e7), name: 'Tes', platform: 'Instagram', keyword: 'harga', status: 'Cold Leads', dataType: 'New',
  createdAt: Date.now(), lastMessageAt: Date.now(), ...o,
});
const withNow = async (iso, fn) => {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try { return await fn(); } finally { Date.now = real; }
};

test('daftar: filter q (tidak peka huruf besar), status, sumber, dataType', async () => {
  reset();
  mk({ name: 'Ayu Lestari', phone: '6281100001', keyword: 'booking' });
  mk({ name: 'Budi', phone: '6281100002', platform: 'Facebook', status: 'Hot Leads' });
  mk({ name: 'Citra', phone: '6281100003', dataType: 'Existing' });
  const q = async (s) => (await call('GET', '/api/leads?' + s)).json;
  assert.deepEqual((await q('q=AYU')).leads.map((l) => l.name), ['Ayu Lestari']);
  assert.equal((await q('q=81100002')).total, 1);
  assert.equal((await q('q=BOOKING')).total, 1);
  assert.equal((await q('status=Hot Leads')).leads[0].name, 'Budi');
  assert.equal((await q('platform=Facebook')).total, 1);
  assert.equal((await q('dataType=Existing')).leads[0].name, 'Citra');
  const all = await q('');
  assert.equal(all.total, 3);
  assert.deepEqual(all.statuses, store.STATUSES);
  assert.equal(all.tz, 'Asia/Jakarta');
});

test('daftar: awaiting dan overdue', async () => {
  reset();
  const now = Date.now();
  mk({ name: 'Menunggu', lastCustomerMessageAt: now, lastReplyAt: now - 1000 });
  mk({ name: 'Sudah dibalas', lastCustomerMessageAt: now - 5000, lastReplyAt: now });
  mk({ name: 'Belum pernah dibalas', lastCustomerMessageAt: now });
  mk({ name: 'Lewat', followUpDate: '2000-01-01' });
  mk({ name: 'Nanti', followUpDate: '2999-01-01' });
  const names = async (s) => (await call('GET', '/api/leads?' + s)).json.leads.map((l) => l.name).sort();
  assert.deepEqual(await names('awaiting=1'), ['Belum pernah dibalas', 'Menunggu']);
  assert.deepEqual(await names('overdue=1'), ['Lewat']);
});

test('daftar: sort, arah, paginasi, batas pageSize', async () => {
  reset();
  for (const [n, t] of [['Citra', 3], ['Ayu', 1], ['Dewi', 4], ['Budi', 2], ['Eka', 5]]) mk({ name: n, createdAt: t * 1000, lastMessageAt: t * 1000 });
  const get = async (s) => (await call('GET', '/api/leads?' + s)).json;
  assert.deepEqual((await get('')).leads.map((l) => l.name), ['Eka', 'Dewi', 'Citra', 'Budi', 'Ayu']); // default lastContactAt desc
  assert.deepEqual((await get('sort=name&dir=asc')).leads.map((l) => l.name), ['Ayu', 'Budi', 'Citra', 'Dewi', 'Eka']);
  const p2 = await get('sort=name&dir=asc&pageSize=2&page=2');
  assert.deepEqual(p2.leads.map((l) => l.name), ['Citra', 'Dewi']);
  assert.equal(p2.total, 5); assert.equal(p2.page, 2); assert.equal(p2.pageSize, 2);
  assert.equal((await get('sort=name&dir=asc&pageSize=2&page=99')).page, 3); // dijepit ke halaman terakhir
  assert.equal((await get('pageSize=9999')).pageSize, 100);
  assert.equal((await get('pageSize=abc')).pageSize, 25);
  assert.equal((await call('GET', '/api/leads?sort=password')).status, 400);
  assert.equal((await call('GET', '/api/leads?dir=sideways')).status, 400);
});

test('daftar: bentuk item, data digabung dengan percakapan, lead lama tidak error', async () => {
  reset();
  const { conv } = C.getOrCreate('6281300001', '6281300001@s.whatsapp.net', 'Lama');
  conv.data = { nama: 'Dari percakapan', kebutuhan: 'Lutut' };
  mk({
    phone: '6281300001', name: 'Lama', notes: [{ id: 'n1', by: 'Rina', text: 'x', ts: 1 }], statusHistory: [{ status: 'Cold Leads', ts: 1, reason: 'a' }],
    lastCustomerMessageAt: 100, lastReplyAt: 300, lastMessageAt: 200, data: { nama: 'Dari lead' }, hotCandidate: { ts: 5, reason: 'bukti' }, warmScore: 7, warmReasons: ['aktif'],
  });
  mk({ phone: null, lid: 'abc@lid', name: 'Hanya LID' }); // tanpa field baru, tanpa phone
  const { leads } = (await call('GET', '/api/leads')).json;
  const a = leads.find((l) => l.name === 'Lama');
  assert.equal(a.noteCount, 1);
  assert.ok(!('notes' in a) && !('statusHistory' in a));
  assert.equal(a.lastContactAt, 300);
  assert.equal(a.awaitingReply, false);
  assert.deepEqual(a.data, { nama: 'Dari lead', kebutuhan: 'Lutut' });
  assert.equal(a.hotCandidate.reason, 'bukti'); assert.equal(a.warmScore, 7); assert.deepEqual(a.warmReasons, ['aktif']);
  const b = leads.find((l) => l.name === 'Hanya LID');
  assert.equal(b.noteCount, 0); assert.equal(b.hotCandidate, null); assert.equal(b.followUpOverdue, false);
});

test('daftar: lead terblokir tersembunyi kecuali blocked=1', async () => {
  reset();
  mk({ name: 'Normal' });
  mk({ name: 'Diblokir', blocked: true });
  assert.deepEqual((await call('GET', '/api/leads')).json.leads.map((l) => l.name), ['Normal']);
  assert.equal((await call('GET', '/api/leads?blocked=1')).json.total, 2);
});

test('ETag: 200 dengan Cache-Control private, no-cache; 304 bila If-None-Match cocok; berubah saat data berubah', async () => {
  reset();
  mk({ name: 'Satu' });
  const r1 = await call('GET', '/api/leads');
  assert.equal(r1.status, 200);
  assert.equal(r1.viaSendJSON, false); // ditulis sendiri, bukan lewat sendJSON (no-store)
  assert.equal(r1.headers['Cache-Control'], 'private, no-cache');
  const etag = r1.headers.ETag;
  assert.match(etag, /^"[\w-]+"$/);
  const r2 = await call('GET', '/api/leads', { headers: { 'if-none-match': etag } });
  assert.equal(r2.status, 304); assert.equal(r2.text, '');
  assert.equal((await call('GET', '/api/leads', { headers: { 'if-none-match': 'W/' + etag } })).status, 304);
  mk({ name: 'Dua' });
  const r3 = await call('GET', '/api/leads', { headers: { 'if-none-match': etag } });
  assert.equal(r3.status, 200); assert.notEqual(r3.headers.ETag, etag);
});

test('stats: batas hari mengikuti timezone (Asia/Jakarta vs America/New_York)', async () => {
  reset();
  // sekarang = 2026-03-10 18:00 UTC = 11 Mar 01:00 WIB = 10 Mar 14:00 EDT
  mk({ name: 'A', createdAt: Date.parse('2026-03-10T17:30:00Z') }); // 11 Mar 00:30 WIB, 10 Mar 13:30 EDT
  mk({ name: 'B', createdAt: Date.parse('2026-03-10T10:00:00Z') }); // 10 Mar 17:00 WIB, 10 Mar 06:00 EDT
  await withNow('2026-03-10T18:00:00Z', async () => {
    setTz('Asia/Jakarta');
    let s = (await call('GET', '/api/leads/stats?period=day')).json;
    assert.equal(s.tz, 'Asia/Jakarta'); assert.equal(s.total, 1); assert.equal(s.prevTotal, 1); assert.equal(s.fromDate, '2026-03-11');
    assert.equal(s.from, Date.parse('2026-03-10T17:00:00Z'));
    setTz('America/New_York');
    s = (await call('GET', '/api/leads/stats?period=day')).json;
    assert.equal(s.tz, 'America/New_York'); assert.equal(s.total, 2); assert.equal(s.prevTotal, 0); assert.equal(s.fromDate, '2026-03-10');
    assert.equal(s.from, Date.parse('2026-03-10T04:00:00Z')); // EDT = UTC-4 (DST mulai 8 Mar 2026)
    assert.equal(s.deltaPct, null);
  });
  setTz('Asia/Jakarta');
});

test('stats: Hot dihitung dari statusHistory, lead lama dari createdAt, cohortHotRate, blocked dikecualikan, periode', async () => {
  reset();
  setTz('Asia/Jakarta');
  const T = (iso) => Date.parse(iso);
  await withNow('2026-05-20T05:00:00Z', async () => { // 20 Mei 2026 12:00 WIB
    // dibuat bulan lalu, naik Hot bulan ini -> masuk hot bulan ini, tidak masuk total bulan ini
    mk({ name: 'Naik', status: 'Hot Leads', createdAt: T('2026-04-25T03:00:00Z'),
      statusHistory: [{ status: 'Cold Leads', ts: T('2026-04-25T03:00:00Z') }, { status: 'Hot Leads', ts: T('2026-05-10T03:00:00Z') }] });
    // dibuat dan Hot bulan ini
    mk({ name: 'Baru Hot', status: 'Hot Leads', platform: 'Facebook', createdAt: T('2026-05-02T03:00:00Z'),
      statusHistory: [{ status: 'Cold Leads', ts: T('2026-05-02T03:00:00Z') }, { status: 'Warm Leads', ts: T('2026-05-03T03:00:00Z') }, { status: 'Hot Leads', ts: T('2026-05-04T03:00:00Z') }] });
    // lead lama tanpa statusHistory
    mk({ name: 'Lama Warm', status: 'Warm Leads', createdAt: T('2026-05-05T03:00:00Z') });
    mk({ name: 'Cold', status: 'Cold Leads', createdAt: T('2026-05-06T03:00:00Z') });
    mk({ name: 'Blokir', status: 'Hot Leads', blocked: true, createdAt: T('2026-05-06T03:00:00Z') });
    mk({ name: 'April', status: 'Cold Leads', createdAt: T('2026-04-10T03:00:00Z') });
    const s = (await call('GET', '/api/leads/stats?period=month')).json;
    assert.equal(s.total, 3);
    assert.equal(s.hot, 2); // Naik + Baru Hot
    assert.equal(s.warm, 2); // Baru Hot + Lama Warm
    assert.equal(s.cold, 2); // Baru Hot + Cold (awal di bulan ini)
    assert.equal(s.cohortHotRate, 33.3); // hanya 'Baru Hot' dari 3 lead yang dibuat bulan ini
    assert.equal(s.prevTotal, 2); // Naik + April
    assert.equal(s.deltaPct, 50);
    assert.deepEqual(s.funnel, [{ label: 'Semua lead', value: 3 }, { label: 'Warm + Hot', value: 2 }, { label: 'Hot', value: 1 }]);
    assert.deepEqual(s.bySource, [{ label: 'Instagram', value: 2 }, { label: 'Facebook', value: 1 }]);
    assert.equal(s.fromDate, '2026-05-01'); assert.equal(s.toDate, '2026-05-31');
    const w = (await call('GET', '/api/leads/stats?period=week')).json;
    assert.equal(w.fromDate, '2026-05-14'); assert.equal(w.toDate, '2026-05-20'); assert.equal(w.total, 0);
    const y = (await call('GET', '/api/leads/stats?period=year')).json;
    assert.equal(y.fromDate, '2026-01-01'); assert.equal(y.toDate, '2026-12-31'); assert.equal(y.total, 5);
    assert.equal((await call('GET', '/api/leads/stats?period=decade')).status, 400);
  });
});

test('export.csv: BOM, CRLF, kolom, proteksi formula injection, audit', async () => {
  reset();
  mk({
    name: '=HYPERLINK("http://x")', phone: '+6281400001', keyword: '@cmd', platform: 'Instagram',
    createdAt: Date.parse('2026-03-10T17:30:00Z'), lastMessageAt: Date.parse('2026-03-11T01:00:00Z'),
    followUpDate: '2026-04-01', followUpNote: 'telepon',
    data: { nama: 'Ayu', kebutuhan: '-5 kg' },
    notes: [{ id: '1', by: 'Rina', text: '+62 minta jadwal', ts: 1 }, { id: '2', by: 'Budi', text: 'baris "dua"', ts: 2 }],
  });
  mk({ name: 'Disembunyikan', blocked: true });
  const r = await call('GET', '/api/leads/export.csv?q=cmd');
  assert.equal(r.status, 200);
  assert.match(r.headers['Content-Type'], /^text\/csv; charset=utf-8/);
  assert.match(r.headers['Content-Disposition'], /^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(r.text.charCodeAt(0), 0xfeff);
  const lines = r.text.slice(1).split('\r\n');
  assert.equal(lines.pop(), ''); // diakhiri CRLF
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '"Nama","No WA","Sumber","Keyword","Status","Data Leads","Tanggal Masuk","Kontak Terakhir","Follow-up","Data Wajib","Catatan"');
  assert.ok(lines[1].startsWith('"\'=HYPERLINK(""http://x"")"'), lines[1]); // diawali apostrof + kutip digandakan
  assert.ok(lines[1].includes('"+6281400001"')); // nomor tidak diberi apostrof
  assert.ok(lines[1].includes('"\'@cmd"'));
  assert.ok(lines[1].includes('"2026-03-11 00:30"')); // Tanggal Masuk menurut timezone config (WIB)
  assert.ok(lines[1].includes('"2026-03-11 08:00"')); // Kontak Terakhir
  assert.ok(lines[1].includes('"2026-04-01 (telepon)"'));
  assert.ok(lines[1].includes('"Nama: Ayu; Kebutuhan: -5 kg"')); // Data Wajib memakai label dari pengaturan
  assert.ok(lines[1].endsWith('"Rina: +62 minta jadwal | Budi: baris ""dua"""')); // catatan digabung
  assert.deepEqual(r.audits, [{ action: 'lead.export', detail: { count: 1 } }]);
  // tanpa filter: blocked tetap tersembunyi, tanpa paginasi
  assert.equal((await call('GET', '/api/leads/export.csv')).text.split('\r\n').length, 3);
});

test('PATCH: status manual menambah statusHistory + statusManual, validasi, batas 200 karakter, resetAuto', async () => {
  reset();
  const l = mk({ name: 'Ayu', status: 'Cold Leads', createdAt: 1000 });
  let r = await call('PATCH', '/api/leads/' + l.id, { body: { status: 'Warm Leads', name: ' ' + 'x'.repeat(300) } });
  assert.equal(r.status, 200);
  assert.equal(r.json.lead.status, 'Warm Leads'); assert.equal(r.json.lead.statusManual, true); assert.equal(r.json.lead.name.length, 200);
  const h = r.json.lead.statusHistory;
  assert.equal(h.length, 2); // entri awal disemai untuk lead lama
  assert.equal(h[0].status, 'Cold Leads');
  assert.equal(h[1].status, 'Warm Leads'); assert.equal(h[1].reason, 'Diubah manual oleh Rina');
  assert.deepEqual(r.audits, [{ action: 'lead.update', detail: { id: l.id, fields: ['name', 'status'] } }]);
  // status sama: tidak menambah riwayat
  r = await call('PATCH', '/api/leads/' + l.id, { body: { status: 'Warm Leads' } });
  assert.equal(r.json.lead.statusHistory.length, 2);
  // validasi
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { status: 'Deal' } })).status, 400);
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { dataType: 'Baru' } })).status, 400);
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { platform: '  ' } })).status, 400);
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { name: 5 } })).status, 400);
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { foo: 1 } })).status, 400);
  assert.equal((await call('PATCH', '/api/leads/tidak-ada', { body: { name: 'a' } })).status, 404);
  // dataType manual lalu resetAuto
  r = await call('PATCH', '/api/leads/' + l.id, { body: { dataType: 'Existing' } });
  assert.equal(r.json.lead.dataTypeManual, true);
  r = await call('PATCH', '/api/leads/' + l.id, { body: { resetAuto: true, status: 'Hot Leads' } });
  assert.equal(r.json.lead.statusManual, false); assert.equal(r.json.lead.dataTypeManual, false);
  assert.equal(r.json.lead.status, 'Warm Leads'); // status diabaikan saat resetAuto (perilaku lama)
  // agent juga boleh PATCH
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { keyword: 'baru' }, user: AGENT })).status, 200);
});

test('PATCH confirmHot: set Hot manual, hapus hotCandidate, tambah riwayat', async () => {
  reset();
  const l = mk({ status: 'Warm Leads', hotCandidate: { ts: 1, reason: 'gambar setelah bahas pembayaran' }, statusHistory: [{ status: 'Warm Leads', ts: 1, reason: 'a' }] });
  const r = await call('PATCH', '/api/leads/' + l.id, { body: { confirmHot: true }, user: AGENT });
  assert.equal(r.status, 200);
  assert.equal(r.json.lead.status, 'Hot Leads'); assert.equal(r.json.lead.statusManual, true); assert.equal(r.json.lead.hotCandidate, null);
  assert.equal(r.json.lead.statusHistory.at(-1).reason, 'Diubah manual oleh Budi');
  assert.equal(store.all().find((x) => x.id === l.id).hotCandidate, null);
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { confirmHot: true, resetAuto: true } })).status, 400);
});

test('DELETE: agent ditolak 403, admin berhasil, percakapan tidak ikut terhapus', async () => {
  reset();
  C.getOrCreate('6281500001', 'j', 'Hapus');
  const l = mk({ phone: '6281500001' });
  let r = await call('DELETE', '/api/leads/' + l.id, { user: AGENT });
  assert.equal(r.status, 403); assert.equal(store.all().length, 1);
  assert.equal((await call('DELETE', '/api/leads/tidak-ada')).status, 404);
  r = await call('DELETE', '/api/leads/' + l.id);
  assert.equal(r.status, 200); assert.equal(store.all().length, 0);
  assert.ok(C.get('6281500001'));
  assert.equal(r.audits[0].action, 'lead.delete');
});

test('block/unblock: agent ditolak 403; admin memblokir, lead tersembunyi dari daftar dan statistik, lalu dibuka', async () => {
  reset();
  const l = mk({ phone: '6281600001', name: 'Blokir Aku' });
  for (const a of ['block', 'unblock']) {
    const r = await call('POST', `/api/leads/${l.id}/${a}`, { user: AGENT });
    assert.equal(r.status, 403);
  }
  assert.equal(store.all()[0].blocked, undefined);
  let r = await call('POST', `/api/leads/${l.id}/block`);
  assert.equal(r.status, 200); assert.equal(r.json.lead.blocked, true);
  assert.equal(L.isBlocked({ phone: '6281600001' }), true);
  assert.equal(store.all().length, 1); // lead tetap ada
  assert.equal((await call('GET', '/api/leads')).json.total, 0);
  assert.equal((await call('GET', '/api/leads?blocked=1')).json.total, 1);
  assert.equal((await call('GET', '/api/leads/stats?period=year')).json.total, 0);
  r = await call('POST', `/api/leads/${l.id}/unblock`);
  assert.equal(r.json.lead.blocked, false);
  assert.equal(L.isBlocked({ phone: '6281600001' }), false);
  assert.equal((await call('GET', '/api/leads')).json.total, 1);
});

test('from-conversation: 404 tanpa percakapan, 400 nomor salah, 201 baru, 200 existed', async () => {
  reset();
  assert.equal((await call('POST', '/api/leads/from-conversation', { body: { phone: 'abc' } })).status, 400);
  assert.equal((await call('POST', '/api/leads/from-conversation', { body: { phone: '6289999999' } })).status, 404);
  const { conv } = C.getOrCreate('6281700001', 'j', 'Dari Chat');
  C.addMessage(conv, 'customer', 'Halo, lihat iklan instagram, berapa harga?', 5000);
  C.addMessage(conv, 'bot', 'Halo!', 6000);
  C.addMessage(conv, 'customer', 'Lutut sakit', 7000);
  conv.data = { nama: 'Dari Chat' };
  let r = await call('POST', '/api/leads/from-conversation', { body: { phone: '6281700001' } });
  assert.equal(r.status, 201); assert.equal(r.json.existed, false);
  assert.equal(r.json.lead.phone, '6281700001'); assert.equal(r.json.lead.data.nama, 'Dari Chat');
  assert.equal(store.all().length, 1);
  assert.equal(r.audits[0].action, 'lead.create');
  r = await call('POST', '/api/leads/from-conversation', { body: { phone: '6281700001' } });
  assert.equal(r.status, 200); assert.equal(r.json.existed, true);
  assert.equal(store.all().length, 1);
});

test('catatan: tambah, batas 1000 karakter dan 200 catatan, hak hapus penulis atau admin', async () => {
  reset();
  const l = mk();
  assert.equal((await call('POST', `/api/leads/${l.id}/notes`, { body: { text: '   ' } })).status, 400);
  assert.equal((await call('POST', `/api/leads/${l.id}/notes`, { body: { text: 'x'.repeat(1001) } })).status, 400);
  let r = await call('POST', `/api/leads/${l.id}/notes`, { body: { text: ' Halo ' }, user: AGENT });
  assert.equal(r.status, 201);
  assert.equal(r.json.note.text, 'Halo'); assert.equal(r.json.note.by, 'Budi'); assert.ok(r.json.note.id && r.json.note.ts);
  const nid = r.json.note.id;
  // bukan penulis dan bukan admin
  const other = { name: 'Sari', role: 'agent' };
  assert.equal((await call('DELETE', `/api/leads/${l.id}/notes/${nid}`, { user: other })).status, 403);
  assert.equal((await call('DELETE', `/api/leads/${l.id}/notes/nope`, { user: other })).status, 404);
  assert.equal((await call('DELETE', `/api/leads/${l.id}/notes/${nid}`, { user: AGENT })).status, 200); // penulis
  r = await call('POST', `/api/leads/${l.id}/notes`, { body: { text: 'dari agent' }, user: AGENT });
  assert.equal((await call('DELETE', `/api/leads/${l.id}/notes/${r.json.note.id}`)).status, 200); // admin
  // batas 200
  store.update(l.id, { notes: Array.from({ length: 200 }, (_, i) => ({ id: 'n' + i, by: 'Rina', text: 't', ts: i })) });
  assert.equal((await call('POST', `/api/leads/${l.id}/notes`, { body: { text: 'ke-201' } })).status, 400);
  assert.equal((await call('GET', `/api/leads/${l.id}`)).json.lead.notes.length, 200);
});

test('followup: validasi format dan tanggal nyata, batas catatan, hapus dengan null', async () => {
  reset();
  const l = mk();
  const put = (body) => call('PUT', `/api/leads/${l.id}/followup`, { body });
  assert.equal((await put({ date: '01-04-2026' })).status, 400);
  assert.equal((await put({ date: '2026-02-30' })).status, 400);
  assert.equal((await put({ date: 20260401 })).status, 400);
  assert.equal((await put({ note: 'tanpa date' })).status, 400);
  assert.equal((await put({ date: '2026-04-01', note: 'x'.repeat(301) })).status, 400);
  let r = await put({ date: '2026-04-01', note: ' telepon ' });
  assert.equal(r.status, 200); assert.equal(r.json.lead.followUpDate, '2026-04-01'); assert.equal(r.json.lead.followUpNote, 'telepon');
  assert.equal(r.json.lead.followUpOverdue, true);
  r = await put({ date: null, note: 'diabaikan' });
  assert.equal(r.json.lead.followUpDate, null); assert.equal(r.json.lead.followUpNote, '');
  assert.equal((await call('PATCH', `/api/leads/${l.id}/followup`, { body: {} })).status, 405);
});

test('transaction-done: menutup siklus terbuka; tanpa siklus terbuka 400', async () => {
  reset();
  const l = mk({ transactionCycles: [{ id: 'c1', startedAt: 1, lastSignalAt: 2, signals: ['transfer'], settledAt: null, doneAt: null }] });
  const r = await call('POST', `/api/leads/${l.id}/transaction-done`, { user: AGENT });
  assert.equal(r.status, 200);
  assert.ok(r.json.lead.transactionCycles[0].doneAt > 0);
  assert.equal((await call('POST', `/api/leads/${l.id}/transaction-done`)).status, 400);
  assert.equal(r.audits[0].action, 'lead.transaction-done');
});

test('routing: /stats, /export.csv, /from-conversation tidak tertangkap pola :id', async () => {
  reset();
  const l = mk();
  let r = await call('GET', '/api/leads/stats');
  assert.equal(r.status, 200); assert.equal(r.json.period, 'day'); assert.ok(!('lead' in r.json));
  r = await call('GET', '/api/leads/export.csv');
  assert.equal(r.status, 200); assert.match(r.headers['Content-Type'], /text\/csv/);
  assert.equal((await call('GET', '/api/leads/from-conversation')).status, 405); // bukan 404 "Lead tidak ditemukan"
  assert.equal((await call('DELETE', '/api/leads/stats')).status, 405); // tidak menghapus lead bernama "stats"
  assert.equal((await call('POST', '/api/leads/stats', { user: AGENT })).status, 405);
  // di luar wilayah modul
  assert.equal((await call('GET', '/api/conversations')).handled, false);
  assert.equal((await call('GET', '/api/leadsx')).handled, false);
  assert.equal((await call('GET', '/api/leads/a/b/c')).handled, false);
  // detail
  assert.equal((await call('GET', '/api/leads/' + l.id)).status, 200);
  assert.equal((await call('GET', '/api/leads/tidak-ada')).json.error, 'Lead tidak ditemukan');
});

// ---------- tahap Hot Lead + kirim ke Acesio ----------
const { createServer } = await import('node:http');
async function fakeAcesio(handler, delayMs = 0) {
  const seen = [];
  const srv = createServer((rq, rs) => {
    let b = '';
    rq.on('data', (c) => { b += c; });
    rq.on('end', () => {
      seen.push({ url: rq.url, key: rq.headers['x-api-key'], cid: rq.headers['x-correlation-id'], body: b ? JSON.parse(b) : null });
      const [code, out] = handler(seen.length);
      setTimeout(() => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(out)); }, delayMs);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

test('hotStage: lead Hot baru berawal Follow Up; PATCH memvalidasi tahap', async () => {
  reset();
  const l = mk({ status: 'Hot Leads', hotStage: 'Follow Up' });
  let r = await call('PATCH', '/api/leads/' + l.id, { body: { hotStage: 'Negosiasi / Kirim Rekening' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.lead.hotStage, 'Negosiasi / Kirim Rekening');
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { hotStage: 'Menang' } })).status, 400);
  assert.equal((await call('GET', '/api/leads')).json.hotStages.join('|'), store.HOT_STAGES.join('|'));
});

test('send-to-acesio: hanya Hot + Won; sukses menyimpan status dan kunci dikirim', async () => {
  reset();
  const fa = await fakeAcesio(() => [201, { id: 'ac-1' }]);
  process.env.ACESIO_URL = fa.url + '/';
  process.env.ACESIO_BOT_KEY = 'kunci-uji';
  try {
    const cold = mk({ status: 'Warm Leads' });
    assert.equal((await call('POST', `/api/leads/${cold.id}/send-to-acesio`, { body: {} })).status, 400);
    const hot = mk({ status: 'Hot Leads', hotStage: 'Follow Up', name: 'Sari', referensi: 'Instagram', firstMessage: 'mau booking' });
    assert.equal((await call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} })).status, 400); // belum Won
    assert.equal((await call('GET', `/api/leads/${hot.id}/send-to-acesio`)).status, 405);
    await call('PATCH', '/api/leads/' + hot.id, { body: { hotStage: 'Won' } });
    const r = await call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.lead.acesioStatus, 'sent');
    assert.ok(r.json.lead.acesioSentAt > 0);
    assert.equal(fa.seen.length, 1);
    assert.equal(fa.seen[0].url, '/api/bot/incoming-leads');
    assert.equal(fa.seen[0].key, 'kunci-uji');
    assert.equal(fa.seen[0].body.wa_lead_id, hot.id);
    assert.equal(fa.seen[0].body.name, 'Sari');
    assert.equal(r.audits[0].action, 'lead.send_to_acesio');
  } finally { await fa.close(); delete process.env.ACESIO_URL; delete process.env.ACESIO_BOT_KEY; }
});

test('send-to-acesio: Acesio menolak (401) -> 502, bukan 401; lead tidak ditandai terkirim; server mati -> 502', async () => {
  reset();
  const fa = await fakeAcesio(() => [401, { error: 'API key salah' }]);
  process.env.ACESIO_URL = fa.url;
  process.env.ACESIO_BOT_KEY = 'kunci-uji';
  try {
    const hot = mk({ status: 'Hot Leads', hotStage: 'Won', referensi: 'Instagram' });
    const r = await call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /HTTP 401.*API key salah/);
    assert.notEqual(store.all().find((x) => x.id === hot.id).acesioStatus, 'sent');
    await fa.close();
    const r2 = await call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} });
    assert.equal(r2.status, 502);
    assert.match(r2.json.error, /Gagal menghubungi Acesio/);
  } finally { delete process.env.ACESIO_URL; delete process.env.ACESIO_BOT_KEY; }
});

// ---- Ketahanan integrasi Acesio (server Acesio PALSU lokal = simulasi, bukan Acesio nyata) ----
const withLogs = async (fn) => {
  const lines = []; const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { return [await fn(), lines]; } finally { console.log = orig; }
};
const ACE_ENV = ['ACESIO_URL', 'ACESIO_BOT_KEY', 'ACESIO_TIMEOUT_MS'];
const clearAce = () => ACE_ENV.forEach((k) => delete process.env[k]);

test('send-to-acesio: tanpa ACESIO_BOT_KEY -> 503 tegas, tidak ada panggilan keluar', async () => {
  reset();
  const fa = await fakeAcesio(() => [201, {}]);
  process.env.ACESIO_URL = fa.url; delete process.env.ACESIO_BOT_KEY; delete process.env.ACESIO_API_KEY; delete process.env.BOT_API_KEY;
  try {
    const hot = mk({ status: 'Hot Leads', hotStage: 'Won', referensi: 'Instagram' });
    const r = await call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /ACESIO_BOT_KEY/);
    assert.equal(fa.seen.length, 0);
  } finally { await fa.close(); clearAce(); }
});

test('send-to-acesio: X-Correlation-ID sama di header, respons, audit; log tanpa kunci/isi pesan', async () => {
  reset();
  const fa = await fakeAcesio(() => [201, { id: 'ac-9' }]);
  process.env.ACESIO_URL = fa.url; process.env.ACESIO_BOT_KEY = 'RAHASIA-KUNCI-123';
  try {
    const hot = mk({ status: 'Hot Leads', hotStage: 'Won', referensi: 'Instagram', phone: '628123456789', firstMessage: 'ISI-PESAN-RAHASIA' });
    const [r, logs] = await withLogs(() => call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} }));
    assert.equal(r.status, 200);
    assert.ok(r.json.cid);
    assert.equal(fa.seen[0].cid, r.json.cid);
    assert.equal(r.audits[0].detail?.cid ?? r.audits[0].cid ?? r.audits[0].meta?.cid, r.json.cid);
    const log = logs.filter((x) => x.startsWith('[acesio]')).join('\n');
    assert.match(log, new RegExp(r.json.cid));
    assert.doesNotMatch(log, /RAHASIA-KUNCI-123|ISI-PESAN-RAHASIA|628123456789/);
    assert.match(log, /\*+6789/);
  } finally { await fa.close(); clearAce(); }
});

test('send-to-acesio: timeout -> 502, lead tetap ada, status failed + alasan tersimpan', async () => {
  reset();
  const fa = await fakeAcesio(() => [201, {}], 3000);
  process.env.ACESIO_URL = fa.url; process.env.ACESIO_BOT_KEY = 'k'; process.env.ACESIO_TIMEOUT_MS = '1000';
  try {
    const hot = mk({ status: 'Hot Leads', hotStage: 'Won', referensi: 'Instagram', name: 'Sari' });
    const [r] = await withLogs(() => call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} }));
    assert.equal(r.status, 502);
    assert.match(r.json.error, /tidak merespons: timeout setelah 1000 ms/);
    const after = store.all().find((x) => x.id === hot.id);
    assert.equal(after.name, 'Sari');
    assert.equal(after.acesioStatus, 'failed');
    assert.match(after.acesioLastError, /timeout/);
    assert.equal(r.audits[0].action, 'lead.send_to_acesio_failed');
  } finally { await fa.close(); clearAce(); }
});

test('send-to-acesio: kirim bersamaan -> yang kedua 409, Acesio hanya dipanggil sekali', async () => {
  reset();
  const fa = await fakeAcesio(() => [201, {}], 300);
  process.env.ACESIO_URL = fa.url; process.env.ACESIO_BOT_KEY = 'k';
  try {
    const hot = mk({ status: 'Hot Leads', hotStage: 'Won', referensi: 'Instagram' });
    const [a, b] = await Promise.all([
      call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} }),
      call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(fa.seen.length, 1);
  } finally { await fa.close(); clearAce(); }
});

test('send-to-acesio: kirim ulang gagal tidak menurunkan status sent', async () => {
  reset();
  let n = 0;
  const fa = await fakeAcesio(() => (++n === 1 ? [201, {}] : [500, { error: 'boom' }]));
  process.env.ACESIO_URL = fa.url; process.env.ACESIO_BOT_KEY = 'k';
  try {
    const hot = mk({ status: 'Hot Leads', hotStage: 'Won', referensi: 'Instagram' });
    assert.equal((await call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} })).status, 200);
    const r2 = await call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} });
    assert.equal(r2.status, 502);
    const after = store.all().find((x) => x.id === hot.id);
    assert.equal(after.acesioStatus, 'sent');
    assert.match(after.acesioLastError, /HTTP 500/);
  } finally { await fa.close(); clearAce(); }
});

test('send-to-acesio: penyimpanan status gagal setelah Acesio menerima -> 200 + warning (bukan gagal palsu)', async () => {
  reset();
  const fa = await fakeAcesio(() => [201, { id: 'x' }]);
  process.env.ACESIO_URL = fa.url; process.env.ACESIO_BOT_KEY = 'k';
  try {
    const hot = mk({ status: 'Hot Leads', hotStage: 'Won', referensi: 'Instagram' });
    Object.freeze(store.all().find((x) => x.id === hot.id)); // simulasi: penyimpanan menolak tulis -> update() melempar
    const [r] = await withLogs(() => call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} }));
    assert.equal(r.status, 200);
    assert.match(r.json.warning, /gagal disimpan/);
    assert.equal(fa.seen.length, 1);
  } finally { await fa.close(); clearAce(); }
});

test('send-to-acesio: lead tanpa nomor telepon (hanya LID/BSUID) -> 400, tidak ada panggilan keluar', async () => {
  reset();
  const fa = await fakeAcesio(() => [201, {}]);
  process.env.ACESIO_URL = fa.url; process.env.ACESIO_BOT_KEY = 'k';
  try {
    const hot = mk({ status: 'Hot Leads', hotStage: 'Won', referensi: 'Instagram', phone: '', lid: 'US.1349120865' });
    const r = await call('POST', `/api/leads/${hot.id}/send-to-acesio`, { body: {} });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Nomor telepon customer belum diketahui/);
    assert.equal(fa.seen.length, 0);
  } finally { await fa.close(); clearAce(); }
});


// ---------- sesi C2: kesiapan data, payload baru, replayed, nama WhatsApp ----------
// Acesio PALSU. ASUMSI: server/incoming.js dan server/routes/bot.js asli TIDAK terlampir di sesi ini, jadi perilakunya
// ditiru dari apa yang terlihat di kode CRM dan kontrak sesi: kunci salah -> 401, field wajib kosong -> 400,
// wa_lead_id baru -> 201 {id}, wa_lead_id yang sudah ada -> 200 {id, replayed:true}. Normalisasi platform (mis. 'fb') TIDAK ditiru:
// itu urusan Acesio, CRM harus mengirim apa adanya. Ini simulasi, bukan bukti berhasil dengan Acesio nyata.
async function acesioDouble() {
  const ids = new Map();
  const known = new Set(); // wa_lead_id yang sudah ada di Acesio sebelum CRM mengirim
  let fa;
  fa = await fakeAcesio(() => {
    const rq = fa.seen.at(-1);
    if (rq.key !== 'kunci-uji') return [401, { error: 'API key salah' }];
    const b = rq.body || {};
    if (!b.name || !b.phone || !b.platform) return [400, { error: 'name, phone, platform wajib diisi' }];
    if (known.has(b.wa_lead_id) || ids.has(b.wa_lead_id)) return [200, { id: ids.get(b.wa_lead_id) || 'ac-lama', replayed: true }];
    const id = 'ac-' + (ids.size + 1);
    ids.set(b.wa_lead_id, id);
    return [201, { id }];
  });
  fa.known = known;
  return fa;
}
const withAce = async (fn) => {
  const fa = await acesioDouble();
  process.env.ACESIO_URL = fa.url; process.env.ACESIO_BOT_KEY = 'kunci-uji';
  try { await fn(fa); } finally { await fa.close(); clearAce(); }
};
const mkWon = (o = {}) => mk({ status: 'Hot Leads', hotStage: 'Won', name: 'Sari Dewi', referensi: 'Instagram', phone: '6281381688802', ...o });
const sendAce = (id) => call('POST', `/api/leads/${id}/send-to-acesio`, { body: {} });
const stored = (id) => store.all().find((x) => x.id === id);

test('acesioReadiness: eligible hanya Hot + Won; missing berurutan phone, referensi, name', () => {
  const full = { status: 'Hot Leads', hotStage: 'Won', phone: '6281381688802', referensi: 'Instagram', name: 'Sari' };
  assert.deepEqual(acesioReadiness(full), { eligible: true, ready: true, missing: [] });
  assert.deepEqual(acesioReadiness({ ...full, hotStage: 'Follow Up' }), { eligible: false, ready: false, missing: [] });
  assert.deepEqual(acesioReadiness({ ...full, status: 'Warm Leads' }), { eligible: false, ready: false, missing: [] });
  assert.deepEqual(acesioReadiness({ ...full, phone: null }).missing, ['phone']);
  assert.deepEqual(acesioReadiness({ ...full, phone: '' }).missing, ['phone']);
  assert.deepEqual(acesioReadiness({ ...full, phone: 'tidak ada angka' }).missing, ['phone']); // tanpa angka
  const { phone: _p, ...tanpaPhone } = full;
  assert.deepEqual(acesioReadiness(tanpaPhone).missing, ['phone']);
  assert.deepEqual(acesioReadiness({ ...full, referensi: '  ' }).missing, ['referensi']);
  for (const name of [undefined, null, '', ' ', 'Tanpa Nama', 'tanpa nama', 'A', ' B ']) {
    assert.deepEqual(acesioReadiness({ ...full, name }).missing, ['name'], String(name));
  }
  assert.equal(acesioReadiness({ ...full, name: 'Al' }).ready, true); // 2 karakter cukup
  const none = acesioReadiness({ status: 'Hot Leads', hotStage: 'Won' });
  assert.deepEqual(none, { eligible: true, ready: false, missing: ['phone', 'referensi', 'name'] });
  assert.deepEqual(acesioReadiness(null), { eligible: false, ready: false, missing: ['phone', 'referensi', 'name'] });
});

test('acesioReadiness ikut di detail dan daftar lead', async () => {
  reset();
  const ok = mkWon();
  const lid = mkWon({ phone: '', lid: 'US.1349120865', referensi: '' });
  const cold = mk({ status: 'Cold Leads' });
  const d = (await call('GET', '/api/leads/' + ok.id)).json.lead;
  assert.deepEqual(d.acesioReadiness, { eligible: true, ready: true, missing: [] });
  const list = (await call('GET', '/api/leads')).json.leads;
  const by = (id) => list.find((x) => x.id === id).acesioReadiness;
  assert.equal(by(ok.id).ready, true);
  assert.deepEqual(by(lid.id).missing, ['phone', 'referensi']);
  assert.equal(by(cold.id).eligible, false);
});

test('send-to-acesio: kurang nama -> 400 dengan daftar missing, tidak ada panggilan keluar', async () => {
  reset();
  await withAce(async (fa) => {
    for (const name of ['', 'Tanpa Nama', 'A']) {
      const l = mkWon({ name });
      const r = await sendAce(l.id);
      assert.equal(r.status, 400, name);
      assert.deepEqual(r.json.missing, ['name']);
      assert.match(r.json.error, /Nama customer belum diisi/);
      assert.notEqual(stored(l.id).acesioStatus, 'sent');
    }
    assert.equal(fa.seen.length, 0);
  });
});

test('send-to-acesio: kurang referensi -> 400 missing referensi', async () => {
  reset();
  await withAce(async (fa) => {
    for (const referensi of ['', '   ', undefined]) {
      const l = mkWon({ referensi });
      const r = await sendAce(l.id);
      assert.equal(r.status, 400);
      assert.deepEqual(r.json.missing, ['referensi']);
      assert.match(r.json.error, /Referensi.*belum diisi/);
    }
    assert.equal(fa.seen.length, 0);
  });
});

test('send-to-acesio: kurang nomor (hanya LID) -> 400 missing phone; semua kurang -> ketiganya terdaftar', async () => {
  reset();
  await withAce(async (fa) => {
    const lid = mkWon({ phone: '', lid: 'US.1349120865' });
    const r = await sendAce(lid.id);
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.missing, ['phone']);
    assert.match(r.json.error, /Nomor telepon customer belum diketahui/);
    const semua = mkWon({ phone: null, lid: 'US.2', referensi: '', name: 'Tanpa Nama' });
    const r2 = await sendAce(semua.id);
    assert.equal(r2.status, 400);
    assert.deepEqual(r2.json.missing, ['phone', 'referensi', 'name']);
    assert.match(r2.json.error, /Nomor telepon.*Referensi.*Nama/);
    assert.equal(fa.seen.length, 0);
  });
});

test('send-to-acesio: belum Won / bukan Hot tetap 400 tanpa daftar missing', async () => {
  reset();
  await withAce(async (fa) => {
    const a = await sendAce(mkWon({ hotStage: 'Follow Up' }).id);
    assert.equal(a.status, 400);
    assert.match(a.json.error, /Won/);
    const b = await sendAce(mkWon({ status: 'Warm Leads', hotStage: null }).id);
    assert.equal(b.status, 400);
    assert.match(b.json.error, /Hot Leads/);
    assert.equal(fa.seen.length, 0);
  });
});

test('send-to-acesio: lengkap -> 200 dan payload.platform == referensi (bukan sumber lead)', async () => {
  reset();
  await withAce(async (fa) => {
    const l = mkWon({ platform: 'TikTok', keyword: 'harga, booking', firstMessage: 'mau booking', followUpNote: 'telepon besok', data: { keluhan: 'pinggang' } });
    const r = await sendAce(l.id);
    assert.equal(r.status, 200);
    assert.equal(r.json.replayed, undefined);
    assert.equal(r.json.message, 'Data customer berhasil dikirim ke Acesio');
    assert.equal(r.json.lead.acesioStatus, 'sent');
    assert.equal(r.json.lead.acesioReplayed, false);
    assert.ok(r.json.lead.acesioSentAt > 0);
    assert.equal(fa.seen.length, 1);
    const b = fa.seen[0].body;
    assert.equal(b.platform, 'Instagram'); // dari referensi, bukan 'TikTok'
    assert.equal(b.name, 'Sari Dewi');
    assert.equal(b.phone, '6281381688802');
    assert.equal(b.keyword, 'harga, booking');
    assert.equal(b.wa_lead_id, l.id);
    assert.equal(b.note, '[Follow-up] telepon besok\n[Pesan Awal] mau booking');
    assert.deepEqual(b.data, { keluhan: 'pinggang' });
    assert.deepEqual(Object.keys(b).sort(), ['data', 'keyword', 'name', 'note', 'phone', 'platform', 'wa_lead_id']);
  });
});

test('send-to-acesio: singkatan "fb" dikirim apa adanya; referensi >50 dan keyword >100 dipotong', async () => {
  reset();
  await withAce(async (fa) => {
    const a = mkWon({ referensi: 'fb' });
    assert.equal((await sendAce(a.id)).status, 200);
    assert.equal(fa.seen[0].body.platform, 'fb'); // normalisasi urusan Acesio
    const panjang = mkWon({ phone: '6281381688803', referensi: 'r'.repeat(80), keyword: 'k'.repeat(150) });
    assert.equal((await sendAce(panjang.id)).status, 200);
    assert.equal(fa.seen[1].body.platform.length, 50);
    assert.equal(fa.seen[1].body.keyword.length, 100);
  });
});

test('send-to-acesio: nomor dikirim dalam bentuk kanonik (angka saja)', async () => {
  reset();
  await withAce(async (fa) => {
    const l = mkWon({ phone: '+62 813-8168-8802' });
    assert.equal((await sendAce(l.id)).status, 200);
    assert.equal(fa.seen[0].body.phone, '6281381688802');
  });
});

test('send-to-acesio: Acesio replayed:true -> status sent + acesioReplayed, bukan pengiriman baru', async () => {
  reset();
  await withAce(async (fa) => {
    const l = mkWon();
    fa.known.add(l.id); // sudah ada di Acesio sebelum CRM mengirim
    const [r, logs] = await withLogs(() => sendAce(l.id));
    assert.equal(r.status, 200);
    assert.equal(r.json.replayed, true);
    assert.equal(r.json.message, 'Sudah ada di Acesio (tidak diperbarui)');
    assert.equal(r.json.lead.acesioStatus, 'sent');
    assert.equal(r.json.lead.acesioReplayed, true);
    assert.ok(!r.json.lead.acesioSentAt, 'replayed tidak dihitung waktu kirim baru');
    assert.equal(r.audits[0].action, 'lead.send_to_acesio');
    assert.equal(r.audits[0].detail.replayed, true);
    assert.match(logs.filter((x) => x.startsWith('[acesio]')).join('\n'), /"replayed":true/);
  });
});

test('send-to-acesio: kirim ulang lead yang sudah terkirim oleh CRM -> replayed, tetapi bukan "sudah ada sebelumnya"', async () => {
  reset();
  await withAce(async () => {
    const l = mkWon();
    const r1 = await sendAce(l.id);
    assert.equal(r1.status, 200);
    const sentAt = stored(l.id).acesioSentAt;
    assert.ok(sentAt > 0);
    const r2 = await sendAce(l.id);
    assert.equal(r2.status, 200);
    assert.equal(r2.json.replayed, true);
    assert.equal(r2.json.message, 'Sudah ada di Acesio (tidak diperbarui)');
    assert.equal(stored(l.id).acesioSentAt, sentAt); // waktu kirim pertama dipertahankan
    assert.equal(stored(l.id).acesioReplayed, false); // CRM-lah yang mengirim pertama kali
  });
});

test('send-to-acesio: kunci/isi pesan tidak bocor ke log pada alur baru', async () => {
  reset();
  await withAce(async () => {
    const l = mkWon({ firstMessage: 'ISI-PESAN-RAHASIA', phone: '6281381688802' });
    const [r, logs] = await withLogs(() => sendAce(l.id));
    assert.equal(r.status, 200);
    const log = logs.filter((x) => x.startsWith('[acesio]')).join('\n');
    assert.doesNotMatch(log, /kunci-uji|ISI-PESAN-RAHASIA|6281381688802/);
    assert.match(log, /\*+8802/);
  });
});

test('PATCH hotStage Won: nama kosong / "Tanpa Nama" diisi dari waName; tidak menimpa nama yang ada', async () => {
  reset();
  const kosong = mk({ status: 'Hot Leads', hotStage: 'Follow Up', name: '', waName: 'Rina Putri' });
  const r = await call('PATCH', '/api/leads/' + kosong.id, { body: { hotStage: 'Won' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.lead.name, 'Rina Putri');
  assert.equal(r.json.lead.hotStage, 'Won');
  assert.ok(r.audits[0].detail.fields.includes('name'));

  const placeholder = mk({ status: 'Hot Leads', hotStage: 'Follow Up', name: 'Tanpa Nama', waName: 'Dewi' });
  assert.equal((await call('PATCH', '/api/leads/' + placeholder.id, { body: { hotStage: 'Won' } })).json.lead.name, 'Dewi');

  const admin = mk({ status: 'Hot Leads', hotStage: 'Follow Up', name: 'Bu Rina (VIP)', waName: 'Rina' });
  assert.equal((await call('PATCH', '/api/leads/' + admin.id, { body: { hotStage: 'Won' } })).json.lead.name, 'Bu Rina (VIP)');

  const eksplisit = mk({ status: 'Hot Leads', hotStage: 'Follow Up', name: '', waName: 'Rina' });
  const e = await call('PATCH', '/api/leads/' + eksplisit.id, { body: { hotStage: 'Won', name: 'Nama Admin' } });
  assert.equal(e.json.lead.name, 'Nama Admin'); // edit admin pada permintaan yang sama menang
  assert.equal(e.audits[0].detail.fields.filter((f) => f === 'name').length, 1);

  const tanpaWa = mk({ status: 'Hot Leads', hotStage: 'Follow Up', name: '' });
  assert.equal((await call('PATCH', '/api/leads/' + tanpaWa.id, { body: { hotStage: 'Won' } })).json.lead.name, '');

  const bukanWon = mk({ status: 'Hot Leads', hotStage: 'Follow Up', name: '', waName: 'Rina' });
  assert.equal((await call('PATCH', '/api/leads/' + bukanWon.id, { body: { hotStage: 'Negosiasi / Kirim Rekening' } })).json.lead.name, '');
});

test('PATCH referensi: teks, dirapikan, maksimal 50 karakter; boleh dikosongkan', async () => {
  reset();
  const l = mk({ status: 'Hot Leads', hotStage: 'Won' });
  const ok = await call('PATCH', '/api/leads/' + l.id, { body: { referensi: '  teman \n  kantor  ' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.lead.referensi, 'teman kantor');
  assert.deepEqual(ok.audits[0].detail.fields, ['referensi']);
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { referensi: 'x'.repeat(50) } })).status, 200);
  const long = await call('PATCH', '/api/leads/' + l.id, { body: { referensi: 'x'.repeat(51) } });
  assert.equal(long.status, 400);
  assert.match(long.json.error, /maksimal 50/);
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { referensi: 123 } })).status, 400);
  assert.equal(stored(l.id).referensi, 'x'.repeat(50)); // permintaan gagal tidak mengubah apa pun
  assert.equal((await call('PATCH', '/api/leads/' + l.id, { body: { referensi: '' } })).json.lead.referensi, '');
});

test('PATCH name: admin boleh mengubah; lalu lead siap dikirim', async () => {
  reset();
  const l = mkWon({ name: 'Tanpa Nama' });
  assert.deepEqual((await call('GET', '/api/leads/' + l.id)).json.lead.acesioReadiness.missing, ['name']);
  const r = await call('PATCH', '/api/leads/' + l.id, { body: { name: '  Sari Dewi ' } });
  assert.equal(r.json.lead.name, 'Sari Dewi');
  assert.equal(r.json.lead.acesioReadiness.ready, true);
});

test('PATCH phone: divalidasi (canonical), duplikat ditolak, lead LID jadi siap kirim', async () => {
  reset();
  const lid = mkWon({ phone: '', lid: 'US.1349120865' });
  assert.deepEqual((await call('GET', '/api/leads/' + lid.id)).json.lead.acesioReadiness.missing, ['phone']);
  for (const [input, want] of [['0813-8168-8802', '6281381688802'], ['+62 813 8168 8802', '6281381688802'], [6281381688802, '6281381688802'], ['0062 813 8168 8802', '6281381688802'], ['62081381688802', '6281381688802']]) {
    const r = await call('PATCH', '/api/leads/' + lid.id, { body: { phone: input } });
    assert.equal(r.status, 200, String(input));
    assert.equal(r.json.lead.phone, want);
  }
  assert.equal((await call('GET', '/api/leads/' + lid.id)).json.lead.acesioReadiness.ready, true);
  assert.equal(stored(lid.id).lid, 'US.1349120865'); // LID tidak hilang
  for (const bad of ['abc', '', '12345', '1'.repeat(16), null, {}, []]) {
    const r = await call('PATCH', '/api/leads/' + lid.id, { body: { phone: bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(stored(lid.id).phone, '6281381688802');
  const lain = mk({ phone: '6281399990000' });
  const dup = await call('PATCH', '/api/leads/' + lain.id, { body: { phone: '081381688802' } });
  assert.equal(dup.status, 409);
  assert.match(dup.json.error, /sudah dipakai/);
  assert.equal(stored(lain.id).phone, '6281399990000');
  assert.equal((await call('PATCH', '/api/leads/' + lid.id, { body: { phone: '0813-8168-8802' } })).status, 200); // nomor sendiri bukan duplikat
});
