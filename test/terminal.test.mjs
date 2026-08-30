// The terminal launcher: what it actually spawns, and that the project path
// never becomes a command-line argument. No real window is opened here - the
// spawn is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openTerminal, openVerifyTerminal, sessionNamePrefix, REMOTE_CONTROL_COMMAND } from '../src/lib/terminal.mjs';

function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() {} };
  };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-terminal-'));

/** A throwaway project with `.work/<folder>/progress.json` holding `workflow`. */
function verifyFixture(folder, workflow) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-verify-'));
  const jobDir = path.join(dir, '.work', folder);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'progress.json'), JSON.stringify({ workflow }, null, 2));
  return dir;
}

const IN_PROGRESS_WORKFLOW = [{ step: 'build', status: 'done' }, { step: 'human-verification', status: 'in_progress' }];

test('the launcher runs claude remote-control --spawn same-dir in a new console', () => {
  const dir = tempDir();
  const calls = [];
  const result = openTerminal(dir, { spawnFn: fakeSpawn(calls), platform: 'win32', hostname: 'mynrd-dev' });

  const prefix = `mynrd-dev - ${path.basename(dir)}`;
  assert.equal(result.ok, true);
  assert.equal(result.command, `claude remote-control --spawn same-dir --remote-control-session-name-prefix ${prefix}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.deepEqual(calls[0].args.slice(-7), ['/k', 'claude', 'remote-control', '--spawn', 'same-dir', '--remote-control-session-name-prefix', prefix]);
  assert.equal(calls[0].args[0], '/c');
  assert.equal(calls[0].args[1], 'start');
  assert.equal(calls[0].opts.cwd, dir);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.shell, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the session name prefix is <computer name> - <folder name>', () => {
  assert.equal(sessionNamePrefix(path.join('D:', 'Work', 'git', 'mynrd', 'work-hub'), { hostname: 'mynrd-dev' }), 'mynrd-dev - work-hub');
  assert.equal(sessionNamePrefix(path.join('D:', 'Work', 'work-hub') + path.sep, { hostname: 'mynrd-dev' }), 'mynrd-dev - work-hub');
});

test('characters cmd.exe would act on are scrubbed out of the prefix', () => {
  const prefix = sessionNamePrefix(path.join('D:', 'a', 'foo & bar %PATH% (x)^!'), { hostname: 'mynrd|dev' });
  assert.equal(prefix, 'mynrd dev - foo bar PATH x');
  for (const ch of ['&', '|', '^', '%', '(', ')', '!', '<', '>', '"']) assert.ok(!prefix.includes(ch), `prefix still has ${ch}`);
  assert.ok(sessionNamePrefix(path.join('D:', 'a', 'x'.repeat(200)), { hostname: 'mynrd-dev' }).length <= 80);
});

test('when both halves scrub away to nothing the flag is left off', () => {
  // Nothing survives the scrub, so there is no prefix to pass and Claude Code
  // falls back to its own default.
  assert.equal(sessionNamePrefix(path.join('D:', '&&&'), { hostname: '&&&' }), '');

  // A hostname that scrubs to nothing still leaves the folder name.
  const dir = tempDir();
  const calls = [];
  const result = openTerminal(dir, { spawnFn: fakeSpawn(calls), platform: 'win32', hostname: '&&&' });
  assert.equal(result.command, `claude remote-control --spawn same-dir --remote-control-session-name-prefix ${path.basename(dir)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the project path travels as cwd, never as an argument', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work hub & spaces-'));
  const calls = [];
  openTerminal(dir, { spawnFn: fakeSpawn(calls), platform: 'win32' });
  assert.ok(calls[0].args.every((a) => !a.includes(dir)));
  assert.ok(calls[0].args.every((a) => !a.includes('&')));
  assert.equal(calls[0].opts.cwd, dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder that is not there is a 400, and nothing is spawned', () => {
  const calls = [];
  const result = openTerminal(path.join(os.tmpdir(), 'work-hub-nowhere-at-all'), { spawnFn: fakeSpawn(calls), platform: 'win32' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);
});

test('a non-Windows server says so and names the command to run by hand', () => {
  const dir = tempDir();
  const calls = [];
  const result = openTerminal(dir, { spawnFn: fakeSpawn(calls), platform: 'linux' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 501);
  assert.match(result.error, new RegExp(REMOTE_CONTROL_COMMAND.replace(/-/g, '\-')));
  assert.equal(calls.length, 0);
});

test('a spawn that throws becomes a 500, not a crash', () => {
  const dir = tempDir();
  const result = openTerminal(dir, {
    spawnFn: () => { throw new Error('EPERM'); },
    platform: 'win32',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.match(result.error, /EPERM/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── openVerifyTerminal (Verified button) ─────────────────────────────────────

test('AC 1: openVerifyTerminal spawns cmd /c start "<title>" powershell -Command "claude -p ..." and the window closes when the run ends', () => {
  const dir = verifyFixture('some-job', IN_PROGRESS_WORKFLOW);
  const calls = [];
  const result = openVerifyTerminal(dir, 'some-job', { spawnFn: fakeSpawn(calls), platform: 'win32' });

  assert.equal(result.ok, true);
  assert.equal(result.command, "claude -p '/mynrd-flow:mynrd-verified .work\\some-job' --model opus --effort high");
  assert.equal(result.cwd, dir);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['/c', 'start', 'Work Hub - verified some-job', '/wait', 'powershell.exe', '-Command', result.command]);
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.equal(calls[0].opts.cwd, dir);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 2: a folder name outside [A-Za-z0-9._-] is a 400 and nothing is spawned', () => {
  const dir = verifyFixture('some-job', IN_PROGRESS_WORKFLOW);
  for (const bad of ['some job', 'a/b', 'a\\b', 'a;b', 'a&b', 'a|b', 'a$b', 'a`b', "a'b", 'a"b', '']) {
    const calls = [];
    const result = openVerifyTerminal(dir, bad, { spawnFn: fakeSpawn(calls), platform: 'win32' });
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.equal(result.status, 400);
    assert.equal(calls.length, 0);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 2: a folder that resolves outside .work/ is a 400 and nothing is spawned', () => {
  const dir = verifyFixture('some-job', IN_PROGRESS_WORKFLOW);
  const calls = [];
  // ".." matches the character-class regex but must still be rejected as a traversal.
  const result = openVerifyTerminal(dir, '..', { spawnFn: fakeSpawn(calls), platform: 'win32' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 2: the folder name is the only non-literal token, and the project path only ever travels as cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work hub & spaces-'));
  fs.mkdirSync(path.join(dir, '.work', 'some-job'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.work', 'some-job', 'progress.json'), JSON.stringify({ workflow: IN_PROGRESS_WORKFLOW }, null, 2));

  const calls = [];
  const result = openVerifyTerminal(dir, 'some-job', { spawnFn: fakeSpawn(calls), platform: 'win32' });
  assert.equal(result.ok, true);
  assert.ok(calls[0].args.every((a) => !a.includes(dir)));
  assert.ok(calls[0].args.every((a) => !a.includes('&')));
  assert.equal(calls[0].opts.cwd, dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 3: a missing progress.json is a 404 and nothing is spawned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-verify-'));
  fs.mkdirSync(path.join(dir, '.work'), { recursive: true });
  const calls = [];
  const result = openVerifyTerminal(dir, 'no-such-job', { spawnFn: fakeSpawn(calls), platform: 'win32' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(calls.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 3: a workflow with no human-verification step in_progress is a 409 and nothing is spawned', () => {
  for (const workflow of [
    [],
    [{ step: 'human-verification', status: 'done' }],
    [{ step: 'build', status: 'in_progress' }],
    'not-an-array',
  ]) {
    const dir = verifyFixture('some-job', workflow);
    const calls = [];
    const result = openVerifyTerminal(dir, 'some-job', { spawnFn: fakeSpawn(calls), platform: 'win32' });
    assert.equal(result.ok, false, `expected ${JSON.stringify(workflow)} to be rejected`);
    assert.equal(result.status, 409);
    assert.equal(calls.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC 3: unparsable progress.json is a 409, like resolveJob', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-verify-'));
  const jobDir = path.join(dir, '.work', 'some-job');
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'progress.json'), '{ not json');
  const calls = [];
  const result = openVerifyTerminal(dir, 'some-job', { spawnFn: fakeSpawn(calls), platform: 'win32' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(calls.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 3: a non-Windows server says so and names the command to run by hand, nothing spawned', () => {
  const dir = verifyFixture('some-job', IN_PROGRESS_WORKFLOW);
  const calls = [];
  const result = openVerifyTerminal(dir, 'some-job', { spawnFn: fakeSpawn(calls), platform: 'linux' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 501);
  assert.match(result.error, /claude -p '\/mynrd-flow:mynrd-verified \.work\\some-job' --model opus --effort high/);
  assert.equal(calls.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 1: onExit fires with the exit code once the window closes (start /wait keeps the launcher alive that long)', () => {
  const dir = verifyFixture('exit-job', IN_PROGRESS_WORKFLOW);
  const handlers = {};
  const spawnFn = () => ({ on(event, fn) { handlers[event] = fn; }, unref() {} });
  const seen = [];
  const result = openVerifyTerminal(dir, 'exit-job', { spawnFn, platform: 'win32', onExit: (code) => seen.push(code) });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, []);
  handlers.exit(0);
  assert.deepEqual(seen, [0]);
});
