// Pengaturan bot: nama, pesan, durasi, kata salam, format nomor, pertanyaan referensi, AI + basis pengetahuan, notifikasi.
// Versi + riwayat (maks 20) untuk deteksi konflik dan pemulihan.
// Kunci API AI TIDAK ada di sini: disimpan terpisah di ai-secret.js (tidak masuk riwayat/publicView/audit).
import { randomBytes } from 'node:crypto';
import { load, save } from './jsonfile.js';
import { hasAiKey } from './ai-secret.js';
import { AGENT_DEFAULTS } from './crm-agent.js';
import { normalizeHex, checkBase } from '../public/assets/js/brand-color.js';

const OPENING_LAMA = 'Halo {nama}, selamat datang. Saya {bot}, asisten virtual yang membantu {admin}. Ada yang bisa kami bantu?';
const MASK = '••••';
const HISTORY_MAX = 20;
export const WA_PROVIDERS = ['baileys', 'convia'];
export const AI_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openai-compatible'];
export const PHONE_FORMATS = ['digits', 'international'];
// Batas basis pengetahuan (kontrak [Setting]). "Total" dihitung dari judul + isi semua entri.
export const KNOWLEDGE_LIMITS = { entries: 200, title: 120, content: 20000, total: 200000 };
const GREETING_LIMITS = { words: 100, chars: 40 };
// [min, maks] angka pengaturan AI; nilai di luar rentang dipotong ke batas terdekat.
const AI_RANGES = { maxHistory: [0, 30], maxReplyChars: [50, 2000], timeoutMs: [3000, 120000], monthlyQuota: [0, 1000000], perCustomerDailyLimit: [0, 1000] };
const GREETING_DEFAULT = [
  'halo', 'hallo', 'hai', 'hi', 'hello', 'hey', 'permisi', 'assalamualaikum', "assalamu'alaikum", 'salam',
  'selamat pagi', 'selamat siang', 'selamat sore', 'selamat malam', 'pagi', 'siang', 'sore', 'malam', 'p',
];
export const CONVIA_WEBHOOK_PATH = '/webhooks/convia';

