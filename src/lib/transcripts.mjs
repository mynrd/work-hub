// Reads Claude Code's own transcripts for a monitored project folder.
//
// Claude Code stores one `.jsonl` per session under
// `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, where the folder name is
// the session's `cwd` with every character outside `[A-Za-z0-9]` replaced by `-`.
// Windows may create that folder with either drive-letter case (`d--Work…` vs
// `D--Work…`) and the filesystem treats the two as one folder, so the lookup
// matches case-insensitively.
//
// Ported from claude-usage/src/services/projects.js (getSessionChat,
// contextEventPart, reorderToolResults) plus the string-wrapper handling from
// chat-viewer.js, trimmed to what this dashboard renders. The one rule carried
// over verbatim from claude-usage/CLAUDE.md: a record shape the parser does not
// recognise is emitted as a collapsed raw-JSON part, never dropped. Claude Code
// changes these shapes between versions; a denylist would silently lose turns.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE_WINDOW_MS = 45 * 1000;

export function claudeProjectsDir(home = os.homedir()) {
  return path.join(home, '.claude', 'projects');
}

/** The transcript folder name Claude Code uses for a given working directory. */
export function encodeProjectFolder(projectPath) {
  return String(projectPath).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The real transcript directory for a project path, or null when Claude Code has
 * never run there. Matched case-insensitively against what is actually on disk.
 */
export function resolveTranscriptDir(projectPath, home = os.homedir()) {
  const root = claudeProjectsDir(home);
  const wanted = encodeProjectFolder(path.resolve(projectPath)).toLowerCase();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.toLowerCase() === wanted) return path.join(root, entry.name);
  }
  return null;
}

/** Every subagent transcript of a session (`<sessionId>/subagents/**.jsonl`),
 *  sorted. Plain Task subagents sit flat as `agent-<id>.jsonl`; workflow
 *  researchers nest one level deeper under `workflows/<id>/`, so the walk is
 *  recursive. Sorted because cross-file dedupe attributes a shared turn to the
 *  first file that carries it - an unstable order would move tokens between
 *  agent rows run to run. */
function listAgentTranscripts(dir, sessionId) {
  const base = path.join(dir, sessionId, 'subagents');
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.jsonl')) out.push(path.join(d, e.name));
    }
  };
  walk(base);
  return out.sort();
}

/** First line of a user message, trimmed of the CLI's injected markup, capped at
 *  80 chars - the fallback title when no `ai-title` record exists. */
function summarizeUserText(text) {
  let s = String(text ?? '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]*>[\s\S]*?<\/ide_[a-z_]*>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '/$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 80) s = s.slice(0, 80).trimEnd() + '…';
  return s;
}

function firstTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && block.text) return block.text;
    }
  }
  return '';
}

// ── Token usage ──────────────────────────────────────────────────────────────
// Ported from claude-usage/src/services/projects.js (createUsageDeduper:31,
// getSessionSubagents:774) with every cost, price and savings field dropped -
// this dashboard reports tokens only.

const USAGE_KEYS = ['input', 'output', 'cacheCreate', 'cacheRead'];

const emptyUsage = () => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 });

/**
 * Claude Code writes one API response as several JSONL lines while streaming,
 * each line repeating a cumulative copy of `message.usage`, so summing raw
 * overcounts several times over. Per `message.id:requestId` the first sighting
 * counts in full; a repeat contributes only the positive delta per counter.
 * A record with no `message.id` has no key and counts in full.
 *
 * The returned delta also carries `first` - true on the first sighting of a key
 * (or for a keyless record). That is what a turn count increments on: the later
 * streamed copies of one API response are the same turn.
 */
function createUsageDeduper() {
  const seen = new Map();
  return (row) => {
    const cur = {
      input: row.input || 0,
      output: row.output || 0,
      cacheCreate: row.cacheCreate || 0,
      cacheRead: row.cacheRead || 0,
    };
    const key = row.id ? row.id + ':' + (row.requestId || '') : null;
    if (!key) return { ...cur, first: true };
    const prev = seen.get(key);
    if (!prev) { seen.set(key, cur); return { ...cur, first: true }; }
    const delta = { first: false };
    for (const c of USAGE_KEYS) {
      delta[c] = cur[c] > prev[c] ? cur[c] - prev[c] : 0;
      if (cur[c] > prev[c]) prev[c] = cur[c];
    }
    return delta;
  };
}

