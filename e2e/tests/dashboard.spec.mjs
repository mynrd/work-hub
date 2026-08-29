import { test, expect } from '@playwright/test';

import { goto, topbar, cardTitled } from '../support/app.mjs';

test.beforeEach(async ({ page }) => { await goto(page, '#/'); });

test('the usage card shows the plan and one bar per limit', async ({ page }) => {
  const usage = page.locator('.card.usage');
  await expect(usage.locator('.usage__title')).toHaveText('Plan usage');
  await expect(usage.locator('.usage__cmd')).toHaveText('claude /usage');
  await expect(usage.locator('.usage__plan')).toContainText('Max 20x');

  const rows = usage.locator('.usage__row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first().locator('.usage__label')).toHaveText('Current session');
  await expect(rows.first().locator('.usage__resets')).toHaveText('resets in 2h');

  // The bar's width is the number, so a wrong percentage is visible and not just
  // wrong text. Read the number rather than hard-coding it: both viewport
  // projects share one server, and the Refresh spec below moves it.
  const pct = (await rows.first().locator('.usage__pct').textContent()).replace('%', '');
  await expect(rows.first().locator('.usage__fill')).toHaveAttribute('style', new RegExp(`width:\s*${pct}%`));
  // 93% crosses the critical threshold; 71% only the high one.
  await expect(rows.nth(1).locator('.usage__fill')).toHaveClass(/is-high/);
  await expect(rows.nth(2).locator('.usage__fill')).toHaveClass(/is-critical/);
});

test('Refresh re-fetches the usage and repaints the bar', async ({ page }) => {
  const first = page.locator('.card.usage .usage__row').first();
  const before = Number((await first.locator('.usage__pct').textContent()).replace('%', ''));

  await page.locator('#usageRefreshBtn').click();

  // The stub bumps the first limit by one per refresh, so a changed number is
  // proof of a round trip rather than a redraw. Relative, because both viewport
  // projects drive the same server and each refresh moves the same counter.
  await expect(first.locator('.usage__pct')).not.toHaveText(`${before}%`);
  const after = Number((await first.locator('.usage__pct').textContent()).replace('%', ''));
  expect(after).toBeGreaterThan(before);
});

test('every configured folder gets a card, badged by what it holds', async ({ page }) => {
  const strip = cardTitled(page, 'Projects').locator('.strip');

  const a = strip.locator('.proj', { hasText: 'proj-a' });
  await expect(a.locator('.proj__name')).toHaveText('proj-a');
  await expect(a).not.toHaveClass(/is-missing/);
  await expect(a.locator('.badge')).toHaveCount(0); // it has a .work/, so no badge

  await expect(strip.locator('.proj', { hasText: 'proj-empty' }).locator('.badge')).toHaveText('no .work/');
  // The "folder is missing" state is covered in settings.spec.mjs, which is the
  // only place that can set it up and tear it down without racing this file.
});

test('a project card is a real link, so it opens the project route', async ({ page }) => {
  await cardTitled(page, 'Projects').locator('.proj', { hasText: 'proj-a' }).click();
  await expect(page.locator('.page-head h1')).toHaveText('proj-a');
  expect(page.url()).toContain('#/p/');
});

test('search filters the project strip and the count badge follows it', async ({ page }) => {
  const projects = cardTitled(page, 'Projects');
  const before = await projects.locator('.proj').count();
  expect(before).toBeGreaterThanOrEqual(2);

  await topbar(page).search.fill('proj-empty');
  await expect(projects.locator('.proj')).toHaveCount(1);
  await expect(projects.locator('.card__head .badge')).toHaveText('1');

  await topbar(page).search.fill('nothing-matches-this');
  await expect(projects.locator('.proj')).toHaveCount(0);
  await expect(projects).toContainText('No monitored folder matches your search');

  await topbar(page).search.fill('');
  await expect(projects.locator('.proj')).toHaveCount(before);
});

test('the theme toggle flips the attribute, swaps the icon, and survives a reload', async ({ page }) => {
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  // The icon shows the theme a click switches TO, not the current one.
  await expect(page.locator('#themeIconUse')).toHaveAttribute('href', '#i-sun');

  await topbar(page).theme.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#themeIconUse')).toHaveAttribute('href', '#i-moon');

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await topbar(page).theme.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});
