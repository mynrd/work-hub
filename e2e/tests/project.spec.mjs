import { test, expect } from '@playwright/test';

import { goto, project, projectId, topbar, cardTitled, jobRow, projectTabs, gitPane, othersFind } from '../support/app.mjs';

test.beforeEach(async ({ page }) => {
  await goto(page, '#/');
  await goto(page, `#/p/${await projectId(page, 'proj-a')}`);
  await expect(page.locator('.page-head h1')).toHaveText('proj-a');
});

test('the page shows four tabs with Work Items active by default', async ({ page }) => {
  const tabs = projectTabs(page);
  await expect(page.locator('#projectTabs .tab')).toHaveText(['Work Items', 'Conversation', 'Branch and Commits', 'Terminal']);
  await expect(tabs.tab('work')).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.tab('conversation')).toHaveAttribute('aria-selected', 'false');
  await expect(tabs.tab('git')).toHaveAttribute('aria-selected', 'false');
  // The work pane is the one actually in the DOM - the others are not built until selected.
  await expect(cardTitled(page, 'Worked today')).toBeVisible();
  await expect(page.locator('.sess')).toHaveCount(0);
});

test('switching to Conversation shows the sessions card and leaves it selected across a repaint', async ({ page }) => {
  const tabs = projectTabs(page);
  await tabs.tab('conversation').click();
  await expect(tabs.tab('conversation')).toHaveAttribute('aria-selected', 'true');
  await expect(cardTitled(page, 'Conversations')).toBeVisible();
  await expect(page.locator('.table-wrap')).toHaveCount(0);

  // Same code path the 30s auto-refresh timer runs: loadJobs + loadSessions,
  // then renderCurrentPage. The tab lives in state, not in the rebuilt DOM, so
  // it survives the repaint.
  await page.locator('#projectRefreshBtn').click();
  await expect(page.locator('#projectRefreshLabel')).toHaveText('Refresh');
  await expect(tabs.tab('conversation')).toHaveAttribute('aria-selected', 'true');
  await expect(cardTitled(page, 'Conversations')).toBeVisible();
});

test('the Branch and Commits tab lists Current changes, staged/unstaged/untracked', async ({ page }) => {
  const git = gitPane(page);
  await projectTabs(page).tab('git').click();
  await expect(git.root).toBeVisible();

  const currentChanges = cardTitled(page, 'Current changes');
  await expect(currentChanges).toContainText('Staged changes');
  await expect(git.currentFileRow('staged', 'README.md')).toContainText('modified');

  await expect(currentChanges).toContainText('Changes');
  await expect(git.currentFileRow('unstaged', 'CHANGELOG.md')).toContainText('modified');
  await expect(git.currentFileRow('untracked', 'untracked-note.txt')).toContainText('new');
});

test('the branch selector lists local branches with the current one marked and pre-selected', async ({ page }) => {
  const git = gitPane(page);
  await projectTabs(page).tab('git').click();
  await expect(git.branchSelect).toBeVisible();
  await expect(git.branchSelect.locator('option')).toHaveText(['feature-branch', 'main (current)']);
  await expect(git.branchSelect).toHaveValue('main');
});

test('commits for the selected branch are listed newest first with sha, subject, author, and when', async ({ page }) => {
  const git = gitPane(page);
  await projectTabs(page).tab('git').click();
  const commits = cardTitled(page, 'Branches and commits');
  const rows = commits.locator('.git-commit-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Add a changelog entry');
  await expect(rows.nth(0)).toContainText('Work Hub Fixture');
  await expect(rows.nth(1)).toContainText('Initial import of the fixture project');
});

test('clicking a commit lists its changed files, and clicking one opens a before/after compare', async ({ page }) => {
  const git = gitPane(page);
  await projectTabs(page).tab('git').click();
  await git.commitRow('Add a changelog entry').click();

  const fileRow = git.commitFileRow('CHANGELOG.md');
  await expect(fileRow).toContainText('modified');

  await fileRow.click();
  await expect(git.backBtn).toBeVisible();
  await expect(git.comparePane('before')).not.toContainText('Second entry');
  await expect(git.comparePane('after')).toContainText('Second entry');

  await git.backBtn.click();
  await expect(git.backBtn).toHaveCount(0);
  await expect(git.commitFileRow('CHANGELOG.md')).toBeVisible();
});

test('clicking a file under Current changes opens the same before/after compare view', async ({ page }) => {
  const git = gitPane(page);
  await projectTabs(page).tab('git').click();

  // Unstaged: the index (committed content) vs the file on disk.
  await git.currentFileRow('unstaged', 'CHANGELOG.md').click();
  await expect(git.comparePane('before')).not.toContainText('Unstaged entry');
  await expect(git.comparePane('after')).toContainText('Unstaged entry');
  await git.backBtn.click();

  // Untracked: an empty before against the file on disk.
  await git.currentFileRow('untracked', 'untracked-note.txt').click();
  await expect(git.comparePane('before')).toContainText('(empty)');
  await expect(git.comparePane('after')).toContainText('not committed');
});

