// Opens a real terminal window in a project folder and runs Claude Code's
// remote-control listener in it:
//
//   claude remote-control --spawn same-dir
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
// Security: every argument below is a fixed literal in this file. The project
// path is never an argument - it travels as the child's `cwd`, which is a
// CreateProcess parameter, not part of the command line. `shell` is false.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** The command the terminal runs, as separate tokens (no quoting needed). */
export const REMOTE_CONTROL_ARGS = ['claude', 'remote-control', '--spawn', 'same-dir'];

/** The window title `start` is given; also what the user sees in the taskbar. */
const WINDOW_TITLE = 'Work Hub - claude remote-control';

export const REMOTE_CONTROL_COMMAND = REMOTE_CONTROL_ARGS.join(' ');

/**
 * Launches the terminal. Returns synchronously - `start` exits as soon as the
 * new console exists, so there is no exit code worth waiting for.
 *
 * @returns {{ ok: true, command: string, cwd: string } | { ok: false, status: number, error: string }}
 */
export function openTerminal(projectPath, { spawnFn = spawn, platform = process.platform } = {}) {
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

  // The title argument has to be quoted on the command line or `start` reads it
  // as the program to run. It contains spaces, so Node quotes it for us.
  const args = ['/c', 'start', WINDOW_TITLE, 'cmd.exe', '/k', ...REMOTE_CONTROL_ARGS];

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

  return { ok: true, command: REMOTE_CONTROL_COMMAND, cwd: projectPath };
}
