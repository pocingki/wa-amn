# E2E Convia: bukti uji dan runbook

Diperbarui: 15 November 2026

## Kesimpulan

- Semua skenario **MOCK** lulus: server WA-AMN sungguhan (`server.js`, `WA_PROVIDER=convia`) diuji melawan server Convia **palsu** lokal.
- Uji **REAL** (Convia nyata) **BLOCKED**: tidak ada API key Convia, secret webhook, URL publik, dan nomor uji. **Tidak ada klaim bahwa REAL lulus.**
- Lulus MOCK hanya membuktikan kode berperilaku sesuai kontrak internal dan payload buatan sendiri, bukan kecocokan dengan Convia sungguhan.

## Hasil perintah

| Perintah | Hasil |
|---|---|
| `npm run lint` | bersih (0 error, 0 peringatan) |
| `npm test` (`node --test`, seluruh proyek, termasuk 21 tes E2E ini dan tes S1-S6, S8) | 506 lulus, 0 gagal, 0 dibatalkan, 0 dilewati (dijalankan dua kali, hasil sama) |
| `node --test test/convia-e2e.test.js` | 21 lulus, 0 gagal (sekitar 50 detik; skenario timeout sendiri ±33 detik) |

Catatan lingkungan: `better-sqlite3` di zip adalah build Windows (`invalid ELF header`) sehingga di Linux 101 tes gagal sebelum dibangun ulang. Untuk verifikasi, modul dibangun ulang di salinan kerja (`node-gyp rebuild --nodedir=/usr`). Di Windows tidak perlu tindakan; di Linux/VPS jalankan `npm ci` atau `npm rebuild better-sqlite3`.

## Tabel skenario

Legenda: **PASS** = lulus; **FAIL** = gagal; **BLOCKED** = belum bisa dijalankan; **MOCK** = melawan server Convia palsu; **REAL** = melawan Convia nyata.
Semua baris MOCK ada di `test/convia-e2e.test.js` kecuali bila disebut lain.

| # | Skenario | MOCK | REAL |
|---|---|---|---|
| 1 | Status: mode convia, `connected`, tanpa QR, health memakai header Bearer | PASS | BLOCKED |
| 2 | Format A, tanda tangan benar -> 200, lead masuk CRM (Cold, platform Instagram), bot membalas lewat API palsu dengan `Authorization: Bearer`, pesan tersimpan | PASS | BLOCKED |
| 3 | Format B (`X-Convia-Signature`, `eventType`/`payload`), skenario yang sama | PASS | BLOCKED |
| 4 | Tanda tangan salah, hilang, kosong, bukan hex, body diubah, secret lain, header milik format lain -> 401; tidak ada lead, percakapan, atau balasan | PASS | BLOCKED |
| 5 | Payload tanpa `data` bertanda tangan benar -> 400; format B tanpa payload -> 200 dilewati; body bukan JSON atau bentuk tak dikenal -> 401 (lihat temuan 1); event tak dikenal -> 200 dilewati | PASS | BLOCKED |
| 6 | Pesan duplikat (`message_id` sama), format A -> `duplicate`, tidak ada balasan baru | PASS | BLOCKED |
| 7 | Retry: event id sama dikirim dua kali (format B) -> satu balasan; event id baru dengan `messageId` sama -> tetap duplikat | PASS | BLOCKED |
| 8 | Dedupe lintas format: `message_id` sama di A lalu B -> satu balasan | PASS | BLOCKED |
| 9 | API Convia mati (koneksi ditolak): pesan masuk tersimpan, lead terbentuk, balasan berstatus `failed`, percakapan `needsAttention` dengan alasan `send_failed` | PASS | BLOCKED |
| 10 | API memutus koneksi: sama seperti #9 | PASS | BLOCKED |
| 11 | API timeout (server palsu tidak menjawab; batas 10 detik per percobaan): sama seperti #9 | PASS | BLOCKED |
| 12 | API 401: sama seperti #9; log tidak memuat API key | PASS | BLOCKED |
| 13 | API 429 (dengan `Retry-After`): sama seperti #9 | PASS | BLOCKED |
| 14 | API `window_closed`: sama seperti #9; tidak ada pengiriman template otomatis | PASS | BLOCKED |
| 15 | Setelah API pulih, kirim ulang (`/resend`) berhasil, status `sent`, `waId` berawalan `convia:out_` | PASS | BLOCKED |
| 16 | BSUID tanpa nomor (format A): diproses, lead `phone` kosong dan `lid` = BSUID, BSUID tidak di field phone, balasan dikirim ke BSUID; Hot + Won lalu kirim ke Acesio -> 400, server Acesio palsu tidak menerima permintaan | PASS | BLOCKED |
| 17 | BSUID format B: diproses, `phone` kosong | PASS | BLOCKED |
| 18 | Pesan Instagram (kedua format) -> 200 dilewati; tidak ada lead atau balasan | PASS | BLOCKED |
| 19 | Log server tidak memuat API key, secret webhook, atau isi pesan pelanggan | PASS | BLOCKED |
| 20 | Mode baileys: `/webhooks/convia` -> 404 (server dijalankan dengan `DISABLE_WA=1` agar Baileys tidak membuka koneksi nyata; pemilihan mode di fasad dites di `test/wa-provider-select.test.js`) | PASS (terbatas) | BLOCKED |
| 21 | Mode convia tanpa API key/secret: status `misconfigured`, webhook 503, tidak jatuh ke Baileys | PASS | BLOCKED |
| 22 | Gagal memproses setelah retry habis -> webhook 500 | tidak diuji di E2E (hanya unit S3/S4) | BLOCKED |
| 23 | Pesan media (gambar/dokumen) dan unduhan `media_url` | tidak diuji di E2E (hanya unit S2/S3/S8) | BLOCKED |
| 24 | Event status delivered/read/failed mengubah status pesan bot | tidak diuji di E2E (hanya unit S2/S4) | BLOCKED |
| 25 | Webhook nyata dari Convia: format yang dipakai akun, nama header, bentuk payload, tanda tangan cocok | tidak ada MOCK | BLOCKED |
| 26 | Kirim pesan nyata lewat API Convia dan tiba di WhatsApp | tidak ada MOCK | BLOCKED |
| 27 | Jendela 24 jam nyata (`window_closed` dari Convia) | tidak ada MOCK | BLOCKED |
| 28 | Batas laju dan kuota Starter nyata (termasuk apakah `/health` dihitung) | tidak ada MOCK | BLOCKED |
| 29 | Perilaku retry/duplikasi webhook nyata | tidak ada MOCK | BLOCKED |
| 30 | BSUID nyata dari akun uji | tidak ada MOCK | BLOCKED |
| 31 | Biaya per event (Rp 25) sesuai tagihan | tidak ada MOCK | BLOCKED |

