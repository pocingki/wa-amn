// Adaptor penyedia AI (B1): satu fungsi chat() untuk anthropic, openai, gemini, dan openai-compatible.
// Semua dependensi (fetch, waktu, timer) diinjeksi. Tidak ada logging di sini. Galat TIDAK pernah memuat
// kunci API, isi pesan, system prompt, URL, maupun teks galat mentah dari server (bisa memantulkan isi permintaan);
// teks galat server hanya dipakai untuk MENGENALI jenis galat, tidak pernah disalin ke keluaran.
//
// ASUMSI (dari pengetahuan publik penulis, BELUM diuji dengan layanan nyata; wajib diuji dengan kunci nyata):
// - anthropic: POST {base}/messages, base bawaan https://api.anthropic.com/v1; header x-api-key dan
//   anthropic-version: 2023-06-01; body {model, max_tokens, system, messages}; jawaban content[] bertipe 'text';
//   usage.input_tokens/output_tokens (+ cache_creation/cache_read_input_tokens dijumlahkan ke input bila ada).
//   Saldo habis = HTTP 400 dengan teks "credit balance is too low"; kelebihan beban = HTTP 529.
// - openai / openai-compatible: POST {base}/chat/completions, base bawaan (openai) https://api.openai.com/v1;
//   Authorization Bearer; system sebagai pesan pertama. 'openai' memakai max_completion_tokens (model baru menolak
//   max_tokens), 'openai-compatible' memakai max_tokens (paling luas didukung server lain). baseUrl openai-compatible
//   harus sudah memuat awalan versi bila server memerlukannya (mis. http://localhost:11434/v1).
//   Jawaban choices[0].message.content (string atau array bagian teks); usage.prompt_tokens/completion_tokens.
//   Saldo habis = code 'insufficient_quota' (HTTP 429) atau 'billing_hard_limit_reached'; HTTP 402 (mis. OpenRouter).
// - gemini: POST {base}/models/{model}:generateContent, base bawaan https://generativelanguage.googleapis.com/v1beta;
//   kunci lewat header x-goog-api-key (BUKAN di URL); systemInstruction + contents (peran 'user'/'model');
//   jawaban candidates[0].content.parts[].text; usageMetadata.promptTokenCount / candidatesTokenCount
//   (+ thoughtsTokenCount dihitung sebagai keluaran). Kunci salah = HTTP 400 dengan alasan API_KEY_INVALID.
// - Header Retry-After berupa detik (bilangan bulat) atau tanggal HTTP; selain itu retryAfterMs = null.
// - Model yang berpikir (reasoning) bisa menghabiskan batas token kecil sehingga teks kosong; pada testConnection
//   hal itu dianggap koneksi BERHASIL (server menjawab dan kunci/model diterima).
// - openai-compatible boleh tanpa kunci (mis. server lokal): header Authorization dihilangkan.

export const PROVIDERS = ['anthropic', 'openai', 'gemini', 'openai-compatible'];

const DEFAULT_BASE = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_TOKENS = 1024;
const TEST_MAX_TOKENS = 16;

const MESSAGES = {
  auth: 'Kunci API penyedia AI ditolak. Periksa kunci API dan hak aksesnya.',
  rate_limit: 'Batas permintaan penyedia AI tercapai. Coba lagi beberapa saat.',
  quota_provider: 'Saldo atau kuota akun penyedia AI habis. Periksa tagihan di akun penyedia.',
  timeout: 'Penyedia AI tidak menjawab tepat waktu. Coba lagi.',
  unreachable: 'Tidak bisa menjangkau penyedia AI. Periksa koneksi internet dan Base URL.',
  bad_request: 'Permintaan ke penyedia AI tidak valid. Periksa nama model dan pengaturan.',
  not_found: 'Model atau alamat tidak ditemukan di penyedia AI. Periksa nama model dan Base URL.',
  server: 'Server penyedia AI bermasalah. Coba lagi nanti.',
  bad_body: 'Respons penyedia AI tidak dapat dibaca.',
  empty: 'Penyedia AI tidak mengembalikan jawaban.',
};

