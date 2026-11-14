# FULL SAAS AUDIT REPORT — WA-AMN

Tanggal: 7 November 2026  
Objek: `C:\Users\AMNAN\Downloads\wa-amn` (paket `amnan-live` 0.2.0, commit `42d857e`)  
Mode: baca saja. Tidak ada perubahan source, konfigurasi, database produksi, atau pesan WhatsApp.

Acesio disebut hanya sebagai sistem lain yang memakai kontrak `/api/v1`. Audit ini tidak mengulang audit aplikasi Acesio.

## Previous Audit Verification

Laporan sebelumnya di berkas yang sama mencakup dua aplikasi. Di bawah ini hanya temuan yang menyentuh WA-AMN. Nomor baris dicek ulang pada source saat ini. Source aplikasi tidak berubah sejak suite tes pagi ini (`git status` hanya menandai laporan ini sebagai berkas baru).

| ID lama | Status | Bukti saat ini |
|---|---|---|
| F-01 Pesan ditandai seen sebelum selesai diproses | Still Exists | `src/whatsapp.js` baris 69–72 dan 116–118 |
| F-02 Baileys `7.0.0-rc14` tidak resmi | Still Exists | `package.json` dependensi |
| F-03 Berkas password awal | Not Reproducible | Temuan itu ada di Acesio, bukan WA-AMN. Daftar `data/` WA-AMN tidak berisi berkas kredensial awal |
| F-04 Server mendengarkan semua interface | Still Exists | `server.js` baris 360 `server.listen(PORT)` tanpa host |
| F-05 Idempotency-Key boleh kosong | Still Exists | `src/connect.js` baris 176–177 |
| F-06 Simpan idempotensi tertunda 200 ms | Still Exists | `src/connect.js` baris 155–165 |
| F-13 Cookie `csrf` tidak HttpOnly | Still Exists | `src/auth.js` baris 476–477 |
| F-15 Menu Integrasi terlihat untuk agent | Still Exists | `public/index.html` baris 33–39. Halaman menolak di `public/assets/js/pages/integrasi.js` baris 13–15. API tetap admin-only |
| F-16 Chat dua kolom sampai 767 px | Still Exists | `public/assets/css/style.css` baris 178. Pada 768 px tata letak dua kolom terlihat di browser |
| F-18 Idempotensi dan webhook di JSON | Still Exists | `src/connect.js` |
| F-07, F-08, F-09, F-10, F-11, F-12, F-14, F-17 | Not Reproducible pada WA-AMN | Temuan kode Acesio. Tidak ada regresi di WA-AMN karena berkas itu bukan bagian repo ini |

Tidak ada temuan lama WA-AMN yang berstatus Fixed atau Regressed.

---

## BAGIAN A — Executive Summary

WA-AMN adalah dashboard CRM dan bot WhatsApp untuk satu client per proses. Autentikasi, peran, CSRF, batas login, kunci API, dan webhook bertanda tangan sudah ada di server dan sebagian besar teruji otomatis. Itu belum membuatnya siap dipakai sebagai layanan produksi yang mengandalkan pesan masuk.

Kesiapan operasional: bisa dijalankan untuk satu client di mesin sendiri, dengan nomor uji, di belakang proxy. Kesiapan produksi: **belum**.

Risiko terbesar:

1. Pesan masuk dapat hilang dari pemrosesan ulang karena ditandai seen terlalu awal.
2. WhatsApp memakai pustaka tidak resmi. Nomor dapat dibatasi tanpa jalur Cloud API di kode yang hidup.
3. Proses membuka semua alamat jaringan. Tidak ada penolakan start seperti yang dimiliki aplikasi pendamping.
4. Pada 390 px dan 768 px menu utama terpotong. Ini terlihat di browser, bukan hanya di CSS.

Kesimpulan: fondasi keamanan dan uji otomatis kuat untuk satu instance. Jangan menyatakan alur WhatsApp harian sudah benar. Sambungan WhatsApp sungguhan tidak diuji pada audit ini.

---

## BAGIAN B — Architecture Overview

```text
Browser  --cookie sesi + CSRF-->  server.js :PORT (semua interface)
                                      |-- src/routes.js  (peran, lalu src/api/*.js)
                                      |-- SQLite data/amnan.db   lead, percakapan, pesan, seen
                                      |-- JSON  users, sessions, settings, connect-*
                                      |-- data/auth              sesi Baileys
                                      |
Aplikasi lain (Acesio, Booking) --Bearer amk_-->  /api/v1/*
WA-AMN --HMAC webhook--> URL yang didaftarkan admin
WA-AMN --Baileys--> WhatsApp
```

