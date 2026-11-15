# Integrasi WhatsApp API Resmi (Convia)

Status: kode terpasang dan lolos uji **MOCK** (server Convia palsu). **Belum pernah diuji dengan Convia nyata** (lihat `docs/E2E-CONVIA.md`).

Mode ini adalah alternatif dari Baileys (QR). Hanya satu mode aktif per proses. Bawaan tetap Baileys; tidak ada yang berubah bila Anda tidak mengaktifkan Convia.

> Sumber fakta: angka batas laju, biaya, jendela 24 jam, BSUID, dan coexistence di bawah berasal dari brief rencana Convia yang diberikan ke sesi ini. Bagian "Fakta baru" dari rencana tersebut **tidak terlampir** pada sesi S7, jadi daftar pertanyaan terbuka di bawah disusun dari hal yang memang belum diketahui. Cocokkan dengan bagian "Fakta baru" asli sebelum dianggap lengkap.

## 1. Cara pasang

1. **Isi `.env`** (salin dari `.env.example`, blok "WhatsApp API resmi lewat Convia"):
   - `CONVIA_API_KEY`: API key dari dashboard Convia.
   - `CONVIA_WEBHOOK_SECRET`: secret penanda tangan webhook (alias `CONVIA_SIGNING_SECRET` juga diterima).
   - `CONVIA_PHONE_NUMBER_ID`: opsional, bila akun punya lebih dari satu nomor.
   - `CONVIA_BASE_URL`: opsional; bawaan `https://api.convia.id/api/v1/public`.
   - `PUBLIC_URL`: opsional; hanya agar Pengaturan menampilkan alamat webhook lengkap.
   - `WA_PROVIDER=convia`: opsional. Bila diisi, **mengalahkan** pilihan di Pengaturan.
2. **Daftarkan URL webhook HTTPS publik** di dashboard Convia: `https://<domain-anda>/webhooks/convia` (metode POST). Server harus bisa dijangkau dari internet lewat HTTPS (reverse proxy, Cloudflare Tunnel, dsb.); bila di belakang proxy, isi `TRUST_PROXY=1` sesuai `.env.example`. Rute ini tanpa sesi dan tanpa CSRF; perlindungannya tanda tangan HMAC-SHA256 atas body asli.
3. **Pilih mode di Pengaturan** (admin): Pengaturan > koneksi WhatsApp > "API Resmi (Convia)". Panel menampilkan apakah konfigurasi server lengkap (hanya ya/tidak, tanpa nilai rahasia) dan alamat webhook.
4. **Restart server.** Pergantian penyedia baru berlaku setelah restart (respons PATCH memuat `restartRequired: true`).
5. **Cek status.** `GET /api/wa/status` harus menampilkan `mode: "convia"` dan `status: "connected"` (berdasarkan health check ke Convia). Tidak ada QR di mode ini.

Bila `WA_PROVIDER=convia` tetapi API key atau secret kosong, status menjadi `misconfigured` dengan pesan jelas dan webhook menjawab 503. Sistem **tidak** jatuh diam-diam ke Baileys. Nilai `WA_PROVIDER` selain `baileys`/`convia` juga gagal tegas.

Mode `baileys`: rute `/webhooks/convia` menjawab 404.

## 2. Dua format webhook

Dokumen Convia yang tersedia untuk pengembangan memuat dua bentuk. Server mendeteksi format dari **isi body**, lalu memeriksa tanda tangan dengan header milik format itu saja.

| | Format A | Format B |
|---|---|---|
| Kunci deteksi | `event` | `eventType` |
| Header tanda tangan | `X-Webhook-Signature` | `X-Convia-Signature` |
| Bentuk | `{event, timestamp, data:{message_id, channel, message_type, content, media_url, customer_phone, ...}}` | `{id:"evt_...", eventType, channel, occurredAt, payload:{messageId, from, type, text:{body}, timestamp}}` |
| Event yang diproses | `message.received`, `message.app_sent` (fromMe); `message.delivered/read/failed` sebagai status | hanya `message.received` |
| Modul | `src/wa-convia-webhook.js` | `src/wa-convia-events.js` |

