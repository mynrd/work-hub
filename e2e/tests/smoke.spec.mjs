// The boot path. If the module graph breaks, an asset 404s, or a view throws,
// this is the file that says so - before any behavioural spec gets confusing.

import { test, expect } from '@playwright/test';

import { goto, projectId } from '../support/app.mjs';

/** Collects anything the browser complains about, for the assertions below. */
function watch(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  return { consoleErrors, pageErrors, failed };
}

test('the page boots with no console error, no page error, and no failed request', async ({ page }) => {
  const seen = watch(page);
  await goto(page, '#/');
  await expect(page.locator('.page-head h1')).toHaveText('Dashboard');

  expect(seen.pageErrors, 'uncaught exceptions').toEqual([]);
  expect(seen.consoleErrors, 'console errors').toEqual([]);
  expect(seen.failed, 'requests that did not return 2xx/3xx').toEqual([]);
});

test('every stylesheet and every ES module the page pulls in is served', async ({ page }) => {
  const assets = [];
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (/\.(css|mjs)$/.test(url.pathname)) assets.push({ path: url.pathname, status: r.status() });
  });
  await goto(page, '#/');

  const paths = assets.map((a) => a.path);
  for (const required of [
    '/styles/tokens.css', '/styles/layout.css', '/styles/components.css',
    '/styles/views.css', '/styles/responsive.css', '/js/main.mjs',
  ]) {
    expect(paths, `${required} was never requested`).toContain(required);
  }
  // responsive.css must load last - the whole mobile pass is overrides.
  const sheets = paths.filter((p) => p.endsWith('.css'));
  expect(sheets[sheets.length - 1]).toBe('/styles/responsive.css');

  expect(assets.filter((a) => a.status !== 200)).toEqual([]);
  // The view modules only load because main.mjs imports them, so their presence
  // is the proof the graph resolved in the browser and not just on disk.
  expect(paths).toContain('/js/views/dashboard.mjs');
  expect(paths).toContain('/js/components/detail-dialog.mjs');
});

test('every route renders without throwing', async ({ page }) => {
  const seen = watch(page);
  await goto(page, '#/');
  const pid = await projectId(page, 'proj-a');

  for (const [hash, heading] of [
    ['#/', 'Dashboard'],
    ['#/settings', 'Settings'],
    [`#/p/${pid}`, 'proj-a'],
    [`#/p/${pid}/s/new`, 'New conversation'],
  ]) {
    await goto(page, hash);
    await expect(page.locator('.page-head h1')).toHaveText(heading);
  }

  expect(seen.pageErrors).toEqual([]);
  expect(seen.consoleErrors).toEqual([]);
});

test('an unknown hash falls back to the dashboard', async ({ page }) => {
  await goto(page, '#/nonsense/deeper');
  await expect(page.locator('.page-head h1')).toHaveText('Dashboard');
});
