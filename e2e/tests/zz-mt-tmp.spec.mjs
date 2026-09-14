import { test, expect } from '@playwright/test';
import { goto, projectId, projectTabs, terminalPane } from '../support/app.mjs';
const SHELL_TIMEOUT = 25000;

test('normal buffer WITH mouse tracking on - the claude case', async ({ browser }, testInfo) => {
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
  const n = async () => { const m = String(await firstRow()).match(/-(\d+)\s*$/); return m ? parseInt(m[1], 10) : NaN; };

  // ---- case A: plain normal buffer (the case I did verify) ----
  await term.host.click();
  await page.keyboard.type('1..600 | % { "plain-$_" }');
  await page.keyboard.press('Enter');
  await expect(term.host).toContainText('plain-600', { timeout: SHELL_TIMEOUT });
  await page.waitForTimeout(700);
  let b = await n();
  for (let i = 0; i < 5; i++) { await up.click(); await page.waitForTimeout(130); }
  await page.waitForTimeout(500);
  console.log('A plain normal buffer          : moved ' + (b - (await n())) + ' lines');

  // ---- case B: mouse tracking ON, still the normal buffer (claude) ----
  await term.host.click();
  await page.keyboard.press('End');
  await page.keyboard.type('$e=[char]27; Write-Host -NoNewline "$e[?1002h$e[?1006h"; 1..600 | % { "mt-$_" }');
  await page.keyboard.press('Enter');
  await expect(term.host).toContainText('mt-600', { timeout: SHELL_TIMEOUT });
  await page.waitForTimeout(900);
  b = await n();
  for (let i = 0; i < 5; i++) { await up.click(); await page.waitForTimeout(130); }
  await page.waitForTimeout(500);
  const afterB = await n();
  console.log('B mouse tracking ON, normal buf: moved ' + (b - afterB) + ' lines   (' + b + ' -> ' + afterB + ')');

  // what a PHYSICAL wheel does in the very same state
  const box = await term.host.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  b = await n();
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -60); await page.waitForTimeout(130); }
  await page.waitForTimeout(500);
  console.log('B physical wheel, same state   : moved ' + (b - (await n())) + ' lines');

  await page.close();
});
