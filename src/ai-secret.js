// Kunci API penyedia AI. Sengaja TERPISAH dari pengaturan (settings.js): kunci tidak ada di S,
// tidak ikut riwayat versi, publicView, audit, maupun respons API ke browser.
// Disimpan lewat jsonfile.js: terenkripsi bila DATA_KEY aktif (tanpa DATA_KEY berupa berkas biasa
// dengan izin 0600), tulis atomik. Env AI_API_KEY dipakai sebagai cadangan bila tidak ada kunci tersimpan.
import fs from 'node:fs';
import path from 'node:path';
import { load, save, dataDir } from './jsonfile.js';

const FILE = 'ai-secret.json';
const KEY_MAX = 512;

const err = (code, message) => Object.assign(new Error(message), { code });

// Pesan galat dari jsonfile.js tidak memuat isi kunci; tetap dicatat sekali saja per pesan.
const logged = new Set();
function logOnce(e) {
  const msg = String(e?.message ?? 'galat tidak diketahui');
  if (logged.has(msg)) return;
  logged.add(msg);
  console.error(`[ai-secret] ${msg}`);
}

// Berkas .bak buatan jsonfile.js menyimpan salinan kunci SEBELUMNYA (teks biasa bila tanpa DATA_KEY).
// Dibuang setelah kunci diganti/dihapus supaya kunci lama tidak tertinggal di disk.
function purgeBackup() {
  try { fs.rmSync(path.join(dataDir(), `${FILE}.bak`), { force: true }); } catch { /* best-effort */ }
}

const fromEnv = () => String(process.env.AI_API_KEY ?? '').trim();

function readStored() {
  try {
    const d = load(FILE, {});
    return typeof d?.key === 'string' ? d.key.trim() : '';
  } catch (e) {
    logOnce(e); // mis. DATA_KEY salah/hilang: jatuh ke env, jangan menjatuhkan balasan bot
    return '';
  }
}

/** Kunci aktif: yang tersimpan, atau env AI_API_KEY bila tidak ada. '' bila keduanya kosong. */
export const getAiKey = () => readStored() || fromEnv();

/** Hanya boolean; aman dikirim ke browser. */
export const hasAiKey = () => getAiKey() !== '';

/** Simpan kunci. Lempar galat code 'VALIDATION' (pesan tanpa isi kunci) bila bentuknya tidak layak. */
export function setAiKey(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  // tanpa spasi/karakter kontrol: kunci penyedia tidak pernah memuatnya, dan ini mencegah salah tempel
  if (!k || k.length > KEY_MAX || /[\s\u0000-\u001f\u007f]/.test(k)) throw err('VALIDATION', 'Kunci API tidak valid.');
  save(FILE, { key: k, updatedAt: Date.now() });
  purgeBackup();
}

/** Hapus kunci tersimpan (kunci dari env AI_API_KEY tidak terpengaruh). */
export function clearAiKey() {
  try { fs.rmSync(path.join(dataDir(), FILE), { force: true }); } catch (e) { logOnce(e); }
  purgeBackup();
}
