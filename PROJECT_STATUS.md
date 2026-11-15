# PROJECT STATUS — WA-AMN (amnan-live 0.2.0)

Diperbarui: 16 November 2026

## Ringkasan kondisi
Dashboard CRM + bot WhatsApp (Baileys) satu client per proses. Server Node 22 ESM tanpa framework, SQLite (`better-sqlite3`) + JSON, frontend vanilla ES module. Di working tree ada pekerjaan yang belum di-commit: tahap Hot Lead (`hotStage`) dan pengiriman data ke Acesio. Pekerjaan itu setengah jadi dan merusak lint; sesi ini menyelesaikannya.

## Fitur selesai (terverifikasi tes)
Login/sesi/CSRF, peran admin/agent, CRM (filter, statistik, CSV, catatan, follow-up, blokir), logika Cold/Warm/Hot, bot + tester, `/api/v1` + webhook, enkripsi data (`DATA_KEY`), retensi, backup/restore, multi-client.

## Diperbaiki sesi ini
| Temuan | Tingkat | Perbaikan |
|---|---|---|
| `src/api/crm.js` baris 517: `return` setelah `return` merujuk variabel `lead` yang tidak ada (lint error, kode mati) | HIGH | Baris dihapus |
| Acesio menolak API key (401/403) diteruskan apa adanya; `public/assets/js/lib.js` menganggap 401 sebagai sesi habis sehingga user terlempar ke login | HIGH | Penolakan Acesio kini dijawab 502 dengan pesan "Acesio menolak data (HTTP n): ..." |
| Fitur `hotStage` / `send-to-acesio` tanpa tes | MEDIUM | 3 tes baru di `test/crm-api.test.js` (server Acesio palsu lokal: validasi tahap, header kunci, payload, status tersimpan, 401 -> 502, server mati -> 502) |
| `ACESIO_URL` dan `ACESIO_BOT_KEY` tidak terdokumentasi | LOW | Ditambahkan (dikomentari) di `.env.example` |

## File berubah sesi ini
- `src/api/crm.js` (bug fix di atas)
- `test/crm-api.test.js` (tes baru)
- `.env.example` (variabel Acesio)
- `PROJECT_STATUS.md` (baru)

Perubahan yang sudah ada sebelumnya di working tree (dipertahankan, tidak diubah): `src/leads.js`, `src/store.js`, `public/assets/js/pages/crm.js`, bagian `hotStage`/`send-to-acesio` di `src/api/crm.js`.

## Hasil testing
- `npm run lint`: bersih (sebelumnya 2 error).
- `npm test`: 320 lulus, 0 gagal (sebelumnya 74 gagal).
- Catatan lingkungan: `node_modules/better-sqlite3` dalam zip adalah build Windows ("invalid ELF header"), sehingga 74 tes gagal di Linux. Itu bukan bug kode. Untuk verifikasi, modul dibangun ulang di salinan kerja (`node-gyp rebuild --nodedir`). Di Windows milik user tidak perlu tindakan; di Linux/VPS jalankan `npm ci` atau `npm rebuild better-sqlite3`.
- Tidak diuji: koneksi WhatsApp sungguhan (QR/Baileys), Acesio sungguhan (hanya server palsu), tampilan browser untuk modal Hot Lead (hanya lolos lint).

## Tertunda / belum dikerjakan (dari `FULL-SAAS-AUDIT-REPORT.md`, tidak diverifikasi ulang sesi ini)
- F-02: Baileys rc14 tidak resmi (risiko pemblokiran nomor), jalur Cloud API belum ada.
- F-04 (listen semua interface) tampaknya sudah ditangani di `server.js` (`BIND_HOST`); perlu konfirmasi.

## F-01 (diperbaiki 14 Nov 2026)
Pesan WA kini ditandai seen hanya setelah tersimpan durable dan diproses; kegagalan tidak ditelan, diulang otomatis (2x, jeda 1 dan 4 detik), dicatat lewat event `wa:process_failed`, dan retry tidak menggandakan pesan/balasan. Rincian di laporan F-01. Tes: `test/wa-reliability.test.js` (11 tes). Hasil: lint bersih, 331/331 tes lulus.

