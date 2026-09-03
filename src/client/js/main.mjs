// Entry point. Importing a view registers it against its route name, so the
// four imports below are what makes the router able to reach any page at all.

import { state } from './state.mjs';
import { renderCurrentPage } from './render.mjs';
import { loadChat, loadConfig, loadDashboard, loadJobs, loadSessions, loadUsage } from './data.mjs';
import { initTheme } from './theme.mjs';
import { initRouter } from './router.mjs';
import { initProcessesDialog } from './components/processes-dialog.mjs';
import { initScrollJump } from './components/scroll-jump.mjs';

import './views/dashboard.mjs';
import './views/settings.mjs';
import './views/project.mjs';
import './views/conversation.mjs';

initTheme();
initProcessesDialog();
initScrollJump();

// ---- Topbar -----------------------------------------------------------------

const searchInput = document.getElementById('searchInput');

searchInput.addEventListener('input', function (e) {
  state.search = e.target.value;
  if (state.route.name === 'dashboard' || state.route.name === 'project') renderCurrentPage();
});

document.addEventListener('keydown', function (e) {
  if (e.key === '/' && document.activeElement !== searchInput && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    searchInput.focus();
  }
});

// Refresh re-fetches whatever the current page actually shows, nothing wider.
document.getElementById('refreshBtn').addEventListener('click', function () {
  var r = state.route;
  if (r.name === 'conversation') {
    Promise.all([loadChat(r.pid, r.sid), loadSessions(r.pid)]).then(renderCurrentPage);
  } else if (r.name === 'project') {
    Promise.all([loadJobs(r.pid), loadSessions(r.pid)]).then(renderCurrentPage);
  } else {
    Promise.all([loadConfig(), loadDashboard(), loadUsage()]).then(renderCurrentPage);
  }
});

initRouter();
