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

/** Number of subagent transcripts for a session (`<sessionId>/subagents/**.jsonl`).
 *  v1 shows the count only; the transcripts themselves are not rendered. */
function countSubagents(dir, sessionId) {
  const base = path.join(dir, sessionId, 'subagents');
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.jsonl')) n++;
    }
  };
  walk(base);
  return n;
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

// One entry per transcript file, keyed by `size:mtimeMs`. Transcripts are
// append-only, so an unchanged size+mtime means an unchanged parse. Without this
// the sessions list re-reads every file (60+ folders, hundreds of KB each) on
// every 30 s dashboard refresh. In memory only - never persisted.
const summaryCache = new Map();

export function clearSummaryCache() {
  summaryCache.clear();
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
      if (rec.type === 'assistant' && rec.message?.model && rec.message.model !== '<synthetic>') {
        models.add(rec.message.model);
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
  };

  summaryCache.set(key, { signature, value });
  return value;
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
    summary.subagents = countSubagents(dir, sessionId);
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
