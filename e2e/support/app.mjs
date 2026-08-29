// Page-object helpers. Specs describe intent; the selectors live here, so a
// markup change is one edit rather than twenty.

import { expect } from '@playwright/test';

import { PORTS } from './env.mjs';

export const OPEN_URL = `http://127.0.0.1:${PORTS.open}`;
export const GATED_URL = `http://127.0.0.1:${PORTS.gated}`;

/** The dashboard's own record for a configured folder, by display name. */
export async function project(page, name) {
  const dashboard = await page.evaluate(async () => (await fetch('/api/dashboard')).json());
  const hit = dashboard.projects.find((p) => p.name === name);
  if (!hit) throw new Error(`No configured project named ${name}. Got: ${dashboard.projects.map((p) => p.name).join(', ')}`);
  return hit;
}

/** The server-side project id for a configured folder, by its display name. */
export async function projectId(page, name) {
  return (await project(page, name)).id;
}

/**
 * Opens a hash route and waits for the view to have painted something.
 *
 * Every page renders through one innerHTML write into #app, so "the route is
 * ready" is "#app is no longer the loading stub" - not a network idle, which
 * the 30s dashboard poll would keep resetting.
 */
export async function goto(page, hash = '#/') {
  const url = OPEN_URL + '/' + hash;
  if (page.url().startsWith(OPEN_URL)) await page.evaluate((h) => { location.hash = h; }, hash);
  else await page.goto(url);
  await expect(page.locator('#app')).not.toBeEmpty();
  return page;
}

export const topbar = (page) => ({
  search: page.locator('#searchInput'),
  refresh: page.locator('#refreshBtn'),
  theme: page.locator('#themeToggleBtn'),
  dashboard: page.locator('.topbar a[href="#/"]'),
  settings: page.locator('.topbar a[href="#/settings"]'),
});

export const detail = (page) => ({
  overlay: page.locator('#detailOverlay'),
  modal: page.locator('#detailOverlay .modal'),
  title: page.locator('#detailTitleId'),
  close: page.locator('#detailCloseBtn'),
  fullscreen: page.locator('#detailFullscreenBtn'),
  resolve: page.locator('#detailResolveBtn'),
  resolveLabel: page.locator('#detailResolveLabel'),
  tab: (id) => page.locator(`#detailTabs .tab[data-tab="${id}"]`),
  panel: (id) => page.locator(`#panel-${id}`),
});

export const composer = (page) => ({
  root: page.locator('.composer'),
  text: page.locator('#composerText'),
  preview: page.locator('#cmdPreview'),
  model: page.locator('#cmpModel'),
  effort: page.locator('#cmpEffort'),
  permission: page.locator('#cmpPerm'),
  send: page.locator('#sendBtn'),
  status: page.locator('.composer__status'),
});

/** The card whose <h3> is exactly `title`. */
export const cardTitled = (page, title) =>
  page.locator('.card').filter({ has: page.locator('.card__head h3', { hasText: new RegExp(`^${title}$`) }) });

/** A job row by the title shown in its Title cell. */
export const jobRow = (page, title) =>
  page.locator('tr[data-folder]').filter({ has: page.locator('td.cell-title', { hasText: title }) });
