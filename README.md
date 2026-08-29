# Work Hub

A local web dashboard over several project folders at once, plus a console for the Claude Code conversations that happened in them.

The dashboard is a list of the folders you monitor and nothing more. Open one and it reads that folder, then:

- **Jobs.** That folder's `.work/<job>/progress.json` files, grouped into **Worked today**, **Not yet started** and **Others**, with a tabbed detail dialog per job (Acceptance Criteria, Intake, Tasks, Tests, Runs, Docs, Raw).
- **Conversations.** Every Claude Code session whose working directory was that folder, 20 to a page, rendered as a chat, with a composer that can reply to a session or start a new one by running `claude` for you. **Terminal** opens a real console window in that folder running `claude remote-control --spawn same-dir`.

It also shows your real subscription usage, straight from `claude -p /usage`.

Node built-ins only. No `package.json`, no `npm install`, no dependencies.

---

## Run it

```powershell
.\run.ps1 -Enroll               # once: pair your authenticator app
.\run.ps1                       # every interface, and restarts when main moves
.\run.ps1 -OpenBrowser          # same, and open the browser once it answers
.\run.ps1 -Loopback -NoWatch    # 127.0.0.1 only, no git polling
```

`-Enroll` is a one-off. It prints a QR code in the console, you scan it with Authy (or
Google Authenticator, or 1Password - anything doing standard TOTP), and you type back the
6 digit code it starts showing. Only then is the shared secret written, to
`~/.work-hub/totp.json`. From then on the page asks for a code instead of a pasted token.

The default bind is `0.0.0.0`, so the LAN address, the Tailscale `100.x` address and the
NordVPN Meshnet address all answer on the same port. Every one of them is printed on start:

```
Reachable at:
  http://127.0.0.1:5081/
  http://192.168.1.42:5081/
  http://100.97.229.12:5081/
```

Narrow it with `-Loopback`, `-Tailscale`, or `-BindAddress <ip>`.

While the server runs and the branch is `main` with a clean working tree, `run.ps1` fetches
`origin/main` every 60 seconds (`-WatchInterval`) and restarts the server on a new commit.
The pull is `--ff-only`, and a dirty tree is left alone until it is clean again. `-NoWatch`
turns the polling off. If node exits on its own the script exits with it - a broken commit
does not become a restart loop.

or directly:

```powershell
node src/serve.mjs                        # 127.0.0.1:5081
node src/serve.mjs --port 9000            # a different port
node src/serve.mjs --host 192.168.1.20    # a specific interface (pairing required)
node src/serve.mjs --lan                  # every interface  (pairing required)
node src/serve.mjs --no-otp               # loopback only: no code prompt at all

node src/enroll.mjs                       # pair an authenticator
node src/enroll.mjs --status              # who is paired, and when
node src/enroll.mjs --force               # replace the pairing (the old one stops working)
node src/enroll.mjs --reset               # unpair; nobody can sign in until you enroll again
```

On start it prints the bound address and the config file path. A port already in use, or an address this machine does not own, fails with a one-line message naming the flag to change, and exits 1.

### Requirements

- **Node 18+** (developed against v26.7.0).
- **`claude` on PATH and signed in.** The Plan Usage card and every reply shell out to it.
- Read access to `~/.claude/projects`, where Claude Code keeps its transcripts.
- **Windows** for the **Terminal** button only. It shells out to `cmd /c start`; everywhere else that one button answers 501 and names the command to run by hand. Nothing else in Work Hub is Windows-only.

---

## ⚠ Exposure

**This is not a read-only viewer.** It can start `claude` under your account, in your project folders, spending your subscription. A run started from the page can edit files - the Permissions select even offers `bypassPermissions`, which is `--dangerously-skip-permissions`.

That is checked, not assumed: in `-p` mode with the default permission mode, a `Write` tool call executed and the file appeared on disk with no prompt (see the spike notes at the top of [claude-run.mjs](src/lib/claude-run.mjs)). "Headless" does not mean "read only".

So:

