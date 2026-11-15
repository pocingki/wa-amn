// Rencana balasan bot (fungsi murni terhadap objek conv; tanpa I/O dan tanpa kirim).
// Efek JAWABAN berlaku segera pada conv; efek KELUARAN hanya lewat commit(conv) setelah balasan terkirim.
// Balasan AI TIDAK dibuat di sini: plan() hanya menandai { kind:'ai', needsAi:true, text:'' }; pipeline (B6)
// yang memanggil penyedia AI dan mengisi teksnya. Modul ini tidak mengimpor modul AI.
import { isGreeting, isGreetingOnly, isQuestion, isSkip } from './bot-validate.js';
import { bookingLink } from './connect.js';

const MEDIA = new Set(['image', 'audio', 'video', 'sticker', 'document', 'location', 'contact']);
const REF_ID = 'referensi'; // satu-satunya data wajib: dari mana customer mengenal kami
const REF_MAX = 50; // panjang maksimal jawaban referensi
const REF_ASK_MAX = 3; // penanyaan per sesi: 1 awal + 2 ulang

// Satu kali lewat: nilai hasil penggantian tidak diperluas lagi.
// {booking} = tautan booking bertanda tangan (docs/INTEGRASI.md bagian 4); dibiarkan bila belum dikonfigurasi.
export const fill = (t, conv, S) =>
  String(t || '').replace(/\{(nama|bot|admin|booking)\}/gi, (whole, k) => {
    k = k.toLowerCase();
    if (k === 'booking') return bookingLink(conv) ?? whole;
    return k === 'nama' ? conv.name || 'Kak' : k === 'bot' ? S.botName : S.adminName;
  });

export function remainingMs(conv, S, now = Date.now()) {
  if (conv.mode !== 'bot' || !S.botEnabled || !(S.botDurationMinutes > 0)) return null;
  return Math.max(0, conv.botStartedAt + S.botDurationMinutes * 60000 - now);
}

export function setMode(conv, mode, now = Date.now()) {
  conv.mode = mode;
  if (mode === 'bot') conv.botStartedAt = now;
  else if (mode === 'admin') conv.adminLastAt = now;
}

/** Kapan admin terakhir aktif di percakapan ini (ambil alih / membalas). 0 bila tidak diketahui. */
export function adminLastAt(conv) {
  if (conv.adminLastAt) return conv.adminLastAt;
  const m = [...(conv.messages || [])].reverse().find((x) => x.by === 'admin');
  return m ? m.ts : 0;
}

/** Sisa ms sebelum mode admin boleh kembali ke bot (null bila bukan mode admin atau fitur mati). */
export function adminReturnMs(conv, S, now = Date.now()) {
  const mins = Number(S.adminAutoReturnMinutes) || 0;
  if (conv.mode !== 'admin' || !S.botEnabled || !(mins > 0)) return null;
  return Math.max(0, adminLastAt(conv) + mins * 60000 - now);
}

/** Efek keluaran sebuah balasan; dipanggil setelah balasan benar-benar terkirim. */
export function applyReplyEffect(conv, kind, fieldId, now = Date.now()) {
  if (kind === 'opening') conv.openingSent = true;
  else if (kind === 'question' || kind === 'reask') {
    conv.pending = fieldId ?? null;
    if (fieldId === REF_ID) conv.refAsked = (conv.refAsked || 0) + 1; // hitung penanyaan referensi pada sesi ini
  } else if (kind === 'fallback' || kind === 'ai' || kind === 'quota') conv.lastFallbackAt = now; // satu cooldown untuk AI dan fallback
  else if (kind === 'completion') conv.completedAt = now;
  else if (kind === 'handover') {
    conv.mode = 'admin';
    conv.adminLastAt = now;
    conv.pending = null;
  }
}

// Sesi baru (durasi bot habis): penanyaan referensi dihitung dari awal lagi; data yang sudah terkumpul tetap.
function resetRefSession(conv) {
  conv.refAsked = 0;
  delete conv.refDone;
  if (conv.pending === REF_ID) conv.pending = null;
  if (Array.isArray(conv.skipped)) conv.skipped = conv.skipped.filter((id) => id !== REF_ID);
}

// Jawaban referensi: spasi dirapikan, dipotong REF_MAX karakter (aman untuk emoji).
const refValue = (text) => Array.from(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, REF_MAX).join('').trim();

const aiEnabled = (S) => !!(S.ai && S.ai.enabled);

/**
 * plan(conv, msg, S, now, ctx). ctx opsional: { isNewNumber, crm:{ referensi, name, phone } }.
 * Tanpa ctx: nomor dianggap baru bila pembuka belum terkirim, dan referensi dibaca dari conv.data.referensi.
 */
