// Starts the two servers the suite drives, both against one throwaway HOME:
//
//   :5178  ungated  - every functional spec
//   :5179  gated    - auth.spec.mjs, the 401 -> code prompt -> replay path
//
// Launched by playwright.config.mjs as its `webServer`. Run it by hand to poke
// at the fixture data in a browser:  node e2e/support/start-server.mjs

import fs from 'node:fs';
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

const servers = [
  { name: 'open', port: PORTS.open, otpSecret: null },
  { name: 'gated', port: PORTS.gated, otpSecret: OTP_SECRET },
].map(({ name, port, otpSecret }) => {
  const server = createServer({
    home: env.home,
    otpSecret,
    usage: stubUsage(),
    runs: createRunRegistry({ spawnFn: stubSpawn }),
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`work-hub e2e [${name}] http://127.0.0.1:${port}`);
  });
  return server;
});

console.log(`work-hub e2e home ${env.home}`);

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const server of servers) server.close();
  cleanTestEnv(env);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('exit', () => { if (!closing) cleanTestEnv(env); });
