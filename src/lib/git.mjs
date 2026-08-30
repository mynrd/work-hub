// Read-only git inspection for one project folder: branches, commits, what a
// commit changed, and the current working tree - each as a small pure-ish
// function taking `projectPath`, the same shape as the other libs in this
// folder.
//
// Every git invocation goes through `runGit`/`readBlob`, both of which call
// `execFile('git', [...args], { cwd: projectPath })` - an argument array,
// never a shell string, never string interpolation into a command. The one
// thing every public function here validates before it lets a caller-supplied
// value near git: a branch name must already be one `listBranches` named, a
// sha must match `SHA_RE`, and a file path handed to `fileAtCommit`/
// `workingFile` must already appear in that commit's/working tree's own file
// list. Nothing free-form from the network reaches an argv slot.
//
// `-z` is used on every git command whose output includes a path, because a
// path can hold a space, a tab, or (for `%(refname)`-style formats it would
// otherwise need quoting for) almost anything else - NUL-separated output
// sidesteps quoting entirely.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// Generous: this only bounds one git invocation's output, and a repo with a
// huge diff or a very long branch list should still come back rather than
// throw ERR_CHILD_PROCESS_STDOUT_MAXBUFFER.
const MAX_BUFFER = 32 * 1024 * 1024;

const SHA_RE = /^[0-9a-f]{7,40}$/i;
// The sha `git hash-object -t tree /dev/null` always produces - the tree with
// no entries. Diffing a root commit against it is how you diff "nothing" vs
// "the commit's tree" with the same `git diff` call used for every other commit.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const ONE_MB = 1024 * 1024;
const BINARY_SCAN_BYTES = 8192;

// ── git invocation ───────────────────────────────────────────────────────────

/** Runs a git subcommand and returns its stdout as text. On failure, throws an
 *  Error whose message is what git said on stderr (or the raw failure when
 *  git printed nothing) - callers turn that into a 4xx/500. */
async function runGit(projectPath, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: projectPath, maxBuffer: MAX_BUFFER, encoding: 'utf8' });
    return stdout;
  } catch (err) {
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    throw new Error(stderr || err.message);
  }
}

/** Reads one blob with `git show <spec>` as raw bytes. A spec that does not
 *  resolve (an added file's "before", a deleted file's "after", no HEAD yet on
 *  a brand new repo, nothing staged at that path) comes back as an empty
 *  buffer rather than throwing - "missing side" is the expected outcome here,
 *  not an error. */
async function readBlob(projectPath, spec) {
  try {
    const { stdout } = await execFileAsync('git', ['show', spec], { cwd: projectPath, maxBuffer: MAX_BUFFER, encoding: 'buffer' });
    return stdout;
  } catch {
    return Buffer.alloc(0);
  }
}

async function isInsideWorkTree(projectPath) {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath, maxBuffer: MAX_BUFFER });
    return true;
  } catch {
    return false;
  }
}

// ── branches ──────────────────────────────────────────────────────────────

/**
 * `{ isRepo: false }` when `projectPath` is not inside a git work tree.
 * Otherwise `{ isRepo: true, current, branches }` - `current` is the checked
 * out branch's short name, or `'HEAD'` as-is when it is detached.
 */
export async function listBranches(projectPath) {
  if (!(await isInsideWorkTree(projectPath))) return { isRepo: false };

  const branchesOut = await runGit(projectPath, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']);
  const branches = branchesOut.split('\n').map((s) => s.trim()).filter(Boolean);

  const current = (await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

  return { isRepo: true, current, branches };
}

// ── commits ───────────────────────────────────────────────────────────────

const LOG_FORMAT = '%h\x1f%s\x1f%an\x1f%aI';

/**
 * Newest-first commits on `branch`, `skip` deep. `branch` must be one of
 * `listBranches(projectPath).branches` - never a caller-supplied string that
 * git has not already named itself. Fetches 51 and returns 50, so `hasMore`
 * tells the caller whether a 51st exists without a second round trip.
 */
export async function listCommits(projectPath, branch, skip) {
  if (!Number.isInteger(skip) || skip < 0) {
    throw new Error(`skip must be a non-negative integer, got ${JSON.stringify(skip)}`);
  }

  const { isRepo, branches } = await listBranches(projectPath);
  if (!isRepo) throw new Error('Not a git repository');
  if (typeof branch !== 'string' || !branches.includes(branch)) {
    throw new Error(`Unknown branch: ${JSON.stringify(branch)}`);
  }

  const out = await runGit(projectPath, ['log', branch, `--skip=${skip}`, '--max-count=51', `--format=${LOG_FORMAT}`]);
  const lines = out.split('\n').filter(Boolean);
  const hasMore = lines.length > 50;
  const commits = lines.slice(0, 50).map((line) => {
    const [sha, subject, author, date] = line.split('\x1f');
    return { sha, subject, author, date };
  });

  return { commits, hasMore };
}

// ── status/name-status -z parsing (shared by commitFiles and workingStatus) ──

/** A/M/D map to their plain-English word; R/C (whatever the similarity suffix
 *  is) become "renamed"; anything else is passed through as the raw letter. */
function mapStatusLetter(raw) {
  switch (raw[0]) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'renamed'; // treated the same as a rename for display
    default: return raw;
  }
}

/**
 * Parses `git diff --numstat -z -M`. Each entry is normally
 * `<added>\t<deleted>\t<path>\0`; when the diff detected a rename/copy the
 * path field is left empty and two more NUL-terminated tokens follow instead
 * (old path, then new path) - that is git's own -z rename encoding, not
 * something this parser invents.
 */
function parseNumstatZ(raw) {
  const tokens = raw.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();

  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.endsWith('\t')) {
      const [added, deleted] = token.split('\t');
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      entries.push({ added, deleted, path: newPath, oldPath });
    } else {
      const tab1 = token.indexOf('\t');
      const tab2 = token.indexOf('\t', tab1 + 1);
      entries.push({ added: token.slice(0, tab1), deleted: token.slice(tab1 + 1, tab2), path: token.slice(tab2 + 1) });
    }
  }
  return entries;
}

