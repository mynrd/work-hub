// The enrolled secret on disk, and the sessions a code buys.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  enrollmentPath, loadEnrollment, saveEnrollment, clearEnrollment, createSessionStore, SESSION_TTL_MS,
} from '../src/lib/authstore.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-auth-'));
}

test('the secret lands in ~/.work-hub, never in the repo', () => {
  const home = tempHome();
  assert.equal(enrollmentPath(home), path.join(home, '.work-hub', 'totp.json'));
  saveEnrollment({ secret: 'JBSWY3DPEHPK3PXP', account: 'me@box' }, home);
  assert.equal(fs.existsSync(path.join(home, '.work-hub', 'totp.json')), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a machine with no pairing reads as null, not as an error', () => {
  const home = tempHome();
  assert.equal(loadEnrollment(home), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('what is written is what comes back', () => {
  const home = tempHome();
  const written = saveEnrollment({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'Work Hub', account: 'me@box' }, home);
  const read = loadEnrollment(home);
  assert.equal(read.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(read.issuer, 'Work Hub');
  assert.equal(read.account, 'me@box');
  assert.equal(read.createdAt, written.createdAt);
  fs.rmSync(home, { recursive: true, force: true });
});

// A corrupt file must not read as "nobody enrolled" - that turns the gate off.
test('a damaged or secretless file throws rather than reading as unenrolled', () => {
  const home = tempHome();
  const file = enrollmentPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.throws(() => loadEnrollment(home), /not valid JSON/);

  fs.writeFileSync(file, '{"issuer":"Work Hub"}', 'utf8');
  assert.throws(() => loadEnrollment(home), /no "secret" field/);

  fs.writeFileSync(file, '{"secret":"   "}', 'utf8');
  assert.throws(() => loadEnrollment(home), /no "secret" field/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('clearing is idempotent and reports whether there was anything there', () => {
  const home = tempHome();
  saveEnrollment({ secret: 'JBSWY3DPEHPK3PXP' }, home);
  assert.equal(clearEnrollment(home), true);
  assert.equal(clearEnrollment(home), false);
  assert.equal(loadEnrollment(home), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a session token is 256 bits, unique, and only valid until it expires', () => {
  const sessions = createSessionStore({ ttlMs: 1000 });
  const now = 1_700_000_000_000;

  const a = sessions.issue(now);
  const b = sessions.issue(now);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.token, b.token);
  assert.equal(a.expiresAt, now + 1000);

  assert.equal(sessions.validate(a.token, now), true);
  assert.equal(sessions.validate(a.token, now + 999), true);
  assert.equal(sessions.validate(a.token, now + 1000), false);
  assert.equal(sessions.size(now + 1000), 0, 'expired sessions are dropped, not just refused');
});

test('a token that was never issued is refused, whatever shape it is', () => {
  const sessions = createSessionStore();
  const { token } = sessions.issue();
  for (const bad of ['', null, undefined, 42, {}, token + 'x', token.slice(0, -1), token.toUpperCase()]) {
    assert.equal(sessions.validate(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(sessions.validate(token), true);
});

test('revoking clears every browser at once', () => {
  const sessions = createSessionStore();
  const a = sessions.issue();
  const b = sessions.issue();
  sessions.revokeAll();
  assert.equal(sessions.validate(a.token), false);
  assert.equal(sessions.validate(b.token), false);
});

test('the default session lasts 12 hours', () => {
  assert.equal(SESSION_TTL_MS, 12 * 60 * 60 * 1000);
  const now = 1_700_000_000_000;
  assert.equal(createSessionStore().issue(now).expiresAt, now + SESSION_TTL_MS);
});
