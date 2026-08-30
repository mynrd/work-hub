// AC 1, 2, 14, 15: arg parsing, config persistence and validation, the one-time
// code gate, and path safety on the project id / job folder / markdown segments.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { parseArgs, createServer } from '../src/serve.mjs';
import { generateSecret, totp, STEP_SECONDS } from '../src/lib/totp.mjs';
import { loadConfig, saveConfig, configPath, encodeProjectId, resolveProjectId, validateProjectPath, normalizeConfig } from '../src/lib/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const PROJ_A = path.join(FIXTURES, 'proj-a');

// ── AC 1: arguments ──────────────────────────────────────────────────────────

test('AC 1: defaults are 127.0.0.1:5081', () => {
  assert.deepEqual(parseArgs([]), { port: 5081, host: '127.0.0.1', noOtp: false, open: false });
});

test('AC 1: --port and --host accept both spaced and = forms', () => {
  assert.equal(parseArgs(['--port', '9000']).port, 9000);
  assert.equal(parseArgs(['--port=9000']).port, 9000);
  assert.equal(parseArgs(['--host', '0.0.0.0']).host, '0.0.0.0');
  assert.equal(parseArgs(['--host=192.168.1.5']).host, '192.168.1.5');
  assert.equal(parseArgs(['--lan']).host, '0.0.0.0');
});

test('AC 1: a bad port or host fails with a message naming the flag', () => {
  assert.throws(() => parseArgs(['--port', 'abc']), /--port/);
  assert.throws(() => parseArgs(['--port', '0']), /--port/);
  assert.throws(() => parseArgs(['--port', '70000']), /--port/);
  assert.throws(() => parseArgs(['--host', 'not-an-ip']), /--host/);
  assert.throws(() => parseArgs(['--frobnicate']), /Unknown argument/);
});

test('AC 14: --no-otp with a non-loopback host refuses, naming the reason', () => {
  assert.throws(() => parseArgs(['--lan', '--no-otp']), /non-loopback bind is always gated/);
  assert.throws(() => parseArgs(['--host', '192.168.1.5', '--no-otp']), /--no-otp/);
  assert.doesNotThrow(() => parseArgs(['--no-otp']));
  assert.equal(parseArgs(['--no-otp']).noOtp, true);
});

test('AC 14: --token is gone, not silently accepted', () => {
  assert.throws(() => parseArgs(['--token', 'long-enough-token']), /Unknown argument/);
  assert.throws(() => parseArgs(['--no-token']), /Unknown argument/);
});

// ── AC 2: config ─────────────────────────────────────────────────────────────

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-cfg-'));
}

