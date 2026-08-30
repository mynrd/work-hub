import { test, expect } from '@playwright/test';

import { goto, projectId, detail, jobRow } from '../support/app.mjs';
import { RESOLVED_JOB } from '../support/env.mjs';

async function openJob(page, title) {
  await goto(page, '#/');
  await goto(page, `#/p/${await projectId(page, 'proj-a')}`);
  await jobRow(page, title).click();
  await expect(detail(page).overlay).toHaveClass(/is-open/);
}

test('a job row opens the dialog with that job in the header', async ({ page }) => {
  await openJob(page, 'A job touched today');
  const d = detail(page);
  await expect(d.title).toHaveText('A job touched today');
  await expect(page.locator('#detailIdLabel')).toHaveText('2026-08-29-worked-today');
  await expect(page.locator('#detailStatusBadge .badge')).toHaveText('in_progress');
  await expect(page.locator('#detailSubline')).toContainText('2026-08-29-worked-today');
});

test('the fixed header shows the meta pairs and the workflow track', async ({ page }) => {
  await openJob(page, 'A job touched today');
  await expect(page.locator('#detailMeta .kv__row')).toHaveCount(5);
  await expect(page.locator('#detailMeta')).toContainText('1 pass / 3 total');

  const steps = page.locator('#detailWorkflow .wf-step');
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText('intake');
  await expect(steps.nth(0).locator('.badge')).toHaveText('done');
  await expect(steps.nth(2)).toContainText('build');
  await expect(steps.nth(2).locator('.badge')).toHaveText('in_progress');
});

test('every tab carries its own count and swaps the visible panel', async ({ page }) => {
  await openJob(page, 'A job touched today');
  const d = detail(page);

  await expect(d.tab('ac').locator('.badge')).toHaveText('3');
  await expect(d.tab('tasks').locator('.badge')).toHaveText('1');
  await expect(d.tab('tests').locator('.badge')).toHaveText('1');
  await expect(d.tab('runs').locator('.badge')).toHaveText('1');
  await expect(d.tab('docs').locator('.badge')).toHaveText('2');

  // AC opens first, and it is the only visible panel.
  await expect(d.tab('ac')).toHaveClass(/is-active/);
  await expect(d.panel('ac')).toBeVisible();
  await expect(d.panel('tasks')).toBeHidden();

  for (const id of ['tasks', 'tests', 'runs', 'intake', 'raw', 'docs']) {
    await d.tab(id).click();
    await expect(d.panel(id)).toBeVisible();
    await expect(d.panel('ac')).toBeHidden();
    await expect(d.tab(id)).toHaveAttribute('aria-selected', 'true');
  }
});

test('arrow keys move between tabs', async ({ page }) => {
  await openJob(page, 'A job touched today');
  const d = detail(page);
  await d.tab('ac').click();
  await d.tab('ac').focus();
  await page.keyboard.press('ArrowRight');
  await expect(d.tab('intake')).toHaveClass(/is-active/);
  await page.keyboard.press('ArrowLeft');
  await expect(d.tab('ac')).toHaveClass(/is-active/);
});

test('each panel renders the part of progress.json it owns', async ({ page }) => {
  await openJob(page, 'A job touched today');
  const d = detail(page);

  const acRows = page.locator('#detailAc tbody tr');
  await expect(acRows).toHaveCount(3);
  await expect(acRows.nth(0)).toContainText('It works');
  await expect(acRows.nth(0).locator('td[data-label="Status"] .badge')).toHaveText('pass');
  await expect(acRows.nth(2).locator('td[data-label="Status"] .badge')).toHaveText('pending');

  await d.tab('tasks').click();
  await expect(page.locator('#detailTasks tbody tr')).toHaveCount(1);
  await expect(page.locator('#detailTasks')).toContainText('abc1234');

  await d.tab('tests').click();
  await expect(page.locator('#detailTests')).toContainText('node --test');
  await expect(page.locator('#detailTests')).toContainText('case one');
  await expect(page.locator('#detailTests')).toContainText('None recorded'); // the ui tier is null

  await d.tab('runs').click();
  await expect(page.locator('#detailRuns .run-card')).toHaveCount(1);
  await expect(page.locator('#detailRuns')).toContainText('round 1');

  await d.tab('intake').click();
  await expect(page.locator('#detailIntake')).toContainText('Do the thing');
  await expect(page.locator('#detailIntake')).toContainText('Because');
  await expect(page.locator('#detailIntake')).toContainText('how'); // an unknown

  await d.tab('raw').click();
  const raw = await page.locator('#detailRaw').textContent();
  expect(() => JSON.parse(raw)).not.toThrow();
  expect(JSON.parse(raw).id).toBe('2026-08-29-worked-today');
});

test('the Docs tab renders a markdown file through the server', async ({ page }) => {
  await openJob(page, 'A job touched today');
  await detail(page).tab('docs').click();

  const chips = page.locator('#mdTabs .chip');
  await expect(chips).toHaveCount(2);
  // PLAN.md is always listed first.
  await expect(chips.first()).toHaveText('PLAN.md');
  await expect(chips.first()).toHaveClass(/is-active/);
  await expect(page.locator('#mdContent')).not.toBeEmpty();

  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveClass(/is-active/);
  await expect(page.locator('#mdContent')).not.toContainText('Failed to load');
});

