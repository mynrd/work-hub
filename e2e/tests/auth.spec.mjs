// The gated server on :5179. Same app, same assets, but every /api/* route
// needs a session token bought with a live 6 digit code.

import { test, expect } from '@playwright/test';

import { totp, secondsRemaining } from '../../src/lib/totp.mjs';
import { GATED_URL } from '../support/app.mjs';
import { OTP_SECRET } from '../support/env.mjs';

const otp = (page) => ({
  overlay: page.locator('#otpOverlay'),
  title: page.locator('#otpTitle'),
  input: page.locator('#otpInput'),
  error: page.locator('#otpError'),
  submit: page.locator('#otpSubmitBtn'),
  modeLink: page.locator('#otpModeLink'),
});

/* Once a PIN exists (the PIN test below sets one, and the file outlives that
   test) the prompt opens in PIN mode. The code-based tests switch it back. */
async function ensureOtpMode(page) {
  const o = otp(page);
  await expect(o.overlay).toHaveClass(/is-open/);
  if ((await o.title.textContent()).includes('PIN')) {
    await o.modeLink.click();
    await expect(o.title).toHaveText('Enter your code');
  }
}

/* A code is single-use per 30s step, and the desktop tests in this file each
   spend one. If two land in the same step the second is refused as a replay,
   so this waits for the next step and tries once more. */
async function signInWithCode(page) {
  const o = otp(page);
  await ensureOtpMode(page);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (secondsRemaining() < 6) await page.waitForTimeout((secondsRemaining() + 1) * 1000);
    await o.input.fill(totp(OTP_SECRET));
    const closed = await o.overlay.evaluate((el) => new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (!el.classList.contains('is-open')) return resolve(true);
        if (Date.now() - started > 4000) return resolve(false);
        setTimeout(tick, 50);
      };
      tick();
    }));
    if (closed) return;
    const text = await o.error.textContent();
    if (!/already been used/.test(text)) throw new Error(`sign-in refused: ${text}`);
    await page.waitForTimeout((secondsRemaining() + 1) * 1000);
  }
  throw new Error('could not sign in with a live code after 3 steps');
}

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
  // OTP mode says "Open your authenticator"; PIN mode (once a PIN exists)
  // still points at the authenticator as the other way in.
  await expect(o.overlay).toContainText(/open your authenticator/i);
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

    // Six digits submit on their own, the way a paste from an authenticator does.
    await signInWithCode(page);
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

  /* One test, on purpose: setting the PIN needs a code-based session, and the
     gated server's idle window is 3 seconds (idleMinutes: 0.05 in
     start-server.mjs), so everything after the first sign-in has to happen in
     one flow before the lock fires - and the lock itself is the next thing
     under test. */
  test('a PIN is set from a code session, the idle lock asks for it, and a PIN session cannot change it', async ({ page }) => {
    const o = otp(page);
    await signInWithCode(page);
    const firstToken = await page.evaluate(() => localStorage.getItem('work-hub-session'));

    // Settings: the card is there on a gated server, and this session may set one.
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.mouse.move(10, 10); // activity: keep the 3s idle lock away until it is the thing under test
    const card = page.locator('#pinCard');
    await expect(card).toBeVisible();
    await expect(card.locator('#pinState')).toHaveText('No PIN yet');
    await expect(card.locator('#savePinBtn')).toBeEnabled();

    // Refused before any request: short, then mismatched.
    const puts = [];
    page.on('request', (r) => { if (r.url().includes('/api/auth/pin') && r.method() === 'PUT') puts.push(r.url()); });
    await card.locator('#pinNew').fill('123');
    await card.locator('#pinConfirm').fill('123');
    await card.locator('#savePinBtn').click();
    await expect(card.locator('#pinError')).toHaveText('A PIN is exactly 6 digits.');
    await card.locator('#pinNew').fill('246810');
    await card.locator('#pinConfirm').fill('246811');
    await card.locator('#savePinBtn').click();
    await expect(card.locator('#pinError')).toHaveText('The two PINs do not match.');
    expect(puts).toEqual([]);

    await card.locator('#pinConfirm').fill('246810');
    await card.locator('#savePinBtn').click();
    await expect(page.locator('#pinState')).toHaveText('A PIN is set');
    expect(puts).toHaveLength(1);

    // Idle lock: no activity for longer than the window. The prompt opens in
    // PIN mode, the token is gone from the browser, and the server has
    // revoked it (the old token no longer opens a gated route).
    const lockPosts = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/auth/lock')) lockPosts.push(r.method()); });
    await expect(o.overlay).toHaveClass(/is-open/, { timeout: 15_000 });
    await expect(o.title).toHaveText('Enter your PIN');
    await expect(o.modeLink).toHaveText('Use authenticator code');
    expect(lockPosts).toEqual(['POST']);
    expect(await page.evaluate(() => localStorage.getItem('work-hub-session'))).toBeNull();
    const revoked = await page.evaluate(async (t) => (await fetch('/api/config', { headers: { 'X-Hub-Token': t } })).status, firstToken);
    expect(revoked).toBe(401);

    // The link swaps modes both ways.
    await o.modeLink.click();
    await expect(o.title).toHaveText('Enter your code');
    await expect(o.modeLink).toHaveText('Use PIN');
    await o.modeLink.click();
    await expect(o.title).toHaveText('Enter your PIN');

    // Wrong PIN: the server's message, input cleared, still locked.
    await o.input.fill('000000');
    await expect(o.error).toHaveText('That PIN is not right.');
    await expect(o.overlay).toHaveClass(/is-open/);
    await expect(o.input).toHaveValue('');

    // Right PIN: the page carries on where it was, no reload, Settings still up.
    await o.input.fill('246810');
    await expect(o.overlay).not.toHaveClass(/is-open/);
    expect(page.url()).toContain('#/settings');
    await expect(page.locator('.page-head h1')).toHaveText('Settings');

    // This session came in by PIN, so the card is read-only with the reason.
    await page.evaluate(() => { location.hash = '#/'; });
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.locator('#pinLocked')).toHaveText('Sign in with your authenticator code to change the PIN.');
    await expect(page.locator('#savePinBtn')).toBeDisabled();
    await expect(page.locator('#pinNew')).toBeDisabled();
  });
});
