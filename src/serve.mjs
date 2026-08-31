// Local HTTP server for Work Hub: the multi-project `.work` dashboard and the
// Claude conversation console.
//
// Unlike the read-only viewer this grew out of, this server can execute `claude`
// under the user's account. That is why access is gated on a code from an
// authenticator app, why the message a run sends only ever travels over stdin,
// and why every other argument is an allowlisted token. See README.md § Exposure.
//
// node: built-ins plus exactly one third-party runtime dependency, node-pty,
// which backs the in-page terminal - there is no pty in Node's built-ins.
// Everything else stays dependency-free. node-pty itself is not loaded here:
// this process only talks to it through `shells` (lib/shell-client.mjs by
// default), a client of the separate shell host daemon (src/shell-host.mjs)
// that actually owns every pty, so a restart of this server never kills or
// orphans an open terminal.

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
import { listBranches, listCommits, commitFiles, fileAtCommit, workingStatus, workingFile } from './lib/git.mjs';
import { openTerminal, openVerifyTerminal } from './lib/terminal.mjs';
import { createShellHostClient } from './lib/shell-client.mjs';
import { listProcesses, killProcess } from './lib/processes.mjs';
import { renderMarkdown } from './lib/markdown.mjs';
import { loadEnrollment, createSessionStore, enrollmentPath } from './lib/authstore.mjs';
import { loadPin, savePin, verifyPin } from './lib/pinstore.mjs';
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

