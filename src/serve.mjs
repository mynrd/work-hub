// Local HTTP server for Work Hub: the multi-project `.work` dashboard and the
// Claude conversation console.
//
// Unlike the read-only viewer this grew out of, this server can execute `claude`
// under the user's account. That is why access is gated on a code from an
// authenticator app, why the message a run sends only ever travels over stdin,
// and why every other argument is an allowlisted token. See README.md § Exposure.
//
// node: built-ins only. No third-party dependency, no package.json.

import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig, configPath, encodeProjectId, resolveProjectId, validateProjectPath, MODELS, EFFORTS, PERMISSION_MODES } from './lib/config.mjs';
import { scanWorkFolder } from './lib/workscan.mjs';
import { listSessions, readSessionChat, resolveTranscriptDir } from './lib/transcripts.mjs';
import { createUsageCache } from './lib/usage.mjs';
import { createRunRegistry } from './lib/claude-run.mjs';
import { resolveJob } from './lib/resolve-job.mjs';
import { openTerminal } from './lib/terminal.mjs';
import { renderMarkdown } from './lib/markdown.mjs';
import { loadEnrollment, createSessionStore, enrollmentPath } from './lib/authstore.mjs';
import { verifyTotp, STEP_SECONDS } from './lib/totp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 5081;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 256 * 1024;

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isValidHost(host) {
  return host === 'localhost' || net.isIP(host) !== 0;
}

export function parseArgs(argv) {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let noOtp = false;
  let open = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const valueOf = (flag) => (arg === flag ? argv[++i] : arg.slice(flag.length + 1));

    if (arg === '--port' || arg.startsWith('--port=')) port = Number(valueOf('--port'));
    else if (arg === '--host' || arg.startsWith('--host=')) host = valueOf('--host');
    else if (arg === '--no-otp') noOtp = true;
    else if (arg === '--lan') host = '0.0.0.0';
    else if (arg === '--open') open = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${port}. Expected 1-65535.`);
  }
  if (!isValidHost(host)) {
    throw new Error(`Invalid --host value: ${JSON.stringify(host)}. Expected an IPv4/IPv6 address, "localhost", or --lan for 0.0.0.0.`);
  }
  if (noOtp && !isLoopback(host)) {
    throw new Error(
      `--no-otp cannot be combined with --host ${host}. This server can run \`claude\` as you; a non-loopback bind is always gated. ` +
      'Drop --no-otp, or bind loopback only.',
    );
  }

  return { port, host, noOtp, open };
}

// ── Small response helpers ───────────────────────────────────────────────────

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = String(text);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (overflowed) return; // keep draining, keep nothing
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        const err = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
        err.tooLarge = true;
        // The rest of the body is drained rather than the socket destroyed:
        // destroying here resets the connection before the response can be
        // written, and the client sees a socket error instead of the reason.
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// ── One-time codes ───────────────────────────────────────────────────────────

const OTP_MAX_FAILURES = 5;
const OTP_LOCKOUT_MS = 60 * 1000;

/**
 * Guards the code exchange.
 *
 * A six digit code with a one step window either side means three of a million
 * codes are live at any moment. Unthrottled, that is roughly a day of flat-out
 * guessing on a LAN. Five wrong codes buy a minute of silence, which pushes the
 * same attempt count past a century.
 *
 * `used` is the replay guard: a code stays valid for its whole window, so a
 * counter that has already been spent is refused even when the arithmetic says
 * the digits are right.
 */
function createOtpGuard({ maxFailures = OTP_MAX_FAILURES, lockoutMs = OTP_LOCKOUT_MS } = {}) {
  let failures = 0;
  let lockedUntil = 0;
  const used = new Set();

  return {
    lockedFor(now = Date.now()) {
      return lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0;
    },
    fail(now = Date.now()) {
      failures++;
      if (failures >= maxFailures) {
        lockedUntil = now + lockoutMs;
        failures = 0;
      }
    },
    /** False when this counter was already spent. Records it when it is not. */
    claim(counter, now = Date.now()) {
      if (used.has(counter)) return false;
      used.add(counter);
      // Anything older than the accept window can never be claimed again.
      const floor = Math.floor(now / 1000 / STEP_SECONDS) - 2;
      for (const c of used) if (c < floor) used.delete(c);
      failures = 0;
      return true;
    },
  };
}

