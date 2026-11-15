// API status & logout WhatsApp.
import { wa as defaultWa, logout as defaultLogout, mode as defaultMode } from '../whatsapp.js';
import * as C from '../conversations.js';

// Pabrik supaya mudah diuji dengan dependensi palsu.
// mode: 'baileys' | 'convia' (string atau fungsi). Selain 'baileys' tidak ada QR (tidak ada sesi perangkat).
export function makeHandle({ wa, logout, unread, mode = 'baileys' }) {
  const modeOf = () => (typeof mode === 'function' ? mode() : mode);
  return async function handle(req, res, url, ctx) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/wa/status') {
      const off = process.env.DISABLE_WA === '1';
      const m = modeOf();
      ctx.sendJSON(res, 200, {
        status: off ? 'disabled' : wa.status,
        mode: m,
        qr: !off && m === 'baileys' && ctx.user?.role === 'admin' ? (wa.qr ?? null) : null, // QR hanya untuk admin, hanya mode baileys, hanya bila soket hidup
        number: off ? null : (wa.number ?? null),
        error: off ? null : (wa.error ?? null),
        unread: unread(),
        since: off ? null : (wa.since ?? null),
        reconnectAttempts: off ? 0 : (wa.reconnectAttempts ?? 0),
      });
      return true;
    }
    if (req.method === 'POST' && p === '/api/wa/logout') {
      if (!ctx.requireRole('admin')) return true;
      try {
        const r = await logout();
        ctx.audit('wa.logout');
        const m = modeOf();
        if (m === 'baileys') ctx.sendJSON(res, 200, { ok: true });
        else {
          // Mode non-QR: tidak ada sesi yang diputus. Pesan dari provider diteruskan bila ada.
          const message = typeof r?.message === 'string' && r.message ? r.message : 'Mode ini tidak memakai sesi QR; tidak ada yang diputus.';
          ctx.sendJSON(res, 200, { ok: true, mode: m, loggedOut: false, message });
        }
      } catch (e) {
        ctx.sendJSON(res, 500, { error: 'Gagal logout WhatsApp' });
      }
      return true;
    }
    return false;
  };
}

export const handle = makeHandle({ wa: defaultWa, logout: defaultLogout, unread: () => C.totalUnread(), mode: defaultMode });
