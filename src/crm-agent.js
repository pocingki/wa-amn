// Agen CRM: saat lead Hot, bot memegang kendali dan meminta customer mengisi formulir data
// (kolom dari Acesio). Setelah lengkap, percakapan dialihkan ke admin untuk pelunasan DP.
// Fungsi step() murni terhadap conv; satu-satunya I/O (ambil formulir Acesio) diinjeksi lewat d.acesioForm.
import { FORM_IDS, BOOKING_IDS, parseReply, formMessage, remainingMessage, monthLabel, withHints } from './crm-form.js';
import { applyReplyEffect, fill } from './bot-plan.js';

export const AGENT_DEFAULTS = {
  enabled: false,
  askBooking: true, // tanyakan layanan, tanggal, dan jam booking di formulir
  autoSubmit: true, // saat DP ditandai lunas (Won), data otomatis diajukan ke Acesio
  formIntro: 'Agar booking Anda bisa kami proses, mohon lengkapi data berikut. Salin lalu isi di sebelah titik dua:',
  doneMessage: 'Terima kasih, data Anda sudah lengkap. {admin} akan melanjutkan untuk pembayaran DP.',
  followUpDelaysMinutes: [180, 1440],
  followUpMessages: [
    'Halo {nama}, data Anda sudah kami terima. Bila ingin melanjutkan booking, silakan lakukan pembayaran DP. Kabari kami jika ada kendala.',
    'Halo {nama}, kami ingatkan kembali untuk pembayaran DP booking Anda. Jika masih ragu atau ada pertanyaan, silakan balas pesan ini.',
  ],
};

export const agentCfg = (S) => ({ ...AGENT_DEFAULTS, ...(S?.crmAgent || {}) });
const closed = (lead) => lead && (lead.hotStage === 'Won' || lead.hotStage === 'Lost');

/** Perlu memulai formulir? Hanya lead Hot yang bot-nya masih memegang kendali dan nomornya diketahui. */
export function shouldStart(conv, lead, S) {
  const A = agentCfg(S);
  return !!(A.enabled && lead && lead.status === 'Hot Leads' && !closed(lead) && !conv.form && conv.mode === 'bot' && conv.phoneKnown);
}

export async function begin(d, conv, lead, now) {
  const f = await d.acesioForm(conv.phone);
  const missing = [...f.missing];
  if (!lead?.referensi && !f.values.reference && !conv.data?.referensi) missing.push('referensi');
  const A = agentCfg(d.settings?.get?.());
  let services = [];
  if (A.askBooking) {
    for (const id of BOOKING_IDS) if (!conv.data?.[id]) missing.push(id);
    try { services = (await d.acesioServices?.()) || []; } catch { services = []; }
  }
  conv.form = {
    services: services.slice(0, 40),
    stage: 'collecting', existing: f.exists, acesioOk: f.ok, missing: missing.filter((id) => FORM_IDS.includes(id)),
    values: {}, known: f.values, asks: 0, startedAt: now, askedAt: null, completedAt: null, followUpsSent: 0,
  };
  return conv.form;
}

const hintsOf = (f) => (f?.services?.length && f.services.length <= 12 ? { booking_services: ` (pilih: ${f.services.join(', ')})` } : {});

/** Cek slot (async, I/O) sebelum step(): kembalikan { day, info } bila tanggal+jam sudah diketahui, selain itu null. */
export async function checkSlots(d, { conv, msg, now }) {
  const f = conv.form;
  if (!f || f.stage !== 'collecting' || !f.missing.some((id) => BOOKING_IDS.includes(id))) return null;
  const r = parseReply(String(msg?.text || msg?.caption || ''), f.missing, now, { services: f.services });
  const day = r.values.booking_day || f.values.booking_day;
  const time = r.values.booking_time || f.values.booking_time;
  if (!day || !time || !d.acesioSlots) return null;
  let info = null;
  try { info = await d.acesioSlots(day); } catch { info = null; }
  return { day, time, info };
}

