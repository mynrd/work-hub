// The regression net for the mobile pass. Every assertion here is a thing that
// was broken before src/client/styles/responsive.css existed, so a rule quietly
// deleted from that file fails a named test rather than looking fine in Chrome
// at 1440px.
//
// Viewports are set per test rather than taken from the project, so each
// breakpoint is asserted at the width it actually claims to cover.

import { test, expect } from '@playwright/test';

import { goto, projectId, detail, jobRow, topbar, composer, projectTabs } from '../support/app.mjs';
import { FIXTURE_SESSION_ID } from '../support/env.mjs';

const PHONE = { width: 390, height: 844 };   // iPhone 14
const NARROW = { width: 320, height: 720 };  // the smallest screen worth supporting
const TABLET = { width: 1000, height: 800 }; // under 1080, where the panes collapse
const DESKTOP = { width: 1440, height: 900 };

const css = (locator, prop) => locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

/** Nothing on the page may stick out sideways: a phone has no horizontal scrollbar
 *  to find it with, so overflow just silently clips or bounces. */
async function expectNoSideScroll(page, where) {
  const over = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scroll: doc.scrollWidth, client: doc.clientWidth };
  });
  expect(over.scroll, `${where} scrolls sideways (${over.scroll}px in a ${over.client}px viewport)`)
    .toBeLessThanOrEqual(over.client + 1);
}

test.describe('topbar', () => {
  test('at 390px the labels collapse to icons and search takes its own row', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await goto(page, '#/');

    await expect(page.locator('.brand-text strong')).toBeVisible();
    await expect(page.locator('.brand-text span')).toBeHidden();     // the strapline
    await expect(page.locator('.search kbd')).toBeHidden();          // the "/" hint
    for (const label of await page.locator('.topbar .btn__label').all()) {
      await expect(label).toBeHidden();
    }
    // The icon inside each button survives, so the buttons are still usable.
    await expect(topbar(page).refresh.locator('svg')).toBeVisible();

    // Search wraps below the brand row rather than squeezing in beside it.
    const brand = await page.locator('.brand').boundingBox();
    const search = await page.locator('.search').boundingBox();
    expect(search.y).toBeGreaterThan(brand.y + brand.height - 1);
    expect(search.width).toBeGreaterThan(PHONE.width * 0.8);
  });

  test('the topbar grows to fit its rows instead of clipping them', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await goto(page, '#/');
    // It used to be `height: 66px` with flex-wrap on - the second row overflowed.
    const bar = await page.locator('.topbar').boundingBox();
    const search = await page.locator('.search').boundingBox();
    expect(bar.height).toBeGreaterThan(66);
    expect(search.y + search.height).toBeLessThanOrEqual(bar.y + bar.height + 1);
  });

  test('at 1440px the labels are back', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await goto(page, '#/');
    await expect(page.locator('.brand-text span')).toBeVisible();
    await expect(page.locator('.topbar .btn__label').first()).toBeVisible();
    await expect(page.locator('.search kbd')).toBeVisible();
  });
});

