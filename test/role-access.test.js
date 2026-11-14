// F-15: peran agent tidak boleh memakai fungsi Integrasi (kunci API, webhook, hubungkan Booking), baik lewat menu maupun
// dengan memanggil endpoint langsung. Admin tetap bisa. Penegakan ada di server (dispatcher + modul), bukan hanya di UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client } from './helpers/server.js';
import { adminOnly } from '../src/routes.js';

let srv, admin, agent, token;
before(async () => {
  srv = await startServer({ env: { CONNECT_DRY_RUN: '1', CLIENT_ID: 'klinik-uji' } });
  admin = new Client(srv.base);
  assert.equal((await admin.login()).status, 302);
  await admin.get('/api/me');
  assert.equal((await admin.post('/api/users', { name: 'agen1', password: 'sandi-agen-12345', role: 'agent' })).status, 201);
  agent = new Client(srv.base);
  assert.equal((await agent.login('agen1', 'sandi-agen-12345')).status, 302);
  assert.equal((await agent.get('/api/me')).json.role, 'agent');
  token = (await admin.post('/api/integrations/keys', { name: 'Uji', app: 'booking', scopes: ['leads:read'] })).json;
});
after(async () => { await srv?.stop(); });

test('kebijakan: semua jalur /api/integrations (semua metode, garis miring akhir) khusus admin', () => {
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const p of ['/api/integrations', '/api/integrations/', '/api/integrations/booking', '/api/integrations/keys', '/api/integrations/keys/abc',
      '/api/integrations/webhooks', '/api/integrations/webhooks/x/test', '/api/integrations/anything']) {
      assert.equal(adminOnly(m, p), true, `${m} ${p}`);
    }
  }
  assert.equal(adminOnly('GET', '/api/leads'), false);
  assert.equal(adminOnly('GET', '/api/conversations'), false);
});

test('agent memanggil endpoint integrasi langsung: semuanya 403 dan tidak ada efek', async () => {
  const calls = [
    ['GET', '/api/integrations'], ['GET', '/api/integrations/booking'], ['POST', '/api/integrations/booking', { bookingUrl: 'https://booking.example.com' }],
    ['DELETE', '/api/integrations/booking'], ['POST', '/api/integrations/keys', { name: 'x', app: 'booking', scopes: ['leads:read'] }],
    ['DELETE', `/api/integrations/keys/${token.key.id}`], ['POST', '/api/integrations/webhooks', { url: 'https://example.com/h', events: ['ping'] }],
    ['POST', '/api/integrations/webhooks/abc/test', {}], ['PATCH', '/api/integrations/webhooks/abc', { active: false }], ['DELETE', '/api/integrations/webhooks/abc'],
    ['GET', '/api/integrations/'], ['GET', '/api/integrations//'],
  ];
  for (const [m, p, body] of calls) {
    const r = await agent.req(m, p, body === undefined ? {} : { body });
    assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
    assert.ok(!/amk_|secret|webhook/i.test(r.text.replace(/Hanya admin/gi, '')), 'respons 403 tidak membocorkan data');
  }
  // kunci yang dibuat admin tetap ada (agent tidak bisa mencabutnya)
  const list = await admin.get('/api/integrations');
  assert.ok(list.json.keys.some((k) => k.id === token.key.id && !k.revokedAt));
});

test('agent tidak bisa lewat Basic auth maupun kunci API sebagai jalan pintas ke menu integrasi', async () => {
  const basic = new Client(srv.base, { mode: 'basic' });
  const r = await basic.req('GET', '/api/integrations', { headers: { Authorization: 'Basic ' + Buffer.from('agen1:sandi-agen-12345').toString('base64') } });
  assert.equal(r.status, 403);
  const withKey = await fetch(srv.base + '/api/integrations', { headers: { authorization: `Bearer ${token.token}` } });
  assert.notEqual(withKey.status, 200, 'kunci API aplikasi tidak membuka API dashboard');
});

test('admin tetap bisa memakai integrasi; agent tetap bisa fungsi harian (CRM, percakapan)', async () => {
  assert.equal((await admin.get('/api/integrations')).status, 200);
  assert.equal((await admin.get('/api/integrations/booking')).status, 200);
  assert.equal((await admin.post('/api/integrations/keys', { name: 'Admin', app: 'booking', scopes: ['leads:read'] })).status, 201);
  for (const p of ['/api/me', '/api/leads', '/api/conversations', '/api/settings']) assert.equal((await agent.get(p)).status, 200, p);
});

test('tanpa login: /api/integrations ditolak (bukan 200)', async () => {
  const r = await fetch(srv.base + '/api/integrations', { redirect: 'manual' });
  assert.notEqual(r.status, 200);
  assert.ok([302, 401, 403].includes(r.status), String(r.status));
});