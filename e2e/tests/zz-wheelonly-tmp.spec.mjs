import { test, expect } from '@playwright/test';
import { goto, projectId, projectTabs, terminalPane } from '../support/app.mjs';
const SHELL_TIMEOUT = 30000;

test('wheel-only dispatch in the NORMAL buffer', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const page = await browser.newPage();
  await goto(page, '#/');
  const pid = await projectId(page, 'proj-a');
  await goto(page, `#/p/${pid}`);
  await projectTabs(page).tab('terminal').click();
  const term = terminalPane(page);
  await expect(term.host.locator('.xterm')).toBeVisible({ timeout: SHELL_TIMEOUT });

  const firstRow = () => page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    for (const r of rows.children) { const t = r.innerText.trim(); if (t) return t; }
    return '';
  });
  const n = async () => { const m = String(await firstRow()).match(/-(\d+)\s*$/); return m ? parseInt(m[1], 10) : NaN; };
  const burst = (count, dy, sel) => page.evaluate(([c, d, s]) => {
    const el = document.querySelector(s);
    if (!el) return 'MISSING ' + s;
    const r = el.getBoundingClientRect();
    for (let i = 0; i < c; i++) {
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaY: d, deltaMode: 0, bubbles: true, cancelable: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
    }
    return 'ok';
  }, [count, dy, sel]);

  await term.host.click();
  await page.keyboard.type('1..600 | % { "w-$_" }');
  await page.keyboard.press('Enter');
  await expect(term.host).toContainText('w-600', { timeout: SHELL_TIMEOUT });
  await page.waitForTimeout(800);

  for (const sel of ['.xterm-screen', '.xterm-viewport', '.xterm']) {
    for (const dy of [-60, -120]) {
      // reset to the bottom
      await page.evaluate(() => { const v = document.querySelector('.xterm-viewport'); if (v) v.scrollTop = v.scrollHeight; });
      await burst(20, 120, '.xterm-screen');
      await page.waitForTimeout(300);
      const before = await n();
      const r = await burst(4, dy, sel);
      await page.waitForTimeout(400);
      const after = await n();
      console.log('WHEELONLY ' + sel + ' @' + dy + ' x4 -> moved ' + (before - after) + ' lines (' + r + ')');
    }
  }
  await page.close();
});