/** The deduper input for an assistant record, or null when it carries no usage. */
function usageRow(rec) {
  const u = rec?.message?.usage;
  if (!u) return null;
  return {
    id: rec.message.id || null,
    requestId: rec.requestId || null,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
  };
}

/** The model a row is filed under. `<synthetic>` is the CLI's own placeholder for
 *  a locally generated assistant message, not a model that ran. */
function modelKey(model) {
  return model && model !== '<synthetic>' ? model : 'unknown';
}

function addUsage(acc, d) {
  for (const c of USAGE_KEYS) acc[c] += d[c] || 0;
  acc.total = acc.input + acc.output + acc.cacheCreate + acc.cacheRead;
  return acc;
}

// One entry per transcript file, keyed by `size:mtimeMs`. Transcripts are
// append-only, so an unchanged size+mtime means an unchanged parse. Without this
// the sessions list re-reads every file (60+ folders, hundreds of KB each) on
// every 30 s dashboard refresh. In memory only - never persisted.
const summaryCache = new Map();

// Subagent transcripts are written while the main file sits unchanged, so their
// totals cannot live behind `summaryCache`'s size+mtime of the main file. They
// get their own cache, keyed by a signature over the whole subagent tree.
const subagentCache = new Map();

export function clearSummaryCache() {
  summaryCache.clear();
  subagentCache.clear();
}

function summarizeSessionFile(filePath, sessionId) {
  let st;
  try { st = fs.statSync(filePath); } catch { return null; }

  const key = filePath.toLowerCase();
  const signature = `${st.size}:${st.mtimeMs}`;
  const cached = summaryCache.get(key);
  if (cached && cached.signature === signature) return cached.value;

  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  let aiTitle = null;
  let firstUserText = '';
  let firstTs = null;
  let lastTs = null;
  let messages = 0;
  let gitBranch = null;
  let version = null;
  const models = new Set();
  // One deduper per session file - the key space is per API response, and
  // sharing it across sessions would cancel a resumed session's copied history.
  const dedupe = createUsageDeduper();
  const usage = emptyUsage();
  // Same pass, same deduper as `usage`: one row per model the main thread ran,
  // so `/model` mid-session shows as two rows instead of one blended number.
  const byModel = new Map();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = String(rec.aiTitle);
    if (rec.gitBranch) gitBranch = rec.gitBranch;
    if (rec.version) version = rec.version;

    if (rec.timestamp) {
      const ms = Date.parse(rec.timestamp);
      if (!Number.isNaN(ms)) {
        if (firstTs === null || ms < firstTs) firstTs = ms;
        if (lastTs === null || ms > lastTs) lastTs = ms;
      }
    }

    // Sidechain records are a subagent's turns spliced into the main file; they
    // are not messages in this conversation and must not inflate the count.
    if (rec.isSidechain === true) continue;

    if (rec.type === 'user' || rec.type === 'assistant') {
      messages++;
      if (rec.type === 'assistant') {
        if (rec.message?.model && rec.message.model !== '<synthetic>') models.add(rec.message.model);
        // Sidechain records were skipped above: their tokens are counted from
        // the subagent transcripts instead, never twice.
        const row = usageRow(rec);
        if (row) {
          const d = dedupe(row);
          addUsage(usage, d);
          const mk = modelKey(rec.message?.model);
          let m = byModel.get(mk);
          if (!m) { m = { model: mk, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }; byModel.set(mk, m); }
          addUsage(m, d);
        }
      }
      if (rec.type === 'user' && !firstUserText && !rec.isMeta) {
        const text = summarizeUserText(firstTextOf(rec.message?.content));
        if (text) firstUserText = text;
      }
    }
  }

  const value = {
    sessionId,
    title: aiTitle || firstUserText || '(no prompt yet)',
    titleSource: aiTitle ? 'ai-title' : firstUserText ? 'prompt' : 'none',
    started: firstTs,
    lastWrite: st.mtimeMs,
    lastTimestamp: lastTs,
    messages,
    models: [...models].sort(),
    gitBranch,
    version,
    bytes: st.size,
    usage,
    usageByModel: [...byModel.values()].sort((a, b) => b.total - a.total),
  };

  summaryCache.set(key, { signature, value });
  return value;
}

