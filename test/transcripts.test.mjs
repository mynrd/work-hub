// AC 8, 9, 10: transcript folder encoding (case-insensitive), session summaries,
// and the chat parser's "nothing is ever dropped" rule.
//
// A fake `home` is built in a temp directory for every test, because the folder
// name Claude Code uses is derived from the project's absolute path - which is
// machine-specific and cannot be committed as a fixture directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeProjectFolder, resolveTranscriptDir, listSessions, readSessionChat, clearSummaryCache } from '../src/lib/transcripts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'transcripts', 'session-sample.jsonl'), 'utf8');
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

/**
 * Builds `<tmp>/.claude/projects/<encoded>/<sessionId>.jsonl`.
 * @param {(name: string) => string} [mangle] - rewrites the folder name, to test
 *   the case-insensitive match.
 */
function makeHome(projectPath, { mangle = (n) => n, content = SAMPLE, subagents = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-home-'));
  const dir = path.join(home, '.claude', 'projects', mangle(encodeProjectFolder(projectPath)));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SESSION_ID + '.jsonl'), content);
  if (subagents > 0) {
    const sub = path.join(dir, SESSION_ID, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < subagents; i++) fs.writeFileSync(path.join(sub, `agent-${i}.jsonl`), '{}\n');
  }
  return home;
}

test.beforeEach(() => clearSummaryCache());

test('AC 8: encode replaces every character outside [A-Za-z0-9] with a dash', () => {
  assert.equal(encodeProjectFolder('D:\\Work\\git\\mynrd\\work-hub'), 'D--Work-git-mynrd-work-hub');
  assert.equal(encodeProjectFolder('C:\\Users\\mynrd\\.claude\\projects'), 'C--Users-mynrd--claude-projects');
  assert.equal(encodeProjectFolder('/home/me/proj'), '-home-me-proj');
});

