// The web server's view of the shell host daemon (src/shell-host.mjs):
// everything serve.mjs used to get from `createShellRegistry` directly, now
// relayed over a named pipe / Unix socket to a process that outlives a server
// restart. See lib/shell-host-core.mjs for the wire protocol and the security
// story behind the token this file reads out of the info file and sends on
// every connection.
//
// The one thing that makes this file more than a thin RPC wrapper is
// `ensure()`: before any op, it makes sure a daemon is actually there to talk
// to - reading the info file, `ping`-ing it, and spawning a fresh one (or
// retiring an old one speaking a different protocol version first) when it is
// not. Every public method below calls it, so a caller never has to think
// about whether the daemon exists yet.
//
// Nothing here ever puts request data on a spawned process's command line.
// The only thing ever spawned from this file is the daemon itself
// (`node <path to shell-host.mjs>`, both fixed, plus fixed options) - the
// shellId/data/cwd/name fields a caller passes through `open`, `write`,
// `rename`, etc. travel only inside the JSON line written to the daemon's
// socket, exactly like they did as plain function arguments to the in-process
// registry this file replaces.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configDir } from './config.mjs';
import { PROTOCOL_VERSION } from './shell-host-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = path.resolve(__dirname, '..', 'shell-host.mjs');

/** One request/response round trip, or one `attach` header. */
const OP_TIMEOUT_MS = 5000;
/** Total budget for spawning a daemon and waiting for it to answer `ping`. */
const ENSURE_TIMEOUT_MS = 5000;
const ENSURE_POLL_MS = 100;

function infoPath(home) {
  return path.join(configDir(home), 'shell-host.json');
}

