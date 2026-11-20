// Penjaga integrasi Acesio (berjalan berkala, mati bila tidak ada yang perlu dikerjakan):
//  1. Ajukan ulang otomatis lead Won yang pengajuannya gagal (hanya yang ditandai acesioAuto, dengan jeda).
//  2. Sinkron keputusan admin Acesio (diterima/ditolak + jadwal) ke lead dan percakapan.
// Semua ketergantungan diinjeksi agar bisa diuji tanpa jaringan.
const RETRY_GAP_MS = 5 * 60_000;
const MAX_TRIES = 12;

export function createSync({ leads, submit, statuses, update, flag, enabled = () => true, now = Date.now, log = () => {} }) {
  let busy = false;
  async function retry() {
    for (const l of leads()) {
      if (!l.acesioAuto || l.acesioStatus === 'sent' || l.hotStage !== 'Won') continue;
      if ((l.acesioAutoTries || 0) >= MAX_TRIES) continue;
      if (l.acesioLastAttemptAt && now() - l.acesioLastAttemptAt < RETRY_GAP_MS) continue;
      try { await submit(l.id); } catch (e) { log('ajukan ulang gagal:', e?.name || 'galat'); }
    }
  }
  async function sync() {
    const open = leads().filter((l) => l.acesioStatus === 'sent' && l.acesioDecision !== 'accepted' && l.acesioDecision !== 'rejected');
    for (let i = 0; i < open.length; i += 50) {
      const batch = open.slice(i, i + 50);
      const res = await statuses(batch.map((l) => l.id));
      if (!res) return; // Acesio tidak terjangkau: coba lagi nanti
      for (const l of batch) {
        const s = res[l.id];
        if (!s || (s.status !== 'accepted' && s.status !== 'rejected')) continue;
        const patch = { acesioDecision: s.status, acesioDecisionAt: now() };
        if (s.status === 'rejected') {
          patch.acesioRejectReason = String(s.rejection_reason || '').slice(0, 300);
          flag(l, `Pengajuan ditolak Acesio${patch.acesioRejectReason ? ': ' + patch.acesioRejectReason : ''}. Hubungi customer atau perbaiki data lalu ajukan ulang.`);
        } else if (s.schedule) {
          patch.acesioSchedule = { day: s.schedule.day, start_time: s.schedule.start_time, worker: s.schedule.worker || '' };
        }
        update(l.id, patch);
      }
    }
  }
  async function tick() {
    if (busy || !enabled()) return;
    busy = true;
    try { await retry(); await sync(); } catch (e) { log('sinkron gagal:', e?.name || 'galat'); } finally { busy = false; }
  }
  let timer = null;
  return {
    tick,
    start(ms = 60_000) { if (!timer) { timer = setInterval(() => tick().catch(() => {}), ms); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
