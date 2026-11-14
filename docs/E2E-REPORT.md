# Laporan Validasi End-to-End — WA-AMN ↔ WhatsApp ↔ Acesio

Tanggal: 14 November 2026 · Lingkungan: sandbox cloud (tanpa akses ke `web.whatsapp.com`, tanpa `ACESIO_URL`/`ACESIO_BOT_KEY`, tanpa nomor uji).

**Aturan pelaporan:** `REAL` = diuji ke layanan sungguhan. `MOCK` = diuji ke simulasi lokal (server Acesio palsu / WhatsApp palsu) dan **bukan** bukti bahwa integrasi nyata berhasil. `BLOCKED` = tidak bisa dijalankan; kebutuhan dijelaskan. Tidak ada pesan dikirim ke pihak ketiga, tidak ada data pelanggan dihapus, tidak ada kredensial produksi dipakai.

## Part A — Persiapan
| Item | Hasil |
|---|---|
| `.env.example` | `ACESIO_URL`, `ACESIO_BOT_KEY`, `ACESIO_TIMEOUT_MS` terdokumentasi (dikomentari, tanpa nilai asli) |
| Kunci Acesio | Dibaca dari `ACESIO_BOT_KEY` (alias `ACESIO_API_KEY`/`BOT_API_KEY`), dikirim di header `X-API-Key` |
| Endpoint | `POST /api/leads/:id/send-to-acesio` → `POST {ACESIO_URL}/api/bot/incoming-leads`; hanya Hot Leads tahap Won |
| Payload | `name, phone, platform, keyword, note, data, wa_lead_id` (kontrak Acesio **belum diverifikasi** terhadap dokumen resmi Acesio) |
| Rahasia | `.env`, `data/` di-gitignore; log Acesio tidak memuat kunci, payload, atau isi pesan |
| Kredensial nyata | **Tidak tersedia** → lihat checklist di bawah |

## Perubahan kode (`src/api/crm.js`, `public/assets/js/pages/crm.js`)
- Tanpa `ACESIO_BOT_KEY` → 503 jelas, tanpa panggilan keluar (sebelumnya mengirim tanpa kunci).
- `X-Correlation-ID` (UUID) per percobaan: header ke Acesio, respons, audit, dan log.
- Log terstruktur `[acesio] {...}`: waktu, cid, id lead, nomor disamarkan (4 digit terakhir), origin tujuan, ok, HTTP, jenis (`ok|rejected|timeout|unreachable`), durasi ms.
- Timeout dapat diatur (`ACESIO_TIMEOUT_MS`), pesan error dibedakan: timeout / tidak terjangkau / ditolak.
- Kegagalan disimpan (`acesioStatus='failed'`, `acesioLastError`, `acesioLastAttemptAt`) tanpa menyentuh data CRM; kirim ulang yang gagal tidak menurunkan status `sent`. UI menampilkan "Gagal kirim ke Acesio".
- Kirim bersamaan untuk lead yang sama → 409 (hanya satu panggilan).
- Jika Acesio sudah menerima tetapi penyimpanan status gagal → 200 + `warning` (bukan gagal palsu yang memicu kirim ganda).

## Part B — WhatsApp (Baileys)
| # | Skenario | Status | Keterangan |
|---|---|---|---|
| 1 | Tautkan QR | **BLOCKED** | `web.whatsapp.com` tidak terjangkau dari sandbox; butuh perangkat HP untuk scan |
| 2 | Sesi tersimpan | **BLOCKED** (nyata) | Logika persistensi `data/auth` tidak dijalankan terhadap WA nyata |
| 3 | Pesan masuk | **BLOCKED** (nyata) / PASS (MOCK) | `test/wa-facade.test.js` |
| 4 | Masuk ke CRM | PASS (MOCK) | `test/wa-reliability.test.js` |
| 5 | Bot memproses | PASS (MOCK) | idem |
| 6 | Balasan terkirim | **BLOCKED** (nyata) / PASS (MOCK) | sender palsu |
| 7 | Pesan duplikat | PASS (MOCK) | retry tidak menggandakan pesan/balasan |
| 8 | Koneksi gagal | PASS (MOCK) | event dan retry diuji lewat connection palsu |
| 9 | Reconnect | **BLOCKED** (nyata) / PASS (MOCK) | |
| 10 | Tidak ada pesan hilang saat proses gagal | PASS (MOCK) | F-01: 2x retry, event `wa:process_failed`, seen setelah durable |

