// AC 8, 9: read-only git inspection - branch/commit listing, a commit's
// changed files and blob content, and the working tree's staged/unstaged/
// untracked split, plus the validation every route in serve.mjs leans on
// (unknown branch, malformed sha, a path git never reported).
//
// Every fixture is a throwaway repo built with plain `git` calls in
// `test.before`/inline per test, never the fixture folders under
// test/fixtures/ (those are plain directories, not real git repos).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { listBranches, listCommits, commitFiles, fileAtCommit, workingStatus, workingFile } from '../src/lib/git.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@test.local',
  GIT_COMMITTER_NAME: 'Test Committer',
  GIT_COMMITTER_EMAIL: 'committer@test.local',
};

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
}

/** A fresh, empty repo: gpg signing off and no autocrlf mangling, so the bytes
 *  this test writes are the bytes git diffs and shows back. */
function freshRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-git-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

function write(dir, file, content) {
  fs.writeFileSync(path.join(dir, file), content);
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// ── A shared history repo for branch/commit/diff tests ──────────────────────
// Nothing here touches the working tree after `test.before`, so it is safe to
// share across the read-only tests below.

let hist;
let rootSha, secondSha, renameSha, binSha, featureSha;

test.before(() => {
  hist = freshRepo();

  write(hist, 'a.txt', 'line1\nline2\n');
  rootSha = commitAll(hist, 'root commit');

  write(hist, 'a.txt', 'line1\nline2\nline3\n');
  write(hist, 'b.txt', 'keep this file around\nline2\nline3\n');
  write(hist, 'todelete.txt', 'bye\n');
  secondSha = commitAll(hist, 'second commit');

  fs.unlinkSync(path.join(hist, 'todelete.txt'));
  fs.renameSync(path.join(hist, 'b.txt'), path.join(hist, 'c.txt'));
  fs.appendFileSync(path.join(hist, 'c.txt'), 'line4\n');
  renameSha = commitAll(hist, 'third commit: rename b to c, delete todelete');

  write(hist, 'bin.dat', Buffer.from([0, 1, 2, 3, 66, 105, 110, 97, 114, 121]));
  binSha = commitAll(hist, 'add a binary file');

  git(hist, ['branch', 'feature']);
  git(hist, ['checkout', '-q', 'feature']);
  write(hist, 'feature.txt', 'on a branch\n');
  featureSha = commitAll(hist, 'feature commit');
  git(hist, ['checkout', '-q', 'main']);
});

test.after(() => cleanup(hist));

// ── non-repo ──────────────────────────────────────────────────────────────

test('a folder that is not a git repository reports isRepo: false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-git-none-'));
  assert.deepEqual(await listBranches(dir), { isRepo: false });
  assert.equal((await workingStatus(dir)).isRepo, false);
  cleanup(dir);
});

// ── branches ──────────────────────────────────────────────────────────────

test('listBranches reports every local branch and the current one', async () => {
  const result = await listBranches(hist);
  assert.equal(result.isRepo, true);
  assert.equal(result.current, 'main');
  assert.deepEqual([...result.branches].sort(), ['feature', 'main']);
});

// ── commits ───────────────────────────────────────────────────────────────

test('listCommits lists newest first with sha, subject, author, date', async () => {
  const { commits, hasMore } = await listCommits(hist, 'main', 0);
  assert.equal(hasMore, false);
  assert.deepEqual(commits.map((c) => c.subject), [
    'add a binary file',
    'third commit: rename b to c, delete todelete',
    'second commit',
    'root commit',
  ]);
  assert.ok(commits.every((c) => /^[0-9a-f]{7,}$/.test(c.sha)));
  assert.ok(commits.every((c) => c.author === 'Test Author'));
  assert.ok(commits.every((c) => !Number.isNaN(Date.parse(c.date))));
});

test('listCommits skips the requested number of commits', async () => {
  const { commits } = await listCommits(hist, 'main', 1);
  assert.deepEqual(commits.map((c) => c.subject), [
    'third commit: rename b to c, delete todelete',
    'second commit',
    'root commit',
  ]);
});

