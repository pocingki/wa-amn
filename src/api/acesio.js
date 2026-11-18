// /api/acesio: alamat + kunci Acesio diisi dari dashboard (hanya admin). Kunci tidak pernah dikembalikan.
import * as link from '../acesio-link.js';

const isObj = (b) => b && typeof b === 'object' && !Array.isArray(b);

export function createHandler({ fetchImpl = globalThis.fetch } = {}) {
  return async function handle(req, res, url, ctx) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p !== '/api/acesio' && p !== '/api/acesio/test') return false;
    if (!ctx.requireRole('admin')) return true;
    const send = (code, body) => (ctx.sendJSON(res, code, body), true);

    if (p === '/api/acesio' && req.method === 'GET') return send(200, link.publicView());

    if (p === '/api/acesio' && (req.method === 'PUT' || req.method === 'DELETE')) {
      if (req.method === 'DELETE') {
        link.clearKey();
        ctx.audit('acesio.kunci.hapus', {});
        return send(200, link.publicView());
      }
      const body = await ctx.readBody(req);
      if (!isObj(body)) return send(400, { error: 'Isi permintaan tidak valid.' });
      try {
        const patch = {};
        if (typeof body.url === 'string') patch.url = body.url;
        if (typeof body.key === 'string' && body.key.trim() !== '') patch.key = body.key;
        link.setLink(patch);
      } catch (e) {
        if (e.code === 'VALIDATION') return send(400, { error: e.message });
        throw e;
      }
      ctx.audit('acesio.sambungan.simpan', { url: link.getLink().url, kunci: typeof body.key === 'string' && body.key.trim() !== '' ? 'diubah' : 'tetap' });
      return send(200, link.publicView());
    }

    if (p === '/api/acesio/test' && req.method === 'POST') {
      const { url: base, key } = link.getLink();
      if (!key) return send(200, { ok: false, message: 'Kunci Acesio belum diisi.' });
      try {
        const r = await fetchImpl(`${base}/api/bot/services`, { headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(8000) });
        const ok = r.ok;
        const message = ok ? 'Tersambung. Kunci diterima Acesio.'
          : r.status === 401 ? 'Kunci ditolak Acesio. Buat ulang kunci di menu Integrasi Acesio lalu tempel di sini.'
            : r.status === 503 ? 'Acesio belum punya kunci aktif. Buat kunci di menu Integrasi Acesio.'
              : `Acesio menjawab HTTP ${r.status}.`;
        ctx.audit('acesio.tes', { ok });
        return send(200, { ok, message });
      } catch (e) {
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        return send(200, { ok: false, message: timeout ? 'Acesio tidak menjawab (timeout). Cek alamatnya.' : 'Acesio tidak terjangkau. Cek alamat dan pastikan Acesio berjalan.' });
      }
    }
    return send(405, { error: 'Metode tidak didukung.' });
  };
}

export const handle = createHandler();