// ── Path safety ──────────────────────────────────────────────────────────────

/**
 * Rejects a raw URL segment that still contains a path separator after decoding.
 * That also catches an encoded slash (`..%2f..%2f`), which the router never
 * splits on because the slash is still percent-escaped in the raw URL.
 */
function decodeSegment(raw) {
  let value;
  try { value = decodeURIComponent(raw); } catch { return null; }
  if (!value || value.includes('/') || value.includes('\\') || value === '..') return null;
  return value;
}

/**
 * Renders one `.md` file from a job folder. Only `.md` is served, and the
 * resolved path must stay under that project's `.work/`.
 */
function handleMarkdownRoute(res, projectPath, rawFolder, rawFile) {
  const folder = decodeSegment(rawFolder);
  const file = decodeSegment(rawFile);
  if (!folder || !file) {
    sendJson(res, 400, { error: 'Invalid folder or file segment' });
    return;
  }
  if (!file.toLowerCase().endsWith('.md')) {
    sendJson(res, 400, { error: 'Only .md files may be requested' });
    return;
  }

  const workRoot = path.resolve(projectPath, '.work');
  const filePath = path.resolve(workRoot, folder, file);
  if (!filePath.startsWith(workRoot + path.sep)) {
    sendJson(res, 400, { error: 'Resolved path escapes the .work root' });
    return;
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    sendJson(res, 404, { error: `Cannot read ${folder}/${file}: ${err.code ?? err.message}` });
    return;
  }

  let html;
  try {
    html = renderMarkdown(raw);
  } catch (err) {
    sendJson(res, 500, { error: `Failed to render ${folder}/${file}: ${err.message}` });
    return;
  }
  sendText(res, 200, html, 'text/html; charset=utf-8');
}

// ── Server ───────────────────────────────────────────────────────────────────

/**
 * `otpSecret` is the enrolled base32 secret, or null for an ungated server.
 * When it is set, every `/api/*` route except `/api/auth/*` needs a session
 * token that `POST /api/auth/otp` handed out in exchange for a live code.
 */
