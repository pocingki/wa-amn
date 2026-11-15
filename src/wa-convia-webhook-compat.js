// Pengarah webhook Convia: Format A (kunci "event", S2) atau Format B (kunci "eventType", S8).
// Format dipilih dari ISI body; tanda tangan diperiksa dengan header milik format itu saja.
// ASUMSI: nama header A = X-Webhook-Signature, B = X-Convia-Signature (case-insensitive).
import * as eventsB from './wa-convia-events.js';

// S2 dimuat dinamis agar modul ini tetap bisa dipakai (dan dites dengan formatA palsu) sebelum S2 digabung.
let defaultA = null;
try {
  defaultA = await import('./wa-convia-webhook.js');
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}

const HEADER = { A: 'x-webhook-signature', B: 'x-convia-signature' };

// Deteksi format: eventType -> B; event -> A; selain itu null.
function detect(rawBody) {
  let obj;
  try {
    obj = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    return { format: null, reason: 'JSON rusak' };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { format: null, reason: 'body bukan objek' };
  if ('eventType' in obj) return { format: 'B' };
  if ('event' in obj) return { format: 'A' };
  return { format: null, reason: 'format payload tidak dikenali' };
}

function headerValue(headers, name) {
  if (!headers) return '';
  let v;
  if (typeof headers.get === 'function') v = headers.get(name);
  else {
    const k = Object.keys(headers).find((x) => x.toLowerCase() === name);
    v = k === undefined ? undefined : headers[k];
  }
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' ? v : '';
}

export function createWebhookCompat({ formatA = defaultA, formatB = eventsB } = {}) {
  if (!formatA) throw new Error('formatA (src/wa-convia-webhook.js) tidak tersedia');
  const impl = { A: formatA, B: formatB };

  return {
    verifyRequest(rawBody, headers, secret) {
      const { format } = detect(rawBody);
      if (!format) return false;
      const sig = headerValue(headers, HEADER[format]);
      if (!sig) return false;
      return impl[format].verifySignature(rawBody, sig, secret) === true;
    },
    parseWebhook(rawBody) {
      const { format, reason } = detect(rawBody);
      if (!format) return { ok: false, reason };
      const res = impl[format].parseWebhook(rawBody);
      return res && res.ok ? { ...res, format } : res;
    },
    toEnvelope(parsed, opts) {
      const f = impl[parsed?.format];
      if (!f) return { skip: true, reason: 'format tidak diketahui' };
      return f.toEnvelope(parsed, opts);
    },
    toStatusUpdate(parsed) {
      const f = impl[parsed?.format];
      return f ? f.toStatusUpdate(parsed) : null;
    },
  };
}