Tidak ada `tenant_id`. Multi-client dibuat `scripts/client.js`: satu folder `/opt/clients/<slug>`, satu `.env`, satu `DATA_DIR`, satu `DATA_KEY`, satu port mulai 8101, dan satu proses. Nginx contoh hanya mem-proxy ke `127.0.0.1` port client itu (`scripts/client.js` baris 118–131 dan 198–208). Isolasi adalah isolasi proses dan folder, bukan baris database bersama.

Modul yang benar-benar dimuat: `src/api/auth.js`, `bot.js`, `brand.js`, `crm.js`, `data.js`, `events.js`, `integrations.js`, `media.js`, `settings.js`, `v1.js`, `wa.js`, lalu `_legacy.js`. Peran `admin` dan `agent`. Kunci aplikasi bukan pengguna dashboard.

Alur data pelanggan: pesan Baileys menjadi percakapan dan lead di SQLite WA-AMN. Aplikasi lain tidak membaca berkas itu. Mereka mengirim kontak, kejadian, dan pesan lewat `/api/v1`. Data aplikasi disimpan di `lead.apps.<app>`, terpisah dari data bot.

---

## BAGIAN C — Security Audit

### Yang terbukti

- Password scrypt. Sesi menyimpan hash token, bukan token mentah. Tes `security-http` yang diulang hari ini: 24 lulus, termasuk sesi setelah restart dan CSRF.
- Tulisan ber-cookie tanpa `X-CSRF-Token` ditolak 403. Basic Auth tidak memakai CSRF. Tes lulus.
- Agent ditolak di pengguna, audit, pengaturan tulis, hapus lead, hapus percakapan, logout WhatsApp, dan seluruh `/api/integrations`. Penolakan ada di `src/routes.js` `adminOnly()` sebelum handler. Tes lulus.
- QR WhatsApp hanya untuk admin di handler yang hidup: `src/api/wa.js` baris 12.
- `/healthz` tidak mengembalikan nomor atau isi pesan. Tes lulus.
- `TRUST_PROXY=0` mengabaikan `X-Forwarded-For` palsu. Tes lulus.
- Unggahan logo menolak SVG dan HTML berkedok gambar. Tes brand di suite pagi lulus.
- Kunci Connect menyimpan hash rahasia. Daftar API tidak mengembalikan rahasia setelah dibuat. Tes connect lulus di suite pagi.
- Webhook menolak URL yang resolve ke alamat privat dan tidak mengikuti redirect. Tes lulus.
- Login tanpa pengguna menolak start, kecuali `ALLOW_NO_AUTH=1` saat belum ada pengguna. Tes lulus.
- Tidak ada reset password lewat tautan. Penggantian lewat admin atau CLI. Bukan lubang yang terbukti; juga bukan pemulihan mandiri.

### Temuan

**Bind semua interface.** `server.js` baris 360. Dashboard yang berisi nomor pelanggan dan QR dapat dijangkau dari LAN bila firewall terbuka. Cookie `Secure` hanya dipasang bila permintaan dianggap HTTPS (`src/auth.js` baris 472–477).

**Cookie CSRF bisa dibaca skrip halaman.** `src/auth.js` baris 477. Cookie sesi tetap HttpOnly. CSP membatasi skrip ke `'self'` (`server.js` baris 99–110). Satu celah skrip di origin yang sama cukup untuk menulis dengan sesi korban.

**Data di disk mesin audit.** Folder `data/` berisi `amnan.db`, `users.json`, `sessions.json`, `connect-keys.json`, `connect-webhooks.json`, `settings.json`, dan folder `auth` (sesi WhatsApp). `.env` ada. Isi tidak dibaca dan tidak disalin ke laporan ini. `.gitignore` mengabaikan `.env` dan `data/`. Risiko ini operasional: menyalin folder `data/` sama dengan menyalin sesi WhatsApp dan hash kunci. Enkripsi isi memakai `DATA_KEY` hanya bila diisi. Tidak diverifikasi apakah salinan produksi ini mengisi `DATA_KEY`, karena `.env` tidak dibuka.