Batasan server palsu (ASUMSI): bentuk respons `{data:{message_id,status,timestamp}}`, bentuk galat `{error:{code}}`, kode `WINDOW_CLOSED`/`RATE_LIMIT_EXCEEDED`/`UNAUTHORIZED`, header `Retry-After` dalam detik, dan nama field payload kedua format berasal dari kontrak sesi dan contoh dokumen yang tersedia, bukan dari Convia nyata.

## Kebutuhan uji REAL

1. API key Convia aktif (`CONVIA_API_KEY`).
2. Secret webhook (`CONVIA_WEBHOOK_SECRET`) dan tahu di mana dibuatnya di dashboard Convia.
3. URL publik HTTPS yang menuju server uji (`https://<domain>/webhooks/convia`), terdaftar di dashboard Convia.
4. Nomor WhatsApp uji yang sudah terhubung ke Convia, plus satu ponsel pelanggan uji (dan, bila mungkin, akun tanpa nomor untuk uji BSUID).
5. Server uji terpisah dengan `DATA_DIR` kosong (bukan data produksi) dan `ACESIO_URL` diarahkan ke server palsu.
6. Kesediaan menerima biaya kecil (Rp 25 per event terkirim menurut brief).
7. Alat inspeksi permintaan masuk (inspector tunnel atau log reverse proxy) untuk melihat nama header dan bentuk body.

## Runbook uji REAL

Jalankan berurutan; berhenti dan catat bila ada langkah gagal. Isi kolom REAL di tabel hanya setelah langkah itu benar-benar dijalankan.