export const DEFAULTS = {
  // Nama/tagline awal untuk instance baru: diisi dari .env (BRAND_NAME, BRAND_TAGLINE). Setelah
  // pengaturan tersimpan, nilai di data/settings.json yang dipakai dan bisa diubah dari dashboard.
  brandName: String(process.env.BRAND_NAME ?? '').trim().slice(0, 60) || 'Amnan',
  brandTagline: String(process.env.BRAND_TAGLINE ?? '').trim().slice(0, 100),
  // Warna utama brand (#RRGGBB). Kosong = palet biru bawaan. Dari .env: BRAND_COLOR (hanya nilai awal).
  brandColor: normalizeHex(process.env.BRAND_COLOR) && !checkBase(process.env.BRAND_COLOR) ? normalizeHex(process.env.BRAND_COLOR) : '',
  botEnabled: true,
  // Koneksi WhatsApp: 'baileys' (scan QR, bawaan) | 'convia' (API resmi). Env WA_PROVIDER, bila diisi, menang.
  // Perubahan baru berlaku setelah server di-restart.
  waProvider: 'baileys',
  botName: 'Asisten Virtual',
  adminName: 'Admin',
  openingMessage: 'Halo {nama}, selamat datang. Saya {bot}, yang membantu {admin} menjawab pesan Anda. Ada yang bisa kami bantu?',
  fallbackMessage: 'Terima kasih, pesan Anda sudah kami terima. {admin} akan segera menindaklanjuti.',
  handoverMessage: 'Percakapan ini dilanjutkan oleh {admin}. Mohon tunggu balasan kami.',
  completionMessage: 'Terima kasih, data Anda sudah kami catat.',
  botDurationMinutes: 0, // 0 = tanpa batas
  staleMinutes: 10,
  autoTakeoverOnPhoneReply: true,
  adminAutoReturnMinutes: 0, // 0 = mati: tetap mode admin sampai dikembalikan manual
  fallbackCooldownMinutes: 30,
  sendRateLimitPerMinute: 20,
  maxMediaMB: 16,
  retentionDays: 0, // 0 = simpan selamanya
  notify: { webhookUrl: '', telegramBotToken: '', telegramChatId: '', onHot: true, onDisconnected: true, attentionMinutes: 30 },
  // Kata salam: pesan nomor lama hanya memicu pembuka bila salah satunya muncul di 3 kata pertama ('p' hanya bila seluruh pesan).
  greetingWords: [...GREETING_DEFAULT],
  // Hanya tampilan nomor: 'digits' (6281381688802) | 'international' (+62 813-8168-8802).
  phoneFormat: 'digits',
  // Balasan AI. Kunci API ada di ai-secret.js, bukan di sini.
  ai: {
    enabled: false,
    provider: 'anthropic',
    baseUrl: '',
    model: '',
    persona: '',
    rules: '',
    maxHistory: 10,
    maxReplyChars: 600,
    timeoutMs: 20000,
    monthlyQuota: 1000,
    perCustomerDailyLimit: 20,
    quotaExhaustedMessage: 'Terima kasih, pesan Anda kami teruskan ke admin.',
    errorMessage: '',
  },
  // Agen CRM: formulir data saat lead Hot + follow up DP (maks 2). Lihat src/crm-agent.js.
  crmAgent: structuredClone(AGENT_DEFAULTS),
  // Basis pengetahuan untuk AI: [{ id, title, content, enabled }] (batas di KNOWLEDGE_LIMITS).
  knowledge: [],
  // Hanya satu butir: pertanyaan referensi. Field lama (nama, nomor, dll.) dimigrasikan keluar; data lead tidak dihapus.
  requiredFields: [
    { id: 'referensi', type: 'text', enabled: true, question: 'Boleh tahu, Kakak mengetahui kami dari mana?' },
  ],
  version: 1,
  updatedAt: 0,
  updatedBy: '',
};

const META = new Set(['version', 'updatedAt', 'updatedBy']);
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const clampInt = (v, min, max, def) => {
  let n = Math.floor(Number(v));
  if (!Number.isFinite(n)) n = def;
  return Math.min(max, Math.max(min, n));
};
const slug = (s) =>
  str(s, 60).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const err = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

function uniq(list) {
  const seen = new Set();
  for (const x of list) {
    let id = x.id || slug(x.label || x.name || x.title);
    while (!id || seen.has(id)) id = (slug(x.label || x.name || x.title) || 'item') + '-' + randomBytes(3).toString('hex');
    x.id = id;
    seen.add(id);
  }
  return list;
}

// ---- validasi URL webhook (anti-SSRF) ----
function ipv6Groups(h) {
  let s = h;
  if (s.includes('.')) {
    const m = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
    if (!m) return null;
    const hex = (a, b) => ((a << 8) | b).toString(16);
    s = m[1] + hex(+m[2], +m[3]) + ':' + hex(+m[4], +m[5]);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null;
  const g = [...head, ...Array(fill).fill('0'), ...tail].map((x) => (/^[0-9a-f]{1,4}$/i.test(x) ? parseInt(x, 16) : NaN));
  return g.length === 8 && g.every((n) => n >= 0) ? g : null;
}

function blockedV6(h) {
  const g = ipv6Groups(h);
  if (!g) return true;
  if (g.slice(0, 6).every((n) => n === 0)) return true; // ::, ::1, IPv4-compatible
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return true; // IPv4-mapped
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  return false;
}

function blockedV4(h) {
  const [a, b] = h.split('.').map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function checkWebhook(v) {
  const raw = str(v, 600);
  if (raw === '') return '';
  const bad = () => err('VALIDATION', 'URL webhook tidak valid: gunakan http(s) ke alamat publik.');
  let u;
  try { u = new URL(raw); } catch { throw bad(); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad();
  if (raw.length > 500) throw bad();
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    if (blockedV6(host.slice(1, -1))) throw bad();
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (blockedV4(host)) throw bad();
  } else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host) {
    throw bad();
  }
  return raw;
}

// ---- pengaturan AI ----
// URL dasar penyedia (opsional; kosong = alamat bawaan penyedia). Boleh alamat lokal (mis. model di laptop),
// tetapi tanpa kredensial/parameter/fragmen supaya tidak ada rahasia terselip di pengaturan yang terlihat browser.
function checkAiBaseUrl(v) {
  const full = String(v ?? '').trim();
  if (full === '') return '';
  const bad = () => err('VALIDATION', 'URL dasar AI tidak valid: gunakan http(s) tanpa kredensial, parameter, atau fragmen (maks 300 karakter).');
  if (full.length > 300) throw bad();
  let u;
  try { u = new URL(full); } catch { throw bad(); }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password || u.search || u.hash) throw bad();
  return full.replace(/\/+$/, '');
}

