// Real shells running under the server, mirrored to the page.
//
// A project can hold several ptys at once (a pty is the OS object that makes a
// child process believe it is talking to a real console, so interactive
// programs - `claude` included - behave exactly as they do in a window). Each
// shell is keyed by a generated shellId, not by project, so a project's
// Terminal tab can open a `Terminal 1 | Terminal 2 | +` strip. Everything a
// shell prints is kept in a bounded replay buffer and pushed to every attached
// listener; everything typed on the page is written to the pty's stdin. Each
// shell also carries a user-set `name` (null until renamed) purely for the tab
// strip label - it never touches the spawned command or the marker.
//
// This is the file's whole security story: the browser sends raw keystrokes
// and the server feeds them to a shell running as the user. That is arbitrary
// command execution BY DESIGN - the same power `claude` runs already have -
// so the routes in serve.mjs sit behind the same session gate, and nothing
// here interprets or builds a command line from user input: the only spawned
// program is a fixed shell binary with fixed arguments, and user input only
// ever travels as pty input, never as an argument.
//
// The one templated argument is the marker (WORK_HUB_SHELL='<projectId>|<shellId>'),
// and both halves are values this server generated - a config-derived project
// id and a UUID - never anything from a request body. The marker lets an
// outside query (WMI on Windows) recognise a Work Hub shell that outlived the
// server, and sets $env:WORK_HUB_SHELL inside the shell so scripts can too.
//
// node-pty is the project's one third-party runtime dependency (there is no
// pty access in Node's built-ins). It is imported lazily so every other part
// of the server - and the test suite - works without node_modules present;
// a missing module answers 501 on the terminal routes instead of taking the
// process down at import time.

import crypto from 'node:crypto';

/** Replay buffer cap per shell. Enough to repaint a busy screen. */
const MAX_BUFFER_BYTES = 256 * 1024;

/** One POST of keystrokes may not exceed this. Pasted text stays well under it. */
const MAX_INPUT_BYTES = 16 * 1024;

/** A ceiling so a stuck "+" cannot spawn shells without bound. */
const MAX_SHELLS = 40;

/** A tab name is cosmetic, not a path or an argument - the cap just keeps a tab strip readable. */
const MAX_NAME_LENGTH = 60;

const MIN_DIM = 2;
const MAX_DIM = 500;

/** The env var name planted in every shell, and matched by the Processes query. */
export const MARKER_ENV = 'WORK_HUB_SHELL';

/**
 * The fixed program and arguments for one shell, including the marker. `marker`
 * is server-generated (`<projectId>|<shellId>`), never request data.
 */
export function shellCommand(marker, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    // -NoExit keeps the shell interactive after the marker assignment runs.
    return { file: 'pwsh.exe', args: ['-NoLogo', '-NoExit', '-Command', `$env:${MARKER_ENV}='${marker}'`] };
  }
  return { file: env.SHELL || '/bin/bash', args: [] };
}

function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_DIM || n > MAX_DIM) return fallback;
  return n;
}

async function defaultPtySpawn(file, args, opts) {
  let pty;
  try {
    pty = await import('node-pty');
  } catch (err) {
    const e = new Error(`node-pty is not installed (${err.message}). Run \`npm install\` in the Work Hub folder.`);
    e.notInstalled = true;
    throw e;
  }
  return pty.spawn(file, args, opts);
}

/**
 * Holds every live shell, keyed by shellId. `ptySpawn` is injectable so the
 * tests never need the native module; `newId` is injectable so they get stable
 * ids.
 */
