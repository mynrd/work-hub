// The single mutable store. Views read it, data.mjs writes it, and nothing in
// here knows how any of it gets rendered.

export const state = {
  route: { name: 'dashboard' },
  dashboard: null,
  config: null,
  auth: null,          // GET /api/auth/status: { required, pinSet, via, idleMinutes }
  usage: null,
  jobs: {},            // pid -> { today[], notStarted[], others[], unreadable[] }, loaded on demand
  sessions: {},        // pid -> { transcriptDir, sessions[] }
  sessPage: {},        // pid -> 0-based page of the conversation list
  projectTab: {},      // pid -> 'work' | 'conversation' | 'git' | 'terminal', which project-page tab is open
  gitView: {},         // pid -> the Branch and Commits tab's own state + cache (see git-card.mjs)
  chat: null,          // { sessionId, messages[] }
  activeRun: null,
  search: '',
  error: null,
};

export const timers = { dashboard: null, run: null, chat: null };

export function clearTimers() {
  Object.keys(timers).forEach(function (k) {
    if (timers[k]) { clearInterval(timers[k]); timers[k] = null; }
  });
}

// Kept outside the composer so a half-typed prompt survives the repaint that
// every poll tick triggers.
export const composerDraft = { model: null, effort: null, permissionMode: null, text: '' };
