// Opens a real terminal window in a project folder and runs Claude Code's
// remote-control listener in it:
//
//   claude remote-control --spawn same-dir //     --remote-control-session-name-prefix "<computer name> - <folder name>"
//
// The prefix is what names the sessions in claude.ai/code and the mobile app,
// so a session from this folder on this machine reads `mynrd-dev - work-hub`
// instead of just the hostname (Claude Code's default).
//
// This is deliberately NOT one of the tracked runs in claude-run.mjs. Those are
// headless `-p` spawns whose output the page collects; this one is an
// interactive session the user drives from their own desktop, so Work Hub only
// launches it and forgets it.
//
// Why the launcher is `cmd /c start` and not a bare `cmd /k`: with
// `stdio: 'ignore'` the child's stdin is NUL, so `cmd /k` reads EOF and exits
// immediately - no window survives. `start` hands the new process a real
// console (checked on Windows 11: the child `cmd.exe /k …` was still alive with
// its own console two seconds later), and it also honours whatever the user set
// as their default terminal, so a Windows Terminal user gets a WT tab.
//
// Security: every argument below is a fixed literal in this file, with one
// exception - the session-name prefix, which ends in the project's folder name.
// That one value is scrubbed by `sessionNamePrefix` down to letters, digits,
// space, dot, underscore and hyphen before it goes near the command line, so
// none of the characters `cmd.exe` acts on (`&`, `|`, `^`, `%`, `(`, `)`, `!`,
// `<`, `>`) can survive. The full project path is still never an argument - it
// travels as the child's `cwd`, which is a CreateProcess parameter, not part of
// the command line. `shell` is false.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The fixed part of the command the terminal runs, as separate tokens. */
export const REMOTE_CONTROL_ARGS = ['claude', 'remote-control', '--spawn', 'same-dir'];

/** Flag that names the sessions this listener creates in claude.ai / mobile. */
const PREFIX_FLAG = '--remote-control-session-name-prefix';

/** The window title `start` is given; also what the user sees in the taskbar. */
const WINDOW_TITLE = 'Work Hub - claude remote-control';

export const REMOTE_CONTROL_COMMAND = REMOTE_CONTROL_ARGS.join(' ');

/**
 * `<computer name> - <folder name>`, e.g. `mynrd-dev - work-hub`, so a session
 * showing up on the phone says which machine and which project it came from.
 *
 * Everything outside `[A-Za-z0-9 ._-]` is dropped, runs of spaces collapse, and
 * the result is capped at 80 characters. If a piece scrubs away to nothing it
 * is left out, and if both do the caller gets '' and the flag is not passed at
 * all (Claude Code then falls back to its own default, the hostname).
 */
export function sessionNamePrefix(projectPath, { hostname = os.hostname() } = {}) {
  const clean = (s) => String(s ?? '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [clean(hostname), clean(path.basename(projectPath))].filter(Boolean);
  return parts.join(' - ').slice(0, 80).trim();
}

/**
 * Launches the terminal. Returns synchronously - `start` exits as soon as the
 * new console exists, so there is no exit code worth waiting for.
 *
 * @returns {{ ok: true, command: string, cwd: string } | { ok: false, status: number, error: string }}
 */
export function openTerminal(projectPath, { spawnFn = spawn, platform = process.platform, hostname = os.hostname() } = {}) {
  if (platform !== 'win32') {
    return { ok: false, status: 501, error: `Opening a terminal is implemented for Windows only (this server is on ${platform}). Run \`${REMOTE_CONTROL_COMMAND}\` in ${projectPath} yourself.` };
  }

  try {
    if (!fs.statSync(projectPath).isDirectory()) {
      return { ok: false, status: 400, error: `${projectPath} is not a directory.` };
    }
  } catch (err) {
    return { ok: false, status: 400, error: `Cannot open a terminal in ${projectPath}: ${err.code ?? err.message}` };
  }

  // The prefix contains spaces, so Node wraps it in double quotes for us; the
  // scrubbing in `sessionNamePrefix` is what makes those quotes enough, because
  // a `\"` inside would not survive cmd.exe's parser.
  const prefix = sessionNamePrefix(projectPath, { hostname });
  const claudeArgs = prefix ? [...REMOTE_CONTROL_ARGS, PREFIX_FLAG, prefix] : [...REMOTE_CONTROL_ARGS];

  // The title argument has to be quoted on the command line or `start` reads it
  // as the program to run. It contains spaces, so Node quotes it for us.
  const args = ['/c', 'start', WINDOW_TITLE, 'cmd.exe', '/k', ...claudeArgs];

  let child;
  try {
    child = spawnFn('cmd.exe', args, {
      cwd: projectPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false,
    });
  } catch (err) {
    return { ok: false, status: 500, error: `Could not start a terminal: ${err.message}` };
  }

  // Nothing reads the launcher again: it exits the moment the console is up.
  // The handler is here so a spawn failure cannot become an unhandled 'error'
  // event that takes the server down with it.
  child.on?.('error', (err) => { console.error(`Terminal launch failed for ${projectPath}: ${err.message}`); });
  child.unref?.();

  return { ok: true, command: claudeArgs.join(' '), cwd: projectPath };
}