export function createShellRegistry({
  ptySpawn = defaultPtySpawn,
  platform = process.platform,
  env = process.env,
  newId = () => crypto.randomUUID(),
} = {}) {
  /** @type {Map<string, object>} */
  const shells = new Map();

  function publicView(shell) {
    if (!shell) return null;
    return {
      shellId: shell.shellId,
      projectId: shell.projectId,
      pid: shell.pty && typeof shell.pty.pid === 'number' ? shell.pty.pid : null,
      running: shell.running,
      command: shell.command,
      cwd: shell.cwd,
      cols: shell.cols,
      rows: shell.rows,
      startedAt: shell.startedAt,
      exitCode: shell.exitCode,
      name: shell.name,
    };
  }

  function broadcast(shell, event) {
    for (const listener of shell.listeners) {
      try { listener(event); } catch { /* a broken sink must not stop the others */ }
    }
  }

  /**
   * The one place a shell dies. `kill()` and the pty's own exit callback both
   * land here, in either order, and the second call is a no-op - listeners
   * must see exactly one exit event, because the stream handler ends its
   * response on it.
   */
  function endShell(shell, exitCode) {
    if (shell.exited) return;
    shell.exited = true;
    shell.running = false;
    shell.exitCode = typeof exitCode === 'number' ? exitCode : null;
    broadcast(shell, { type: 'exit', exitCode: shell.exitCode });
    shell.listeners.clear();
  }

  /**
   * Starts a new shell for a project. Always creates one - there is no reuse;
   * the caller decides how many a project may hold.
   * @returns {Promise<{ ok: true, shell: object } | { ok: false, status: number, error: string }>}
   */
  async function open({ projectId, cwd, cols, rows, startedAt = Date.now() }) {
    if (shells.size >= MAX_SHELLS) {
      return { ok: false, status: 429, error: `Too many shells are open (${MAX_SHELLS}). Close some before opening more.` };
    }

    const shellId = newId();
    const marker = `${projectId}|${shellId}`;
    const { file, args } = shellCommand(marker, platform, env);
    const shell = {
      shellId,
      projectId,
      cwd,
      command: [file, ...args].join(' '),
      cols: clampDim(cols, 80),
      rows: clampDim(rows, 24),
      running: false,
      exited: false,
      startedAt,
      exitCode: null,
      buffer: '',
      listeners: new Set(),
      pty: null,
      name: null,
    };

    let proc;
    try {
      proc = await ptySpawn(file, args, {
        name: 'xterm-256color',
        cols: shell.cols,
        rows: shell.rows,
        cwd,
        // The marker also lives in the environment, so a shell on any platform
        // can read $WORK_HUB_SHELL even where the command-line marker is absent.
        env: { ...env, [MARKER_ENV]: marker },
      });
    } catch (err) {
      return { ok: false, status: err.notInstalled ? 501 : 500, error: `Could not start ${file}: ${err.message}` };
    }

    shell.pty = proc;
    shell.running = true;
    shells.set(shellId, shell);

    proc.onData((data) => {
      shell.buffer += data;
      if (shell.buffer.length > MAX_BUFFER_BYTES) {
        shell.buffer = shell.buffer.slice(shell.buffer.length - MAX_BUFFER_BYTES);
      }
      broadcast(shell, { type: 'data', data });
    });

    proc.onExit(({ exitCode }) => endShell(shell, exitCode));

    return { ok: true, shell: publicView(shell) };
  }

  /**
   * Subscribes a sink to a shell's output. The current replay buffer comes
   * back so a fresh page repaints what the screen already shows.
   * @returns {{ ok: true, replay: string, running: boolean, unsubscribe: () => void } | { ok: false, status: number, error: string }}
   */
  function attach(shellId, listener) {
    const shell = shells.get(shellId);
    if (!shell) return { ok: false, status: 404, error: 'No such shell. It may have been closed.' };
    shell.listeners.add(listener);
    return {
      ok: true,
      replay: shell.buffer,
      running: shell.running,
      unsubscribe: () => { shell.listeners.delete(listener); },
    };
  }

  /** @returns {{ ok: true } | { ok: false, status: number, error: string }} */
  function write(shellId, data) {
    const shell = shells.get(shellId);
    if (!shell || !shell.running) return { ok: false, status: 409, error: 'That shell is not running.' };
    if (typeof data !== 'string' || data.length === 0) return { ok: false, status: 400, error: '`data` must be a non-empty string.' };
    if (Buffer.byteLength(data) > MAX_INPUT_BYTES) return { ok: false, status: 413, error: `Input exceeds ${MAX_INPUT_BYTES} bytes.` };
    try { shell.pty.write(data); } catch (err) {
      return { ok: false, status: 500, error: `Write to the shell failed: ${err.message}` };
    }
    return { ok: true };
  }

  /** @returns {{ ok: true } | { ok: false, status: number, error: string }} */
  function resize(shellId, cols, rows) {
    const shell = shells.get(shellId);
    if (!shell || !shell.running) return { ok: false, status: 409, error: 'That shell is not running.' };
    const c = clampDim(cols, null);
    const r = clampDim(rows, null);
    if (c === null || r === null) return { ok: false, status: 400, error: `cols and rows must be integers between ${MIN_DIM} and ${MAX_DIM}.` };
    shell.cols = c;
    shell.rows = r;
    try { shell.pty.resize(c, r); } catch { /* a dying pty may refuse; the next write surfaces it */ }
    return { ok: true };
  }

  /** Kills the pty and forgets the shell. Fine to call on an unknown id. */
  function kill(shellId) {
    const shell = shells.get(shellId);
    if (!shell) return { ok: false, status: 404, error: 'No such shell.' };
    if (shell.running) {
      try { shell.pty.kill(); } catch { /* already gone */ }
    }
    endShell(shell, shell.exitCode);
    shells.delete(shellId);
    return { ok: true };
  }

  function status(shellId) {
    return publicView(shells.get(shellId));
  }

  /**
   * Sets or clears a shell's tab name. Works on an exited shell too - a closed
   * tab keeps showing its last name until the tab itself is removed, and there
   * is no reason to forbid renaming it in the meantime.
   * @returns {{ ok: true } | { ok: false, status: number, error: string }}
   */
  function rename(shellId, name) {
    const shell = shells.get(shellId);
    if (!shell) return { ok: false, status: 404, error: 'No such shell.' };
    const trimmed = typeof name === 'string' ? name.trim() : '';
    shell.name = trimmed ? trimmed.slice(0, MAX_NAME_LENGTH) : null;
    return { ok: true };
  }

  /** Every live shell, newest last (insertion order). For the Processes list. */
  function list() {
    return [...shells.values()].map(publicView);
  }

  /** One project's shells, in open order - drives its terminal tab strip. */
  function listForProject(projectId) {
    return [...shells.values()].filter((s) => s.projectId === projectId).map(publicView);
  }

  /** Server shutdown: every pty dies with the process anyway; this is the tidy version. */
  function killAll() {
    for (const id of [...shells.keys()]) kill(id);
  }

  return { open, attach, write, resize, kill, rename, status, list, listForProject, killAll, size: () => shells.size };
}