**`_legacy.js` masih memuat salinan lama.** Handler hidup untuk status WA, CRM, dan percakapan ada di modul yang dimuat lebih dulu dan mengembalikan `true`, jadi salinan lama tidak jalan untuk rute yang sama pada urutan saat ini. Salinan lama `GET /api/wa/status` mengembalikan QR tanpa cek peran (`src/api/_legacy.js` baris 20). Itu tidak aktif selama `wa.js` tetap mengklaim rute tersebut. Ini utang yang bisa menjadi kebocoran QR bila urutan modul berubah.

SQL yang diperiksa di CRM dan penyimpanan memakai parameter. Tidak ada temuan SQL injection pada jalur yang dibaca. Itu bukan bukti seluruh string SQL aman.

---

## BAGIAN D — API Integration Audit

Endpoint yang diklaim modul hidup:

| Area | Path | Auth |
|---|---|---|
| Sesi | `GET /api/me`, `GET/POST /api/users`, `GET /api/audit` | cookie; tulis pengguna dan audit hanya admin |
| WhatsApp | `GET /api/wa/status`, `POST /api/wa/logout` | cookie; logout dan QR hanya admin |
| CRM | `GET/PATCH /api/leads`, stats, export, from-conversation, notes, block | cookie; DELETE admin |
| Percakapan | `GET/POST/DELETE /api/conversations...` termasuk send, resend, mode, read | cookie; hapus admin |
| Pesan bot | `GET/PUT /api/settings`, history, restore | cookie; PUT admin |
| Tester | `GET /api/tester`, `POST /api/tester/*` | cookie, semua peran yang login |
| Integrasi | `/api/integrations`, keys, webhooks, booking | admin |
| Data | `/api/data/status`, backup, retention | tulis admin |
| Media | `GET /api/media/:id` | cookie |
| Event | `GET /api/events` SSE | cookie |
| Kontrak | `GET /api/v1/ping`, kontak, pesan, event | Bearer, scope |
| Health | `GET /healthz` | publik |

`_legacy.js` mengulang sebagian path di atas dan tidak menambah path baru yang lolos dari modul sebelumnya. Bot tester dan percakapan di `bot.js` mengembalikan `true` untuk aksi yang dikenal.

Keandalan `/api/v1` terhadap 400, 401, 403, 429, 503, dan pengiriman ulang dengan kunci yang sama teruji di `test/connect-api.test.js` dan `test/connect.test.js` pada suite pagi (bagian itu lulus). Uji ini mock, bukan Acesio atau WhatsApp sungguhan.

Idempotensi tidak wajib. `withIdempotency` di `src/connect.js` baris 177 menjalankan efek bila header tidak ada. Hasil 2xx baru dijadwalkan ke disk 200 ms kemudian (baris 156–159). Proses mati di jendela itu dapat mengirim pesan kedua. 429 dan 503 sengaja tidak disimpan agar ulang diizinkan.

Dokumentasi `docs/INTEGRASI.md` sesuai endpoint v1 yang ada di `src/api/v1.js`, termasuk scope dan tanda tangan webhook. Selisih: dokumen menyebut UI webhook belum ada, sedangkan halaman Integrasi yang hidup adalah sambungan Booking (`public/assets/js/pages/integrasi.js`), bukan daftar webhook umum. Webhook umum tetap lewat `scripts/integrations.js` dan `POST /api/integrations/webhooks`.

---

## BAGIAN E — Dashboard Integration Audit

Arah keluar WA-AMN:

- Webhook HMAC ke URL langganan. Event v1 mencakup `lead.created`, `lead.hot`, `message.received` tanpa isi pesan, `conversation.attention`, `wa.status`. Ulang 5 dtk, 30 dtk, 5 menit, 30 menit, 2 jam, lalu berhenti. 50 gagal beruntun menonaktifkan langganan. Teruji di suite pagi.
- Tautan `{booking}` bertanda tangan bila Booking tersambung.
- Ada field Webhook URL terpisah di halaman Pengaturan (terlihat di browser sesi ini). Itu jalur notifikasi lama di settings, berbeda dari antrean Connect. Dua pintu keluar untuk “kabar ke sistem lain”.

Arah masuk:

- `PUT /api/v1/contacts/:phone` membuat atau memperbarui lead. Nama yang sudah ada tidak ditimpa (`src/api/v1.js` baris 88). Data aplikasi digabung ke `lead.apps[app]`, bukan ke `lead.data` bot.
- `POST /api/v1/events` menolak tipe yang awalannya bukan app milik kunci.
- `POST /api/v1/messages` mengirim teks. Nomor diblokir ditolak. WhatsApp mati mengembalikan 503 dan kuota harian dikembalikan.
- Acesio adalah klien kontrak ini. WA-AMN tidak memanggil API Acesio. Tidak ada webhook masuk dari Acesio di repo ini.

Sumber kebenaran:

| Data | Pemilik |
|---|---|
| Percakapan, pesan, sesi WhatsApp | WA-AMN |
| Lead dan status Hot | WA-AMN |
| Nama yang sudah terisi | WA-AMN; aplikasi lain tidak menimpa |
| Data khusus aplikasi (`apps.acesio`, booking) | aplikasi pemanggil, disimpan di lead WA-AMN |
| Jadwal, SOAP, komisi klinik | bukan WA-AMN |

Konflik nama antar-dashboard tidak diselesaikan dengan merge dua arah. Yang pertama menulis nama menang. Itu konsisten dengan dokumen, dan tidak diuji terhadap dua aplikasi hidup sekaligus.

Sesi ini tidak mengirim request ke Acesio atau ke URL produksi.

---

## BAGIAN F — WhatsApp Audit

Koneksi: `src/wa-connection.js` punya state idle, connecting, qr, open, closing. Putus biasa memakai backoff sampai sekitar 60 detik. Logout menghapus auth dan meminta QR. `connectionReplaced` berhenti dan meminta sambung manual. Tes `wa-connection.test.js` lulus di suite pagi, dengan adapter palsu.

Pesan masuk: `messages.upsert` tipe `notify` saja. Grup dan broadcast dibuang. Deduplikasi:

```69:72:src/whatsapp.js
      if (waId) {
        if (convs.seenMessage(waId)) return;
        convs.markSeen(waId);
      }
```

`handleIncoming` ada di dalam `try` yang sama. Kegagalan hanya di-log (baris 115–117). ID yang sudah di `seen_messages` tidak diproses lagi. Kondisi pemicu: exception setelah `markSeen`, lalu event yang sama datang lagi. Dampak: percakapan dan bot tidak melihat pesan itu. Reproduksi live tidak dijalankan. Pesan tanpa `key.id` tidak dideduplikasi.

Pesan keluar: antrean dan batas per menit yang sama untuk bot dan `/api/v1/messages`. Gagal kirim pada alur bot menandai `failed` dan bisa diulang dari UI. Tes pipeline gagal-kirim lulus dengan mock. Pengiriman ganda tetap mungkin bila idempotensi belum tersimpan (Bagian D) atau bila pengirim tidak mengirim kunci.

Bot: intent, data wajib, takeover admin, pesan basi, dan durasi sesi teruji di `test/bot-pipeline.test.js` dan tester. Halaman Bot Tester termuat di browser dan menjelaskan aturan Cold, Warm, New, dan Existing. NLU tidak diuji terhadap percakapan pelanggan sungguhan.

Sesi per client: path `data/auth` dihitung dari `DATA_DIR` (`src/wa-connection.js` baris 5). Dua client dengan `DATA_DIR` berbeda tidak berbagi sesi selama prosesnya tidak salah membaca env. Dua proses pada folder yang sama tidak diuji. Logout satu client tidak punya kode yang menyentuh folder client lain.

Live QR, pairing, dan satu pesan bolak-balik: **Belum diuji**. Server uji memakai `DISABLE_WA=1`. Folder `data/auth` produksi tidak dibuka.

---

## BAGIAN G — UI/UX Audit

Server uji: `127.0.0.1:8099`, `DATA_DIR` di folder temp, WhatsApp dimatikan, pengguna admin baru di folder itu. `data/users.json` produksi tidak berubah (waktu tulis tetap 31 Okt 2026). Server uji sudah dimatikan. Password uji tidak dicatat di sini.

Halaman yang termuat tanpa banner gagal muat, peran admin:

- Login, lalu masuk ke `#/crm`.
- CRM, Percakapan Masuk, Pesan, Bot Tester, Integrasi, Pengaturan.

### Desktop

