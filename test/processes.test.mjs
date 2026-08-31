// The Processes list merge logic: session shells plus OS stragglers, with the
// WMI scan and taskkill stubbed out. On a non-Windows `platform` the scan is a
// no-op, so `listProcesses` there returns only the registry rows - which is all
// this test needs to exercise the merge.

import test from 'node:test';
import assert from 'node:assert/strict';

import { listProcesses, killProcess } from '../src/lib/processes.mjs';
import { createShellRegistry } from '../src/lib/shell.mjs';

function fakePty(pid) {
  return {
    pid,
    onData() {}, onExit() {}, write() {}, resize() {}, kill() {},
  };
}

function registry() {
  let n = 0;
  return createShellRegistry({
    ptySpawn: async () => fakePty(2000 + n),
    platform: 'linux',
    env: {},
    newId: () => 'shell-' + (++n),
  });
}

test('listProcesses returns registry shells with project names, no scan off Windows', async () => {
  const reg = registry();
  await reg.open({ projectId: 'p1', cwd: '/a' });
  await reg.open({ projectId: 'p2', cwd: '/b' });

  const rows = await listProcesses({
    registry: reg,
    nameOf: (id) => ({ p1: 'Alpha', p2: 'Beta' }[id]),
    platform: 'linux',
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'session');
  assert.equal(rows[0].projectName, 'Alpha');
  assert.equal(rows[1].projectName, 'Beta');
  assert.ok(rows.every((r) => r.shellId && r.running));
});

test('listProcesses tolerates a missing project name', async () => {
  const reg = registry();
  await reg.open({ projectId: 'p1', cwd: '/a' });
  const rows = await listProcesses({ registry: reg, nameOf: () => undefined, platform: 'linux' });
  assert.equal(rows[0].projectName, null);
});

test('killProcess validates the pid and refuses off Windows', async () => {
  assert.equal((await killProcess(0)).status, 400);
  assert.equal((await killProcess(-5)).status, 400);
  assert.equal((await killProcess(1.5)).status, 400);
  assert.equal((await killProcess('x')).status, 400);
  assert.equal((await killProcess(1234, { platform: 'linux' })).status, 501);
});
