// Alur pesan masuk: rekonsiliasi identitas -> simpan -> CRM -> rencana balasan -> (AI) -> kirim -> sinkron lead.
import { createHash } from 'node:crypto';
import * as convStore from './conversations.js';
import * as leadStore from './store.js';
import * as settingsStore from './settings.js';
import { ingest } from './leads.js';
import { emit } from './events.js';
import { plan, setMode, applyReplyEffect, fill } from './bot-plan.js';

const BACKOFF = [1000, 3000, 9000]; // jeda antar percobaan kirim
const ATTEMPTS = 3;
const RANK = { sending: 0, sent: 1, delivered: 2, read: 3 };
const waIdToKey = new Map(); // waId pesan bot -> kunci percakapan

// ---------- AI (B1-B4) ----------
// ASUMSI: bentuk modul B1-B4 mengikuti KONTRAK ANTAR-SESI; belum bisa diverifikasi karena berkasnya
// bukan lampiran sesi ini. Modul dimuat malas (import dinamis) supaya: (a) tanpa AI aktif tidak ada
// sentuhan ke DB/jaringan, (b) pipeline tetap bisa dimuat dan diuji sebelum B1-B4 digabung.
// ASUMSI: parameter `knowledge` pada createAiReply menerima namespace src/ai-knowledge.js
// (buildContext/validateEntries); sesuaikan bila B4 mengharapkan bentuk lain.
const AI_DISABLED = { ok: false, reason: 'disabled' };
let aiLoadWarned = false;
// Log AI: hanya teks pendek; objek/isi pesan tidak pernah ikut tercatat.
const aiLog = (...a) => console.warn('[ai]', ...a.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)));

/** Pembungkus AI nyata: { ai: { reply }, quota: { refund } }. getSettings bisa diganti (tester). */
export function makeRealAi({ getSettings = () => settingsStore.get() } = {}) {
  let loading = null;
  const load = () => {
    loading ||= (async () => {
      const [prov, know, qm, rp, sec, db] = await Promise.all([
        import('./ai-providers.js'), import('./ai-knowledge.js'), import('./ai-quota.js'),
        import('./ai-reply.js'), import('./ai-secret.js'), import('./db.js'),
      ]);
      const quota = qm.createQuota({ getDb: db.getDb, now: Date.now, getSettings });
      const ai = rp.createAiReply({ chat: prov.chat, quota, knowledge: know, getSettings, getKey: sec.getAiKey, now: Date.now, log: aiLog });
      return { ai, quota };
    })().catch((e) => {
      loading = null; // boleh dicoba lagi pada pesan berikutnya
      throw e;
    });
    return loading;
  };
  return {
    ai: {
      async reply(args) {
        if (!getSettings()?.ai?.enabled) return AI_DISABLED; // AI mati: tidak memuat apa pun
        let real;
        try {
          real = await load();
        } catch (e) {
          if (!aiLoadWarned) { aiLoadWarned = true; console.error('[ai] modul AI tidak dapat dimuat:', e?.code || e?.name || 'galat'); }
          return { ok: false, reason: 'disabled', detail: 'modul AI tidak tersedia' };
        }
        return real.ai.reply(args);
      },
    },
    quota: {
      async refund(key) {
        if (!loading) return; // belum pernah dipakai: tidak ada yang perlu dilepas
        (await load()).quota.refund(key);
      },
      // Kirim gagal setelah AI sukses: kuota yang sudah commit pun dilepas.
      async release(key) {
        if (!loading) return;
        (await load()).quota.release(key);
      },
    },
  };
}

export function makeRealDeps(send) {
  const { ai, quota } = makeRealAi();
  return {
    send,
    now: Date.now,
    sleep: process.env.BOT_NO_DELAY ? () => Promise.resolve() : (ms) => new Promise((r) => setTimeout(r, ms)),
    convs: convStore,
    ingest,
    leads: leadStore,
    settings: settingsStore,
    emit,
    plan,
    ai,
    quota,
  };
}

/** Kunci pelanggan untuk kuota: hash dari kunci percakapan, bukan nomor mentah. */
export const customerKeyOf = (key) => createHash('sha256').update('ai-customer:' + String(key)).digest('hex').slice(0, 32);

const blankName = (n) => !String(n ?? '').trim() || String(n).trim() === 'Tanpa Nama';

