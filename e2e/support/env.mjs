// Builds the throwaway world the e2e server runs against: a temp HOME holding
// its own config.json, its own copy of the .work fixtures, and its own Claude
// transcript folder.
//
// Nothing here reads or writes the real ~/.work-hub or ~/.claude. That is the
// point: the suite must be safe to run on the machine you actually work on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeProjectFolder } from '../../src/lib/transcripts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures');

/** Base32, test-only. The gated server is enrolled with this so a spec can
 *  compute a live code instead of typing one. Never used outside the suite. */
export const OTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export const FIXTURE_SESSION_ID = '11111111-2222-3333-4444-555555555555';

/** The job in proj-a whose folder gets touched to now, so it lands in "Worked today". */
const TODAY_JOB = '2026-08-29-worked-today';

/** Added by this harness, not by test/fixtures: every workflow step already done,
 *  which is the only state that renders Resolve as a disabled "Resolved". */
export const RESOLVED_JOB = {
  folder: '2020-05-05-already-resolved',
  title: 'Already fully resolved',
  progress: {
    schemaVersion: 3,
    id: '2020-05-05-already-resolved',
    title: 'Already fully resolved',
    type: 'task',
    status: 'done',
    workflow: [
      { step: 'intake', status: 'done' },
      { step: 'plan', status: 'done' },
      { step: 'build', status: 'done' },
      { step: 'human-verification', status: 'done' },
    ],
    acceptanceCriteria: [{ id: 'AC1', text: 'Signed off', status: 'pass', evidence: 'by hand' }],
    runs: [],
  },
};

export const PORTS = { open: 5178, gated: 5179 };

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** Every file under `dir`, recursively, stamped to `when`. */
function touchTree(dir, when) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) touchTree(p, when);
    else fs.utimesSync(p, when, when);
  }
  fs.utimesSync(dir, when, when);
}

/**
 * Creates the temp home and returns what the specs need to address it.
 *
 * The "worked today" fixture is grouped by mtime, and git checkout leaves that
 * at whenever the clone happened. Stamping it to now is what makes the grouping
 * assertion deterministic instead of true only on the day you cloned.
 */
export function buildTestEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-e2e-'));

  const projA = path.join(home, 'projects', 'proj-a');
  copyDir(path.join(FIXTURES, 'proj-a'), projA);
  touchTree(path.join(projA, '.work', TODAY_JOB), new Date());

  const resolved = path.join(projA, '.work', RESOLVED_JOB.folder);
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, 'progress.json'), JSON.stringify(RESOLVED_JOB.progress, null, 2));
  // Written just now, so without this it would land in "Worked today" beside the
  // one job that is supposed to be there. Backdate it into "Others".
  touchTree(resolved, new Date('2020-05-05T00:00:00Z'));

  const projEmpty = path.join(home, 'projects', 'proj-empty');
  fs.mkdirSync(projEmpty, { recursive: true });

  /* Nothing missing is seeded. A configured folder that does not exist blocks
     every other config write, so the "folder is missing" state is created and
     torn down inside the one spec that needs it - see settings.spec.mjs. */

  fs.mkdirSync(path.join(home, '.work-hub'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.work-hub', 'config.json'),
    JSON.stringify({
      projects: [projA, projEmpty],
      usageIntervalMinutes: 0, // manual only - no timer firing under the tests
      defaults: { model: 'opus', effort: 'high', permissionMode: 'default' },
    }, null, 2),
  );

  // One transcript, for proj-a only, so the conversation page has real records
  // to render and proj-empty has the "no conversations yet" state.
  const transcriptDir = path.join(home, '.claude', 'projects', encodeProjectFolder(projA));
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES, 'transcripts', 'session-sample.jsonl'),
    path.join(transcriptDir, FIXTURE_SESSION_ID + '.jsonl'),
  );

  return { home, projA, projEmpty };
}

export function cleanTestEnv(env) {
  fs.rmSync(env.home, { recursive: true, force: true });
}
