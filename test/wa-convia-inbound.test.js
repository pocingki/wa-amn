// Tes pipeline masuk Convia (S3). SEMUA tes memakai MOCK: tanpa jaringan, tanpa Convia nyata, tanpa WhatsApp.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createInbound } = await import('../src/wa-convia-inbound.js');

const NOW = 1_700_000_000_000;
const SECRET_TEXT = 'RAHASIA-ISI-PESAN-123';
const FULL_PHONE = '6281234567890';

const makeEnvelope = (o = {}) => ({
  waId: 'convia:wamid.1', jid: `${FULL_PHONE}@s.whatsapp.net`, phone: FULL_PHONE, lid: null, name: 'Budi', ts: NOW,
  kind: 'text', text: SECRET_TEXT, caption: '', mediaId: null, mediaError: null, fromMe: false, fromPhone: false,
  source: {}, provider: 'convia', mediaUrl: null, bsuid: null, identityUnresolved: false, ...o,
});

// Harness: semua dependensi palsu + catatan panggilan.
function harness(o = {}) {
  const seen = new Set();
  const calls = { handle: [], sent: [], emits: [], sleeps: [], saves: [], fetches: [] };
  const deps = {
    handleIncoming: o.handleIncoming || (async (env, send) => {
      calls.handle.push(env);
      await send(env.jid, 'balasan');
    }),
    saveMedia: o.saveMedia || (async (buf, meta) => { calls.saves.push({ buf, meta }); return { mediaId: 'm1' }; }),
    convs: {
      seenMessage: (id) => seen.has(id),
      markSeen: (id) => { seen.add(id); },
    },
    emit: (t, p) => { calls.emits.push([t, p]); },
    now: () => NOW,
    fetchImpl: o.fetchImpl || (async (url, init) => { calls.fetches.push({ url, init }); throw new Error('fetch tidak diharapkan'); }),
    retryDelaysMs: o.retryDelaysMs ?? [1000, 4000],
    sleep: async (ms) => { calls.sleeps.push(ms); },
    mediaTimeoutMs: o.mediaTimeoutMs ?? 20000,
    sendText: async (jid, text) => { calls.sent.push({ jid, text }); },
  };
  return { inbound: createInbound(deps), seen, calls, deps };
}

// Respons fetch palsu.
const okRes = (bytes = 'abc', type = 'image/jpeg; charset=x') => ({
  ok: true, status: 200,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
  arrayBuffer: async () => new TextEncoder().encode(bytes).buffer,
});

// Tangkap console.error supaya log bisa diperiksa dan tidak berisik.
function captureErrors(t) {
  const lines = [];
  t.mock.method(console, 'error', (...a) => { lines.push(a.map(String).join(' ')); });
  return lines;
}

test('MOCK sukses: diproses, ditandai seen, handleIncoming dipanggil sekali dengan sendText', async () => {
  const { inbound, seen, calls } = harness();
  assert.equal(await inbound.processEnvelope(makeEnvelope()), 'processed');
  assert.equal(calls.handle.length, 1);
  assert.equal(calls.handle[0].waId, 'convia:wamid.1');
  assert.equal(calls.handle[0].text, SECRET_TEXT);
  assert.equal(calls.sent.length, 1);
  assert.ok(seen.has('convia:wamid.1'));
});

test('MOCK duplikat berurutan: kedua kali -> duplicate tanpa memproses ulang', async () => {
  const { inbound, calls } = harness();
  assert.equal(await inbound.processEnvelope(makeEnvelope()), 'processed');
  assert.equal(await inbound.processEnvelope(makeEnvelope()), 'duplicate');
  assert.equal(calls.handle.length, 1);
  assert.equal(calls.sent.length, 1);
});

test('MOCK duplikat bersamaan: permintaan kedua saat inflight -> duplicate', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const handled = [];
  const { inbound, seen } = harness({
    handleIncoming: async (env) => { handled.push(env.waId); await gate; },
  });
  const first = inbound.processEnvelope(makeEnvelope());
  const second = inbound.processEnvelope(makeEnvelope());
  assert.equal(await second, 'duplicate');
  assert.ok(!seen.has('convia:wamid.1'), 'belum seen selagi pertama berjalan');
  release();
  assert.equal(await first, 'processed');
  assert.deepEqual(handled, ['convia:wamid.1']);
  assert.ok(seen.has('convia:wamid.1'));
});