export function plan(conv, msg, S, now = Date.now(), ctx = null) {
  const out = { replies: [], attention: null, ignored: false };
  if (!S.botEnabled || msg.kind === 'reaction' || msg.kind === 'system') {
    out.ignored = true;
    return out;
  }
  const stale = now - msg.ts > S.staleMinutes * 60000;
  // Mode admin: bot diam, kecuali admin sudah tidak aktif melebihi adminAutoReturnMinutes.
  // Pesan basi tidak membangunkan bot.
  if (conv.mode !== 'bot') {
    const left = adminReturnMs(conv, S, now);
    if (stale || left == null || left > 0) {
      out.ignored = true;
      return out;
    }
    setMode(conv, 'bot', now);
    conv.pending = null;
    out.returnedToBot = Number(S.adminAutoReturnMinutes);
  }
  // Pesan basi: tanpa balasan, tanpa ubah state.
  if (stale) {
    out.attention = { reason: 'stale' };
    return out;
  }
  const add = (kind, text, fieldId) => {
    const r = { text: fill(text, conv, S), kind, commit: (c) => applyReplyEffect(c, kind, fieldId, now) };
    if (fieldId) r.fieldId = fieldId;
    out.replies.push(r);
  };
  // Teks diisi pipeline setelah penyedia AI menjawab; commit hanya menandai cooldown.
  const addAi = () => out.replies.push({ text: '', kind: 'ai', needsAi: true, commit: (c) => applyReplyEffect(c, 'ai', null, now) });
  const cooled = () => now - (conv.lastFallbackAt || 0) >= S.fallbackCooldownMinutes * 60000;

  // Durasi bot habis: sesi baru. Hanya menghitung ulang durasi dan penanyaan referensi;
  // TIDAK memicu pembuka ulang (pembuka: nomor baru atau salam).
  if (S.botDurationMinutes > 0 && now - conv.botStartedAt > S.botDurationMinutes * 60000) {
    conv.botStartedAt = now;
    resetRefSession(conv);
  }

  const isMedia = MEDIA.has(msg.kind);
  const content = String((isMedia ? msg.caption : msg.text) || '');
  const greeting = isGreeting(content, S.greetingWords);
  const greetingOnly = greeting && isGreetingOnly(content, S.greetingWords);

  // Pembuka: nomor baru selalu (bila belum terkirim); nomor lama hanya bila pesan berisi salam.
  const isNew = ctx ? !!ctx.isNewNumber : !conv.openingSent;
  const opening = isNew ? !conv.openingSent : greeting;
  if (opening) {
    if (S.openingMessage) add('opening', S.openingMessage);
    else conv.openingSent = true;
  }
  const wantsAi = aiEnabled(S) && content.trim() !== '' && !greetingOnly;

  // Media: bukan jawaban data; hanya caption yang dipertimbangkan untuk AI. Pertanyaan referensi tidak ditanyakan.
  if (isMedia) {
    if (wantsAi) {
      if (cooled()) addAi();
    } else if (!opening && S.fallbackMessage && cooled()) add('fallback', S.fallbackMessage);
    out.attention = { reason: 'media' };
    return out;
  }

  // Teks.
  const refField = (S.requiredFields || []).find((f) => f && f.enabled && f.id === REF_ID) || null;
  const crmRef = ctx ? ctx.crm?.referensi : conv.data?.referensi;
  const refFilled = String(crmRef ?? '').trim() !== '';
  // Pertanyaan yang menggantung tetapi sudah tidak relevan (field mati, CRM sudah terisi, sisa skema lama).
  if (conv.pending && (!refField || refFilled || conv.pending !== REF_ID)) conv.pending = null;

  let answered = false, skippedNow = false;
  if (conv.pending === REF_ID && !greetingOnly && !isQuestion(content)) {
    if (isSkip(content)) {
      conv.skipped = conv.skipped || [];
      if (!conv.skipped.includes(REF_ID)) conv.skipped.push(REF_ID);
      conv.refDone = 'skipped';
      conv.pending = null;
      skippedNow = true;
    } else {
      const v = refValue(content);
      if (v) {
        conv.data = conv.data || {};
        conv.data[REF_ID] = v;
        out.referensi = v;
        conv.refDone = 'answered';
        conv.pending = null;
        answered = true;
      }
    }
  }

  // Jawaban data wajib tidak memicu AI atau fallback.
  if (!answered && !skippedNow) {
    if (wantsAi) {
      if (cooled()) addAi();
    } else if (!opening && S.fallbackMessage && cooled()) add('fallback', S.fallbackMessage);
  }

  if (answered || skippedNow) {
    if (!conv.completedAt) {
      if (S.completionMessage) add('completion', S.completionMessage);
      else conv.completedAt = now;
    }
  } else if (refField && !refFilled && !conv.refDone && (conv.refAsked || 0) < REF_ASK_MAX) {
    add('question', refField.question, refField.id);
  }

  if (!out.replies.length && !opening) out.attention = { reason: 'no_reply' };
  return out;
}

/** Pembungkus kompatibilitas: jalankan commit balasan biasa, kembalikan teksnya. Balasan AI (needsAi) dilewati. */
export function decide(conv, text, S, now = Date.now(), ctx = null) {
  const p = plan(conv, { text, kind: 'text', ts: now }, S, now, ctx);
  const done = p.replies.filter((r) => !r.needsAi);
  done.forEach((r) => r.commit(conv));
  return done.map((r) => r.text);
}
