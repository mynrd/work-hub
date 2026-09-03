// AC 4, 5, 6: grouping given an injectable `now`, unknown-shape tolerance, and
// the AC-count rule. Everything runs against test/fixtures/, so the mtimes that
// decide "worked today" are set explicitly rather than left to whenever git
// happened to check the files out.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanWorkFolder, groupFor, computeAcCounts, computeCurrentStep, localDay, listMarkdownFiles } from '../src/lib/workscan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const PROJ_A = path.join(FIXTURES, 'proj-a');

const NOW = new Date('2026-08-29T12:00:00').getTime();
const LONG_AGO = new Date('2020-06-01T12:00:00').getTime();

/** Stamps every file under a job folder so the mtime walk is deterministic. */
function stampFolder(folder, ms) {
  const dir = path.join(PROJ_A, '.work', folder);
  const when = new Date(ms);
  for (const name of fs.readdirSync(dir)) {
    fs.utimesSync(path.join(dir, name), when, when);
  }
}

test.before(() => {
  stampFolder('2026-08-29-worked-today', NOW - 60 * 60 * 1000);
  stampFolder('2020-01-01-not-started', LONG_AGO);
  stampFolder('2020-02-02-others', LONG_AGO);
  stampFolder('2020-03-03-broken', LONG_AGO);
  stampFolder('2020-04-04-no-progress', LONG_AGO);
});

test('AC 4: a job touched on the local day of `now` lands in today', () => {
  const model = scanWorkFolder(PROJ_A, { now: NOW });
  assert.deepEqual(model.today.map((j) => j.folder), ['2026-08-29-worked-today']);
});

test('AC 4: build pending + no runs, not touched today, lands in notStarted', () => {
  const model = scanWorkFolder(PROJ_A, { now: NOW });
  assert.deepEqual(model.notStarted.map((j) => j.folder), ['2020-01-01-not-started']);
});

test('AC 4: everything else readable lands in others', () => {
  const model = scanWorkFolder(PROJ_A, { now: NOW });
  assert.deepEqual(model.others.map((j) => j.folder), ['2020-02-02-others']);
});

test('AC 4: worked-today wins over status and workflow', () => {
  // The same progress object that would otherwise be "notStarted".
  const progress = { workflow: [{ step: 'build', status: 'pending' }], runs: [] };
  assert.equal(groupFor(progress, NOW - 1000, NOW), 'today');
  assert.equal(groupFor(progress, LONG_AGO, NOW), 'notStarted');
});

test('AC 4: a job with no build step at all and no runs is notStarted', () => {
  assert.equal(groupFor({ workflow: [{ step: 'intake', status: 'done' }], runs: [] }, LONG_AGO, NOW), 'notStarted');
});

test('AC 4: a job with runs recorded is not notStarted even when build is pending', () => {
  assert.equal(groupFor({ workflow: [{ step: 'build', status: 'pending' }], runs: [{ round: 1 }] }, LONG_AGO, NOW), 'others');
});

test('AC 4: a folder without a parseable progress.json object is unreadable, with the reason', () => {
  const model = scanWorkFolder(PROJ_A, { now: NOW });
  const folders = model.unreadable.map((u) => u.folder).sort();
  assert.deepEqual(folders, ['2020-03-03-broken', '2020-04-04-no-progress']);
  const broken = model.unreadable.find((u) => u.folder === '2020-03-03-broken');
  assert.match(broken.reason, /invalid JSON/);
  const missing = model.unreadable.find((u) => u.folder === '2020-04-04-no-progress');
  assert.equal(missing.reason, 'no progress.json');
});

