// AC 1, 2, 14, 15: arg parsing, config persistence and validation, the token
// gate, and path safety on the project id / job folder / markdown file segments.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, createServer } from './serve.mjs';
import { loadConfig, saveConfig, configPath, encodeProjectId, resolveProjectId, validateProjectPath, normalizeConfig } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'test-fixtures');
const PROJ_A = path.join(FIXTURES, 'proj-a');

// ── AC 1: arguments ──────────────────────────────────────────────────────────

test('AC 1: defaults are 127.0.0.1:8731', () => {
  assert.deepEqual(parseArgs([]), { port: 8731, host: '127.0.0.1', token: null, noToken: false, open: false });
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

test('AC 14: --no-token with a non-loopback host refuses, naming the reason', () => {
  assert.throws(() => parseArgs(['--lan', '--no-token']), /non-loopback bind requires a token/);
  assert.doesNotThrow(() => parseArgs(['--no-token']));
});

test('AC 14: a token shorter than 8 characters is refused', () => {
  assert.throws(() => parseArgs(['--token', 'short']), /--token/);
  assert.equal(parseArgs(['--token', 'long-enough-token']).token, 'long-enough-token');
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
    defaults: { model: 'claude-fable-5', effort: 'medium', permissionMode: 'default' },
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

  const file = validateProjectPath(path.join(__dirname, 'serve.mjs'));
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
  assert.equal(c.defaults.model, 'claude-fable-5');
  assert.equal(c.defaults.effort, 'medium');
  assert.equal(c.extra, undefined);
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

test('AC 14: with a token set, /api/* without the header is 401 but GET / still serves', async () => {
  const home = tempHome();
  await withServer({ home, token: 'a-secret-token' }, async (get) => {
    assert.equal((await get('/')).status, 200);
    assert.equal((await get('/api/config')).status, 401);
    assert.equal((await get('/api/dashboard')).status, 401);
    assert.equal((await get('/api/config', { headers: { 'X-Hub-Token': 'wrong-token-x' } })).status, 401);
    assert.equal((await get('/api/config', { headers: { 'X-Hub-Token': 'a-secret-token' } })).status, 200);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 14: with no token every /api/* route is open (loopback default)', async () => {
  const home = tempHome();
  await withServer({ home }, async (get) => {
    assert.equal((await get('/api/config')).status, 200);
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

test('AC 4: GET /api/dashboard groups jobs across configured projects', async () => {
  const home = tempHome();
  saveConfig({ projects: [PROJ_A, path.join(FIXTURES, 'proj-empty')] }, home);
  await withServer({ home }, async (get) => {
    const model = await (await get('/api/dashboard')).json();
    assert.equal(model.projects.length, 2);
    const all = model.today.concat(model.notStarted, model.others);
    assert.ok(all.every((j) => typeof j.projectId === 'string'));
    assert.ok(model.unreadable.length >= 1);
    // AC 3: the folder with no .work/ is listed with zero jobs, not an error.
    const empty = model.projects.find((p) => p.path.endsWith('proj-empty'));
    assert.equal(empty.jobCount, 0);
    assert.equal(empty.hasWorkDir, false);
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
