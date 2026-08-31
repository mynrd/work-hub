// Client for support/start-server.mjs's restart control endpoint - see the
// comment there for why it exists instead of an OS-level process restart.
//
// Used by exactly one spec: terminal.spec.mjs's proof that a shell survives a
// server restart. Everything else about the fixture server is untouched by
// this - same throwaway home, same stubs, same ports - only the two
// http.Server objects behind :5178/:5179 are closed and rebuilt.

import { PORTS } from './env.mjs';

const CONTROL_URL = `http://127.0.0.1:${PORTS.control}`;
const HEALTH_URL = `http://127.0.0.1:${PORTS.open}/api/auth/status`;

async function waitUntilHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not come back up within ${timeoutMs}ms of a restart` + (lastErr ? `: ${lastErr.message}` : ''));
}

/**
 * Restarts the fixture servers in place and resolves once the open one
 * answers again. The shell-host daemon is a separate OS process and is
 * deliberately left alone - that survival is the entire point of the
 * regression this exists for.
 */
export async function restartServer() {
  const res = await fetch(`${CONTROL_URL}/restart`, { method: 'POST' });
  if (!res.ok) throw new Error(`Restart control endpoint answered ${res.status}`);
  await waitUntilHealthy(15000);
}