function sendEmpty(res, status) {
  res.writeHead(status, { 'Content-Length': 0 });
  res.end();
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
    /** Zeroes the failure count. For a PIN, which has no replay counter to `claim`. */
    reset() {
      failures = 0;
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

// ── Static client ────────────────────────────────────────────────────────────

// An extension not in here is not servable, whatever it resolves to. That is
// what keeps `src/client/` from turning into "serve any file the process can
// open" if a stray file ever lands in the folder.
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Maps a request path to a file under `root`, or null when it does not name one.
 *
 * The guard is the resolved-prefix check, not a scan for `..` in the string:
 * `/js/%2e%2e/%2e%2e/lib/config.mjs` decodes and normalises to a path outside
 * `root`, and that resolved path is what gets rejected. A NUL is refused up
 * front because `fs` throws on it, and that throw would surface as a 500.
 */
function resolveStaticFile(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;

  const full = path.resolve(root, decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (!Object.prototype.hasOwnProperty.call(STATIC_TYPES, path.extname(full).toLowerCase())) return null;
  return full;
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

// ── Git inspection routes ────────────────────────────────────────────────────

const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_STATUS_AREAS = ['staged', 'unstaged', 'untracked'];

async function handleGitBranches(res, projectPath) {
  try {
    sendJson(res, 200, await listBranches(projectPath));
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGitStatus(res, projectPath) {
  try {
    sendJson(res, 200, await workingStatus(projectPath));
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGitStatusFile(res, projectPath, filePath, area) {
  if (!filePath || !GIT_STATUS_AREAS.includes(area)) {
    sendJson(res, 400, { error: `path is required and area must be one of ${GIT_STATUS_AREAS.join(', ')}` });
    return;
  }
  try {
    sendJson(res, 200, await workingFile(projectPath, filePath, area));
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleGitCommits(res, projectPath, branch, skip) {
  if (!branch || !Number.isInteger(skip) || skip < 0) {
    sendJson(res, 400, { error: 'branch is required and skip must be a non-negative integer' });
    return;
  }
  try {
    sendJson(res, 200, await listCommits(projectPath, branch, skip));
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleGitCommitFiles(res, projectPath, sha) {
  if (!sha || !GIT_SHA_RE.test(sha)) {
    sendJson(res, 400, { error: 'Malformed commit sha' });
    return;
  }
  try {
    sendJson(res, 200, await commitFiles(projectPath, sha));
  } catch (err) {
    sendJson(res, 404, { error: err.message });
  }
}

async function handleGitCommitFile(res, projectPath, sha, filePath) {
  if (!sha || !GIT_SHA_RE.test(sha)) {
    sendJson(res, 400, { error: 'Malformed commit sha' });
    return;
  }
  if (!filePath) {
    sendJson(res, 400, { error: 'path is required' });
    return;
  }
  try {
    sendJson(res, 200, await fileAtCommit(projectPath, sha, filePath));
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

/**
 * Lists the immediate subdirectories of an absolute path, directories only,
 * sorted case-insensitively. Never an error body: a missing param, a relative
 * path, a non-existent path, a file, or an unreadable directory all answer
 * `{ dirs: [] }` - this only ever helps a folder picker offer children, so
 * there is nothing for the caller to react to besides an empty list.
 */
function handleFsDirs(res, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || !path.isAbsolute(rawPath)) {
    sendJson(res, 200, { dirs: [] });
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(rawPath, { withFileTypes: true });
  } catch {
    sendJson(res, 200, { dirs: [] });
    return;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  sendJson(res, 200, { dirs });
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
  openVerify = openVerifyTerminal,
  shells = createShellHostClient(),
  usage = createUsageCache(),
  sessions = createSessionStore(),
  idleMinutes = 10,
} = {}) {
  const clientRoot = path.resolve(__dirname, 'client');
  const homeArgs = home === undefined ? [] : [home];
  const otpGuard = createOtpGuard();
  const pinGuard = createOtpGuard();

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
    const favorites = new Set((config.favorites ?? []).map((p) => p.toLowerCase()));
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
        name: config.projectNames[projectPath] || path.basename(projectPath) || projectPath,
        missing,
        hasWorkDir,
        favorite: favorites.has(projectPath.toLowerCase()),
      };
    });

    // Favourites first, config order kept inside each group - a starred folder
    // moves to the front, it does not shuffle everything else.
    const sorted = [...projects.filter((p) => p.favorite), ...projects.filter((p) => !p.favorite)];

    // Groups as project ids: the page only ever handles ids, and a member whose
    // folder left the config has already been dropped by normalizeConfig.
    const idOf = new Map(projects.map((p) => [p.path.toLowerCase(), p.id]));
    const groups = (config.groups ?? []).map((g) => ({
      name: g.name,
      ids: g.projects.map((p) => idOf.get(p.toLowerCase())).filter(Boolean),
    }));

    return { projects: sorted, groups, configPath: configPath(...homeArgs), loadError: config.loadError ?? null };
  }

  /** One project's jobs, scanned on demand. This is the expensive call. */
  function buildProjectJobs(projectPath, pid, now = Date.now()) {
    const scan = scanWorkFolder(projectPath, { now });
    const projectName = config.projectNames[projectPath] || path.basename(projectPath) || projectPath;
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
        // Not editable here - Settings does not know about stars or groups. A
        // folder dropped from `projects` loses both in normalizeConfig.
        favorites: config.favorites,
        groups: config.groups,
        projectNames: body?.projectNames ?? config.projectNames,
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

  async function handleFavoritePut(req, res, projectPath) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }
    if (typeof body?.favorite !== 'boolean') {
      sendJson(res, 400, { error: '`favorite` must be true or false' });
      return;
    }

    const key = projectPath.toLowerCase();
    const kept = (config.favorites ?? []).filter((p) => p.toLowerCase() !== key);
    try {
      config = saveConfig({ ...config, favorites: body.favorite ? [...kept, projectPath] : kept }, ...homeArgs);
    } catch (err) {
      sendJson(res, 500, { error: `Cannot write ${configPath(...homeArgs)}: ${err.message}` });
      return;
    }
    sendJson(res, 200, buildDashboard());
  }

  /**
   * Replaces the whole dashboard group list in one write. Create, rename,
   * delete, and drag all send the full `[{ name, ids }]` they want, so there is
   * no per-action route to keep consistent. Ids resolve to configured paths
   * here; anything that does not resolve is dropped rather than refused, since
   * the worst it can mean is a project removed between paint and drop.
   */
  async function handleGroupsPut(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }
    if (!Array.isArray(body?.groups)) {
      sendJson(res, 400, { error: '`groups` must be an array' });
      return;
    }
    const groups = [];
    for (const entry of body.groups) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name.trim()) {
        sendJson(res, 400, { error: 'Each group needs a non-empty string `name`' });
        return;
      }
      const ids = Array.isArray(entry.ids) ? entry.ids : [];
      const members = ids
        .map((id) => (typeof id === 'string' ? resolveProjectId(config, id) : null))
        .filter(Boolean);
      groups.push({ name: entry.name, projects: members });
    }
    try {
      config = saveConfig({ ...config, groups }, ...homeArgs);
    } catch (err) {
      sendJson(res, 500, { error: `Cannot write ${configPath(...homeArgs)}: ${err.message}` });
      return;
    }
    sendJson(res, 200, buildDashboard());
  }

  /** `<pid>/<folder>` -> the state of that job's verify window, while this process lives. */
  const verifyRuns = new Map();

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

  /**
   * Trades a six digit PIN for a session token.
   *
   * Same shape as `handleOtpExchange`, minus the replay guard: a PIN is not
   * single-use, and its own guard (`pinGuard`) so wrong PINs never lock the
   * code exchange, and vice versa.
   */
  async function handlePinExchange(req, res) {
    const locked = pinGuard.lockedFor();
    if (locked > 0) {
      sendJson(res, 429, { error: `Too many wrong PINs. Try again in ${locked}s.`, retryAfterSeconds: locked });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }

    const record = loadPin(...homeArgs);
    if (!verifyPin(record, body?.pin)) {
      pinGuard.fail();
      sendJson(res, 401, { error: 'That PIN is not right.' });
      return;
    }
    pinGuard.reset();

    const session = sessions.issue({ via: 'pin' });
    sendJson(res, 200, { token: session.token, expiresAt: session.expiresAt });
  }

  /** Sets or replaces the PIN. Requires a live session whose `via` is `otp`. */
  async function handlePinPut(req, res, token) {
    const session = sessions.validate(token);
    if (!session) {
      sendJson(res, 401, { error: 'Missing or expired session.' });
      return;
    }
    if (session.via !== 'otp') {
      sendJson(res, 403, { error: 'Sign in with your authenticator code to set a PIN.' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }

    try {
      savePin(body?.pin, ...homeArgs);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    sendEmpty(res, 204);
  }

  /** Revokes the calling session so the next request needs a fresh sign-in. */
  function handleLock(req, res, token) {
    if (!sessions.revoke(token)) {
      sendJson(res, 401, { error: 'Missing or expired session.' });
      return;
    }
    sendEmpty(res, 204);
  }

  // ── In-page terminals ──────────────────────────────────────────────────────
  // Several ptys per project, keyed by shellId (see lib/shell.mjs). These
  // routes are the reason the whole /api/* tree is session-gated: input is fed
  // straight to a shell running as the user.

  async function handleShellOpen(req, res, pid, projectPath) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }
    const opened = await shells.open({ projectId: pid, cwd: projectPath, cols: body?.cols, rows: body?.rows });
    if (!opened.ok) { sendJson(res, opened.status, { error: opened.error }); return; }
    sendJson(res, 200, opened.shell);
  }

  async function handleShellKill(req, res, shellId) {
    const killed = await shells.kill(shellId);
    if (!killed.ok) { sendJson(res, killed.status, { error: killed.error }); return; }
    sendEmpty(res, 204);
  }

  /** DELETE /api/shells with no id: closes every shell the host owns. */
  async function handleShellKillAll(req, res) {
    await shells.killAll();
    sendJson(res, 200, { ok: true });
  }

  /**
   * The output stream: newline-delimited JSON events over a response that
   * never ends until the shell exits or the client goes away. The page reads
   * it with a streaming fetch (EventSource cannot carry the session header).
   */
  async function handleShellStream(req, res, shellId) {
    let ended = false;
    const send = (event) => {
      if (ended) return; // a straggling event after exit must not write to an ended response
      res.write(JSON.stringify(event) + '\n');
      if (event.type === 'exit') { ended = true; res.end(); }
    };
    const attached = await shells.attach(shellId, send);
    if (!attached.ok) { sendJson(res, attached.status, { error: attached.error }); return; }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    if (attached.replay) res.write(JSON.stringify({ type: 'data', data: attached.replay }) + '\n');
    // Already exited: the shell host (or an in-process fake) still delivers
    // exactly one exit event through `send` above - it is never up to this
    // handler to synthesize one.
    if (!attached.running) return;

    // Keeps intermediaries (and the client's reader) from mistaking a quiet
    // shell for a dead connection.
    const ping = setInterval(() => { try { res.write(JSON.stringify({ type: 'ping' }) + '\n'); } catch { /* closing */ } }, 30000);
    ping.unref?.();
    res.on('close', () => { clearInterval(ping); attached.unsubscribe(); });
  }

  async function handleShellInput(req, res, shellId) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }
    const wrote = await shells.write(shellId, body?.data);
    if (!wrote.ok) { sendJson(res, wrote.status, { error: wrote.error }); return; }
    sendEmpty(res, 204);
  }

  async function handleShellResize(req, res, shellId) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }
    const resized = await shells.resize(shellId, body?.cols, body?.rows);
    if (!resized.ok) { sendJson(res, resized.status, { error: resized.error }); return; }
    sendEmpty(res, 204);
  }

  async function handleShellRename(req, res, shellId) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? err.message : `Invalid request body: ${err.message}` });
      return;
    }
    const renamed = await shells.rename(shellId, body?.name);
    if (!renamed.ok) { sendJson(res, renamed.status, { error: renamed.error }); return; }
    sendEmpty(res, 204);
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
      const session = otpSecret ? sessions.validate(req.headers['x-hub-token']) : false;
      sendJson(res, 200, {
        required: Boolean(otpSecret),
        authenticated: !otpSecret || Boolean(session),
        digits: 6,
        periodSeconds: STEP_SECONDS,
        pinSet: Boolean(otpSecret && loadPin(...homeArgs)),
        via: session ? session.via : null,
        idleMinutes,
      });
      return;
    }

    if (pathname === '/api/auth/otp') {
      if (!otpSecret) { sendJson(res, 404, { error: 'This server is not gated; no code is needed.' }); return; }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Only POST is supported here' }); return; }
      handleOtpExchange(req, res);
      return;
    }

    // Ungated on purpose, like /api/auth/otp - it is a way in. A PIN can only
    // be exchanged when the server is gated and a PIN has been set.
    if (pathname === '/api/auth/pin' && req.method === 'POST') {
      if (!otpSecret || !loadPin(...homeArgs)) { sendJson(res, 404, { error: 'No PIN is set.' }); return; }
      handlePinExchange(req, res);
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

    // These two need a live session already, so they sit after the gate above:
    // a missing token is already a 401 by the time either handler runs.
    if (pathname === '/api/auth/pin') {
      if (!otpSecret) { sendJson(res, 404, { error: 'This server is not gated; there is nothing to set a PIN for.' }); return; }
      if (req.method === 'PUT') { handlePinPut(req, res, req.headers['x-hub-token']); return; }
      sendJson(res, 405, { error: 'Only POST and PUT are supported here' });
      return;
    }

    if (pathname === '/api/auth/lock') {
      if (!otpSecret) { sendJson(res, 404, { error: 'This server is not gated; there is no session to lock.' }); return; }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Only POST is supported here' }); return; }
      handleLock(req, res, req.headers['x-hub-token']);
      return;
    }

    // The page and everything it pulls in - stylesheets, ES modules - is served
    // ungated, exactly as the single client.html was: the prompt for the code
    // is part of that page, so it has to load before a code can be entered.
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      const file = resolveStaticFile(clientRoot, pathname);
      if (file) {
        let body;
        try { body = fs.readFileSync(file); }
        catch (err) {
          if (err.code === 'ENOENT' || err.code === 'EISDIR') { sendJson(res, 404, { error: 'Not found' }); return; }
          sendJson(res, 500, { error: `Cannot read ${path.relative(clientRoot, file)}: ${err.message}` });
          return;
        }
        res.writeHead(200, {
          'Content-Type': STATIC_TYPES[path.extname(file).toLowerCase()],
          'Content-Length': body.length,
          // Read off disk per request. An edit has to show up on the next
          // reload, not after a hard refresh.
          'Cache-Control': 'no-cache',
        });
        res.end(body);
        return;
      }
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

    if (pathname === '/api/fs/dirs' && req.method === 'GET') {
      handleFsDirs(res, url.searchParams.get('path'));
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

    if (pathname === '/api/groups') {
      if (req.method === 'PUT') { handleGroupsPut(req, res); return; }
      sendJson(res, 405, { error: 'Only PUT is supported here' });
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

    // /api/shells - the Processes list: every Work Hub shell across all
    // projects, this session's and any straggler the OS still shows (see
    // lib/processes.mjs). One place, whatever page you are on. DELETE (no id)
    // is the "close everything" button - it kills every shell the host owns,
    // which is why it is checked here, ahead of the `/api/shells/:shellId`
    // parsing below that always expects a UUID segment.
    if (pathname === '/api/shells') {
      if (req.method === 'GET') {
        const nameOf = (projectId) => {
          const p = projectId ? resolveProjectId(config, projectId) : null;
          return p ? (config.projectNames[p] || path.basename(p) || p) : undefined;
        };
        listProcesses({ registry: shells, nameOf })
          .then((list) => sendJson(res, 200, { processes: list }))
          .catch((err) => sendJson(res, 500, { error: `Could not list processes: ${err.message}` }));
        return;
      }
      if (req.method === 'DELETE') { handleShellKillAll(req, res); return; }
      sendJson(res, 405, { error: 'Only GET and DELETE are supported here' });
      return;
    }

    // /api/shells/:shellId[/...] - per-shell operations, keyed by the id the
    // page already holds. stream/input/resize drive one terminal; rename sets
    // its tab label; DELETE kills a session shell cleanly by closing its pty.
    if (pathname.startsWith('/api/shells/')) {
      const rest = pathname.slice('/api/shells/'.length).split('/');
      const shellId = decodeSegment(rest[0]);
      if (!shellId || !UUID_RE.test(shellId)) { sendJson(res, 400, { error: 'Malformed shell id' }); return; }

      if (rest.length === 1) {
        if (req.method === 'DELETE') { handleShellKill(req, res, shellId); return; }
        sendJson(res, 405, { error: 'Only DELETE is supported here' });
        return;
      }
      if (rest[1] === 'stream' && rest.length === 2 && req.method === 'GET') { handleShellStream(req, res, shellId); return; }
      if (rest[1] === 'input' && rest.length === 2 && req.method === 'POST') { handleShellInput(req, res, shellId); return; }
      if (rest[1] === 'resize' && rest.length === 2 && req.method === 'POST') { handleShellResize(req, res, shellId); return; }
      if (rest[1] === 'rename' && rest.length === 2 && req.method === 'POST') { handleShellRename(req, res, shellId); return; }
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // /api/processes/:pid - force-kill a straggler by pid (a shell from a past
    // run the registry no longer owns). taskkill /T takes its child tree too.
    if (pathname.startsWith('/api/processes/') && req.method === 'DELETE') {
      const pidStr = decodeSegment(pathname.slice('/api/processes/'.length));
      const targetPid = Number(pidStr);
      if (!Number.isInteger(targetPid) || targetPid <= 0) { sendJson(res, 400, { error: 'pid must be a positive integer' }); return; }
      killProcess(targetPid)
        .then((r) => { if (r.ok) sendEmpty(res, 204); else sendJson(res, r.status, { error: r.error }); })
        .catch((err) => sendJson(res, 500, { error: err.message }));
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

      // /api/projects/:pid/favorite - stars or unstars a monitored folder. The
      // whole dashboard comes back so the strip repaints from one response
      // rather than starring locally and hoping the next poll agrees.
      if (parts[1] === 'favorite' && parts.length === 2 && req.method === 'PUT') {
        handleFavoritePut(req, res, projectPath);
        return;
      }

      // /api/projects/:pid/shells - the in-page terminals for this project.
      // POST opens a new one (returns its shellId); GET lists this project's,
      // so the Terminal tab can rebuild its `Terminal 1 | Terminal 2 | +`
      // strip. Per-shell operations live under /api/shells/:shellId below,
      // because a shellId is unique on its own and the page holds it directly.
      if (parts[1] === 'shells' && parts.length === 2) {
        if (req.method === 'POST') { handleShellOpen(req, res, pid, projectPath); return; }
        if (req.method === 'GET') {
          shells.listForProject(pid).then((list) => sendJson(res, 200, { shells: list }));
          return;
        }
        sendJson(res, 405, { error: 'Only GET and POST are supported here' });
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

      // /api/projects/:pid/jobs/:folder/verify - POST opens a headless
      // `claude -p` verification run on the server's desktop; GET says whether
      // that window is still open. The page polls GET and reloads the job when
      // the run ends. Memory only, like sessions: a restart forgets a run, and
      // GET then answers `known: false`, which the page treats as "ended".
      if (parts[1] === 'jobs' && parts[3] === 'verify' && parts.length === 4 && (req.method === 'POST' || req.method === 'GET')) {
        const folder = decodeSegment(parts[2]);
        if (!folder) { sendJson(res, 400, { error: 'Invalid job folder segment' }); return; }
        const key = `${pid}/${folder}`;
        const current = verifyRuns.get(key) || null;

        if (req.method === 'GET') {
          sendJson(res, 200, current ? { ...current } : { folder, known: false, running: false });
          return;
        }

        if (current && current.running) {
          sendJson(res, 409, { error: `A verify run for ${folder} is already open. Finish or close that window first.` });
          return;
        }
        const record = { folder, known: true, running: true, startedAt: Date.now(), endedAt: null, exitCode: null };
        const result = openVerify(projectPath, folder, {
          onExit: (code) => {
            record.running = false;
            record.endedAt = Date.now();
            record.exitCode = typeof code === 'number' ? code : null;
          },
        });
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return; }
        verifyRuns.set(key, record);
        sendJson(res, 200, { folder, command: result.command, cwd: result.cwd, running: true });
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

      // /api/projects/:pid/git/* - read-only git inspection
      if (parts[1] === 'git') {
        if (parts[2] === 'branches' && parts.length === 3) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'Only GET is supported here' }); return; }
          handleGitBranches(res, projectPath);
          return;
        }

        if (parts[2] === 'status' && parts.length === 3) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'Only GET is supported here' }); return; }
          handleGitStatus(res, projectPath);
          return;
        }

        if (parts[2] === 'status' && parts[3] === 'file' && parts.length === 4) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'Only GET is supported here' }); return; }
          handleGitStatusFile(res, projectPath, url.searchParams.get('path'), url.searchParams.get('area'));
          return;
        }

        if (parts[2] === 'commits' && parts.length === 3) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'Only GET is supported here' }); return; }
          const branch = url.searchParams.get('branch');
          const skip = Number(url.searchParams.get('skip') ?? '0');
          handleGitCommits(res, projectPath, branch, skip);
          return;
        }

        if (parts[2] === 'commits' && parts[4] === 'files' && parts.length === 5) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'Only GET is supported here' }); return; }
          handleGitCommitFiles(res, projectPath, decodeSegment(parts[3]));
          return;
        }

        if (parts[2] === 'commits' && parts[4] === 'file' && parts.length === 5) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'Only GET is supported here' }); return; }
          handleGitCommitFile(res, projectPath, decodeSegment(parts[3]), url.searchParams.get('path'));
          return;
        }

        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  // Deliberately does NOT call shells.killAll() here any more: the shell host
  // daemon owns every pty in its own process now (see lib/shell-client.mjs),
  // so a server restart or shutdown must leave every open terminal running -
  // that survival is the entire point of moving shells out of this process.
  server.on('close', () => { usage.stop(); });
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
      let pinSet = false;
      try { pinSet = Boolean(loadPin()); } catch { pinSet = false; }
      if (pinSet) console.log('A PIN is also set: it signs in the same way, and only an authenticator session can change it.');
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
