// Stand-ins for the two things the server would otherwise shell out for.
//
// Neither `claude /usage` nor `claude -p` may run under the e2e suite: one is
// slow and depends on the machine's real plan, the other would start a live
// agent in a real folder. Both are injectable through createServer(), so both
// are injected.
//
// `openTerminal()` is NOT injectable, so no spec ever clicks Terminal - see
// the note in project.spec.mjs.

import { EventEmitter } from 'node:events';

import { FIXTURE_SESSION_ID } from './env.mjs';

/** How long a stubbed run stays in flight. Longer than the client's 1s poll,
 *  so a spec can actually observe the Running state before it flips to Done. */
export const STUB_RUN_MS = 1500;

export function stubUsage() {
  let pct = 42;
  let last = {
    ok: true,
    fetchedAt: Date.now(),
    plan: 'Max 20x (stubbed)',
    limits: [
      { label: 'Current session', pct, resets: 'in 2h' },
      { label: 'Current week (all models)', pct: 71, resets: 'Mon' },
      { label: 'Current week (Opus)', pct: 93, resets: 'Mon' },
    ],
    raw: '',
  };
  return {
    get: () => last,
    // Each refresh moves the first bar, so a spec can prove the button did
    // something rather than just that it did not throw.
    refresh: async () => {
      pct += 1;
      last = { ...last, fetchedAt: Date.now(), limits: [{ ...last.limits[0], pct }, ...last.limits.slice(1)] };
      return last;
    },
    setIntervalMinutes: () => {},
    stop: () => {},
  };
}

/**
 * A spawn that never spawns. Completes after STUB_RUN_MS with the JSON shape
 * `claude -p --output-format json` produces, reporting back the session id it
 * was resumed with - or the fixture session for a new conversation, so the hop
 * to `#/p/<pid>/s/<sid>` lands on a transcript that exists.
 */
export function stubSpawn(cmd, args) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  child.kill = () => {};

  const resumed = args.indexOf('-r');
  const sessionId = resumed === -1 ? FIXTURE_SESSION_ID : args[resumed + 1];

  const timer = setTimeout(() => {
    child.stdout.emit('data', JSON.stringify({
      session_id: sessionId,
      result: 'Stubbed reply from the e2e harness.',
      is_error: false,
      duration_ms: STUB_RUN_MS,
    }));
    child.emit('close', 0);
  }, STUB_RUN_MS);
  timer.unref?.();

  return child;
}