/** Nama WhatsApp (pushName) yang layak disimpan: spasi dirapikan, tanpa baris baru, 2-100 karakter; selain itu ''. */
export function cleanWaName(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.length >= 2 && s.length <= 100 ? s : '';
}

const empty = (v) =>
  v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const findLead = (d, phone, lid) => (phone && d.leads.findByPhone(phone)) || (lid && d.leads.findByLid?.(lid)) || null;

function setAttention(d, conv, reason, now) {
  conv.needsAttention = true;
  conv.attentionReason = reason;
  conv.attentionAt = now;
  d.emit('conversation:attention', { phone: conv.phone, reason });
}

// Kirim dengan retry hanya bila galat boleh diulang (retryable !== false).
async function sendRetry(d, jid, text) {
  let err;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      return await d.send(jid, text);
    } catch (e) {
      err = e;
      if (e?.retryable === false || i === ATTEMPTS - 1) break;
      await d.sleep(BACKOFF[i]);
    }
  }
  throw err;
}

function mergeConv(cur, old) {
  cur.messages = [...cur.messages, ...old.messages].sort((a, b) => a.ts - b.ts);
  cur.createdAt = Math.min(cur.createdAt ?? Infinity, old.createdAt ?? Infinity);
  cur.data = { ...old.data, ...cur.data };
  cur.unread = (cur.unread || 0) + (old.unread || 0);
  cur.lastMessageAt = Math.max(cur.lastMessageAt || 0, old.lastMessageAt || 0);
  cur.skipped = [...new Set([...(cur.skipped || []), ...(old.skipped || [])])];
  cur.openingSent = !!(cur.openingSent || old.openingSent);
  cur.completedAt = cur.completedAt || old.completedAt;
  if (!cur.name && old.name) cur.name = old.name;
}

function reconcile(d, phone, lid) {
  if (!phone || !lid || phone === lid) return;
  const old = d.convs.get(lid);
  if (old) {
    const cur = d.convs.get(phone);
    if (!cur) {
      const { conv } = d.convs.getOrCreate(phone, old.jid, old.name);
      Object.assign(conv, old, { phone, phoneKnown: true });
    } else {
      mergeConv(cur, old);
      cur.phoneKnown = true;
    }
    d.convs.remove(lid);
  }
  const a = d.leads.findByLid?.(lid), b = d.leads.findByPhone(phone);
  if (a && b && a.id !== b.id) {
    const [keep, drop] = (a.createdAt ?? 0) <= (b.createdAt ?? 0) ? [a, b] : [b, a];
    const patch = { phone, lid: keep.lid || lid };
    for (const [k, v] of Object.entries(drop)) if (k !== 'id' && empty(keep[k]) && !empty(v)) patch[k] = v;
    d.leads.update(keep.id, patch);
    d.leads.remove(drop.id);
  }
}

// Simpan sinkron bila tersedia (DB nyata); deps tes boleh hanya punya save().
function durable(d, conv) {
  if (typeof d.convs.saveNow === 'function') d.convs.saveNow(conv);
  else d.convs.save(conv);
}

const cooled = (S, conv, now) => now - (conv.lastFallbackAt || 0) >= S.fallbackCooldownMinutes * 60000; // cooldown fallback lama

// Lepas kuota; kegagalan pelepasan tidak boleh menggagalkan alur pesan.
async function refundSafe(d, aiKey, { afterCommit = false } = {}) {
  try {
    const fn = afterCommit && typeof d.quota?.release === 'function' ? d.quota.release : d.quota?.refund;
    await fn?.call(d.quota, aiKey);
  } catch { /* diabaikan */ }
}

// Teks AI disimpan di pesan pelanggan agar percobaan ulang memakai teks yang sama (tanpa panggilan/kuota baru).
function keepAiText(d, conv, message, text) {
  message.aiText = text;
  try {
    durable(d, conv);
  } catch {
    d.convs.save(conv); // DB sedang gagal: tetap di memori, ditulis saat DB pulih
  }
}

/**
 * Menyelesaikan balasan needsAi. Mengembalikan { send, attention }:
 * send = { kind, text, aiKey, stamp } atau null bila tidak ada yang dikirim; attention = alasan atau null.
 */
