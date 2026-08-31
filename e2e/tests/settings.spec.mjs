import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { goto, cardTitled, project } from '../support/app.mjs';

test.beforeEach(async ({ page }) => {
  await goto(page, '#/settings');
  await expect(page.locator('.page-head h1')).toHaveText('Settings');
});

test('the page names the file it writes', async ({ page }) => {
  await expect(page.locator('.page-head .mono')).toContainText(path.join('.work-hub', 'config.json'));
});

test('every configured folder is listed with a Remove button', async ({ page }) => {
  const rows = cardTitled(page, 'Monitored folders').locator('tbody tr');
  await expect(rows.filter({ hasText: 'proj-a' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'proj-empty' })).toHaveCount(1);
  await expect(rows.first().locator('button[data-remove]')).toHaveText('Remove');
});

test('the composer defaults show what the config holds', async ({ page }) => {
  await expect(page.locator('#defModel')).toHaveValue('opus');
  await expect(page.locator('#defEffort')).toHaveValue('high');
  await expect(page.locator('#defPerm')).toHaveValue('default');
  await expect(page.locator('#defInterval')).toHaveValue('0');

  // The selects offer exactly the server's allowlists, nothing hand-written.
  const models = await page.locator('#defModel option').allTextContents();
  expect(models).toContain('opus');
  expect(models).toContain('sonnet');
  expect(await page.locator('#defPerm option').allTextContents())
    .toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
});

test('a path that is not a folder is refused, with the reason', async ({ page }) => {
  await page.locator('#newProjectInput').fill(path.join(os.tmpdir(), 'definitely-not-a-real-folder-xyz'));
  await page.locator('#addProjectBtn').click();
  // Add folder opens the name dialog first; the refusal comes from the save.
  await expect(page.locator('#projectNameOverlay')).toHaveClass(/is-open/);
  await page.locator('#projectNameSaveBtn').click();
  await expect(page.locator('#settingsError')).toBeVisible();
  await expect(page.locator('#settingsError')).not.toBeEmpty();
});

test('an empty path is refused before anything is sent', async ({ page }) => {
  const puts = [];
  page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });
  await page.locator('#addProjectBtn').click();
  await expect(page.locator('#settingsError')).toHaveText('Enter a folder path.');
  expect(puts).toEqual([]);
});

/* Everything below writes the shared config.json, so it runs once, in order, on
   one worker. Both viewport projects drive ONE server: two workers adding
   folders at the same time would clobber each other's read-modify-write, and
   the missing-folder state below would race whatever else was reading it. The
   layout of this page is covered on mobile by the read-only specs above. */