function readInfo(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(infoPath(home), 'utf8'));
    if (parsed && typeof parsed.pipe === 'string' && typeof parsed.token === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Deliberately NOT `.unref()`'d, unlike the op-timeout guards below: during a
 * poll wait there is no open socket or anything else holding the event loop
 * open, so an unref'd timer here would let Node decide the loop has nothing
 * left to do and exit early, abandoning whatever `await ensure()` chain is
 * still in flight.
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Creates the client. `homeDir`, `spawnFn` and `connect` exist purely so tests
 * never spawn a real detached process or open a real OS pipe unless they mean
 * to.
 */
export function createShellHostClient({ homeDir = undefined, spawnFn = spawn, connect = (pipe) => net.createConnection(pipe) } = {}) {
  const home = homeDir;
  let ensuring = null;

  /** One request line in, one response line out, over a fresh connection. */
  function shortOp(pipe, token, payload) {
    return new Promise((resolve) => {
      let socket;
      try {
        socket = connect(pipe);
      } catch (err) {
        resolve({ ok: false, status: 503, error: `Cannot reach the shell host: ${err.message}` });
        return;
      }

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* already gone */ }
        resolve(result);
      };

      const timer = setTimeout(() => finish({ ok: false, status: 503, error: 'The shell host did not answer in time.' }), OP_TIMEOUT_MS);
      timer.unref?.();

      socket.on('error', (err) => finish({ ok: false, status: 503, error: `Shell host connection error: ${err.message}` }));

      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        const line = buf.slice(0, idx);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          finish({ ok: false, status: 503, error: `Shell host sent malformed JSON: ${err.message}` });
          return;
        }
        finish(msg);
      });

      socket.on('connect', () => { socket.write(JSON.stringify({ token, ...payload }) + '\n'); });
    });
  }

  /**
   * The `attach` op: a long-lived connection. Resolves once the header (and
   * the replay line, if there was one) has arrived, with the same shape
   * lib/shell.mjs's synchronous `attach()` returns, so serve.mjs's stream
   * handler needs no change beyond awaiting it. Everything after that is fed
   * to `listener` as it arrives.
   */
  function attachOp(pipe, token, shellId, listener) {
    return new Promise((resolve) => {
      let socket;
      try {
        socket = connect(pipe);
      } catch (err) {
        resolve({ ok: false, status: 503, error: `Cannot reach the shell host: ${err.message}` });
        return;
      }

      let settled = false;
      let phase = 'header'; // header -> streaming (replay, if any, is just the first streamed line)
      let running = false;
      const unsubscribe = () => { try { socket.destroy(); } catch { /* already gone */ } };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* already gone */ }
        resolve({ ok: false, status: 503, error: 'The shell host did not answer the attach request in time.' });
      }, OP_TIMEOUT_MS);
      timer.unref?.();

      socket.on('error', (err) => {
        if (settled) return; // once attached, a later error just ends the stream - the caller already has unsubscribe
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, status: 503, error: `Shell host connection error: ${err.message}` });
      });

      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }

          if (phase === 'header') {
            if (!msg.ok) {
              settled = true;
              clearTimeout(timer);
              try { socket.destroy(); } catch { /* already gone */ }
              resolve(msg);
              return;
            }
            running = Boolean(msg.running);
            phase = 'streaming';
            // The host (lib/shell-host-core.mjs) writes the header and the
            // optional replay line back to back, with no I/O in between, so
            // on a local pipe/socket both are already sitting in `buf` by the
            // time either is parsed - unless there simply is no replay line
            // coming (an empty buffer). If nothing else is buffered right
            // now, there is nothing to wait for: resolve with an empty replay
            // immediately, rather than blocking on a line that was never
            // going to arrive.
            if (buf.indexOf('\n') === -1 && !settled) {
              settled = true;
              clearTimeout(timer);
              resolve({ ok: true, replay: '', running, unsubscribe });
            }
            continue;
          }

          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (msg.type === 'replay') {
              resolve({ ok: true, replay: msg.data, running, unsubscribe });
              continue;
            }
            // No replay line for an empty buffer - the first streamed message
            // is already live content (most often the exit event of a shell
            // that had already ended by the time attach() ran, but just as
            // often a shell that is very much alive and has simply already
            // printed something - e.g. its own first prompt - by the time
            // attach() was called). It must not reach `listener` before the
            // caller has seen the resolved `attach()` result (serve.mjs's
            // stream handler calls `res.writeHead()` right after that, and
            // `listener` there writes straight to the same response -
            // reversed, that is `ERR_HTTP_HEADERS_SENT`, uncaught, and it
            // takes the whole process down). A same-tick `queueMicrotask`
            // is not enough to guarantee that ordering: `attach()` (below)
            // returns this function's promise directly rather than an
            // already-`await`ed value, and unwrapping a thenable returned
            // from an async function costs the caller's continuation extra
            // microtask ticks of its own - ticks a microtask queued here,
            // at the same synchronous point as `resolve()`, is not
            // guaranteed to fall behind. `setImmediate` defers to the next
            // macrotask instead, by which point every microtask the
            // `await` chain needed - however many - has already run.
            resolve({ ok: true, replay: '', running, unsubscribe });
            setImmediate(() => listener(msg));
            continue;
          }

          setImmediate(() => listener(msg));
        }
      });

      socket.on('connect', () => { socket.write(JSON.stringify({ token, op: 'attach', shellId }) + '\n'); });
    });
  }

  async function spawnAndWait() {
    try {
      const child = spawnFn(process.execPath, [HOST_ENTRY], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on?.('error', () => { /* surfaced below by the poll simply never succeeding */ });
      child.unref?.();
    } catch (err) {
      return { ok: false, status: 503, error: `Could not start the shell host: ${err.message}` };
    }

    const deadline = Date.now() + ENSURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const info = readInfo(home);
      if (info) {
        const ping = await shortOp(info.pipe, info.token, { op: 'ping' });
        if (ping.ok && ping.version === PROTOCOL_VERSION) return { ok: true, pipe: info.pipe, token: info.token };
      }
      await sleep(ENSURE_POLL_MS);
    }
    return { ok: false, status: 503, error: 'Timed out waiting for the shell host to start.' };
  }

  async function ensureOnce() {
    const info = readInfo(home);
    if (info) {
      const ping = await shortOp(info.pipe, info.token, { op: 'ping' });
      if (ping.ok && ping.version === PROTOCOL_VERSION) return { ok: true, pipe: info.pipe, token: info.token };
      if (ping.ok) {
        // A live daemon, but speaking a protocol version this client does not
        // know: retire it and wait for it to actually go before starting a
        // replacement, so the two never briefly race for the same pipe name.
        await shortOp(info.pipe, info.token, { op: 'shutdown' });
        const giveUpAt = Date.now() + ENSURE_TIMEOUT_MS;
        while (Date.now() < giveUpAt) {
          const still = await shortOp(info.pipe, info.token, { op: 'ping' });
          if (!still.ok) break;
          await sleep(ENSURE_POLL_MS);
        }
      }
      // Either the ping failed outright (dead pipe, stale info file) or the
      // old daemon has now been asked to leave - either way, fall through to
      // starting a fresh one.
    }
    return spawnAndWait();
  }

  /** Dedupes concurrent callers so a burst of ops before the daemon exists
   *  spawns it exactly once, not once per caller. */
  function ensure() {
    if (!ensuring) ensuring = ensureOnce().finally(() => { ensuring = null; });
    return ensuring;
  }

  async function open({ projectId, cwd, cols, rows }) {
    const e = await ensure();
    if (!e.ok) return { ok: false, status: e.status, error: e.error };
    return shortOp(e.pipe, e.token, { op: 'open', projectId, cwd, cols, rows });
  }

  async function attach(shellId, listener) {
    const e = await ensure();
    if (!e.ok) return { ok: false, status: e.status, error: e.error };
    return attachOp(e.pipe, e.token, shellId, listener);
  }

  async function write(shellId, data) {
    const e = await ensure();
    if (!e.ok) return { ok: false, status: e.status, error: e.error };
    return shortOp(e.pipe, e.token, { op: 'write', shellId, data });
  }

  async function resize(shellId, cols, rows) {
    const e = await ensure();
    if (!e.ok) return { ok: false, status: e.status, error: e.error };
    return shortOp(e.pipe, e.token, { op: 'resize', shellId, cols, rows });
  }

  async function kill(shellId) {
    const e = await ensure();
    if (!e.ok) return { ok: false, status: e.status, error: e.error };
    return shortOp(e.pipe, e.token, { op: 'kill', shellId });
  }

  async function rename(shellId, name) {
    const e = await ensure();
    if (!e.ok) return { ok: false, status: e.status, error: e.error };
    return shortOp(e.pipe, e.token, { op: 'rename', shellId, name });
  }

  /** Mirrors the registry's `list()`: a bare array, never a rejected promise -
   *  an unreachable daemon just means no shells to report. */
  async function list() {
    const e = await ensure();
    if (!e.ok) return [];
    const res = await shortOp(e.pipe, e.token, { op: 'list' });
    return res.ok ? res.shells : [];
  }

  async function listForProject(projectId) {
    const e = await ensure();
    if (!e.ok) return [];
    const res = await shortOp(e.pipe, e.token, { op: 'list', projectId });
    return res.ok ? res.shells : [];
  }

  async function status(shellId) {
    const shells = await list();
    return shells.find((s) => s.shellId === shellId) ?? null;
  }

  async function killAll() {
    const e = await ensure();
    if (!e.ok) return { ok: false, status: e.status, error: e.error };
    return shortOp(e.pipe, e.token, { op: 'killAll' });
  }

  /** Not part of the registry's surface: an explicit "tell the daemon to go
   *  away" for callers that want it (and what `ensure()` uses internally on a
   *  protocol mismatch). A no-op, successfully, when no daemon is running. */
  async function shutdownHost() {
    const info = readInfo(home);
    if (!info) return { ok: true };
    return shortOp(info.pipe, info.token, { op: 'shutdown' });
  }

  return { open, attach, write, resize, kill, rename, status, list, listForProject, killAll, shutdownHost };
}
