// Ambil formulir data customer dari Acesio (lewat kunci API). Gagal/tidak dikonfigurasi -> formulir lengkap, bukan galat.
import { getLink } from './acesio-link.js';
import { FORM_IDS, FORBIDDEN } from './crm-form.js';

const ASKABLE = ['name', 'gender', 'birth_date', 'occupation', 'domicile'];

export async function fetchForm(phone, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const fallback = { ok: false, exists: false, values: {}, missing: [...ASKABLE] };
  const { url, key } = getLink();
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!key || !digits) return fallback;
  try {
    const r = await fetchImpl(`${url}/api/bot/customer-form?phone=${encodeURIComponent(digits)}`, {
      headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return fallback;
    const j = await r.json();
    // Hanya kolom yang boleh ditanyakan; kolom terlarang dibuang walau server mengirimnya.
    const missing = (Array.isArray(j.missing) ? j.missing : []).filter((id) => ASKABLE.includes(id) && FORM_IDS.includes(id) && !FORBIDDEN.includes(id));
    const values = {};
    for (const id of [...ASKABLE, 'reference']) if (typeof j.values?.[id] === 'string') values[id] = j.values[id];
    return { ok: true, exists: j.exists === true, values, missing };
  } catch {
    return fallback;
  }
}
