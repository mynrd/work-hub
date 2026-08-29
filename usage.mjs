// Runs Claude Code's own `/usage` slash command non-interactively and parses the
// plain-text output. This is the official subscription usage - real percentages
// and reset times - not an estimate reconstructed from local transcripts.
//
// Output shape (Pro/Max; the lines vary by plan):
//
//   You are currently using your subscription to power your Claude Code usage
//
//   Current session: 4% used · resets Aug 30, 12:59am (Asia/Manila)
//   Current week (all models): 22% used · resets Sep 2, 7am (Asia/Manila)
//   Current week (Fable): 9% used · resets Sep 2, 7am (Asia/Manila)
//
// Every "<label>: N% used · resets <when>" line is parsed generically so a new
// limit row (a new model family, say) shows up without a code change.
//
// Ported from claude-usage/src/services/usage-cli.js, CommonJS -> ESM, otherwise
// unchanged.

import { spawn } from 'node:child_process';

// `<label>: N% used · resets <when>`  (· is U+00B7; the reset clause is optional)
const LIMIT_RE = /^(.+?):\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/i;

export function parseUsage(text) {
  const limits = [];
  let plan = '';
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(LIMIT_RE);
    if (m) {
      limits.push({ label: m[1].trim(), pct: Number(m[2]), resets: (m[3] || '').trim() });
    } else if (!plan && /subscription|api|credit/i.test(line)) {
      plan = line;
    }
  }
  return { plan, limits };
}

/**
 * Resolves to `{ ok, raw, plan, limits, fetchedAt, error }`. Never rejects - a
 * failure (claude not on PATH, not signed in, timeout) comes back as `ok: false`
 * with the captured message so the card can show it instead of throwing.
 */
export function fetchCliUsage({ timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // Single command string + shell:true so Windows resolves claude.cmd. Nothing
      // here is user input, so the shell has nothing to interpolate. stdin 'ignore'
      // gives an immediate EOF instead of an interactive wait.
      child = spawn('claude -p /usage', { stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: e.message, fetchedAt: Date.now() });
      return;
    }

    let out = '';
    let err = '';
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, error: `timed out after ${timeoutMs / 1000}s`, fetchedAt: Date.now() });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: e.message, fetchedAt: Date.now() }));
    child.on('close', (code) => {
      const raw = out.trim();
      if (code !== 0 && !raw) {
        finish({ ok: false, error: err.trim() || `claude exited with code ${code}`, fetchedAt: Date.now() });
        return;
      }
      const { plan, limits } = parseUsage(raw);
      finish({ ok: true, raw, plan, limits, fetchedAt: Date.now() });
    });
  });
}

/**
 * Holds the last `/usage` result and reruns it on a timer. `GET /api/usage`
 * serves whatever is cached; only the Refresh button (and the timer) fetch.
 */
export function createUsageCache() {
  let last = { ok: false, error: 'not fetched yet', fetchedAt: 0, limits: [], plan: '' };
  let inFlight = null;
  let timer = null;

  async function refresh() {
    // One fetch at a time: two clicks on Refresh must not spawn two `claude`
    // processes, they share the same promise.
    if (inFlight) return inFlight;
    inFlight = fetchCliUsage().then((res) => {
      last = res;
      inFlight = null;
      return res;
    });
    return inFlight;
  }

  function setInterval_(minutes) {
    if (timer) { clearInterval(timer); timer = null; }
    const n = Number(minutes);
    if (!Number.isFinite(n) || n <= 0) return; // 0 = manual only
    timer = setInterval(() => { refresh().catch(() => {}); }, n * 60 * 1000);
    timer.unref?.();
  }

  return {
    get: () => last,
    refresh,
    setIntervalMinutes: setInterval_,
    stop: () => { if (timer) { clearInterval(timer); timer = null; } },
  };
}
