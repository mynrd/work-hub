import { test, expect } from '@playwright/test';

import { goto, projectId, composer, cardTitled } from '../support/app.mjs';
import { FIXTURE_SESSION_ID } from '../support/env.mjs';

async function openSession(page) {
  await goto(page, '#/');
  const pid = await projectId(page, 'proj-a');
  await goto(page, `#/p/${pid}/s/${FIXTURE_SESSION_ID}`);
  await expect(page.locator('.chat')).toBeVisible();
  return pid;
}

test('the transcript renders, titled by the session', async ({ page }) => {
  await openSession(page);
  await expect(page.locator('.page-head h1')).toHaveText('Fixture session title');
  await expect(page.locator('.page-head p.mono')).toContainText('11111111');
  await expect(page.locator('.chat .msg').first()).toBeVisible();
});

test('user and assistant turns are labelled and styled apart', async ({ page }) => {
  await openSession(page);
  await expect(page.locator('.msg--user').first().locator('.msg__head')).toContainText('You');
  await expect(page.locator('.msg--assistant').first().locator('.msg__head')).toContainText('Claude');
  await expect(page.locator('.chat')).toContainText('First real prompt from the human');
  await expect(page.locator('.chat')).toContainText('Here is the answer.');
});

test('thinking and tool blocks collapse, and open on click', async ({ page }) => {
  await openSession(page);
  const thinking = page.locator('details.tool--thinking').first();
  await expect(thinking).toBeVisible();
  await expect(thinking.locator('.tool__body')).toBeHidden();
  await thinking.locator('summary').click();
  await expect(thinking.locator('.tool__body')).toContainText('Let me consider this.');
});

test('nothing in the transcript is dropped, however odd its shape', async ({ page }) => {
  await openSession(page);
  const chat = page.locator('.chat');
  // A record type and a block type that did not exist when the parser was written
  // both fall through to a raw block rather than vanishing.
  await expect(chat).toContainText('a-record-type-that-did-not-exist-when-this-was-written');
  await expect(chat).toContainText('a_block_type_from_the_future');
  // The compact boundary and the summary that follows it are both marked.
  await expect(chat).toContainText('Compacted');
  await expect(page.locator('.msg--compact')).toHaveCount(1);
});

test('slash commands and IDE context render as chips, not raw tags', async ({ page }) => {
  await openSession(page);
  const chat = page.locator('.chat');
  await expect(chat.locator('.cmd-block .cmd-name').first()).toHaveText('/clear');
  await expect(chat.locator('.ctx-row', { hasText: 'Opened file' })).toContainText('a.ts');
  await expect(chat.locator('.ctx-row', { hasText: 'src/index.ts' })).toContainText('42 lines');
  // The tag markup itself must never leak into the body.
  await expect(chat).not.toContainText('<command-name>');
  await expect(chat).not.toContainText('<ide_opened_file>');
});

/* A sidechain (subagent) turn is excluded from the session's message COUNT by
   listSessions, but readSessionChat still returns it, flagged `isSidechain`.
   The client renders it and ignores the flag, so it reads as a main-thread
   turn. Asserted as-is because that is the shipped behaviour; if the flag ever
   grows a style, this is the test that will say so. */
test('a subagent turn is rendered, and carries the model that produced it', async ({ page }) => {
  await openSession(page);
  const chat = page.locator('.chat');
  await expect(chat).toContainText('Subagent turn spliced in');
  await expect(chat.locator('.msg', { hasText: 'Subagent turn spliced in' }).locator('.msg__head'))
    .toContainText('haiku-4-5');
});

test('the composer preview is the exact command a send would run', async ({ page }) => {
  await openSession(page);
  const c = composer(page);
  await expect(c.preview).toHaveText(
    `claude -p -r ${FIXTURE_SESSION_ID} --model opus --effort high --output-format json`,
  );

  await c.model.selectOption('sonnet');
  await c.effort.selectOption('low');
  await expect(c.preview).toHaveText(
    `claude -p -r ${FIXTURE_SESSION_ID} --model sonnet --effort low --output-format json`,
  );

  // Each permission mode maps to its own flags - or to none at all.
  await c.permission.selectOption('acceptEdits');
  await expect(c.preview).toContainText('--permission-mode acceptEdits');
  await c.permission.selectOption('bypassPermissions');
  await expect(c.preview).toContainText('--dangerously-skip-permissions');
  await c.permission.selectOption('default');
  await expect(c.preview).not.toContainText('--permission-mode');
});

test('the open conversation is marked active in the list beside it', async ({ page }) => {
  await openSession(page);
  const active = cardTitled(page, 'Conversations').locator('a.sess__row.is-active');
  await expect(active).toHaveCount(1);
  await expect(active).toContainText('Fixture session title');
});

test('Send is refused while the box is empty', async ({ page }) => {
  await openSession(page);
  const c = composer(page);
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/sessions')) posts.push(r.url()); });
  await c.send.click();
  await expect(c.text).toBeEditable();
  expect(posts).toEqual([]);
});

/* Sending goes through a stubbed spawn - see support/stubs.mjs. No `claude`
   process ever starts, and nothing is written into the fixture folder.
   This uses the NEW conversation route on purpose: the run registry allows one
   run in flight per session id, so replying to the fixture session from the
   desktop and mobile projects at once would legitimately 409. */
test('a new conversation runs, reports progress, and lands on the session it created', async ({ page }) => {
  await goto(page, '#/');
  const pid = await projectId(page, 'proj-a');
  await goto(page, `#/p/${pid}/s/new`);
  await expect(page.locator('.page-head h1')).toHaveText('New conversation');

  const c = composer(page);
  await expect(c.preview).toHaveText('claude -p --model opus --effort high --output-format json');

  await c.text.fill('Do the thing, please.');
  await c.send.click();

  // In flight: the button reports it and the box is locked.
  await expect(c.send).toContainText('Running');
  await expect(c.text).toBeDisabled();
  await expect(c.status).toContainText('Running');

  // The stub reports the fixture session, so completion hops to that transcript.
  await expect(page).toHaveURL(new RegExp(`/s/${FIXTURE_SESSION_ID}$`), { timeout: 15_000 });
  await expect(page.locator('.page-head h1')).toHaveText('Fixture session title');
});

test('Ctrl+Enter sends and a bare Enter does not', async ({ page }) => {
  await goto(page, '#/');
  const pid = await projectId(page, 'proj-a');
  await goto(page, `#/p/${pid}/s/new`);

  const c = composer(page);
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/sessions')) posts.push(r.url()); });

  await c.text.fill('line one');
  await c.text.press('Enter');
  await expect(c.text).toHaveValue('line one\n');
  expect(posts, 'a bare Enter is a newline, these prompts run to several lines').toEqual([]);

  await c.text.press('Control+Enter');
  await expect(c.send).toContainText('Running');
  expect(posts).toHaveLength(1);
});
