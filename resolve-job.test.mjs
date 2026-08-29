// Resolve: mark every workflow step done, adding `build` and
// `human-verification` when the job never had them.
//
// This is the only code path that writes into a monitored folder, so the tests
// care as much about what it leaves alone (every other field, the file's line
// endings) as about what it changes. Every case runs on a throwaway copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveWorkflow, isResolved, resolveJob, REQUIRED_STEPS } from './resolve-job.mjs';

/** A job folder in a temp project, written with the exact bytes given. */
function makeJob(raw, folder = 'a-job') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-resolve-'));
  fs.mkdirSync(path.join(dir, '.work', folder), { recursive: true });
  fs.writeFileSync(path.join(dir, '.work', folder, 'progress.json'), raw);
  return { projectPath: dir, folder, file: path.join(dir, '.work', folder, 'progress.json') };
}

const cleanup = (job) => fs.rmSync(job.projectPath, { recursive: true, force: true });

// ── The pure transform ───────────────────────────────────────────────────────

test('every step becomes done', () => {
  const out = resolveWorkflow([
    { step: 'intake', status: 'skipped' },
    { step: 'plan', status: 'done' },
    { step: 'build', status: 'pending' },
    { step: 'human-verification', status: 'pending' },
  ]);
  assert.deepEqual(out.map((s) => s.status), ['done', 'done', 'done', 'done']);
});

test('a missing build and human-verification are appended as done', () => {
  // The real shape that started this: a job using intake/plan/dev-start, with
  // no `build` step at all, which is why it was grouped as "not yet started".
  const out = resolveWorkflow([
    { step: 'intake', status: 'skipped', reason: 'intake skipped - /mynrd-plan invoked directly' },
    { step: 'plan', status: 'done', at: '2026-08-26T00:20:00+08:00' },
    { step: 'dev-start', status: 'done', at: '2026-08-26T00:00:00+08:00' },
  ]);
  assert.deepEqual(out.map((s) => s.step), ['intake', 'plan', 'dev-start', 'build', 'human-verification']);
  assert.ok(out.every((s) => s.status === 'done'));
});

test('existing step fields survive - only status is rewritten', () => {
  const out = resolveWorkflow([{ step: 'intake', status: 'skipped', reason: 'settled in conversation', at: '2026-08-26T00:20:00+08:00', extra: 1 }]);
  assert.deepEqual(out[0], { step: 'intake', status: 'done', reason: 'settled in conversation', at: '2026-08-26T00:20:00+08:00', extra: 1 });
});

test('an already-complete workflow is left as it is', () => {
  const before = [{ step: 'build', status: 'done' }, { step: 'human-verification', status: 'done' }];
  assert.deepEqual(resolveWorkflow(before), before);
});

test('a bare-string step is normalised, and a null entry is dropped', () => {
  const out = resolveWorkflow(['plan', null, undefined]);
  assert.deepEqual(out[0], { step: 'plan', status: 'done' });
  assert.equal(out.length, 3); // plan + the two required steps
});

test('a missing or non-array workflow produces just the required steps', () => {
  for (const input of [undefined, null, 'nope', {}]) {
    assert.deepEqual(resolveWorkflow(input).map((s) => s.step), REQUIRED_STEPS);
  }
});

test('resolveWorkflow does not mutate its input', () => {
  const before = [{ step: 'build', status: 'pending' }];
  resolveWorkflow(before);
  assert.equal(before[0].status, 'pending');
});

test('isResolved is true only when every step is done and both required steps exist', () => {
  assert.equal(isResolved([{ step: 'build', status: 'done' }, { step: 'human-verification', status: 'done' }]), true);
  assert.equal(isResolved([{ step: 'build', status: 'done' }]), false, 'human-verification missing');
  assert.equal(isResolved([{ step: 'build', status: 'pending' }, { step: 'human-verification', status: 'done' }]), false);
  assert.equal(isResolved([{ step: 'intake', status: 'skipped' }, { step: 'build', status: 'done' }, { step: 'human-verification', status: 'done' }]), false);
  assert.equal(isResolved([]), false);
  assert.equal(isResolved(undefined), false);
});

// ── The write ────────────────────────────────────────────────────────────────

