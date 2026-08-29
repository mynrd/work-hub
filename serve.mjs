// Local HTTP server for Work Hub: the multi-project `.work` dashboard and the
// Claude conversation console.
//
// Unlike the read-only viewer this grew out of, this server can execute `claude`
// under the user's account. That is why every non-loopback bind needs a shared
// token, why the message a run sends only ever travels over stdin, and why every
// other argument is an allowlisted token. See README.md § Exposure.
//
// node: built-ins only. No third-party dependency, no package.json.

import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig, configPath, encodeProjectId, resolveProjectId, validateProjectPath, MODELS, EFFORTS, PERMISSION_MODES } from './config.mjs';
import { scanWorkFolder } from './workscan.mjs';
import { listSessions, readSessionChat, resolveTranscriptDir } from './transcripts.mjs';
import { createUsageCache } from './usage.mjs';
import { createRunRegistry } from './claude-run.mjs';
import { resolveJob } from './resolve-job.mjs';
import { renderMarkdown } from './markdown.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 8731;
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
  let token = null;
  let noToken = false;
  let open = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const valueOf = (flag) => (arg === flag ? argv[++i] : arg.slice(flag.length + 1));

    if (arg === '--port' || arg.startsWith('--port=')) port = Number(valueOf('--port'));
    else if (arg === '--host' || arg.startsWith('--host=')) host = valueOf('--host');
    else if (arg === '--token' || arg.startsWith('--token=')) token = valueOf('--token');
    else if (arg === '--no-token') noToken = true;
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
  if (token !== null && (typeof token !== 'string' || token.trim().length < 8)) {
    throw new Error('Invalid --token value: it must be at least 8 characters.');
  }
  if (noToken && !isLoopback(host)) {
    throw new Error(
      `--no-token cannot be combined with --host ${host}. This server can run \`claude\` as you; a non-loopback bind requires a token. ` +
      'Drop --no-token (one is generated and printed for you) or pass --token <secret>.',
    );
  }

  return { port, host, token, noToken, open };
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

/** Constant-time compare so a wrong token cannot be guessed a character at a time. */
function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

export function createServer({ token = null, home = undefined, runs = createRunRegistry(), usage = createUsageCache() } = {}) {
  const clientHtmlPath = path.join(__dirname, 'client.html');
  const homeArgs = home === undefined ? [] : [home];

  let config = loadConfig(...homeArgs);
  usage.setIntervalMinutes(config.usageIntervalMinutes);

  /** The dashboard model: every configured project, scanned fresh. No cache. */
  function buildDashboard(now = Date.now()) {
    const projects = [];
    const today = [];
    const notStarted = [];
    const others = [];
    const unreadable = [];

    for (const projectPath of config.projects) {
      const pid = encodeProjectId(projectPath);
      const scan = scanWorkFolder(projectPath, { now });
      const transcriptDir = resolveTranscriptDir(projectPath, ...homeArgs);
      const sessions = transcriptDir ? listSessions(projectPath, { ...(home === undefined ? {} : { home }), now }) : [];

      const jobs = [...scan.today, ...scan.notStarted, ...scan.others];
      const lastActivity = jobs.reduce((max, j) => Math.max(max, j.lastActivity || 0), 0);
      const lastSession = sessions.reduce((max, s) => Math.max(max, s.lastWrite || 0), 0);

      projects.push({
        id: pid,
        path: projectPath,
        name: path.basename(projectPath) || projectPath,
        missing: scan.missing,
        hasWorkDir: scan.hasWorkDir,
        jobCount: jobs.length,
        unreadableCount: scan.unreadable.length,
        sessionCount: sessions.length,
        liveSessions: sessions.filter((s) => s.live).length,
        lastActivity: Math.max(lastActivity, lastSession),
      });

      const tag = (job) => ({ ...job, projectId: pid, projectName: path.basename(projectPath) || projectPath });
      today.push(...scan.today.map(tag));
      notStarted.push(...scan.notStarted.map(tag));
      others.push(...scan.others.map(tag));
      unreadable.push(...scan.unreadable.map((u) => ({ ...u, projectId: pid, projectName: path.basename(projectPath) || projectPath })));
    }

    const byActivity = (a, b) => (b.lastActivity || 0) - (a.lastActivity || 0);
    today.sort(byActivity);
    notStarted.sort(byActivity);
    others.sort(byActivity);

    return { projects, today, notStarted, others, unreadable, configPath: configPath(...homeArgs), loadError: config.loadError ?? null };
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

    // The page itself is always served so the token can be entered in the UI;
    // every /api/* route is gated.
    if (token && pathname.startsWith('/api/') && !tokenMatches(token, req.headers['x-hub-token'])) {
      sendJson(res, 401, { error: 'Missing or invalid X-Hub-Token header.' });
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
        sendJson(res, 200, { ...config, configPath: configPath(...homeArgs), models: MODELS, efforts: EFFORTS, permissionModes: PERMISSION_MODES });
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

  const { port, host, open } = opts;
  const exposed = !isLoopback(host); // 0.0.0.0 included - it binds every interface
  // A token is mandatory the moment the server is reachable from off-machine.
  // On loopback it is opt-in, because a token there only protects against other
  // local users - who can run `claude` themselves anyway.
  const token = opts.token ?? (exposed ? crypto.randomBytes(24).toString('base64url') : null);

  const server = createServer({ token });

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

    if (token) {
      console.log('');
      console.log(`Access token: ${token}`);
      console.log('Paste it into the page when asked. Every /api/* request needs it as the X-Hub-Token header.');
    }

    if (exposed) {
      console.warn('');
      console.warn(`WARNING: bound to ${host}, not loopback. This server can run \`claude\` under your account, with your`);
      console.warn('files and your subscription. The token above is the only thing standing between the network and that.');
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
