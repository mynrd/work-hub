// TOTP (RFC 6238) over HMAC-SHA1 (RFC 4226), plus the base32 alphabet the
// authenticator apps expect. node:crypto only - no package.json in this repo.
//
// Every knob is fixed at what Authy, Google Authenticator and 1Password all
// assume by default: SHA1, a 30 second step, 6 digits. A QR that carries
// non-default algorithm/digits parameters is silently ignored by some of them,
// so there is nothing to configure here on purpose.

import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const STEP_SECONDS = 30;
export const DIGITS = 6;

/** RFC 4648 base32, uppercase, no `=` padding - what every authenticator prints. */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Throws on any character outside the alphabet. Spaces and `=` are tolerated -
 *  users paste secrets with both. */
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=]/g, '');
  if (!clean) throw new Error('Secret is empty.');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`Secret contains ${JSON.stringify(ch)}, which is not a base32 character.`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 20-byte (160-bit) secret, the size RFC 4226 § 4 R6 requires. */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function counterBuffer(counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  return buf;
}

/** RFC 4226 HOTP: HMAC-SHA1, dynamic truncation, modulo 10^digits. */
export function hotp(secretBuf, counter, digits = DIGITS) {
  const mac = crypto.createHmac('sha1', secretBuf).update(counterBuffer(counter)).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function counterFor(nowMs = Date.now(), step = STEP_SECONDS) {
  return Math.floor(nowMs / 1000 / step);
}

/** The code an authenticator is showing right now, for the given secret. */
export function totp(secretBase32, { now = Date.now(), step = STEP_SECONDS, digits = DIGITS } = {}) {
  return hotp(base32Decode(secretBase32), counterFor(now, step), digits);
}

/**
 * Checks a typed code.
 *
 * `window` is how many steps either side of now are accepted - 1 means the code
 * stays good for the 30 seconds before and after its own slot, which covers
 * both a slow typist and a phone whose clock has drifted a little.
 *
 * Returns `{ ok, counter }`. The caller must remember `counter` and refuse a
 * second use of it: without that, a code shoulder-surfed off the screen works
 * again for the rest of its window.
 */
export function verifyTotp(secretBase32, code, { now = Date.now(), window = 1, step = STEP_SECONDS, digits = DIGITS } = {}) {
  const typed = String(code ?? '').replace(/\s/g, '');
  if (typed.length !== digits || !/^[0-9]+$/.test(typed)) return { ok: false, counter: null };

  const secret = base32Decode(secretBase32);
  const current = counterFor(now, step);
  const typedBuf = Buffer.from(typed);
  let match = null;
  // Every candidate is compared, and with timingSafeEqual, so neither the loop
  // length nor the compare leaks which step matched.
  for (let offset = -window; offset <= window; offset++) {
    const counter = current + offset;
    const candidate = Buffer.from(hotp(secret, counter, digits));
    if (candidate.length === typedBuf.length && crypto.timingSafeEqual(candidate, typedBuf)) match = counter;
  }
  return match === null ? { ok: false, counter: null } : { ok: true, counter: match };
}

/**
 * The `otpauth://` URI that goes into the QR. The label is `issuer:account` and
 * the issuer is repeated as a parameter - Authy reads the parameter, older apps
 * read the label prefix, so both are set to the same thing.
 */
export function otpauthUri({ secret, issuer = 'Work Hub', account = 'work-hub' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  // Built by hand, not with URLSearchParams: that encodes a space as `+`, and
  // some authenticators show the issuer with a literal plus sign in it.
  const params = [
    ['secret', secret],
    ['issuer', issuer],
    ['algorithm', 'SHA1'],
    ['digits', String(DIGITS)],
    ['period', String(STEP_SECONDS)],
  ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `otpauth://totp/${label}?${params}`;
}

/** Seconds until the current code rolls over - the countdown the enroll app shows. */
export function secondsRemaining(now = Date.now(), step = STEP_SECONDS) {
  return step - Math.floor(now / 1000) % step;
}