test('resolveJob rewrites the workflow and reports which steps it added', () => {
  const job = makeJob(JSON.stringify({
    id: 32625,
    status: 'built',
    workflow: [{ step: 'plan', status: 'done' }, { step: 'dev-start', status: 'done' }],
  }, null, 2));

  const result = resolveJob(job.projectPath, job.folder);
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, ['build', 'human-verification']);

  const after = JSON.parse(fs.readFileSync(job.file, 'utf8'));
  assert.deepEqual(after.workflow.map((s) => s.step), ['plan', 'dev-start', 'build', 'human-verification']);
  assert.ok(after.workflow.every((s) => s.status === 'done'));
  cleanup(job);
});

test('nothing outside workflow is touched', () => {
  const original = {
    schemaVersion: 2,
    workItemId: 32625,
    title: 'Add a SQL-backed caching service',
    status: 'built',
    workflow: [{ step: 'plan', status: 'done' }],
    tasks: [{ id: 'T1', state: 'done' }],
    acceptanceCriteria: [{ id: 'AC1', status: 'implemented' }],
    runs: [],
    somethingNobodyDocumented: { nested: [1, 2, 3] },
  };
  const job = makeJob(JSON.stringify(original, null, 2));

  resolveJob(job.projectPath, job.folder);
  const after = JSON.parse(fs.readFileSync(job.file, 'utf8'));

  for (const key of Object.keys(original)) {
    if (key === 'workflow') continue;
    assert.deepEqual(after[key], original[key], `${key} must be untouched`);
  }
  // Key order is preserved too, so the repo diff stays small.
  assert.deepEqual(Object.keys(after), Object.keys(original));
  cleanup(job);
});

test('CRLF and a missing trailing newline are preserved', () => {
  // The shape of the real file this feature was built for.
  const raw = JSON.stringify({ workflow: [{ step: 'plan', status: 'done' }] }, null, 2).replace(/\n/g, '\r\n');
  assert.ok(!raw.endsWith('\n'));
  const job = makeJob(raw);

  resolveJob(job.projectPath, job.folder);
  const after = fs.readFileSync(job.file, 'utf8');
  assert.ok(after.includes('\r\n'), 'CRLF must survive');
  assert.ok(!/\n$/.test(after), 'a file with no trailing newline must not gain one');
  cleanup(job);
});

test('LF with a trailing newline is preserved too', () => {
  const raw = JSON.stringify({ workflow: [{ step: 'plan', status: 'done' }] }, null, 2) + '\n';
  const job = makeJob(raw);

  resolveJob(job.projectPath, job.folder);
  const after = fs.readFileSync(job.file, 'utf8');
  assert.ok(!after.includes('\r\n'), 'LF must not become CRLF');
  assert.ok(after.endsWith('\n'));
  cleanup(job);
});

test('resolving twice is safe and changes nothing the second time', () => {
  const job = makeJob(JSON.stringify({ workflow: [{ step: 'plan', status: 'done' }] }, null, 2));
  resolveJob(job.projectPath, job.folder);
  const first = fs.readFileSync(job.file, 'utf8');
  const second = resolveJob(job.projectPath, job.folder);
  assert.equal(second.ok, true);
  assert.deepEqual(second.added, []);
  assert.equal(fs.readFileSync(job.file, 'utf8'), first);
  cleanup(job);
});

test('an unparseable progress.json is refused, and the file is left alone', () => {
  const raw = '{ not json at all';
  const job = makeJob(raw);
  const result = resolveJob(job.projectPath, job.folder);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /not valid JSON/);
  assert.equal(fs.readFileSync(job.file, 'utf8'), raw, 'the file must be untouched');
  cleanup(job);
});

test('a progress.json holding an array is refused rather than rewritten', () => {
  const job = makeJob('[1,2,3]');
  const result = resolveJob(job.projectPath, job.folder);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(fs.readFileSync(job.file, 'utf8'), '[1,2,3]');
  cleanup(job);
});

test('a job folder that does not exist is a 404', () => {
  const job = makeJob('{}');
  const result = resolveJob(job.projectPath, 'no-such-job');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  cleanup(job);
});

test('a folder segment that escapes .work is refused', () => {
  const job = makeJob('{}');
  for (const bad of ['..', path.join('..', '..'), '.']) {
    const result = resolveJob(job.projectPath, bad);
    assert.equal(result.ok, false, `${bad} must be refused`);
    assert.equal(result.status, 400);
  }
  cleanup(job);
});

test('no temp file is left behind', () => {
  const job = makeJob(JSON.stringify({ workflow: [] }, null, 2));
  resolveJob(job.projectPath, job.folder);
  const entries = fs.readdirSync(path.join(job.projectPath, '.work', job.folder));
  assert.deepEqual(entries, ['progress.json']);
  cleanup(job);
});