test('MOCK gagal lalu sukses di retry: balasan tidak ganda, waId sama di tiap percobaan', async (t) => {
  captureErrors(t);
  let n = 0;
  const ids = [];
  const sent = [];
  const { inbound, seen, calls } = harness({
    handleIncoming: async (env, send) => {
      ids.push(env.waId);
      n += 1;
      if (n === 1) throw new Error('db sibuk'); // gagal sebelum membalas
      await send(env.jid, 'balasan');
      sent.push(1);
    },
  });
  assert.equal(await inbound.processEnvelope(makeEnvelope()), 'processed');
  assert.equal(n, 2);
  assert.deepEqual(ids, ['convia:wamid.1', 'convia:wamid.1']);
  assert.equal(calls.sent.length, 1, 'balasan hanya satu');
  assert.deepEqual(calls.sleeps, [1000]);
  assert.ok(seen.has('convia:wamid.1'));
  assert.equal(calls.emits.filter(([e]) => e === 'wa:process_failed').length, 0);
});

test('MOCK gagal permanen: tidak seen, emit process_failed sekali, bisa dicoba lagi setelahnya', async (t) => {
  captureErrors(t);
  let fail = true;
  let n = 0;
  const { inbound, seen, calls } = harness({
    handleIncoming: async () => { n += 1; if (fail) throw new Error('tetap gagal'); },
  });
  assert.equal(await inbound.processEnvelope(makeEnvelope()), 'failed');
  assert.equal(n, 3); // 1 + retryDelaysMs.length
  assert.deepEqual(calls.sleeps, [1000, 4000]);
  assert.ok(!seen.has('convia:wamid.1'));
  const failed = calls.emits.filter(([e]) => e === 'wa:process_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0][1].waId, 'convia:wamid.1');
  assert.match(failed[0][1].error, /tetap gagal/);

  // slot inflight terlepas: kiriman ulang dari Convia diproses lagi, bukan 'duplicate'
  fail = false;
  assert.equal(await inbound.processEnvelope(makeEnvelope()), 'processed');
  assert.ok(seen.has('convia:wamid.1'));
});

test('MOCK media: berhasil diunduh lalu disimpan; tanpa Authorization; mime dari content-type', async () => {
  const fetches = [];
  const { inbound, calls } = harness({
    fetchImpl: async (url, init) => { fetches.push({ url, init }); return okRes('abc'); },
  });
  const env = makeEnvelope({ kind: 'image', text: '', caption: 'foto', mediaUrl: 'https://media.example/x.jpg' });
  assert.equal(await inbound.processEnvelope(env), 'processed');
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].init.headers, undefined);
  assert.equal(calls.saves.length, 1);
  assert.equal(Buffer.isBuffer(calls.saves[0].buf), true);
  assert.equal(calls.saves[0].buf.toString(), 'abc');
  assert.equal(calls.saves[0].meta.mime, 'image/jpeg');
  assert.equal(calls.saves[0].meta.kind, 'image');
  assert.equal(calls.handle[0].mediaId, 'm1');
  assert.equal(calls.handle[0].mediaError, null);
  assert.equal(env.mediaId, null, 'envelope masukan tidak diubah');
});

test('MOCK media gagal (jaringan, HTTP 404, timeout, simpan gagal, URL tidak valid): pesan tetap diproses', async () => {
  const URL_SECRET = 'https://media.example/x.jpg?token=TOKEN-RAHASIA';
  const cases = [
    ['jaringan', { fetchImpl: async () => { throw new Error(`fetch gagal ${URL_SECRET}`); } }, URL_SECRET, /Unduh media gagal/],
    ['http', { fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }) }, URL_SECRET, /HTTP 404/],
    ['timeout', { fetchImpl: () => new Promise(() => {}), mediaTimeoutMs: 15 }, URL_SECRET, /batas waktu/],
    ['simpan', { fetchImpl: async () => okRes(), saveMedia: async () => { throw new Error('disk penuh'); } }, URL_SECRET, /Simpan media gagal: disk penuh/],
    ['url', { fetchImpl: async () => okRes() }, 'http://x', /URL media tidak valid/],
  ];
  for (const [nama, o, url, pola] of cases) {
    const { inbound, seen, calls } = harness(o);
    const env = makeEnvelope({ kind: 'image', text: '', mediaUrl: nama === 'url' ? 'http://insecure.example/x' : url });
    assert.equal(await inbound.processEnvelope(env), 'processed', nama);
    assert.equal(calls.handle.length, 1, nama);
    assert.equal(calls.handle[0].mediaId, null, nama);
    assert.match(calls.handle[0].mediaError, pola, nama);
    assert.ok(!String(calls.handle[0].mediaError).includes('TOKEN-RAHASIA'), `${nama}: URL tidak bocor ke mediaError`);
    assert.ok(seen.has('convia:wamid.1'), nama);
  }
});

