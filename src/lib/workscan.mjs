// Reads a project's `.work/` folder and produces the job list model for the
// dashboard. Ported from work-viewer's scan.mjs; the active/others split is
// replaced by the three-way today / not-yet-started / others grouping.
//
// `now` is an injectable parameter rather than an inline `Date.now()` so the
// "worked today" boundary and the activity badge window are testable.
//
// `progress.json` is treated as untrusted JSON of unknown shape everywhere in
// this file: every field is read with `?.`/`??`, nothing is validated against a
// fixed schema, and nothing throws on a shape that deviates from the canonical
// one. Real folders already carry `status` values outside the documented set and
// `workflow[]` steps outside the canonical four.

import fs from 'node:fs';
import path from 'node:path';

const PROGRESS_FILE = 'progress.json';
const WORK_DIR = '.work';

/**
 * Recursively finds the newest mtime (in epoch ms) among every file under
 * `dirPath`. Any per-entry stat/readdir failure is swallowed and simply does not
 * contribute to the max - a job folder should never fail to scan because one
 * file inside it is momentarily locked.
 */
function getNewestMtimeMs(dirPath) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return newest;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = getNewestMtimeMs(fullPath);
      if (sub > newest) newest = sub;
    } else {
      try {
        const st = fs.statSync(fullPath);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        // unreadable file - ignore for mtime purposes
      }
    }
  }

  return newest;
}

/**
 * The first workflow step that is neither "done" nor "skipped", or the step name
 * of the last entry when every entry is done/skipped.
 */
export function computeCurrentStep(workflow) {
  if (!Array.isArray(workflow) || workflow.length === 0) return null;

  for (const step of workflow) {
    const status = step && typeof step === 'object' ? step.status : undefined;
    if (status !== 'done' && status !== 'skipped') {
      return (step && typeof step === 'object' ? step.step : null) ?? null;
    }
  }

  const last = workflow[workflow.length - 1];
  return (last && typeof last === 'object' ? last.step : null) ?? null;
}

export function computeAcCounts(acceptanceCriteria) {
  const list = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  const acTotal = list.length;
  const acPass = list.filter((item) => item && item.status === 'pass').length;
  const acImplemented = list.filter((item) => item && item.status === 'implemented').length;
  return { acPass, acTotal, acImplemented };
}

/** `YYYY-M-D` in the machine's local timezone. Used only for same-day equality. */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** activeSession exists and its lastBeat is inside the window. Honoured when the
 *  field is present; nothing in this repo writes it. */
function isSessionActive(activeSession, now, windowMs) {
  if (!activeSession || typeof activeSession !== 'object') return false;
  const lastBeat = activeSession.lastBeat;
  if (typeof lastBeat !== 'string') return false;
  const parsed = Date.parse(lastBeat);
  if (Number.isNaN(parsed)) return false;
  return now - parsed < windowMs;
}

/**
 * The three-way group for one job.
 * - `today`: any file under the job folder was modified on the local day of `now`,
 *   regardless of status or workflow.
 * - `notStarted`: not worked today, the `build` step is `pending` (or there is no
 *   build step at all), and `runs[]` is empty.
 * - `others`: everything else.
 */
export function groupFor(progress, lastActivity, now) {
  if (lastActivity && localDay(lastActivity) === localDay(now)) return 'today';

  const workflow = Array.isArray(progress?.workflow) ? progress.workflow : [];
  const buildStep = workflow.find((s) => s && typeof s === 'object' && s.step === 'build');
  const runsLength = Array.isArray(progress?.runs) ? progress.runs.length : 0;
  const notStarted = (!buildStep || buildStep.status === 'pending') && runsLength === 0;

  return notStarted ? 'notStarted' : 'others';
}