/**
 * Parses `git diff --name-status -z -M`. Each entry is `<status>\0<path>\0`,
 * except a rename/copy status, which is followed by two paths (old, then
 * new) instead of one.
 */
function parseNameStatusZ(raw) {
  const tokens = raw.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();

  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      entries.push({ status, path: newPath, oldPath });
    } else {
      const filePath = tokens[++i];
      entries.push({ status, path: filePath });
    }
  }
  return entries;
}

function numstatCount(raw) {
  return raw === '-' ? null : Number(raw);
}

// ── commit diffs ──────────────────────────────────────────────────────────

/** Resolves a validated sha to its full form and the sha/empty-tree to diff it
 *  against (its first parent, or the empty tree for a root commit). */
async function resolveCommitBase(projectPath, sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new Error(`Malformed commit sha: ${JSON.stringify(sha)}`);
  }
  const fullSha = (await runGit(projectPath, ['rev-parse', '--verify', `${sha}^{commit}`])).trim();

  let base = EMPTY_TREE;
  try {
    base = (await runGit(projectPath, ['rev-parse', '--verify', '--quiet', `${fullSha}^1`])).trim();
  } catch {
    // No first parent - a root commit. Diff against the empty tree instead.
  }

  return { fullSha, base };
}

async function diffCommit(projectPath, sha) {
  const { fullSha, base } = await resolveCommitBase(projectPath, sha);

  const [numstatOut, nameStatusOut] = await Promise.all([
    runGit(projectPath, ['diff', '--numstat', '-z', '-M', base, fullSha]),
    runGit(projectPath, ['diff', '--name-status', '-z', '-M', base, fullSha]),
  ]);

  const counts = parseNumstatZ(numstatOut);
  const statuses = parseNameStatusZ(nameStatusOut);

  const files = statuses.map((entry, i) => {
    const count = counts[i];
    const file = {
      path: entry.path,
      status: mapStatusLetter(entry.status),
      additions: count ? numstatCount(count.added) : null,
      deletions: count ? numstatCount(count.deleted) : null,
    };
    if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
    return file;
  });

  return { fullSha, base, files };
}

/**
 * The files changed by commit `sha` vs its first parent (or the empty tree
 * for a root commit): `{ files: [{ path, status, additions, deletions,
 * oldPath? }] }`. `status` is one of added|modified|deleted|renamed.
 * `additions`/`deletions` are `null` for a binary file (numstat reports `-`).
 */
export async function commitFiles(projectPath, sha) {
  const { files } = await diffCommit(projectPath, sha);
  return { files };
}

// ── blob comparison ─────────────────────────────────────────────────────────

/** NUL in the first 8k of either side means binary; either side over 1 MB
 *  means too large - in both cases the content is not sent, just the flag. */
function compareResult(filePath, beforeBuf, afterBuf) {
  const binary = beforeBuf.subarray(0, BINARY_SCAN_BYTES).includes(0) || afterBuf.subarray(0, BINARY_SCAN_BYTES).includes(0);
  const tooLarge = beforeBuf.length > ONE_MB || afterBuf.length > ONE_MB;
  const skip = binary || tooLarge;
  return {
    path: filePath,
    binary,
    tooLarge,
    before: skip ? '' : beforeBuf.toString('utf8'),
    after: skip ? '' : afterBuf.toString('utf8'),
  };
}

/**
 * The before/after content of one file changed by commit `sha`. `filePath`
 * must be a path `commitFiles(projectPath, sha)` actually reported for that
 * sha - a rename's "before" side reads its `oldPath`, an added file has no
 * "before", a deleted file has no "after". `{ path, binary, tooLarge, before,
 * after }`.
 */