export function createServer({
  otpSecret = null,
  home = undefined,
  runs = createRunRegistry(),
  usage = createUsageCache(),
  sessions = createSessionStore(),
} = {}) {
  const clientHtmlPath = path.join(__dirname, 'client.html');
  const homeArgs = home === undefined ? [] : [home];
  const otpGuard = createOtpGuard();

  let config = loadConfig(...homeArgs);
  usage.setIntervalMinutes(config.usageIntervalMinutes);

  /**
   * The dashboard model: the configured folders and nothing else.
   *
   * It deliberately does NOT scan `.work/` or list transcripts. Both walk the
   * disk per project - `scanWorkFolder` recurses every job folder for its
   * newest mtime - and the dashboard re-runs every 30 seconds, so with a dozen
   * projects the page paid for every job and every session before showing a
   * single box. The scan now happens once, for one project, when its box is
   * clicked (`GET /api/projects/:pid/jobs`).
   */
  function buildDashboard() {
    const projects = config.projects.map((projectPath) => {
      let missing = false;
      let hasWorkDir = false;
      try {
        missing = !fs.statSync(projectPath).isDirectory();
      } catch {
        missing = true;
      }
      if (!missing) {
        try { hasWorkDir = fs.statSync(path.join(projectPath, '.work')).isDirectory(); }
        catch { hasWorkDir = false; }
      }
      return {
        id: encodeProjectId(projectPath),
        path: projectPath,
        name: path.basename(projectPath) || projectPath,
        missing,
        hasWorkDir,
      };
    });

    return { projects, configPath: configPath(...homeArgs), loadError: config.loadError ?? null };
  }

  /** One project's jobs, scanned on demand. This is the expensive call. */
  function buildProjectJobs(projectPath, pid, now = Date.now()) {
    const scan = scanWorkFolder(projectPath, { now });
    const projectName = path.basename(projectPath) || projectPath;
    const tag = (job) => ({ ...job, projectId: pid, projectName });

    return {
      projectId: pid,
      projectPath,
      name: projectName,
      missing: scan.missing,
      hasWorkDir: scan.hasWorkDir,
      today: scan.today.map(tag),
      notStarted: scan.notStarted.map(tag),
      others: scan.others.map(tag),
      unreadable: scan.unreadable.map((u) => ({ ...u, projectId: pid, projectName })),
    };
  }

  async function handleConfigPut(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }

    const incoming = Array.isArray(body?.projects) ? body.projects : [];
    const accepted = [];
    const rejected = [];
    for (const candidate of incoming) {
      const check = validateProjectPath(candidate);
      if (check.ok) accepted.push(check.path);
      else rejected.push({ path: String(candidate ?? ''), error: check.error });
    }

    if (rejected.length > 0) {
      sendJson(res, 400, { error: rejected[0].error, rejected });
      return;
    }

    try {
      config = saveConfig({
        projects: accepted,
        usageIntervalMinutes: body?.usageIntervalMinutes ?? config.usageIntervalMinutes,
        defaults: body?.defaults ?? config.defaults,
      }, ...homeArgs);
    } catch (err) {
      sendJson(res, 500, { error: `Cannot write ${configPath(...homeArgs)}: ${err.message}` });
      return;
    }

    usage.setIntervalMinutes(config.usageIntervalMinutes);
    sendJson(res, 200, { ...config, configPath: configPath(...homeArgs) });
  }

  /**
   * Trades a six digit code for a session token.
   *
   * Ungated on purpose - it is the way in - which is why the throttle and the
   * replay guard live here rather than anywhere else.
   */
  async function handleOtpExchange(req, res) {
    const locked = otpGuard.lockedFor();
    if (locked > 0) {
      sendJson(res, 429, { error: `Too many wrong codes. Try again in ${locked}s.`, retryAfterSeconds: locked });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }

    const result = verifyTotp(otpSecret, body?.code);
    if (!result.ok) {
      otpGuard.fail();
      sendJson(res, 401, { error: 'That code is not right. Check the one your authenticator is showing now.' });
      return;
    }
    if (!otpGuard.claim(result.counter)) {
      otpGuard.fail();
      sendJson(res, 401, { error: 'That code has already been used. Wait for the next one.' });
      return;
    }

    const session = sessions.issue();
    sendJson(res, 200, { token: session.token, expiresAt: session.expiresAt });
  }

  async function handleRunStart(req, res, projectPath, projectId, sessionId) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }

    const started = runs.startRun({
      projectId,
      projectPath,
      sessionId,
      message: body?.message,
      model: body?.model ?? config.defaults.model,
      effort: body?.effort ?? config.defaults.effort,
      permissionMode: body?.permissionMode ?? config.defaults.permissionMode,
    });

    if (!started.ok) {
      sendJson(res, started.status, { error: started.error });
      return;
    }
    sendJson(res, 202, started.run);
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Malformed URL' });
      return;
    }
    const pathname = url.pathname;

    // Whether a code is needed at all. The page reads this before it renders,
    // so an ungated loopback server never shows the prompt.
    if (pathname === '/api/auth/status' && req.method === 'GET') {
      sendJson(res, 200, {
        required: Boolean(otpSecret),
        authenticated: !otpSecret || sessions.validate(req.headers['x-hub-token']),
        digits: 6,
        periodSeconds: STEP_SECONDS,
      });
      return;
    }

    if (pathname === '/api/auth/otp') {
      if (!otpSecret) { sendJson(res, 404, { error: 'This server is not gated; no code is needed.' }); return; }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Only POST is supported here' }); return; }
      handleOtpExchange(req, res);
      return;
    }

    // The page itself is always served so the code can be entered in the UI;
    // every other /api/* route needs the session token that code bought.
    //
    // Requiring a header, rather than reading a cookie, is also what stops a
    // random page in another tab from POSTing to this server: a custom header
    // forces a CORS preflight, and nothing here answers one.
    if (otpSecret && pathname.startsWith('/api/') && !sessions.validate(req.headers['x-hub-token'])) {
      sendJson(res, 401, { error: 'Missing or expired session. Enter the 6 digit code from your authenticator.' });
      return;
    }

    if (pathname === '/' && req.method === 'GET') {
      let html;
      try { html = fs.readFileSync(clientHtmlPath, 'utf8'); }
      catch (err) { sendJson(res, 500, { error: `Cannot read client.html: ${err.message}` }); return; }
      sendText(res, 200, html, 'text/html; charset=utf-8');
      return;
    }

    if (pathname === '/api/config') {
      if (req.method === 'GET') {
        // A config pinned to an exact version holds a model MODELS does not offer.
        // Leaving it out would render a select with nothing selected, so the page
        // would show `opus` while the server still ran the pinned one.
        const models = MODELS.includes(config.defaults.model) ? MODELS : [config.defaults.model, ...MODELS];
        sendJson(res, 200, { ...config, configPath: configPath(...homeArgs), models, efforts: EFFORTS, permissionModes: PERMISSION_MODES });
        return;
      }
      if (req.method === 'PUT') { handleConfigPut(req, res); return; }
      sendJson(res, 405, { error: 'Only GET and PUT are supported here' });
      return;
    }

    if (pathname === '/api/dashboard' && req.method === 'GET') {
      try {
        sendJson(res, 200, buildDashboard());
      } catch (err) {
        sendJson(res, 500, { error: `Scan failed: ${err.message}` });
      }
      return;
    }

    if (pathname === '/api/usage' && req.method === 'GET') {
      sendJson(res, 200, { ...usage.get(), intervalMinutes: config.usageIntervalMinutes });
      return;
    }

    if (pathname === '/api/usage/refresh' && req.method === 'POST') {
      usage.refresh().then((result) => sendJson(res, 200, { ...result, intervalMinutes: config.usageIntervalMinutes }));
      return;
    }

    if (pathname.startsWith('/api/runs/') && req.method === 'GET') {
      const runId = decodeSegment(pathname.slice('/api/runs/'.length));
      const run = runId ? runs.get(runId) : null;
      if (!run) { sendJson(res, 404, { error: 'No such run' }); return; }
      sendJson(res, 200, run);
      return;
    }

    if (pathname.startsWith('/api/projects/')) {
      const parts = pathname.slice('/api/projects/'.length).split('/');
      const pid = decodeSegment(parts[0]);
      const projectPath = pid ? resolveProjectId(config, pid) : null;
      // A project id that is not in the config is a 404 - a path is never
      // accepted from the URL, only an id that already resolves.
      if (!projectPath) { sendJson(res, 404, { error: 'No such project' }); return; }

      // /api/projects/:pid/jobs - the on-demand .work scan for one project
      if (parts[1] === 'jobs' && parts.length === 2 && req.method === 'GET') {
        try {
          sendJson(res, 200, buildProjectJobs(projectPath, pid));
        } catch (err) {
          sendJson(res, 500, { error: `Scan failed: ${err.message}` });
        }
        return;
      }

      // /api/projects/:pid/terminal - opens a console on the server's desktop
      if (parts[1] === 'terminal' && parts.length === 2 && req.method === 'POST') {
        const result = openTerminal(projectPath);
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return; }
        sendJson(res, 200, result);
        return;
      }

      // /api/projects/:pid/jobs/:folder/md/:file
      if (parts[1] === 'jobs' && parts[3] === 'md' && parts.length === 5 && req.method === 'GET') {
        handleMarkdownRoute(res, projectPath, parts[2], parts[4]);
        return;
      }

      // /api/projects/:pid/jobs/:folder/resolve - the only route that writes
      // into a monitored folder.
      if (parts[1] === 'jobs' && parts[3] === 'resolve' && parts.length === 4 && req.method === 'POST') {
        const folder = decodeSegment(parts[2]);
        if (!folder) { sendJson(res, 400, { error: 'Invalid job folder segment' }); return; }
        const result = resolveJob(projectPath, folder);
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return; }
        sendJson(res, 200, { folder, workflow: result.workflow, added: result.added });
        return;
      }

      // /api/projects/:pid/sessions
      if (parts[1] === 'sessions' && parts.length === 2) {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            projectId: pid,
            projectPath,
            transcriptDir: resolveTranscriptDir(projectPath, ...homeArgs),
            sessions: listSessions(projectPath, home === undefined ? {} : { home }),
          });
          return;
        }
        if (req.method === 'POST') { handleRunStart(req, res, projectPath, pid, null); return; }
        sendJson(res, 405, { error: 'Only GET and POST are supported here' });
        return;
      }

      // /api/projects/:pid/sessions/:sid[/reply]
      if (parts[1] === 'sessions' && (parts.length === 3 || parts.length === 4)) {
        const sid = decodeSegment(parts[2]);
        if (!sid) { sendJson(res, 400, { error: 'Invalid session id' }); return; }

        if (parts.length === 3 && req.method === 'GET') {
          const chat = readSessionChat(projectPath, sid, home === undefined ? {} : { home });
          if (!chat) { sendJson(res, 404, { error: 'No such conversation' }); return; }
          sendJson(res, 200, chat);
          return;
        }
        if (parts[3] === 'reply' && req.method === 'POST') {
          handleRunStart(req, res, projectPath, pid, sid);
          return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  server.on('close', () => usage.stop());
  return server;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const { port, host, open, noOtp } = opts;
  const exposed = !isLoopback(host); // 0.0.0.0 included - it binds every interface

  let enrollment;
  try {
    enrollment = loadEnrollment();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Off-machine and unpaired is refused outright. There is no fallback secret
  // to fall back to any more, and starting wide open is not a default anyone
  // should get by forgetting a step.
  if (exposed && !enrollment) {
    console.error(`Cannot bind ${host}: no authenticator is paired with this machine, so there would be nothing gating it.`);
    console.error('Pair one first:  node src/enroll.mjs');
    console.error(`It writes ${enrollmentPath()}.`);
    process.exit(1);
  }

  // Once paired, loopback is gated too. A code every 12 hours is the price of
  // any page in any tab not being able to POST a run into this server.
  const otpSecret = enrollment && !noOtp ? enrollment.secret : null;

  const server = createServer({ otpSecret });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Pass a different port with --port <n> (e.g. --port ${port + 1}).`);
      process.exit(1);
    }
    if (err.code === 'EADDRNOTAVAIL') {
      console.error(
        `Cannot bind ${host}: this machine does not have that address right now. Confirm it with ipconfig (LAN), ` +
        '"tailscale ip -4" (Tailscale), or your Meshnet peer list (NordVPN) before retrying, or pass --host <ip>.',
      );
      process.exit(1);
    }
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const displayUrl = host === '0.0.0.0' ? `http://127.0.0.1:${port}/ (and every other interface)` : `http://${host}:${port}/`;
    console.log(`Work Hub running at ${displayUrl}`);
    console.log(`Bound to:    ${host}:${port}`);
    console.log(`Config file: ${configPath()}`);

    if (otpSecret) {
      console.log('');
      console.log(`Sign in: the page asks for the 6 digit code your authenticator shows for ${enrollment.account}.`);
      console.log('A correct code buys a 12 hour session. Restarting this server ends every session.');
    } else if (enrollment) {
      console.log('');
      console.warn('--no-otp: every /api/* route is open to anything that can reach 127.0.0.1, this browser included.');
    } else {
      console.log('');
      console.log('No authenticator paired, so nothing is gated. Pair one with: node src/enroll.mjs');
    }

    if (exposed) {
      console.warn('');
      console.warn(`WARNING: bound to ${host}, not loopback. This server can run \`claude\` under your account, with your`);
      console.warn(`files and your subscription. A code from ${enrollment.account} is the only thing standing between the network and that.`);
      console.warn('');
    }

    if (open) {
      import('node:child_process').then(({ spawn }) => {
        spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}/`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