/** The `.md` files directly inside a job folder, PLAN.md first. Never throws. */
export function listMarkdownFiles(folderPath) {
  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const mdFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name);

  mdFiles.sort((a, b) => {
    if (a === 'PLAN.md') return -1;
    if (b === 'PLAN.md') return 1;
    return a.localeCompare(b);
  });

  return mdFiles;
}

function buildJob(folder, folderPath, parsed, { now, windowMs }) {
  const workflow = Array.isArray(parsed.workflow) ? parsed.workflow : [];
  const { acPass, acTotal, acImplemented } = computeAcCounts(parsed.acceptanceCriteria);
  const lastActivity = getNewestMtimeMs(folderPath);

  const sessionActive = isSessionActive(parsed.activeSession, now, windowMs);
  const mtimeActive = lastActivity > now - windowMs;

  let activeReason = null;
  if (sessionActive) activeReason = 'session';
  else if (mtimeActive) activeReason = 'mtime';

  return {
    folder,
    // schemaVersion 3 calls it `id`; older folders written by the previous tool
    // call it `workItemId`. Both are read, neither is required.
    id: parsed.id ?? parsed.workItemId ?? null,
    title: parsed.title ?? null,
    type: parsed.type ?? null,
    status: parsed.status ?? null,
    slug: parsed.slug ?? null,
    acPass,
    acTotal,
    acImplemented,
    currentStep: computeCurrentStep(workflow),
    lastActivity,
    activeReason,
    active: sessionActive || mtimeActive,
    mdFiles: listMarkdownFiles(folderPath),
    progress: parsed,
  };
}

/**
 * Scans one project folder's `.work/` directory.
 *
 * A project with no `.work/` directory is not an error (AC 3): it comes back with
 * empty groups and `hasWorkDir: false`. A project path that does not exist at all
 * comes back with `missing: true` so the dashboard can mark it red.
 *
 * @param {string} projectPath - absolute path to the project folder (not `.work`).
 * @param {{ activeWindowMinutes?: number, now?: number }} [options]
 */
export function scanWorkFolder(projectPath, { activeWindowMinutes = 30, now = Date.now() } = {}) {
  const windowMs = activeWindowMinutes * 60 * 1000;
  const result = {
    projectPath,
    missing: false,
    hasWorkDir: false,
    today: [],
    notStarted: [],
    others: [],
    unreadable: [],
  };

  if (!fs.existsSync(projectPath)) {
    result.missing = true;
    return result;
  }

  const workRoot = path.join(projectPath, WORK_DIR);
  let entries;
  try {
    entries = fs.readdirSync(workRoot, { withFileTypes: true });
  } catch {
    // No .work/ (or it is unreadable) - zero jobs, no error. Conversations for
    // this project still work.
    return result;
  }
  result.hasWorkDir = true;

  for (const dirent of entries.filter((e) => e.isDirectory())) {
    const folder = dirent.name;
    const folderPath = path.join(workRoot, folder);
    const progressPath = path.join(folderPath, PROGRESS_FILE);

    let raw;
    try {
      raw = fs.readFileSync(progressPath, 'utf8');
    } catch (err) {
      const reason = err.code === 'ENOENT' ? 'no progress.json' : `cannot read progress.json: ${err.message}`;
      result.unreadable.push({ folder, reason });
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      result.unreadable.push({ folder, reason: `invalid JSON: ${err.message}` });
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      result.unreadable.push({ folder, reason: 'progress.json does not contain a JSON object' });
      continue;
    }

    const job = buildJob(folder, folderPath, parsed, { now, windowMs });
    result[groupFor(parsed, job.lastActivity, now)].push(job);
  }

  // readdirSync hands the folders back by name, which is oldest job first.
  // Newest activity first is what the tables want; equal mtimes fall back to
  // folder name descending so the order is deterministic.
  const byActivityDesc = (a, b) => (b.lastActivity - a.lastActivity) || b.folder.localeCompare(a.folder);
  for (const key of ['today', 'notStarted', 'others']) result[key].sort(byActivityDesc);

  return result;
}