test.describe('config state', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(({ }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'config writes run once, on desktop only');
  });

  test('a folder can be added and removed again', async ({ page }) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-e2e-added-'));
    const rows = cardTitled(page, 'Monitored folders').locator('tbody tr');
    const before = await rows.count();

    try {
      await page.locator('#newProjectInput').fill(folder);
      await page.locator('#addProjectBtn').click();
      // Add folder now opens the name dialog rather than saving straight away;
      // the default name (the folder's basename) is accepted as-is.
      await expect(page.locator('#projectNameOverlay')).toHaveClass(/is-open/);
      await expect(page.locator('#projectNameInput')).toHaveValue(path.basename(folder));
      await page.locator('#projectNameSaveBtn').click();
      await expect(rows).toHaveCount(before + 1);
      await expect(rows.filter({ hasText: path.basename(folder) })).toHaveCount(1);

      // It is a real project now: the dashboard picks it up too.
      await goto(page, '#/');
      await expect(cardTitled(page, 'Projects')).toContainText(path.basename(folder));

      await goto(page, '#/settings');
      await rows.filter({ hasText: path.basename(folder) }).locator('button[data-remove]').click();
      await expect(rows).toHaveCount(before);
      await expect(rows.filter({ hasText: path.basename(folder) })).toHaveCount(0);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  test('saving the defaults persists them across a reload', async ({ page }) => {
    await page.locator('#defModel').selectOption('sonnet');
    await page.locator('#defEffort').selectOption('medium');
    await page.locator('#saveDefaultsBtn').click();
    await expect(page.locator('#defaultsSaved')).toBeVisible();

    await page.reload();
    await expect(page.locator('#defModel')).toHaveValue('sonnet');
    await expect(page.locator('#defEffort')).toHaveValue('medium');

    // Put it back, so the composer specs still see the documented defaults.
    await page.locator('#defModel').selectOption('opus');
    await page.locator('#defEffort').selectOption('high');
    await page.locator('#saveDefaultsBtn').click();
    await expect(page.locator('#defaultsSaved')).toBeVisible();
  });

  /* KNOWN, PRE-DATES THE CLIENT SPLIT. `PUT /api/config` validates every path in
     the list it is handed and rejects the whole write if any one of them fails.
     The page always submits the full list, so while a configured folder is
     missing - deleted, or an unplugged drive - no other setting can be saved.

     Removing the dead entry itself still works, because that request is the one
     list that does not contain it. So this is a nuisance, not a lockout: fix the
     dead entry first and everything else starts saving again.

     Asserted rather than fixed - which paths a PUT may reject is a server-side
     decision, not a cleanup. This test is what fails when that decision is made. */
  test('while a folder is missing, other settings cannot be saved - but it can be removed', async ({ page }) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-e2e-vanishing-'));
    const name = path.basename(folder);
    const rows = cardTitled(page, 'Monitored folders').locator('tbody tr');
    const before = await rows.count();
    let added = false;

    try {
      await page.locator('#newProjectInput').fill(folder);
      await page.locator('#addProjectBtn').click();
      await page.locator('#projectNameSaveBtn').click();
      await expect(rows).toHaveCount(before + 1);
      added = true;

      // It disappears from under the running server.
      fs.rmSync(folder, { recursive: true, force: true });

      await goto(page, '#/');
      const card = cardTitled(page, 'Projects').locator('.proj', { hasText: name });
      await expect(card).toHaveClass(/is-missing/);
      await expect(card.locator('.badge')).toHaveText('folder is missing');

      // Saving anything else resubmits the dead path along with the change.
      await goto(page, '#/settings');
      await page.locator('#defEffort').selectOption('low');
      await page.locator('#saveDefaultsBtn').click();
      await expect(page.locator('#settingsError')).toContainText(name);
      await expect(page.locator('#settingsError')).toContainText('does not exist');
      await expect(page.locator('#defaultsSaved')).toBeHidden();

      // Adding another folder is refused for the same reason.
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hub-e2e-other-'));
      try {
        await page.locator('#newProjectInput').fill(other);
        await page.locator('#addProjectBtn').click();
        await page.locator('#projectNameSaveBtn').click();
        await expect(page.locator('#settingsError')).toContainText(name);
        await expect(rows).toHaveCount(before + 1);
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }

      // Removing the dead entry is the one write that goes through: its own
      // request is the only list that does not carry the missing path.
      await rows.filter({ hasText: name }).locator('button[data-remove]').click();
      await expect(rows).toHaveCount(before);
      added = false;

      // And with it gone, saving works again.
      await page.locator('#defEffort').selectOption('low');
      await page.locator('#saveDefaultsBtn').click();
      await expect(page.locator('#defaultsSaved')).toBeVisible();
    } finally {
      if (added) {
        fs.mkdirSync(folder, { recursive: true });
        await goto(page, '#/settings');
        await rows.filter({ hasText: name }).locator('button[data-remove]').click();
        await expect(rows).toHaveCount(before);
      }
      fs.rmSync(folder, { recursive: true, force: true });
      // Put the documented default back for whatever runs next.
      await goto(page, '#/settings');
      await page.locator('#defEffort').selectOption('high');
      await page.locator('#saveDefaultsBtn').click();
      await expect(page.locator('#defaultsSaved')).toBeVisible();
    }
  });
});

/* The new-folder input's directory suggestions and the project-name dialog.
   Both GET /api/fs/dirs and the config PUT are stubbed, so - unlike the
   "config state" block above - nothing here touches the real config.json and
   both viewport projects can run it in parallel. */
