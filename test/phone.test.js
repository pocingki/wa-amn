// Uji pembantu nomor telepon (fungsi murni, tanpa berkas/jaringan/waktu).
import test from 'node:test';
import assert from 'node:assert/strict';
import { digitsOf, canonicalPhone, formatPhone, samePhone } from '../src/phone.js';

const CANON = '6281381688802';

test('digitsOf: buang pemisah, awalan tidak diubah', () => {
  assert.equal(digitsOf('+62 813-8168-8802'), CANON);
  assert.equal(digitsOf('(0813) 8168-8802'), '081381688802');
  assert.equal(digitsOf('0062 813'), '0062813');
  assert.equal(digitsOf(6281381688802), CANON);
});

test('digitsOf: kosong/null aman', () => {
  for (const v of ['', null, undefined, '   ', '+-()']) assert.equal(digitsOf(v), '');
});

test('canonicalPhone: berbagai tulisan nomor yang sama -> kanonik sama', () => {
  for (const v of ['+62 813-8168-8802', '6281381688802', '0813-8168-8802', '81381688802', '0062 813 8168 8802', '+62 (0) 813-8168-8802', 6281381688802]) {
    assert.equal(canonicalPhone(v), CANON, String(v));
  }
});

test('canonicalPhone: nomor non-62 dipertahankan', () => {
  assert.equal(canonicalPhone('+1 (415) 555-2671'), '14155552671');
  assert.equal(canonicalPhone('0044 7911 123456'), '447911123456');
  assert.equal(canonicalPhone('+60 12-345 6789'), '60123456789');
  assert.equal(canonicalPhone('+84 912 345 678'), '84912345678'); // bukan awalan seluler Indonesia
});

test('canonicalPhone: LID/BSUID/ID pengganti -> kosong', () => {
  for (const v of ['123456789012345@lid', '81381688802@lid', 'US.13491208655302741918', 'abc', '6281381688802@s.whatsapp.net', '+62 813 8168 880x']) {
    assert.equal(canonicalPhone(v), '', v);
  }
});

test('canonicalPhone: terlalu pendek atau terlalu panjang -> kosong', () => {
  assert.equal(canonicalPhone('0813'), '');
  assert.equal(canonicalPhone('12345678'), '');
  assert.equal(canonicalPhone('1234567890123456'), ''); // 16 digit
  assert.equal(canonicalPhone('+62 813 8168 8802 99999'), '');
  assert.equal(canonicalPhone('123456789'), '123456789'); // batas bawah 9
  assert.equal(canonicalPhone('123456789012345'), '123456789012345'); // batas atas 15
});

test('canonicalPhone: kosong/null/nilai aneh aman', () => {
  for (const v of ['', null, undefined, '   ', '+-', {}, [], NaN, true]) assert.equal(canonicalPhone(v), '');
});

test('formatPhone: digits (bawaan dan format tak dikenal)', () => {
  assert.equal(formatPhone(CANON, 'digits'), CANON);
  assert.equal(formatPhone(CANON), CANON);
  assert.equal(formatPhone(CANON, 'aneh'), CANON);
  assert.equal(formatPhone(CANON, null), CANON);
  assert.equal(formatPhone('+62 813-8168-8802', 'digits'), CANON);
});

test('formatPhone: international untuk 62', () => {
  assert.equal(formatPhone(CANON, 'international'), '+62 813-8168-8802');
  assert.equal(formatPhone('6281234567890', 'international'), '+62 812-3456-7890');
  assert.equal(formatPhone('0813-8168-8802', 'international'), '+62 813-8168-8802');
  assert.equal(formatPhone('628123456789', 'international'), '+62 812-3456-789');
});

test('formatPhone: international untuk non-62', () => {
  assert.equal(formatPhone('14155552671', 'international'), '+14155552671');
  assert.equal(formatPhone('60123456789', 'international'), '+60123456789');
});

test('formatPhone: kosong/null/ID pengganti -> kosong', () => {
  for (const f of ['digits', 'international']) {
    for (const v of ['', null, undefined, '123456789012345@lid', 'US.13491208655302741918']) {
      assert.equal(formatPhone(v, f), '', `${f}:${v}`);
    }
  }
});

test('samePhone: bandingkan kanonik', () => {
  const variants = ['+62 813-8168-8802', CANON, '0813-8168-8802', '81381688802'];
  for (const a of variants) for (const b of variants) assert.equal(samePhone(a, b), true, `${a} ~ ${b}`);
  assert.equal(samePhone(CANON, '6281381688803'), false);
  assert.equal(samePhone('14155552671', '+1 415 555 2671'), true);
  assert.equal(samePhone('+62 813-8168-8802', '14155552671'), false);
});

test('samePhone: kosong/tidak valid tidak pernah dianggap sama', () => {
  assert.equal(samePhone('', ''), false);
  assert.equal(samePhone(null, undefined), false);
  assert.equal(samePhone(CANON, null), false);
  assert.equal(samePhone('abc@lid', 'abc@lid'), false);
  assert.equal(samePhone('0813', '0813'), false);
});
