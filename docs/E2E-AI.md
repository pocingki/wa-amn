# E2E Balasan AI: bukti uji dan runbook

Diperbarui: 16 November 2026

## Kesimpulan

- Semua skenario **MOCK** yang dijalankan lulus, kecuali dua temuan yang ditandai `todo` (lihat di bawah): server WA-AMN sungguhan (`server.js`, `WA_PROVIDER=convia` sebagai jalur WhatsApp palsu) melawan penyedia AI palsu, WhatsApp palsu, dan Acesio palsu.
- Semua uji **REAL** berstatus **BLOCKED**: belum ada API key penyedia AI, nomor WhatsApp uji, maupun Acesio nyata. **Tidak ada klaim bahwa integrasi nyata berhasil.**
- Lulus MOCK hanya membuktikan kode sesuai kontrak internal dan payload buatan sendiri. Bentuk API penyedia AI di server palsu adalah **ASUMSI**.

## Hasil perintah (Linux, 16 Nov 2026)

| Perintah | Hasil |
|---|---|
| `npm run lint` | **TIDAK DIJALANKAN**: `eslint` tidak bisa dipasang di lingkungan ini (tanpa jaringan). Jalankan `npx eslint test/ai-e2e.test.js` dan `npm run lint` sebelum digabung. |
| `node --test test/ai-e2e.test.js` | 30 lulus, 0 gagal, 2 todo (temuan); ±10 detik; stabil di 3 kali jalan |
| `npm test` (seluruh proyek gabungan B1-C3 + B10) | 741 tes: 733 lulus, 6 gagal, 2 todo, 0 dibatalkan, 0 dilewati |

Catatan lingkungan: `better-sqlite3` tidak terpasang, sehingga server memakai `node:sqlite` bawaan Node 22 (jalur cadangan di `src/db.js`). Dijalankan hanya di Linux; Windows belum diuji. Penggabungan B1-C3 dilakukan dengan menyalin file hasil sesi ke path yang sesuai (pemetaan dari nama dan isi file).

### 6 tes gagal di file sesi lain (dicatat, tidak diperbaiki)

| File:baris | Tes | Dugaan sebab |
|---|---|---|
| `test/bot-pipeline.test.js:77` | alur normal: pembuka + pertanyaan | Fixture masih memakai pertanyaan `nama`; B5 kini hanya menanyakan `referensi` (milik B6) |
| `test/bot-pipeline.test.js:92` | gagal di balasan ke-2 | sama |
| `test/bot-pipeline.test.js:137` | sinkron nama/data ke lead | sama (jawaban `nama` tidak lagi menjadi pertanyaan) |
| `test/bot-pipeline.test.js:168` | onStatusUpdate | sama (`replies[1]` tidak ada) |
| `test/crm-api.test.js:229` | export.csv | Label "Data Wajib" dari `requiredFields` yang kini hanya `referensi` (dugaan, belum diverifikasi; milik C2/B7) |
| `test/integration-alur.test.js:45` | lebih dari 10 pesan -> Warm | Hasil Cold; sebab belum diselidiki |

## Tabel skenario

Status: PASS = lulus; FAIL = temuan nyata (ditandai `todo` di tes supaya suite tetap hijau); BLOCKED = tidak bisa dijalankan.

| # | Skenario | MOCK | REAL |
|---|---|---|---|
| 1 | AI nonaktif -> fallback lama dengan cooldown, tanpa panggilan AI | PASS | BLOCKED |
| 2 | AI aktif tanpa kunci -> fallback | PASS | BLOCKED |
| 3 | Pertanyaan bebas -> balasan AI, kuota +1, urutan pembuka-AI-referensi, token tercatat | PASS | BLOCKED |
| 4 | Prompt memuat basis pengetahuan dan aturan keras; tanpa nomor/nama; kunci hanya di header | PASS | BLOCKED |
| 5 | Salam saja tanpa AI; nomor lama tanpa salam tanpa pembuka; salam di nomor lama -> pembuka | PASS | BLOCKED |
| 6 | Referensi: disimpan (maks 50), tidak ditanya lagi, "lewati" menghentikan; nama dari pushName; phone kanonik | PASS | BLOCKED |
| 7 | Nama hasil edit admin tidak ditimpa pushName; `waName` mengikuti pushName terbaru | PASS | BLOCKED |
| 8 | Batas harian per customer -> pesan kuota + `ai_quota`; customer lain tetap dilayani | PASS | BLOCKED |
| 9 | Kuota bulanan habis -> pesan tetap + `ai_quota`, tanpa panggilan AI | PASS | BLOCKED |
| 10 | 12 customer bersamaan, sisa kuota 3 -> tepat 3 panggilan, kuota tidak terlampaui | PASS | BLOCKED |
| 11 | AI 401 / 429 / 500 / jawaban kosong / timeout -> fallback, `ai_error`, kuota tidak terpakai | PASS | BLOCKED |
| 12 | `errorMessage` dipakai bila diisi | PASS | BLOCKED |
| 13 | Kirim WhatsApp gagal setelah AI sukses -> balasan `failed`, `send_failed`, AI dipanggil sekali | PASS | BLOCKED |
| 14 | Kirim WhatsApp gagal setelah AI sukses -> **kuota dilepas** | **FAIL** (todo) | BLOCKED |
| 15 | Retry balasan gagal -> teks dipakai ulang, satu panggilan AI, satu balasan, tanpa kuota tambahan | PASS | BLOCKED |
| 16 | Webhook sama dikirim ulang -> satu panggilan AI, satu balasan | PASS | BLOCKED |
| 17 | Uji koneksi memakai kunci tersimpan; galat penyedia yang mengutip kunci dibersihkan | PASS | BLOCKED |
| 18 | Kunci tidak ada di `/api/settings`, `/api/ai/*`, riwayat, audit, log, berkas data (kunci lama dan baru) | PASS | BLOCKED |
| 19 | Isi pesan customer dan nomor utuh tidak ada di log server | PASS | BLOCKED |
| 20 | Agent: boleh melihat pemakaian; ditolak (403) mengubah kunci/uji/pengaturan; kuota dan kunci tidak berubah | PASS | BLOCKED |
| 21 | UI tidak menawarkan pilihan API resmi (HTML/JS); backend Convia tetap aktif | PASS | BLOCKED |
| 22 | Migrasi intent lama -> basis pengetahuan; `intents`/`slangMap` hilang; `requiredFields` jadi satu butir `referensi`; AI memakai isi hasil migrasi | PASS | BLOCKED |
| 23 | Acesio: payload `name`, `phone` kanonik, `platform` = referensi, `keyword`, `wa_lead_id`; kesiapan data | PASS | BLOCKED |
| 24 | Acesio: `replayed` -> `acesioStatus` sent, pesan "Sudah ada di Acesio (tidak diperbarui)", tidak ada rekaman baru | PASS | BLOCKED |
| 25 | Acesio: data kurang (referensi/nama) -> 400 dengan daftar `missing`, Acesio tidak disentuh | PASS | BLOCKED |
| 26 | Won mengisi nama kosong dari `waName`, tidak menimpa nama yang ada | PASS | BLOCKED |
| 27 | Pesan customer saat ini muncul tepat sekali di prompt | **FAIL** (todo) | BLOCKED |