test.describe('tables', () => {
  test('at 390px a job table is a stack of labelled cards, not a sideways scroll', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await goto(page, '#/');
    await goto(page, `#/p/${await projectId(page, 'proj-a')}`);

    const table = page.locator('table.table--stack').first();
    await expect(table.locator('thead')).toBeHidden();

    const row = jobRow(page, 'A job touched today');
    expect(await css(row, 'display')).toBe('block');

    // Each cell prints its own column name, so the value still has a label.
    const status = row.locator('td[data-label="Status"]');
    const before = await status.evaluate((el) => getComputedStyle(el, '::before').content);
    expect(before).toContain('Status');

    // The merged Job / Title cell prints one label, and the title sits under
    // the id (same left edge, lower down) rather than under the label column.
    const jobCell = row.locator('td[data-label="Job / Title"]');
    expect(await jobCell.evaluate((el) => getComputedStyle(el, '::before').content)).toContain('Job / Title');
    const idBox = await jobCell.locator('.cell-job__id').boundingBox();
    const titleBox = await jobCell.locator('.cell-job__title').boundingBox();
    expect(Math.abs(titleBox.x - idBox.x)).toBeLessThan(1);
    expect(titleBox.y).toBeGreaterThanOrEqual(idBox.y + idBox.height - 1);

    // The row is now as wide as the card, not as wide as seven columns.
    const box = await row.boundingBox();
    expect(box.width).toBeLessThanOrEqual(PHONE.width);
    await expectNoSideScroll(page, 'the project page at 390px');
  });

  test('at 1440px the same table is a real table with a header row', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await goto(page, '#/');
    await goto(page, `#/p/${await projectId(page, 'proj-a')}`);

    await expect(page.locator('table.table--stack thead').first()).toBeVisible();
    const row = jobRow(page, 'A job touched today');
    expect(await css(row, 'display')).toBe('table-row');

    // Both lines of the Job / Title cell clip to their column instead of
    // widening the table: nowrap + hidden overflow + ellipsis on each.
    for (const line of ['.cell-job__id', '.cell-job__title']) {
      const el = row.locator(line);
      expect(await css(el, 'white-space')).toBe('nowrap');
      expect(await css(el, 'overflow-x')).toBe('hidden');
      expect(await css(el, 'text-overflow')).toBe('ellipsis');
    }
    const table = page.locator('table.table--stack').first();
    const wrap = page.locator('.table-wrap').first();
    expect((await table.boundingBox()).width).toBeLessThanOrEqual((await wrap.boundingBox()).width + 1);
  });
});

test.describe('project page tabs', () => {
  test('at 390px the three labels stay one row and scroll sideways, not the page', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await goto(page, '#/');
    await goto(page, `#/p/${await projectId(page, 'proj-a')}`);

    expect(await css(page.locator('#projectTabs'), 'flex-wrap')).toBe('nowrap');
    await expectNoSideScroll(page, 'the project page tabs at 390px');

    await projectTabs(page).tab('conversation').click();
    await expect(page.locator('.sess')).toBeVisible();
    await expectNoSideScroll(page, 'the project page tabs after switching at 390px');
  });
});

test.describe('job dialog', () => {
  test('at 390px it goes full-bleed', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await goto(page, '#/');
    await goto(page, `#/p/${await projectId(page, 'proj-a')}`);
    await jobRow(page, 'A job touched today').click();

    const d = detail(page);
    await expect(d.overlay).toHaveClass(/is-open/);

    // Polled, not read once: the dialog opens through a 200ms scale transition,
    // so a single boundingBox() lands a fraction of a pixel short of the edge.
    await expect.poll(async () => {
      const box = await d.modal.boundingBox();
      return { width: box.width, x: box.x };
    }).toEqual({ width: PHONE.width, x: 0 });

    expect(await css(d.modal, 'border-radius')).toBe('0px');

    // Wrapped, the tab strip became a three-row block that ate the panel below it.
    expect(await css(page.locator('#detailTabs'), 'flex-wrap')).toBe('nowrap');
    await expectNoSideScroll(page, 'the job dialog at 390px');
  });

  /* The header above the tabs is five stacked meta rows plus a vertical
     workflow track - taller than the phone. It does not shrink, so with two
     independent scroll regions the panels under it collapsed to 0px and every
     tab's content became unreachable. One scrolling column fixed it. */
  test('at 390px every tab panel is reachable, not crushed to nothing', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await goto(page, '#/');
    await goto(page, `#/p/${await projectId(page, 'proj-a')}`);
    await jobRow(page, 'A job touched today').click();

    const d = detail(page);
    const panels = page.locator('#detailPanels');
    expect((await panels.boundingBox()).height).toBeGreaterThan(0);

    // The tab strip sticks to the top of the scrolling body, so switching tabs
    // never means scrolling back up past the workflow track.
    expect(await css(page.locator('#detailTabs'), 'position')).toBe('sticky');

    // Reaching the content of the deepest tab is the real assertion.
    await d.tab('docs').click();
    const chips = page.locator('#mdTabs .chip');
    await expect(chips).toHaveCount(2);
    await chips.nth(1).click();
    await expect(chips.nth(1)).toHaveClass(/is-active/);
    await expect(page.locator('#mdContent')).not.toBeEmpty();
  });

  test('at 1440px it stays a centred card', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await goto(page, '#/');
    await goto(page, `#/p/${await projectId(page, 'proj-a')}`);
    await jobRow(page, 'A job touched today').click();

    const box = await detail(page).modal.boundingBox();
    expect(box.width).toBeLessThan(DESKTOP.width);
    expect(box.x).toBeGreaterThan(0);
  });
});

