// Data booking dari Acesio (lewat kunci API): daftar layanan, slot jadwal per tanggal, status pengajuan.
// Semua fungsi tidak melempar galat: Acesio mati/tidak dikonfigurasi -> null (pemanggil memutuskan cadangan).
import { getLink } from './acesio-link.js';

async function get(path, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const { url, key } = getLink();
  if (!key) return null;
  try {
    const r = await fetchImpl(`${url}${path}`, { headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Nama layanan aktif, atau null bila Acesio tidak terjangkau. */
export async function fetchServices(opts) {
  const j = await get('/api/bot/services', opts);
  if (!j || !Array.isArray(j.services)) return null;
  return j.services.map((s) => String(s?.name ?? '').trim()).filter(Boolean);
}

/** Slot satu tanggal: { supported, step_minutes, slots:[{time,available}] } atau null. */
export async function fetchSlots(day, opts) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return null;
  const j = await get(`/api/bot/slots?date=${day}`, opts);
  if (!j || j.supported !== true || !Array.isArray(j.slots)) return null;
  return { day, step: Number(j.step_minutes) || 60, slots: j.slots.map((s) => ({ time: String(s.time), available: s.available === true })) };
}

/** Status pengajuan: { [wa_lead_id]: {status, rejection_reason, schedule} } atau null. Maksimal 50 id per panggilan. */
export async function fetchStatuses(ids, opts) {
  const list = [...new Set(ids)].slice(0, 50);
  if (!list.length) return {};
  const j = await get(`/api/bot/incoming-leads/status?ids=${list.map(encodeURIComponent).join(',')}`, opts);
  if (!j) return null;
  const arr = Array.isArray(j.items) ? j.items : Array.isArray(j.leads) ? j.leads : null;
  if (arr) return Object.fromEntries(arr.map((x) => [String(x.wa_lead_id ?? x.id), x]));
  return j && typeof j === 'object' && j.statuses ? j.statuses : null;
}
