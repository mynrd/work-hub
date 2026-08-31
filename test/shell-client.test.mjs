// lib/shell-client.mjs against a real in-process shell host (lib/shell-host-core.mjs
// listening on a throwaway TCP port, standing in for the named pipe / Unix
// socket the real daemon uses - see the header of shell-host.test.mjs for why
// TCP is used here). `spawnFn` is always a stub: nothing in this file ever
// spawns a real child process, and `connect` always dials the test's TCP
// port instead of the placeholder `pipe` string these tests put in the info
// file, so the client's actual pipe-name logic (shell-host.mjs's job) is
// never exercised here - only the client's own protocol and lifecycle logic.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createShellHostClient } from '../src/lib/shell-client.mjs';
import { createShellHostServer, PROTOCOL_VERSION } from '../src/lib/shell-host-core.mjs';
import { createShellRegistry } from '../src/lib/shell.mjs';

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

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-shell-client-'));
}

function infoPath(home) {
  return path.join(home, '.work-hub', 'shell-host.json');
}

function writeInfo(home, info) {
  fs.mkdirSync(path.join(home, '.work-hub'), { recursive: true });
  fs.writeFileSync(infoPath(home), JSON.stringify(info));
}

/** A real host on an ephemeral loopback port. Its default `onShutdown`
 *  actually closes the server, mirroring what the real daemon does (minus
 *  the process exit), so an ensure() flow that retires an old daemon over
 *  the wire sees it really go. */
async function startHost({ registry, token = 'tok', version = PROTOCOL_VERSION, onShutdown } = {}) {
  const built = registry ? { registry, spawned: [] } : registryWithFake();
  let serverRef;
  const shutdown = onShutdown ?? (() => { serverRef.close(); });
  const server = createShellHostServer({ registry: built.registry, token, version, onShutdown: shutdown });
  serverRef = server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    registry: built.registry,
    spawned: built.spawned,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a running daemon answers every op the client exposes, without spawning anything', async () => {
  const home = tempHome();
  const host = await startHost({ token: 'tok' });
  writeInfo(home, { version: PROTOCOL_VERSION, pipe: 'placeholder', token: 'tok', pid: 1, startedAt: Date.now() });
  const client = createShellHostClient({
    homeDir: home,
    spawnFn: () => { throw new Error('must not spawn - a valid daemon is already up'); },
    connect: () => net.createConnection(host.port, '127.0.0.1'),
  });

  const opened = await client.open({ projectId: 'p1', cwd: 'x', cols: 100, rows: 30 });
  assert.equal(opened.ok, true);
  assert.equal(opened.shell.name, null);
  const shellId = opened.shell.shellId;

  assert.equal((await client.write(shellId, 'ls\r')).ok, true);
  assert.deepEqual(host.spawned[0].pty.written, ['ls\r']);

  assert.equal((await client.resize(shellId, 120, 40)).ok, true);
  assert.deepEqual(host.spawned[0].pty.resized, [[120, 40]]);

  assert.equal((await client.rename(shellId, '  build  ')).ok, true);
  assert.equal((await client.status(shellId)).name, 'build');

  assert.equal((await client.list()).length, 1);
  assert.equal((await client.listForProject('p1')).length, 1);
  assert.deepEqual(await client.listForProject('nope'), []);

  assert.equal((await client.kill(shellId)).ok, true);
  assert.equal(await client.status(shellId), null);

  await client.open({ projectId: 'p1', cwd: 'x' });
  assert.equal((await client.killAll()).ok, true);
  assert.deepEqual(await client.list(), []);

  fs.rmSync(home, { recursive: true, force: true });
  await host.close();
});