test('listCommits caps at 50 and reports hasMore for a 51st', async () => {
  const many = freshRepo();
  for (let i = 0; i < 55; i++) {
    write(many, 'f.txt', `commit ${i}\n`);
    commitAll(many, `commit ${i}`);
  }
  const { commits, hasMore } = await listCommits(many, 'main', 0);
  assert.equal(commits.length, 50);
  assert.equal(hasMore, true);
  assert.equal(commits[0].subject, 'commit 54');
  assert.equal(commits[49].subject, 'commit 5');
  cleanup(many);
});

test('listCommits rejects a branch git has not already named', async () => {
  await assert.rejects(() => listCommits(hist, 'no-such-branch', 0), /Unknown branch/);
  await assert.rejects(() => listCommits(hist, 'main; rm -rf /', 0), /Unknown branch/);
});

test('listCommits rejects a negative or non-integer skip', async () => {
  await assert.rejects(() => listCommits(hist, 'main', -1), /non-negative integer/);
  await assert.rejects(() => listCommits(hist, 'main', 1.5), /non-negative integer/);
  await assert.rejects(() => listCommits(hist, 'main', NaN), /non-negative integer/);
});

// ── commitFiles ──────────────────────────────────────────────────────────

test('commitFiles reports added and modified files with numstat counts', async () => {
  const { files } = await commitFiles(hist, secondSha);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(byPath['a.txt'].status, 'modified');
  assert.equal(byPath['a.txt'].additions, 1);
  assert.equal(byPath['a.txt'].deletions, 0);
  assert.equal(byPath['b.txt'].status, 'added');
  assert.equal(byPath['b.txt'].additions, 3);
  assert.equal(byPath['todelete.txt'].status, 'added');
});

test('commitFiles reports a deleted file and detects the rename', async () => {
  const { files } = await commitFiles(hist, renameSha);
  const deleted = files.find((f) => f.path === 'todelete.txt');
  assert.equal(deleted.status, 'deleted');

  const renamed = files.find((f) => f.status === 'renamed');
  assert.ok(renamed, 'expected a renamed entry');
  assert.equal(renamed.path, 'c.txt');
  assert.equal(renamed.oldPath, 'b.txt');
});

test('commitFiles for the root commit diffs against the empty tree', async () => {
  const { files } = await commitFiles(hist, rootSha);
  assert.deepEqual(files.map((f) => f.path), ['a.txt']);
  assert.equal(files[0].status, 'added');
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 0);
});

test('commitFiles rejects a malformed sha', async () => {
  await assert.rejects(() => commitFiles(hist, 'not-a-sha'), /Malformed/);
  await assert.rejects(() => commitFiles(hist, ''), /Malformed/);
  await assert.rejects(() => commitFiles(hist, '../../etc/passwd'), /Malformed/);
});

test('commitFiles rejects a well-formed sha that does not exist', async () => {
  await assert.rejects(() => commitFiles(hist, 'deadbeef'));
});

// ── fileAtCommit ─────────────────────────────────────────────────────────

test('fileAtCommit returns before/after content for a modified file', async () => {
  const result = await fileAtCommit(hist, secondSha, 'a.txt');
  assert.equal(result.before, 'line1\nline2\n');
  assert.equal(result.after, 'line1\nline2\nline3\n');
  assert.equal(result.binary, false);
  assert.equal(result.tooLarge, false);
});

test('fileAtCommit for an added file has an empty before', async () => {
  const result = await fileAtCommit(hist, secondSha, 'b.txt');
  assert.equal(result.before, '');
  assert.equal(result.after, 'keep this file around\nline2\nline3\n');
});

test('fileAtCommit for a deleted file has an empty after', async () => {
  const result = await fileAtCommit(hist, renameSha, 'todelete.txt');
  assert.equal(result.before, 'bye\n');
  assert.equal(result.after, '');
});

test('fileAtCommit for a rename reads the old path for the before side', async () => {
  const result = await fileAtCommit(hist, renameSha, 'c.txt');
  assert.equal(result.before, 'keep this file around\nline2\nline3\n');
  assert.equal(result.after, 'keep this file around\nline2\nline3\nline4\n');
});

test('fileAtCommit detects a binary file and sends no content', async () => {
  const result = await fileAtCommit(hist, binSha, 'bin.dat');
  assert.equal(result.binary, true);
  assert.equal(result.before, '');
  assert.equal(result.after, '');
});

