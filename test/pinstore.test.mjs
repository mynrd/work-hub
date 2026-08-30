// AC 12: the PIN on disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pinPath, loadPin, savePin, verifyPin } from '../src/lib/pinstore.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-pin-'));
}

test('AC 12: the PIN lands in ~/.work-hub/pin.json, mode 0600', () => {
  const home = tempHome();
  assert.equal(pinPath(home), path.join(home, '.work-hub', 'pin.json'));
  savePin('123456', home);
  const file = pinPath(home);
  assert.equal(fs.existsSync(file), true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 12: what is written round-trips, and the right PIN verifies', () => {
  const home = tempHome();
  const written = savePin('654321', home);
  const read = loadPin(home);
  assert.equal(read.salt, written.salt);
  assert.equal(read.hash, written.hash);
  assert.equal(read.createdAt, written.createdAt);
  assert.equal(verifyPin(read, '654321'), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 12: a wrong PIN, or the wrong shape, never verifies', () => {
  const home = tempHome();
  const record = savePin('111222', home);
  assert.equal(verifyPin(record, '111223'), false);
  assert.equal(verifyPin(record, ''), false);
  assert.equal(verifyPin(record, null), false);
  assert.equal(verifyPin(record, undefined), false);
  assert.equal(verifyPin(record, 111222), false);
  assert.equal(verifyPin(record, '11122'), false);
  assert.equal(verifyPin(record, '1112222'), false);
  assert.equal(verifyPin(record, 'abcdef'), false);
  assert.equal(verifyPin(null, '111222'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 12: savePin refuses anything that is not exactly 6 ASCII digits', () => {
  const home = tempHome();
  for (const bad of ['12345', '1234567', 'abcdef', '12345a', '', null, undefined, 123456, ' 12345', '123 456']) {
    assert.throws(() => savePin(bad, home), /6 digits/);
  }
  assert.equal(loadPin(home), null, 'no file was left behind by a refused save');
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 12: a missing file reads as null', () => {
  const home = tempHome();
  assert.equal(loadPin(home), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 12: a present but damaged file throws rather than reading as unset', () => {
  const home = tempHome();
  const file = pinPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.throws(() => loadPin(home), /not valid JSON/);

  fs.writeFileSync(file, '{"createdAt":1}', 'utf8');
  assert.throws(() => loadPin(home), /"salt"\/"hash"/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 12: setting a PIN twice replaces it atomically, no temp file left behind', () => {
  const home = tempHome();
  savePin('111111', home);
  savePin('222222', home);
  assert.equal(verifyPin(loadPin(home), '222222'), true);
  assert.equal(verifyPin(loadPin(home), '111111'), false);
  assert.deepEqual(fs.readdirSync(path.join(home, '.work-hub')), ['pin.json']);
  fs.rmSync(home, { recursive: true, force: true });
});