1440×900, halaman CRM: tidak ada overflow dokumen (`scrollWidth` 1425). Header satu baris: Pesan, Percakapan, CRM, Bot Tester, Integrasi, Pengaturan. Kartu statistik, funnel kosong, dan tabel kosong dengan kalimat “Belum ada data lead masuk” terlihat utuh. Filter dan tombol Export CSV ada. 1280, 1366, dan 1920 tidak diukur. Pada 1440 tata letak ini profesional dan longgar.

### Mobile

390×800, CRM: dokumen tidak overflow (`scrollWidth` 390), kartu statistik menumpuk satu kolom. Menu terpotong. Tulisan yang terlihat dimulai di tengah kata, “cakapan Masuk”, dan “Pengaturan” tidak masuk layar. Penyebab di markup: nav `justify-center` sekaligus `overflow-x-auto` (`public/index.html` baris 33). Flex yang di-center memotong awal dan akhir bila tidak muat. 320, 360, 375, 414, dan 430 tidak dibuka. Pola yang sama akan memotong pada lebar di bawah 768 karena kelas `md` baru mulai di 768.

### Tablet

768×1024, Percakapan: panel kiri dan kanan tampil bersamaan, sesuai CSS yang baru menumpuk di bawah 768. Ada empty state “Belum ada percakapan masuk” dan “Pilih percakapan di sebelah kiri”. Logo terpotong menjadi “Amn”. Nav lebih lebar dari wadahnya (`scrollWidth` 476, `clientWidth` 393) sehingga “Pesan” dan “Pengaturan” terpotong. 820 dan 1024 tidak dibuka. Orientasi landscape tidak diuji.

### Akses dan keadaan lain

Login punya label. CRM punya skip link, `aria-current`, tombol periode `pressed`, dan empty state. Pengaturan memuat form bot, merek, webhook, dan Telegram; nilai rahasia tidak dibaca. Integrasi menampilkan “Belum tersambung” dan tidak menampilkan kode. Bot Tester memuat kontrol kirim, gagal kirim, dan pesan basi; tidak dipakai untuk mengirim apa pun.

Tidak ada screenshot untuk setiap lebar yang diminta. Tidak ada uji keyboard lengkap, kontras terukur, atau safe-area.

---

## BAGIAN H — Error dan Bug Audit

Backend: exception tak tertangkap mematikan proses lewat shutdown (`server.js` baris 349–355). Tes unhandledRejection lulus di pengulangan `security-http`. Itu lebih aman daripada terus berjalan, dan membuat satu bug menjatuhkan dashboard.

Frontend sesi browser: enam halaman admin termuat. Tidak ada teks “Gagal memuat halaman”. Konsol tidak direkam, jadi error konsol yang tidak mengubah DOM tidak tertutup.

Database: SQLite `leads`, `conversations`, `messages`, `seen_messages`, plus indeks `messages_seq` (`src/db.js` baris 115–120). Tidak ada foreign key antar tabel itu; relasi ada di dalam blob. Backup `scripts/backup.js` menyalin database ke `data/backups` dengan rotasi 14 hari. Skrip ini tidak dijalankan terhadap database produksi.

Suite `npm test` pagi ini, source tidak berubah sejak itu:

- 314 tes, 309 lulus, 5 gagal.
- Dua gagal di `test/security-http.test.js` (`ETIMEDOUT`, lalu audit “user.hapus” yang bergantung pada tes sebelumnya). Diulang sendiri: 24 lulus, 0 gagal. Bukan bug produk yang terbukti.
- Tiga gagal di `test/setup-laptop.test.js`: `EPERM` `symlinkSync` ke folder temp. Windows tanpa hak symlink. Pemasangan lewat tes itu tidak terbukti di mesin ini.

Dependensi: `npm audit` tidak dijalankan pada sesi ini. Baileys RC adalah risiko pasokan yang diketahui, bukan CVE yang baru dicek.

Edge yang terbukti di kode, belum dipicu live: pesan tanpa `waId` tidak dideduplikasi; `markSeen` sebelum sukses (Bagian F).

---

## BAGIAN I — Daily Workflow Audit

