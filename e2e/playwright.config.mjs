import { defineConfig, devices } from '@playwright/test';

import { PORTS } from './support/env.mjs';

/* Two viewports, and the whole functional suite runs on both. That is the point
   of the split: "it works on a phone" is a claim the suite has to keep making,
   not something checked once by hand. Breakpoint-specific assertions live in
   responsive.spec.mjs, which sets its own sizes explicitly. */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: `http://127.0.0.1:${PORTS.open}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],

  webServer: {
    command: 'node support/start-server.mjs',
    // The gated server starts in the same process, so waiting on the open one
    // is enough to know both are listening.
    url: `http://127.0.0.1:${PORTS.open}/api/auth/status`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  },
});