const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// strict=true (PUT/restore): nilai tak valid -> galat VALIDATION. strict=false (muat berkas): nilai tak valid diabaikan.
// Hanya field yang dikenal yang dibaca: apa pun lain di `p` (mis. apiKey yang terselip) dibuang.
function cleanAi(p, base, strict = true) {
  const a = { ...base };
  const src = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  const fail = (e) => { if (strict) throw e; };
  if ('enabled' in src) a.enabled = !!src.enabled;
  if ('provider' in src) {
    if (typeof src.provider === 'string' && AI_PROVIDERS.includes(src.provider.trim())) a.provider = src.provider.trim();
    else fail(err('VALIDATION', `Penyedia AI tidak valid: pilih ${AI_PROVIDERS.join(', ')}.`));
  }
  if ('baseUrl' in src) {
    try { a.baseUrl = checkAiBaseUrl(src.baseUrl); } catch (e) { fail(e); }
  }
  if ('model' in src) a.model = oneLine(src.model, 100); // teks bebas: bukan daftar tetap
  if ('persona' in src) a.persona = str(src.persona, 2000);
  if ('rules' in src) a.rules = str(src.rules, 4000);
  for (const [k, [min, max]] of Object.entries(AI_RANGES)) {
    if (k in src) a[k] = clampInt(src[k], min, max, DEFAULTS.ai[k]);
  }
  if ('quotaExhaustedMessage' in src) a.quotaExhaustedMessage = str(src.quotaExhaustedMessage, 1000) || DEFAULTS.ai.quotaExhaustedMessage;
  if ('errorMessage' in src) a.errorMessage = str(src.errorMessage, 1000);
  if (strict && a.enabled) {
    if (!a.model) throw err('VALIDATION', 'Isi nama model sebelum mengaktifkan balasan AI.');
    if (a.provider === 'openai-compatible' && !a.baseUrl) throw err('VALIDATION', "Penyedia 'openai-compatible' wajib mengisi URL dasar.");
  }
  return a;
}

const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Basis pengetahuan. strict=true: lebih dari batas -> galat VALIDATION (isi pengguna tidak dipotong diam-diam).
// strict=false (muat berkas): entri rusak dibuang, kelebihan dipotong.
function cleanKnowledge(list, strict = true) {
  const L = KNOWLEDGE_LIMITS;
  const errors = [];
  const arr = Array.isArray(list) ? list : [];
  if (strict && arr.length > L.entries) errors.push(`Maksimal ${L.entries} entri basis pengetahuan.`);
  const out = [];
  let total = 0;
  arr.slice(0, L.entries).forEach((e, i) => {
    const o = e && typeof e === 'object' ? e : {};
    let title = oneLine(o.title, strict ? Infinity : L.title);
    let content = String(o.content ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
    if (!strict) content = content.slice(0, L.content);
    const n = i + 1;
    if (!title) { if (strict) errors.push(`Entri ${n}: judul wajib diisi.`); return; }
    if (!content) { if (strict) errors.push(`Entri ${n}: isi wajib diisi.`); return; }
    if (title.length > L.title) errors.push(`Entri ${n}: judul maksimal ${L.title} karakter.`);
    if (content.length > L.content) errors.push(`Entri ${n}: isi maksimal ${fmtNum(L.content)} karakter.`);
    if (total + title.length + content.length > L.total) {
      if (strict) errors.push(`Total basis pengetahuan maksimal ${fmtNum(L.total)} karakter.`);
      return;
    }
    total += title.length + content.length;
    out.push({ id: slug(o.id), title, content, enabled: o.enabled !== false });
  });
  if (strict && errors.length) throw err('VALIDATION', [...new Set(errors)].slice(0, 5).join(' '));
  return uniq(out);
}

function cleanGreetingWords(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]/);
  const out = [];
  for (const x of list) {
    const w = String(x ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, GREETING_LIMITS.chars);
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= GREETING_LIMITS.words) break;
  }
  return out;
}