test('fileAtCommit rejects a path that commit did not change', async () => {
  await assert.rejects(() => fileAtCommit(hist, secondSha, 'nope.txt'), /was not changed/);
  await assert.rejects(() => fileAtCommit(hist, secondSha, 'feature.txt'), /was not changed/);
});

test('fileAtCommit rejects a malformed sha', async () => {
  await assert.rejects(() => fileAtCommit(hist, 'zz', 'a.txt'), /Malformed/);
});

// ── working tree ─────────────────────────────────────────────────────────
// Each of these mutates the working tree, so every one gets its own throwaway
// repo rather than sharing `hist`.

test('workingStatus on a clean tree returns empty arrays', async () => {
  const dir = freshRepo();
  write(dir, 's.txt', 'staged base\n');
  write(dir, 'u.txt', 'unstaged base\n');
  commitAll(dir, 'base');

  const status = await workingStatus(dir);
  assert.deepEqual(status, { isRepo: true, staged: [], unstaged: [], untracked: [] });
  cleanup(dir);
});

test('workingStatus splits staged, unstaged, and untracked changes', async () => {
  const dir = freshRepo();
  write(dir, 's.txt', 'staged base\n');
  write(dir, 'u.txt', 'unstaged base\n');
  commitAll(dir, 'base');

  write(dir, 's.txt', 'staged base\nplus a staged line\n');
  git(dir, ['add', 's.txt']);
  write(dir, 'u.txt', 'unstaged base\nplus an unstaged line\n');
  write(dir, 'new.txt', 'brand new\n');

  const status = await workingStatus(dir);
  assert.deepEqual(status.staged, [{ path: 's.txt', status: 'modified' }]);
  assert.deepEqual(status.unstaged, [{ path: 'u.txt', status: 'modified' }]);
  assert.deepEqual(status.untracked, ['new.txt']);
  cleanup(dir);
});

test('workingStatus reports a staged rename with its original path', async () => {
  const dir = freshRepo();
  write(dir, 'old.txt', 'same content\n');
  commitAll(dir, 'base');
  git(dir, ['mv', 'old.txt', 'renamed.txt']);

  const status = await workingStatus(dir);
  assert.deepEqual(status.staged, [{ path: 'renamed.txt', status: 'renamed', oldPath: 'old.txt' }]);
  cleanup(dir);
});

test('workingFile reads the staged before/after pair (HEAD vs the index)', async () => {
  const dir = freshRepo();
  write(dir, 's.txt', 'staged base\n');
  commitAll(dir, 'base');
  write(dir, 's.txt', 'staged base\nplus a staged line\n');
  git(dir, ['add', 's.txt']);

  const result = await workingFile(dir, 's.txt', 'staged');
  assert.equal(result.before, 'staged base\n');
  assert.equal(result.after, 'staged base\nplus a staged line\n');
  cleanup(dir);
});

test('workingFile reads the unstaged before/after pair (the index vs disk)', async () => {
  const dir = freshRepo();
  write(dir, 'u.txt', 'unstaged base\n');
  commitAll(dir, 'base');
  write(dir, 'u.txt', 'unstaged base\nplus an unstaged line\n');

  const result = await workingFile(dir, 'u.txt', 'unstaged');
  assert.equal(result.before, 'unstaged base\n');
  assert.equal(result.after, 'unstaged base\nplus an unstaged line\n');
  cleanup(dir);
});

test('workingFile reads an untracked file with an empty before', async () => {
  const dir = freshRepo();
  write(dir, 'base.txt', 'base\n');
  commitAll(dir, 'base');
  write(dir, 'new.txt', 'brand new\n');

  const result = await workingFile(dir, 'new.txt', 'untracked');
  assert.equal(result.before, '');
  assert.equal(result.after, 'brand new\n');
  cleanup(dir);
});

test('workingFile rejects a path git did not report for that area', async () => {
  const dir = freshRepo();
  write(dir, 'base.txt', 'base\n');
  commitAll(dir, 'base');
  write(dir, 'new.txt', 'brand new\n');

  await assert.rejects(() => workingFile(dir, 'nope.txt', 'untracked'), /is not an untracked file/);
  await assert.rejects(() => workingFile(dir, 'base.txt', 'staged'), /is not a staged change/);
  await assert.rejects(() => workingFile(dir, 'new.txt', 'bogus-area'), /area must be one of/);
  cleanup(dir);
});