test('AC 8: the folder is matched case-insensitively', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project, { mangle: (n) => n.toLowerCase() });
  const dir = resolveTranscriptDir(project, home);
  assert.ok(dir, 'expected the lowercased folder to be found');
  assert.equal(path.basename(dir), encodeProjectFolder(project).toLowerCase());
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 8: a project with no transcript folder resolves to null and lists no sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  assert.equal(resolveTranscriptDir(path.resolve('D:\\Nothing\\Here'), home), null);
  assert.deepEqual(listSessions(path.resolve('D:\\Nothing\\Here'), { home }), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 8: a missing ~/.claude/projects is not an error', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-home-'));
  assert.equal(resolveTranscriptDir(path.resolve('D:\\Anything'), home), null);
  assert.deepEqual(listSessions(path.resolve('D:\\Anything'), { home }), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 9: a session row carries the ai-title, timestamps, model set and subagent count', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project, { subagents: 3 });
  const [row] = listSessions(project, { home });
  assert.equal(row.sessionId, SESSION_ID);
  assert.equal(row.title, 'Fixture session title');
  assert.equal(row.titleSource, 'ai-title');
  assert.equal(row.started, Date.parse('2026-08-29T01:00:00.000Z'));
  assert.equal(row.lastTimestamp, Date.parse('2026-08-29T01:00:12.000Z'));
  assert.deepEqual(row.models, ['claude-fable-5', 'claude-opus-5']);
  assert.equal(row.subagents, 3);
  assert.equal(row.gitBranch, 'main');
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 9: sidechain records do not count as messages', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project);
  const [row] = listSessions(project, { home });
  // 8 user/assistant records in the fixture, one of them isSidechain.
  assert.equal(row.messages, 8);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 9: with no ai-title the first non-meta user prompt becomes the title, capped at 80 chars', () => {
  const project = path.resolve('D:\\Fixture\\NoTitle');
  const lines = SAMPLE.split('\n').filter((l) => l && !l.includes('"ai-title"'));
  const home = makeHome(project, { content: lines.join('\n') + '\n' });
  const [row] = listSessions(project, { home });
  assert.equal(row.title, 'First real prompt from the human');
  assert.equal(row.titleSource, 'prompt');
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 9: a long first prompt is truncated to 80 characters plus an ellipsis', () => {
  const project = path.resolve('D:\\Fixture\\LongTitle');
  const long = 'x'.repeat(200);
  const content = JSON.stringify({ type: 'user', message: { role: 'user', content: long }, timestamp: '2026-08-29T01:00:00.000Z' }) + '\n';
  const home = makeHome(project, { content });
  const [row] = listSessions(project, { home });
  assert.equal(row.title.length, 81);
  assert.ok(row.title.endsWith('…'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 9: the live dot is on inside 45 s of the last write and off outside it', () => {
  const project = path.resolve('D:\\Fixture\\Live');
  const home = makeHome(project);
  const fresh = listSessions(project, { home, now: Date.now() });
  assert.equal(fresh[0].live, true);
  const stale = listSessions(project, { home, now: Date.now() + 60 * 1000 });
  assert.equal(stale[0].live, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 9: sessions sort by last write, newest first', () => {
  const project = path.resolve('D:\\Fixture\\Sort');
  const home = makeHome(project);
  const dir = resolveTranscriptDir(project, home);
  const older = '00000000-0000-4000-8000-000000000000';
  fs.writeFileSync(path.join(dir, older + '.jsonl'), SAMPLE);
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, older + '.jsonl'), past, past);
  const rows = listSessions(project, { home });
  assert.deepEqual(rows.map((r) => r.sessionId), [SESSION_ID, older]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 10: every part kind in the fixture is rendered, and nothing is dropped', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project);
  const chat = readSessionChat(project, SESSION_ID, { home });
  const kinds = new Set();
  for (const m of chat.messages) for (const p of m.parts) kinds.add(p.kind);
  for (const expected of ['text', 'thinking', 'tool_use', 'tool_result', 'attachment', 'event', 'unknown']) {
    assert.ok(kinds.has(expected), `expected a part of kind ${expected}`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 10: an invented record type surfaces as a collapsed raw block, never dropped', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project);
  const chat = readSessionChat(project, SESSION_ID, { home });
  const unknowns = chat.messages.flatMap((m) => m.parts).filter((p) => p.kind === 'unknown');
  const record = unknowns.find((p) => p.label === 'record: a-record-type-that-did-not-exist-when-this-was-written');
  assert.ok(record, 'the invented record type must appear as a raw part');
  assert.deepEqual(record.raw.payload, { anything: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 10: an unknown content block inside a known message also surfaces raw', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project);
  const chat = readSessionChat(project, SESSION_ID, { home });
  const block = chat.messages.flatMap((m) => m.parts).find((p) => p.kind === 'unknown' && p.label === 'block: a_block_type_from_the_future');
  assert.ok(block, 'the future block type must appear as a raw part');
  assert.equal(block.raw.data, 42);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 10: a tool result is moved next to the call that produced it', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project);
  const chat = readSessionChat(project, SESSION_ID, { home });
  const callIndex = chat.messages.findIndex((m) => m.parts.some((p) => p.kind === 'tool_use' && p.id === 'toolu_1'));
  const resultIndex = chat.messages.findIndex((m) => m.parts.some((p) => p.kind === 'tool_result' && p.toolUseId === 'toolu_1'));
  assert.equal(resultIndex, callIndex + 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 10: a user message carrying only tool results is labelled tool, not user', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project);
  const chat = readSessionChat(project, SESSION_ID, { home });
  const msg = chat.messages.find((m) => m.parts.some((p) => p.kind === 'tool_result'));
  assert.equal(msg.role, 'tool');
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 10: the compact summary flag is preserved', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project);
  const chat = readSessionChat(project, SESSION_ID, { home });
  assert.ok(chat.messages.some((m) => m.isCompactSummary === true));
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 10: a truncated final line (claude mid-append) is skipped, not fatal', () => {
  const project = path.resolve('D:\\Fixture\\Partial');
  const home = makeHome(project, { content: SAMPLE + '{"type":"assistant","message":{"rol' });
  const chat = readSessionChat(project, SESSION_ID, { home });
  assert.ok(chat.messages.length > 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('readSessionChat returns null for a session that does not exist', () => {
  const project = path.resolve('D:\\Fixture\\Proj');
  const home = makeHome(project);
  assert.equal(readSessionChat(project, '99999999-9999-4999-8999-999999999999', { home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the summary cache re-reads a file whose size or mtime changed', () => {
  const project = path.resolve('D:\\Fixture\\Cache');
  const home = makeHome(project);
  const first = listSessions(project, { home });
  assert.equal(first[0].messages, 8);

  const dir = resolveTranscriptDir(project, home);
  fs.appendFileSync(
    path.join(dir, SESSION_ID + '.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'one more' }, timestamp: '2026-08-29T02:00:00.000Z' }) + '\n',
  );
  const second = listSessions(project, { home });
  assert.equal(second[0].messages, 9);
  fs.rmSync(home, { recursive: true, force: true });
});