// Selalu tepat satu butir 'referensi'. Hanya butir ber-id 'referensi' yang dibaca; yang lain (field lama) dibuang
// dan bila tidak ada, nilai `base` dipertahankan. Nilai di lead TIDAK disentuh di sini.
function cleanRequired(list, base) {
  const cur = base?.requiredFields?.[0] ?? DEFAULTS.requiredFields[0];
  const d = DEFAULTS.requiredFields[0];
  const item = Array.isArray(list) ? list.find((f) => f && typeof f === 'object' && slug(f.id) === 'referensi') : null;
  return [{
    id: 'referensi',
    type: 'text',
    enabled: item ? item.enabled !== false : cur.enabled !== false,
    question: item ? str(item.question, 500) || d.question : str(cur.question, 500) || d.question,
  }];
}

// ---- agen CRM ----
function cleanAgent(p, base) {
  const b = { ...AGENT_DEFAULTS, ...(base || {}) };
  const x = p && typeof p === 'object' ? p : {};
  const o = { ...b };
  if ('enabled' in x) o.enabled = !!x.enabled;
  for (const k of ['askBooking', 'autoSubmit']) if (k in x) o[k] = !!x[k];
  if ('remindersEnabled' in x) o.remindersEnabled = !!x.remindersEnabled;
  for (const k of ['formIntro', 'dpMessage', 'proofMessage', 'dpNotReceivedMessage', 'reminderH1Message', 'reminderH0Message']) if (k in x) o[k] = str(x[k], 1000) || AGENT_DEFAULTS[k];
  if ('dpAmount' in x) o.dpAmount = str(x.dpAmount, 60);
  if ('bankAccounts' in x) o.bankAccounts = str(x.bankAccounts, 600);
  for (const k of ['reminderH1Time', 'reminderH0Time']) if (k in x) o[k] = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(x[k]).trim()) ? String(x[k]).trim() : AGENT_DEFAULTS[k];
  if (Array.isArray(x.followUpDelaysMinutes)) o.followUpDelaysMinutes = [clampInt(x.followUpDelaysMinutes[0], 5, 10080, AGENT_DEFAULTS.followUpDelaysMinutes[0])];
  if (Array.isArray(x.followUpMessages)) o.followUpMessages = [str(x.followUpMessages[0], 1000) || AGENT_DEFAULTS.followUpMessages[0]];
  return o;
}

