// The project page's Terminal tab: real pwsh shells owned by the shell-host
// daemon (src/shell-host.mjs), rendered in-page by xterm.js. Not the same
// thing as the Conversation tab's Terminal button (#terminalBtn / openTerminal()) -
// see the note in project.spec.mjs and the README - clicking here never opens
// an OS console window, it only drives a pty through the daemon's pipe.
//
// One describe block, serial, sharing one page and one daemon end to end:
// every test after the first depends on shells the earlier ones created.
// Destructive tests (kill, kill all) are ordered last. Real pwsh startup and
// echo round trips are slower than anything else in the suite, so timeouts
// here are deliberately generous.
//
// The Processes dialog can also list a straggler from an unrelated, real
// Work Hub instance running on the same machine (its own WMI scan is
// system-wide, see lib/processes.mjs) - every assertion against it below is
// scoped to our own two shellIds rather than the row count, so this suite
// stays green next to a real terminal someone left open elsewhere.
//
// The server-restart test (see support/start-server.mjs's control endpoint)
// briefly closes and rebuilds the shared :5178/:5179 servers every other spec
// file also drives, in parallel workers. Accepted trade-off, not a
// guarantee: nothing else in this suite holds a connection open across that
// (bounded, sub-second) window in practice, so it costs a real but small
// chance of a one-off flake in a concurrently running spec rather than a
// spec-managed third server duplicating this file's whole fixture.

import { test, expect } from '@playwright/test';

import { goto, projectId, projectTabs, terminalPane, processesDialog } from '../support/app.mjs';
import { restartServer } from '../support/restart.mjs';

const SHELL_TIMEOUT = 20000; // first prompt / echo round trip through a real pwsh
// Exit/kill events relayed down the output stream, and every read of the
// Processes dialog - GET /api/shells runs a WMI process scan (up to 8s on its
// own, see lib/processes.mjs) on top of whatever the daemon answers, so the
// default 5s expect timeout is not generous enough for it under load.
const EVENT_TIMEOUT = 10000;

async function focusHost(term) {
  await expect(term.host.locator('.xterm')).toBeVisible({ timeout: SHELL_TIMEOUT });
  await term.host.click();
}

