// The shell registry: many ptys keyed by shellId, replay buffer, ordered
// fan-out, and exactly one exit event however a shell dies. All against a fake
// pty - node-pty itself is never loaded here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createShellRegistry, shellCommand, MARKER_ENV } from '../src/lib/shell.mjs';

function fakePty(pid) {
  const pty = {
    pid: pid ?? 4242,
    written: [],
    resized: [],
    killed: false,
    dataCb: null,
    exitCb: null,
    onData(cb) { pty.dataCb = cb; },
    onExit(cb) { pty.exitCb = cb; },
    write(d) { pty.written.push(d); },
    resize(c, r) { pty.resized.push([c, r]); },
    kill() { pty.killed = true; pty.exitCb?.({ exitCode: 0 }); },
    emit(d) { pty.dataCb(d); },
    exit(code) { pty.exitCb({ exitCode: code }); },
  };
  return pty;
}

function registryWithFake() {
  const spawned = [];
  let n = 0;
  const registry = createShellRegistry({
    ptySpawn: async (file, args, opts) => {
      const pty = fakePty(1000 + spawned.length);
      spawned.push({ file, args, opts, pty });
      return pty;
    },
    platform: 'win32',
    env: {},
    newId: () => 'shell-' + (++n),
  });
  return { registry, spawned };
}

test('shellCommand: pwsh on windows carries the marker; $SHELL elsewhere', () => {
  const win = shellCommand('pid|sid', 'win32', {});
  assert.equal(win.file, 'pwsh.exe');
  assert.ok(win.args.join(' ').includes(`$env:${MARKER_ENV}='pid|sid'`));
  assert.deepEqual(shellCommand('m', 'linux', { SHELL: '/bin/zsh' }), { file: '/bin/zsh', args: [] });
  assert.deepEqual(shellCommand('m', 'linux', {}), { file: '/bin/bash', args: [] });
});

test('open creates a new shell each time, keyed by shellId, and tags the marker', async () => {
  const { registry, spawned } = registryWithFake();
  const a = await registry.open({ projectId: 'p1', cwd: 'C:\\proj', cols: 100, rows: 30 });
  const b = await registry.open({ projectId: 'p1', cwd: 'C:\\proj' });
  assert.equal(a.ok, true);
  assert.equal(a.shell.shellId, 'shell-1');
  assert.equal(a.shell.projectId, 'p1');
  assert.equal(a.shell.pid, 1000);
  assert.equal(a.shell.cols, 100);
  assert.notEqual(a.shell.shellId, b.shell.shellId);
  assert.equal(spawned.length, 2);
  // The marker in the spawned env and on the command line carries project + shell id.
  assert.equal(spawned[0].opts.env[MARKER_ENV], 'p1|shell-1');
  assert.ok(spawned[0].args.join(' ').includes('p1|shell-1'));
});

test('open clamps nonsense dimensions to the defaults', async () => {
  const { registry } = registryWithFake();
  const opened = await registry.open({ projectId: 'p1', cwd: 'x', cols: 'wide', rows: 99999 });
  assert.equal(opened.shell.cols, 80);
  assert.equal(opened.shell.rows, 24);
});

test('a failed spawn answers 500 and registers nothing', async () => {
  const registry = createShellRegistry({ ptySpawn: async () => { throw new Error('no conpty'); } });
  const opened = await registry.open({ projectId: 'p1', cwd: 'x' });
  assert.equal(opened.ok, false);
  assert.equal(opened.status, 500);
  assert.equal(registry.size(), 0);
});

test('a missing node-pty answers 501', async () => {
  const registry = createShellRegistry({ ptySpawn: async () => { const e = new Error('gone'); e.notInstalled = true; throw e; } });
  const opened = await registry.open({ projectId: 'p1', cwd: 'x' });
  assert.equal(opened.ok, false);
  assert.equal(opened.status, 501);
});

test('list and listForProject group by project', async () => {
  const { registry } = registryWithFake();
  await registry.open({ projectId: 'p1', cwd: 'x' });
  await registry.open({ projectId: 'p1', cwd: 'x' });
  await registry.open({ projectId: 'p2', cwd: 'y' });
  assert.equal(registry.list().length, 3);
  assert.deepEqual(registry.listForProject('p1').map((s) => s.shellId), ['shell-1', 'shell-2']);
  assert.deepEqual(registry.listForProject('p2').map((s) => s.shellId), ['shell-3']);
});

