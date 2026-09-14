import { test, expect } from '@playwright/test';
import { goto, projectId, projectTabs, terminalPane } from '../support/app.mjs';
const SHELL_TIMEOUT = 30000;

test('TOUCH: tapping the up button must scroll', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'this is the touch case');
  await goto(page, '#/');
  const pid = await projectId(page, 'proj-a');
  await goto(page, `#/p/${pid}`);
  await projectTabs(page).tab('terminal').click();
  const term = terminalPane(page);
  await expect(term.host.locator('.xterm')).toBeVisible({ timeout: SHELL_TIMEOUT });

  const up = page.locator('#termScrollUpBtn');
  const firstRow = () => page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    for (const r of rows.children) { const t = r.innerText.trim(); if (t) return t; }
    return '';
  });
  const n = async () => { const m = String(await firstRow()).match(/-(\d+)\s*$/); return m ? parseInt(m[1], 10) : NaN; };

  await term.host.click();
  await page.keyboard.type('1..600 | % { "t-$_" }');
  await page.keyboard.press('Enter');
  await expect(term.host).toContainText('t-600', { timeout: SHELL_TIMEOUT });
  await page.waitForTimeout(800);

  // which pointer events actually arrive from a tap
  await page.evaluate(() => {
    window.__ev = [];
    const b = document.getElementById('termScrollUpBtn');
    ['pointerdown', 'pointerup', 'pointercancel', 'pointerleave', 'click', 'touchstart', 'touchend'].forEach((t) => {
      b.addEventListener(t, (e) => window.__ev.push(t + (e.pointerType ? ':' + e.pointerType : '')), true);
    });
  });

  const before = await n();
  await up.tap();
  await page.waitForTimeout(500);
  const afterTap = await n();
  console.log('TOUCH events from one tap = ' + JSON.stringify(await page.evaluate(() => window.__ev)));
  console.log('TOUCH one tap moved = ' + (before - afterTap) + ' lines  (' + before + ' -> ' + afterTap + ')');

  const b2 = await n();
  for (let i = 0; i < 5; i++) { await up.tap(); await page.waitForTimeout(150); }
  await page.waitForTimeout(500);
  console.log('TOUCH 5 taps moved  = ' + (b2 - (await n())) + ' lines');

  // and a mouse-style click on the same device, for contrast
  const b3 = await n();
  for (let i = 0; i < 5; i++) { await up.click(); await page.waitForTimeout(150); }
  await page.waitForTimeout(500);
  console.log('TOUCH 5 clicks moved = ' + (b3 - (await n())) + ' lines');
});
