// The one place Work Hub writes into a monitored folder.
//
// Everything else in this tool is read-only over your `.work/` trees - see the
// route table in README.md. "Resolve" is the deliberate exception: it marks a
// job's workflow finished in that job's own `progress.json`, because the
// dashboard's grouping reads the workflow and there is nowhere else that a
// correction could live and still be seen by the rest of your workflow tooling.
//
// What it does, exactly:
//   - every entry in `workflow[]` gets `status: "done"`
//   - a `build` step is appended if there is none
//   - a `human-verification` step is appended if there is none
// Nothing else in the file is touched: `status`, `tasks`, `acceptanceCriteria`,
// `runs` and every unknown field are left exactly as they were.
//
// The rewrite is format-preserving. Real folders on this machine carry CRLF
// with no trailing newline, and a naive `JSON.stringify(x, null, 2)` would
// rewrite all 200-odd lines and bury the actual change in the repo's diff. The
// original line ending and trailing-newline style are detected and restored.

import fs from 'node:fs';
import path from 'node:path';

/** Steps the dashboard's grouping looks for, appended when a job has neither. */
export const REQUIRED_STEPS = ['build', 'human-verification'];

/**
 * Returns the workflow array with every step done and the required steps present.
 * Pure - it does not mutate the array it is given.
 *
 * A workflow entry that is a bare string (some folders carry that) is normalised
 * into `{ step, status }`; a null entry is dropped rather than written back as
 * `{ step: "null" }`.
 */
export function resolveWorkflow(workflow) {
  const source = Array.isArray(workflow) ? workflow : [];
  const list = [];

  for (const entry of source) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'object') {
      // Spread first so `status` overrides whatever was there while every other
      // field the job carries - `at`, `reason`, anything unknown - survives.
      list.push({ ...entry, status: 'done' });
    } else {
      list.push({ step: String(entry), status: 'done' });
    }
  }

  for (const step of REQUIRED_STEPS) {
    if (!list.some((s) => s.step === step)) list.push({ step, status: 'done' });
  }

  return list;
}

/** True when the workflow already satisfies what resolveWorkflow would produce. */
export function isResolved(workflow) {
  const list = Array.isArray(workflow) ? workflow.filter((s) => s !== null && s !== undefined) : [];
  if (list.length === 0) return false;
  const allDone = list.every((s) => (typeof s === 'object' ? s.status === 'done' : false));
  const hasRequired = REQUIRED_STEPS.every((step) => list.some((s) => typeof s === 'object' && s.step === step));
  return allDone && hasRequired;
}

/** Detects the byte-level style of the file so the rewrite can restore it. */
function detectStyle(raw) {
  return {
    crlf: raw.includes('\r\n'),
    trailingNewline: /\n\r?$/.test(raw) || raw.endsWith('\n'),
  };
}

function applyStyle(text, style) {
  let out = text.replace(/\r?\n/g, style.crlf ? '\r\n' : '\n');
  if (style.trailingNewline) out += style.crlf ? '\r\n' : '\n';
  return out;
}

/**
 * Marks one job's workflow resolved on disk.
 *
 * @param {string} projectPath - the monitored folder (not `.work`).
 * @param {string} folder - the job folder name, already checked for separators.
 * @returns {{ ok: true, workflow: object[], added: string[] } | { ok: false, status: number, error: string }}
 */
export function resolveJob(projectPath, folder) {
  const workRoot = path.resolve(projectPath, '.work');
  const folderPath = path.resolve(workRoot, folder);
  // Belt and braces: serve.mjs already rejects a segment holding a separator,
  // but this function writes, so it re-checks rather than trusting its caller.
  if (!folderPath.startsWith(workRoot + path.sep)) {
    return { ok: false, status: 400, error: 'Resolved path escapes the .work root' };
  }

  const file = path.join(folderPath, 'progress.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, status: 404, error: `Cannot read ${folder}/progress.json: ${err.code ?? err.message}` };
  }

  let progress;
  try {
    progress = JSON.parse(raw);
  } catch (err) {
    return { ok: false, status: 409, error: `${folder}/progress.json is not valid JSON, so it will not be rewritten: ${err.message}` };
  }
  if (progress === null || typeof progress !== 'object' || Array.isArray(progress)) {
    return { ok: false, status: 409, error: `${folder}/progress.json does not contain a JSON object, so it will not be rewritten.` };
  }

  const before = Array.isArray(progress.workflow) ? progress.workflow : [];
  const added = REQUIRED_STEPS.filter(
    (step) => !before.some((s) => s && typeof s === 'object' && s.step === step),
  );
  progress.workflow = resolveWorkflow(before);

  const style = detectStyle(raw);
  const body = applyStyle(JSON.stringify(progress, null, 2), style);

  // Temp file + rename, so a crash mid-write leaves the old file or the new
  // one - never a half-written progress.json in someone's repo.
  const tmp = path.join(folderPath, `progress.json.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return { ok: false, status: 500, error: `Cannot write ${folder}/progress.json: ${err.message}` };
  }

  return { ok: true, workflow: progress.workflow, added };
}