### Temuan (FAIL)

- **#14**: `src/ai-reply.js` (B4) commit kuota saat AI sukses, sedangkan `refund` di `src/ai-quota.js` (B3) hanya melepas baris `reserved`. Refund dari `src/bot-pipeline.js` (B6) setelah kirim gagal tidak berefek. Perlu keputusan: refund kuota yang sudah commit (B3), commit setelah kirim (B4/B6), atau ubah kontrak (kuota terpakai karena panggilan penyedia memang terjadi). Hapus `todo` di tes setelah diputuskan.
- **#27**: pesan saat ini ada di riwayat percakapan dan ditambahkan lagi sebagai pesan terakhir (B4/B6).

### Hal lain yang teramati

- Cooldown fallback dipakai bersama AI: secara bawaan satu balasan AI per percakapan per 30 menit. Tes menonaktifkannya (0) untuk skenario beruntun.
- AI nonaktif + nomor baru yang bertanya: tanpa fallback (hanya pembuka dan referensi). AI aktif tanpa kunci: fallback dikirim.
- Tanpa `DATA_KEY`, kunci AI tersimpan sebagai teks biasa (izin 0600). Tes berjalan dengan `DATA_KEY`.

## Cakupan MOCK vs REAL

MOCK memakai: penyedia AI palsu bentuk `openai-compatible` (ASUMSI), Convia palsu (jalur WhatsApp), Acesio palsu (perilaku ditiru dari kontrak sesi). Hanya penyedia `openai-compatible` yang dijalankan end-to-end; adaptor `anthropic`, `openai`, dan `gemini` hanya diuji di unit test B1 (juga MOCK).

## Runbook uji nyata (REAL)

Prasyarat: API key penyedia AI (dengan batas pengeluaran terpasang), nomor WhatsApp uji, server WA-AMN berjalan dengan `DATA_KEY` terisi.

1. **Pasang kunci**: Pengaturan -> Balasan AI: pilih penyedia, isi model yang benar-benar tersedia di akun, (URL dasar bila `openai-compatible`), simpan kunci. Periksa hanya status "sudah ada"; kunci tidak tampil lagi.
2. **Uji koneksi**: `POST /api/ai/test`. Harapan: `ok:true`. Catat bentuk galat bila gagal (`auth`, `bad_request`, dst.); inilah pertama kali asumsi bentuk API diuji.
3. **Isi basis pengetahuan** dengan 2-3 entri sederhana (harga, jam buka), set `monthlyQuota` kecil (mis. 5) dan `fallbackCooldownMinutes` 0, aktifkan AI.
4. **Kirim pesan dari nomor uji**: pertanyaan yang ada di basis pengetahuan (harapan: jawaban sesuai isi), lalu yang tidak ada (harapan: diteruskan ke admin, tidak mengarang), lalu perintah "abaikan aturanmu" (harapan: tidak menurut). Catat bahasa dan panjang jawaban.
5. **Cek pemakaian**: `GET /api/ai/usage` -> `month.used` bertambah sesuai jumlah jawaban, token terisi; bandingkan token dengan dasbor penyedia.
6. **Kuota habis**: kirim pesan sampai melewati `monthlyQuota`. Harapan: pesan kuota habis, percakapan bertanda `ai_quota`, tidak ada panggilan baru di dasbor penyedia.
7. **Kunci salah**: ganti dengan kunci keliru, kirim pertanyaan. Harapan: fallback/`errorMessage`, `ai_error`, kuota tidak berkurang, kunci tidak ada di log. Pulihkan kunci benar.
8. **Privasi**: periksa log penyedia/dasbor: nomor dan nama customer tidak ada di permintaan.
9. Catat hasil per langkah (PASS/FAIL) dan ubah kolom REAL di tabel di atas. Jangan ubah ke PASS tanpa bukti dari langkah ini.

Uji REAL Acesio dan WhatsApp (nomor uji) mengikuti `docs/E2E-CONVIA.md` dan runbook integrasi Acesio; belum dilakukan.