- `serve.mjs` on its own still defaults to **loopback only**. `run.ps1` defaults to `0.0.0.0`, which is why it refuses to start without a pairing and prints the warning below; `-Loopback` puts it back.
- Any **non-loopback bind requires a paired authenticator**. There is no generated fallback secret any more: an unpaired machine will not bind anything but loopback, and says so with the command to fix it.
- **Once paired, loopback is gated too.** That is not about other users on the machine - it is about the browser. With no header required, any page open in any tab can `fetch('http://127.0.0.1:5081/api/projects/<id>/sessions', {method:'POST', mode:'no-cors', ...})` and start a `claude` run under your account; it never sees the response, but the run happens, and DNS rebinding does the same thing from a random site. Requiring `X-Hub-Token` forces a CORS preflight, and nothing here answers one.
- `--no-otp` turns the gate off, and only on a loopback bind. Combining it with a non-loopback host refuses to start.
- Binding beyond loopback also needs a Windows Firewall inbound-allow rule. `run.ps1` checks for one and prints the exact `New-NetFirewallRule` command; it never creates one, because that needs elevation.

### How signing in works

1. `GET /` is always served, so the prompt can be shown.
2. The page posts the 6 digit code to `POST /api/auth/otp`. That route is the way in, so it is the only ungated one.
3. A correct code comes back as a **session token**: 32 random bytes, good for 12 hours, held in `localStorage`. Every other `/api/*` request carries it as `X-Hub-Token`.
4. Sessions live in memory only, so restarting the server signs every browser out. A 401 re-opens the prompt and replays the request that failed.

A code is single use - the counter it verified against is remembered and refused a second time, so a code read over your shoulder is already spent. Five wrong codes lock the exchange for 60 seconds, which is what keeps a six digit secret from being guessable: three of a million codes are live at any moment, and unthrottled that is about a day of flat-out guessing on a LAN.

The secret lives in `~/.work-hub/totp.json`, **not** in a `.env` in this repo - this repo gets committed, and a secret that can start `claude` under your account should not be one `git add -A` from being pushed. `enroll.mjs` writes it 0600 and never opens a socket: the QR is drawn in the terminal by [qr.mjs](src/lib/qr.mjs) precisely so the secret is never handed to a QR service.

Anyone who reaches the port and can produce a code can read every file under your `.work/` folders, read every Claude Code transcript for the monitored projects, start new Claude runs, and **open a terminal window on the machine running the server** - the Terminal button is a `POST` that spawns `cmd /c start`, so a console appears on your desktop running `claude remote-control --spawn same-dir`, which then accepts work from claude.ai and the mobile app. Treat the phone holding that pairing like an SSH key.

The message you type is never an argument. On Windows `claude` resolves to `claude.cmd`, which Node will only spawn with `shell: true`, and with `shell: true` Node does not escape argv. So every argument is an allowlisted token or a UUID matched against a regex, and the message itself goes over the child's stdin.

---

## Configuration

Stored in `~/.work-hub/config.json`, written atomically (temp file + rename), 2-space indent:

```json
{
  "projects": [
    "D:\\Work\\git\\mynrd\\claude-usage",
    "D:\\Work\\git\\mynrd\\work-hub"
  ],
  "usageIntervalMinutes": 5,
  "defaults": { "model": "opus", "effort": "high", "permissionMode": "default" }
}
```

The Model select offers aliases - `opus`, `opus[1m]`, `sonnet`, `haiku`, `fable` - which
`claude --model` resolves to that family's newest version when it spawns, so the list does
not go stale on a Claude Code update. The tradeoff is that a new version starts running
here on its own, and you only see which one ran once the transcript names it. To pin a
version, put an exact id (`claude-opus-5`, `claude-opus-5[1m]`) in `config.json` by hand:
`ALLOWED_MODELS` in `src/lib/config.mjs` accepts it, and the Settings select adds it as an
option so the page shows what is actually running.

Edit it from the **Settings** page. Adding a path that does not exist is refused with the reason. A folder with no `.work/` is fine - it is listed with `0 jobs` and its conversations still work.

`usageIntervalMinutes: 0` means the Plan Usage card only refreshes when you click Refresh.