function subagentDirSignature(base, files) {
  const parts = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      parts.push(`${path.relative(base, f)}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch { /* raced with a delete - the next poll re-signs the tree */ }
  }
  return parts.join('|');
}

/** The agent's identity, most authoritative first:
 *  1. the `agent-<id>.meta.json` sidecar's `agentType` (written for both plain
 *     Task subagents and agent-team members);
 *  2. an agent-team member self-identifying as `You are "name"` in its first
 *     string user record;
 *  3. a neutral fallback. */
function resolveAgentName(filePath, firstUser) {
  try {
    const meta = JSON.parse(fs.readFileSync(filePath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    if (meta && meta.agentType) return String(meta.agentType);
  } catch { /* no sidecar, or it is not JSON */ }
  const match = firstUser && firstUser.match(/You are ["“]([^"”]+)["”]/);
  return (match && match[1]) || 'subagent';
}

/**
 * Per-agent rows for one session, `{ agentCount, totals, agents[] }`. `totals` is
 * null when the session spawned no agents. One row per (name, model) pair;
 * `spawns` counts the transcripts that fed the row, `turns` the API responses,
 * `toolUses` the tool calls and `durationMs` the summed wall clock of those
 * transcripts. `totals` covers tokens only.
 */
function readSubagentUsage(dir, sessionId) {
  const base = path.join(dir, sessionId, 'subagents');
  const files = listAgentTranscripts(dir, sessionId);
  if (!files.length) return { agentCount: 0, totals: null, agents: [] };

  const cacheKey = base.toLowerCase();
  const signature = subagentDirSignature(base, files);
  const cached = subagentCache.get(cacheKey);
  if (cached && cached.signature === signature) return cached.value;

  const byRow = new Map();
  const totals = emptyUsage();
  let agentCount = 0;

  // Agent-team members each persist their own copy of the shared conversation
  // turns, so one deduper spans ALL agent files of the session - a per-file
  // deduper would count a shared turn once per teammate. Tool calls in such a
  // shared turn would likewise repeat per teammate file, so they are deduped by
  // `tool_use` block id across the whole session too.
  const dedupe = createUsageDeduper();
  const seenToolUseIds = new Set();

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }

    let firstUser = null;
    // Wall clock spans every record type, not just assistant ones, so the time an
    // agent spent waiting on its own tool calls counts.
    let firstTs = null;
    let lastTs = null;
    // A subagent can run more than one model, so accumulate per model within the
    // file and merge each into its own session-level row.
    const perModel = new Map();
    const ensure = (mk) => {
      let acc = perModel.get(mk);
      if (!acc) { acc = { ...emptyUsage(), turns: 0, toolUses: 0 }; perModel.set(mk, acc); }
      return acc;
    };

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }

      if (rec.timestamp) {
        const ms = Date.parse(rec.timestamp);
        if (!Number.isNaN(ms)) {
          if (firstTs === null || ms < firstTs) firstTs = ms;
          if (lastTs === null || ms > lastTs) lastTs = ms;
        }
      }

      if (firstUser === null && rec.type === 'user' && typeof rec.message?.content === 'string') {
        firstUser = rec.message.content;
      }
      if (rec.type !== 'assistant') continue;

      const mk = modelKey(rec.message?.model);

      if (Array.isArray(rec.message?.content)) {
        for (const block of rec.message.content) {
          if (block?.type !== 'tool_use') continue;
          // A repeat of an already-counted call still proves this file ran the
          // model, so the row is created either way - it just adds no tool use.
          if (block.id && seenToolUseIds.has(block.id)) { ensure(mk); continue; }
          if (block.id) seenToolUseIds.add(block.id);
          ensure(mk).toolUses++;
        }
      }

      const row = usageRow(rec);
      if (!row) continue;
      const d = dedupe(row);
      const acc = ensure(mk);
      addUsage(acc, d);
      // One turn per API response: the later streamed copies of it are not turns.
      if (d.first) acc.turns++;
    }

    if (perModel.size === 0) continue;
    const name = resolveAgentName(file, firstUser);
    agentCount++;

    for (const [mk, acc] of perModel) {
      // Keep a row even when dedupe left it at zero: a teammate whose turns were
      // all attributed to an earlier file still ran, and dropping it would make
      // the transcript silently missing from the list.
      const key = name + ' ' + mk;
      let g = byRow.get(key);
      if (!g) {
        g = { name, model: mk, spawns: 0, turns: 0, toolUses: 0, durationMs: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 };
        byRow.set(key, g);
      }
      g.spawns++;
      g.turns += acc.turns;
      g.toolUses += acc.toolUses;
      // The span is per transcript, so a file that ran two models gives its whole
      // span to both rows - wall time has no per-model split.
      if (firstTs !== null && lastTs > firstTs) g.durationMs += lastTs - firstTs;
      addUsage(g, acc);
      addUsage(totals, acc);
    }
  }

  const agents = [...byRow.values()].sort((a, b) => b.total - a.total);
  const value = { agentCount, totals: agentCount ? totals : null, agents };
  subagentCache.set(cacheKey, { signature, value });
  return value;
}

/**
 * Token usage for one session: `main` (the session transcript, as `{ totals,
 * byModel }`), `subagents` (its `<sessionId>/subagents/**.jsonl` rows) and the
 * element-wise sum of both in `totals`. Tokens only - no cost anywhere.
 */
export function readSessionUsage(projectPath, sessionId, { home = os.homedir() } = {}) {
  const empty = () => ({
    totals: emptyUsage(),
    main: { totals: emptyUsage(), byModel: [] },
    subagents: { agentCount: 0, totals: null, agents: [] },
  });
  const dir = resolveTranscriptDir(projectPath, home);
  if (!dir) return empty();

  const summary = summarizeSessionFile(path.join(dir, sessionId + '.jsonl'), sessionId);
  if (!summary) return empty();

  // summary.usage and summary.usageByModel belong to the summary cache - copy
  // before handing them out, since `totals` sums into its accumulator.
  const main = {
    totals: { ...summary.usage },
    byModel: summary.usageByModel.map((m) => ({ ...m })),
  };
  const subagents = readSubagentUsage(dir, sessionId);
  const totals = addUsage(addUsage(emptyUsage(), main.totals), subagents.totals || {});
  return { totals, main, subagents };
}

/**
 * Session summaries for one project path, newest write first. Returns `[]` when
 * Claude Code has never run in that folder - the caller distinguishes that from
 * an error via `resolveTranscriptDir`.
 */
export function listSessions(projectPath, { home = os.homedir(), now = Date.now() } = {}) {
  const dir = resolveTranscriptDir(projectPath, home);
  if (!dir) return [];

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -'.jsonl'.length);
    const summary = summarizeSessionFile(path.join(dir, entry.name), sessionId);
    if (!summary) continue;
    // Still the transcript-file count, not readSubagentUsage's agentCount: a file
    // with no assistant records is a spawned agent that has not answered yet.
    summary.subagents = listAgentTranscripts(dir, sessionId).length;
    const sub = readSubagentUsage(dir, sessionId);
    summary.totalTokens = summary.usage.total + (sub.totals ? sub.totals.total : 0);
    summary.live = now - summary.lastWrite < LIVE_WINDOW_MS;
    out.push(summary);
  }

  out.sort((a, b) => b.lastWrite - a.lastWrite);
  return out;
}

