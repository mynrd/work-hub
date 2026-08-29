// AC 11, 13: the argument builder accepts only allowlisted tokens, the message
// never becomes an argument, and one session can only have one run in flight.
//
// Every spawn is faked - these tests must never start a real `claude`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildArgs, previewCommand, createRunRegistry } from './claude-run.mjs';

const VALID_SID = '0a690e2d-fb11-480b-b48a-ff6f44eff2e9';
const OK = { model: 'claude-fable-5', effort: 'medium', permissionMode: 'default' };

/** A stand-in for a spawned child. `finish(code, stdout)` completes the run. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinWrites = [];
  child.stdin = { write: (d) => child.stdinWrites.push(d), end: () => { child.stdinEnded = true; } };
  child.kill = () => { child.killed = true; };
  child.finish = (code, stdout = '', stderr = '') => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code);
  };
  return child;
}

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, options) => {
    const child = fakeChild();
    calls.push({ cmd, args, options, child });
    return child;
  };
  fn.calls = calls;
  fn.last = () => calls[calls.length - 1];
  return fn;
}

test('AC 11: a reply builds -p -r <sid> --model --effort --output-format json', () => {
  const built = buildArgs({ sessionId: VALID_SID, ...OK });
  assert.equal(built.ok, true);
  assert.deepEqual(built.args, ['-p', '-r', VALID_SID, '--model', 'claude-fable-5', '--effort', 'medium', '--output-format', 'json']);
});

test('AC 12: a new conversation builds the same args without -r', () => {
  const built = buildArgs({ sessionId: null, ...OK });
  assert.equal(built.ok, true);
  assert.ok(!built.args.includes('-r'));
  assert.deepEqual(built.args, ['-p', '--model', 'claude-fable-5', '--effort', 'medium', '--output-format', 'json']);
});

test('AC 11: each permission mode maps to its own flags', () => {
  assert.deepEqual(buildArgs({ ...OK, permissionMode: 'acceptEdits' }).args.slice(-2), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(buildArgs({ ...OK, permissionMode: 'plan' }).args.slice(-2), ['--permission-mode', 'plan']);
  assert.deepEqual(buildArgs({ ...OK, permissionMode: 'bypassPermissions' }).args.slice(-1), ['--dangerously-skip-permissions']);
  assert.deepEqual(buildArgs({ ...OK, permissionMode: 'default' }).args.slice(-2), ['--output-format', 'json']);
});

test('AC 11: a session id that is not a UUID is refused', () => {
  for (const bad of ['not-a-uuid', '../../etc/passwd', VALID_SID + ' && calc.exe', '', ' ']) {
    if (bad === '') continue; // empty means "new conversation", covered above
    const built = buildArgs({ sessionId: bad, ...OK });
    assert.equal(built.ok, false, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('AC 11: a model, effort or permission mode outside the allowlist is refused', () => {
  assert.equal(buildArgs({ ...OK, model: 'gpt-4' }).ok, false);
  assert.equal(buildArgs({ ...OK, model: 'claude-fable-5 --dangerously-skip-permissions' }).ok, false);
  assert.equal(buildArgs({ ...OK, effort: 'turbo' }).ok, false);
  assert.equal(buildArgs({ ...OK, permissionMode: 'yolo' }).ok, false);
  assert.equal(buildArgs({ ...OK, permissionMode: '__proto__' }).ok, false);
});

test('AC 11: an invalid token returns 400 and nothing is spawned', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  const res = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: 'nope', message: 'hi', ...OK });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(spawnFn.calls.length, 0);
});

test('AC 11: an empty message returns 400 and nothing is spawned', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  const res = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: '   ', ...OK });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(spawnFn.calls.length, 0);
});

test('AC 11: the message goes to stdin and never appears in the argument list', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  const message = 'rm -rf / && echo "pwned" `whoami` $(id)';
  runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message, ...OK });

  const call = spawnFn.last();
  assert.equal(call.cmd, 'claude');
  assert.ok(!call.args.some((a) => a.includes('pwned')), 'the message must not reach argv');
  assert.deepEqual(call.child.stdinWrites, [message]);
  assert.equal(call.child.stdinEnded, true);
});

test('AC 11: the child runs with cwd set to the project path', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  runs.startRun({ projectId: 'p', projectPath: 'D:\\Work\\thing', sessionId: VALID_SID, message: 'hi', ...OK });
  assert.equal(spawnFn.last().options.cwd, 'D:\\Work\\thing');
  assert.equal(spawnFn.last().options.shell, true);
});

test('AC 13: a run reports done with the parsed result and session id', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  const started = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: 'hi', ...OK });
  assert.equal(started.run.state, 'running');

  spawnFn.last().child.finish(0, JSON.stringify({ session_id: VALID_SID, result: 'hello', is_error: false, duration_ms: 1234 }));
  const run = runs.get(started.run.runId);
  assert.equal(run.state, 'done');
  assert.equal(run.result, 'hello');
  assert.equal(run.resultSessionId, VALID_SID);
  assert.equal(run.durationMs, 1234);
  assert.equal(run.exitCode, 0);
});

test('AC 12: a new conversation returns the session id claude reports', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  const started = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: null, message: 'hi', ...OK });
  spawnFn.last().child.finish(0, JSON.stringify({ session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', result: 'ok' }));
  assert.equal(runs.get(started.run.runId).resultSessionId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
});

test('AC 13: a non-zero exit fails the run and keeps stderr verbatim', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  const started = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: 'hi', ...OK });
  spawnFn.last().child.finish(1, '', 'Invalid API key · Please run /login');
  const run = runs.get(started.run.runId);
  assert.equal(run.state, 'failed');
  assert.equal(run.error, 'Invalid API key · Please run /login');
  assert.equal(run.stderr, 'Invalid API key · Please run /login');
});

test('AC 13: exit 0 with unparsable stdout fails, and the raw output is kept', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  const started = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: 'hi', ...OK });
  spawnFn.last().child.finish(0, 'not json at all');
  const run = runs.get(started.run.runId);
  assert.equal(run.state, 'failed');
  assert.equal(run.stdout, 'not json at all');
});

test('AC 13: a second send while a run is active on that session returns 409', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: 'first', ...OK });
  const second = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: 'second', ...OK });
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(spawnFn.calls.length, 1);
});

test('AC 13: the session frees up once the run finishes', () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn });
  runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: 'first', ...OK });
  spawnFn.last().child.finish(0, JSON.stringify({ session_id: VALID_SID, result: 'done' }));
  assert.equal(runs.isSessionBusy(VALID_SID), false);
  const second = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: 'second', ...OK });
  assert.equal(second.ok, true);
});

test('AC 13: the hard timeout kills the child and fails the run', async () => {
  const spawnFn = fakeSpawn();
  const runs = createRunRegistry({ spawnFn, timeoutMs: 10 });
  const started = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: 'hi', ...OK });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const run = runs.get(started.run.runId);
  assert.equal(run.state, 'failed');
  assert.match(run.error, /timed out/);
  assert.equal(spawnFn.last().child.killed, true);
});

test('a spawn that throws is reported as a failed run rather than crashing the server', () => {
  const runs = createRunRegistry({ spawnFn: () => { throw new Error('spawn ENOENT claude'); } });
  const res = runs.startRun({ projectId: 'p', projectPath: 'D:\\p', sessionId: VALID_SID, message: 'hi', ...OK });
  assert.equal(res.ok, true);
  assert.equal(res.run.state, 'failed');
  assert.match(res.run.error, /ENOENT/);
});

test('the preview command is exactly what will be run', () => {
  const built = buildArgs({ sessionId: VALID_SID, ...OK, permissionMode: 'bypassPermissions' });
  assert.equal(
    previewCommand(built.args),
    `claude -p -r ${VALID_SID} --model claude-fable-5 --effort medium --output-format json --dangerously-skip-permissions`,
  );
});
