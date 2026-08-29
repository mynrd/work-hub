# Work Hub

A local web dashboard over several project folders at once, plus a console for the Claude Code conversations that happened in them.

Two things in one page:

- **Jobs.** Every configured folder is scanned for `.work/<job>/progress.json` and the jobs are grouped into **Worked today**, **Not yet started** and **Others**, with a tabbed detail dialog per job (Acceptance Criteria, Intake, Tasks, Tests, Runs, Docs, Raw).
- **Conversations.** Every Claude Code session whose working directory was that folder, rendered as a chat, with a composer that can reply to a session or start a new one by running `claude` for you.

It also shows your real subscription usage, straight from `claude -p /usage`.

Node built-ins only. No `package.json`, no `npm install`, no dependencies.

---

## Run it

```powershell
.\run.ps1                 # loopback only - http://127.0.0.1:8731/
.\run.ps1 -OpenBrowser    # same, and open the browser once it answers
```

or directly:

```powershell
node serve.mjs                        # 127.0.0.1:8731
node serve.mjs --port 9000            # a different port
node serve.mjs --host 192.168.1.20    # a specific interface (token required)
node serve.mjs --lan                  # every interface  (token required)
node serve.mjs --token my-secret-here # supply the token instead of generating one
```

On start it prints the bound address and the config file path. A port already in use, or an address this machine does not own, fails with a one-line message naming the flag to change, and exits 1.

### Requirements

- **Node 18+** (developed against v26.7.0).
- **`claude` on PATH and signed in.** The Plan Usage card and every reply shell out to it.
- Read access to `~/.claude/projects`, where Claude Code keeps its transcripts.

---

## ⚠ Exposure

**This is not a read-only viewer.** It can start `claude` under your account, in your project folders, spending your subscription. A run started from the page can edit files - the Permissions select even offers `bypassPermissions`, which is `--dangerously-skip-permissions`.

That is checked, not assumed: in `-p` mode with the default permission mode, a `Write` tool call executed and the file appeared on disk with no prompt (see the spike notes at the top of [claude-run.mjs](claude-run.mjs)). "Headless" does not mean "read only".

So:

- The default bind is **loopback only**. Nothing off this machine can reach it.
- Any **non-loopback bind requires a token**. `serve.mjs` generates one and prints it, or you pass `--token <secret>`. Every `/api/*` request must carry it as the `X-Hub-Token` header; the page asks for it once and keeps it in `localStorage`. `GET /` is always served so the token can be entered.
- `--no-token` exists for loopback only. Combining it with a non-loopback host refuses to start.
- Binding beyond loopback also needs a Windows Firewall inbound-allow rule. `run.ps1` checks for one and prints the exact `New-NetFirewallRule` command; it never creates one, because that needs elevation.

Anyone who reaches the port and holds the token can read every file under your `.work/` folders, read every Claude Code transcript for the monitored projects, and start new Claude runs. Treat the token like an SSH key.

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
  "defaults": { "model": "claude-fable-5", "effort": "medium", "permissionMode": "default" }
}
```

Edit it from the **Settings** page. Adding a path that does not exist is refused with the reason. A folder with no `.work/` is fine - it is listed with `0 jobs` and its conversations still work.

`usageIntervalMinutes: 0` means the Plan Usage card only refreshes when you click Refresh.

A hand-mangled config never stops the server: unknown or wrongly-typed fields fall back to the defaults, and a file that is not valid JSON loads as empty with the reason shown at the top of the dashboard.

---

## How the pieces map

```text
serve.mjs            HTTP server, arg parsing, routes, token check
run.ps1              PowerShell wrapper: bind selection, firewall check, exposure warning
client.html          the whole UI - markup, CSS and JS inline, no build step
config.mjs           ~/.work-hub/config.json, path validation, the model/effort/permission allowlists
workscan.mjs         scanWorkFolder(projectPath, {now}) -> { today, notStarted, others, unreadable }
resolve-job.mjs      Resolve - the one writer into a monitored folder, format-preserving
transcripts.mjs      encodeProjectFolder(), listSessions(), readSessionChat()
usage.mjs            fetchCliUsage() + parseUsage() + the refresh timer
claude-run.mjs       buildArgs(), the run registry, the spawn
markdown.mjs         the Docs tab renderer (copied verbatim from work-viewer)
*.test.mjs           node --test
test-fixtures/       .work trees, a transcript, /usage samples
```

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

---

## Routes

| Method | Route | Returns |
|---|---|---|
| GET | `/` | `client.html` |
| GET / PUT | `/api/config` | the config; PUT validates every path with `statSync().isDirectory()` |
| GET | `/api/dashboard` | `{ projects[], today[], notStarted[], others[], unreadable[] }` - re-scanned every call, no cache |
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

Only `PUT /api/config`, the two POST run routes, `/api/usage/refresh` and `/api/projects/:pid/jobs/:folder/resolve` change anything. Everything else is read-only.

`resolve` is the single route that writes into a monitored folder - see below. Otherwise the only files Work Hub writes are `~/.work-hub/config.json` and whatever `claude` itself writes.

---

## Tests

```powershell
node --test *.test.mjs
```

The glob form matters: `node --test .` fails on Node v26 with `Cannot find module`.

95 tests cover grouping and the unknown-shape tolerance, the AC-count rule, the transcript folder encoding and session summaries, the chat parser's never-drop rule (including a fixture record type that does not exist), the argument builder and the run registry, config load/save/validation, the token gate, path safety, and the `/usage` parser. Nothing in the suite starts a real `claude` - every spawn is faked.

`client.html` has no test runner pointed at it; it is checked by hand in a browser.

---

## Not in here

- Token counts, cost estimates, analytics charts, rate-window reconstruction. Those stay in `claude-usage`.
- Rendering subagent transcripts. The count is shown; the transcripts are not.
- Streaming a reply token by token. The page polls the `.jsonl` instead.
- Answering permission prompts interactively.
- Editing `PLAN.md`, or anything under a monitored folder other than the workflow block that **Resolve** rewrites.
- Multi-user, auth beyond the shared token, HTTPS.

## Credits

Grown out of two local tools: a private work-viewer dashboard (the architecture, the design language and `markdown.mjs`), and [claude-usage](https://github.com/mynrd/claude-usage) (transcript parsing and the `/usage` fetch).