test('a missing info file spawns the daemon and waits for it to come up', async () => {
  const home = tempHome();
  let currentPort;
  let spawnCalls = 0;
  const started = [];
  const spawnFn = () => {
    spawnCalls++;
    setTimeout(() => {
      startHost({ token: 'freshtok' }).then((host) => {
        started.push(host);
        currentPort = host.port;
        writeInfo(home, { version: PROTOCOL_VERSION, pipe: 'placeholder', token: 'freshtok', pid: 999, startedAt: Date.now() });
      });
    }, 50);
    return { on() {}, unref() {} };
  };
  const client = createShellHostClient({
    homeDir: home,
    spawnFn,
    connect: () => net.createConnection(currentPort, '127.0.0.1'),
  });

  const opened = await client.open({ projectId: 'p1', cwd: 'x' });
  assert.equal(opened.ok, true);
  assert.equal(spawnCalls, 1);

  for (const host of started) await host.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a protocol version mismatch shuts the old daemon down and spawns a replacement', async () => {
  const home = tempHome();
  let currentPort;
  const oldHost = await startHost({ token: 'oldtok', version: 999 });
  currentPort = oldHost.port;
  writeInfo(home, { version: 999, pipe: 'placeholder', token: 'oldtok', pid: 1, startedAt: Date.now() });

  let spawnCalls = 0;
  const started = [];
  const spawnFn = () => {
    spawnCalls++;
    startHost({ token: 'newtok' }).then((host) => {
      started.push(host);
      currentPort = host.port;
      writeInfo(home, { version: PROTOCOL_VERSION, pipe: 'placeholder', token: 'newtok', pid: 2, startedAt: Date.now() });
    });
    return { on() {}, unref() {} };
  };

  const client = createShellHostClient({
    homeDir: home,
    spawnFn,
    connect: () => net.createConnection(currentPort, '127.0.0.1'),
  });

  const result = await client.list();
  assert.deepEqual(result, []); // the fresh daemon, with nothing opened on it yet
  assert.equal(spawnCalls, 1);

  const oldStillUp = await new Promise((resolve) => {
    const s = net.createConnection(oldHost.port, '127.0.0.1');
    s.on('error', () => resolve(false));
    s.on('connect', () => { s.destroy(); resolve(true); });
  });
  assert.equal(oldStillUp, false, 'the old daemon should have shut down');

  for (const host of started) await host.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('an unreachable daemon and a spawn that never comes up answers 503, not a hang', async () => {
  const home = tempHome();
  const client = createShellHostClient({
    homeDir: home,
    spawnFn: () => ({ on() {}, unref() {} }), // spawns nothing real; no info file ever appears
    connect: () => net.createConnection(1, '127.0.0.1'), // nothing listens on port 1
  });

  const res = await client.write('shell-1', 'x');
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);

  fs.rmSync(home, { recursive: true, force: true });
});

test('attach streams to the listener until unsubscribe, which then stops it', async () => {
  const home = tempHome();
  const host = await startHost({ token: 'tok' });
  writeInfo(home, { version: PROTOCOL_VERSION, pipe: 'placeholder', token: 'tok', pid: 1, startedAt: Date.now() });
  const client = createShellHostClient({
    homeDir: home,
    spawnFn: () => { throw new Error('must not spawn'); },
    connect: () => net.createConnection(host.port, '127.0.0.1'),
  });

  const opened = await client.open({ projectId: 'p1', cwd: 'x' });
  const shellId = opened.shell.shellId;

  const events = [];
  const attached = await client.attach(shellId, (e) => events.push(e));
  assert.equal(attached.ok, true);
  assert.equal(attached.running, true);
  assert.equal(attached.replay, '');

  host.spawned[0].pty.emit('hello');
  await sleep(50);
  assert.deepEqual(events, [{ type: 'data', data: 'hello' }]);

  attached.unsubscribe();
  await sleep(50);
  host.spawned[0].pty.emit('unseen');
  await sleep(50);
  assert.deepEqual(events, [{ type: 'data', data: 'hello' }]);

  fs.rmSync(home, { recursive: true, force: true });
  await host.close();
});

test('attaching to an already-exited shell resolves with replay and forwards the exit event', async () => {
  const home = tempHome();
  const host = await startHost({ token: 'tok' });
  writeInfo(home, { version: PROTOCOL_VERSION, pipe: 'placeholder', token: 'tok', pid: 1, startedAt: Date.now() });
  const client = createShellHostClient({
    homeDir: home,
    spawnFn: () => { throw new Error('must not spawn'); },
    connect: () => net.createConnection(host.port, '127.0.0.1'),
  });

  const opened = await client.open({ projectId: 'p1', cwd: 'x' });
  const shellId = opened.shell.shellId;
  host.spawned[0].pty.emit('bye');
  host.spawned[0].pty.exit(9);

  const events = [];
  const attached = await client.attach(shellId, (e) => events.push(e));
  assert.equal(attached.ok, true);
  assert.equal(attached.running, false);
  assert.equal(attached.replay, 'bye');

  await sleep(50);
  assert.deepEqual(events, [{ type: 'exit', exitCode: 9 }]);

  fs.rmSync(home, { recursive: true, force: true });
  await host.close();
});
