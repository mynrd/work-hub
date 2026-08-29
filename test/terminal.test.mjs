// The terminal launcher: what it actually spawns, and that the project path
// never becomes a command-line argument. No real window is opened here - the
// spawn is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openTerminal, REMOTE_CONTROL_COMMAND } from '../src/lib/terminal.mjs';

function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() {} };
  };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-terminal-'));

test('the launcher runs claude remote-control --spawn same-dir in a new console', () => {
  const dir = tempDir();
  const calls = [];
  const result = openTerminal(dir, { spawnFn: fakeSpawn(calls), platform: 'win32' });

  assert.equal(result.ok, true);
  assert.equal(result.command, 'claude remote-control --spawn same-dir');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.deepEqual(calls[0].args.slice(-5), ['/k', 'claude', 'remote-control', '--spawn', 'same-dir']);
  assert.equal(calls[0].args[0], '/c');
  assert.equal(calls[0].args[1], 'start');
  assert.equal(calls[0].opts.cwd, dir);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.shell, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the project path travels as cwd, never as an argument', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work hub & spaces-'));
  const calls = [];
  openTerminal(dir, { spawnFn: fakeSpawn(calls), platform: 'win32' });
  assert.ok(calls[0].args.every((a) => !a.includes(dir)));
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