async function resolveAi(d, S, conv, msg, message, key, now) {
  const A = S.ai || {};
  const aiKey = String(msg.waId || message.id);
  if (typeof message.aiText === 'string' && message.aiText) {
    return { send: { kind: 'ai', text: message.aiText, aiKey }, attention: null }; // pakai ulang, tanpa panggilan AI
  }
  let res;
  if (typeof d.ai?.reply !== 'function') res = AI_DISABLED;
  else {
    try {
      // Hanya isi pesan; nomor, nama, dan JID tidak ikut dikirim.
      res = await d.ai.reply({
        conv, msg: { id: message.id, kind: msg.kind, text: msg.text, caption: msg.caption, ts: msg.ts }, key: aiKey, customerKey: customerKeyOf(key),
      });
    } catch {
      res = { ok: false, reason: 'error' };
    }
  }
  if (res?.ok) {
    const text = typeof res.text === 'string' ? res.text.trim() : '';
    if (text) {
      keepAiText(d, conv, message, text);
      return { send: { kind: 'ai', text, aiKey }, attention: null };
    }
    await refundSafe(d, aiKey); // jawaban kosong diperlakukan sebagai galat
    res = { ok: false, reason: 'error' };
  }
  const fallback = () => (S.fallbackMessage && cooled(S, conv, now)
    ? { kind: 'fallback', text: fill(S.fallbackMessage, conv, S), stamp: true } : null);
  if (res?.reason === 'disabled' || res?.reason === 'no_key') return { send: fallback(), attention: null };
  if (res?.reason === 'quota') {
    return { send: A.quotaExhaustedMessage ? { kind: 'quota', text: fill(A.quotaExhaustedMessage, conv, S) } : null, attention: 'ai_quota' };
  }
  if (A.errorMessage) return { send: { kind: 'ai_error', text: fill(A.errorMessage, conv, S) }, attention: 'ai_error' };
  return { send: fallback(), attention: 'ai_error' };
}