test.describe('conversation layout', () => {
  test('under 1080px the chat comes first and the session list stops being a sticky wall', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await goto(page, '#/');
    await goto(page, `#/p/${await projectId(page, 'proj-a')}/s/${FIXTURE_SESSION_ID}`);
    await expect(page.locator('.chat')).toBeVisible();

    const list = page.locator('.conv-list');
    expect(await css(list, 'position'), 'a sticky full-height list above the chat').toBe('static');
    expect(await css(list, 'order')).toBe('2');

    // Visually: the first message is above the conversation list, not below it.
    const chat = await page.locator('.chat').boundingBox();
    const listBox = await list.boundingBox();
    expect(chat.y).toBeLessThan(listBox.y);
  });

  test('at 1440px the list is back beside the chat, sticky', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await goto(page, '#/');
    await goto(page, `#/p/${await projectId(page, 'proj-a')}/s/${FIXTURE_SESSION_ID}`);
    await expect(page.locator('.chat')).toBeVisible();

    const list = page.locator('.conv-list');
    expect(await css(list, 'position')).toBe('sticky');
    const chat = await page.locator('.chat').boundingBox();
    const listBox = await list.boundingBox();
    expect(listBox.x).toBeLessThan(chat.x); // side by side, list on the left
  });
});

test('at 390px every focusable field is at least 16px, so iOS does not zoom on focus', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await goto(page, '#/');
  const pid = await projectId(page, 'proj-a');

  // Below 16px iOS Safari zooms the page in on focus with no way back to scale.
  const check = async (locator, what) => {
    const size = parseFloat(await css(locator, 'font-size'));
    expect(size, `${what} is ${size}px`).toBeGreaterThanOrEqual(16);
  };

  await check(topbar(page).search, 'the topbar search');

  await goto(page, `#/p/${pid}/s/${FIXTURE_SESSION_ID}`);
  await expect(page.locator('.chat')).toBeVisible();
  await check(composer(page).text, 'the composer textarea');
  await check(composer(page).model, 'the model select');

  await goto(page, '#/settings');
  await check(page.locator('#newProjectInput'), 'the add-folder input');
  await check(page.locator('#defModel'), 'the default model select');
});

test('at 390px the composer stacks one control per row', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await goto(page, '#/');
  await goto(page, `#/p/${await projectId(page, 'proj-a')}/s/new`);

  const fields = page.locator('.composer__controls .field');
  await expect(fields).toHaveCount(3);
  const boxes = await Promise.all((await fields.all()).map((f) => f.boundingBox()));
  // Three distinct rows: each label stays glued to its own select.
  expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(3);
  for (const b of boxes) expect(b.width).toBeGreaterThan(PHONE.width * 0.7);

  const send = await composer(page).send.boundingBox();
  expect(send.width).toBeGreaterThan(PHONE.width * 0.7);
});

test('at 560px the workflow track runs down the page instead of wrapping', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await goto(page, '#/');
  await goto(page, `#/p/${await projectId(page, 'proj-a')}`);
  await jobRow(page, 'A job touched today').click();

  const steps = page.locator('#detailWorkflow .wf-step');
  await expect(steps).toHaveCount(4);
  const boxes = await Promise.all((await steps.all()).map((s) => s.boundingBox()));
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].y, 'each step sits below the one before it').toBeGreaterThan(boxes[i - 1].y);
  }
});

test('no route scrolls sideways at any width worth supporting', async ({ page }) => {
  for (const viewport of [NARROW, PHONE, { width: 768, height: 1024 }, TABLET]) {
    await page.setViewportSize(viewport);
    await goto(page, '#/');
    const pid = await projectId(page, 'proj-a');

    for (const [hash, ready] of [
      ['#/', '.strip'],
      ['#/settings', '#newProjectInput'],
      [`#/p/${pid}`, 'tr[data-folder]'],
      [`#/p/${pid}/s/${FIXTURE_SESSION_ID}`, '.chat'],
      [`#/p/${pid}/s/new`, '.composer'],
    ]) {
      await goto(page, hash);
      await page.locator(ready).first().waitFor();
      await expectNoSideScroll(page, `${hash} at ${viewport.width}px`);
    }
  }
});