// ---- pembersihan input ----
function clean(p, base) {
  const o = {};
  for (const [k, max] of [['brandName', 60], ['brandTagline', 100], ['botName', 60], ['adminName', 60]]) if (k in p) o[k] = str(p[k], max) || DEFAULTS[k];
  if ('brandColor' in p) {
    const raw = str(p.brandColor, 20);
    if (raw === '') o.brandColor = '';
    else {
      const bad = checkBase(raw);
      if (bad) throw err('VALIDATION', bad);
      o.brandColor = normalizeHex(raw);
    }
  }
  if ('waProvider' in p) {
    // enum ketat: hanya string persis 'baileys' | 'convia' (nilai lain ditolak, bukan diam-diam diganti)
    if (typeof p.waProvider !== 'string' || !WA_PROVIDERS.includes(p.waProvider.trim())) {
      throw err('VALIDATION', "Koneksi WhatsApp tidak valid: pilih 'baileys' atau 'convia'.");
    }
    o.waProvider = p.waProvider.trim();
  }
  for (const k of ['openingMessage', 'fallbackMessage', 'handoverMessage', 'completionMessage']) if (k in p) o[k] = str(p[k], 2000);
  for (const k of ['botEnabled', 'autoTakeoverOnPhoneReply']) if (k in p) o[k] = !!p[k];
  for (const [k, min, max] of [['botDurationMinutes', 0, 10080], ['adminAutoReturnMinutes', 0, 10080], ['staleMinutes', 1, 1440], ['fallbackCooldownMinutes', 0, 1440], ['sendRateLimitPerMinute', 1, 120], ['maxMediaMB', 1, 64], ['retentionDays', 0, 3650]]) {
    if (k in p) o[k] = clampInt(p[k], min, max, DEFAULTS[k]);
  }
  if ('phoneFormat' in p) {
    if (typeof p.phoneFormat !== 'string' || !PHONE_FORMATS.includes(p.phoneFormat.trim())) {
      throw err('VALIDATION', "Format nomor tidak valid: pilih 'digits' atau 'international'.");
    }
    o.phoneFormat = p.phoneFormat.trim();
  }
  if (Array.isArray(p.greetingWords) || typeof p.greetingWords === 'string') o.greetingWords = cleanGreetingWords(p.greetingWords);
  if (p.notify && typeof p.notify === 'object') {
    const n = p.notify;
    const x = { ...base.notify };
    if ('webhookUrl' in n) x.webhookUrl = checkWebhook(n.webhookUrl);
    if ('telegramBotToken' in n) {
      const t = str(n.telegramBotToken, 200);
      if (!t.startsWith(MASK)) x.telegramBotToken = t; // berawalan •••• = tidak diubah
    }
    if ('telegramChatId' in n) x.telegramChatId = str(n.telegramChatId, 64);
    for (const k of ['onHot', 'onDisconnected']) if (k in n) x[k] = !!n[k];
    if ('attentionMinutes' in n) x.attentionMinutes = clampInt(n.attentionMinutes, 1, 1440, DEFAULTS.notify.attentionMinutes);
    o.notify = x;
  }
  if (p.ai && typeof p.ai === 'object' && !Array.isArray(p.ai)) o.ai = cleanAi(p.ai, base.ai, true);
  if (p.crmAgent && typeof p.crmAgent === 'object' && !Array.isArray(p.crmAgent)) o.crmAgent = cleanAgent(p.crmAgent, base.crmAgent);
  if ('knowledge' in p) {
    if (!Array.isArray(p.knowledge)) throw err('VALIDATION', 'Basis pengetahuan harus berupa daftar entri.');
    o.knowledge = cleanKnowledge(p.knowledge, true);
  }
  if (Array.isArray(p.requiredFields)) o.requiredFields = cleanRequired(p.requiredFields, base);
  return o;
}

