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

// Offered in the UI. `claude --model` resolves an alias to that family's newest
// model when it spawns, so this list does not go stale when a new version ships -
// at the cost of not knowing which version ran until the transcript names it.
export const MODELS = ['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'fable[1m]'];
// What validation accepts. Wider than MODELS so a config pinned to an exact
// version keeps working. This is an allowlist, not a hint: it is the only thing
// stopping a model string from carrying extra argv into the spawn.
export const ALLOWED_MODELS = [
  ...MODELS,
  'claude-opus-5', 'claude-opus-5[1m]',
  'claude-sonnet-5', 'claude-sonnet-5[1m]',
  'claude-haiku-4-5-20251001',
  'claude-fable-5', 'claude-fable-5[1m]',
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

const DEFAULTS = {
  projects: [],
  favorites: [],
  projectNames: {},
  usageIntervalMinutes: 5,
  defaults: { model: 'opus', effort: 'high', permissionMode: 'default' },
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

/** Favourites are paths, not ids, so they survive the id encoding changing. One
 *  that is no longer a monitored folder is dropped rather than kept as a ghost. */
function normalizeFavorites(value, projects) {
  const known = new Map(projects.map((p) => [p.toLowerCase(), p]));
  const seen = new Set();
  const out = [];
  for (const entry of normalizeProjects(value)) {
    const key = entry.toLowerCase();
    const hit = known.get(key);
    if (!hit || seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** A custom display name per project, keyed by the project's resolved path so it
 *  survives id encoding changing. A key that no longer names a monitored folder,
 *  or a name that is not a non-empty string once trimmed, is dropped rather than
 *  kept as a ghost - mirrors `normalizeFavorites` above, but as a map. */
function normalizeProjectNames(value, projects) {
  const known = new Map(projects.map((p) => [p.toLowerCase(), p]));
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [rawKey, rawName] of Object.entries(src)) {
    const hit = known.get(path.resolve(rawKey).toLowerCase());
    if (!hit) continue;
    if (typeof rawName !== 'string') continue;
    const name = rawName.trim();
    if (!name) continue;
    out[hit] = name;
  }
  return out;
}

function normalizeDefaults(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    model: ALLOWED_MODELS.includes(src.model) ? src.model : DEFAULTS.defaults.model,
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
  const projects = normalizeProjects(src.projects);
  return {
    projects,
    favorites: normalizeFavorites(src.favorites, projects),
    projectNames: normalizeProjectNames(src.projectNames, projects),
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
