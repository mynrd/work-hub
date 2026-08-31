// The shell host daemon's protocol server (lib/shell-host-core.mjs), exercised
// with real `net.Socket` connections against an in-process `net.Server`. A TCP
// loopback port stands in for the Windows named pipe / Unix socket the real
// daemon (src/shell-host.mjs) listens on - the protocol only cares about a
// duplex byte stream, and TCP keeps this file running the same on every
// platform. The registry underneath is the real createShellRegistry with a
// fake pty, exactly like shell.test.mjs - node-pty is never loaded here.

import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createShellHostServer } from '../src/lib/shell-host-core.mjs';
import { createShellRegistry } from '../src/lib/shell.mjs';

const TOKEN = 'test-token';

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

/** Starts a host on an ephemeral loopback port. */
async function startHost({ registry, onShutdown } = {}) {
  const built = registry ? { registry, spawned: [] } : registryWithFake();
  const onShutdownCalls = [];
  const server = createShellHostServer({
    registry: built.registry,
    token: TOKEN,
    onShutdown: onShutdown ?? (() => { onShutdownCalls.push(true); }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    registry: built.registry,
    spawned: built.spawned,
    onShutdownCalls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A raw connection that queues incoming JSON lines for `next()` to consume. */
function connectRaw(port) {
  const socket = net.createConnection(port, '127.0.0.1');
  const queue = [];
  const waiters = [];
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (waiters.length) waiters.shift()(msg);
      else queue.push(msg);
    }
  });
  return {
    socket,
    send(obj) { socket.write(JSON.stringify(obj) + '\n'); },
    sendRaw(text) { socket.write(text); },
    next(timeoutMs = 2000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a line')), timeoutMs);
        waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
      });
    },
    closed: new Promise((resolve) => socket.on('close', resolve)),
  };
}

/** One request line, collects exactly one response line, then the socket ends. */
async function oneShot(port, payload) {
  const conn = connectRaw(port);
  conn.send(payload);
  const line = await conn.next();
  return line;
}