export class AiError extends Error {
  constructor(kind, { message, http = null, retryAfterMs = null } = {}) {
    super(message || MESSAGES[kind] || 'Galat penyedia AI.');
    this.name = 'AiError';
    this.kind = kind;
    this.http = http;
    this.retryAfterMs = retryAfterMs;
  }
}

const bad = (message) => new AiError('bad_request', { message });

// ---------- validasi dan normalisasi masukan ----------

function cleanBase(provider, baseUrl) {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!raw) {
    if (provider === 'openai-compatible') throw bad('Base URL wajib diisi untuk penyedia OpenAI-compatible.');
    return DEFAULT_BASE[provider];
  }
  let u;
  try { u = new URL(raw); } catch { throw bad('Base URL tidak valid.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('Base URL harus diawali http:// atau https://.');
  // Tanpa kredensial/query di URL: supaya rahasia tidak pernah ikut tercetak di log infrastruktur.
  if (u.username || u.password) throw bad('Base URL tidak boleh memuat nama pengguna atau kata sandi.');
  if (u.search || u.hash) throw bad('Base URL tidak boleh memuat parameter query atau fragmen.');
  return raw.replace(/\/+$/, '');
}

function cleanKey(provider, apiKey) {
  const k = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!k) {
    if (provider === 'openai-compatible') return '';
    throw new AiError('auth', { message: 'Kunci API penyedia AI belum diisi.' });
  }
  // Karakter di luar ASCII tercetak membuat fetch melempar galat header (yang bisa memantulkan nilainya).
  if (!/^[\x21-\x7E]+$/.test(k)) throw new AiError('auth', { message: 'Kunci API berisi karakter yang tidak valid.' });
  return k;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) throw bad('Daftar pesan percakapan tidak valid.');
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw bad('Format pesan percakapan tidak valid.');
    }
    // Pesan kosong ditolak hampir semua penyedia; dibuang diam-diam (mis. media tanpa caption).
    if (m.content.trim()) out.push({ role: m.role, content: m.content });
  }
  if (!out.length) throw bad('Tidak ada pesan untuk dikirim ke penyedia AI.');
  return out;
}

function prepare(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const provider = c.provider;
  if (!PROVIDERS.includes(provider)) throw bad('Penyedia AI tidak dikenal.');
  if (typeof (c.fetchImpl ?? fetch) !== 'function') throw bad('Implementasi fetch tidak tersedia.');
  const model = typeof c.model === 'string' ? c.model.trim() : '';
  if (!model) throw bad('Nama model wajib diisi.');
  const mt = Number(c.maxTokens);
  const to = Number(c.timeoutMs);
  return {
    provider,
    key: cleanKey(provider, c.apiKey),
    base: cleanBase(provider, c.baseUrl),
    model, // teks bebas dari pengguna: diteruskan apa adanya (hanya spasi tepi dipangkas)
    system: typeof c.system === 'string' ? c.system.trim() : '',
    messages: cleanMessages(c.messages),
    maxTokens: Number.isFinite(mt) && mt >= 1 ? Math.floor(mt) : DEFAULT_MAX_TOKENS,
    timeoutMs: Number.isFinite(to) && to > 0 ? to : DEFAULT_TIMEOUT_MS,
    fetchImpl: c.fetchImpl ?? fetch,
    now: typeof c.now === 'function' ? c.now : Date.now,
    setTimer: typeof c.setTimer === 'function' ? c.setTimer : setTimeout,
    clearTimer: typeof c.clearTimer === 'function' ? c.clearTimer : clearTimeout,
  };
}

// ---------- pembentuk permintaan per penyedia ----------