| Alur | Hasil sesi ini |
|---|---|
| Login admin | Terbukti di browser pada server temp. Masuk ke CRM |
| Login agent | Tidak dibuka di browser. API agent ditolak untuk aksi admin pada tes yang diulang |
| Logout | Tidak diklik. Tes HTTP logout lulus pada pengulangan keamanan |
| Sambung WhatsApp dan scan QR | Belum diuji. Badge menampilkan “WA Terputus” karena `DISABLE_WA=1` dan tidak ada status “dimatikan” di `BADGE` (`public/assets/js/app.js` baris 77–86). Status tak dikenal jatuh ke “Terputus” |
| Pesan masuk sampai tersimpan | Belum diuji live. Tes mock pipeline lulus di suite pagi |
| Bot membalas | Halaman tester termuat. Tidak ada pesan yang dikirim |
| CRM kosong | Terlihat: 0 lead, empty state, filter, export |
| Percakapan kosong | Terlihat di 768 px |
| Integrasi Booking | Halaman termuat, status belum tersambung. Kode tidak dibuat |
| Multi-client dua proses | Belum diuji. `createClient` di tes provision lulus di suite pagi. Tes symlink laptop gagal |
| Restart, database terkunci, internet mati | Belum diuji pada instance hidup |

---

## BAGIAN J — Business Logic Audit

Sumber utama tidak ganda untuk lead dan percakapan: keduanya di SQLite WA-AMN. Settings JSON adalah sumber pengaturan bot. Connect JSON adalah sumber kunci dan webhook baru.

Tumpang tindih yang masih ada:

- `src/api/_legacy.js` mengulang CRM, percakapan, settings, status WA, dan tester. Modul baru menang selama mereka mengembalikan `true`. Salinan lama tetap berbahaya bila ada yang mengembalikan `false` untuk method yang lama masih melayani.
- Webhook di Pengaturan dan webhook Connect adalah dua mekanisme kabar keluar.
- Halaman Pesan mengatur intent. Halaman Pengaturan mengatur pembuka, takeover, dan batas. Keduanya menulis settings. Bukan dua sumber, tetapi dua layar untuk satu dokumen. Konflik simpan bersamaan memakai versi `If-Match` di API settings (409). Tidak diuji dengan dua tab di browser.

Status lead Cold, Warm, Hot dan New, Existing dijelaskan di Bot Tester dan dihitung di CRM. Tes lead di suite pagi lulus. Tidak ada bukti dua rumus berbeda di halaman yang dimuat.

Agen melihat semua percakapan client yang sama. Itu sesuai model satu client per proses, bukan kebocoran antar-client.

---

## BAGIAN K — Performance dan Infrastructure

Tidak ada load test. Tidak ada angka CPU atau RAM.

Yang ada di kode: SQLite untuk percakapan, JSON untuk idempotensi 24 jam (dokumen sendiri menyebut ini tidak untuk ribuan permintaan per detik), backup database 14 hari, shutdown yang menutup server lalu menyimpan store. Media di `GET /api/media/:id` mendukung Range.

Backup JSON kunci, sesi WhatsApp (`data/auth`), dan media tidak otomatis ikut `scripts/backup.js`, yang hanya memanggil backup database. Restore database saja tidak mengembalikan sesi WhatsApp atau kunci Connect. Prosedur lengkap harus menyalin seluruh `DATA_DIR` beserta `DATA_KEY` bila enkripsi aktif. Restore itu tidak disimulasikan.

Deployment yang sesuai kode: proses per client, port localhost, Nginx di depan bila ada domain. Tidak ada health check eksternal selain `/healthz`. Tidak ada rotasi log aplikasi selain audit JSONL harian. Monitoring tidak ada.

`uncaughtException` keluar dari proses. Pengawas proses (PM2 atau systemd, disebut README) diperlukan agar dashboard bangkit lagi. PM2 tidak diuji di mesin ini.

---

## BAGIAN L — Testing Summary

Angka di bawah adalah hasil perintah yang benar-benar dijalankan. Suite tidak memisahkan unit dan integrasi, jadi tidak dipecah dengan perkiraan.

| Pengujian | Total | Lulus | Gagal | Belum diuji |
|---|---:|---:|---:|---:|
| `npm test` (`node --test`, pagi, source tidak berubah) | 314 | 309 | 5 | 0 berkas tes yang dilewati runner |
| `node --test test/security-http.test.js` (ulang) | 24 | 24 | 0 | 0 |
| API v1 dan webhook | termasuk dalam 314 | bagian connect lulus di log suite | 0 pada berkas connect | panggilan ke layanan produksi |
| WhatsApp live | 0 | 0 | 0 | QR, kirim, terima, reconnect sungguhan |
| UI browser | 6 halaman admin termuat | 6 mount tanpa banner gagal | 0 crash halaman | 1280, 1366, 1920, 320, 360, 375, 414, 430, 820, 1024, peran agent, konsol |
| Workflow hidup | login admin + halaman kosong | login dan empty state | 0 | pesan, bot, dua pengguna, restart |
| Multi-client hidup | 0 proses ganda | tes `createClient` ada di dalam 309 yang lulus | 3 tes setup gagal `EPERM` symlink | dua instance bersamaan |