// ---- migrasi skema lama -> skema AI (intents/slangMap/requiredFields lama) ----
// Intent lama jadi entri basis pengetahuan: judul = nama (atau kata kunci), isi = "Pertanyaan: <kata kunci>\nJawaban: <respons>".
// Aturan: tidak menimpa data baru (entri yang id-nya sudah ada dipertahankan), idempoten (berjalan hanya bila kunci
// lama masih ada di berkas), contoh bawaan yang belum diisi ("[ISI: ...]") tidak dipindahkan karena bukan isi pengguna.
function intentsToKnowledge(intents, existing) {
  const L = KNOWLEDGE_LIMITS;
  const out = [...existing];
  const ids = new Set(out.map((x) => x.id));
  let total = out.reduce((n, x) => n + x.title.length + x.content.length, 0);
  const r = { entries: out, moved: 0, kept: 0, skipped: 0, templates: 0 };
  for (const i of intents) {
    if (!i || typeof i !== 'object') continue;
    const response = String(i.response ?? '').replace(/\u0000/g, '').trim();
    if (!response) continue;
    if (i.example === true && /^\[ISI:/.test(response)) { r.templates++; continue; }
    const kws = (Array.isArray(i.keywords) ? i.keywords : String(i.keywords ?? '').split(/[,;|\n]/)).map((k) => oneLine(k, 60)).filter(Boolean);
    const title = oneLine(i.name, L.title) || oneLine(kws.join(', '), L.title);
    if (!title) continue;
    const id = ('intent-' + (slug(i.id) || slug(i.name) || 'x')).slice(0, 40);
    if (ids.has(id)) { r.kept++; continue; }
    const content = `Pertanyaan: ${kws.length ? kws.join(', ') : title}\nJawaban: ${response}`.slice(0, L.content);
    if (out.length >= L.entries || total + title.length + content.length > L.total) { r.skipped++; continue; }
    total += title.length + content.length;
    ids.add(id);
    out.push({ id, title, content, enabled: i.active !== false });
    r.moved++;
  }
  return r;
}

function migrateLegacy(saved) {
  const data = { ...saved };
  const notes = [];
  if ('intents' in saved || 'slangMap' in saved) {
    const m = intentsToKnowledge(Array.isArray(saved.intents) ? saved.intents : [], cleanKnowledge(saved.knowledge, false));
    data.knowledge = m.entries;
    delete data.intents;
    delete data.slangMap;
    let n = `${m.moved} intent lama dipindahkan ke basis pengetahuan; kamus bahasa gaul dihapus`;
    if (m.templates) n += `; ${m.templates} contoh intent yang belum diisi dibuang`;
    if (m.kept) n += `; ${m.kept} intent dilewati karena entri baru dengan id sama sudah ada`;
    if (m.skipped) n += `; ${m.skipped} intent tidak muat di batas basis pengetahuan`;
    notes.push(n);
  }
  if ('requiredFields' in saved) {
    const canon = cleanRequired(saved.requiredFields, DEFAULTS);
    if (JSON.stringify(canon) !== JSON.stringify(saved.requiredFields)) {
      notes.push("data wajib disederhanakan menjadi satu butir 'referensi' (nilai di lead tidak dihapus)");
    }
    data.requiredFields = canon;
  }
  return { data, notes };
}

// ---- muat + normalisasi (tanpa menimpa pengaturan pengguna) ----
function normalize(saved) {
  const s = { ...structuredClone(DEFAULTS), ...saved };
  delete s.intents; // skema lama: sudah dimigrasikan ke knowledge
  delete s.slangMap;
  s.notify = { ...DEFAULTS.notify, ...(saved.notify && typeof saved.notify === 'object' ? saved.notify : {}) };
  s.ai = cleanAi(saved.ai, DEFAULTS.ai, false);
  s.crmAgent = cleanAgent(saved.crmAgent, DEFAULTS.crmAgent);
  s.knowledge = cleanKnowledge(saved.knowledge, false);
  s.greetingWords = Array.isArray(saved.greetingWords) ? cleanGreetingWords(saved.greetingWords) : [...DEFAULTS.greetingWords];
  s.phoneFormat = PHONE_FORMATS.includes(saved.phoneFormat) ? saved.phoneFormat : DEFAULTS.phoneFormat;
  s.requiredFields = cleanRequired(saved.requiredFields, DEFAULTS);
  if (!WA_PROVIDERS.includes(s.waProvider)) s.waProvider = DEFAULTS.waProvider; // berkas lama/rusak -> bawaan
  s.version = Number.isInteger(saved.version) && saved.version >= 1 ? saved.version : 1;
  return s;
}

const saved = load('settings.json', {});
if (saved.brandName === 'Amnan SaaS') delete saved.brandName; // default lama
if (saved.openingMessage === OPENING_LAMA) delete saved.openingMessage; // teks lama redundan
const original = structuredClone(saved);
const migration = migrateLegacy(saved);
let cur = normalize(migration.data);

export const get = () => cur;

const readHistory = () => {
  const h = load('settings.history.json', []);
  return Array.isArray(h) ? h : [];
};

// Simpan hasil migrasi sebagai versi BARU: isi sebelum migrasi (masih memuat intents/slangMap lama) masuk riwayat
// dengan catatan, jadi tidak ada data yang hilang. Gagal menyimpan (mis. berkas terblokir) -> dipakai di memori saja.
function persistMigration(notes) {
  const oldVersion = cur.version;
  try {
    const hist = readHistory();
    hist.push({ version: oldVersion, ts: original.updatedAt || Date.now(), by: original.updatedBy || '', note: `Sebelum migrasi otomatis: ${notes.join('. ')}.`, settings: original });
    save('settings.history.json', hist.slice(-HISTORY_MAX));
    cur = { ...cur, version: oldVersion + 1, updatedAt: Date.now(), updatedBy: 'migrasi' };
    save('settings.json', cur);
  } catch (e) {
    console.error(`[settings] migrasi belum tersimpan (dipakai di memori): ${e.message}`);
  }
}
if (migration.notes.length) persistMigration(migration.notes);

function apply(patch, by) {
  const next = { ...cur, ...clean(patch || {}, cur) }; // galat validasi -> tidak ada perubahan
  const hist = readHistory();
  hist.push({ version: cur.version, ts: cur.updatedAt || Date.now(), by: cur.updatedBy || '', settings: cur });
  save('settings.history.json', hist.slice(-HISTORY_MAX));
  next.version = cur.version + 1;
  next.updatedAt = Date.now();
  next.updatedBy = str(by, 60);
  cur = next;
  save('settings.json', cur);
  return cur;
}

export function update(patch, { expectedVersion = null, by = '' } = {}) {
  if (expectedVersion != null && Number(expectedVersion) !== cur.version) {
    throw err('CONFLICT', 'Pengaturan diubah orang lain.', { current: cur });
  }
  return apply(patch, by);
}

export const history = () => readHistory().map(({ version, ts, by, note }) => ({ version, ts, by, ...(note ? { note } : {}) }));

// Terapkan snapshot lama sebagai versi BARU.
export function restore(version, { by = '' } = {}) {
  const h = readHistory().find((x) => x.version === Number(version));
  if (!h) throw err('NOT_FOUND', 'Versi pengaturan tidak ditemukan.');
  const patch = Object.fromEntries(Object.entries(h.settings).filter(([k]) => !META.has(k)));
  return apply(patch, by);
}

// Info Convia untuk klien: HANYA boolean/alamat publik, tidak pernah nilai key atau secret.
// Env dibaca saat dipanggil (bukan saat impor) supaya perubahan .env + restart dan tes konsisten.
function conviaInfo() {
  const env = (k) => String(process.env[k] ?? '').trim();
  const publicUrl = env('PUBLIC_URL').replace(/\/+$/, '');
  const override = env('WA_PROVIDER').toLowerCase();
  return {
    configured: !!env('CONVIA_API_KEY') && !!(env('CONVIA_WEBHOOK_SECRET') || env('CONVIA_SIGNING_SECRET')),
    webhookPath: CONVIA_WEBHOOK_PATH,
    publicUrl: /^https?:\/\//i.test(publicUrl) ? publicUrl : '', // bukan rahasia; kosong bila bukan http(s)
    envOverride: WA_PROVIDERS.includes(override) ? override : '', // WA_PROVIDER di .env mengalahkan pengaturan ini
  };
}

// Salinan aman untuk klien: token Telegram dimasking; status Convia dan kunci AI hanya boolean.
export function publicView(S) {
  const v = structuredClone(S);
  const t = v.notify?.telegramBotToken;
  if (v.notify) v.notify.telegramBotToken = t ? MASK + String(t).slice(-4) : '';
  v.waProvider = WA_PROVIDERS.includes(v.waProvider) ? v.waProvider : DEFAULTS.waProvider;
  v.ai.hasKey = hasAiKey(); // hanya boolean: kunci tidak pernah keluar dari server
  v.convia = conviaInfo();
  return v;
}
