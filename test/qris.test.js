import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qris-'));
const brand = await import('../src/brand.js');
const settings = await import('../src/settings.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test('QRIS: unggah PNG, muncul di status, bukan berkas publik, hapus', () => {
  assert.equal(brand.status().qris, null);
  const r = brand.saveAsset('qris', PNG);
  assert.equal(r.type, 'png');
  assert.equal(brand.status().qris.type, 'png');
  assert.equal(brand.status().limits.qrisKB, 2048);
  const res = { statusCode: 0, writeHead(c) { this.statusCode = c; }, setHeader() {}, end() {} };
  const handled = brand.servePublic({ method: 'GET', headers: {} }, res, '/brand/qris');
  assert.ok(!handled || res.statusCode === 404, '/brand/qris tidak dilayani publik');
  assert.throws(() => brand.saveAsset('qris', Buffer.from('bukan gambar')));
  brand.removeAsset('qris');
  assert.equal(brand.status().qris, null);
});

test('Pengaturan: info DP, rekening, jam pengingat dibersihkan; follow up DP hanya satu', () => {
  const s = settings.update({ crmAgent: { dpAmount: 'Rp 150.000', bankAccounts: 'BCA 111\nBRI 222', reminderH1Time: '25:00', reminderH0Time: '06:30', followUpDelaysMinutes: [60, 999], followUpMessages: ['a', 'b'], remindersEnabled: false } });
  const a = s.crmAgent;
  assert.equal(a.dpAmount, 'Rp 150.000'); assert.equal(a.bankAccounts, 'BCA 111\nBRI 222');
  assert.equal(a.reminderH1Time, '09:00', 'jam tidak valid kembali ke bawaan'); assert.equal(a.reminderH0Time, '06:30');
  assert.deepEqual(a.followUpDelaysMinutes, [60]); assert.deepEqual(a.followUpMessages, ['a']);
  assert.equal(a.remindersEnabled, false);
});