## F-05/F-06 (diperbaiki 14 Nov 2026)
Idempotensi dipindah dari berkas JSON ke tabel SQLite `idempotency_keys` (reservasi atomik, ruang kunci per kunci API + endpoint, sidik jari isi, 422 untuk isi berbeda, 409 INTERRUPTED setelah restart, TTL 24 jam, impor otomatis berkas lama). Tes: `test/idempotency.test.js` (12 tes, termasuk lintas proses). Lint bersih, 345/345 tes lulus. Detail kontrak: `docs/INTEGRASI.md`.

## F-15/F-16 (14 Nov 2026)
Menu Integrasi: default tersembunyi, dibuka hanya untuk admin dan dihapus dari DOM untuk agent; `#/integrasi` bagi agent dialihkan ke CRM. Server sudah menolak agent (403) di dispatcher untuk semua metode `/api/integrations/*`; dikunci dengan `test/role-access.test.js`. Layout: audit lama tidak akurat untuk chat (sudah satu panel di ponsel); yang nyata: menu terpotong di 768 px, overflow 17 px di CRM pada 320 px. Perbaikan: mode tab bawah dan chat satu panel sampai 899 px, dua kolom dari 900 px, status WA ringkas dan merek hanya logo di 900-1023 px, pemilih periode CRM grid 2 kolom di ponsel. Tes browser: `test/responsive.test.js` (Playwright, dilewati bila tidak terpasang). Lint bersih, 362/362 tes lulus.

## Validasi E2E (14 Nov 2026)
WhatsApp nyata dan Acesio nyata: **BLOCKED** (tanpa akses jaringan/kredensial/nomor uji). Simulasi (MOCK) lulus. Endpoint send-to-acesio diperkuat: 503 tanpa kunci, X-Correlation-ID, log aman, timeout, status gagal tersimpan, 409 untuk kirim bersamaan. Laporan: `docs/E2E-REPORT.md`. Lint bersih, 368/368 tes lulus.

## Blocker
- Akses ke Acesio nyata dan nomor WhatsApp uji untuk uji end-to-end.

## Keputusan terbuka
- `POST /api/leads/:id/send-to-acesio` kini boleh dipakai agent. Jika hanya admin yang boleh, tambahkan `ctx.requireRole('admin')` seperti pada blokir.
- Fallback `ACESIO_URL` ke `http://127.0.0.1:3000` bila env kosong; pertimbangkan gagal tegas.

## Rekomendasi berikutnya
1. Commit perubahan hotStage + Acesio (CRLF/LF pada file diubah penuh; pakai `git diff --ignore-cr-at-eol` untuk review).
2. Kerjakan F-01 (seen setelah proses sukses) dengan tes.
3. Perbaiki menu mobile (F-16) dan sembunyikan menu Integrasi untuk agent (F-15).
4. Uji end-to-end dengan nomor uji dan Acesio nyata.

## Opsi API Resmi (Convia) (15 Nov 2026)
Alternatif dari Baileys lewat WhatsApp Business API resmi (Convia). Bawaan tetap Baileys; tidak berubah bila tidak diaktifkan. Menjawab sebagian F-02 (jalur resmi kini ada, tetapi **baru teruji MOCK**).

