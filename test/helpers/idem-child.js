// Proses anak untuk tes idempotensi lintas-proses: menjalankan satu permintaan ber-key dan mencatat efeknya ke berkas.
import fs from 'node:fs';

if (!process.env.EFFECT_FILE) process.exit(0); // dipindai `node --test` sebagai berkas tes: abaikan bila bukan proses anak
const C = await import('../../src/connect.js');
const r = await C.withIdempotency('app-lintas', 'kunci-lintas-proses-1', async () => {
  fs.appendFileSync(process.env.EFFECT_FILE, 'efek\n');
  await new Promise((res) => setTimeout(res, 300));
  return { status: 200, body: { ok: true } };
}, { endpoint: 'POST /x', fingerprint: 'fp1' });
process.stdout.write(JSON.stringify({ status: r.status, replay: r.replay, code: r.body.code || null }));
process.exit(0);