## Part C — Acesio
| # | Skenario | Status | Bukti |
|---|---|---|---|
| 1 | Kirim Hot Lead | **BLOCKED** (nyata) / PASS (MOCK) | `crm-api.test.js` |
| 2 | Payload sesuai kontrak | **BLOCKED** | kontrak resmi Acesio belum diberikan; hanya dicocokkan dengan kode sendiri |
| 3 | Header API key benar | PASS (MOCK) | `X-API-Key` terbaca server palsu |
| 4 | Acesio menerima data | **BLOCKED** | butuh instance Acesio |
| 5 | Status pengiriman tersimpan | PASS (MOCK) | `acesioStatus/acesioSentAt` |
| 6 | API key salah | PASS (MOCK) | 401 Acesio → 502 (tidak melempar user ke login) |
| 7 | Server tidak tersedia | PASS (MOCK) | → 502 + status `failed` |
| 8 | Timeout | PASS (MOCK) | → 502 "timeout setelah N ms" |
| 9 | Permintaan duplikat | PASS (MOCK) | konkuren → 409, satu panggilan. **Catatan:** idempotensi sisi Acesio untuk `wa_lead_id` yang sama tidak diketahui |
| 10 | Kegagalan Acesio tak menghapus data CRM | PASS (MOCK) | lead utuh, status `sent` dipertahankan |

## Part D — Observabilitas
PASS (MOCK): cid sama di header/respons/audit/log; log tanpa kunci, isi pesan, dan nomor penuh (diuji eksplisit). Contoh log tersanitasi:
```
[acesio] {"ts":"2026-11-14T..","cid":"<uuid>","leadId":"..","phone":"********6789","target":"http://127.0.0.1:PORT","ok":false,"http":0,"kind":"timeout","ms":1003,"error":"timeout setelah 1000 ms"}
```
Catatan: apakah Acesio membaca `X-Correlation-ID` belum diketahui.

## Part E — Uji kegagalan
| Skenario | Status |
|---|---|
| WhatsApp terputus | PASS (MOCK) |
| Acesio tidak tersedia / API key salah / timeout | PASS (MOCK) |
| Kegagalan database | PASS (MOCK, parsial): tulis status ditolak setelah Acesio sukses → 200+warning; DB non-writable untuk pesan WA dicakup F-01 |
| Restart server | PASS (MOCK): idempotensi lintas proses (`idempotency.test.js`) |
| Pemulihan koneksi WA nyata | **BLOCKED** |

## Kebutuhan yang belum tersedia (untuk mengubah BLOCKED → REAL)
1. Nomor WhatsApp uji milik Anda + HP untuk scan QR, dan konfirmasi nomor penerima uji yang sah.
2. `ACESIO_URL` instance Acesio (staging, bukan produksi) yang terjangkau dari server WA-AMN.
3. `ACESIO_BOT_KEY` untuk staging.
4. Dokumen kontrak `/api/bot/incoming-leads` (field wajib, respons, perilaku duplikat `wa_lead_id`, header correlation).
5. Jaringan keluar ke `web.whatsapp.com` (bukan sandbox ini).

## Runbook uji nyata (di mesin Anda)
1. Isi `.env`: `ACESIO_URL`, `ACESIO_BOT_KEY`; `npm start`; login admin; tautkan QR dengan nomor uji.
2. Dari nomor uji lain milik Anda, kirim pesan berisi kata kunci platform, lalu "booking"; cek lead masuk dan menjadi Hot.
3. Ubah tahap ke Won, klik Kirim ke Acesio; cek log `[acesio]` (ok=true, http 2xx) dan data di Acesio.
4. Ulangi dengan kunci salah (di staging), ACESIO_URL mati, dan restart server saat pesan masuk. Salin log `[acesio]` ke laporan ini.

## Sisa risiko
- Baileys tidak resmi (F-02). Kontrak Acesio belum diverifikasi. `send-to-acesio` masih boleh dipakai agent; fallback `ACESIO_URL` ke localhost masih ada (kini aman karena kunci wajib).