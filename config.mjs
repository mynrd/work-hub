// Reads and writes ~/.work-hub/config.json - the only file this tool ever writes
// outside of whatever `claude` itself writes.
//
// The config is user-scoped, not per repo: Work Hub monitors several unrelated
// project folders at once, so there is no repo to hang a config file off. Every
// field is read defensively - a hand-edited config with a missing key, a wrong
// type, or a stray extra key must not stop the server from starting.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MODELS = ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

const DEFAULTS = {
  projects: [],
  usageIntervalMinutes: 5,
  defaults: { model: 'claude-fable-5', effort: 'medium', permissionMode: 'default' },
};

export function configDir(home = os.homedir()) {
  return path.join(home, '.work-hub');
}

export function configPath(home = os.homedir()) {
  return path.join(configDir(home), 'config.json');
}

/** A configured path's stable, URL-safe id. Same encoding Claude Code uses for its
 *  transcript folder names, which is why transcripts.mjs can reuse it directly. */
export function encodeProjectId(projectPath) {
  return String(projectPath).replace(/[^A-Za-z0-9]/g, '-');
}

function normalizeProjects(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function normalizeDefaults(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    model: MODELS.includes(src.model) ? src.model : DEFAULTS.defaults.model,
    effort: EFFORTS.includes(src.effort) ? src.effort : DEFAULTS.defaults.effort,
    permissionMode: PERMISSION_MODES.includes(src.permissionMode) ? src.permissionMode : DEFAULTS.defaults.permissionMode,
  };
}

function normalizeInterval(value) {
  const n = Number(value);
  // 0 means "manual refresh only"; anything unparseable or negative falls back to
  // the default rather than disabling the timer silently.
  if (!Number.isFinite(n) || n < 0) return DEFAULTS.usageIntervalMinutes;
  return Math.floor(n);
}

/** Coerces any parsed JSON into the config shape. Never throws. */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    projects: normalizeProjects(src.projects),
    usageIntervalMinutes: normalizeInterval(src.usageIntervalMinutes),
    defaults: normalizeDefaults(src.defaults),
  };
}

/**
 * Loads the config. A missing file yields the defaults; an unreadable or invalid
 * file yields the defaults plus `loadError` so the UI can say why the user's
 * projects vanished instead of pretending the list was always empty.
 */
export function loadConfig(home = os.homedir()) {
  const file = configPath(home);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return normalizeConfig(null);
    return { ...normalizeConfig(null), loadError: `cannot read ${file}: ${err.message}` };
  }
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch (err) {
    return { ...normalizeConfig(null), loadError: `invalid JSON in ${file}: ${err.message}` };
  }
}

/**
 * Writes the config atomically - a temp file in the same directory, then a rename.
 * A crash mid-write can therefore leave the old file or the new one, never a
 * truncated one. Returns the normalized config that was written.
 */
export function saveConfig(config, home = os.homedir()) {
  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const normalized = normalizeConfig(config);
  const file = configPath(home);
  const tmp = path.join(dir, `config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return normalized;
}

/**
 * Validates a candidate project path for AC 2. Returns `{ ok, path }` or
 * `{ ok: false, error }` with the reason spelled out - "refused with the reason"
 * is the AC, so no generic "invalid path" here.
 */
export function validateProjectPath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'Path is required.' };
  }
  const resolved = path.resolve(input.trim());
  let st;
  try {
    st = fs.statSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, error: `${resolved} does not exist.` };
    return { ok: false, error: `${resolved} cannot be read: ${err.code ?? err.message}` };
  }
  if (!st.isDirectory()) return { ok: false, error: `${resolved} is a file, not a folder.` };
  return { ok: true, path: resolved };
}

/** Resolves a project id from a URL back to a configured absolute path, or null.
 *  A path is never accepted from the URL - only an id that is already in config. */
export function resolveProjectId(config, id) {
  if (typeof id !== 'string' || !id) return null;
  const list = Array.isArray(config?.projects) ? config.projects : [];
  for (const p of list) {
    if (encodeProjectId(p) === id) return p;
  }
  return null;
}
