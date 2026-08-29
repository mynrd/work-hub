# Work Hub e2e

Playwright UI suite. It drives the real `src/serve.mjs` in a real browser, at a
desktop viewport and a phone viewport, and asserts both.

This folder is the only part of the repo with a `package.json`. The app itself
stays what it always was: node built-ins, no dependency, no build step. Nothing
under `src/` imports anything from here.

## Running it

```powershell
cd e2e
npm install                      # once
npx playwright install chromium  # once, ~150 MB of browser
npm test
```

| Command | What it does |
|---|---|
| `npm test` | the whole suite, both viewports |
| `npm run test:desktop` | 1440x900 only |
| `npm run test:mobile` | Pixel 5 only |
| `npm run ui` | Playwright's watch/inspector UI |
| `npm run report` | opens the HTML report from the last run |
| `npm run serve` | starts the fixture servers and leaves them up, to poke at by hand |

`npm test` starts the servers itself. `reuseExistingServer` is on outside CI, so
a `npm run serve` already running is used as-is.

## What it runs against

`support/start-server.mjs` builds a throwaway HOME under the temp folder and
starts two servers against it:

| Port | | Used by |
|---|---|---|
| 5178 | ungated | every functional spec |
| 5179 | enrolled with a test TOTP secret | `auth.spec.mjs` |

The temp HOME holds its own `config.json`, its own copy of `test/fixtures/proj-a`,
and its own `.claude/projects` transcript folder. **Your real `~/.work-hub` and
`~/.claude` are never read or written.** The temp folder is removed on exit, and
a stale one from a hard kill is swept on the next start.

Two things the server would otherwise shell out for are injected instead
(`support/stubs.mjs`):

- **`claude /usage`** - a fixed plan with three limit bars. Each Refresh bumps
  the first one, so a spec can prove the round trip happened.
- **`claude -p`** - a spawn that never spawns. It completes after 1.5s with the
  JSON shape the real CLI produces. **No `claude` process ever starts and
  nothing is written into a project folder.**

`openTerminal()` is *not* injectable, so **no spec ever clicks the Terminal
button** - a click would open a real console window on the machine running the
suite. `project.spec.mjs` asserts the button and its title, and stops there.

## Layout

```
playwright.config.mjs     two viewport projects, and the webServer that feeds them
support/env.mjs           builds the throwaway HOME and the fixture data
support/stubs.mjs         the usage cache and the spawn that never spawns
support/start-server.mjs  starts both servers; also `npm run serve`
support/app.mjs           page objects - selectors live here, not in the specs

tests/smoke.spec.mjs      boots, loads every asset, renders every route, no console errors
tests/dashboard.spec.mjs  usage card, project strip, search, theme
tests/project.spec.mjs    job grouping, unreadable folders, search, conversations card
tests/job-detail.spec.mjs the dialog: tabs, panels, docs, fullscreen, the Resolve gate
tests/conversation.spec.mjs  transcript rendering, the composer, a stubbed run
tests/settings.spec.mjs   folder list, composer defaults, and the config-write paths
tests/auth.spec.mjs       the gated server: 401 -> code prompt -> replay
tests/responsive.spec.mjs every breakpoint claim in src/client/styles/responsive.css
```

## Things worth knowing before you add a spec

**One server, two viewport projects.** Both run in parallel against the same
process, so anything that mutates shared state races itself. Writes to
`config.json` live in one serial, desktop-only `describe` in `settings.spec.mjs`.
The one-time code is single-use, so `auth.spec.mjs` signs in on desktop only.
Assertions against the usage numbers are relative, never absolute.

**Resolve is asserted but never confirmed.** The e2e covers the two-click arming
gate; the write itself is covered by `test/resolve-job.test.mjs`. Confirming it
here would mutate a job the other project is reading.

**Skips are deliberate.** `npm test` reports 5 skipped. That is the desktop-only
work described above, not something quietly broken.