test('Maximise toggles fullscreen, and the state persists across a reload', async ({ page }) => {
  await openJob(page, 'A job touched today');
  const d = detail(page);
  await expect(d.modal).not.toHaveClass(/is-fullscreen/);

  await d.fullscreen.click();
  await expect(d.modal).toHaveClass(/is-fullscreen/);
  await expect(d.fullscreen).toHaveAttribute('aria-pressed', 'true');

  // The preference is applied at load, before any job is opened, so the class is
  // already on the modal by the time the next dialog is shown.
  await page.reload();
  await expect(d.modal).toHaveClass(/is-fullscreen/);

  await jobRow(page, 'A job touched today').click();
  await expect(d.overlay).toHaveClass(/is-open/);
  await expect(d.modal).toHaveClass(/is-fullscreen/);

  await d.fullscreen.click();
  await expect(d.modal).not.toHaveClass(/is-fullscreen/);
});

test('Read expands the Docs tab to fill the screen, and Escape backs out without losing the doc', async ({ page }) => {
  await openJob(page, 'A job touched today');
  const d = detail(page);
  await d.tab('docs').click();

  const chips = page.locator('#mdTabs .chip');
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveClass(/is-active/);

  await d.read.click();
  await expect(d.modal).toHaveClass(/is-reading/);
  // Scoped to the detail modal - '.modal__head' alone also matches the OTP dialog's head.
  await expect(d.modal.locator('.modal__head')).toBeHidden();
  await expect(page.locator('#detailTabs')).toBeHidden();
  await expect(page.locator('#mdTabs')).toBeVisible();
  await expect(page.locator('#mdContent')).toBeVisible();
  // The selected doc survives entering reader mode.
  await expect(chips.nth(1)).toHaveClass(/is-active/);

  // First Escape exits reader mode only - the dialog stays open on the same tab and doc.
  await page.keyboard.press('Escape');
  await expect(d.modal).not.toHaveClass(/is-reading/);
  await expect(d.overlay).toHaveClass(/is-open/);
  await expect(d.tab('docs')).toHaveClass(/is-active/);
  await expect(chips.nth(1)).toHaveClass(/is-active/);

  // Second Escape closes the dialog as it always has.
  await page.keyboard.press('Escape');
  await expect(d.overlay).not.toHaveClass(/is-open/);
});

test('Escape and the close button both close the dialog', async ({ page }) => {
  const d = detail(page);

  await openJob(page, 'A job touched today');
  await page.keyboard.press('Escape');
  await expect(d.overlay).not.toHaveClass(/is-open/);

  await jobRow(page, 'A job touched today').click();
  await expect(d.overlay).toHaveClass(/is-open/);
  await d.close.click();
  await expect(d.overlay).not.toHaveClass(/is-open/);
});

/* Wide only. Below 700px the dialog is full-bleed, so every pixel of the overlay
   is covered by the modal and there is no backdrop left to click - Escape and
   the close button are the way out there. */
test('a click on the backdrop closes the dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const d = detail(page);
  await openJob(page, 'A job touched today');
  await d.overlay.click({ position: { x: 4, y: 4 } });
  await expect(d.overlay).not.toHaveClass(/is-open/);
});

/* Resolve writes into a real repo's progress.json, so the UI arms it first and
   only the second click sends anything. These specs cover the gate, not the
   write - the write itself is covered by test/resolve-job.test.mjs, and
   confirming it here would mutate state the parallel projects share. */
test.describe('Resolve', () => {
  test('the first click arms rather than writes, and the arming lapses', async ({ page }) => {
    await openJob(page, 'A job touched today');
    const d = detail(page);

    await expect(d.resolveLabel).toHaveText('Resolve');
    await expect(d.resolve).toHaveClass(/btn-secondary/);

    const writes = [];
    page.on('request', (r) => { if (r.url().includes('/resolve')) writes.push(r.url()); });

    await d.resolve.click();
    await expect(d.resolveLabel).toHaveText('Write to progress.json?');
    await expect(d.resolve).toHaveClass(/btn-danger/);
    expect(writes, 'the first click must not write').toEqual([]);

    // Arming lapses after 4s so a stray click never leaves the button one
    // accidental click away from editing a file.
    await expect(d.resolveLabel).toHaveText('Resolve', { timeout: 8_000 });
    await expect(d.resolve).toHaveClass(/btn-secondary/);
    expect(writes).toEqual([]);
  });

  test('closing the dialog disarms it', async ({ page }) => {
    await openJob(page, 'A job touched today');
    const d = detail(page);
    await d.resolve.click();
    await expect(d.resolveLabel).toHaveText('Write to progress.json?');

    await page.keyboard.press('Escape');
    await jobRow(page, 'A job touched today').click();
    await expect(d.resolveLabel).toHaveText('Resolve');
    await expect(d.resolve).toHaveClass(/btn-secondary/);
  });

  test('a job whose workflow is already done cannot be resolved again', async ({ page }) => {
    await openJob(page, RESOLVED_JOB.title);
    const d = detail(page);
    await expect(d.resolveLabel).toHaveText('Resolved');
    await expect(d.resolve).toBeDisabled();
  });
});