Tanda tangan: HMAC-SHA256 heksadesimal atas **byte asli** body (bukan hasil parse ulang). Format lain (awalan `sha256=`, base64) ditolak. **Itu ASUMSI** yang belum dikonfirmasi Convia.

Kunci duplikasi (sama di kedua format): `convia:<message_id>`. ID event (`evt_...`) hanya untuk log, bukan kunci dedupe.

**Format mana yang dipakai akun Anda hanya bisa dipastikan lewat uji REAL**: kirim satu pesan nyata dan periksa permintaan yang tiba (nama header dan kunci body) dengan alat inspeksi, mis. inspector tunnel atau log reverse proxy. Runbook ada di `docs/E2E-CONVIA.md`. Kedua format sudah diuji hanya dengan payload buatan sendiri.

Kebijakan respons webhook:

| Kondisi | Status |
|---|---|
| Tanda tangan salah/hilang/tidak cocok dengan format payload | 401 |
| Body bukan JSON atau bentuk tak dikenali | 401 (format tak bisa dideteksi sehingga tanda tangan tak bisa diverifikasi) |
| Format terdeteksi tetapi isi rusak (mis. `data` hilang) | 400 |
| Event dilewati, pesan duplikat, channel bukan WhatsApp | 200 |
| Gagal memproses setelah percobaan ulang | 500 (agar Convia dapat mengirim ulang, **jika** didukung; belum diketahui) |
| Mode convia belum dikonfigurasi | 503 |

## 3. Jendela 24 jam dan template

- Pesan bebas (teks) hanya boleh dikirim dalam jendela 24 jam sejak pesan terakhir pelanggan. Di luar itu API menolak dengan galat `window_closed`.
- Perilaku sistem: balasan **tidak dikirim**, tersimpan di percakapan dengan status `failed`, dan percakapan ditandai perlu perhatian (`send_failed`). Pesan masuk pelanggan tidak hilang.
- **Template belum didukung.** Sistem tidak mengirim template otomatis; admin harus membalas pelanggan lewat cara lain atau menunggu pelanggan menulis lagi.
- Kode galat Convia yang dipetakan (`WINDOW_CLOSED`, `RATE_LIMIT_EXCEEDED`, `UNAUTHORIZED`, dst.) adalah **ASUMSI** dari kode klien API, belum dicocokkan dengan respons nyata.

## 4. BSUID (pelanggan tanpa nomor)

WhatsApp dapat mengirim pengenal pengguna (BSUID, pola seperti `US.13491208655302741918`) tanpa nomor telepon.

- Pesan tetap diproses: percakapan memakai BSUID sebagai kunci (`phone || lid`), lead dibuat dengan **phone kosong**.
- BSUID tidak pernah ditulis ke field `phone`.
- Balasan dikirim ke BSUID sebagai tujuan (belum terbukti diterima Convia nyata).
- Kirim ke Acesio **ditolak 400** untuk lead tanpa nomor ("Nomor telepon customer belum diketahui"). Isi nomor di data customer dulu.

## 5. Coexistence (WhatsApp Business app dan API pada nomor yang sama)

- Event `message.app_sent` (pesan yang dikirim lewat aplikasi, **format A**) diteruskan ke pipeline sebagai pesan keluar (`fromMe` dan `fromPhone` = true), sejalan dengan perlakuan pesan yang diketik admin di HP pada jalur Baileys.
- **Format B tidak menangani `app_sent`** (hanya `message.received`); event itu dilewati.
- Perilaku coexistence di sisi Convia (event apa yang dikirim, urutannya) belum diverifikasi.

## 6. Batas laju dan kuota

Menurut brief rencana:

| Batas | Nilai |
|---|---|
| WhatsApp | 60 pesan per menit |
| Paket Starter Convia | 1.000 request per hari |
| Indikator mengetik | 1 permintaan per 3 detik per pelanggan (dijaga lokal di klien API) |

Hal yang perlu diperhatikan:

- Pengaturan `sendRateLimitPerMinute` (bawaan 20, rentang 1-120) membatasi kiriman bot. Jangan diisi di atas 60 pada mode Convia.
- Setiap balasan bot memakai minimal 2 request (indikator mengetik + kirim pesan), belum termasuk percobaan ulang saat gagal.
- Server memanggil `GET /health` ke Convia setiap 60 detik untuk menentukan status `connected`. Itu sekitar **1.440 request per hari**. Belum diketahui apakah `/health` dihitung dalam kuota 1.000/hari. Bila dihitung, kuota Starter habis sebelum ada pesan. Interval ini belum bisa diatur lewat `.env` (lihat temuan di `docs/E2E-CONVIA.md`).
- Respons 429: klien membaca `Retry-After` (detik atau tanggal HTTP; itu ASUMSI). Balasan yang gagal karena 429 ditandai `failed` dan dapat dikirim ulang dari dashboard.

## 7. Biaya

Menurut halaman Harga Convia yang Anda salin (format webhook B): **Rp 25 per event terkirim**; percobaan ulang dan pengiriman gagal gratis. Kalimat itu bicara tentang event webhook yang Convia kirim ke server Anda, jadi yang dihitung kemungkinan besar adalah event masuk (mis. `message.received`, dan status delivered/read bila ikut dikirim), bukan pesan keluar. Itu penafsiran, belum dikonfirmasi. 1.000 event = Rp 25.000.

Yang belum jelas: apakah jenis event bisa dipilih (cukup `message.received` agar hemat); apakah pengiriman pesan lewat API, indikator mengetik, dan template punya tarif sendiri; apakah ada biaya Meta di luar tarif ini; dan aturan deposit (saldo habis kemungkinan membuat pengiriman gagal, belum diverifikasi). Konfirmasi dengan Convia sebelum produksi dan pantau tagihan minggu pertama.

## 8. Pertanyaan terbuka

Belum ada di dokumen Convia yang dilampirkan (semuanya ditulis sebagai ASUMSI di komentar kode):

1. Apakah Convia mengirim ulang webhook bila kita membalas 5xx; berapa kali dan jedanya.
2. Apakah webhook yang sama bisa tiba dua kali, dan apakah urutan event terjamin.
3. Masa berlaku `media_url` dan apakah unduhan butuh autentikasi (kode mengunduh tanpa header Authorization, hanya https).
4. Di mana secret webhook dibuat/diambil di dashboard Convia, dan apakah satu secret berlaku untuk kedua format.
5. Format header tanda tangan selain hex (mis. `sha256=...`) dan apakah ada timestamp anti-replay.
6. Format mana (A atau B) yang dikirim ke akun Anda, dan apakah keduanya bisa terjadi bersamaan.
7. Bentuk payload non-teks di format B (gambar, dokumen, lokasi). Saat ini hanya contoh teks yang dipakai; non-teks diproses dengan label dan catatan "format media belum diketahui".
8. Event status (delivered/read/failed) untuk format B.
9. Nama field nama profil pelanggan (kode Format A membaca `customer_name`, itu tebakan).
10. Apakah `/health` dan indikator mengetik dihitung dalam kuota harian dan biaya.
11. Aturan biaya template dan kapan template wajib.
12. Bentuk galat nyata untuk `window_closed`, rate limit, dan autentikasi.

## 9. Pemecahan masalah

| Gejala | Penyebab umum |
|---|---|
| Status `misconfigured` | `CONVIA_API_KEY` atau secret kosong di `.env`; lengkapi lalu restart |
| Webhook 401 | Secret berbeda, body diubah proxy sebelum sampai (harus byte asli), header salah untuk format itu |
| Webhook 503 | Mode convia belum lengkap konfigurasinya |
| Webhook 404 | Server berjalan di mode baileys |
| Status `disconnected` dengan "Convia tidak sehat" | API key salah, `CONVIA_BASE_URL` salah, atau Convia tak terjangkau |
| Balasan `failed` dan percakapan perlu perhatian | `window_closed`, kunci ditolak, 429, atau Convia tak terjangkau; periksa `error` di `/api/wa/status` dan log (tanpa nilai rahasia) |
