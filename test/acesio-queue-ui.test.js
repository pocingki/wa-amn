/* global document */
// Kotak "Pengajuan ke Acesio" di browser sungguhan (Playwright; dilewati bila tidak ada). Respons API dipalsukan lewat page.route,
// jadi tes ini menguji tampilan dan tombol; logika server diuji di acesio-queue.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';

let pw = null;
try { pw = createRequire(import.meta.url)('playwright'); } catch { /* tidak terpasang */ }
let srv, browser, skip = !pw;

before(async () => {
  if (skip) return;
  try { browser = await pw.chromium.launch(); } catch { skip = true; return; }
  srv = await startServer({});
});
after(async () => { await browser?.close(); await srv?.stop(); });

const ITEMS = [
  { id: 'l1', name: 'Ayu Lestari', phone: '6281100001', referensi: 'Instagram', ready: true, missing: [], acesioStatus: null },
  { id: 'l2', name: 'Budi Santoso', phone: '6281100002', referensi: 'TikTok', ready: true, missing: [], acesioStatus: 'failed', acesioLastError: 'HTTP 500' },
  { id: 'l3', name: 'Cici', phone: '6281100003', referensi: '', ready: false, missing: ['Referensi'], acesioStatus: null },
];
const QUEUE = { items: ITEMS, configured: true, counts: { total: 3, ready: 2, incomplete: 1, failed: 1 } };

async function open(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(srv.base + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'sandi-uji-12345');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button[type=submit]')]);
  return { ctx, page };
}

for (const w of [390, 1366]) {
  test(`CRM @${w}px: kotak pengajuan menampilkan antrean, ajukan satu dan ajukan semua`, async (t) => {
    if (skip) return t.skip('Playwright/Chromium tidak tersedia');
    const { ctx, page } = await open(w);
    const calls = [];
    let queue = QUEUE;
    await page.route('**/api/leads/acesio/queue', (r) => r.fulfill({ json: queue }));
    await page.route('**/api/leads/acesio/submit-all', (r) => {
      calls.push('all');
      queue = { items: [ITEMS[2]], configured: true, counts: { total: 1, ready: 0, incomplete: 1, failed: 0 } };
      r.fulfill({ json: { ok: true, total: 2, sent: 2, replayed: 0, failed: 0, skippedIncomplete: 1, results: [], queue } });
    });
    await page.route('**/api/leads/l1/send-to-acesio', (r) => {
      calls.push('l1');
      queue = { items: ITEMS.slice(1), configured: true, counts: { total: 2, ready: 1, incomplete: 1, failed: 1 } };
      r.fulfill({ json: { ok: true, message: 'Data customer berhasil dikirim ke Acesio', lead: {} } });
    });
    await page.goto(srv.base + '/#/crm');
    await page.waitForSelector('#acs-body li');
    assert.equal(await page.locator('#acs-body li').count(), 3);
    assert.equal((await page.locator('#acs-all').innerText()).trim(), 'Ajukan semua (2)');
    assert.equal(await page.locator('#acs-all').isEnabled(), true);
    // lead lengkap bisa diajukan; yang kurang data tidak
    assert.equal(await page.locator('[data-acs-one="l3"]').isDisabled(), true);
    assert.equal(await page.locator('[data-acs-one="l1"]').isEnabled(), true);
    assert.match(await page.locator('#acs-body li').nth(1).innerText(), /Gagal diajukan: HTTP 500/);
    assert.match(await page.locator('#acs-body li').nth(1).innerText(), /Coba lagi/);
    assert.match(await page.locator('#acs-body li').nth(2).innerText(), /Data kurang: Referensi/);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `overflow ${over}px`);

    await page.locator('[data-acs-one="l1"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#acs-body li').length === 2);
    assert.deepEqual(calls, ['l1']);

    page.once('dialog', (d) => d.accept());
    await page.locator('#acs-all').click();
    await page.waitForFunction(() => document.querySelectorAll('#acs-body li').length === 1);
    assert.deepEqual(calls, ['l1', 'all']);
    assert.equal(await page.locator('#acs-all').isDisabled(), true, 'tidak ada yang siap lagi');
    await ctx.close();
  });
}