const ask = (conv, text) => ({
  text, kind: 'form_ask',
  commit: (c) => { c.form.askedAt = Date.now(); c.form.asks = (c.form.asks || 0) + 1; },
});

/**
 * Satu langkah formulir untuk pesan customer.
 * Mengembalikan { consumed, replies, patch?, referensi? }.
 *  consumed = pesan ini dijawab agen (balasan rencana biasa dibuang).
 */
export function step({ conv, msg, S, now, slots = null }) {
  const A = agentCfg(S);
  const f = conv.form;
  if (!f || f.stage !== 'collecting' || conv.mode !== 'bot') return { consumed: false, replies: [] };
  const text = String(msg?.text || msg?.caption || '');
  // missing kosong = lengkap tetapi balasan penutup belum terkirim (gagal kirim): selesaikan sekarang.
  const r = f.askedAt && f.missing.length ? parseReply(text, f.missing, now, { services: f.services }) : { values: {}, errors: {}, touched: false };
  if (!r.touched && f.missing.length) {
    // Belum dijawab sebagai formulir: kirim formulir bila belum pernah terkirim; selain itu serahkan ke balasan biasa (mis. tanya DP).
    if (!f.askedAt) return { consumed: false, replies: [ask(conv, withHints(hintsOf(f), () => formMessage(f.missing, A.formIntro)))], append: true };
    return { consumed: false, replies: [] };
  }
  Object.assign(f.values, r.values);
  // Cek slot: tanggal+jam yang diminta harus tersedia di jadwal Acesio.
  if (f.values.booking_day && f.values.booking_time && slots && slots.day === f.values.booking_day && slots.time === f.values.booking_time) {
    if (!slots.info) f.slotUnchecked = true; // Acesio tidak terjangkau: diterima, admin memeriksa manual
    else {
      f.slotUnchecked = false;
      const free = slots.info.slots.filter((x) => x.available).map((x) => x.time);
      if (!free.includes(slots.time)) {
        const alt = free.slice(0, 6).join(', ');
        r.errors.booking_time = free.length
          ? `Jam ${slots.time} pada ${slots.day.split('-').reverse().join('/')} sudah penuh. Jam yang masih tersedia: ${alt}`
          : `Tanggal ${slots.day.split('-').reverse().join('/')} sudah penuh. Silakan pilih tanggal lain`;
        delete f.values.booking_time;
        if (!free.length) delete f.values.booking_day;
      }
    }
  }
  f.missing = FORM_IDS.filter((id) => (f.missing.includes(id) || id in r.errors) && !(id in f.values));
  const out = { consumed: true, replies: [] };
  if (r.values.referensi) out.referensi = r.values.referensi;
  if (f.missing.length) {
    out.replies.push(ask(conv, withHints(hintsOf(f), () => remainingMessage(f.missing, r.errors))));
    return out;
  }
  // Lengkap: nama dari formulir hanya menimpa nama kontak WA untuk customer BARU.
  const v = f.values;
  const patch = {};
  const data = {};
  for (const id of ['gender', 'birth_date', 'occupation', 'domicile', ...BOOKING_IDS]) if (v[id]) data[id] = v[id];
  if (!f.existing) {
    if (v.name) patch.name = v.name;
    data.month = monthLabel(now);
  } else if (f.known?.name) patch.name = f.known.name;
  out.patch = patch;
  out.data = data;
  out.replies.push({
    text: fill(A.doneMessage, { ...conv, name: v.name || conv.name }, S), kind: 'handover',
    commit: (c) => {
      applyReplyEffect(c, 'handover', undefined, now);
      c.form.stage = 'done';
      c.form.completedAt = now;
      if (!f.existing && v.name) c.name = v.name;
      c.data = { ...(c.data || {}), ...data, ...(v.referensi ? { referensi: v.referensi } : {}) };
    },
  });
  out.attention = f.slotUnchecked ? 'Formulir lengkap, menunggu DP. Slot booking belum diverifikasi ke Acesio, cek jadwalnya' : 'Formulir data lengkap, menunggu pembayaran DP';
  return out;
}
