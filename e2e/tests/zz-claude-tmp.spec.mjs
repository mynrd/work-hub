import { test, expect } from '@playwright/test';
import { goto, projectId, projectTabs, terminalPane } from '../support/app.mjs';
const SHELL_TIMEOUT = 40000;
const SHOT = 'C:/Users/mynrd/AppData/Local/Temp/claude/D--Work-git-mynrd-work-hub/6adef591-c278-4c11-a909-bcc66498f4eb/scratchpad';

test('scroll up while REAL claude code owns the terminal', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  test.setTimeout(180000);
  const page = await browser.newPage();
  await goto(page, '#/');
  const pid = await projectId(page, 'proj-a');
  await goto(page, `#/p/${pid}`);
  await projectTabs(page).tab('terminal').click();
  const term = terminalPane(page);
  await expect(term.host.locator('.xterm')).toBeVisible({ timeout: SHELL_TIMEOUT });

  const up = page.locator('#termScrollUpBtn');
  const screenText = () => page.evaluate(() => document.querySelector('.xterm-rows').innerText);
  const firstRow = () => page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    for (const r of rows.children) { const t = r.innerText.trim(); if (t) return t; }
    return '';
  });

  // Landmark lines first, so there is known content above claude to scroll to.
  await term.host.click();
  await page.keyboard.type('1..600 | % { "landmark-$_" }');
  await page.keyboard.press('Enter');
  await expect(term.host).toContainText('landmark-600', { timeout: SHELL_TIMEOUT });
  await page.waitForTimeout(600);

  // Now hand the terminal to the real claude CLI. No prompt is sent.
  await page.keyboard.type('claude');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(15000); // let the TUI come up fully

  await page.screenshot({ path: `${SHOT}/claude-before-up.png` });
  const beforeTxt = await screenText();
  const beforeFirst = await firstRow();
  console.log('CLAUDE first visible row BEFORE = ' + JSON.stringify(beforeFirst));
  console.log('CLAUDE sees landmark text BEFORE = ' + /landmark-\d+/.test(beforeTxt));

  for (let i = 0; i < 8; i++) { await up.click(); await page.waitForTimeout(160); }
  await page.waitForTimeout(1200);

  await page.screenshot({ path: `${SHOT}/claude-after-up.png` });
  const afterTxt = await screenText();
  const afterFirst = await firstRow();
  console.log('CLAUDE first visible row AFTER  = ' + JSON.stringify(afterFirst));
  console.log('CLAUDE screen CHANGED after 8 up taps = ' + (beforeTxt !== afterTxt));
  console.log('CLAUDE landmark visible AFTER = ' + /landmark-\d+/.test(afterTxt));

  // physical wheel in the identical state, for comparison
  const box = await term.host.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -60); await page.waitForTimeout(160); }
  await page.waitForTimeout(1200);
  const wheelTxt = await screenText();
  await page.screenshot({ path: `${SHOT}/claude-after-wheel.png` });
  console.log('CLAUDE screen CHANGED after 8 wheel notches = ' + (afterTxt !== wheelTxt));
  console.log('CLAUDE landmark visible after WHEEL = ' + /landmark-\d+/.test(wheelTxt));

  await page.close();
});
