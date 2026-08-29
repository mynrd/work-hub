// The gated server on :5179. Same app, same assets, but every /api/* route
// needs a session token bought with a live 6 digit code.

import { test, expect } from '@playwright/test';

import { totp, secondsRemaining } from '../../src/lib/totp.mjs';
import { GATED_URL } from '../support/app.mjs';
import { OTP_SECRET } from '../support/env.mjs';

const otp = (page) => ({
  overlay: page.locator('#otpOverlay'),
  input: page.locator('#otpInput'),
  error: page.locator('#otpError'),
  submit: page.locator('#otpSubmitBtn'),
});

test.beforeEach(async ({ page }) => {
  await page.goto(GATED_URL + '/');
});

test('the page and its assets load ungated, so the code can be typed at all', async ({ page }) => {
  const assets = [];
  page.on('response', (r) => {
    const p = new URL(r.url()).pathname;
    if (/\.(css|mjs)$/.test(p) || p === '/') assets.push({ p, status: r.status() });
  });
  await page.reload();
  await expect(otp(page).overlay).toHaveClass(/is-open/);

  expect(assets.length).toBeGreaterThan(5);
  expect(assets.filter((a) => a.status !== 200), 'an asset behind the gate would lock you out').toEqual([]);
});

test('the first API call 401s and raises the code prompt', async ({ page }) => {
  const o = otp(page);
  await expect(o.overlay).toHaveClass(/is-open/);
  await expect(o.overlay).toContainText('Open your authenticator');
  await expect(o.input).toBeFocused();
  // The page behind it paints its loading skeleton but never gets data.
  await expect(page.locator('#app')).toContainText('Loading');
  await expect(page.locator('.strip .proj')).toHaveCount(0);
});

test('the input keeps digits only', async ({ page }) => {
  const o = otp(page);
  // maxlength=6 truncates the raw value first, so the filter only ever sees
  // six characters - '12ab34' becomes '1234', not '12345'.
  await o.input.fill('12ab34cd5');
  await expect(o.input).toHaveValue('1234');
  await o.input.fill('9z8');
  await expect(o.input).toHaveValue('98');
});

test('a wrong code is refused with a reason, and hands out nothing', async ({ page }) => {
  const o = otp(page);
  // 000000 is a live code one time in a million; on that run this is a false pass.
  await o.input.fill('000000');
  await expect(o.error).not.toBeEmpty();
  await expect(o.overlay).toHaveClass(/is-open/);
  expect(await page.evaluate(() => localStorage.getItem('work-hub-session'))).toBeNull();
});

test('fewer than six digits is refused before anything is sent', async ({ page }) => {
  const o = otp(page);
  const posts = [];
  page.on('request', (r) => { if (r.url().includes('/api/auth/otp')) posts.push(r.url()); });
  await o.input.fill('123');
  await o.submit.click();
  await expect(o.error).toHaveText('A code is 6 digits.');
  expect(posts).toEqual([]);
});

/* Only on desktop. A code is single-use - the server's replay guard refuses a
   counter it has already spent - so the mobile project signing in during the
   same 30 second step would be refused, correctly. Mobile still covers that the
   prompt appears and lays out; only the exchange runs once. */
test.describe('signing in', () => {
  test.beforeEach(({ }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'a code is single-use; the exchange runs once');
  });

  test('a live code buys a session and the dashboard renders behind it', async ({ page }) => {
    const o = otp(page);
    await expect(o.overlay).toHaveClass(/is-open/);

    // Do not start typing into the tail of a step - the code would expire between
    // the first digit and the sixth.
    if (secondsRemaining() < 5) await page.waitForTimeout(6000);
    await o.input.fill(totp(OTP_SECRET));

    // Six digits submit on their own, the way a paste from an authenticator does.
    await expect(o.overlay).not.toHaveClass(/is-open/);
    await expect(page.locator('.page-head h1')).toHaveText('Dashboard');
    await expect(page.locator('.card.usage')).toBeVisible();

    // The request that 401'd is replayed, not lost.
    await expect(page.locator('.strip .proj', { hasText: 'proj-a' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('work-hub-session'))).not.toBeNull();

    // The session survives a reload: no second prompt.
    await page.reload();
    await expect(page.locator('.page-head h1')).toHaveText('Dashboard');
    await expect(o.overlay).not.toHaveClass(/is-open/);
  });

  test('a stale token from a previous server run is dropped and re-asked for', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('work-hub-session', 'a-token-from-a-server-that-restarted'));
    await page.reload();
    await expect(otp(page).overlay).toHaveClass(/is-open/);
    expect(await page.evaluate(() => localStorage.getItem('work-hub-session'))).toBeNull();
  });
});
