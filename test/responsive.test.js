/* global document, location */
// F-15/F-16 di browser sungguhan: menu Integrasi per peran, navigasi, dan tata letak di breakpoint penting.
// Memakai Playwright bila terpasang di mesin ini (tidak jadi dependensi proyek); bila tidak ada, tes dilewati.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, Client } from './helpers/server.js';

let pw = null;
try { pw = createRequire(import.meta.url)('playwright'); } catch { /* tidak terpasang */ }

const SIZES = [320, 360, 390, 430, 767, 768, 899, 900, 1024, 1366];
let srv, browser, skip = !pw;

before(async () => {
  if (skip) return;
  try { browser = await pw.chromium.launch(); } catch { skip = true; return; }
  srv = await startServer({ env: { CONNECT_DRY_RUN: '1', CLIENT_ID: 'klinik-uji' } });
  const admin = new Client(srv.base);
  await admin.login();
  await admin.get('/api/me');
  await admin.post('/api/users', { name: 'agen1', password: 'sandi-agen-12345', role: 'agent' });
  const key = (await admin.post('/api/integrations/keys', { name: 'Seed', app: 'booking', scopes: ['messages:send'] })).json.token;
  for (let i = 0; i < 6; i++) {
    await fetch(srv.base + '/api/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'idempotency-key': `seed-responsif-${i}-ok` },
      body: JSON.stringify({ phone: '08120000' + (2000 + i), name: i ? `Pelanggan ${i}` : 'Pelanggan Dengan Nama Sangat Panjang Sekali Untuk Menguji Overflow Horizontal', text: 'Halo kak, mau tanya paket dan jadwal terapi minggu depan ' + 'x'.repeat(i ? 5 : 150) }),
    });
  }
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function open(width, user, pass) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 760 : 900 } });
  const page = await ctx.newPage();
  await page.goto(srv.base + '/login');
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button[type=submit]')]);
  await page.waitForFunction(() => document.querySelector('#me-name')?.textContent.trim().length > 1);
  return { ctx, page };
}
const visibleNav = (page) => page.evaluate(() => [...document.querySelectorAll('#nav a, #os-tabbar a')].filter((a) => a.offsetParent !== null).map((a) => a.dataset.r));

test('agent: menu Integrasi tidak ada di DOM (bukan sekadar disembunyikan) dan #/integrasi dialihkan ke CRM', async (t) => {
  if (skip) return t.skip('Playwright/Chromium tidak tersedia');
  for (const w of [390, 1366]) {
    const { ctx, page } = await open(w, 'agen1', 'sandi-agen-12345');
    assert.equal(await page.locator('a[data-r="/integrasi"]').count(), 0, `lebar ${w}`);
    assert.equal(await page.locator('[data-admin-only]').count(), 0);
    assert.deepEqual((await visibleNav(page)).sort(), ['/bot-tester', '/crm', '/pengaturan', '/percakapan', '/pesan']);
    await page.goto(srv.base + '/#/integrasi');
    await page.waitForFunction(() => location.hash === '#/crm');
    assert.equal(await page.locator('#view').getByText('Kunci API').count(), 0, 'isi halaman integrasi tidak dimuat');
    await ctx.close();
  }
});

test('admin: menu Integrasi tampil dan halamannya terbuka; navigasi antar halaman berjalan', async (t) => {
  if (skip) return t.skip('Playwright/Chromium tidak tersedia');
  for (const w of [390, 1366]) {
    const { ctx, page } = await open(w, 'admin', 'sandi-uji-12345');
    assert.ok((await visibleNav(page)).includes('/integrasi'), `lebar ${w}`);
    for (const r of ['pesan', 'percakapan', 'crm', 'bot-tester', 'integrasi', 'pengaturan']) {
      const link = page.locator(`${w < 900 ? '#os-tabbar' : '#nav'} a[data-r="/${r}"]`);
      await link.click();
      await page.waitForFunction((x) => location.hash === '#/' + x, r);
      await page.waitForFunction((x) => document.querySelector(`a[data-r="/${x}"][aria-current="page"]`) && document.querySelector('#view')?.getAttribute('aria-busy') !== 'true', r);
      assert.equal(await link.getAttribute('aria-current'), 'page', r);
    }
    assert.match(await page.locator('#view').innerText(), /Pengaturan/i);
    await ctx.close();
  }
});

for (const w of SIZES) {
  test(`layout ${w}px: tanpa overflow horizontal, menu terjangkau, chat sesuai mode (satu panel/dua kolom)`, async (t) => {
    if (skip) return t.skip('Playwright/Chromium tidak tersedia');
    const { ctx, page } = await open(w, 'admin', 'sandi-uji-12345');
    for (const r of ['crm', 'percakapan', 'pesan', 'pengaturan', 'integrasi']) {
      await page.goto(`${srv.base}/#/${r}`);
      await page.waitForFunction(() => document.querySelector('#view')?.getAttribute('aria-busy') !== 'true');
      await page.waitForTimeout(250);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(over <= 0, `${r} @${w}px overflow ${over}px`);
    }
    const tab = w <= 899;
    assert.equal(await page.locator('#os-tabbar').isVisible(), tab, 'tab bawah hanya ≤899px');
    if (!tab) {
      const fit = await page.evaluate(() => { const n = document.querySelector('#nav'); return n.scrollWidth <= n.clientWidth; });
      assert.ok(fit, 'semua menu header terlihat tanpa digeser');
    }

    await page.goto(`${srv.base}/#/percakapan`);
    await page.waitForSelector('.wa-item');
    const listVisible = () => page.locator('.wa-list').isVisible();
    const paneVisible = () => page.locator('#p-pane').isVisible();
    if (tab) {
      assert.ok(await listVisible() && !(await paneVisible()), 'ponsel: hanya daftar');
      await page.locator('.wa-item').first().click();
      await page.waitForSelector('#c-head');
      assert.ok(!(await listVisible()) && await paneVisible(), 'ponsel: hanya isi chat');
      const box = await page.locator('#c-foot').boundingBox();
      const vh = page.viewportSize().height;
      const tb = await page.locator('#os-tabbar').boundingBox();
      assert.ok(box && box.y + box.height <= tb.y + 1 && box.y >= 0 && box.x >= 0 && box.x + box.width <= w + 1, `kolom balas terlihat (di atas tab bawah, vh ${vh})`);
      await page.locator('.wa-back').click();
      assert.ok(await listVisible() && !(await paneVisible()), 'tombol kembali ke daftar');
    } else {
      assert.ok(await listVisible() && await paneVisible(), 'desktop: dua kolom');
      assert.equal(await page.locator('.wa-back').isVisible(), false);
    }
    await ctx.close();
  });
}