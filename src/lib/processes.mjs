// The Processes list behind the topbar button: every Work Hub shell, whether
// this server started it or a previous run did.
//
// Two sources, merged:
//   1. `registry.list()` - every shell the shell host daemon owns (see
//      shell-host.mjs; `registry` here is usually the client from
//      shell-client.mjs, not the in-process shell.mjs registry directly). It
//      knows the project, the shellId, and whether a page is attached. Since
//      the daemon survives a server restart, this list survives one too.
//   2. On Windows, a WMI query for any `pwsh.exe` whose command line carries
//      the WORK_HUB_SHELL marker. This is OS truth: it survives the daemon
//      itself dying and catches a shell that detached and outlived its ConPTY.
//
// A row the registry knows is `source: 'session'` and is killed by shellId
// (registry.kill, which closes the pty cleanly) - "session" now means "the
// daemon", not "this server process". A row only WMI knows is `source:
// 'external'` - a straggler the daemon itself lost track of - and is killed by
// pid with `taskkill /T /F`, because nothing here has a pty handle to it.
//
// Everything on the command line here is a fixed literal; the only variable
// that reaches a command is a pid, validated as a positive integer first.

import { execFile } from 'node:child_process';

import { MARKER_ENV } from './shell.mjs';

/** Pulls `<projectId>|<shellId>` out of a marked command line, or null. */
function parseMarker(commandLine) {
  const m = new RegExp(`${MARKER_ENV}='([^']*)'`).exec(String(commandLine || ''));
  if (!m) return null;
  const idx = m[1].indexOf('|');
  if (idx === -1) return { projectId: m[1], shellId: null };
  return { projectId: m[1].slice(0, idx), shellId: m[1].slice(idx + 1) };
}

function run(file, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); return; }
      resolve(String(stdout || ''));
    });
  });
}

/**
 * Marked pwsh processes as the OS sees them: `{ pid, projectId, shellId,
 * startedAt }`. Windows only; anything else returns []. Never throws - a query
 * failure answers [] and logs, because this only augments the registry list.
 */
export async function scanMarkedProcesses({ platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  // The `=` narrows the match to a real marker assignment
  // (`$env:WORK_HUB_SHELL='...'`), so an unrelated shell that merely mentions
  // the name - a process scan like this one - does not list itself.
  const psScript =
    "Get-CimInstance Win32_Process -Filter \"Name='pwsh.exe'\" | " +
    `Where-Object { $_.CommandLine -like '*${MARKER_ENV}=*' } | ` +
    'ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine; ' +
    'started = $_.CreationDate.ToUniversalTime().ToString("o") } } | ConvertTo-Json -Compress';

  let out;
  try {
    out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
  } catch (err) {
    console.error(`Process scan failed: ${err.message}`);
    return [];
  }
  const trimmed = out.trim();
  if (!trimmed) return [];

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    console.error(`Process scan returned non-JSON: ${err.message}`);
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((r) => {
    const marker = parseMarker(r.cmd);
    const started = Date.parse(r.started);
    return {
      pid: Number(r.pid),
      projectId: marker ? marker.projectId : null,
      shellId: marker ? marker.shellId : null,
      startedAt: Number.isFinite(started) ? started : null,
    };
  }).filter((r) => Number.isInteger(r.pid));
}

/**
 * The unified Processes list. Registry shells first (this session), then any
 * marked pwsh the OS knows that the registry does not (stragglers).
 *
 * @param registry the shell registry or shell host client (for `.list()`,
 *                 sync or async - either works, since this always awaits it)
 * @param nameOf   (projectId) => display name, or undefined
 */
export async function listProcesses({ registry, nameOf = () => undefined, platform = process.platform } = {}) {
  const session = await registry.list();
  const sessionPids = new Set(session.map((s) => s.pid).filter((p) => p !== null));
  const sessionShellIds = new Set(session.map((s) => s.shellId));

  const rows = session.map((s) => ({
    source: 'session',
    shellId: s.shellId,
    pid: s.pid,
    projectId: s.projectId,
    projectName: nameOf(s.projectId) || null,
    running: s.running,
    startedAt: s.startedAt,
  }));

  const marked = await scanMarkedProcesses({ platform });
  for (const m of marked) {
    // Skip anything the registry already represents, matched by shellId first
    // (survives pid reuse) and pid as a fallback.
    if (m.shellId && sessionShellIds.has(m.shellId)) continue;
    if (m.pid !== null && sessionPids.has(m.pid)) continue;
    rows.push({
      source: 'external',
      shellId: m.shellId,
      pid: m.pid,
      projectId: m.projectId,
      projectName: nameOf(m.projectId) || null,
      running: true,
      startedAt: m.startedAt,
    });
  }
  return rows;
}

/**
 * Force-kills a straggler by pid, whole tree. `taskkill /T` takes the children
 * (an `ng serve` under the shell) with it.
 *
 * The pid MUST currently belong to a marked Work Hub shell - the scan is
 * repeated here, not trusted from the caller, so this route can only ever kill
 * a Work Hub shell, never an arbitrary process someone names in a crafted
 * request. (The terminal already allows arbitrary `taskkill`; this keeps the
 * Processes button's own reach to exactly what it lists.)
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function killProcess(pid, { platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, status: 400, error: 'pid must be a positive integer.' };
  if (platform !== 'win32') return { ok: false, status: 501, error: 'Killing a straggler by pid is implemented for Windows only.' };

  const marked = await scanMarkedProcesses({ platform });
  if (!marked.some((m) => m.pid === pid)) {
    return { ok: false, status: 404, error: `pid ${pid} is not a Work Hub shell (it may have already exited).` };
  }

  try {
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    return { ok: true };
  } catch (err) {
    // taskkill exits non-zero when the pid is already gone - treat that as done.
    if (/not found|no running instance|128/i.test(err.stderr || err.message)) return { ok: true };
    return { ok: false, status: 500, error: `taskkill failed: ${(err.stderr || err.message).trim()}` };
  }
}