const BUILD = {
  anthropic(c) {
    const body = { model: c.model, max_tokens: c.maxTokens, messages: c.messages };
    if (c.system) body.system = c.system; // system terpisah dari messages
    return {
      url: `${c.base}/messages`,
      headers: { 'x-api-key': c.key, 'anthropic-version': ANTHROPIC_VERSION },
      body,
    };
  },

  openai(c) {
    return {
      url: `${c.base}/chat/completions`,
      headers: { Authorization: `Bearer ${c.key}` },
      body: { model: c.model, max_completion_tokens: c.maxTokens, messages: openaiMessages(c) },
    };
  },

  'openai-compatible'(c) {
    return {
      url: `${c.base}/chat/completions`,
      headers: c.key ? { Authorization: `Bearer ${c.key}` } : {},
      body: { model: c.model, max_tokens: c.maxTokens, messages: openaiMessages(c) },
    };
  },

  gemini(c) {
    const body = {
      contents: c.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: c.maxTokens },
    };
    if (c.system) body.systemInstruction = { parts: [{ text: c.system }] };
    // Pengguna kadang mengetik "models/nama-model"; awalan dibuang supaya tidak ganda di path.
    const name = c.model.replace(/^models\//, '');
    return {
      url: `${c.base}/models/${encodeURIComponent(name)}:generateContent`,
      headers: { 'x-goog-api-key': c.key }, // kunci di header, bukan di URL
      body,
    };
  },
};

function openaiMessages(c) {
  const list = c.messages.map((m) => ({ role: m.role, content: m.content }));
  return c.system ? [{ role: 'system', content: c.system }, ...list] : list;
}

// ---------- pengurai respons per penyedia ----------

const isObj = (v) => v && typeof v === 'object';
const tok = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const sumTok = (...vals) => {
  const nums = vals.map(tok).filter((v) => v !== null);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
};

const PARSE = {
  anthropic(j) {
    const blocks = Array.isArray(j.content) ? j.content : [];
    const text = blocks.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    const u = isObj(j.usage) ? j.usage : {};
    const input = tok(u.input_tokens) === null
      ? null
      : sumTok(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens);
    return { text: text.trim(), usage: { inputTokens: input, outputTokens: tok(u.output_tokens) } };
  },

  openai(j) {
    const choice = Array.isArray(j.choices) && isObj(j.choices[0]) ? j.choices[0] : {};
    const msg = isObj(choice.message) ? choice.message : {};
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      text = msg.content.filter((p) => isObj(p) && typeof p.text === 'string').map((p) => p.text).join('');
    }
    const u = isObj(j.usage) ? j.usage : {};
    return { text: text.trim(), usage: { inputTokens: tok(u.prompt_tokens), outputTokens: tok(u.completion_tokens) } };
  },

  gemini(j) {
    const cand = Array.isArray(j.candidates) && isObj(j.candidates[0]) ? j.candidates[0] : {};
    const parts = isObj(cand.content) && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    const text = parts.filter((p) => isObj(p) && typeof p.text === 'string' && p.thought !== true).map((p) => p.text).join('');
    const u = isObj(j.usageMetadata) ? j.usageMetadata : {};
    const out = tok(u.candidatesTokenCount) === null && tok(u.thoughtsTokenCount) === null
      ? null
      : sumTok(u.candidatesTokenCount, u.thoughtsTokenCount);
    return { text: text.trim(), usage: { inputTokens: tok(u.promptTokenCount), outputTokens: out } };
  },
};
PARSE['openai-compatible'] = PARSE.openai;

// ---------- pemetaan galat ----------

function parseRetryAfter(headers, now) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, t - now());
  return null;
}

// Kumpulan petunjuk dari badan galat server (huruf kecil). HANYA untuk pencocokan; tidak pernah dikembalikan.
function errorHints(json) {
  if (!isObj(json)) return '';
  const out = [];
  const add = (v) => { if (typeof v === 'string' || typeof v === 'number') out.push(String(v).toLowerCase()); };
  const e = json.error;
  if (isObj(e)) {
    add(e.message); add(e.code); add(e.type); add(e.status);
    if (Array.isArray(e.details)) for (const d of e.details) if (isObj(d)) add(d.reason);
  } else add(e);
  add(json.message);
  return out.join(' | ');
}