test('a bad or missing token is 403 and the socket is closed, before any op runs', async () => {
  const host = await startHost();
  const bad = await oneShot(host.port, { token: 'wrong', op: 'ping' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 403);

  const missing = await oneShot(host.port, { op: 'ping' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 403);

  await host.close();
});

test('ping answers the protocol version and this process pid', async () => {
  const host = await startHost();
  const res = await oneShot(host.port, { token: TOKEN, op: 'ping' });
  assert.equal(res.ok, true);
  assert.equal(res.pid, process.pid);
  assert.equal(typeof res.version, 'number');
  await host.close();
});

test('malformed JSON is a 400, not a crash', async () => {
  const host = await startHost();
  const conn = connectRaw(host.port);
  conn.sendRaw('{ not json\n');
  const res = await conn.next();
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  await host.close();
});

test('an unknown op is a 400', async () => {
  const host = await startHost();
  const res = await oneShot(host.port, { token: TOKEN, op: 'frobnicate' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  await host.close();
});

test('open, write, then attach: the replay line always precedes live data', async () => {
  const host = await startHost();
  const opened = await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p1', cwd: 'x' });
  assert.equal(opened.ok, true);
  const shellId = opened.shell.shellId;

  host.spawned[0].pty.emit('before ');

  const wrote = await oneShot(host.port, { token: TOKEN, op: 'write', shellId, data: 'ls\r' });
  assert.equal(wrote.ok, true);
  assert.deepEqual(host.spawned[0].pty.written, ['ls\r']);

  const conn = connectRaw(host.port);
  conn.send({ token: TOKEN, op: 'attach', shellId });
  const header = await conn.next();
  assert.deepEqual(header, { ok: true, running: true });
  const replay = await conn.next();
  assert.deepEqual(replay, { type: 'replay', data: 'before ' });

  host.spawned[0].pty.emit('after');
  const live = await conn.next();
  assert.deepEqual(live, { type: 'data', data: 'after' });

  conn.socket.destroy();
  await host.close();
});

test('attaching to an already-exited shell gets replay then exit, and nothing more', async () => {
  const host = await startHost();
  const opened = await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p1', cwd: 'x' });
  const shellId = opened.shell.shellId;
  host.spawned[0].pty.emit('last words');
  host.spawned[0].pty.exit(7);

  const conn = connectRaw(host.port);
  conn.send({ token: TOKEN, op: 'attach', shellId });
  const header = await conn.next();
  assert.deepEqual(header, { ok: true, running: false });
  const replay = await conn.next();
  assert.deepEqual(replay, { type: 'replay', data: 'last words' });
  const exit = await conn.next();
  assert.deepEqual(exit, { type: 'exit', exitCode: 7 });

  await conn.closed;
  await host.close();
});

test('attaching to an unknown shell is a 404, not a stream', async () => {
  const host = await startHost();
  const res = await oneShot(host.port, { token: TOKEN, op: 'attach', shellId: 'nope' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  await host.close();
});

test('killing a shell mid-attach delivers exactly one exit event over the stream', async () => {
  const host = await startHost();
  const opened = await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p1', cwd: 'x' });
  const shellId = opened.shell.shellId;

  const conn = connectRaw(host.port);
  conn.send({ token: TOKEN, op: 'attach', shellId });
  assert.deepEqual(await conn.next(), { ok: true, running: true }); // no replay: the buffer is empty

  const killed = await oneShot(host.port, { token: TOKEN, op: 'kill', shellId });
  assert.equal(killed.ok, true);

  const exit = await conn.next();
  assert.deepEqual(exit, { type: 'exit', exitCode: 0 });
  await conn.closed;
  await host.close();
});

test('rename over the protocol reaches the registry', async () => {
  const host = await startHost();
  const opened = await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p1', cwd: 'x' });
  const shellId = opened.shell.shellId;

  const renamed = await oneShot(host.port, { token: TOKEN, op: 'rename', shellId, name: '  build  ' });
  assert.equal(renamed.ok, true);

  const list = await oneShot(host.port, { token: TOKEN, op: 'list' });
  assert.equal(list.shells.find((s) => s.shellId === shellId).name, 'build');

  const missing = await oneShot(host.port, { token: TOKEN, op: 'rename', shellId: 'nope', name: 'x' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);

  await host.close();
});

test('list and list-by-project mirror the registry', async () => {
  const host = await startHost();
  const a = await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p1', cwd: 'x' });
  const b = await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p1', cwd: 'x' });
  const c = await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p2', cwd: 'y' });

  const all = await oneShot(host.port, { token: TOKEN, op: 'list' });
  assert.equal(all.ok, true);
  assert.equal(all.shells.length, 3);

  const p1 = await oneShot(host.port, { token: TOKEN, op: 'list', projectId: 'p1' });
  assert.deepEqual(p1.shells.map((s) => s.shellId).sort(), [a.shell.shellId, b.shell.shellId].sort());

  const p2 = await oneShot(host.port, { token: TOKEN, op: 'list', projectId: 'p2' });
  assert.deepEqual(p2.shells.map((s) => s.shellId), [c.shell.shellId]);

  await host.close();
});

test('killAll empties the registry', async () => {
  const host = await startHost();
  await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p1', cwd: 'x' });
  await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p2', cwd: 'y' });

  const res = await oneShot(host.port, { token: TOKEN, op: 'killAll' });
  assert.equal(res.ok, true);

  const list = await oneShot(host.port, { token: TOKEN, op: 'list' });
  assert.deepEqual(list.shells, []);

  await host.close();
});

test('shutdown answers ok and calls the injected onShutdown', async () => {
  const host = await startHost();
  await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p1', cwd: 'x' });

  const res = await oneShot(host.port, { token: TOKEN, op: 'shutdown' });
  assert.equal(res.ok, true);
  assert.equal(host.onShutdownCalls.length, 1);
  // The registry is torn down as part of shutdown, same as killAll.
  assert.equal(host.registry.size(), 0);

  await host.close();
});

test('a client disconnecting mid-attach unsubscribes from the registry', async () => {
  const { registry, spawned } = registryWithFake();
  let listenerCount = 0;
  const rawAttach = registry.attach;
  registry.attach = (id, listener) => {
    const result = rawAttach(id, listener);
    if (result.ok) {
      listenerCount++;
      const rawUnsubscribe = result.unsubscribe;
      result.unsubscribe = () => { listenerCount--; rawUnsubscribe(); };
    }
    return result;
  };

  const host = await startHost({ registry });
  const opened = await oneShot(host.port, { token: TOKEN, op: 'open', projectId: 'p1', cwd: 'x' });
  const shellId = opened.shell.shellId;

  const conn = connectRaw(host.port);
  conn.send({ token: TOKEN, op: 'attach', shellId });
  await conn.next(); // header
  assert.equal(listenerCount, 1);

  conn.socket.end();
  await conn.closed;
  // The server's 'close' handler runs off the same event; give it a turn.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listenerCount, 0);

  spawned[0].pty.emit('still alive'); // must not throw with zero listeners
  await host.close();
});
