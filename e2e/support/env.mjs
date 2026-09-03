// Builds the throwaway world the e2e server runs against: a temp HOME holding
// its own config.json, its own copy of the .work fixtures, and its own Claude
// transcript folder.
//
// Nothing here reads or writes the real ~/.work-hub or ~/.claude. That is the
// point: the suite must be safe to run on the machine you actually work on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { configDir } from '../../src/lib/config.mjs';

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

/** Added by this harness: build done, human-verification in_progress - the one
 *  state that renders the Verified button. Backdated into "Others". */
export const AWAITING_VERIFY_JOB = {
  folder: '2020-06-06-awaiting-verify',
  title: 'Green and awaiting verification',
  progress: {
    schemaVersion: 3,
    id: '2020-06-06-awaiting-verify',
    title: 'Green and awaiting verification',
    type: 'task',
    status: 'green',
    workflow: [
      { step: 'intake', status: 'done' },
      { step: 'plan', status: 'done' },
      { step: 'build', status: 'done' },
      { step: 'human-verification', status: 'in_progress', startedAt: '2020-06-06T10:00:00+08:00' },
    ],
    acceptanceCriteria: [{ id: 1, text: 'It is green', status: 'pass' }],
    humanVerification: { unlocked: true, unlockedAt: '2020-06-06T10:00:00+08:00' },
    runs: [],
  },
};

export const PORTS = { open: 5178, gated: 5179, control: 5180 };

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function git(dir, args) {
  execFileSync('git', args, {
    cwd: dir,
    env: Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 'Work Hub Fixture', GIT_AUTHOR_EMAIL: 'fixture@work-hub.test',
      GIT_COMMITTER_NAME: 'Work Hub Fixture', GIT_COMMITTER_EMAIL: 'fixture@work-hub.test',
    }),
    stdio: 'ignore',
  });
}

/**
 * Turns `dir` into a small real git repo for the Branch and Commits tab: two
 * commits on `main`, a second branch (`feature-branch`) pointing at the first
 * one, and uncommitted changes covering all three Current changes groups -
 * a staged edit, an unstaged edit, and an untracked file.
 */
function seedGitRepo(dir) {
  fs.writeFileSync(path.join(dir, 'README.md'), '# proj-a\n\nFixture project for the work-hub e2e suite.\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n- Initial version\n');

  git(dir, ['init']);
  // Not --initial-branch=main: that flag needs git >= 2.28. Pointing HEAD at
  // refs/heads/main before the first commit works on any git version.
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'Initial import of the fixture project']);

  fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '- Second entry\n');
  git(dir, ['add', 'CHANGELOG.md']);
  git(dir, ['commit', '-m', 'Add a changelog entry']);

  git(dir, ['branch', 'feature-branch']);

  fs.appendFileSync(path.join(dir, 'README.md'), '\nStaged edit.\n');
  git(dir, ['add', 'README.md']);

  fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '- Unstaged entry\n');

  fs.writeFileSync(path.join(dir, 'untracked-note.txt'), 'not committed\n');
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
  // The Others order assertion needs distinct mtimes, so this one is stamped too.
  touchTree(path.join(projA, '.work', '2020-02-02-others'), new Date('2020-02-02T00:00:00Z'));

  const resolved = path.join(projA, '.work', RESOLVED_JOB.folder);
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, 'progress.json'), JSON.stringify(RESOLVED_JOB.progress, null, 2));
  // Written just now, so without this it would land in "Worked today" beside the
  // one job that is supposed to be there. Backdate it into "Others".
  touchTree(resolved, new Date('2020-05-05T00:00:00Z'));

  const awaiting = path.join(projA, '.work', AWAITING_VERIFY_JOB.folder);
  fs.mkdirSync(awaiting, { recursive: true });
  fs.writeFileSync(path.join(awaiting, 'progress.json'), JSON.stringify(AWAITING_VERIFY_JOB.progress, null, 2));
  touchTree(awaiting, new Date('2020-06-06T00:00:00Z'));

  seedGitRepo(projA);

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

/**
 * The shell-host daemon (src/shell-host.mjs) is a detached process, spawned
 * on first Terminal use by whichever server's shell-client needed it - see
 * the HOME/USERPROFILE override in start-server.mjs for why it lands in this
 * temp home's `.work-hub/shell-host.json` instead of the real one. A leaked
 * daemon holds real pwsh processes open on the machine running the suite, so
 * it is killed - tree and all, tolerating "already gone" - before the temp
 * home it lives under is removed.
 */
function stopShellHost(home) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(configDir(home), 'shell-host.json'), 'utf8'));
  } catch {
    return; // no daemon was ever spawned into this home
  }
  if (!info || !info.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(info.pid, 'SIGKILL');
    }
  } catch {
    /* already exited - fine */
  }
}

export function cleanTestEnv(env) {
  stopShellHost(env.home);
  fs.rmSync(env.home, { recursive: true, force: true });
}
