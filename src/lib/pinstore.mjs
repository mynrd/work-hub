// The PIN sign-in on disk: ~/.work-hub/pin.json, next to totp.json.
//
// A 6 digit PIN is one of a million values, so the hash below is NOT what
// protects it - the throttle in serve.mjs is (5 wrong per 60s puts a full
// sweep past 100 days, and a session is 12 hours anyway). scrypt at N=16384
// is here only so the file isn't a plaintext PIN; do not "fix" this later
// with a bigger N, that does not change the threat model.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { configDir } from './config.mjs';

const KEY_LEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const PIN_RE = /^\d{6}$/;

export function pinPath(home = os.homedir()) {
  return path.join(configDir(home), 'pin.json');
}

/**
 * Returns the stored PIN record, or null when no PIN has been set.
 *
 * A file that exists but cannot be read or parsed throws rather than
 * returning null - same reasoning as `loadEnrollment`: "no PIN" and "cannot
 * tell" must not collapse into the same answer.
 */
export function loadPin(home = os.homedir()) {
  const file = pinPath(home);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}. Delete it and set a PIN again.`);
  }
  if (!parsed || typeof parsed.salt !== 'string' || typeof parsed.hash !== 'string' || !parsed.salt || !parsed.hash) {
    throw new Error(`${file} has no "salt"/"hash" field. Delete it and set a PIN again.`);
  }
  return {
    salt: parsed.salt,
    hash: parsed.hash,
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : null,
  };
}

/** Writes the PIN atomically, then tightens the mode. Throws on anything that
 *  is not exactly 6 ASCII digits - the exchange and PUT routes both trust that. */
export function savePin(pin, home = os.homedir()) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
    throw new Error('PIN must be exactly 6 digits.');
  }

  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = pinPath(home);
  const tmp = path.join(dir, `pin.json.${process.pid}.tmp`);

  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pin, salt, KEY_LEN, SCRYPT_OPTS);
  const record = { salt: salt.toString('hex'), hash: key.toString('hex'), createdAt: Date.now() };

  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: the profile folder already gates it */ }
  return record;
}

/**
 * True only when `given` is exactly the PIN that produced `record`.
 *
 * A non-string or non-6-digit `given` is refused without hashing - there is
 * nothing to prove against and no reason to pay for scrypt on garbage input.
 */
export function verifyPin(record, given) {
  if (typeof given !== 'string' || !PIN_RE.test(given)) return false;
  if (!record || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(record.salt, 'hex');
    expected = Buffer.from(record.hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;

  const actual = crypto.scryptSync(given, salt, KEY_LEN, SCRYPT_OPTS);
  return crypto.timingSafeEqual(actual, expected);
}
