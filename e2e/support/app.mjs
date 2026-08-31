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
  read: page.locator('#mdReadBtn'),
  resolve: page.locator('#detailResolveBtn'),
  resolveLabel: page.locator('#detailResolveLabel'),
  verified: page.locator('#detailVerifiedBtn'),
  verifiedLabel: page.locator('#detailVerifiedLabel'),
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

/** The project page's own tab strip - Work Items / Conversation / Branch and Commits. */
export const projectTabs = (page) => ({
  tab: (id) => page.locator(`#projectTabs .tab[data-tab="${id}"]`),
  panel: (id) => page.locator(`#panel-${id}`),
});

/** The card whose <h3> is exactly `title`. */
export const cardTitled = (page, title) =>
  page.locator('.card').filter({ has: page.locator('.card__head h3', { hasText: new RegExp(`^${title}$`) }) });

/** The Branch and Commits tab. */
export const gitPane = (page) => ({
  root: page.locator('#gitPane'),
  branchSelect: page.locator('#gitBranchSelect'),
  commitRow: (subject) => page.locator('#gitPane .git-commit-row', { hasText: subject }),
  currentFileRow: (area, filePath) => page.locator(`#gitPane .git-file-row[data-area="${area}"][data-path="${filePath}"]`),
  commitFileRow: (filePath) => page.locator(`#gitPane .git-file-row[data-sha][data-path="${filePath}"]`),
  comparePane: (side) => page.locator(`#gitPane .compare__pane[data-side="${side}"]`),
  backBtn: page.locator('#gitCompareBackBtn'),
});

/** A job row by the title shown in its Title cell. */
export const jobRow = (page, title) =>
  page.locator('tr[data-folder]').filter({ has: page.locator('td.cell-title', { hasText: title }) });

/** The project page's Terminal tab: a strip of real shells, one xterm each. */
export const terminalPane = (page) => ({
  card: page.locator('#termCard'),
  strip: page.locator('#termStrip'),
  tabs: page.locator('.term-tab[data-shell]'),
  tab: (shellId) => page.locator(`.term-tab[data-shell="${shellId}"]`),
  tabLabel: (shellId) => page.locator(`.term-tab[data-shell="${shellId}"] .term-tab__label`),
  closeBtn: (shellId) => page.locator(`.term-tab[data-shell="${shellId}"] [data-close]`),
  newBtn: page.locator('#termNewBtn'),
  host: page.locator('#termHost'),
  restartBtn: page.locator('#termRestartBtn'),
  status: page.locator('#termPaneStatus'),
});

/** The topbar's Processes dialog - every shell Work Hub has open, everywhere. */
export const processesDialog = (page) => ({
  openBtn: page.locator('#processesBtn'),
  overlay: page.locator('#processesOverlay'),
  closeBtn: page.locator('#processesCloseBtn'),
  refreshBtn: page.locator('#processesRefreshBtn'),
  killAllBtn: page.locator('#processesKillAllBtn'),
  killAllLabel: page.locator('#processesKillAllLabel'),
  rows: page.locator('.proc-row'),
  /** The row for one of our own shells, found by its kill button - not by
   *  position, since a machine with another Work Hub instance open may list
   *  stragglers this suite did not create. */
  rowFor: (shellId) => page.locator('.proc-row').filter({ has: page.locator(`[data-kill-shell="${shellId}"]`) }),
  killShellBtn: (shellId) => page.locator(`[data-kill-shell="${shellId}"]`),
  /** The project-name link on a row - opens that project's Terminal tab. */
  projLink: (projectId) => page.locator(`.proc-row__proj[data-proj="${projectId}"]`),
});
