// The enrolled TOTP secret on disk, and the short-lived session tokens the
// browser trades a one-time code for.
//
// The secret lives in ~/.work-hub/totp.json, next to config.json, and NOT in a
// .env inside the repo: this repo gets committed, and a shared secret that can
// start `claude` under your account is one `git add -A` away from being pushed.
// The file is written 0600 (owner read/write only) on the platforms that honour
// it - on Windows it inherits the profile folder's permissions, which already
// exclude other users.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { configDir } from './config.mjs';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function enrollmentPath(home = os.homedir()) {
  return path.join(configDir(home), 'totp.json');
}

/**
 * Returns the enrollment, or null when nobody has enrolled yet.
 *
 * A file that exists but cannot be read or parsed throws rather than returning
 * null: "not enrolled" turns the gate off, so a corrupt file must stop the
 * server, not quietly open it.
 */
export function loadEnrollment(home = os.homedir()) {
  const file = enrollmentPath(home);
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
    throw new Error(`${file} is not valid JSON: ${err.message}. Delete it and enroll again.`);
  }
  if (!parsed || typeof parsed.secret !== 'string' || !parsed.secret.trim()) {
    throw new Error(`${file} has no "secret" field. Delete it and enroll again.`);
  }
  return {
    secret: parsed.secret.trim(),
    issuer: typeof parsed.issuer === 'string' ? parsed.issuer : 'Work Hub',
    account: typeof parsed.account === 'string' ? parsed.account : 'work-hub',
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : null,
  };
}

/** Writes the enrollment atomically, then tightens the mode. */
export function saveEnrollment({ secret, issuer = 'Work Hub', account = 'work-hub' }, home = os.homedir()) {
  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = enrollmentPath(home);
  const tmp = path.join(dir, `totp.json.${process.pid}.tmp`);
  const record = { secret, issuer, account, createdAt: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: the profile folder already gates it */ }
  return record;
}

export function clearEnrollment(home = os.homedir()) {
  try {
    fs.unlinkSync(enrollmentPath(home));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * The session tokens issued after a correct code.
 *
 * Memory only, on purpose: a restart should invalidate every browser, because
 * the whole point of the one-time code is that access is re-proved rather than
 * left lying in a file.
 */
export function createSessionStore({ ttlMs = SESSION_TTL_MS } = {}) {
  const sessions = new Map(); // token -> { expiresAt, via }

  function sweep(now) {
    for (const [token, record] of sessions) {
      if (record.expiresAt <= now) sessions.delete(token);
    }
  }

  return {
    // `arg` is `{ via }` for a real caller, or (from before `via` existed) a
    // bare `now` timestamp - both call shapes are kept working so nothing
    // that already calls `issue(now)` has to change.
    issue(arg, now = Date.now()) {
      let via = 'otp';
      if (typeof arg === 'number') {
        now = arg;
      } else if (arg && typeof arg === 'object') {
        via = arg.via ?? 'otp';
      }
      sweep(now);
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = now + ttlMs;
      sessions.set(token, { expiresAt, via });
      return { token, expiresAt };
    },

    /**
     * Constant-time across the whole set, so a token cannot be probed apart.
     * Returns a fresh `{ via, expiresAt }` for a live token, `false` otherwise -
     * every current caller only truth-tests the result, which `false` still does.
     */
    validate(given, now = Date.now()) {
      if (typeof given !== 'string' || !given) return false;
      sweep(now);
      const givenBuf = Buffer.from(given);
      let hit = null;
      for (const [token, record] of sessions) {
        const buf = Buffer.from(token);
        if (buf.length === givenBuf.length && crypto.timingSafeEqual(buf, givenBuf) && record.expiresAt > now) hit = record;
      }
      return hit ? { via: hit.via, expiresAt: hit.expiresAt } : false;
    },

    /** Removes one token. Returns whether it was there. */
    revoke(given) {
      if (typeof given !== 'string' || !given) return false;
      return sessions.delete(given);
    },

    revokeAll() {
      sessions.clear();
    },

    size(now = Date.now()) {
      sweep(now);
      return sessions.size;
    },
  };
}