1. **Siapkan.** Isi `.env` (`WA_PROVIDER=convia`, `CONVIA_API_KEY`, `CONVIA_WEBHOOK_SECRET`, opsional `CONVIA_PHONE_NUMBER_ID`, `PUBLIC_URL`). Mulai server. `GET /api/wa/status` -> `mode: convia`. Catat apakah `status` menjadi `connected` (skenario #1, health nyata). Bila `disconnected`, catat pesan `error`.
2. **Daftarkan webhook** di dashboard Convia ke `https://<domain>/webhooks/convia`. Catat di mana secret diambil (pertanyaan terbuka 4).
3. **Format dan tanda tangan (#25).** Dari ponsel pelanggan uji, kirim "Halo kak dari Instagram, mau tanya harga". Di alat inspeksi, catat: nama header tanda tangan (`X-Webhook-Signature` atau `X-Convia-Signature`), kunci teratas body (`event` atau `eventType`), apakah header berisi hex polos atau ada awalan. Hasil webhook: 200 berarti tanda tangan cocok; 401 berarti asumsi tanda tangan salah (jangan ubah secret; catat header dan format yang terlihat, tanpa menempel secret).
4. **Lead dan balasan (#2/#3, #26).** Cek lead muncul di CRM dan balasan pembuka tiba di ponsel. Catat format yang dipakai (A atau B).
5. **Duplikasi dan retry (#6, #7, #29).** Biarkan Convia mengirim; di log inspeksi cari event dengan `message_id` sama yang tiba lebih dari sekali. Untuk memancing retry, hentikan server sebentar (webhook gagal), kirim pesan, jalankan lagi, dan catat apakah dan kapan Convia mengirim ulang. Pastikan hanya satu balasan.
6. **Jendela 24 jam (#27).** Tunggu lebih dari 24 jam sejak pesan terakhir, lalu dari dashboard kirim balasan ke percakapan itu. Catat bentuk galat nyata (kode dan HTTP status). Pastikan pesan pelanggan tidak hilang dan percakapan ditandai perlu perhatian.
7. **Batas laju dan kuota (#28).** Catat hitungan request di dashboard Convia sebelum dan sesudah satu jam server dibiarkan menyala tanpa pesan, untuk mengetahui apakah `/health` (setiap 60 detik) dihitung. Jangan uji 60 pesan per menit pada nomor produksi.
8. **BSUID (#30).** Bila ada akun pelanggan tanpa nomor, kirim pesan; cek lead dibuat dengan phone kosong, balasan tiba, dan kirim ke Acesio ditolak 400.
9. **Media (#23) dan status (#24).** Kirim gambar; catat bentuk payload dan apakah `media_url` bisa diunduh tanpa header Authorization serta masa berlakunya. Catat apakah event delivered/read tiba dan formatnya.
10. **Biaya (#31).** Bandingkan jumlah event terkirim dengan tagihan Convia.
11. Perbarui tabel (PASS/FAIL dengan label REAL), sesuaikan `docs/INTEGRASI-CONVIA.md` dan hapus ASUMSI yang terbukti, dan laporkan hasilnya.

## Temuan untuk pemilik file

Tidak ada file milik sesi lain yang diubah oleh sesi S7. Lint dan seluruh tes lulus, jadi tidak ada kegagalan untuk dikembalikan. Yang berikut adalah temuan perilaku dari tes E2E; keputusan perbaikan ada pada pemilik file.

| # | File dan baris | Temuan | Dampak | Saran untuk pemilik |
|---|---|---|---|---|
| 1 | `src/wa-convia-webhook-compat.js` baris 17-47 (`detect`, `verifyRequest`); `src/wa-convia-provider.js` baris 195 | Body JSON valid yang bentuknya tidak dikenal (tanpa `event`/`eventType`), bahkan bila ditandatangani benar, dijawab **401 `invalid_signature`**, bukan 400 `invalid_payload`. Sebabnya `verifyRequest` mengembalikan false saat format tak terdeteksi. Body bukan JSON juga 401. Dikunci oleh skenario #5 (asersi 401). | Kebijakan kontrak S4 menyebut payload rusak -> 400. Operator yang melihat 401 akan mencurigai secret padahal masalahnya bentuk payload. Aman (tidak ada data masuk). | S8/S4: bedakan "format tak dikenal" dari "tanda tangan salah", mis. coba kedua header lalu 400 bila tak ada yang cocok. Bila diubah, ubah asersi #5. |
| 2 | `src/wa-convia-provider.js` baris 11, 61, 167-168 (`DEFAULT_POLL_MS = 60_000`) | Health check ke Convia setiap 60 detik (sekitar 1.440 request/hari), dan interval hanya bisa diubah lewat `deps.pollIntervalMs`, bukan `.env`. | Bila `/health` dihitung dalam kuota Starter 1.000 request/hari, kuota habis oleh health check saja. Belum diketahui apakah dihitung. | S4: pertimbangkan interval lebih panjang (mis. 5-15 menit) atau env `CONVIA_HEALTH_INTERVAL_MS`, setelah uji REAL #28. |
| 3 | `src/wa-convia-events.js` baris 66, 111 | Format B hanya menangani `message.received`; `message.app_sent` dilewati dan `toStatusUpdate` selalu null. Itu sesuai catatan di berkas (hanya contoh dokumen yang dipakai), bukan bug. | Bila akun memakai format B, pesan dari aplikasi (coexistence) dan status terkirim/dibaca tidak tercatat. | S8: lengkapi setelah bentuk event B diketahui dari uji REAL. |
| 4 | `.env.example` dan `env.example` (akar proyek) | Ada dua berkas: `.env.example` (lama, tanpa variabel Acesio) dan `env.example` (14 Nov, memuat Acesio). `PROJECT_STATUS.md` menyebut variabel Acesio ada di `.env.example`. | Mudah salah salin. Sesi ini hanya menambah blok Convia ke `.env.example`. | Pemilik repo: gabungkan menjadi satu berkas, dan pindahkan blok Convia ke berkas yang tersisa. |
