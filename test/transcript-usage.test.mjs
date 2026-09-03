// AC 10: token aggregation over a session transcript and its subagent tree -
// streamed-record dedupe, sidechain exclusion, agent naming, nested workflow
// dirs, cross-file dedupe, and the list summary's totalTokens.
//
// The fixture tree under test/fixtures/transcripts/usage-session/ is copied into
// a fake `home` per test, because the folder name Claude Code uses is derived
// from the project's absolute path and cannot be committed as a fixture folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeProjectFolder, listSessions, readSessionUsage, clearSummaryCache } from '../src/lib/transcripts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'transcripts', 'usage-session');
const MAIN = fs.readFileSync(path.join(FIXTURE, 'main.jsonl'), 'utf8');
const MAIN_TWO_MODELS = fs.readFileSync(path.join(FIXTURE, 'main-two-models.jsonl'), 'utf8');
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Builds `<tmp>/.claude/projects/<encoded>/` with `<sessionId>.jsonl` and,
 *  unless `subagents: false`, the fixture's `<sessionId>/subagents/` tree. */
function makeHome(projectPath, { content = MAIN, subagents = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-usage-'));
  const dir = path.join(home, '.claude', 'projects', encodeProjectFolder(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SESSION_ID + '.jsonl'), content);
  if (subagents) {
    fs.cpSync(path.join(FIXTURE, 'subagents'), path.join(dir, SESSION_ID, 'subagents'), { recursive: true });
  }
  return home;
}

const agent = (usage, name, model) => usage.subagents.agents.find((a) => a.name === name && a.model === model);

test.beforeEach(() => clearSummaryCache());

test('AC 1: two streamed records sharing message.id and requestId count the delta once', () => {
  const project = path.resolve('D:\\Fixture\\Usage');
  const home = makeHome(project, { subagents: false });
  const usage = readSessionUsage(project, SESSION_ID, { home });
  // msg_a repeats its cumulative usage (output 5 then 20); msg_b adds 10/2/0/50.
  assert.deepEqual(usage.main.totals, { input: 110, output: 22, cacheCreate: 200, cacheRead: 350, total: 682 });
  assert.deepEqual(usage.main.byModel, [
    { model: 'claude-opus-5', input: 110, output: 22, cacheCreate: 200, cacheRead: 350, total: 682 },
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 11: main reports one row per model, sorted by total descending, with <synthetic> as unknown', () => {
  const project = path.resolve('D:\\Fixture\\UsageMainModels');
  const home = makeHome(project, { subagents: false, content: MAIN_TWO_MODELS });
  const usage = readSessionUsage(project, SESSION_ID, { home });

  // msg_m2 streams twice (output 100 then 150) - the same deduper feeds both the
  // per-model rows and main.totals, so the repeat adds only the 50 delta.
  assert.deepEqual(usage.main.byModel, [
    { model: 'claude-fable-5', input: 1000, output: 150, cacheCreate: 0, cacheRead: 0, total: 1150 },
    { model: 'claude-opus-5', input: 100, output: 10, cacheCreate: 0, cacheRead: 0, total: 110 },
    { model: 'unknown', input: 5, output: 1, cacheCreate: 0, cacheRead: 0, total: 6 },
  ]);
  // The rows add up to main.totals, and the 999-token sidechain is in neither.
  assert.deepEqual(usage.main.totals, { input: 1105, output: 161, cacheCreate: 0, cacheRead: 0, total: 1266 });
  assert.equal(usage.main.byModel.reduce((a, m) => a + m.total, 0), usage.main.totals.total);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 1: a sidechain assistant record contributes nothing to main', () => {
  const project = path.resolve('D:\\Fixture\\UsageSidechain');
  const withSide = makeHome(project, { subagents: false });
  const withoutSide = makeHome(path.resolve('D:\\Fixture\\UsageNoSidechain'), {
    subagents: false,
    content: MAIN.split('\n').filter((l) => l && !l.includes('"isSidechain":true')).join('\n') + '\n',
  });
  const a = readSessionUsage(project, SESSION_ID, { home: withSide });
  const b = readSessionUsage(path.resolve('D:\\Fixture\\UsageNoSidechain'), SESSION_ID, { home: withoutSide });
  assert.deepEqual(a.main, b.main);
  assert.equal(a.main.totals.total, 682, 'the 999-token sidechain record must not be in main');
  fs.rmSync(withSide, { recursive: true, force: true });
  fs.rmSync(withoutSide, { recursive: true, force: true });
});

test('AC 3: a session with no subagents reports null subagent totals', () => {
  const project = path.resolve('D:\\Fixture\\UsageNoAgents');
  const home = makeHome(project, { subagents: false });
  const usage = readSessionUsage(project, SESSION_ID, { home });
  assert.deepEqual(usage.subagents, { agentCount: 0, totals: null, agents: [] });
  assert.deepEqual(usage.totals, usage.main.totals);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 2: the meta.json agentType wins over the "You are" line in the transcript', () => {
  const project = path.resolve('D:\\Fixture\\UsageNames');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });
  assert.ok(agent(usage, 'code-reviewer', 'claude-opus-5'), 'agent-a must be named from its sidecar');
  assert.equal(usage.subagents.agents.some((a) => a.name === 'name-from-the-prompt'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 2: an agent with no sidecar is named from its "You are" line, and one with neither falls back to subagent', () => {
  const project = path.resolve('D:\\Fixture\\UsageNames2');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });
  assert.ok(agent(usage, 'researcher', 'claude-fable-5'), 'agent-b must be named from its prompt');
  assert.ok(agent(usage, 'subagent', 'claude-fable-5'), 'agent-c has neither source and falls back');
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 2: a <synthetic> model is reported as unknown', () => {
  const project = path.resolve('D:\\Fixture\\UsageSynthetic');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });
  const row = agent(usage, 'researcher', 'unknown');
  assert.ok(row, 'the <synthetic> record must land on an "unknown" model row');
  assert.equal(row.total, 6);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 2: a transcript nested under subagents/workflows/<id>/ is parsed and merges into its (name, model) row', () => {
  const project = path.resolve('D:\\Fixture\\UsageNested');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });
  const row = agent(usage, 'researcher', 'claude-fable-5');
  // agent-b (200/20) plus the nested agent-d (100/10), one row, two spawns.
  assert.equal(row.spawns, 2);
  assert.equal(row.input, 300);
  assert.equal(row.output, 30);
  assert.equal(row.total, 330);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 2: the same message.id and requestId in two agent files counts once', () => {
  const project = path.resolve('D:\\Fixture\\UsageCrossFile');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });
  // msg_shared (500/50) sits in both agent-a and agent-b: counted with agent-a.
  assert.equal(agent(usage, 'code-reviewer', 'claude-opus-5').input, 1500);
  const shared = agent(usage, 'researcher', 'claude-opus-5');
  assert.ok(shared, 'the second file keeps a row even when dedupe leaves it at zero');
  assert.equal(shared.total, 0);
  assert.equal(usage.subagents.totals.input, 2105);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 3: the usage payload matches the contract shape and sorts agents by total descending', () => {
  const project = path.resolve('D:\\Fixture\\UsageShape');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });

  assert.deepEqual(Object.keys(usage), ['totals', 'main', 'subagents']);
  assert.deepEqual(Object.keys(usage.totals), ['input', 'output', 'cacheCreate', 'cacheRead', 'total']);
  assert.deepEqual(Object.keys(usage.main), ['totals', 'byModel']);
  assert.deepEqual(Object.keys(usage.main.totals), ['input', 'output', 'cacheCreate', 'cacheRead', 'total']);
  assert.deepEqual(Object.keys(usage.main.byModel[0]), ['model', 'input', 'output', 'cacheCreate', 'cacheRead', 'total']);
  assert.deepEqual(Object.keys(usage.subagents), ['agentCount', 'totals', 'agents']);
  assert.deepEqual(Object.keys(usage.subagents.agents[0]), ['name', 'model', 'spawns', 'turns', 'toolUses', 'durationMs', 'input', 'output', 'cacheCreate', 'cacheRead', 'total']);

  assert.equal(usage.subagents.agentCount, 4);
  assert.deepEqual(usage.subagents.totals, { input: 2105, output: 211, cacheCreate: 400, cacheRead: 800, total: 3516 });
  assert.deepEqual(usage.totals, { input: 2215, output: 233, cacheCreate: 600, cacheRead: 1150, total: 4198 });

  const totals = usage.subagents.agents.map((a) => a.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a));
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 11: turns count first-seen message ids only, so a shared turn does not count twice', () => {
  const project = path.resolve('D:\\Fixture\\UsageTurns');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });

  // agent-a carries msg_s1 and msg_shared, both first seen there.
  assert.equal(agent(usage, 'code-reviewer', 'claude-opus-5').turns, 2);
  // agent-b's only opus record is its copy of msg_shared: a spawn, but no turn.
  const shared = agent(usage, 'researcher', 'claude-opus-5');
  assert.equal(shared.spawns, 1);
  assert.equal(shared.turns, 0);
  // researcher/claude-fable-5 merges agent-b's msg_s2 with nested agent-d's msg_s5.
  assert.equal(agent(usage, 'researcher', 'claude-fable-5').turns, 2);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 11: tool_use blocks are counted per row and deduped by block id across agent files', () => {
  const project = path.resolve('D:\\Fixture\\UsageTools');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });

  // agent-a: toolu_a1, one id-less block (counts on its own), and toolu_shared.
  assert.equal(agent(usage, 'code-reviewer', 'claude-opus-5').toolUses, 3);
  // agent-b repeats toolu_shared - already counted against agent-a, so zero here.
  assert.equal(agent(usage, 'researcher', 'claude-opus-5').toolUses, 0);
  // An agent whose records carry no tool_use block reports zero, not undefined.
  assert.equal(agent(usage, 'subagent', 'claude-fable-5').toolUses, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 11: durationMs is each transcript span, summed into the rows it feeds', () => {
  const project = path.resolve('D:\\Fixture\\UsageDuration');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });

  // agent-a spans 01:00:05 → 01:00:07.
  assert.equal(agent(usage, 'code-reviewer', 'claude-opus-5').durationMs, 2000);
  // agent-b spans 01:00:08 → 01:00:11 and ran three models: the whole span goes
  // to each of its rows, wall time is not split per model.
  assert.equal(agent(usage, 'researcher', 'claude-opus-5').durationMs, 3000);
  assert.equal(agent(usage, 'researcher', 'unknown').durationMs, 3000);
  // agent-b (3000) plus nested agent-d (01:00:14 → 01:00:15) on one row.
  assert.equal(agent(usage, 'researcher', 'claude-fable-5').durationMs, 4000);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 11: an agent file with no timestamps reports zero duration rather than NaN', () => {
  const project = path.resolve('D:\\Fixture\\UsageNoTimestamps');
  const home = makeHome(project);
  const sub = path.join(home, '.claude', 'projects', encodeProjectFolder(project), SESSION_ID, 'subagents');
  fs.writeFileSync(path.join(sub, 'agent-untimed.jsonl'),
    JSON.stringify({
      type: 'assistant',
      requestId: 'req_t',
      message: { role: 'assistant', id: 'msg_t1', model: 'claude-haiku-x', usage: { input_tokens: 1, output_tokens: 1 } },
    }) + '\n');

  const row = agent(readSessionUsage(project, SESSION_ID, { home }), 'subagent', 'claude-haiku-x');
  assert.equal(row.durationMs, 0);
  assert.equal(row.turns, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 3: no cost or price field appears anywhere in the usage payload', () => {
  const project = path.resolve('D:\\Fixture\\UsageNoCost');
  const home = makeHome(project);
  const usage = readSessionUsage(project, SESSION_ID, { home });
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v)) {
      assert.equal(/cost|price|pricing|saving/i.test(k), false, `unexpected money field: ${k}`);
      walk(child);
    }
  };
  walk(usage);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 3: the session list summary carries totalTokens = main + subagents', () => {
  const project = path.resolve('D:\\Fixture\\UsageList');
  const home = makeHome(project);
  const [row] = listSessions(project, { home });
  assert.equal(row.totalTokens, 682 + 3516);
  assert.equal(row.subagents, 4);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 3: a subagent file written after the main file still changes totalTokens', () => {
  const project = path.resolve('D:\\Fixture\\UsageCache');
  const home = makeHome(project);
  const before = listSessions(project, { home })[0].totalTokens;

  // The main transcript is untouched here - only the subagent tree grows, which
  // is exactly the case the summary cache's size+mtime signature cannot see.
  const sub = path.join(home, '.claude', 'projects', encodeProjectFolder(project), SESSION_ID, 'subagents');
  fs.writeFileSync(path.join(sub, 'agent-e.jsonl'),
    JSON.stringify({
      type: 'assistant',
      requestId: 'req_f',
      message: { role: 'assistant', id: 'msg_s6', model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 1 } },
    }) + '\n');

  const after = listSessions(project, { home })[0].totalTokens;
  assert.equal(after, before + 2);
  fs.rmSync(home, { recursive: true, force: true });
});

test('unreadable or malformed subagent data never throws', () => {
  const project = path.resolve('D:\\Fixture\\UsageBadData');
  const home = makeHome(project);
  const sub = path.join(home, '.claude', 'projects', encodeProjectFolder(project), SESSION_ID, 'subagents');
  fs.writeFileSync(path.join(sub, 'agent-broken.jsonl'), '{"type":"assistant","message":{"rol\nnot json at all\n');
  fs.writeFileSync(path.join(sub, 'agent-broken.meta.json'), 'not json either');
  const usage = readSessionUsage(project, SESSION_ID, { home });
  assert.equal(usage.totals.total, 4198);
  fs.rmSync(home, { recursive: true, force: true });
});