test('AC 2: a fresh machine loads the documented defaults', () => {
  const home = tempHome();
  const config = loadConfig(home);
  assert.deepEqual(config, {
    projects: [],
    usageIntervalMinutes: 5,
    defaults: { model: 'opus', effort: 'high', permissionMode: 'default' },
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 2: saving writes ~/.work-hub/config.json with 2-space indent, atomically', () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A], usageIntervalMinutes: 10 }, home);
  const raw = fs.readFileSync(configPath(home), 'utf8');
  assert.match(raw, /^\{\n {2}"projects": \[/);
  assert.deepEqual(loadConfig(home).projects, [path.resolve(PROJ_A)]);
  // The temp file used for the rename must not be left behind.
  assert.deepEqual(fs.readdirSync(path.join(home, '.work-hub')), ['config.json']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 2: adding a path that does not exist is refused with the reason', () => {
  const bad = validateProjectPath(path.join(FIXTURES, 'nowhere-at-all'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /does not exist/);

  const file = validateProjectPath(path.join(__dirname, '..', 'src', 'serve.mjs'));
  assert.equal(file.ok, false);
  assert.match(file.error, /is a file, not a folder/);

  assert.equal(validateProjectPath('').ok, false);
  assert.equal(validateProjectPath(null).ok, false);
});

test('AC 2: a valid path is accepted and resolved to an absolute path', () => {
  const ok = validateProjectPath(PROJ_A);
  assert.equal(ok.ok, true);
  assert.equal(ok.path, path.resolve(PROJ_A));
});

test('AC 5: a hand-mangled config file falls back to defaults with loadError set', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.work-hub'), { recursive: true });
  fs.writeFileSync(configPath(home), '{ not json');
  const config = loadConfig(home);
  assert.deepEqual(config.projects, []);
  assert.match(config.loadError, /invalid JSON/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 5: unknown or wrongly-typed config fields are coerced, never fatal', () => {
  const c = normalizeConfig({ projects: 'not an array', usageIntervalMinutes: -4, defaults: { model: 'gpt-4', effort: 'turbo' }, extra: true });
  assert.deepEqual(c.projects, []);
  assert.equal(c.usageIntervalMinutes, 5);
  assert.equal(c.defaults.model, 'opus');
  assert.equal(c.defaults.effort, 'high');
  assert.equal(c.extra, undefined);
});

test('a config pinned to an exact model id keeps it; the UI list only holds aliases', () => {
  assert.equal(normalizeConfig({ defaults: { model: 'claude-opus-5[1m]' } }).defaults.model, 'claude-opus-5[1m]');
  assert.equal(normalizeConfig({ defaults: { model: 'claude-opus-6' } }).defaults.model, 'opus');
});

test('duplicate paths are collapsed, case-insensitively', () => {
  const c = normalizeConfig({ projects: [PROJ_A, PROJ_A.toUpperCase(), '  '] });
  assert.equal(c.projects.length, 1);
});

// ── AC 15: ids and path safety ───────────────────────────────────────────────

test('AC 15: a project id resolves only to a configured path', () => {
  const config = { projects: [path.resolve(PROJ_A)] };
  assert.equal(resolveProjectId(config, encodeProjectId(path.resolve(PROJ_A))), path.resolve(PROJ_A));
  assert.equal(resolveProjectId(config, 'D--somewhere-else'), null);
  assert.equal(resolveProjectId(config, '..'), null);
  assert.equal(resolveProjectId(config, ''), null);
});

// ── Server routes ────────────────────────────────────────────────────────────

/** Starts the server on an ephemeral port and returns a fetch bound to it. */
async function withServer(options, fn) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn((path_, init) => fetch(base + path_, init));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('AC 1: GET / serves the dashboard page', async () => {
  const home = tempHome();
  await withServer({ home }, async (get) => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /Work Hub/);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 1: the page assets are served with the right content type', async () => {
  const home = tempHome();
  await withServer({ home }, async (get) => {
    for (const [path_, type, marker] of [
      ['/styles/tokens.css', /text\/css/, '--accent-500'],
      ['/styles/responsive.css', /text\/css/, '@media'],
      ['/js/main.mjs', /text\/javascript/, 'initRouter'],
      ['/js/components/detail-dialog.mjs', /text\/javascript/, 'openDetail'],
    ]) {
      const res = await get(path_);
      assert.equal(res.status, 200, path_);
      assert.match(res.headers.get('content-type'), type, path_);
      assert.ok((await res.text()).includes(marker), `${path_} is missing ${marker}`);
    }
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 1: the static root cannot be escaped, and only known extensions are served', async () => {
  const home = tempHome();
  await withServer({ home }, async (get) => {
    // fetch() normalises a literal `..` out of the path before it leaves, so
    // the escape attempts that matter are the percent-encoded ones - which is
    // exactly the form the resolved-prefix check exists to catch.
    for (const path_ of [
      '/js/%2e%2e/serve.mjs',
      '/js/%2e%2e/%2e%2e/serve.mjs',
      '/styles/%2e%2e/%2e%2e/lib/config.mjs',
      '/%2e%2e/package.json',
      '/js/%2e%2e/client/index.html%00.css',
      '/js',                 // a directory, not a file
      '/js/nope.mjs',        // inside the root, does not exist
      '/serve.mjs',          // a real file, but not under src/client
    ]) {
      assert.equal((await get(path_)).status, 404, path_);
    }
  });
  fs.rmSync(home, { recursive: true, force: true });
});

// A code is only live for 30 seconds, so these tests mint their own secret and
// read the current code off it rather than hard-coding digits.
function postCode(get, code) {
  return get('/api/auth/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

test('AC 14: with a secret enrolled, /api/* without a session is 401 but GET / still serves', async () => {
  const home = tempHome();
  await withServer({ home, otpSecret: generateSecret() }, async (get) => {
    assert.equal((await get('/')).status, 200);
    // The prompt for the code is part of the page, so the page and everything
    // it pulls in have to load before a code can be entered.
    assert.equal((await get('/styles/tokens.css')).status, 200);
    assert.equal((await get('/js/main.mjs')).status, 200);
    assert.equal((await get('/api/config')).status, 401);
    assert.equal((await get('/api/dashboard')).status, 401);
    assert.equal((await get('/api/config', { headers: { 'X-Hub-Token': 'not-a-session' } })).status, 401);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 14: a live code buys a session token that opens every /api/* route', async () => {
  const home = tempHome();
  const secret = generateSecret();
  await withServer({ home, otpSecret: secret }, async (get) => {
    const res = await postCode(get, totp(secret));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(body.expiresAt > Date.now());

    const headers = { 'X-Hub-Token': body.token };
    assert.equal((await get('/api/config', { headers })).status, 200);
    assert.equal((await get('/api/dashboard', { headers })).status, 200);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 14: a wrong code is refused and hands out nothing', async () => {
  const home = tempHome();
  const secret = generateSecret();
  await withServer({ home, otpSecret: secret }, async (get) => {
    const wrong = String((Number(totp(secret)) + 1) % 1000000).padStart(6, '0');
    const res = await postCode(get, wrong);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.token, undefined);
    assert.match(body.error, /not right/);

    assert.equal((await postCode(get, '12')).status, 401);
    assert.equal((await postCode(get, 'abcdef')).status, 401);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 14: the same code cannot be spent twice', async () => {
  const home = tempHome();
  const secret = generateSecret();
  await withServer({ home, otpSecret: secret }, async (get) => {
    const code = totp(secret);
    assert.equal((await postCode(get, code)).status, 200);
    const replay = await postCode(get, code);
    assert.equal(replay.status, 401);
    assert.match((await replay.json()).error, /already been used/);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 14: five wrong codes lock the exchange out for a minute', async () => {
  const home = tempHome();
  const secret = generateSecret();
  await withServer({ home, otpSecret: secret }, async (get) => {
    for (let i = 0; i < 5; i++) assert.equal((await postCode(get, '000000')).status, 401);
    // Even the right code is refused while the lockout holds.
    const res = await postCode(get, totp(secret));
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.ok(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 60);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 14: /api/auth/status says whether a code is needed, without needing one', async () => {
  const home = tempHome();
  const secret = generateSecret();
  await withServer({ home, otpSecret: secret }, async (get) => {
    const gated = await (await get('/api/auth/status')).json();
    assert.deepEqual(gated, { required: true, authenticated: false, digits: 6, periodSeconds: STEP_SECONDS });

    const token = (await (await postCode(get, totp(secret))).json()).token;
    const signedIn = await (await get('/api/auth/status', { headers: { 'X-Hub-Token': token } })).json();
    assert.equal(signedIn.authenticated, true);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 14: with no secret enrolled every /api/* route is open and the exchange is gone', async () => {
  const home = tempHome();
  await withServer({ home }, async (get) => {
    assert.equal((await get('/api/config')).status, 200);
    assert.equal((await get('/api/auth/otp', { method: 'POST', body: '{}' })).status, 404);
    assert.deepEqual(await (await get('/api/auth/status')).json(), { required: false, authenticated: true, digits: 6, periodSeconds: STEP_SECONDS });
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 2: PUT /api/config persists an added path and GET returns it', async () => {
  const home = tempHome();
  await withServer({ home }, async (get) => {
    const put = await get('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: [PROJ_A] }) });
    assert.equal(put.status, 200);
    const saved = await put.json();
    assert.deepEqual(saved.projects, [path.resolve(PROJ_A)]);
    assert.deepEqual((await (await get('/api/config')).json()).projects, [path.resolve(PROJ_A)]);
    assert.deepEqual(loadConfig(home).projects, [path.resolve(PROJ_A)]);

    const removed = await get('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: [] }) });
    assert.deepEqual((await removed.json()).projects, []);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 2: PUT /api/config rejects a non-existent path with the reason and saves nothing', async () => {
  const home = tempHome();
  await withServer({ home }, async (get) => {
    const res = await get('/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [path.join(FIXTURES, 'nowhere-at-all')] }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /does not exist/);
    assert.deepEqual(loadConfig(home).projects, []);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 4: GET /api/dashboard lists the folders and scans nothing', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A, path.join(FIXTURES, 'proj-empty')] }, home);
  await withServer({ home }, async (get) => {
    const model = await (await get('/api/dashboard')).json();
    assert.equal(model.projects.length, 2);
    assert.ok(model.projects.every((p) => typeof p.id === 'string' && typeof p.name === 'string'));
    // The expensive fields are gone on purpose: the dashboard must not walk
    // .work/ or read a transcript for a folder nobody has opened.
    assert.equal(model.today, undefined);
    assert.equal(model.projects[0].jobCount, undefined);
    assert.equal(model.projects[0].sessionCount, undefined);
    // AC 3: the folder with no .work/ is still listed, not an error.
    const empty = model.projects.find((p) => p.path.endsWith('proj-empty'));
    assert.equal(empty.hasWorkDir, false);
    assert.equal(empty.missing, false);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 4: GET /api/projects/:pid/jobs scans that one project on demand', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A, path.join(FIXTURES, 'proj-empty')] }, home);
  await withServer({ home }, async (get) => {
    const pid = encodeProjectId(path.resolve(PROJ_A));
    const model = await (await get(`/api/projects/${pid}/jobs`)).json();
    const all = model.today.concat(model.notStarted, model.others);
    assert.ok(all.length >= 1);
    assert.ok(all.every((j) => j.projectId === pid && typeof j.projectName === 'string'));
    assert.ok(model.unreadable.length >= 1);
    assert.equal(model.hasWorkDir, true);

    const emptyPid = encodeProjectId(path.resolve(path.join(FIXTURES, 'proj-empty')));
    const emptyModel = await (await get(`/api/projects/${emptyPid}/jobs`)).json();
    assert.deepEqual(emptyModel.today.concat(emptyModel.notStarted, emptyModel.others), []);
    assert.equal(emptyModel.hasWorkDir, false);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 4: a jobs scan for an unconfigured project id is 404', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A] }, home);
  await withServer({ home }, async (get) => {
    assert.equal((await get('/api/projects/D--not-configured/jobs')).status, 404);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 15: an unknown project id is 404, and a path in the URL is never accepted', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A] }, home);
  await withServer({ home }, async (get) => {
    assert.equal((await get('/api/projects/D--not-configured/sessions')).status, 404);
    assert.equal((await get('/api/projects/' + encodeURIComponent(PROJ_A) + '/sessions')).status, 404);
    assert.equal((await get('/api/projects/..%2f..%2fetc/sessions')).status, 404);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 15: the markdown route serves .md from the job folder only', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A] }, home);
  const pid = encodeProjectId(path.resolve(PROJ_A));
  await withServer({ home }, async (get) => {
    const ok = await get(`/api/projects/${pid}/jobs/2026-08-29-worked-today/md/PLAN.md`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /<strong>markdown<\/strong>/);

    // Not .md
    assert.equal((await get(`/api/projects/${pid}/jobs/2026-08-29-worked-today/md/progress.json`)).status, 400);
    // Separator surviving decode, in either segment
    assert.equal((await get(`/api/projects/${pid}/jobs/..%2f..%2f..%2fserve.mjs/md/PLAN.md`)).status, 400);
    assert.equal((await get(`/api/projects/${pid}/jobs/2026-08-29-worked-today/md/..%5c..%5cserve.mjs`)).status, 400);
    assert.equal((await get(`/api/projects/${pid}/jobs/../md/PLAN.md`)).status, 404);
    // A .md that is not there
    assert.equal((await get(`/api/projects/${pid}/jobs/2026-08-29-worked-today/md/NOPE.md`)).status, 404);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a run id that does not exist is 404', async () => {
  const home = tempHome();
  await withServer({ home }, async (get) => {
    assert.equal((await get('/api/runs/does-not-exist')).status, 404);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 11: the reply route validates before spawning - a bad model is 400', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A] }, home);
  const pid = encodeProjectId(path.resolve(PROJ_A));
  const sid = '0a690e2d-fb11-480b-b48a-ff6f44eff2e9';
  let spawned = 0;
  const runs = {
    startRun: (args) => {
      if (args.model !== 'claude-fable-5') return { ok: false, status: 400, error: 'bad model' };
      spawned++;
      return { ok: true, run: { runId: 'r1', state: 'running' } };
    },
    get: () => null,
  };
  await withServer({ home, runs }, async (get) => {
    const res = await get(`/api/projects/${pid}/sessions/${sid}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', model: 'gpt-4', effort: 'medium', permissionMode: 'default' }),
    });
    assert.equal(res.status, 400);
    assert.equal(spawned, 0);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a JSON body over 256 KB is refused with 413', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A] }, home);
  await withServer({ home }, async (get) => {
    const res = await get('/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [], note: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(res.status, 413);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('the resolve route writes the job workflow and enforces path safety', async () => {
  const home = tempHome();
  // A throwaway copy of a project, so the fixture tree is never rewritten.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-resolve-route-'));
  fs.mkdirSync(path.join(project, '.work', 'a-job'), { recursive: true });
  const file = path.join(project, '.work', 'a-job', 'progress.json');
  fs.writeFileSync(file, JSON.stringify({ status: 'built', workflow: [{ step: 'dev-start', status: 'done' }] }, null, 2));
  saveConfig({ projects: [project] }, home);
  const pid = encodeProjectId(path.resolve(project));

  await withServer({ home }, async (get) => {
    const res = await get(`/api/projects/${pid}/jobs/a-job/resolve`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).added, ['build', 'human-verification']);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after.workflow.map((s) => s.step), ['dev-start', 'build', 'human-verification']);
    assert.ok(after.workflow.every((s) => s.status === 'done'));
    assert.equal(after.status, 'built', 'the top-level status must not change');

    // GET does not write; a traversal segment and an unknown project are refused.
    assert.equal((await get(`/api/projects/${pid}/jobs/a-job/resolve`)).status, 404);
    assert.equal((await get(`/api/projects/${pid}/jobs/..%2f..%2fescape/resolve`, { method: 'POST' })).status, 400);
    assert.equal((await get(`/api/projects/D--not-configured/jobs/a-job/resolve`, { method: 'POST' })).status, 404);
    assert.equal((await get(`/api/projects/${pid}/jobs/no-such-job/resolve`, { method: 'POST' })).status, 404);
  });

  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// ── AC 8: /api/projects/:pid/git/* ───────────────────────────────────────────

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.local', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.local' };

/** A throwaway git repo (outside the work-hub tree) with one commit on main. */
function gitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-serve-git-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'commit.gpgsign', 'false']);
  run(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'first']);
  return dir;
}

test('AC 8: git routes sit behind the same pid guard as every other project route', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A] }, home);
  await withServer({ home }, async (get) => {
    for (const route of ['branches', 'status', 'commits?branch=main&skip=0']) {
      assert.equal((await get(`/api/projects/D--not-configured/git/${route}`)).status, 404);
    }
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 8: git routes sit behind the same OTP session gate as every other project route', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A] }, home);
  const pid = encodeProjectId(path.resolve(PROJ_A));
  await withServer({ home, otpSecret: generateSecret() }, async (get) => {
    assert.equal((await get(`/api/projects/${pid}/git/branches`)).status, 401);
    assert.equal((await get(`/api/projects/${pid}/git/status`)).status, 401);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 8: a real git repo answers branches, status, and commits over the route', async () => {
  const home = tempHome();
  const repo = gitFixture();
  saveConfig({ projects: [repo] }, home);
  const pid = encodeProjectId(path.resolve(repo));
  await withServer({ home }, async (get) => {
    const branches = await (await get(`/api/projects/${pid}/git/branches`)).json();
    assert.deepEqual(branches, { isRepo: true, current: 'main', branches: ['main'] });

    const status = await (await get(`/api/projects/${pid}/git/status`)).json();
    assert.deepEqual(status, { isRepo: true, staged: [], unstaged: [], untracked: [] });

    const commits = await (await get(`/api/projects/${pid}/git/commits?branch=main&skip=0`)).json();
    assert.equal(commits.commits.length, 1);
    assert.equal(commits.commits[0].subject, 'first');
    assert.equal(commits.hasMore, false);

    const sha = commits.commits[0].sha;
    const files = await (await get(`/api/projects/${pid}/git/commits/${sha}/files`)).json();
    assert.deepEqual(files.files.map((f) => f.path), ['a.txt']);

    const file = await (await get(`/api/projects/${pid}/git/commits/${sha}/file?path=a.txt`)).json();
    assert.equal(file.after, 'line1\n');
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('AC 8: a project folder that is not a git repository is a 200 with isRepo: false, not an error', async () => {
  const home = tempHome();
  // Outside the work-hub tree entirely - a folder under test/fixtures/ is still
  // inside this repo's own work tree, so `git rev-parse` there would say yes.
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-serve-notrepo-'));
  saveConfig({ projects: [notRepo] }, home);
  const pid = encodeProjectId(path.resolve(notRepo));
  await withServer({ home }, async (get) => {
    const res = await get(`/api/projects/${pid}/git/branches`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { isRepo: false });
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(notRepo, { recursive: true, force: true });
});

test('AC 8: a malformed sha is 400 and never reaches git', async () => {
  const home = tempHome();
  const repo = gitFixture();
  saveConfig({ projects: [repo] }, home);
  const pid = encodeProjectId(path.resolve(repo));
  await withServer({ home }, async (get) => {
    for (const bad of ['not-a-sha', '..%2f..%2fetc-passwd', '']) {
      assert.equal((await get(`/api/projects/${pid}/git/commits/${bad}/files`)).status, 400, bad);
      assert.equal((await get(`/api/projects/${pid}/git/commits/${bad}/file?path=a.txt`)).status, 400, bad);
    }
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('AC 8: an unknown branch and a bad skip are 400 before git runs', async () => {
  const home = tempHome();
  const repo = gitFixture();
  saveConfig({ projects: [repo] }, home);
  const pid = encodeProjectId(path.resolve(repo));
  await withServer({ home }, async (get) => {
    assert.equal((await get(`/api/projects/${pid}/git/commits?branch=no-such-branch&skip=0`)).status, 400);
    assert.equal((await get(`/api/projects/${pid}/git/commits?branch=main&skip=-1`)).status, 400);
    assert.equal((await get(`/api/projects/${pid}/git/commits?branch=main&skip=abc`)).status, 400);
    assert.equal((await get(`/api/projects/${pid}/git/commits?skip=0`)).status, 400, 'branch is required');
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('AC 8: a status/file path or area not reported by git status is 400', async () => {
  const home = tempHome();
  const repo = gitFixture();
  saveConfig({ projects: [repo] }, home);
  const pid = encodeProjectId(path.resolve(repo));
  await withServer({ home }, async (get) => {
    assert.equal((await get(`/api/projects/${pid}/git/status/file?path=nope.txt&area=untracked`)).status, 400);
    assert.equal((await get(`/api/projects/${pid}/git/status/file?path=a.txt&area=bogus`)).status, 400);
    assert.equal((await get(`/api/projects/${pid}/git/status/file?area=staged`)).status, 400, 'path is required');
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('AC 8: only GET is supported on the git routes', async () => {
  const home = tempHome();
  const repo = gitFixture();
  saveConfig({ projects: [repo] }, home);
  const pid = encodeProjectId(path.resolve(repo));
  await withServer({ home }, async (get) => {
    assert.equal((await get(`/api/projects/${pid}/git/branches`, { method: 'POST' })).status, 405);
    assert.equal((await get(`/api/projects/${pid}/git/status`, { method: 'POST' })).status, 405);
    assert.equal((await get(`/api/projects/${pid}/git/commits?branch=main&skip=0`, { method: 'POST' })).status, 405);
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});