const QUOTA_RE = /insufficient[_ ](quota|funds|credits?|balance)|billing[_ ]hard[_ ]limit|credit balance|exceeded your current quota|out of credits|payment required/;
const AUTH_RE = /api[_ ]key (is )?(not valid|invalid)|api_key_invalid|invalid[_ ]api[_ ]key/;

function toError(res, now) {
  const s = res.status;
  const hints = errorHints(res.json);
  const retry = () => parseRetryAfter(res.headers, now);
  const mk = (kind, extra = {}) => new AiError(kind, { http: s, ...extra });

  if (s === 401) return mk('auth');
  if (s === 402) return mk('quota_provider');
  if (s === 408) return mk('timeout');
  if ((s === 400 || s === 403 || s === 429) && QUOTA_RE.test(hints)) return mk('quota_provider');
  if (s === 400 && AUTH_RE.test(hints)) return mk('auth');
  if (s === 403) return mk('auth');
  if (s === 429) {
    const ms = retry();
    let message = MESSAGES.rate_limit;
    if (ms != null) message = `${message} Coba lagi dalam ${Math.max(1, Math.ceil(ms / 1000))} detik.`;
    return mk('rate_limit', { message, retryAfterMs: ms });
  }
  if (s === 404) return mk('bad_request', { message: MESSAGES.not_found });
  if (s >= 500) return mk('server', { retryAfterMs: retry() });
  return mk('bad_request');
}

// ---------- transport ----------

// Satu permintaan HTTP. Mengembalikan { status, headers, json } atau melempar AiError (timeout/unreachable).
async function exchange(c, req) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = c.setTimer(() => {
      controller.abort();
      reject(new AiError('timeout'));
    }, c.timeoutMs);
  });
  timeout.catch(() => {}); // cegah unhandled rejection bila fetch selesai lebih dulu
  const work = (async () => {
    const res = await c.fetchImpl(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...req.headers },
      body: JSON.stringify(req.body),
      signal: controller.signal,
      // Jangan ikuti pengalihan: header kunci khusus (x-api-key, x-goog-api-key) bisa terbawa ke host lain.
      redirect: 'error',
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, headers: res.headers, json };
  })();
  work.catch(() => {}); // fetch yang di-abort menolak belakangan; sudah ditangani oleh race
  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new AiError('timeout');
    // Sengaja tanpa cause/teks asli: galat jaringan bisa memuat URL atau nilai header.
    throw new AiError('unreachable');
  } finally {
    c.clearTimer(timer);
  }
}

// ---------- API publik ----------

// Opsi tambahan (selain kontrak) untuk tes: now, setTimer, clearTimer.
export async function chat(cfg = {}) {
  const c = prepare(cfg);
  const req = BUILD[c.provider](c);
  const res = await exchange(c, req);
  if (res.status < 200 || res.status >= 300) throw toError(res, c.now);
  if (!isObj(res.json)) throw new AiError('server', { message: MESSAGES.bad_body, http: res.status });
  const out = PARSE[c.provider](res.json);
  if (!out.text) throw new AiError('empty', { http: res.status });
  return out;
}

// Tes koneksi: permintaan sangat kecil. Tidak pernah melempar.
export async function testConnection(cfg = {}) {
  try {
    await chat({
      ...(cfg && typeof cfg === 'object' ? cfg : {}),
      system: 'Balas hanya dengan satu kata: ok.',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: TEST_MAX_TOKENS,
    });
    return { ok: true, message: 'Koneksi berhasil. Model merespons.' };
  } catch (e) {
    if (e instanceof AiError) {
      // Server menjawab 2xx tetapi teks kosong (mis. model berpikir menghabiskan batas token kecil): kunci dan model diterima.
      if (e.kind === 'empty') {
        return { ok: true, message: 'Koneksi berhasil, tetapi jawaban uji kosong (wajar untuk sebagian model). Coba kirim pesan uji sungguhan.' };
      }
      return { ok: false, kind: e.kind, message: e.message };
    }
    return { ok: false, kind: 'unreachable', message: MESSAGES.unreachable };
  }
}
