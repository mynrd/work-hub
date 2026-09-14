import { test, expect } from '@playwright/test';
import { goto, projectId, projectTabs, terminalPane } from '../support/app.mjs';
const SHELL_TIMEOUT = 25000;

test('does a live-redrawing app snap the viewport back to the bottom?', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const page = await browser.newPage();
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
  const n = async () => { const m = String(await firstRow()).match(/rd-(\d+)/); return m ? parseInt(m[1], 10) : NaN; };

  await term.host.click();
  // 600 lines, then a status line that keeps rewriting itself for ~8s -
  // structurally what claude's spinner / status row does while it sits there.
  await page.keyboard.type('1..600 | % { "rd-$_" }; 1..40 | % { Write-Host -NoNewline ("`r  working " + $_ + "   "); Start-Sleep -Milliseconds 200 }');
  await page.keyboard.press('Enter');
  await expect(term.host).toContainText('rd-600', { timeout: SHELL_TIMEOUT });
  await page.waitForTimeout(600);

  const before = await n();
  for (let i = 0; i < 5; i++) { await up.click(); await page.waitForTimeout(130); }
  await page.waitForTimeout(200);
  const right = await n();          // immediately after clicking
  await page.waitForTimeout(2500);  // let several redraws land
  const later = await n();

  console.log('REDRAW before=' + before + '  right-after=' + right + '  2.5s-later=' + later);
  console.log('REDRAW moved on click = ' + (before - right) + ' ; still there after redraws = ' + (before - later));

  await page.close();
});