export async function processIncoming(msg, d) {
  const key = msg.phone || msg.lid;
  if (!key || msg.kind === 'reaction' || msg.kind === 'system') return null;
  const S = d.settings.get();
  const now = d.now();
  reconcile(d, msg.phone, msg.lid);

  const { conv } = d.convs.getOrCreate(key, msg.jid, msg.name);
  conv.jid = msg.jid;
  conv.lid = msg.lid || conv.lid;
  conv.phoneKnown = !!msg.phone;
  if (!conv.name && msg.name) conv.name = msg.name;
  const nameBefore = conv.name;
  const media = { type: msg.kind, mediaId: msg.mediaId, caption: msg.caption, waId: msg.waId };

  // Pengiriman ulang (id WA sama): pesan yang sudah selesai diproses dilewati; yang belum dilanjutkan.
  const prior = msg.waId ? conv.messages.find((x) => x.waId === msg.waId && x.by === (msg.fromPhone ? 'admin' : 'customer')) : null;
  if (prior?.handled) return { conv, message: prior, replies: [], lead: null, changes: null, attention: null, duplicate: true };

  // Pesan dari HP admin: auto-takeover, tidak masuk CRM.
  if (msg.fromPhone) {
    const m = prior || d.convs.addMessage(conv, 'admin', msg.text, msg.ts);
    Object.assign(m, media, { sender: 'HP' });
    durable(d, conv); // simpan dulu (lempar galat bila gagal) sebelum efek lain
    if (S.autoTakeoverOnPhoneReply && conv.mode === 'bot') {
      setMode(conv, 'admin', now);
      d.convs.addMessage(conv, 'system', 'Admin membalas dari HP. Bot dinonaktifkan untuk percakapan ini.', now);
    }
    conv.adminLastAt = Math.max(conv.adminLastAt || 0, msg.ts || now); // pengatur waktu bot aktif kembali
    conv.needsAttention = false;
    conv.attentionReason = null;
    conv.attentionAt = null;
    const lead = findLead(d, msg.phone, msg.lid);
    if (lead) d.leads.update(lead.id, { lastReplyAt: msg.ts });
    m.handled = true;
    d.convs.save();
    d.emit('message:new', { phone: key, by: 'admin', type: msg.kind });
    return { conv, message: m, replies: [], lead, changes: null, attention: null };
  }

  // Pesan pelanggan.
  // Nomor baru = belum ada lead (phone/lid) dan belum ada pesan pelanggan sebelumnya. Dihitung SEBELUM
  // ingest membuat lead dan disimpan di pesan, supaya percobaan ulang konsisten.
  const earlierCustomer = conv.messages.some((m) => m.by === 'customer' && m.type !== 'reaction' && m.type !== 'system' && m !== prior);
  const message = prior || d.convs.addMessage(conv, 'customer', msg.text, msg.ts);
  if (!prior) {
    Object.assign(message, media);
    conv.unread = (conv.unread || 0) + 1;
    message.isNewNumber = !earlierCustomer && !findLead(d, msg.phone, msg.lid);
  }
  durable(d, conv); // pesan pelanggan tersimpan durable SEBELUM CRM/bot; gagal -> lempar, tidak ditandai seen
  const customerCount = conv.messages.filter((m) => m.by === 'customer' && m.type !== 'reaction' && m.type !== 'system').length;
  let res = null;
  if (!message.ingested) {
    res = d.ingest({
      phone: msg.phone, lid: msg.lid, name: conv.name || msg.name, text: msg.text,
      ts: msg.ts, customerCount, kind: msg.kind, source: msg.source,
    });
    message.ingested = true;
  }

  // Percobaan ulang: bila bot sudah membalas pesan ini, jangan membalas lagi (cegah respons ganda).
  const alreadyReplied = !!prior && conv.messages.slice(conv.messages.indexOf(prior) + 1).some((x) => x.by === 'bot');
  let p = { replies: [], attention: null };
  if (!alreadyReplied) {
    const crmLead = findLead(d, msg.phone, msg.lid) || res?.lead || null;
    const ctx = {
      isNewNumber: !!message.isNewNumber,
      crm: { referensi: String(crmLead?.referensi || ''), name: String(crmLead?.name || ''), phone: String(crmLead?.phone || '') },
    };
    p = (d.plan || plan)(conv, { text: msg.text, caption: msg.caption, kind: msg.kind, ts: msg.ts }, S, now, ctx);
  }
  if (p.referensi) message.referensi = String(p.referensi); // dipertahankan untuk percobaan ulang
  if (p.returnedToBot) {
    d.convs.addMessage(conv, 'system', `Admin tidak membalas lebih dari ${p.returnedToBot} menit. Bot aktif kembali untuk percakapan ini.`, now);
    conv.needsAttention = false;
    conv.attentionReason = null;
    conv.attentionAt = null;
  }
  if (p.attention) setAttention(d, conv, p.attention.reason, now);

  // Kirim berurutan; gagal -> berhenti tanpa commit. Balasan needsAi diselesaikan tepat sebelum dikirim.
  let attention = p.attention;
  const replies = [];
  for (const r0 of p.replies) {
    let r = r0, ai = null;
    if (r0.needsAi) {
      const x = await resolveAi(d, S, conv, msg, message, key, now);
      if (x.attention) {
        attention = { reason: x.attention };
        setAttention(d, conv, x.attention, now);
      }
      if (!x.send) {
        // Tidak ada yang dikirim (perilaku lama): tanpa balasan sama sekali dan bukan pesan pertama -> perlu perhatian.
        if (!x.attention && !replies.length && !p.replies.some((q) => q.kind === 'opening')) {
          attention = { reason: 'no_reply' };
          setAttention(d, conv, 'no_reply', now);
        }
        continue;
      }
      ai = x.send;
      r = {
        text: ai.text, kind: ai.kind, fieldId: r0.fieldId,
        commit: (c) => {
          r0.commit?.(c);
          if (ai.stamp) applyReplyEffect(c, 'fallback', undefined, now);
        },
      };
    }
    let sentOk = false;
    try {
      const { waId } = await sendRetry(d, conv.jid, r.text);
      sentOk = true;
      const m = d.convs.addMessage(conv, 'bot', r.text, d.now());
      Object.assign(m, { type: 'text', status: 'sent', waId, replyKind: r.kind, fieldId: r.fieldId });
      waIdToKey.set(waId, key);
      r.commit(conv);
      const l = findLead(d, msg.phone, msg.lid);
      if (l) d.leads.update(l.id, { lastReplyAt: d.now() });
      replies.push(m);
    } catch {
      if (ai?.kind === 'ai' && !sentOk) {
        delete message.aiText; // kuota dilepas, teks tidak dianggap terpakai
        await refundSafe(d, ai.aiKey, { afterCommit: true });
      }
      const m = d.convs.addMessage(conv, 'bot', r.text, d.now());
      Object.assign(m, { type: 'text', status: 'failed', replyKind: r.kind, fieldId: r.fieldId });
      replies.push(m);
      setAttention(d, conv, 'send_failed', now);
      break;
    }
  }

  // Sinkron nama/data/referensi ke lead. lead.phone TIDAK pernah diisi dari teks pelanggan.
  let lead = findLead(d, msg.phone, msg.lid) || res?.lead || null;
  if (lead) {
    const patch = {};
    const merged = { ...(lead.data || {}), ...conv.data };
    if (JSON.stringify(merged) !== JSON.stringify(lead.data || {})) patch.data = merged;
    // Jalur lama (kolom nama di Pengaturan, kini dimigrasikan keluar): hanya mengisi nama yang kosong, tidak menimpa.
    if (conv.name !== nameBefore && blankName(lead.name)) patch.name = conv.name;
    const ref = String(p.referensi || message.referensi || '').trim().slice(0, 50);
    if (ref && ref !== lead.referensi) patch.referensi = ref;
    const wa = cleanWaName(msg.name);
    if (wa && wa !== lead.waName) patch.waName = wa;
    // Nama dari WhatsApp hanya mengisi nama yang kosong; tidak menimpa nama yang sudah ada atau hasil edit admin.
    const waNow = wa || cleanWaName(lead.waName);
    if (waNow && blankName(patch.name ?? lead.name)) patch.name = waNow;
    if (Object.keys(patch).length) {
      d.leads.update(lead.id, patch);
      lead = findLead(d, msg.phone, msg.lid) || lead;
    }
  }
  message.handled = true; // selesai: balasan terkirim atau gagal tercatat (status failed + perlu perhatian)
  d.convs.save();
  d.emit('message:new', { phone: key, by: 'customer', type: msg.kind });
  d.emit('unread', { total: d.convs.totalUnread() });
  return { conv, message, replies, lead, changes: res?.changes, attention };
}