test('the Branch and Commits tab shows a plain message for a folder that is not a git repository', async ({ page }) => {
  await goto(page, '#/');
  await goto(page, `#/p/${await projectId(page, 'proj-empty')}`);
  await projectTabs(page).tab('git').click();
  await expect(page.locator('#gitPane')).toContainText('Not a git repository.');
  await expect(page.locator('#gitBranchSelect')).toHaveCount(0);
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
  // One Job / Title cell: the id on the first line, the title under it.
  const cell = row.locator('td[data-label="Job / Title"]');
  await expect(cell).toHaveCount(1);
  await expect(cell.locator('.cell-job__id')).toHaveText('2026-08-29-worked-today');
  await expect(cell.locator('.cell-job__title')).toHaveText('A job touched today');
  await expect(row.locator('td[data-label="Job"]')).toHaveCount(0);
  await expect(row.locator('td[data-label="Title"]')).toHaveCount(0);
  await expect(page.locator('table.table--stack thead th', { hasText: /^Job \/ Title$/ }).first()).toBeAttached();
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

/* The Others card carries its own search box - that group is the long tail,
   and the topbar search filters all three tables at once. */
test('only the Others card has an in-card search box', async ({ page }) => {
  await expect(cardTitled(page, 'Others').locator('#jobFind')).toHaveCount(1);
  await expect(cardTitled(page, 'Worked today').locator('.sess-find')).toHaveCount(0);
  await expect(cardTitled(page, 'Not yet started').locator('.sess-find')).toHaveCount(0);
});

test('typing in the Others search filters that table, its badge and its match count', async ({ page }) => {
  const find = othersFind(page);
  await find.input.fill('awaiting');

  const rows = cardTitled(page, 'Others').locator('tr[data-folder]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Green and awaiting verification');
  await expect(cardTitled(page, 'Others').locator('.card__head .badge')).toHaveText('1');
  await expect(find.count).toHaveText('1 match');
  // The other cards are untouched - this box is not the topbar.
  await expect(cardTitled(page, 'Worked today')).toContainText('A job touched today');
});

test('an Others search that matches nothing shows the empty state, box included', async ({ page }) => {
  const find = othersFind(page);
  await find.input.fill('zzz-no-such-job');
  await expect(cardTitled(page, 'Others')).toContainText('No jobs match your search');
  // The box has to survive the empty state, or the filter cannot be cleared.
  await expect(find.input).toHaveValue('zzz-no-such-job');
});

test('the Others clear button empties the filter', async ({ page }) => {
  const find = othersFind(page);
  await find.input.fill('resolved');
  await expect(find.clear).toBeVisible();

  await find.clear.click();
  await expect(find.input).toHaveValue('');
  await expect(find.clear).toHaveCount(0);
  await expect(cardTitled(page, 'Others').locator('tr[data-folder]')).toHaveCount(3);
});

test('the Others search and the topbar search both have to match', async ({ page }) => {
  const find = othersFind(page);
  const rows = cardTitled(page, 'Others').locator('tr[data-folder]');

  await topbar(page).search.fill('a');
  await find.input.fill('resolved');
  await expect(rows).toHaveCount(1);

  await topbar(page).search.fill('awaiting');
  await expect(find.input).toHaveValue('resolved');
  await expect(cardTitled(page, 'Others')).toContainText('No jobs match your search');

  await topbar(page).search.fill('');
  await othersFind(page).input.fill('');
  await expect(rows).toHaveCount(3);
});

test('the Others search text and caret survive a repaint', async ({ page }) => {
  const find = othersFind(page);
  await find.input.fill('resol');

  // dispatchEvent, not click: a real click moves focus to the button, which is
  // the reader leaving the box on purpose. What has to survive is the repaint
  // the 30s timer causes, and this fires exactly that handler.
  await page.locator('#projectRefreshBtn').dispatchEvent('click');
  await expect(page.locator('#projectRefreshLabel')).toHaveText('Refresh');

  await expect(othersFind(page).input).toHaveValue('resol');
  await expect(othersFind(page).input).toBeFocused();
  await expect(cardTitled(page, 'Others').locator('tr[data-folder]')).toHaveCount(1);
});

test('the Others search is per project', async ({ page }) => {
  await othersFind(page).input.fill('resolved');
  await expect(cardTitled(page, 'Others').locator('tr[data-folder]')).toHaveCount(1);

  await goto(page, `#/p/${await projectId(page, 'proj-empty')}`);
  await expect(page.locator('.page-head h1')).toHaveText('proj-empty');
  // proj-empty has no .work at all, so the card may be all empty state - what
  // matters is that proj-a's text did not follow it here.
  const emptyFind = othersFind(page).input;
  if (await emptyFind.count()) await expect(emptyFind).toHaveValue('');

  await goto(page, `#/p/${await projectId(page, 'proj-a')}`);
  await expect(othersFind(page).input).toHaveValue('resolved');
});

test('Refresh re-scans this folder and restores the button', async ({ page }) => {
  const btn = page.locator('#projectRefreshBtn');
  await btn.click();
  await expect(page.locator('#projectRefreshLabel')).toHaveText('Refresh');
  await expect(btn).toBeEnabled();
  await expect(cardTitled(page, 'Worked today')).toContainText('A job touched today');
});

test('the conversations card lists the session for this folder', async ({ page }) => {
  await projectTabs(page).tab('conversation').click();
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
  await projectTabs(page).tab('conversation').click();
  const btn = page.locator('#terminalBtn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('title', /claude remote-control --spawn same-dir/);
});

test('New goes to the new-conversation route', async ({ page }) => {
  await projectTabs(page).tab('conversation').click();
  await page.locator('#newConvBtn').click();
  await expect(page.locator('.page-head h1')).toHaveText('New conversation');
  expect(page.url()).toContain('/s/new');
});

test('a folder with no .work and no transcripts shows both empty states', async ({ page }) => {
  await goto(page, '#/');
  await goto(page, `#/p/${await projectId(page, 'proj-empty')}`);
  await expect(page.locator('.page-head h1')).toHaveText('proj-empty');
  await expect(cardTitled(page, 'Worked today')).toContainText('Nothing has been touched today');

  await projectTabs(page).tab('conversation').click();
  await expect(cardTitled(page, 'Conversations')).toContainText('Claude Code has never run with this folder');
});

test('a project id that is not configured explains itself instead of hanging', async ({ page }) => {
  await goto(page, '#/p/not-a-configured-project');
  await expect(page.locator('#app')).toContainText('No configured project with id');
});

/* Renaming from the h1. The config PUT (and, where the new name needs to show
   up in the h1, the dashboard GET that follows it) are stubbed, so - like
   Settings' "directory suggestions and the name dialog" block - nothing here
   touches the real config.json and both viewport projects can run it in
   parallel. */
test.describe('renaming a project from its title', () => {
  const dlg = (page) => ({
    overlay: page.locator('#projectRenameOverlay'),
    input: page.locator('#projectRenameInput'),
    save: page.locator('#projectRenameSaveBtn'),
    cancel: page.locator('#projectRenameCancelBtn'),
  });

  test('clicking the title opens the editor prefilled with the current display name', async ({ page }) => {
    await page.locator('#projectNameBtn').click();
    const d = dlg(page);
    await expect(d.overlay).toHaveClass(/is-open/);
    await expect(d.input).toHaveValue('proj-a');
  });

  test('Save sends the new name keyed by the project path, and the h1 updates', async ({ page }) => {
    const projectPath = (await project(page, 'proj-a')).path;
    let putBody = null;
    await page.route('**/api/config', async (route) => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      putBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(putBody) });
    });
    // The stubbed PUT never actually rewrites config.json, so the dashboard
    // reload after it would still answer with the old name unless this is
    // stubbed too - it echoes back the same dashboard with just this one
    // project's name swapped, the way the real server would after that PUT.
    await page.route('**/api/dashboard', async (route) => {
      const dash = await (await route.fetch()).json();
      dash.projects = dash.projects.map((p) => (p.path === projectPath ? { ...p, name: 'Renamed Project' } : p));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dash) });
    });

    await page.locator('#projectNameBtn').click();
    const d = dlg(page);
    await d.input.fill('Renamed Project');
    await d.save.click();

    await expect(d.overlay).not.toHaveClass(/is-open/);
    expect(putBody.projectNames[projectPath]).toBe('Renamed Project');
    await expect(page.locator('.page-head h1')).toHaveText('Renamed Project');
  });

  test('saving an empty name sends a PUT without that key, so the display falls back to the basename', async ({ page }) => {
    const projectPath = (await project(page, 'proj-a')).path;
    let putBody = null;
    await page.route('**/api/config', async (route) => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      putBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(putBody) });
    });

    await page.locator('#projectNameBtn').click();
    const d = dlg(page);
    await d.input.fill('');
    await d.save.click();

    await expect(d.overlay).not.toHaveClass(/is-open/);
    expect(putBody.projectNames).not.toHaveProperty(projectPath);
  });

  test('Cancel and Escape close the editor and save nothing', async ({ page }) => {
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });
    const d = dlg(page);

    await page.locator('#projectNameBtn').click();
    await expect(d.overlay).toHaveClass(/is-open/);
    await d.cancel.click();
    await expect(d.overlay).not.toHaveClass(/is-open/);

    await page.locator('#projectNameBtn').click();
    await expect(d.overlay).toHaveClass(/is-open/);
    await page.keyboard.press('Escape');
    await expect(d.overlay).not.toHaveClass(/is-open/);

    expect(puts).toEqual([]);
    await expect(page.locator('.page-head h1')).toHaveText('proj-a');
  });
});