test('AC 4: a progress.json holding an array or a scalar is unreadable, not a job', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-scan-'));
  fs.mkdirSync(path.join(dir, '.work', 'array-job'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.work', 'array-job', 'progress.json'), '[1,2,3]');
  const model = scanWorkFolder(dir, { now: NOW });
  assert.equal(model.unreadable.length, 1);
  assert.match(model.unreadable[0].reason, /does not contain a JSON object/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A temp project holding `specs` as job folders, each stamped to its own mtime. */
function tempProject(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-sort-'));
  for (const { folder, progress, ms } of specs) {
    const jobDir = path.join(dir, '.work', folder);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'progress.json'), JSON.stringify(progress));
    fs.utimesSync(path.join(jobDir, 'progress.json'), new Date(ms), new Date(ms));
  }
  return dir;
}

const OTHERS_PROGRESS = { workflow: [{ step: 'build', status: 'done' }], runs: [{ round: 1 }] };
const NOT_STARTED_PROGRESS = { workflow: [{ step: 'build', status: 'pending' }], runs: [] };

test('sort: others come back newest activity first, not in folder-name order', () => {
  const dir = tempProject([
    { folder: '2020-01-01-oldest-name-middle-activity', progress: OTHERS_PROGRESS, ms: LONG_AGO + 2000 },
    { folder: '2020-02-02-middle-name-newest-activity', progress: OTHERS_PROGRESS, ms: LONG_AGO + 3000 },
    { folder: '2020-03-03-newest-name-oldest-activity', progress: OTHERS_PROGRESS, ms: LONG_AGO + 1000 },
  ]);
  const model = scanWorkFolder(dir, { now: NOW });
  assert.deepEqual(model.others.map((j) => j.folder), [
    '2020-02-02-middle-name-newest-activity',
    '2020-01-01-oldest-name-middle-activity',
    '2020-03-03-newest-name-oldest-activity',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sort: equal lastActivity falls back to folder name descending', () => {
  const dir = tempProject([
    { folder: '2020-01-01-a', progress: OTHERS_PROGRESS, ms: LONG_AGO },
    { folder: '2020-01-01-b', progress: OTHERS_PROGRESS, ms: LONG_AGO },
    { folder: '2020-01-01-c', progress: OTHERS_PROGRESS, ms: LONG_AGO },
  ]);
  const model = scanWorkFolder(dir, { now: NOW });
  assert.deepEqual(model.others.map((j) => j.folder), ['2020-01-01-c', '2020-01-01-b', '2020-01-01-a']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sort: today and notStarted are sorted the same way', () => {
  const dir = tempProject([
    { folder: '2026-08-29-today-earlier', progress: OTHERS_PROGRESS, ms: NOW - 3 * 60 * 60 * 1000 },
    { folder: '2026-08-29-today-later', progress: OTHERS_PROGRESS, ms: NOW - 60 * 60 * 1000 },
    { folder: '2020-01-01-ns-older', progress: NOT_STARTED_PROGRESS, ms: LONG_AGO },
    { folder: '2020-01-02-ns-newer', progress: NOT_STARTED_PROGRESS, ms: LONG_AGO + 5000 },
    { folder: '2020-01-03-ns-oldest', progress: NOT_STARTED_PROGRESS, ms: LONG_AGO - 5000 },
  ]);
  const model = scanWorkFolder(dir, { now: NOW });
  assert.deepEqual(model.today.map((j) => j.folder), ['2026-08-29-today-later', '2026-08-29-today-earlier']);
  assert.deepEqual(model.notStarted.map((j) => j.folder), ['2020-01-02-ns-newer', '2020-01-01-ns-older', '2020-01-03-ns-oldest']);
  assert.ok(model.others.length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 3: a project with no .work/ scans clean, with hasWorkDir false', () => {
  const model = scanWorkFolder(path.join(FIXTURES, 'proj-empty'), { now: NOW });
  assert.equal(model.missing, false);
  assert.equal(model.hasWorkDir, false);
  assert.deepEqual([model.today, model.notStarted, model.others, model.unreadable], [[], [], [], []]);
});

test('AC 3: a project path that does not exist is flagged missing, not thrown', () => {
  const model = scanWorkFolder(path.join(FIXTURES, 'no-such-folder-anywhere'), { now: NOW });
  assert.equal(model.missing, true);
});

test('AC 5: unknown status and workflow step values survive verbatim', () => {
  const model = scanWorkFolder(PROJ_A, { now: NOW });
  const job = model.others.find((j) => j.folder === '2020-02-02-others');
  assert.equal(job.status, 'some-status-nobody-documented');
  assert.equal(job.progress.workflow[2].step, 'a-step-that-does-not-exist');
});

test('AC 5: every field is optional - an empty object is still a job', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-scan-'));
  fs.mkdirSync(path.join(dir, '.work', 'bare'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.work', 'bare', 'progress.json'), '{}');
  const model = scanWorkFolder(dir, { now: NOW });
  const all = [...model.today, ...model.notStarted, ...model.others];
  assert.equal(all.length, 1);
  assert.equal(all[0].title, null);
  assert.equal(all[0].status, null);
  assert.equal(all[0].acTotal, 0);
  assert.equal(all[0].currentStep, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC 6: AC counts read pass / total, and implemented is counted separately', () => {
  const model = scanWorkFolder(PROJ_A, { now: NOW });
  const job = model.today[0];
  assert.equal(job.acPass, 1);
  assert.equal(job.acTotal, 3);
  assert.equal(job.acImplemented, 1);
});

test('AC 6: a non-array acceptanceCriteria counts as zero rather than throwing', () => {
  assert.deepEqual(computeAcCounts(undefined), { acPass: 0, acTotal: 0, acImplemented: 0 });
  assert.deepEqual(computeAcCounts('nope'), { acPass: 0, acTotal: 0, acImplemented: 0 });
  assert.deepEqual(computeAcCounts([null, { status: 'pass' }]), { acPass: 1, acTotal: 2, acImplemented: 0 });
});

test('currentStep is the first step that is neither done nor skipped', () => {
  assert.equal(computeCurrentStep([{ step: 'a', status: 'done' }, { step: 'b', status: 'pending' }]), 'b');
  assert.equal(computeCurrentStep([{ step: 'a', status: 'done' }, { step: 'b', status: 'skipped' }]), 'b');
  assert.equal(computeCurrentStep([]), null);
  assert.equal(computeCurrentStep('not an array'), null);
});

test('localDay compares by local calendar day, not by UTC', () => {
  const a = new Date(2026, 7, 29, 23, 30).getTime();
  const b = new Date(2026, 7, 29, 0, 30).getTime();
  const c = new Date(2026, 7, 30, 0, 30).getTime();
  assert.equal(localDay(a), localDay(b));
  assert.notEqual(localDay(a), localDay(c));
});

test('markdown files list PLAN.md first', () => {
  const files = listMarkdownFiles(path.join(PROJ_A, '.work', '2026-08-29-worked-today'));
  assert.deepEqual(files, ['PLAN.md', 'NOTES.md']);
});