- **Aktivasi:** `WA_PROVIDER=convia` (env, mengalahkan pengaturan) atau Pengaturan > koneksi WhatsApp > "API Resmi (Convia)" lalu restart. Env: `CONVIA_API_KEY`, `CONVIA_WEBHOOK_SECRET` (alias `CONVIA_SIGNING_SECRET`), opsional `CONVIA_BASE_URL`, `CONVIA_PHONE_NUMBER_ID`. Tanpa key/secret: status `misconfigured`, tidak jatuh ke Baileys.
- **Webhook:** `POST /webhooks/convia` (tanpa sesi/CSRF, dilindungi HMAC-SHA256 atas body asli). Dua format: A (`event`, header `X-Webhook-Signature`) dan B (`eventType`, header `X-Convia-Signature`); format dideteksi dari isi body.
- **Modul:** `src/wa-convia-api.js`, `wa-convia-webhook.js` (A), `wa-convia-events.js` (B), `wa-convia-webhook-compat.js`, `wa-convia-inbound.js`, `wa-convia-provider.js`; pemilih di `src/whatsapp.js`; setting `waProvider` di `src/settings.js`; rute di `server.js`.
- **Bukti:** `test/convia-e2e.test.js` (21 tes, server Convia palsu + server asli), seluruh `npm test` 506/506, lint bersih. Semua MOCK. Uji REAL **BLOCKED** (butuh API key, secret webhook, URL publik, nomor uji). Lihat `docs/E2E-CONVIA.md` (tabel, runbook, temuan) dan `docs/INTEGRASI-CONVIA.md` (cara pasang, batas, biaya).
- **Tidak didukung:** template (di luar jendela 24 jam balasan gagal dan ditandai perlu perhatian), media keluar, pengiriman otomatis template.

### Sisa risiko Convia
| Risiko | Tingkat | Catatan |
|---|---|---|
| Perilaku retry dan duplikasi webhook Convia belum terdokumentasi (apakah 5xx memicu kirim ulang, apakah event bisa ganda, urutan) | HIGH | Dedupe memakai `convia:<message_id>` dan teruji MOCK; perilaku nyata belum diketahui |
| Format header tanda tangan hanya diasumsikan hex polos; format mana (A/B) yang dipakai akun belum pasti | HIGH | Salah asumsi = semua webhook 401 (aman, tetapi tidak ada pesan masuk). Pastikan lewat uji REAL |
| Kuota Starter 1.000 request/hari vs health check tiap 60 detik (sekitar 1.440/hari) | MEDIUM | Belum diketahui apakah `/health` dihitung; interval belum bisa diatur lewat env |
| Biaya: Rp 25 per event terkirim (menurut brief); biaya template dan apa saja yang dihitung belum jelas | MEDIUM | Konfirmasi dengan Convia dan pantau tagihan awal |
| Template belum didukung: di luar jendela 24 jam balasan tidak terkirim | MEDIUM | Admin harus menunggu pelanggan menulis lagi |
| Format B hanya menangani `message.received` (tanpa `app_sent` dan status); non-teks belum diketahui bentuknya | MEDIUM | Lengkapi setelah payload nyata terlihat |
| BSUID: balasan ke pengguna tanpa nomor belum terbukti diterima Convia; kirim ke Acesio ditolak 400 sampai nomor diisi | LOW | Lead tetap tercatat |
| Body bukan JSON atau bentuk tak dikenal dijawab 401, bukan 400 | LOW | Aman; membingungkan saat diagnosa (temuan 1 di `docs/E2E-CONVIA.md`) |
| `.env.example` dan `env.example` ganda | LOW | Gabungkan |

### File berubah (sesi S7)
`test/convia-e2e.test.js` (baru), `docs/INTEGRASI-CONVIA.md` (baru), `docs/E2E-CONVIA.md` (baru), `.env.example` (blok Convia), `PROJECT_STATUS.md` (bagian ini).

## Balasan AI (Baileys) (16 Nov 2026)
Pengganti intent dan kamus bahasa gaul: bot menjawab pertanyaan bebas dari basis pengetahuan lewat penyedia AI (`anthropic`, `openai`, `gemini`, `openai-compatible`). **Mati secara bawaan.** Cara pakai dan privasi: `docs/AI-BALASAN.md`. Bukti uji dan runbook: `docs/E2E-AI.md`.