// ── Chat rendering model ─────────────────────────────────────────────────────

const rawPart = (label, raw) => ({ kind: 'unknown', label, raw });

/**
 * Top-level record types beyond user/assistant carry session events - hook runs,
 * API errors, mode flips, queue operations, file snapshots. Known shapes map to a
 * compact event row; anything unrecognised surfaces raw so it is visible in the
 * UI rather than silently dropped.
 */
function contextEventPart(rec) {
  const ev = (label, text) => ({ kind: 'event', label, text: text || '', raw: rec });
  switch (rec.type) {
    case 'system': {
      const st = rec.subtype;
      if (st === 'compact_boundary') {
        const m = rec.compactMetadata;
        const detail = m ? ` (${m.trigger}, ${(m.preTokens || 0).toLocaleString()} → ${(m.postTokens || 0).toLocaleString()} tokens)` : '';
        return ev('Compacted', (rec.content || 'Conversation compacted') + detail);
      }
      if (st === 'api_error') {
        const e = rec.error || {};
        const retry = rec.retryAttempt ? ` — retry ${rec.retryAttempt}/${rec.maxRetries}` : '';
        return ev('API error', (e.formatted || e.message || '') + retry);
      }
      if (st === 'stop_hook_summary') {
        const n = rec.hookCount || (rec.hookInfos || []).length;
        const ms = (rec.hookInfos || []).reduce((a, h) => a + (h.durationMs || 0), 0);
        const errs = (rec.hookErrors || []).length;
        return ev('Stop hook', `${n} hook${n === 1 ? '' : 's'}, ${ms} ms${errs ? `, ${errs} error${errs === 1 ? '' : 's'}` : ''}`);
      }
      if (st === 'turn_duration') return ev('Turn', `${((rec.durationMs || 0) / 1000).toFixed(1)}s · ${rec.messageCount || 0} messages`);
      if (st === 'away_summary') return ev('Recap', rec.content || '');
      if (st === 'informational') return ev('Info', rec.content || '');
      if (st === 'scheduled_task_fire') return ev('Scheduled', rec.content || '');
      // local_command content carries the same <command-name> markup user
      // messages do - route it through the text part so the chip renderer sees it.
      if (st === 'local_command' && rec.content) return { kind: 'text', text: rec.content };
      return rawPart('system: ' + (st || 'unknown'), rec);
    }
    case 'progress': {
      const d = rec.data || {};
      if (d.type === 'hook_progress') return ev('Hook', d.hookName || d.hookEvent || '');
      if (d.type === 'agent_progress') return ev('Agent progress', '');
      return rawPart('progress: ' + (d.type || 'unknown'), rec);
    }
    case 'queue-operation': {
      if (rec.operation === 'enqueue') return ev('Queued', rec.content || '');
      if (rec.operation === 'dequeue') return ev('Dequeued', rec.content || '');
      if (rec.operation === 'remove') return ev('Unqueued', rec.content || '');
      return rawPart('queue-operation: ' + (rec.operation || 'unknown'), rec);
    }
    case 'last-prompt': return ev('Last prompt', rec.lastPrompt || '');
    case 'file-history-snapshot': {
      const n = Object.keys(rec.snapshot?.trackedFileBackups || {}).length;
      return ev('File snapshot', n ? `${n} file${n === 1 ? '' : 's'} tracked` : 'no tracked files');
    }
    case 'mode': return ev('Mode', rec.mode || '');
    case 'permission-mode': return ev('Permissions', rec.permissionMode || '');
    case 'teleported-from': return ev('Teleported', `from remote session${rec.messageCount ? ` (${rec.messageCount} messages)` : ''}`);
    case 'ai-title': return ev('Title', rec.aiTitle || '');
    case 'summary': return ev('Summary', rec.summary || '');
    default: return rawPart('record: ' + (rec.type || 'unknown'), rec);
  }
}