Lima gagal suite: 2 tidak terulang saat berkas keamanan dijalankan sendiri; 3 adalah symlink Windows.

---

## BAGIAN M — Prioritas Perbaikan

| ID | Judul | Prioritas | Kategori | Lokasi | Bukti | Kondisi pemicu | Dampak | Reproduksi | Rekomendasi | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| AUD-001 | Pesan masuk ditandai seen sebelum sukses | P1 | WhatsApp | `src/whatsapp.js` 69–72, 116–118 | `markSeen` lalu `catch` hanya log | Exception setelah ID tercatat | Pesan tidak masuk CRM dan tidak dijawab | Lihat urutan kode. Live tidak dipicu | Tandai seen setelah simpan berhasil | Terbukti |
| AUD-002 | Baileys tidak resmi | P1 | WhatsApp | `package.json` | Versi `7.0.0-rc14` | Operasi harian pada nomor bisnis | Nomor dibatasi, tanpa SLA | Baca dependensi dan README | Nomor uji saja sampai ada keputusan Cloud API | Terbukti |
| AUD-003 | Listen semua interface | P1 | Security | `server.js` 360 | `listen(PORT)` tanpa host | Proses di mesin yang punya LAN | Dashboard dan QR terjangkau di jaringan | Baca panggilan listen. Port produksi tidak dipindai | Bind `127.0.0.1`, TLS di proxy | Terbukti |
| AUD-004 | Menu terpotong di layar sempit | P2 | UI | `public/index.html` 33; CSS chat `style.css` 178 | Screenshot 390 dan 768. Nav 768: lebar isi 476, wadah 393 | Lebar di bawah atau sama dengan 768 | Pengguna tidak melihat Pesan atau Pengaturan utuh | Buka CRM di 390 px dan percakapan di 768 px | Jangan `justify-center` pada nav yang bisa overflow. Tumpuk chat mulai 1024 bila tablet harus satu kolom | Terbukti |
| AUD-005 | Idempotency-Key tidak wajib | P2 | API | `src/connect.js` 176–177 | `if (!idemKey) return fn()` | Klien mengulang POST tanpa header | Pesan atau event ganda | Baca fungsi. Acesio mengirim kunci; klien lain belum tentu | Tolak POST pesan dan event tanpa kunci | Terbukti |
| AUD-006 | Idempotensi tersimpan terlambat | P2 | API | `src/connect.js` 155–165 | `setTimeout` 200 ms | Proses mati setelah kirim, sebelum flush | Pesan kedua | Baca `persistIdem` | Tulis sebelum efek samping, atau tampilkan risiko at-least-once di UI | Terbukti |
| AUD-007 | Salinan API lama masih dimuat | P2 | Logic | `src/api/_legacy.js` 20 dan seterusnya | QR tanpa cek peran di salinan; modul `wa.js` mengklaim rute lebih dulu | Urutan modul berubah atau handler baru mengembalikan false | QR atau aturan lama hidup lagi | Bandingkan klaim rute `wa.js` 9–12 dengan `_legacy.js` 20 | Hapus salinan setelah yakin tidak ada path tersisa | Terbukti sebagai kode mati yang berbahaya |
| AUD-008 | Dua jalur webhook | P2 | Integrasi | Pengaturan di UI; Connect di `src/connect.js` | Form “Webhook URL” termuat di `#/pengaturan` | Keduanya diisi | Kabar ganda atau salah jalur | Buka Pengaturan dan baca `docs/INTEGRASI.md` bagian webhook | Satu mekanisme, atau tulis di UI mana yang untuk apa | Terbukti |
| AUD-009 | Cookie CSRF tidak HttpOnly | P3 | Security | `src/auth.js` 477 | Cookie `csrf` tanpa HttpOnly; `session` HttpOnly | XSS di origin yang sama | Permintaan tulis atas nama korban | Baca `sessionCookies` | Pertahankan CSP. Jangan menambah skrip luar | Terbukti, desain disengaja |
| AUD-010 | Badge tidak membedakan WA dimatikan dan terputus | P3 | UI | `public/assets/js/app.js` 77–86 | Server uji `DISABLE_WA=1` menampilkan “WA Terputus” | Status di luar `connected`, `qr`, `connecting` | Operator mengira sambungan rusak | Login ke instance dengan WA dimatikan | Status “nonaktif” bila proses tidak memulai soket | Terbukti pada server uji |
| AUD-011 | Backup tidak mencakup sesi WA dan kunci | P2 | Infrastructure | `scripts/backup.js` | Skrip hanya memanggil backup database | Restore dari skrip itu saja | Sesi WhatsApp dan kunci Connect hilang | Baca skrip. Restore tidak dijalankan | Cadangkan seluruh `DATA_DIR` dan simpan `DATA_KEY` terpisah | Terbukti dari skrip |
| AUD-012 | Sesi WhatsApp dan `.env` ada di folder kerja | P1 | Security | `data/auth`, `.env` | Nama berkas ada. Isi tidak dibaca | Folder disalin atau dibagikan | Pengambilalihan nomor dan dashboard | Lihat daftar nama di `data/` | ACL ketat, enkripsi disk, jangan mengarsipkan `data/` ke ZIP | Terbukti keberadaannya |
| AUD-013 | Pemasangan laptop gagal di Windows audit | P3 | Workflow | `test/setup-laptop.test.js` | `EPERM` symlink | Menjalankan tes tanpa hak symlink | Tes tidak membuktikan installer | `npm test` | Tes tanpa symlink, atau dokumentasikan syarat Windows | Terbukti sebagai batas lingkungan |

