// /api/ai: pemakaian (admin + agent), uji koneksi (admin), kelola kunci API (admin).
// Kunci hanya masuk lewat PUT /api/ai/key dan TIDAK PERNAH dikembalikan: respons hanya { hasKey }.
// Modul kuota (B3) dan adaptor penyedia (B1) dimuat dengan impor dinamis + fallback aman bila belum ada,
// dan semua dependensi bisa disuntik lewat createHandler() supaya tes memakai mock (tanpa jaringan/DB nyata).
import * as settings from '../settings.js';
import * as secret from '../ai-secret.js';

const isObj = (b) => b && typeof b === 'object' && !Array.isArray(b);

// Pesan dari penyedia bisa mengutip kunci (utuh atau sebagian): buang sebelum dikirim ke browser.
const KEY_LIKE = /\b(?:sk-|AIza)[\w-]{6,}/g;
function scrub(text, key) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('[kunci]');
  return s.replace(KEY_LIKE, '[kunci]').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Modul B3/B1 belum tentu ada (sesi paralel): hilang -> null, galat lain dicatat tanpa isi apa pun dari permintaan.
const missing = (e) => e?.code === 'ERR_MODULE_NOT_FOUND';

async function defaultLoadQuota({ getSettings, now }) {
  try {
    const [q, d] = await Promise.all([import('../ai-quota.js'), import('../db.js')]);
    return typeof q.createQuota === 'function' ? q.createQuota({ getDb: d.getDb, now, getSettings }) : null;
  } catch (e) {
    if (!missing(e)) console.error(`[api/ai] modul kuota gagal dimuat: ${e.message}`);
    return null;
  }
}

async function defaultLoadProviders() {
  try {
    const m = await import('../ai-providers.js');
    return typeof m.testConnection === 'function' ? m : null;
  } catch (e) {
    if (!missing(e)) console.error(`[api/ai] modul penyedia AI gagal dimuat: ${e.message}`);
    return null;
  }
}

// Bentuk usage() bila B3 belum terpasang: semua nol, ditandai available:false (UI bisa menyembunyikan angka).
function emptyUsage(S) {
  const limit = S.ai.monthlyQuota;
  return { available: false, month: { used: 0, reserved: 0, limit, remaining: limit, from: null, to: null }, today: { used: 0 }, daily: [], tokens: { input: 0, output: 0 } };
}

export function createHandler({
  getSettings = settings.get,
  getKey = secret.getAiKey,
  hasKey = secret.hasAiKey,
  setKey = secret.setAiKey,
  clearKey = secret.clearAiKey,
  loadQuota = defaultLoadQuota,
  loadProviders = defaultLoadProviders,
  fetchImpl,
  now = Date.now,
} = {}) {
  let quotaP = null;
  let provP = null;
  const getQuota = () => (quotaP ||= Promise.resolve(loadQuota({ getSettings, now })).catch(() => null));
  const getProviders = () => (provP ||= Promise.resolve(loadProviders()).catch(() => null));

  return async function handle(req, res, url, ctx) {
    const p = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const m = req.method;
    if (p !== '/api/ai/usage' && p !== '/api/ai/test' && p !== '/api/ai/key') return false;

    // Pemakaian: agent boleh membaca.
    if (p === '/api/ai/usage' && m === 'GET') {
      const quota = await getQuota();
      if (!quota) {
        ctx.sendJSON(res, 200, emptyUsage(getSettings()));
        return true;
      }
      try {
        ctx.sendJSON(res, 200, await quota.usage());
      } catch (e) {
        console.error(`[api/ai] usage gagal: ${e.message}`);
        ctx.sendJSON(res, 503, { error: 'Pemakaian AI belum bisa dibaca. Coba lagi.' });
      }
      return true;
    }

    // Uji koneksi memakai kunci/model/penyedia TERSIMPAN (body diabaikan). Selalu 200 dengan { ok, kind?, message }.
    if (p === '/api/ai/test' && m === 'POST') {
      if (!ctx.requireRole('admin')) return true;
      const a = getSettings().ai;
      const key = getKey();
      const done = (body) => {
        ctx.audit('ai.test', { ok: body.ok, ...(body.kind ? { kind: body.kind } : {}), provider: a.provider });
        ctx.sendJSON(res, 200, body);
        return true;
      };
      if (!key) return done({ ok: false, kind: 'auth', message: 'Kunci API belum diisi.' });
      if (!a.model) return done({ ok: false, kind: 'bad_request', message: 'Nama model belum diisi.' });
      if (a.provider === 'openai-compatible' && !a.baseUrl) return done({ ok: false, kind: 'bad_request', message: 'URL dasar belum diisi.' });
      const prov = await getProviders();
      if (!prov) return done({ ok: false, kind: 'unavailable', message: 'Modul penyedia AI belum terpasang.' });
      try {
        const r = await prov.testConnection({
          provider: a.provider, apiKey: key, baseUrl: a.baseUrl, model: a.model, timeoutMs: a.timeoutMs,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        const ok = !!r?.ok;
        return done({ ok, ...(r?.kind ? { kind: String(r.kind) } : {}), message: scrub(r?.message || (ok ? 'Koneksi berhasil.' : 'Koneksi gagal.'), key) });
      } catch (e) {
        const kind = typeof e?.kind === 'string' ? e.kind : 'server';
        console.error(`[api/ai] uji koneksi gagal (${kind})`); // tanpa pesan: bisa mengutip kunci
        return done({ ok: false, kind, message: scrub(e?.message || 'Koneksi gagal.', key) });
      }
    }

    if (p === '/api/ai/key' && m === 'PUT') {
      if (!ctx.requireRole('admin')) return true;
      const body = await ctx.readBody(req);
      if (!isObj(body) || typeof body.key !== 'string') {
        ctx.sendJSON(res, 400, { error: 'Isi permintaan tidak valid.' });
        return true;
      }
      try {
        setKey(body.key);
      } catch (e) {
        if (e.code === 'VALIDATION') ctx.sendJSON(res, 400, { error: 'Kunci API tidak valid.' });
        else {
          console.error(`[api/ai] kunci tidak tersimpan: ${e.message}`);
          ctx.sendJSON(res, 500, { error: 'Kunci tidak dapat disimpan. Periksa log server.' });
        }
        return true;
      }
      ctx.audit('ai.key.set', {}); // tanpa nilai kunci
      ctx.sendJSON(res, 200, { hasKey: true });
      return true;
    }

    if (p === '/api/ai/key' && m === 'DELETE') {
      if (!ctx.requireRole('admin')) return true;
      clearKey();
      ctx.audit('ai.key.delete', {});
      ctx.sendJSON(res, 200, { hasKey: hasKey() }); // bisa tetap true bila AI_API_KEY di env terisi
      return true;
    }

    return false; // metode lain (mis. GET /api/ai/key) tidak ada: kunci tidak pernah bisa dibaca
  };
}

export const handle = createHandler();
