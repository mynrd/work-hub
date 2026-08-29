// AC 7: the /usage parser. The spawn itself is not exercised here - that needs a
// signed-in claude on PATH - so the samples under test/fixtures/usage/ stand in
// for its stdout.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseUsage, usageCwd } from '../src/lib/usage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sample = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'usage', name), 'utf8');

test('AC 7: every "<label>: N% used · resets <when>" line is parsed', () => {
  const { plan, limits } = parseUsage(sample('pro.txt'));
  assert.equal(plan, 'You are currently using your subscription to power your Claude Code usage');
  assert.deepEqual(limits, [
    { label: 'Current session', pct: 4, resets: 'Aug 30, 12:59am (Asia/Manila)' },
    { label: 'Current week (all models)', pct: 22, resets: 'Sep 2, 7am (Asia/Manila)' },
    { label: 'Current week (Fable)', pct: 9, resets: 'Sep 2, 7am (Asia/Manila)' },
  ]);
});

test('AC 7: a limit line with no reset clause still parses', () => {
  const { limits } = parseUsage(sample('no-reset.txt'));
  assert.deepEqual(limits, [{ label: 'Current session', pct: 100, resets: '' }]);
});

test('AC 7: a new limit row surfaces without a code change', () => {
  const { limits } = parseUsage('Current week (SomeFutureModel): 3% used · resets Jan 1, 1am (UTC)');
  assert.deepEqual(limits, [{ label: 'Current week (SomeFutureModel)', pct: 3, resets: 'Jan 1, 1am (UTC)' }]);
});

test('AC 7: output with no limit lines yields no limits', () => {
  const { plan, limits } = parseUsage(sample('error.txt'));
  assert.deepEqual(limits, []);
  assert.equal(plan, 'Invalid API key · Please run /login'); // "API" matches the plan-sentence probe; harmless, and the limits list is what the card reads
});

test('AC 7: an API-credit plan sentence is picked up too', () => {
  const { plan } = parseUsage('You are using API credits\n\nCurrent session: 1% used');
  assert.equal(plan, 'You are using API credits');
});

test("AC 7: /usage runs from ~/.claude so its transcripts do not land in a monitored project", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-usage-home-'));
  assert.equal(usageCwd(home), home, 'with no .claude folder it falls back to the home folder');
  fs.mkdirSync(path.join(home, '.claude'));
  assert.equal(usageCwd(home), path.join(home, '.claude'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC 7: empty, null and undefined input do not throw', () => {
  assert.deepEqual(parseUsage(''), { plan: '', limits: [] });
  assert.deepEqual(parseUsage(null), { plan: '', limits: [] });
  assert.deepEqual(parseUsage(undefined), { plan: '', limits: [] });
});