P0 tidak ditetapkan. Tidak ada bukti bypass login, SQL injection, atau baca data client lain pada tes yang lulus.

Urutan kerja: AUD-001, AUD-003, AUD-012, AUD-002, AUD-005, AUD-006, AUD-004, AUD-011, AUD-007, AUD-008, lalu P3.

---

## BAGIAN N — Final Assessment

| Area | Status | Alasan |
|---|---|---|
| 1. Keamanan data | Perlu perbaikan | Auth dan CSRF teruji. Bind terbuka, sesi WA di folder kerja, cookie CSRF terbaca skrip |
| 2. Kualitas arsitektur | Baik | Satu proses per client, kontrak v1 terpisah dari database. Salinan `_legacy.js` masih dimuat |
| 3. API | Perlu perbaikan | Kontrak dan scope teruji dengan mock. Kunci idempoten belum wajib |
| 4. Integrasi dashboard | Perlu perbaikan | Arah v1 jelas dan teruji tiruan. Dua webhook. Tidak diuji dengan Acesio hidup |
| 5. WhatsApp | Bermasalah | Pustaka tidak resmi, pesan bisa hilang setelah `markSeen`, live belum diverifikasi |
| 6. UI desktop | Baik | CRM 1440 px utuh, empty state jelas. Lebar 1280, 1366, dan 1920 belum diukur |
| 7. UI mobile | Bermasalah | 390 px memotong menu. Lebar ponsel lain belum dibuka |
| 8. UI tablet | Perlu perbaikan | 768 px memotong logo dan menu; chat masih dua kolom |
| 9. Stabilitas | Perlu perbaikan | Exception mematikan proses dengan bersih. Tidak ada uji beban atau restart hidup |
| 10. Business logic | Perlu perbaikan | Lead dan percakapan punya satu sumber. Salinan API dan dua webhook masih ada |
| 11. Workflow harian | Belum dapat diverifikasi | Login dan halaman kosong terbukti. Pesan, bot, dan QR tidak dijalankan |
| 12. Multi-client | Perlu perbaikan | Desain folder dan port benar dan teruji di unit provision. Dua proses hidup tidak diuji. Installer Windows gagal di tes symlink |
| 13. Backup dan recovery | Perlu perbaikan | Backup database ada. Sesi WA dan kunci tidak ikut. Restore tidak disimulasikan |
| 14. Production readiness | Bermasalah | AUD-001 sampai AUD-003 dan AUD-012 belum ditutup. WhatsApp live belum diverifikasi |

Tidak ada nilai sempurna. Bagian yang lulus tes tiruan tetap bisa gagal pada nomor WhatsApp sungguhan dan pada layar yang belum dibuka.