test('attach replays what was printed before it and streams what comes after', async () => {
  const { registry, spawned } = registryWithFake();
  await registry.open({ projectId: 'p1', cwd: 'x' });
  spawned[0].pty.emit('before ');

  const events = [];
  const attached = registry.attach('shell-1', (e) => events.push(e));
  assert.equal(attached.ok, true);
  assert.equal(attached.replay, 'before ');
  assert.equal(attached.running, true);

  spawned[0].pty.emit('after');
  assert.deepEqual(events, [{ type: 'data', data: 'after' }]);

  attached.unsubscribe();
  spawned[0].pty.emit('unseen');
  assert.equal(events.length, 1);
});

test('attach to an unknown shell is a 404', () => {
  const { registry } = registryWithFake();
  const attached = registry.attach('nope', () => {});
  assert.equal(attached.ok, false);
  assert.equal(attached.status, 404);
});

test('the replay buffer keeps only the newest bytes', async () => {
  const { registry, spawned } = registryWithFake();
  await registry.open({ projectId: 'p1', cwd: 'x' });
  spawned[0].pty.emit('x'.repeat(300 * 1024));
  spawned[0].pty.emit('END');
  const attached = registry.attach('shell-1', () => {});
  assert.equal(attached.replay.length, 256 * 1024);
  assert.equal(attached.replay.endsWith('END'), true);
});

test('write forwards to the pty and validates its input', async () => {
  const { registry, spawned } = registryWithFake();
  await registry.open({ projectId: 'p1', cwd: 'x' });

  assert.equal(registry.write('shell-1', 'ls\r').ok, true);
  assert.deepEqual(spawned[0].pty.written, ['ls\r']);

  assert.equal(registry.write('shell-1', '').status, 400);
  assert.equal(registry.write('shell-1', 42).status, 400);
  assert.equal(registry.write('shell-1', 'x'.repeat(17 * 1024)).status, 413);
  assert.equal(registry.write('nope', 'ls').status, 409);
});

test('resize validates and forwards', async () => {
  const { registry, spawned } = registryWithFake();
  await registry.open({ projectId: 'p1', cwd: 'x' });

  assert.equal(registry.resize('shell-1', 120, 40).ok, true);
  assert.deepEqual(spawned[0].pty.resized, [[120, 40]]);
  assert.equal(registry.status('shell-1').cols, 120);

  assert.equal(registry.resize('shell-1', 1, 40).status, 400);
  assert.equal(registry.resize('shell-1', 120, 'tall').status, 400);
  assert.equal(registry.resize('nope', 80, 24).status, 409);
});

test('the pty exiting on its own notifies each listener exactly once', async () => {
  const { registry, spawned } = registryWithFake();
  await registry.open({ projectId: 'p1', cwd: 'x' });
  const events = [];
  registry.attach('shell-1', (e) => events.push(e));

  spawned[0].pty.exit(3);
  assert.deepEqual(events, [{ type: 'exit', exitCode: 3 }]);
  assert.equal(registry.status('shell-1').running, false);
  assert.equal(registry.status('shell-1').exitCode, 3);

  // A late kill of the already-dead shell adds no second exit event.
  registry.kill('shell-1');
  assert.equal(events.length, 1);
});

test('kill sends one exit event even though the fake pty also fires onExit', async () => {
  const { registry, spawned } = registryWithFake();
  await registry.open({ projectId: 'p1', cwd: 'x' });
  const events = [];
  registry.attach('shell-1', (e) => events.push(e));

  assert.equal(registry.kill('shell-1').ok, true);
  assert.equal(spawned[0].pty.killed, true);
  assert.equal(events.filter((e) => e.type === 'exit').length, 1);
  assert.equal(registry.status('shell-1'), null);
  assert.equal(registry.write('shell-1', 'ls').status, 409);
});

test('kill of an unknown shell is a 404', () => {
  const { registry } = registryWithFake();
  assert.equal(registry.kill('nope').status, 404);
});

test('killAll empties the registry', async () => {
  const { registry } = registryWithFake();
  await registry.open({ projectId: 'p1', cwd: 'x' });
  await registry.open({ projectId: 'p2', cwd: 'y' });
  registry.killAll();
  assert.equal(registry.size(), 0);
});

test('a listener that throws does not stop the others', async () => {
  const { registry, spawned } = registryWithFake();
  await registry.open({ projectId: 'p1', cwd: 'x' });
  const events = [];
  registry.attach('shell-1', () => { throw new Error('broken sink'); });
  registry.attach('shell-1', (e) => events.push(e));
  spawned[0].pty.emit('hello');
  assert.deepEqual(events, [{ type: 'data', data: 'hello' }]);
});

test('open refuses past the shell ceiling', async () => {
  const { registry } = registryWithFake();
  for (let i = 0; i < 40; i++) await registry.open({ projectId: 'p', cwd: 'x' });
  const over = await registry.open({ projectId: 'p', cwd: 'x' });
  assert.equal(over.ok, false);
  assert.equal(over.status, 429);
});
