// Follow up otomatis untuk customer yang sudah mengisi formulir tetapi belum membayar DP (maksimal 2 kali).
// Berhenti bila: DP lunas (hotStage Won/Lost), customer membalas, atau percakapan dihapus.
// Convia (API resmi): pesan bebas hanya boleh dalam 24 jam sejak pesan terakhir customer. Di luar itu TIDAK dikirim
// (template belum didukung); percakapan ditandai "perlu perhatian" agar admin menindaklanjuti.
import { agentCfg } from './crm-agent.js';
import { fill } from './bot-plan.js';

const WINDOW_MS = 23.5 * 3600_000; // sisakan margin 30 menit dari batas 24 jam

const lastCustomerAt = (conv) => {
  let t = 0;
  for (const m of conv.messages || []) if (m.by === 'customer' && m.type !== 'reaction' && m.type !== 'system') t = Math.max(t, m.ts || 0);
  return t;
};

/** Daftar follow up yang jatuh tempo: [{ conv, index, text, blocked }]. Murni. */
export function due({ convs, findLead, S, now }) {
  const A = agentCfg(S);
  const out = [];
  if (!A.enabled) return out;
  const delays = A.followUpDelaysMinutes.slice(0, 2);
  for (const conv of convs) {
    const f = conv.form;
    if (!f || f.stage !== 'done' || !f.completedAt) continue;
    const n = f.followUpsSent || 0;
    if (n >= delays.length || n >= A.followUpMessages.length) continue;
    const lead = findLead(conv);
    if (lead && (lead.hotStage === 'Won' || lead.hotStage === 'Lost' || lead.blocked)) continue;
    if (lastCustomerAt(conv) > f.completedAt) continue; // customer sudah membalas: admin yang menangani
    if (now < f.completedAt + delays[n] * 60_000) continue;
    const text = fill(A.followUpMessages[n], conv, S);
    const outsideWindow = S.waProvider === 'convia' && now - lastCustomerAt(conv) > WINDOW_MS;
    out.push({ conv, index: n, text, blocked: outsideWindow ? 'convia_window' : null });
  }
  return out;
}

export function createRunner({ convs, findLead, getSettings, send, now = Date.now, emit = () => {}, log = () => {} }) {
  let timer = null;
  async function tick() {
    const S = getSettings();
    for (const it of due({ convs: convs._all(), findLead, S, now: now() })) {
      const c = it.conv;
      if (it.blocked) {
        // Tandai sekali saja; tahap ini dilewati supaya tidak diulang tiap menit.
        c.form.followUpsSent = (c.form.followUpsSent || 0) + 1;
        c.needsAttention = true;
        c.attentionReason = 'Follow up DP tidak dikirim: lewat 24 jam (batas WhatsApp resmi). Hubungi customer secara manual.';
        c.attentionAt = now();
        emit('conversation:attention', { phone: c.phone, reason: c.attentionReason });
        convs.save(c);
        continue;
      }
      try {
        const { waId } = await send(c.jid, it.text);
        const m = convs.addMessage(c, 'bot', it.text, now());
        Object.assign(m, { type: 'text', status: 'sent', waId, replyKind: 'followup' });
        c.form.followUpsSent = (c.form.followUpsSent || 0) + 1;
        convs.save(c);
        emit('message:new', { phone: c.phone, by: 'bot', type: 'text' });
      } catch (e) {
        log('follow up gagal:', e?.name || 'galat'); // dicoba lagi pada tick berikutnya
      }
    }
  }
  return {
    tick,
    start(ms = 60_000) { if (!timer) { timer = setInterval(() => tick().catch(() => {}), ms); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}