// The shell host daemon's protocol server, factored out of the entry point
// (src/shell-host.mjs) so it can run in-process under the test suite against a
// real `net` socket instead of a spawned child.
//
// Why a daemon at all: `createShellRegistry` (lib/shell.mjs) holds every live
// node-pty handle in the process that calls `open()`. When that process was
// the web server, a server restart killed or orphaned every open terminal.
// This file is the server side of moving that ownership into its own process:
// the web server (via lib/shell-client.mjs) becomes a client that reconnects
// after it restarts, and the shells - and their replay buffers - are still
// there.
//
// Protocol: newline-delimited JSON over a Windows named pipe or a Unix domain
// socket (see shell-host.mjs for which, and why). One connection per
// operation, except `attach`, which stays open for the life of the terminal:
// the client's first (and for every op but `attach`, only) line is
// `{ token, op, ...params }`; the server answers with one JSON line for a
// one-shot op, or a header line followed by a live stream of event lines for
// `attach`.
//
// Security: this pipe is exactly as dangerous as the in-process registry it
// replaces - the browser's keystrokes still end up as a shell's stdin,
// running as the user, BY DESIGN (see the security note atop lib/shell.mjs).
// `token` is what stands between "any local process" and that: it is a random
// 256-bit value shell-host.mjs mints once per daemon run and writes only to a
// file under the user's own profile (`~/.work-hub/shell-host.json`), which
// gets the OS's normal per-user file permissions - nobody else's account can
// read the token off disk, so nobody else's process can open a connection
// this server accepts. A wrong or missing token gets one JSON line and the
// socket destroyed - no op ever runs first. Every other field in a request
// (`shellId`, `data`, `cwd`, `name`, ...) is used purely as data - a map key,
// pty input bytes, a spawn `cwd`, a display string - never as a shell command
// or an argument; the fixed program and argument list still live entirely in
// lib/shell.mjs's `shellCommand`, untouched by anything that arrives here.
//
// Every socket gets an 'error' handler before anything else touches it: a
// client that vanishes mid-request (closes its pipe, the process dies) must
// never throw past this file and take the whole daemon down with it.

import net from 'node:net';

/** Bumped whenever the wire format below changes incompatibly. Both sides
 *  compare this on `ping`; a mismatch makes the client retire the old daemon
 *  and start a fresh one rather than talk a protocol it does not understand. */
export const PROTOCOL_VERSION = 1;

function writeLine(socket, obj) {
  if (socket.destroyed) return;
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch {
    /* the socket went away between the check above and the write; nothing to do */
  }
}

function endSocket(socket) {
  try { socket.end(); } catch { /* already gone */ }
}

/**
 * Builds the daemon's `net.Server`. The caller (shell-host.mjs in production,
 * a test in-process) is responsible for `.listen()`.
 *
 * `onShutdown` is what the `shutdown` op calls after telling the registry to
 * kill everything and answering the caller - the default closes this server
 * and exits the process, which is what a real daemon should do, but a test
 * that wants to keep asserting against the same server passes its own no-op
 * or flag-setting stand-in instead.
 */
export function createShellHostServer({ registry, token, version = PROTOCOL_VERSION, onShutdown } = {}) {
  const server = net.createServer((socket) => { handleConnection(socket); });

  const shutdown = onShutdown || (() => { server.close(); process.exit(0); });

  /** One shell's live output, relayed to a socket as it happens, mirroring
   *  the streaming response lib/serve.mjs used to write directly. */
  function handleAttach(socket, shellId) {
    const listener = (event) => {
      writeLine(socket, event);
      if (event.type === 'exit') endSocket(socket);
    };
    const attached = registry.attach(shellId, listener);
    if (!attached.ok) {
      writeLine(socket, attached);
      endSocket(socket);
      return;
    }

    writeLine(socket, { ok: true, running: attached.running });
    if (attached.replay) writeLine(socket, { type: 'replay', data: attached.replay });

    if (!attached.running) {
      // Already dead by the time we attached: there will be no future exit
      // event to relay, so this is the one place that event is synthesized
      // instead of forwarded.
      const status = registry.status(shellId);
      writeLine(socket, { type: 'exit', exitCode: status ? status.exitCode : null });
      attached.unsubscribe();
      endSocket(socket);
      return;
    }

    let unsubscribed = false;
    const cleanup = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      attached.unsubscribe();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  async function dispatch(socket, msg) {
    try {
      switch (msg.op) {
        case 'ping':
          writeLine(socket, { ok: true, version, pid: process.pid });
          endSocket(socket);
          return;

        case 'open': {
          const result = await registry.open({ projectId: msg.projectId, cwd: msg.cwd, cols: msg.cols, rows: msg.rows });
          writeLine(socket, result);
          endSocket(socket);
          return;
        }

        case 'attach':
          handleAttach(socket, msg.shellId);
          return;

        case 'write':
          writeLine(socket, registry.write(msg.shellId, msg.data));
          endSocket(socket);
          return;

        case 'resize':
          writeLine(socket, registry.resize(msg.shellId, msg.cols, msg.rows));
          endSocket(socket);
          return;

        case 'kill':
          writeLine(socket, registry.kill(msg.shellId));
          endSocket(socket);
          return;

        case 'rename':
          writeLine(socket, registry.rename(msg.shellId, msg.name));
          endSocket(socket);
          return;

        case 'list': {
          const shells = msg.projectId ? registry.listForProject(msg.projectId) : registry.list();
          writeLine(socket, { ok: true, shells });
          endSocket(socket);
          return;
        }

        case 'killAll':
          registry.killAll();
          writeLine(socket, { ok: true });
          endSocket(socket);
          return;

        case 'shutdown':
          registry.killAll();
          writeLine(socket, { ok: true });
          endSocket(socket);
          shutdown();
          return;

        default:
          writeLine(socket, { ok: false, status: 400, error: `Unknown op: ${JSON.stringify(msg.op)}` });
          endSocket(socket);
      }
    } catch (err) {
      // A handler above must never throw past the socket - a broken op is a
      // 500 to this one caller, not a crashed daemon.
      writeLine(socket, { ok: false, status: 500, error: err.message });
      endSocket(socket);
    }
  }

  function handleConnection(socket) {
    // Must be first: a client that disconnects mid-write (or mid-attach) is
    // routine, not a bug, and must never surface as an uncaught exception.
    socket.on('error', () => { /* a dropped client is not this daemon's problem */ });
    socket.setEncoding('utf8');

    let buf = '';
    let requestHandled = false;

    function onData(chunk) {
      if (requestHandled) return; // the request line has already been consumed
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      requestHandled = true;
      socket.removeListener('data', onData);

      const line = buf.slice(0, idx);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        writeLine(socket, { ok: false, status: 400, error: `Malformed request: ${err.message}` });
        endSocket(socket);
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.op !== 'string') {
        writeLine(socket, { ok: false, status: 400, error: 'Request must be a JSON object with a string `op`.' });
        endSocket(socket);
        return;
      }
      if (msg.token !== token) {
        writeLine(socket, { ok: false, status: 403, error: 'Bad or missing token.' });
        socket.destroy();
        return;
      }
      dispatch(socket, msg);
    }

    socket.on('data', onData);
  }

  return server;
}