function attachmentPart(a) {
  if (a.type === 'file' && a.displayPath) {
    let numLines = null;
    try {
      const c = typeof a.content === 'string' ? JSON.parse(a.content) : a.content;
      numLines = c?.file?.numLines ?? null;
    } catch { /* content is not the JSON envelope - the path alone is enough */ }
    return { kind: 'attachment', attachKind: 'file', displayPath: a.displayPath, numLines };
  }
  if (a.type === 'compact_file_reference' && a.displayPath) return { kind: 'attachment', attachKind: 'reference', displayPath: a.displayPath };
  if (a.type === 'edited_text_file' && (a.displayPath || a.filename)) return { kind: 'attachment', attachKind: 'edited', displayPath: a.displayPath || a.filename };
  if (a.type === 'nested_memory' && a.displayPath) return { kind: 'attachment', attachKind: 'memory', displayPath: a.displayPath };
  if (a.type === 'queued_command') {
    const txt = Array.isArray(a.prompt) ? a.prompt.map((b) => b?.text || '').join(' ').trim() : '';
    return txt ? { kind: 'attachment', attachKind: 'queued', text: txt } : null;
  }
  if (a.type === 'date_change' && a.newDate) return { kind: 'attachment', attachKind: 'date', text: a.newDate };
  return rawPart('attachment: ' + (a.type || 'unknown'), a);
}

/** The short input string shown beside a tool name. Everything else stays in the
 *  collapsed raw block, so a Bash command reads at a glance. */
function toolInputSummary(name, input) {
  if (name === 'Bash' || name === 'PowerShell') return input?.command || '';
  if (name === 'Edit' || name === 'Write' || name === 'Read' || name === 'NotebookEdit') return input?.file_path || '';
  if (name === 'Glob' || name === 'Grep') return input?.pattern || '';
  if (name === 'Agent' || name === 'Task') return input?.description || input?.subagent_type || '';
  if (name === 'Skill') return input?.skill || '';
  try { return JSON.stringify(input ?? {}); } catch { return ''; }
}

/** Moves a lone tool_result message directly after the tool_use that produced it,
 *  so a call and its output read as one pair. Results whose call is missing are
 *  kept at the end rather than dropped. */