- **Modul:** `src/ai-providers.js` (B1), `ai-knowledge.js` (B2), `ai-quota.js` (B3), `ai-reply.js` (B4), `ai-secret.js` dan `api/ai.js` (B7), `phone.js` (C1); `bot-plan.js`/`bot-validate.js` (B5), `bot-pipeline.js`/`bot-tester.js` (B6), UI `pengaturan.js` (B8), `pesan.js`/`lib.js` (B9), `leads.js`/`api/crm.js` (C2), `crm.js` UI (C3).
- **Aturan bisnis:** pembuka untuk nomor baru atau salam; pertanyaan referensi (maks 3 kali, bisa dilewati); `waName` dari pushName; kirim ke Acesio hanya bila phone, referensi, dan nama lengkap; `replayed` tidak dianggap kiriman baru. Mode API resmi disembunyikan dari UI; backend dan tesnya utuh.
- **Kuota:** bulanan dan harian per customer (internal). Biaya nyata ada di penyedia AI dan naik dengan panjang basis pengetahuan.
- **Bukti:** `test/ai-e2e.test.js` (30 lulus, 2 todo; server asli + penyedia AI, WhatsApp, Acesio palsu). `npm test` penuh di proyek gabungan: 741 tes, 733 lulus, **6 gagal** (di file sesi lain, lihat `docs/E2E-AI.md`), 2 todo. **Lint belum dijalankan** (eslint tidak terpasang di lingkungan sesi). Semua MOCK; uji REAL **BLOCKED** sampai ada API key penyedia AI.

### Sisa risiko Balasan AI
| Risiko | Tingkat | Catatan |
|---|---|---|
| Bentuk API penyedia (terutama `anthropic`, `openai`, `gemini`) belum diuji nyata; hanya `openai-compatible` dijalankan end-to-end, itu pun melawan server palsu | HIGH | Salah asumsi = semua balasan jatuh ke fallback (`ai_error`). Jalankan runbook di `docs/E2E-AI.md` |
| Kualitas dan kebenaran jawaban bergantung pada model dan basis pengetahuan; aturan keras hanya instruksi ke model | HIGH | Pantau percakapan awal; isi basis pengetahuan seakurat mungkin |
| Kuota tetap terpakai bila kirim WhatsApp gagal setelah AI sukses (kontrak meminta dilepas; B4 commit lebih dulu, refund B3 hanya melepas yang `reserved`) | MEDIUM | Tes `todo` di `test/ai-e2e.test.js`; butuh keputusan B3/B4/B6 |
| Pesan customer saat ini terkirim dua kali di prompt | LOW | Boros token; tes `todo`; B4/B6 |
| Cooldown bersama AI dan fallback (bawaan 30 menit): satu balasan AI per percakapan per 30 menit | MEDIUM | Atur `fallbackCooldownMinutes` ke 0 bila ingin menjawab tiap pertanyaan |
| Tanpa `DATA_KEY`, kunci AI tersimpan sebagai teks biasa (izin 0600) | MEDIUM | Isi `DATA_KEY` di produksi |
| Isi pesan customer (dan riwayat) dikirim ke penyedia AI | MEDIUM | Nomor dan nama tidak dikirim (teruji). Sesuaikan kebijakan privasi |
| Biaya penyedia tidak dibatasi kuota internal | MEDIUM | Pasang batas pengeluaran di akun penyedia |
| AI nonaktif + nomor baru yang bertanya: tanpa fallback; AI aktif tanpa kunci: fallback dikirim | LOW | Perilaku tidak seragam |
| API resmi (Convia) ditunda: disembunyikan dari Pengaturan, hanya aktif lewat `.env`/data lama; bagian "Opsi API Resmi" di atas yang menyebut pilihan di Pengaturan sudah usang | LOW | Backend utuh dan teruji MOCK |
| 6 tes gagal di `bot-pipeline.test.js` (fixture `nama`), `crm-api.test.js:229`, `integration-alur.test.js:45` | MEDIUM | Milik B6, C2/B7, dan integrasi; belum diperbaiki |

### File berubah (sesi B10)
`test/ai-e2e.test.js` (baru), `docs/AI-BALASAN.md` (baru), `docs/E2E-AI.md` (baru), `.env.example` (blok `AI_API_KEY`), `PROJECT_STATUS.md` (bagian ini).