`claude -p /usage` is itself a Claude Code session, so it writes a transcript. It runs with `~/.claude` as its working directory - not a monitored project - so those one-turn `/usage` sessions collect under `~/.claude/projects/` for that folder instead of appearing in a project's Conversations list every few minutes. If `~/.claude` is not there it falls back to the home folder.

A hand-mangled config never stops the server: unknown or wrongly-typed fields fall back to the defaults, and a file that is not valid JSON loads as empty with the reason shown at the top of the dashboard.

---

## How the pieces map

```text
run.ps1                  PowerShell wrapper: bind selection, firewall check, exposure warning,
                         and the watch loop that restarts the server when main moves

src/serve.mjs            HTTP server, arg parsing, routes, the code/session gate
src/enroll.mjs           terminal app: prints the QR, confirms a code, writes the secret
src/lib/totp.mjs         RFC 4226/6238 TOTP, base32, the otpauth:// URI
src/lib/qr.mjs           QR encoder (byte mode, level M, versions 1-10) and the terminal render
src/lib/authstore.mjs    ~/.work-hub/totp.json, and the in-memory session tokens
src/client.html          the whole UI - markup, CSS and JS inline, no build step

src/lib/config.mjs       ~/.work-hub/config.json, path validation, the model/effort/permission allowlists
src/lib/workscan.mjs     scanWorkFolder(projectPath, {now}) -> { today, notStarted, others, unreadable }
src/lib/resolve-job.mjs  Resolve - the one writer into a monitored folder, format-preserving
src/lib/transcripts.mjs  encodeProjectFolder(), listSessions(), readSessionChat()
src/lib/usage.mjs        fetchCliUsage() + parseUsage() + usageCwd() + the refresh timer
src/lib/claude-run.mjs   buildArgs(), the run registry, the spawn
src/lib/terminal.mjs     openTerminal() - the Terminal button's `cmd /c start`
src/lib/markdown.mjs     the Docs tab renderer (copied verbatim from work-viewer)

test/*.test.mjs          node --test
test/fixtures/           .work trees, a transcript, /usage samples
```

### What loads when

The dashboard asks for `/api/dashboard`, which reads the config and calls `statSync` twice per folder - does it exist, does it have a `.work/`. That is all. It never walks a job folder and never opens a transcript.

Clicking a project box fires two independent requests for that one folder, and each half of the page paints as its own answer lands:

| Request | What it costs |
|---|---|
| `GET /api/projects/:pid/jobs` | `scanWorkFolder`, which recurses every job folder for its newest mtime |
| `GET /api/projects/:pid/sessions` | every `.jsonl` in that folder's transcript directory, parsed and cached against `size + mtime` |

Neither runs for a folder nobody opened. With a dozen monitored projects the old dashboard paid for all of them, every 30 seconds, to render a strip of boxes. Each half of the project page shows a spinner until its own answer arrives.

### Grouping

| Group | Rule |
|---|---|
| **Worked today** | any file under the job folder has an mtime on the local day of `now` - regardless of status or workflow |
| **Not yet started** | not worked today, `workflow[build].status === "pending"` (or there is no `build` step), and `runs[]` is empty |
| **Others** | every other readable job |
| **Unreadable** | the folder is there but `progress.json` is missing or not a JSON object - listed with the reason, never silently dropped |

### Resolve

The grouping above is a heuristic, and it gets jobs wrong. A folder whose workflow uses a different vocabulary - `intake / plan / dev-start`, with no `build` step at all - lands in **Not yet started** even when its `status` is `built` and every acceptance criterion is `implemented`, because there is no `build` step to read.

The **Resolve** button in the job dialog is the correction. It writes into that job's own `progress.json`:

- every entry in `workflow[]` gets `status: "done"`;
- a `build` step is appended if the job never had one;
- a `human-verification` step is appended if the job never had one.

Nothing else in the file changes - `status`, `tasks`, `acceptanceCriteria`, `runs` and every field Work Hub does not recognise are written back exactly as they were read, in their original key order. The rewrite preserves the file's line endings and trailing-newline style, so the diff in your repo is the workflow block and nothing else.