test.describe('directory suggestions and the name dialog', () => {
  const input = (page) => page.locator('#newProjectInput');
  const suggest = (page) => page.locator('#projectSuggest');
  const nameDialog = (page) => ({
    overlay: page.locator('#projectNameOverlay'),
    input: page.locator('#projectNameInput'),
    save: page.locator('#projectNameSaveBtn'),
    cancel: page.locator('#projectNameCancelBtn'),
  });

  async function stubDirs(page, dirs) {
    await page.route('**/api/fs/dirs*', async (route) => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dirs }) });
    });
  }

  test('suggestions appear after a trailing separator and filter as you type', async ({ page }) => {
    await stubDirs(page, ['alpha', 'alpha-two', 'beta']);
    await input(page).fill('D:\\Work\\');
    await expect(suggest(page).locator('.suggest-list__item')).toHaveCount(3);
    await expect(suggest(page).locator('.suggest-list__item')).toHaveText(['alpha', 'alpha-two', 'beta']);

    await input(page).fill('D:\\Work\\al');
    await expect(suggest(page).locator('.suggest-list__item')).toHaveText(['alpha', 'alpha-two']);
  });

  test('ArrowDown then Enter inserts the highlighted folder and a separator, without adding a project', async ({ page }) => {
    await stubDirs(page, ['alpha', 'beta']);
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });

    await input(page).fill('D:\\Work\\');
    await expect(suggest(page).locator('.suggest-list__item')).toHaveCount(2);
    await input(page).press('ArrowDown'); // moves off the default first item onto "beta"
    await input(page).press('Enter');

    await expect(input(page)).toHaveValue('D:\\Work\\beta\\');
    await expect(suggest(page)).toBeHidden();
    expect(puts).toEqual([]);
  });

  test('clicking a suggestion inserts it and a separator, the same as Enter', async ({ page }) => {
    await stubDirs(page, ['alpha', 'beta']);
    await input(page).fill('D:\\Work\\');
    await expect(suggest(page).locator('.suggest-list__item')).toHaveCount(2);
    await suggest(page).locator('.suggest-list__item', { hasText: 'beta' }).click();
    await expect(input(page)).toHaveValue('D:\\Work\\beta\\');
    await expect(suggest(page)).toBeHidden();
  });

  test('Escape closes the suggestion list', async ({ page }) => {
    await stubDirs(page, ['alpha', 'beta']);
    await input(page).fill('D:\\Work\\');
    await expect(suggest(page).locator('.suggest-list__item')).toHaveCount(2);
    await input(page).press('Escape');
    await expect(suggest(page)).toBeHidden();
  });

  test('Add folder opens the name dialog prefilled with the basename', async ({ page }) => {
    await input(page).fill('D:\\Work\\git\\mynrd\\some-repo');
    await page.locator('#addProjectBtn').click();
    const dlg = nameDialog(page);
    await expect(dlg.overlay).toHaveClass(/is-open/);
    await expect(dlg.input).toHaveValue('some-repo');
  });

  test('Save sends the folder and the chosen name to the config PUT, and adds the row', async ({ page }) => {
    const folder = 'D:\\Work\\git\\mynrd\\some-repo';
    let putBody = null;
    await page.route('**/api/config', async (route) => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      putBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(putBody) });
    });

    await input(page).fill(folder);
    await page.locator('#addProjectBtn').click();
    const dlg = nameDialog(page);
    await dlg.input.fill('Some Repo');
    await dlg.save.click();

    await expect(dlg.overlay).not.toHaveClass(/is-open/);
    expect(putBody.projects).toContain(folder);
    expect(putBody.projectNames[folder]).toBe('Some Repo');

    const rows = cardTitled(page, 'Monitored folders').locator('tbody tr');
    await expect(rows.filter({ hasText: 'some-repo' })).toHaveCount(1);
  });

  test('Cancel closes the dialog and saves nothing; Escape does the same', async ({ page }) => {
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });
    const dlg = nameDialog(page);

    await input(page).fill('D:\\Work\\git\\mynrd\\cancel-me');
    await page.locator('#addProjectBtn').click();
    await expect(dlg.overlay).toHaveClass(/is-open/);
    await dlg.cancel.click();
    await expect(dlg.overlay).not.toHaveClass(/is-open/);

    await input(page).fill('D:\\Work\\git\\mynrd\\escape-me');
    await page.locator('#addProjectBtn').click();
    await expect(dlg.overlay).toHaveClass(/is-open/);
    await page.keyboard.press('Escape');
    await expect(dlg.overlay).not.toHaveClass(/is-open/);

    expect(puts).toEqual([]);
    const rows = cardTitled(page, 'Monitored folders').locator('tbody tr');
    await expect(rows.filter({ hasText: 'cancel-me' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'escape-me' })).toHaveCount(0);
  });
});