// Antrean serial per kunci percakapan.
const queues = new Map();
export function handleIncoming(msg, send, deps = null) { // deps: hanya untuk tes (dependensi palsu)
  const k = msg.phone || msg.lid || '';
  const prev = queues.get(k) || Promise.resolve();
  const run = prev.then(() => processIncoming(msg, deps || makeRealDeps(send)));
  // Antrean tetap jalan walau satu pesan gagal; pemanggil menerima galatnya (tidak ditelan)
  // supaya pesan yang gagal diproses tidak ditandai seen dan bisa dicoba ulang.
  const tail = run.catch(() => {}).finally(() => {
    if (queues.get(k) === tail) queues.delete(k);
  });
  queues.set(k, tail);
  return run;
}

function findByWaId(d, waId) {
  const hit = (c) => c?.messages?.find((m) => m.waId === waId && m.by === 'bot');
  const c0 = d.convs.get(waIdToKey.get(waId));
  if (hit(c0)) return { conv: c0, m: hit(c0) };
  for (const row of d.convs.list()) {
    const c = d.convs.get(row.phone);
    if (hit(c)) return { conv: c, m: hit(c) };
  }
  return null;
}

/** Status kirim/baca dari WA. Tidak pernah menurunkan status. deps opsional (untuk tes). */
export function onStatusUpdate({ waId, status }, d = makeRealDeps(null)) {
  const f = findByWaId(d, waId);
  if (!f) return;
  const { conv, m } = f;
  if (status === 'failed') {
    if ((RANK[m.status] ?? 0) <= RANK.sent) m.status = 'failed';
    setAttention(d, conv, 'send_failed', d.now());
  } else if ((RANK[status] ?? -1) > (RANK[m.status] ?? -1)) m.status = status;
  d.convs.save();
}

/** Kirim ulang pesan bot yang gagal; efek keluaran diterapkan setelah sukses. */
export async function resendMessage(conv, messageId, send, d = makeRealDeps(send)) {
  const m = conv.messages.find((x) => x.id === messageId && x.by === 'bot' && x.status === 'failed');
  if (!m) throw Object.assign(new Error('Pesan tidak berstatus gagal'), { code: 'NOT_FAILED' });
  const { waId } = await sendRetry(d, conv.jid, m.text);
  m.status = 'sent';
  m.waId = waId;
  waIdToKey.set(waId, conv.phone);
  applyReplyEffect(conv, m.replyKind, m.fieldId, d.now());
  if (conv.attentionReason === 'send_failed') {
    conv.needsAttention = false;
    conv.attentionReason = null;
    conv.attentionAt = null;
  }
  d.convs.save();
  return m;
}
