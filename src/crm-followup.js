// Pesan otomatis agen CRM setelah formulir lengkap:
//  1. Follow up DP: SATU kali bila DP belum masuk (belum ada bukti bayar, belum Won/Lost).
//  2. Pengingat booking: H-1 dan hari H untuk customer yang DP-nya lunas (tahap Won), sesuai tanggal/jam booking di data lead.
// Convia (API resmi): pesan bebas hanya boleh dalam 24 jam sejak pesan terakhir customer. Di luar itu TIDAK dikirim
// (template belum didukung); percakapan ditandai "perlu perhatian" agar admin menindaklanjuti.
import { agentCfg } from './crm-agent.js';
import { fill } from './bot-plan.js';

const WINDOW_MS = 23.5 * 3600_000; // sisakan margin 30 menit dari batas 24 jam
const DAY_MS = 86_400_000;

const lastCustomerAt = (conv) => {
  let t = 0;
  for (const m of conv.messages || []) if (m.by === 'customer' && m.type !== 'reaction' && m.type !== 'system') t = Math.max(t, m.ts || 0);
  return t;
};
const outsideWindow = (conv, S, now) => S.waProvider === 'convia' && now - lastCustomerAt(conv) > WINDOW_MS;

/** Follow up DP yang jatuh tempo: [{ conv, kind:'followup', index, text, blocked }]. Murni. */
export function due({ convs, findLead, S, now }) {
  const A = agentCfg(S);
  const out = [];
  if (!A.enabled) return out;
  const delay = A.followUpDelaysMinutes[0];
  for (const conv of convs) {
    const f = conv.form;
    if (!f || f.stage !== 'done' || !f.completedAt || f.dpState === 'proof') continue;
    if ((f.followUpsSent || 0) >= 1 || !A.followUpMessages[0]) continue; // hanya satu kali
    const lead = findLead(conv);
    if (lead && (lead.hotStage === 'Won' || lead.hotStage === 'Lost' || lead.blocked)) continue;
    const last = lastCustomerAt(conv);
    // Bot masih memegang chat (menunggu DP): hitung dari aktivitas customer terakhir. Alur lama (sudah ke admin): customer membalas = admin yang menangani.
    if (f.dpState !== 'awaiting' && last > f.completedAt) continue;
    const base = f.dpState === 'awaiting' ? Math.max(f.completedAt, last) : f.completedAt;
    if (now < base + delay * 60_000) continue;
    out.push({ conv, kind: 'followup', index: 0, text: fill(A.followUpMessages[0], conv, S), blocked: outsideWindow(conv, S, now) ? 'convia_window' : null });
  }
  return out;
}

const dayStart = (ymd) => Date.parse(`${ymd}T00:00:00+07:00`);
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return (h * 60 + m) * 60_000; };
const longDay = (ymd) => new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date(dayStart(ymd) + 12 * 3600_000));

/** Pengingat booking H-1 dan hari H: [{ conv, kind:'h1'|'h0', text, blocked, day }]. Murni. */
export function dueReminders({ convs, findLead, S, now }) {
  const A = agentCfg(S);
  const out = [];
  if (!A.enabled || !A.remindersEnabled) return out;
  for (const conv of convs) {
    const lead = findLead(conv);
    if (!lead || lead.hotStage !== 'Won' || lead.blocked || lead.acesioDecision === 'rejected') continue;
    const day = String(lead.data?.booking_day || ''), time = String(lead.data?.booking_time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time) || Number.isNaN(dayStart(day))) continue;
    const r = conv.reminders && conv.reminders.day === day ? conv.reminders : {}; // tanggal booking diubah -> pengingat dihitung ulang
    const d0 = dayStart(day), start = d0 + hm(time);
    const kinds = [];
    if (!r.h1 && now >= d0 - DAY_MS + hm(A.reminderH1Time) && now < d0) kinds.push('h1');
    if (!r.h0 && now >= d0 + hm(A.reminderH0Time) && now < start) kinds.push('h0');
    for (const kind of kinds) {
      const tpl = kind === 'h1' ? A.reminderH1Message : A.reminderH0Message;
      const text = fill(tpl, conv, S)
        .replace(/\{tanggal\}/gi, longDay(day)).replace(/\{jam\}/gi, time)
        .replace(/\{layanan\}/gi, String(lead.data?.booking_services || '').trim() || 'layanan');
      out.push({ conv, kind, text, day, blocked: outsideWindow(conv, S, now) ? 'convia_window' : null });
    }
  }
  return out;
}

export function createRunner({ convs, findLead, getSettings, send, now = Date.now, emit = () => {}, log = () => {} }) {
  let timer = null;
  const mark = (it, t) => {
    const c = it.conv;
    if (it.kind === 'followup') c.form.followUpsSent = (c.form.followUpsSent || 0) + 1;
    else { c.reminders = { ...(c.reminders && c.reminders.day === it.day ? c.reminders : { day: it.day }), [it.kind]: t }; }
  };
  async function tick() {
    const S = getSettings();
    const all = convs._all();
    const items = [...due({ convs: all, findLead, S, now: now() }), ...dueReminders({ convs: all, findLead, S, now: now() })];
    for (const it of items) {
      const c = it.conv;
      const label = it.kind === 'followup' ? 'Follow up DP' : it.kind === 'h1' ? 'Pengingat booking H-1' : 'Pengingat booking hari H';
      if (it.blocked) {
        // Tandai sekali saja; tahap ini dilewati supaya tidak diulang tiap menit.
        mark(it, now());
        c.needsAttention = true;
        c.attentionReason = `${label} tidak dikirim: lewat 24 jam (batas WhatsApp resmi). Hubungi customer secara manual.`;
        c.attentionAt = now();
        emit('conversation:attention', { phone: c.phone, reason: c.attentionReason });
        convs.save(c);
        continue;
      }
      try {
        const { waId } = await send(c.jid, it.text);
        const m = convs.addMessage(c, 'bot', it.text, now());
        Object.assign(m, { type: 'text', status: 'sent', waId, replyKind: it.kind === 'followup' ? 'followup' : 'reminder' });
        mark(it, now());
        convs.save(c);
        emit('message:new', { phone: c.phone, by: 'bot', type: 'text' });
      } catch (e) {
        log(`${label} gagal:`, e?.name || 'galat'); // dicoba lagi pada tick berikutnya
      }
    }
  }
  return {
    tick,
    start(ms = 60_000) { if (!timer) { timer = setInterval(() => tick().catch(() => {}), ms); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