function reorderToolResults(messages) {
  const movable = new Map();
  for (const m of messages) {
    if (m.parts.length === 1 && m.parts[0].kind === 'tool_result' && m.parts[0].toolUseId) {
      m.__key = m.parts[0].toolUseId;
      movable.set(m.__key, m);
    }
  }
  if (movable.size === 0) return messages;

  const out = [];
  const placed = new Set();
  for (const m of messages) {
    if (m.__key) continue;
    out.push(m);
    for (const p of m.parts) {
      if (p.kind === 'tool_use' && p.id && movable.has(p.id) && !placed.has(p.id)) {
        out.push(movable.get(p.id));
        placed.add(p.id);
      }
    }
  }
  for (const m of messages) {
    if (m.__key && !placed.has(m.__key)) out.push(m);
  }
  for (const m of out) delete m.__key;
  return out;
}

/**
 * Parses one session transcript into `{ messages[] }` for the chat view.
 * Every part carries `kind` in
 * `text | tool_use | tool_result | thinking | image | attachment | event | unknown`.
 * Returns null when the file does not exist.
 */
export function readSessionChat(projectPath, sessionId, { home = os.homedir() } = {}) {
  const dir = resolveTranscriptDir(projectPath, home);
  if (!dir) return null;
  const file = path.join(dir, sessionId + '.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }

  const messages = [];
  // Consecutive attachment / event records are buffered into one "context"
  // message so a post-compact run of them renders as a single card.
  let pending = null;
  const flush = () => {
    if (pending && pending.parts.length) messages.push(pending);
    pending = null;
  };
  const pushContext = (part, timestamp) => {
    if (!part) return;
    if (!pending) pending = { role: 'context', parts: [], timestamp: timestamp || null };
    pending.parts.push(part);
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // A half-written last line while `claude` is mid-append. Skip it; the next
      // poll picks up the complete record.
      continue;
    }

    if (rec.type === 'attachment' && rec.attachment) {
      pushContext(attachmentPart(rec.attachment), rec.timestamp);
      continue;
    }

    if (rec.type !== 'user' && rec.type !== 'assistant') {
      pushContext(contextEventPart(rec), rec.timestamp);
      continue;
    }

    flush();

    const content = rec.message?.content;
    if (!content) continue;

    const parts = [];
    if (typeof content === 'string') {
      parts.push({ kind: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text') {
          parts.push({ kind: 'text', text: block.text ?? '' });
        } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
          parts.push({ kind: 'thinking', text: block.thinking ?? '(redacted)' });
        } else if (block?.type === 'tool_use') {
          parts.push({
            kind: 'tool_use',
            tool: block.name ?? '(unnamed)',
            input: toolInputSummary(block.name, block.input),
            raw: block.input ?? null,
            id: block.id ?? null,
          });
        } else if (block?.type === 'tool_result') {
          const text = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((b) => {
                  if (typeof b === 'string') return b;
                  if (b?.text) return b.text;
                  if (b?.type === 'tool_reference') return b.tool_name || '';
                  try { return JSON.stringify(b); } catch { return ''; }
                }).join('\n')
              : '';
          parts.push({ kind: 'tool_result', text, isError: block.is_error || false, toolUseId: block.tool_use_id ?? null });
        } else if (block?.type === 'image' && block.source) {
          parts.push({ kind: 'image', mediaType: block.source.media_type || 'image/png', data: block.source.data || '' });
        } else {
          // An unknown content block inside a known message - same rule as an
          // unknown record: show it raw rather than lose it.
          parts.push(rawPart('block: ' + (block?.type || 'unknown'), block));
        }
      }
    } else {
      parts.push(rawPart('content: ' + typeof content, content));
    }

    if (parts.length === 0) continue;

    // A user record carrying only tool results is the CLI feeding output back to
    // the model, not the human speaking.
    let role = rec.type;
    if (rec.type === 'user' && !parts.some((p) => p.kind === 'text' || p.kind === 'image')) role = 'tool';

    const msg = { role, parts, timestamp: rec.timestamp || null };
    if (rec.isCompactSummary) msg.isCompactSummary = true;
    if (rec.isSidechain) msg.isSidechain = true;
    if (rec.type === 'assistant') {
      const model = rec.message?.model;
      if (model && model !== '<synthetic>') msg.model = model;
    }
    messages.push(msg);
  }
  flush();

  return { sessionId, messages: reorderToolResults(messages) };
}
