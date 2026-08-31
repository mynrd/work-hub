// Starts the two servers the suite drives, both against one throwaway HOME:
//
//   :5178  ungated  - every functional spec
//   :5179  gated    - auth.spec.mjs, the 401 -> code prompt -> replay path
//
// Launched by playwright.config.mjs as its `webServer`. Run it by hand to poke
// at the fixture data in a browser:  node e2e/support/start-server.mjs

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../../src/serve.mjs';
import { createRunRegistry } from '../../src/lib/claude-run.mjs';
import { buildTestEnv, cleanTestEnv, OTP_SECRET, PORTS } from './env.mjs';
import { stubUsage, stubSpawn } from './stubs.mjs';

/* A hard kill on Windows skips the exit handler, so a crashed or force-closed
   run leaves its temp home behind. Sweep the old ones before making a new one. */
function sweepStaleHomes() {
  const tmp = os.tmpdir();
  let names;
  try { names = fs.readdirSync(tmp); } catch { return; }
  for (const name of names) {
    if (!name.startsWith('work-hub-e2e-')) continue;
    try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); } catch { /* in use, leave it */ }
  }
}

sweepStaleHomes();
const env = buildTestEnv();

/* createServer()'s shell-client (lib/shell-client.mjs) resolves the shell-host
   daemon's info file - and spawns the daemon itself - through os.homedir(),
   not through the `home` option passed below: every other store here
   (config, auth, transcripts, ...) takes `home` explicitly, but the shells
   client is built as a bare `createShellHostClient()` with none of them
   wired through. Overriding HOME/USERPROFILE for this process routes that
   resolution into the same throwaway home as everything else instead of the
   real ~/.work-hub - and the detached daemon, spawned with no `env` override
   of its own, inherits it. Confirmed against the real daemon before relying
   on it: without this, terminal.spec.mjs would drive real pwsh shells on
   whatever machine runs the suite. */
process.env.HOME = env.home;
process.env.USERPROFILE = env.home;

const SERVER_SPECS = [
  { name: 'open', port: PORTS.open, otpSecret: null },
  { name: 'gated', port: PORTS.gated, otpSecret: OTP_SECRET, idleMinutes: 0.05 }, // 3s, so the idle-lock spec finishes in seconds
];

function startOne({ name, port, otpSecret, idleMinutes }) {
  const server = createServer({
    home: env.home,
    otpSecret,
    usage: stubUsage(),
    runs: createRunRegistry({ spawnFn: stubSpawn }),
    ...(idleMinutes === undefined ? {} : { idleMinutes }),
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`work-hub e2e [${name}] http://127.0.0.1:${port}`);
  });
  return server;
}

const servers = new Map(SERVER_SPECS.map((spec) => [spec.name, startOne(spec)]));

console.log(`work-hub e2e home ${env.home}`);

/* Closes a server, giving in-flight requests a moment to finish naturally
   before forcing dangling keep-alive sockets shut - `close()` alone waits
   forever for a keep-alive connection nothing is actively using, but forcing
   it immediately would sever a response another spec's concurrent request is
   still reading. 300ms is enough for any of this app's requests (nothing here
   streams for that long except a terminal's own output, and this endpoint
   only ever runs for terminal.spec.mjs, which owns the connection it drops). */
function closeServer(server, graceMs = 300) {
  return new Promise((resolve) => {
    let done = false;
    server.close(() => { done = true; resolve(); });
    setTimeout(() => { if (!done) server.closeAllConnections?.(); }, graceMs);
  });
}

/*
 * terminal.spec.mjs's headline regression is that a shell survives a web
 * server restart. Playwright owns this process as its `webServer` and gives
 * a spec no way to restart it, so this control endpoint is the harness's own
 * stand-in: it closes and rebuilds the *open* server's http.Server object in
 * place - the same churn a real restart produces - while leaving this
 * process (and any shell-host daemon it has spawned) running. Not part of
 * the app; only this harness process listens for it, and only
 * support/restart.mjs calls it.
 *
 * Only `open` - never `gated` - restarts here. auth.spec.mjs's gated-server
 * flows run for many seconds across live TOTP codes and a session token held
 * in that server's own in-memory store; restarting it mid-flow would wipe
 * that state out from under a concurrently running worker. Every other spec
 * runs against the open server too, in parallel workers, for the seconds
 * this takes - a request that lands in the narrow window between close and
 * re-listen sees a connection error. Nothing else in the suite holds a
 * connection open long enough to be caught by it in practice (see the module
 * comment in terminal.spec.mjs), but it is a real, accepted trade-off, not a
 * guarantee.
 */
const control = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/restart') {
    const spec = SERVER_SPECS.find((s) => s.name === 'open');
    closeServer(servers.get('open'))
      .then(() => { servers.set('open', startOne(spec)); })
      .then(() => { res.writeHead(200); res.end('ok'); })
      .catch((err) => { res.writeHead(500); res.end(String(err && err.message || err)); });
    return;
  }
  res.writeHead(404);
  res.end();
});
control.listen(PORTS.control, '127.0.0.1');

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const server of servers.values()) server.close();
  control.close();
  cleanTestEnv(env);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('exit', () => { if (!closing) cleanTestEnv(env); });
