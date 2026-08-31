// Entry point for the shell host daemon: a small, long-lived process whose
// only job is to own the node-pty handles that used to live inside the web
// server (src/serve.mjs). All of the actual protocol logic is in
// lib/shell-host-core.mjs, which is what the test suite exercises directly;
// this file is just wiring - resolve where the daemon lives, mint a token,
// listen, write the info file, and get out of the way.
//
// This process is meant to be spawned detached, with its stdio ignored (see
// lib/shell-client.mjs), and to outlive whatever spawned it: a web server
// restart must not take a single open terminal down with it. Nothing here
// ever writes to stdout - there is no console attached to read it - so every
// problem worth knowing about goes to stderr, and the exit code says whether
// starting failed.
//
// Discovery: a client finds this daemon through
// `~/.work-hub/shell-host.json` - `{ version, pipe, token, pid, startedAt }` -
// written only after `listen()` succeeds, so a client never reads a pipe name
// nobody is listening on yet. `configDir` is the same helper lib/config.mjs
// uses for `~/.work-hub`, so this file lives in the same place as everything
// else Work Hub writes outside of a monitored project.
//
// The token is 256 random bits (crypto.randomBytes), written only into that
// info file. Anyone who can read it can drive every shell this daemon owns -
// see the security note atop lib/shell-host-core.mjs for why that is an
// acceptable trust boundary (it is the same one the file already sat behind:
// the user's own profile).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configDir } from './lib/config.mjs';
import { createShellRegistry } from './lib/shell.mjs';
import { createShellHostServer, PROTOCOL_VERSION } from './lib/shell-host-core.mjs';

export function infoPath(home = os.homedir()) {
  return path.join(configDir(home), 'shell-host.json');
}

/** Unix domain socket path used on every platform but Windows, which has no
 *  filesystem path for a named pipe. */
export function socketPath(home = os.homedir()) {
  return path.join(configDir(home), 'shell-host.sock');
}

function randomPipeName() {
  return `\\\\.\\pipe\\work-hub-shells-${crypto.randomBytes(16).toString('hex')}`;
}

function main() {
  const home = os.homedir();
  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });

  const token = crypto.randomBytes(32).toString('hex');
  const pipe = process.platform === 'win32' ? randomPipeName() : socketPath(home);

  if (process.platform !== 'win32') {
    // A previous daemon that crashed without cleaning up can leave this file
    // behind; a stale socket file makes `listen()` fail with EADDRINUSE even
    // though nothing is actually listening, so it is removed first. Losing
    // this race to a daemon that IS still alive is fine - see the
    // EADDRINUSE handler below.
    try { fs.unlinkSync(pipe); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }

  const registry = createShellRegistry();
  const server = createShellHostServer({
    registry,
    token,
    version: PROTOCOL_VERSION,
    onShutdown: () => {
      try { fs.unlinkSync(infoPath(home)); } catch { /* already gone, or never written */ }
      server.close(() => process.exit(0));
    },
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Another daemon won the race to this name (only possible on the
      // Unix socket path, which is fixed - the Windows pipe name is random
      // per process). There is nothing to fix; whichever daemon is already
      // listening is the one clients will find.
      process.exit(0);
    }
    console.error(`shell-host: ${err.message}`);
    process.exit(1);
  });

  server.listen(pipe, () => {
    fs.writeFileSync(infoPath(home), JSON.stringify({
      version: PROTOCOL_VERSION,
      pipe,
      token,
      pid: process.pid,
      startedAt: Date.now(),
    }, null, 2));
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
