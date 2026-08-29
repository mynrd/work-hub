import { test, expect } from '@playwright/test';

import { goto, projectId, topbar, cardTitled, jobRow } from '../support/app.mjs';

test.beforeEach(async ({ page }) => {
  await goto(page, '#/');
  await goto(page, `#/p/${await projectId(page, 'proj-a')}`);
  await expect(page.locator('.page-head h1')).toHaveText('proj-a');
});

test('jobs land in the group their progress.json puts them in', async ({ page }) => {
  await expect(cardTitled(page, 'Worked today')).toContainText('A job touched today');
  await expect(cardTitled(page, 'Not yet started')).toContainText('Planned but never built');
  await expect(cardTitled(page, 'Others')).toContainText('Built a while ago');

  // Each card's badge is its own filtered row count.
  await expect(cardTitled(page, 'Worked today').locator('.card__head .badge')).toHaveText('1');
  await expect(cardTitled(page, 'Not yet started').locator('.card__head .badge')).toHaveText('1');
});

test('a job row shows its id, status, step and AC progress', async ({ page }) => {
  const row = jobRow(page, 'A job touched today');
  await expect(row).toHaveCount(1);
  await expect(row.locator('td[data-label="Job"]')).toHaveText('2026-08-29-worked-today');
  await expect(row.locator('td[data-label="Status"] .badge')).toHaveText('in_progress');
  await expect(row.locator('td[data-label="Step"]')).toHaveText('build');
  await expect(row.locator('td[data-label="AC"]')).toHaveText('1 pass / 3 total · 1 implemented');
});

test('an unreadable job folder is listed with its reason, not silently dropped', async ({ page }) => {
  const card = cardTitled(page, 'Unreadable');
  await expect(card.locator('.card__head .badge')).toHaveText('2');
  await expect(card).toContainText('2020-03-03-broken');
  await expect(card).toContainText('2020-04-04-no-progress');
});

test('an unknown status renders verbatim rather than being normalised away', async ({ page }) => {
  await expect(jobRow(page, 'Built a while ago').locator('td[data-label="Status"] .badge'))
    .toHaveText('some-status-nobody-documented');
});

test('search filters job rows across every group', async ({ page }) => {
  await topbar(page).search.fill('touched today');
  await expect(page.locator('tr[data-folder]')).toHaveCount(1);
  await expect(cardTitled(page, 'Not yet started')).toContainText('No jobs match your search');

  await topbar(page).search.fill('');
  await expect(page.locator('tr[data-folder]').first()).toBeVisible();
});

test('Refresh re-scans this folder and restores the button', async ({ page }) => {
  const btn = page.locator('#projectRefreshBtn');
  await btn.click();
  await expect(page.locator('#projectRefreshLabel')).toHaveText('Refresh');
  await expect(btn).toBeEnabled();
  await expect(cardTitled(page, 'Worked today')).toContainText('A job touched today');
});

test('the conversations card lists the session for this folder', async ({ page }) => {
  const card = cardTitled(page, 'Conversations');
  const rows = card.locator('a.sess__row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.sess__title .txt')).toHaveText('Fixture session title');
  // The meta strip is the short id, the message count, and when it last changed.
  await expect(rows.first().locator('.sess__meta')).toContainText('11111111');
});

/* The Terminal button is asserted but never clicked. `openTerminal()` is not
   injectable, so a click would run `cmd /c start` and open a real console
   window on whatever machine the suite is running on. */
test('the Terminal button is present and says what it will run', async ({ page }) => {
  const btn = page.locator('#terminalBtn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('title', /claude remote-control --spawn same-dir/);
});

test('New goes to the new-conversation route', async ({ page }) => {
  await page.locator('#newConvBtn').click();
  await expect(page.locator('.page-head h1')).toHaveText('New conversation');
  expect(page.url()).toContain('/s/new');
});

test('a folder with no .work and no transcripts shows both empty states', async ({ page }) => {
  await goto(page, '#/');
  await goto(page, `#/p/${await projectId(page, 'proj-empty')}`);
  await expect(page.locator('.page-head h1')).toHaveText('proj-empty');
  await expect(cardTitled(page, 'Worked today')).toContainText('Nothing has been touched today');
  await expect(cardTitled(page, 'Conversations')).toContainText('Claude Code has never run with this folder');
});

test('a project id that is not configured explains itself instead of hanging', async ({ page }) => {
  await goto(page, '#/p/not-a-configured-project');
  await expect(page.locator('#app')).toContainText('No configured project with id');
});