**This is the only thing in Work Hub that writes into a folder you monitor**, and it is deliberate: the dashboard's grouping reads the workflow, and a correction has to live where the rest of your workflow tooling will also see it. It takes two clicks - the button arms first, showing `Write to progress.json?`, and disarms itself after four seconds. A `progress.json` that is not valid JSON, or is not a JSON object, is refused rather than rewritten.

One consequence worth knowing: writing the file updates its mtime, so a resolved job appears under **Worked today** for the rest of the day before settling into **Others**.

`progress.json` is otherwise treated as untrusted JSON of unknown shape. Every field is read with `?.`/`??`, an unknown `status` or `workflow[].step` renders verbatim in neutral styling, and the **Raw** tab always shows the file exactly as read, with a copy button. Real folders on disk already carry values outside the documented set; a schema check here would hide jobs rather than help.

### Conversations

Claude Code stores a session at `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, where the folder name is the working directory with every character outside `[A-Za-z0-9]` replaced by `-`:

```text
D:\Work\git\mynrd\work-hub  ->  D--Work-git-mynrd-work-hub
```

Windows creates that folder with either drive-letter case and treats the two as one, so the lookup matches case-insensitively.

The list is paged, 20 rows to a page, newest first - a folder with 300 sessions renders 20 of them. Opening a conversation moves the pager to whichever page holds it, so the open one is always visible in the list beside the chat.

Opening a conversation scrolls straight to its newest message. From then on the page only follows new messages while you are already at the bottom (within 120px): the transcript is re-read every 3 seconds during a run, and yanking the view down mid-scroll would make an in-flight reply unreadable.

A session row shows the title (from an `ai-title` record, else the first non-meta user prompt truncated to 80 characters), the short id, first and last timestamps, message count, the distinct models seen, the subagent transcript count, and a live dot when the file was written in the last 45 seconds. Sidechain records (a subagent's turns spliced into the main file) do not count as messages. Parsed summaries are cached in memory against `size + mtime`, so a refresh only re-reads files that actually changed.

**Nothing in a transcript is ever dropped.** User turns, assistant text, tool calls and results, thinking, slash-command chips, compact summaries and IDE context each get their own rendering; every other record type or content block shows as a collapsed raw-JSON block labelled `record: <type>` / `attachment: <type>` / `block: <type>`. Claude Code changes these shapes between versions - the raw fallback is what keeps the viewer honest, so never add a denylist.

### Replies

The composer builds exactly this, with the project folder as the working directory:

```text
claude -p [-r <sessionId>] --model <model> --effort <effort> --output-format json [--permission-mode <mode> | --dangerously-skip-permissions]
```

The generated line is shown above the textarea before you send, so there is no guessing about what will run. Ctrl+Enter sends; a bare Enter is a newline.

Each spawn is a run with `queued | running | done | failed`, timings, exit code and captured stdout/stderr. While one is in flight the page polls the run every second and re-reads the transcript every three seconds - `claude -p -r` appends to the same `.jsonl`, so the reply simply appears in the chat. A failed run prints its stderr verbatim. One run at a time per session: a second send on the same conversation is refused with a message, not queued.

A new conversation is the same thing without `-r`; when the child reports its `session_id` the page jumps to that conversation.

There is a hard 10-minute timeout per run. `-p` mode cannot answer an interactive permission prompt - the Permissions select is the only control you have over that.

### Terminal

The button beside **New** opens a console window on the machine running the server, in that project's folder, running:

```text
claude remote-control --spawn same-dir
```

That is the one thing here that is not headless, and it is the answer to `-p` mode's permission-prompt problem: the session lives in a real terminal you can answer, and Remote Control lets you drive it from claude.ai or the mobile app.

The launcher is `cmd.exe /c start "Work Hub - claude remote-control" cmd.exe /k claude remote-control --spawn same-dir`, spawned `detached` with `shell: false`. `start` is there because it is the only way to get a real console: with `stdio: 'ignore'` a bare `cmd /k` reads EOF from NUL and exits before you see it. It also honours your default terminal setting, so a Windows Terminal user gets a WT tab. Every argument above is a literal in `terminal.mjs` - the project path travels as the child's `cwd`, which is a `CreateProcess` parameter, not part of the command line.

Work Hub launches it and forgets it: no run is registered, no output is captured, and closing the page does not close the window.

---

## Routes

| Method | Route | Returns |
|---|---|---|
| GET | `/` | `client.html` - always served, gate or no gate, so the code can be typed |
| GET | `/api/auth/status` | `{ required, authenticated, digits, periodSeconds }` - ungated |
| POST | `/api/auth/otp` | `{ token, expiresAt }` for a live 6 digit code; 401 wrong or replayed, 429 locked out. Ungated - it is the way in |
| GET / PUT | `/api/config` | the config; PUT validates every path with `statSync().isDirectory()` |
| GET | `/api/dashboard` | `{ projects[] }` - id, path, name, `missing`, `hasWorkDir`. Two `statSync` calls per folder, nothing else |
| GET | `/api/projects/:pid/jobs` | `{ today[], notStarted[], others[], unreadable[] }` for that one folder - the `.work` scan, on demand, no cache |
| POST | `/api/projects/:pid/terminal` | opens a console on the **server's** desktop running `claude remote-control --spawn same-dir` |
| GET | `/api/projects/:pid/jobs/:folder/md/:file` | one `.md` rendered to HTML |
| POST | `/api/projects/:pid/jobs/:folder/resolve` | marks the job's workflow done **in its `progress.json`** |
| GET | `/api/projects/:pid/sessions` | session summaries |
| POST | `/api/projects/:pid/sessions` | `{ runId }` - new conversation |
| GET | `/api/projects/:pid/sessions/:sid` | the parsed chat |
| POST | `/api/projects/:pid/sessions/:sid/reply` | `{ runId }` |
| GET | `/api/runs/:runId` | run state, timings, exit code, stdout/stderr |
| GET | `/api/usage` | the cached `/usage` result |
| POST | `/api/usage/refresh` | forces a fetch |

`:pid` is the encoded folder name, resolved back to a path from the config on every request - a path is never accepted from a URL, and an id that is not configured is a 404. Job folder and file segments are rejected if they still contain a separator after decoding, only `.md` is served, and the resolved path must stay under that project's `.work/`. JSON bodies are capped at 256 KB (413 past that).

Only `PUT /api/config`, the two POST run routes, `/api/usage/refresh`, `/api/projects/:pid/terminal` and `/api/projects/:pid/jobs/:folder/resolve` change anything. Everything else is read-only.

`resolve` is the single route that writes into a monitored folder - see below. Otherwise the only files Work Hub writes are `~/.work-hub/config.json`, `~/.work-hub/totp.json` (by `enroll.mjs`, never by the server), and whatever `claude` itself writes.

---

## Tests

```powershell
node --test test/*.test.mjs
```

The glob form matters: `node --test .` fails on Node v26 with `Cannot find module`.

158 tests cover grouping and the unknown-shape tolerance, the AC-count rule, the transcript folder encoding and session summaries, the chat parser's never-drop rule (including a fixture record type that does not exist), the argument builder and the run registry, config load/save/validation, the code exchange (against the RFC 4226 and RFC 6238 published vectors) with its replay guard and lockout, the QR encoder (its codewords, error correction included, checked against vectors captured from an independent implementation, plus a round trip through a decoder written from the spec geometry rather than from the encoder), session issue and expiry, path safety, the split between the light dashboard and the on-demand job scan, the terminal launcher's argument list, and the `/usage` parser. Nothing in the suite starts a real `claude`, and no test opens a terminal window - every spawn is faked.

`client.html` has no test runner pointed at it; it is checked by hand in a browser.

---

## Not in here

- Token counts, cost estimates, analytics charts, rate-window reconstruction. Those stay in `claude-usage`.
- Rendering subagent transcripts. The count is shown; the transcripts are not.
- Streaming a reply token by token. The page polls the `.jsonl` instead.
- Answering permission prompts interactively.
- Editing `PLAN.md`, or anything under a monitored folder other than the workflow block that **Resolve** rewrites.
- Multi-user, accounts, roles, HTTPS. One pairing, one person.

## Credits

Grown out of two local tools: a private work-viewer dashboard (the architecture, the design language and `markdown.mjs`), and [claude-usage](https://github.com/mynrd/claude-usage) (transcript parsing and the `/usage` fetch).
