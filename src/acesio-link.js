// Sambungan ke Acesio (alamat + kunci) yang diisi dari dashboard, jadi tidak perlu membuka .env.
// Kunci disimpan lewat jsonfile.js (terenkripsi bila DATA_KEY aktif, jika tidak berkas 0600), TERPISAH dari pengaturan:
// tidak ikut riwayat versi, audit, atau respons API. Nilai .env (ACESIO_URL, ACESIO_BOT_KEY) tetap jadi cadangan.
import fs from 'node:fs';
import path from 'node:path';
import { load, save, dataDir } from './jsonfile.js';

const FILE = 'acesio-link.json';
const KEY_MAX = 512;
const DEFAULT_URL = 'http://127.0.0.1:3000';

const err = (code, message) => Object.assign(new Error(message), { code });
const envKey = () => String(process.env.ACESIO_BOT_KEY || process.env.ACESIO_API_KEY || process.env.BOT_API_KEY || '').trim();
const envUrl = () => String(process.env.ACESIO_URL || '').trim();

function readStored() {
  try {
    const d = load(FILE, {});
    return { url: typeof d?.url === 'string' ? d.url.trim() : '', key: typeof d?.key === 'string' ? d.key.trim() : '' };
  } catch (e) {
    console.error(`[acesio-link] ${String(e?.message ?? e)}`); // mis. DATA_KEY salah: jatuh ke .env
    return { url: '', key: '' };
  }
}

function purgeBackup() {
  try { fs.rmSync(path.join(dataDir(), `${FILE}.bak`), { force: true }); } catch { /* best-effort */ }
}

export function cleanUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { throw err('VALIDATION', 'Alamat Acesio tidak valid. Contoh: https://acesio.contoh.id'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw err('VALIDATION', 'Alamat Acesio harus berawalan http:// atau https:// dan tanpa nama pengguna/kata sandi.');
  return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}`;
}

/** { url, key } yang dipakai pengiriman: nilai dashboard didahulukan, lalu .env. */
export function getLink() {
  const st = readStored();
  return { url: (st.url || envUrl() || DEFAULT_URL).replace(/\/+$/, ''), key: st.key || envKey() };
}

/** Aman dikirim ke browser: tanpa kunci. */
export function publicView() {
  const st = readStored();
  const hasKey = !!(st.key || envKey());
  return { url: getLink().url, hasKey, keySource: st.key ? 'dashboard' : envKey() ? 'env' : 'none' };
}

/** Simpan alamat dan/atau kunci. key undefined = kunci tetap; '' tidak diterima (pakai clearKey). */
export function setLink({ url, key } = {}) {
  const st = readStored();
  const next = { url: st.url, key: st.key };
  if (url !== undefined) next.url = cleanUrl(url);
  if (key !== undefined) {
    const k = String(key).trim();
    if (!k || k.length > KEY_MAX || /[\s\u0000-\u001f\u007f]/.test(k)) throw err('VALIDATION', 'Kunci tidak valid. Tempel kunci dari menu Integrasi Acesio tanpa spasi.');
    next.key = k;
  }
  save(FILE, { ...next, updatedAt: Date.now() });
  purgeBackup();
}

export function clearKey() {
  const st = readStored();
  if (st.url) save(FILE, { url: st.url, key: '', updatedAt: Date.now() });
  else try { fs.rmSync(path.join(dataDir(), FILE), { force: true }); } catch { /* abaikan */ }
  purgeBackup();
}
