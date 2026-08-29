// TOTP, checked against the vectors in the RFCs rather than against itself -
// an authenticator app is the other half of this, and it follows the RFC, not
// this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  base32Encode, base32Decode, generateSecret, hotp, totp, verifyTotp,
  counterFor, otpauthUri, secondsRemaining, STEP_SECONDS, DIGITS,
} from '../src/lib/totp.mjs';

const RFC_KEY = Buffer.from('12345678901234567890');

test('RFC 4226 appendix D: the ten published HOTP values', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let counter = 0; counter < expected.length; counter++) {
    assert.equal(hotp(RFC_KEY, counter), expected[counter], `counter ${counter}`);
  }
});

test('RFC 6238 appendix B: the SHA1 rows, truncated to 6 digits', () => {
  const secret = base32Encode(RFC_KEY);
  const rows = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [seconds, expected] of rows) {
    assert.equal(totp(secret, { now: seconds * 1000 }), expected, `T = ${seconds}`);
  }
});

test('base32 round trips, and tolerates the padding and spacing users paste', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
  assert.equal(base32Decode('mzxw6ytboi').toString(), 'foobar');
  assert.equal(base32Decode('MZXW 6YTB OI======').toString(), 'foobar');
  for (let i = 0; i < 20; i++) {
    const secret = generateSecret();
    assert.equal(base32Encode(base32Decode(secret)), secret);
  }
});

test('a secret that is not base32 says which character broke it', () => {
  assert.throws(() => base32Decode('ABC1DEF'), /"1", which is not a base32 character/);
  assert.throws(() => base32Decode(''), /empty/);
});

test('a freshly generated secret is 160 bits of base32', () => {
  const secret = generateSecret();
  assert.equal(secret.length, 32);
  assert.equal(base32Decode(secret).length, 20);
  assert.notEqual(generateSecret(), generateSecret());
});

// This is the case that matters and the one a unit test of hotp alone misses:
// the code this module produces must be the code this module accepts.
test('the code the app would show is the code the server accepts', () => {
  for (let i = 0; i < 25; i++) {
    const secret = generateSecret();
    const result = verifyTotp(secret, totp(secret));
    assert.equal(result.ok, true, `round trip failed for ${secret}`);
    assert.equal(result.counter, counterFor());
  }
});

test('one step either side is accepted, two is not', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  for (const offset of [-1, 0, 1]) {
    const code = totp(secret, { now: now + offset * STEP_SECONDS * 1000 });
    assert.equal(verifyTotp(secret, code, { now }).ok, true, `offset ${offset}`);
  }
  for (const offset of [-2, 2]) {
    const code = totp(secret, { now: now + offset * STEP_SECONDS * 1000 });
    assert.equal(verifyTotp(secret, code, { now }).ok, false, `offset ${offset}`);
  }
});

test('the counter comes back so the caller can refuse a replay', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const previous = totp(secret, { now: now - STEP_SECONDS * 1000 });
  assert.equal(verifyTotp(secret, previous, { now }).counter, counterFor(now) - 1);
  assert.equal(verifyTotp(secret, totp(secret, { now }), { now }).counter, counterFor(now));
});

test('anything that is not six digits is refused before the secret is touched', () => {
  const secret = generateSecret();
  for (const bad of ['', '12345', '1234567', 'abcdef', '12345a', null, undefined, 123456, {}, '12 34 5']) {
    assert.deepEqual(verifyTotp(secret, bad), { ok: false, counter: null }, `accepted ${JSON.stringify(bad)}`);
  }
  // Spaces inside an otherwise correct code are stripped, not rejected: phones
  // and password managers copy it as "123 456".
  const code = totp(secret);
  assert.equal(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`).ok, true);
});

test('the otpauth URI carries what an authenticator needs, with no plus signs', () => {
  const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'Work Hub', account: 'me@box' });
  assert.equal(
    uri,
    'otpauth://totp/Work%20Hub:me%40box?secret=JBSWY3DPEHPK3PXP&issuer=Work%20Hub&algorithm=SHA1&digits=6&period=30',
  );
  assert.equal(uri.includes('+'), false, 'a literal + shows up as a plus sign in the app name');
  assert.equal(DIGITS, 6);
  assert.equal(STEP_SECONDS, 30);
});

test('the countdown runs from the step boundary', () => {
  assert.equal(secondsRemaining(0), 30);
  assert.equal(secondsRemaining(1000), 29);
  assert.equal(secondsRemaining(29_000), 1);
  assert.equal(secondsRemaining(30_000), 30);
});