export async function fileAtCommit(projectPath, sha, filePath) {
  const { fullSha, base, files } = await diffCommit(projectPath, sha);
  const entry = files.find((f) => f.path === filePath);
  if (!entry) throw new Error(`${JSON.stringify(filePath)} was not changed by commit ${sha}`);

  const beforePath = entry.oldPath ?? entry.path;
  const [beforeBuf, afterBuf] = await Promise.all([
    entry.status === 'added' ? Buffer.alloc(0) : readBlob(projectPath, `${base}:${beforePath}`),
    entry.status === 'deleted' ? Buffer.alloc(0) : readBlob(projectPath, `${fullSha}:${entry.path}`),
  ]);

  return compareResult(filePath, beforeBuf, afterBuf);
}

// ── working tree ─────────────────────────────────────────────────────────

/**
 * Parses `git status --porcelain=v1 -z`. Each entry is `XY <path>\0`, where X
 * is the index (staged) column and Y is the worktree (unstaged) column; a
 * rename/copy in either column (`R`/`C`) is followed by one more NUL-
 * terminated token, the original path.
 */
function parseStatusZ(raw) {
  const tokens = raw.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();

  const staged = [];
  const unstaged = [];
  const untracked = [];

  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    const indexStatus = code[0];
    const worktreeStatus = code[1];
    const filePath = code.slice(3);

    let oldPath;
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      oldPath = tokens[++i];
    }

    if (indexStatus === '?' && worktreeStatus === '?') {
      untracked.push(filePath);
      continue;
    }
    if (indexStatus !== ' ' && indexStatus !== '?') {
      const entry = { path: filePath, status: mapStatusLetter(indexStatus) };
      if (oldPath !== undefined) entry.oldPath = oldPath;
      staged.push(entry);
    }
    if (worktreeStatus !== ' ') {
      unstaged.push({ path: filePath, status: mapStatusLetter(worktreeStatus) });
    }
  }

  return { staged, unstaged, untracked };
}

/**
 * The working tree right now: `{ isRepo, staged: [{ path, status, oldPath? }],
 * unstaged: [{ path, status }], untracked: [paths] }`. `staged` is the index
 * vs HEAD, `unstaged` is the worktree vs the index.
 */
export async function workingStatus(projectPath) {
  if (!(await isInsideWorkTree(projectPath))) return { isRepo: false, staged: [], unstaged: [], untracked: [] };

  const out = await runGit(projectPath, ['status', '--porcelain=v1', '-z']);
  const { staged, unstaged, untracked } = parseStatusZ(out);
  return { isRepo: true, staged, unstaged, untracked };
}

/** Reads a worktree file relative to `projectPath`. A file that is not there
 *  (already deleted on disk) comes back as an empty buffer. */
async function readWorktreeFile(projectPath, filePath) {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${JSON.stringify(filePath)} escapes the project folder`);
  }
  try {
    return await fs.readFile(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  }
}

const WORKING_AREAS = ['staged', 'unstaged', 'untracked'];

/**
 * The before/after content of one file in the working tree. `filePath` must
 * already appear in the matching list of `workingStatus(projectPath)` for
 * `area` - a disk path git did not just report is never read.
 *   - `staged`:    before = HEAD:<oldPath|path>, after = the index (`:path`)
 *   - `unstaged`:  before = the index (`:path`),  after = the file on disk
 *   - `untracked`: before = '',                   after = the file on disk
 * `{ path, binary, tooLarge, before, after }`.
 */
export async function workingFile(projectPath, filePath, area) {
  if (!WORKING_AREAS.includes(area)) {
    throw new Error(`area must be one of ${WORKING_AREAS.join(', ')}, got ${JSON.stringify(area)}`);
  }

  const status = await workingStatus(projectPath);
  if (!status.isRepo) throw new Error('Not a git repository');

  if (area === 'untracked') {
    if (!status.untracked.includes(filePath)) throw new Error(`${JSON.stringify(filePath)} is not an untracked file`);
    const afterBuf = await readWorktreeFile(projectPath, filePath);
    return compareResult(filePath, Buffer.alloc(0), afterBuf);
  }

  if (area === 'staged') {
    const entry = status.staged.find((f) => f.path === filePath);
    if (!entry) throw new Error(`${JSON.stringify(filePath)} is not a staged change`);
    const beforePath = entry.oldPath ?? entry.path;
    const [beforeBuf, afterBuf] = await Promise.all([
      readBlob(projectPath, `HEAD:${beforePath}`),
      readBlob(projectPath, `:${filePath}`),
    ]);
    return compareResult(filePath, beforeBuf, afterBuf);
  }

  // unstaged
  const entry = status.unstaged.find((f) => f.path === filePath);
  if (!entry) throw new Error(`${JSON.stringify(filePath)} is not an unstaged change`);
  const [beforeBuf, afterBuf] = await Promise.all([
    readBlob(projectPath, `:${filePath}`),
    readWorktreeFile(projectPath, filePath),
  ]);
  return compareResult(filePath, beforeBuf, afterBuf);
}