test('MOCK media diunduh sekali walau proses di-retry', async (t) => {
  captureErrors(t);
  let n = 0;
  let fetchCount = 0;
  const { inbound, calls } = harness({
    fetchImpl: async () => { fetchCount += 1; return okRes(); },
    handleIncoming: async (env) => { n += 1; if (n < 3) throw new Error('gagal'); calls.handle.push(env); },
  });
  const env = makeEnvelope({ kind: 'image', text: '', mediaUrl: 'https://media.example/x.jpg' });
  assert.equal(await inbound.processEnvelope(env), 'processed');
  assert.equal(fetchCount, 1);
  assert.equal(calls.saves.length, 1);
});

test('MOCK identityUnresolved: diteruskan apa adanya (lid=BSUID, phone null) + emit tanpa isi pesan', async () => {
  const { inbound, calls } = harness();
  const env = makeEnvelope({
    jid: 'BSUID123@convia', phone: null, lid: 'BSUID123', bsuid: 'BSUID123', identityUnresolved: true,
  });
  assert.equal(await inbound.processEnvelope(env), 'processed');
  assert.equal(calls.handle.length, 1);
  assert.equal(calls.handle[0].phone, null);
  assert.equal(calls.handle[0].lid, 'BSUID123');
  assert.equal(calls.handle[0].jid, 'BSUID123@convia');
  assert.equal(calls.handle[0].text, SECRET_TEXT);
  const ev = calls.emits.filter(([e]) => e === 'wa:identity_unresolved');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0][1], { waId: 'convia:wamid.1' });
});

test('MOCK pesan fromMe kosong/reaction -> skipped; fromMe berisi tetap diproses; teks kosong -> skipped', async () => {
  const { inbound, calls, seen } = harness();
  assert.equal(await inbound.processEnvelope(makeEnvelope({ waId: 'convia:a', fromMe: true, fromPhone: true, text: '   ' })), 'skipped');
  assert.equal(await inbound.processEnvelope(makeEnvelope({ waId: 'convia:b', fromMe: true, kind: 'reaction', text: '👍' })), 'skipped');
  assert.equal(await inbound.processEnvelope(makeEnvelope({ waId: 'convia:c', text: '' })), 'skipped');
  assert.equal(calls.handle.length, 0);
  assert.equal(seen.size, 0);
  assert.equal(await inbound.processEnvelope(makeEnvelope({ waId: 'convia:d', fromMe: true, fromPhone: true, text: 'dibalas dari HP' })), 'processed');
  assert.equal(calls.handle.length, 1);
});

test('MOCK emit dan log tidak memuat isi pesan, nomor lengkap, atau URL media', async (t) => {
  const lines = captureErrors(t);
  const { inbound, calls } = harness({
    handleIncoming: async () => { throw new Error(`gagal untuk ${FULL_PHONE}`); },
  });
  const env = makeEnvelope({ identityUnresolved: true, bsuid: 'B1', lid: 'B1', phone: null });
  assert.equal(await inbound.processEnvelope(env), 'failed');
  const dump = JSON.stringify(calls.emits) + lines.join('\n');
  assert.ok(!dump.includes(SECRET_TEXT), 'isi pesan bocor');
  assert.ok(!dump.includes(FULL_PHONE), 'nomor lengkap bocor');
  assert.ok(!dump.includes('Budi'), 'nama bocor');
  const failed = calls.emits.find(([e]) => e === 'wa:process_failed');
  assert.match(failed[1].error, /\*\*\*7890/);
});

test('MOCK emit yang melempar tidak mengubah hasil; markSeen yang melempar tetap processed', async (t) => {
  captureErrors(t);
  const inbound = createInbound({
    handleIncoming: async () => {},
    saveMedia: async () => ({ mediaId: 'm' }),
    convs: { seenMessage: () => false, markSeen: () => { throw new Error('db'); } },
    emit: () => { throw new Error('emit rusak'); },
    sleep: async () => {},
  });
  assert.equal(await inbound.processEnvelope(makeEnvelope({ identityUnresolved: true, phone: null, lid: 'B' })), 'processed');
});

test('MOCK dependensi wajib dicek dan envelope tanpa waId -> skipped', async (t) => {
  captureErrors(t);
  assert.throws(() => createInbound({}), /handleIncoming/);
  const { inbound, calls } = harness();
  assert.equal(await inbound.processEnvelope(makeEnvelope({ waId: '' })), 'skipped');
  assert.equal(await inbound.processEnvelope(null), 'skipped');
  assert.equal(calls.handle.length, 0);
});
