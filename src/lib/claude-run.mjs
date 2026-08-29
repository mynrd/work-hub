// Spawns `claude` for the reply composer and tracks each spawn as a run.
//
// ── Spike outcome (Claude Code 2.1.226, Windows 11, Node v26.7.0) ────────────
// The four assumptions in .plan/PLAN.md item 5 were checked before this file was
// written. All four hold:
//
//   1. `claude -p` with no positional prompt reads the prompt from stdin and
//      exits after one reply. Confirmed: exit 0, reply in the JSON `result`.
//   2. `--output-format json` prints a single JSON object carrying `session_id`,
//      `result`, `is_error`, `subtype`, `duration_ms`, `total_cost_usd`,
//      `permission_denials[]`, `modelUsage{}`.
//   3. `-r <id>` with `cwd` set to the original project folder resumes that
//      session and APPENDS to the existing `<id>.jsonl` (32,755 -> 37,462 bytes
//      across the resume); the returned `session_id` is unchanged. No new file
//      is created, so polling the one file during a run is sufficient.
//   4. A tool call is NOT blocked waiting for approval in `-p` mode. A Write was
//      executed and the file appeared on disk, with `permission_denials` empty,
//      under the default permission mode. `-p` does not hang - but it also does
//      not mean "read only". See the exposure warning in README.md.
//
// Security note that shapes the whole file: on Windows `claude` resolves to
// `claude.cmd`, and Node refuses to spawn a `.cmd` without `shell: true` (EINVAL
// since 18.20). With `shell: true` Node concatenates argv without escaping, so
// nothing the user typed may ever become an argument. Hence: every argument is
// an allowlisted token or a regex-validated UUID, and the message itself only
// ever travels over stdin.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { MODELS, EFFORTS } from './config.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERMISSION_ARGS = {
  default: [],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  plan: ['--permission-mode', 'plan'],
  bypassPermissions: ['--dangerously-skip-permissions'],
};

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RUNS_KEPT = 50;

/**
 * Builds the argument list from validated tokens only.
 * @returns {{ ok: true, args: string[] } | { ok: false, error: string }}
 */
export function buildArgs({ sessionId = null, model, effort, permissionMode }) {
  if (sessionId !== null && sessionId !== undefined && sessionId !== '') {
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
      return { ok: false, error: 'sessionId is not a valid session id.' };
    }
  }
  if (!MODELS.includes(model)) {
    return { ok: false, error: `model must be one of: ${MODELS.join(', ')}` };
  }
  if (!EFFORTS.includes(effort)) {
    return { ok: false, error: `effort must be one of: ${EFFORTS.join(', ')}` };
  }
  if (!Object.prototype.hasOwnProperty.call(PERMISSION_ARGS, permissionMode)) {
    return { ok: false, error: `permissionMode must be one of: ${Object.keys(PERMISSION_ARGS).join(', ')}` };
  }

  const args = ['-p'];
  if (sessionId) args.push('-r', sessionId);
  args.push('--model', model, '--effort', effort, '--output-format', 'json', ...PERMISSION_ARGS[permissionMode]);
  return { ok: true, args };
}

/** The command line shown to the user above the composer before they send. The
 *  message is not part of it - it goes over stdin. */
export function previewCommand(args) {
  return ['claude', ...args].join(' ');
}

export function createRunRegistry({ spawnFn = spawn, timeoutMs = RUN_TIMEOUT_MS } = {}) {
  /** @type {Map<string, object>} */
  const runs = new Map();
  /** @type {Map<string, string>} sessionId -> runId, for the one-run-per-session rule */
  const activeBySession = new Map();

  function prune() {
    while (runs.size > MAX_RUNS_KEPT) {
      const oldest = runs.keys().next().value;
      runs.delete(oldest);
    }
  }

  function publicView(run) {
    if (!run) return null;
    return {
      runId: run.runId,
      state: run.state,
      sessionId: run.sessionId,
      resultSessionId: run.resultSessionId,
      projectId: run.projectId,
      command: run.command,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      result: run.result,
      isError: run.isError,
      durationMs: run.durationMs,
      error: run.error,
    };
  }

  /**
   * Starts a run. Returns `{ ok: false, status, error }` when the tokens are
   * invalid (400) or the session already has a run in flight (409); nothing is
   * spawned in either case.
   */
  function startRun({ projectId, projectPath, sessionId = null, message, model, effort, permissionMode }) {
    if (typeof message !== 'string' || message.trim() === '') {
      return { ok: false, status: 400, error: 'message is required.' };
    }

    const built = buildArgs({ sessionId, model, effort, permissionMode });
    if (!built.ok) return { ok: false, status: 400, error: built.error };

    if (sessionId && activeBySession.has(sessionId)) {
      return { ok: false, status: 409, error: 'A reply is already running on this conversation. Wait for it to finish.' };
    }

    const runId = crypto.randomUUID();
    const run = {
      runId,
      state: 'queued',
      sessionId: sessionId || null,
      resultSessionId: null,
      projectId,
      command: previewCommand(built.args),
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      stdout: '',
      stderr: '',
      result: null,
      isError: false,
      durationMs: null,
      error: null,
    };
    runs.set(runId, run);
    prune();
    if (sessionId) activeBySession.set(sessionId, runId);

    let child;
    try {
      child = spawnFn('claude', built.args, {
        cwd: projectPath,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      run.state = 'failed';
      run.error = err.message;
      run.endedAt = Date.now();
      if (sessionId) activeBySession.delete(sessionId);
      return { ok: true, run: publicView(run) };
    }

    run.state = 'running';

    let settled = false;
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Object.assign(run, patch, { endedAt: Date.now() });
      if (sessionId) activeBySession.delete(sessionId);
      // A new conversation has no sessionId to key on until the child reports
      // one; release that key too so a second reply to it is not blocked.
      if (run.resultSessionId) activeBySession.delete(run.resultSessionId);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ state: 'failed', error: `timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    // A pending timeout must not by itself hold the process open - the HTTP
    // server keeps the event loop alive in production, and unit tests that leave
    // a run mid-flight would otherwise hang for the full ten minutes.
    timer.unref?.();

    child.stdout.on('data', (d) => { run.stdout += d; });
    child.stderr.on('data', (d) => { run.stderr += d; });
    child.on('error', (err) => finish({ state: 'failed', error: err.message }));
    child.on('close', (code) => {
      run.exitCode = code;
      if (code !== 0) {
        finish({ state: 'failed', error: run.stderr.trim() || `claude exited with code ${code}` });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(run.stdout);
      } catch {
        finish({ state: 'failed', error: 'claude exited 0 but its output was not JSON. Raw output is below.' });
        return;
      }
      run.resultSessionId = typeof parsed?.session_id === 'string' ? parsed.session_id : null;
      finish({
        state: 'done',
        result: typeof parsed?.result === 'string' ? parsed.result : null,
        isError: parsed?.is_error === true,
        durationMs: Number.isFinite(parsed?.duration_ms) ? parsed.duration_ms : null,
      });
    });

    try {
      child.stdin.write(message);
      child.stdin.end();
    } catch (err) {
      try { child.kill(); } catch { /* already gone */ }
      finish({ state: 'failed', error: `could not write the message to claude's stdin: ${err.message}` });
    }

    return { ok: true, run: publicView(run) };
  }

  return {
    startRun,
    get: (runId) => publicView(runs.get(runId)),
    isSessionBusy: (sessionId) => activeBySession.has(sessionId),
    size: () => runs.size,
  };
}