test.describe('Terminal tab: real shells that survive a reload and a server restart', () => {
  test.describe.configure({ mode: 'serial' });

  let page;
  let pid;
  let firstShellId; // renamed to "build-shell" in test b, killed via the dialog in test e
  let secondShellId; // survives to test f, where typing exit ends it

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'shares one daemon and one set of shells; runs once, on desktop only');
  });

  test.beforeAll(async ({ browser }, testInfo) => {
    if (testInfo.project.name !== 'desktop') return; // every test below skips itself for this project
    page = await browser.newPage();
    await goto(page, '#/');
    pid = await projectId(page, 'proj-a');
    await goto(page, `#/p/${pid}`);
    await projectTabs(page).tab('terminal').click();
  });

  test.afterAll(async () => {
    if (page) await page.close();
  });

  test('opening the tab starts one shell, and typed input echoes back', async () => {
    const term = terminalPane(page);
    await expect(term.tabs).toHaveCount(1, { timeout: SHELL_TIMEOUT });
    firstShellId = await term.tabs.first().getAttribute('data-shell');
    expect(firstShellId).toBeTruthy();

    await focusHost(term);
    await page.keyboard.type('echo wh-e2e-alpha');
    await page.keyboard.press('Enter');
    await expect(term.host).toContainText('wh-e2e-alpha', { timeout: SHELL_TIMEOUT });
  });

  test('+ opens a second terminal; double-click renames the first', async () => {
    const term = terminalPane(page);
    await term.newBtn.click();
    await expect(term.tabs).toHaveCount(2, { timeout: SHELL_TIMEOUT });

    const ids = await term.tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-shell')));
    secondShellId = ids.find((id) => id !== firstShellId);
    expect(secondShellId).toBeTruthy();

    await term.tabLabel(firstShellId).dblclick();
    const renameInput = term.tab(firstShellId).locator('.term-tab__rename');
    await renameInput.fill('build-shell');
    await renameInput.press('Enter');

    await expect(term.tabs).toHaveCount(2);
    await expect(term.tabLabel(firstShellId)).toHaveText('build-shell');
  });

  test('reloading the page brings both tabs back, the name persists, and output replays', async () => {
    await page.reload();
    await expect(page.locator('#app')).not.toBeEmpty();
    // A reload wipes the in-memory JS state a hash change would have kept -
    // the project page starts back on Work Items.
    await projectTabs(page).tab('terminal').click();

    const term = terminalPane(page);
    await expect(term.tabs).toHaveCount(2, { timeout: SHELL_TIMEOUT });
    await expect(term.tabLabel(firstShellId)).toHaveText('build-shell');

    await term.tab(firstShellId).click();
    await focusHost(term);
    await expect(term.host).toContainText('wh-e2e-alpha', { timeout: SHELL_TIMEOUT });
  });

  test('a server restart does not kill the shell: it reattaches instead of respawning', async () => {
    await restartServer();
    await page.reload();
    await expect(page.locator('#app')).not.toBeEmpty();
    await projectTabs(page).tab('terminal').click();

    const term = terminalPane(page);
    await expect(term.tabs).toHaveCount(2, { timeout: SHELL_TIMEOUT });
    await expect(term.tabLabel(firstShellId)).toHaveText('build-shell');

    await term.tab(firstShellId).click();
    await focusHost(term);
    await expect(term.host).toContainText('wh-e2e-alpha', { timeout: SHELL_TIMEOUT });

    // Proves reattach, not respawn: the same pty is still alive and still
    // running the original process, not a fresh shell that happens to share a name.
    await page.keyboard.type('echo wh-e2e-beta');
    await page.keyboard.press('Enter');
    await expect(term.host).toContainText('wh-e2e-beta', { timeout: SHELL_TIMEOUT });
  });

  test('Processes dialog: the project name opens that project on its Terminal tab', async () => {
    // Leave the Terminal tab and the project page first, so the click has to
    // do both jobs - navigate, and preselect the tab - rather than landing on
    // a page that was already showing what we assert.
    await projectTabs(page).tab('work').click();
    await goto(page, '#/');

    const dlg = processesDialog(page);
    await dlg.openBtn.click();
    await expect(dlg.overlay).toHaveClass(/is-open/);
    await expect(dlg.rowFor(firstShellId)).toHaveCount(1, { timeout: EVENT_TIMEOUT });

    await dlg.projLink(pid).first().click();
    await expect(dlg.overlay).not.toHaveClass(/is-open/);
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
    await expect(projectTabs(page).tab('terminal')).toHaveAttribute('aria-selected', 'true');

    const term = terminalPane(page);
    await expect(term.host).toBeVisible();
    await expect(term.tabs).toHaveCount(2, { timeout: SHELL_TIMEOUT });
    await expect(term.tabLabel(firstShellId)).toHaveText('build-shell');
  });

  test('Processes dialog: killing a shell greys its tab', async () => {
    const dlg = processesDialog(page);
    await dlg.openBtn.click();
    await expect(dlg.overlay).toHaveClass(/is-open/);
    await expect(dlg.rowFor(firstShellId)).toHaveCount(1, { timeout: EVENT_TIMEOUT });
    await expect(dlg.rowFor(secondShellId)).toHaveCount(1, { timeout: EVENT_TIMEOUT });
    await expect(dlg.rowFor(firstShellId)).toContainText('proj-a');

    await dlg.killShellBtn(firstShellId).click();
    await expect(dlg.rowFor(firstShellId)).toHaveCount(0, { timeout: EVENT_TIMEOUT });
    await expect(dlg.rowFor(secondShellId)).toHaveCount(1, { timeout: EVENT_TIMEOUT });

    await dlg.closeBtn.click();
    await expect(dlg.overlay).not.toHaveClass(/is-open/);

    const term = terminalPane(page);
    await expect(term.tab(firstShellId)).toHaveClass(/term-tab--dead/, { timeout: EVENT_TIMEOUT });

    await term.closeBtn(firstShellId).click();
    await expect(term.tab(firstShellId)).toHaveCount(0);
    await expect(term.tabs).toHaveCount(1);
  });

  test('typing exit ends the remaining shell', async () => {
    const term = terminalPane(page);
    await term.tab(secondShellId).click();
    await focusHost(term);
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await expect(term.tab(secondShellId)).toHaveClass(/term-tab--dead/, { timeout: SHELL_TIMEOUT });

    const dlg = processesDialog(page);
    await dlg.openBtn.click();
    await expect(dlg.rowFor(secondShellId)).toContainText('exited', { timeout: EVENT_TIMEOUT });
    await dlg.closeBtn.click();
  });

  test('Kill all clears every shell this session owns; no live tab remains on the strip', async () => {
    const dlg = processesDialog(page);
    await dlg.openBtn.click();
    await expect(dlg.rowFor(secondShellId)).toHaveCount(1, { timeout: EVENT_TIMEOUT });

    await dlg.killAllBtn.click();
    await expect(dlg.rowFor(secondShellId)).toHaveCount(0, { timeout: EVENT_TIMEOUT });
    await expect(dlg.killAllLabel).toHaveText('Kill all');

    await dlg.closeBtn.click();
    await expect(page.locator('.term-tab[data-shell]:not(.term-tab--dead)')).toHaveCount(0);
  });
});
