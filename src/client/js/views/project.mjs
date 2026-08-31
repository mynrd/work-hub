// Project page: the .work/ scan for one folder, beside its conversation list.

import { esc, errorCard, loadingCard } from '../dom.mjs';
import { state, timers } from '../state.mjs';
import { loadConfig, loadDashboard, loadJobs, loadSessions, projectOf, saveConfig } from '../data.mjs';
import { registerView, renderCurrentPage, setApp } from '../render.mjs';
import { jobTable, unreadableTable, wireJobRows } from '../components/job-table.mjs';
import { sessionsCardHtml, wireSessionPager, wireNewConversation, wireTerminal } from '../components/sessions-card.mjs';
import { gitPaneHtml, wireGitPane, enterGitPane, refreshGitPane } from '../components/git-card.mjs';
import { terminalPaneHtml, wireTerminalPane, terminalPaneIsLive } from '../components/terminal-pane.mjs';

// The page-level tab strip: which pid maps to which tab lives in
// state.projectTab, so the 30s repaint (renderCurrentPage) keeps whatever was
// selected instead of snapping back to Work Items.
var PROJECT_TABS = [
  { id: 'work', label: 'Work Items' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'git', label: 'Branch and Commits' },
  { id: 'terminal', label: 'Terminal' },
];

function projectTabsHtml(tab) {
  return '<div class="tabs" role="tablist" aria-label="Project sections" id="projectTabs">' +
    PROJECT_TABS.map(function (t) {
      var active = t.id === tab;
      return '<button type="button" class="tab' + (active ? ' is-active' : '') + '" id="ptab-' + t.id + '" role="tab" ' +
        'aria-selected="' + (active ? 'true' : 'false') + '" aria-controls="panel-' + t.id + '" tabindex="' + (active ? '0' : '-1') + '" data-tab="' + t.id + '">' +
        esc(t.label) + '</button>';
    }).join('') +
  '</div>';
}

function renderProject() {
  var pid = state.route.pid;
  var project = projectOf(pid);
  if (!project) {
    if (!state.dashboard) { setApp(loadingCard('Project', 'Reading the configured folders.')); return; }
    setApp(errorCard('No configured project with id ' + pid + '. It may have been removed in Settings.'));
    return;
  }
  var jobs = state.jobs[pid];
  var tab = state.projectTab[pid] || 'work';

  var paneHtml;
  if (tab === 'conversation') {
    paneHtml = sessionsCardHtml(pid, null);
  } else if (tab === 'git') {
    paneHtml = '<div id="gitPane">' + gitPaneHtml(pid) + '</div>';
  } else if (tab === 'terminal') {
    // A live terminal must not be rebuilt by the 30s repaint - replacing the
    // DOM detaches xterm and steals its focus mid-typing. The page around it
    // is static enough to leave as it is until the tab changes.
    if (terminalPaneIsLive(pid)) return;
    paneHtml = terminalPaneHtml(pid);
  } else {
    paneHtml = jobs
      ? jobTable('Worked today', 'A file under the job folder changed today.', jobs.today, 'info', false, 'Nothing has been touched today.') +
        jobTable('Not yet started', 'Build is still pending and no run has been recorded.', jobs.notStarted, 'accent', false, 'Every job has been started.') +
        jobTable('Others', 'Everything else.', jobs.others, 'neutral', false, 'Nothing here.') +
        unreadableTable(jobs.unreadable, false)
      : loadingCard('Jobs', 'Scanning .work/ in this folder.');
  }

  setApp(
    '<div class="page-head"><div><h1><button type="button" class="title-edit" id="projectNameBtn" title="Click to rename this project">' +
      esc(project.name) + '</button></h1><p class="mono">' + esc(project.path) + '</p></div>' +
    '<div class="row gap-2">' +
      '<a class="btn btn-secondary" href="#/"><svg class="icon"><use href="#i-back"/></svg> Dashboard</a>' +
      '<button type="button" class="btn btn-secondary" id="projectRefreshBtn" title="Re-scan .work/ and re-read the transcripts for this folder">' +
        '<svg class="icon"><use href="#i-refresh"/></svg> <span id="projectRefreshLabel">Refresh</span></button>' +
    '</div></div>' +
    (project.missing ? errorCard('This folder does not exist on disk right now.') : '') +
    projectTabsHtml(tab) +
    '<div class="tabpanel" id="panel-' + tab + '" role="tabpanel" aria-labelledby="ptab-' + tab + '">' + paneHtml + '</div>' +
    // The rename dialog: same overlay/modal idiom as Settings' project-name
    // dialog (openNameDialog in settings.mjs), but its own ids - this is a
    // rename of an already-configured project, not the add-folder flow.
    '<div class="overlay" id="projectRenameOverlay" role="dialog" aria-modal="true" aria-labelledby="projectRenameTitle">' +
      '<div class="modal modal--sm">' +
        '<div class="modal__head"><div><h3 id="projectRenameTitle">Rename this project</h3></div></div>' +
        '<div class="modal__body">' +
          '<div class="col gap-2"><label class="fs-xs muted" for="projectRenameInput">Project name</label>' +
            '<input class="input" id="projectRenameInput" /></div>' +
          '<div id="projectRenameError" class="fs-sm" style="color:var(--danger-fg)" hidden></div>' +
          '<div class="row gap-2">' +
            '<button type="button" class="btn btn-primary" id="projectRenameSaveBtn">Save</button>' +
            '<button type="button" class="btn btn-secondary" id="projectRenameCancelBtn">Cancel</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
  if (tab === 'work') wireJobRows();
  if (tab === 'conversation') { wireNewConversation(pid); wireTerminal(pid); wireSessionPager(pid); }
  if (tab === 'git') wireGitPane(pid);
  if (tab === 'terminal') wireTerminalPane(pid);
  wireProjectTabs(pid);
  wireProjectRefresh(pid);
  wireProjectName(project);
}

/* Opens on a click (or Enter/Space, for free - it's a real <button>) on the
   h1, prefilled with the current display name. Saving writes projectNames
   keyed by the project's configured path (not its id, which is derived from
   the path and would break the link if the path ever changed) - an empty
   name deletes the key instead of storing '', so config.mjs's
   normalizeProjectNames drops it server-side and the dashboard falls back to
   the folder basename. The dashboard is reloaded (not just patched locally)
   so this page and the next dashboard visit agree on the name in one place. */
function wireProjectName(project) {
  var btn = document.getElementById('projectNameBtn');
  var overlay = document.getElementById('projectRenameOverlay');
  var input = document.getElementById('projectRenameInput');
  var saveBtn = document.getElementById('projectRenameSaveBtn');
  var cancelBtn = document.getElementById('projectRenameCancelBtn');
  var errorEl = document.getElementById('projectRenameError');
  if (!btn) return;

  function showError(message) { errorEl.textContent = message; errorEl.hidden = !message; }

  function openDialog() {
    showError('');
    input.value = project.name;
    overlay.classList.add('is-open');
    input.focus();
    input.select();
    // The project page never loads config on its own - kick it off now so
    // Save has state.config.projectNames to merge into, without blocking the
    // dialog opening on it.
    if (!state.config) loadConfig();
  }
  function closeDialog() { overlay.classList.remove('is-open'); }

  btn.addEventListener('click', openDialog);

  saveBtn.addEventListener('click', function () {
    var name = input.value.trim();
    saveBtn.disabled = true;
    (state.config ? Promise.resolve() : loadConfig()).then(function () {
      var names = Object.assign({}, state.config.projectNames || {});
      if (name) names[project.path] = name; else delete names[project.path];
      return saveConfig({ projectNames: names });
    }).then(function () {
      saveBtn.disabled = false;
      closeDialog();
      state.dashboard = null;
      return loadDashboard();
    }).then(renderCurrentPage)
      .catch(function (err) { saveBtn.disabled = false; showError(err.message); });
  });

  cancelBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDialog(); });
  overlay.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDialog(); });
}

/* Same click + arrow-key idiom as the job detail dialog's tab strip
   (detail-dialog.mjs setActiveTab), except switching tabs here rebuilds the
   whole page rather than toggling `hidden` on panels that already exist -
   only the active pane is ever in the DOM - so a keyboard switch re-focuses
   the new tab button by id after the repaint. */
function wireProjectTabs(pid) {
  var tabsEl = document.getElementById('projectTabs');
  if (!tabsEl) return;
  tabsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (btn) setProjectTab(pid, btn.getAttribute('data-tab'), false);
  });
  tabsEl.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    var tabs = Array.prototype.slice.call(tabsEl.querySelectorAll('.tab'));
    var idx = tabs.indexOf(document.activeElement);
    if (idx === -1) return;
    e.preventDefault();
    var next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
    setProjectTab(pid, tabs[next].getAttribute('data-tab'), true);
  });
}

function setProjectTab(pid, id, focus) {
  state.projectTab[pid] = id;
  // The git tab's own data is lazy: status always refetches, branches/commits
  // only the first time (see enterGitPane in git-card.mjs).
  if (id === 'git') enterGitPane(pid);
  renderCurrentPage();
  if (focus) {
    var btn = document.getElementById('ptab-' + id);
    if (btn) btn.focus();
  }
}

/* Same two calls the 30s timer makes - the .work scan and the transcript
   listing for this one folder - on demand. `renderCurrentPage` rebuilds the
   page, and with it this button, so the label is not restored here. */
function wireProjectRefresh(pid) {
  var btn = document.getElementById('projectRefreshBtn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var label = document.getElementById('projectRefreshLabel');
    if (btn.disabled) return;
    btn.disabled = true;
    if (label) label.textContent = 'Refreshing…';
    var tasks = [loadJobs(pid), loadSessions(pid)];
    // The git tab's own cache only wipes on this click (or a branch
    // re-select) - see refreshGitPane in git-card.mjs.
    if (state.projectTab[pid] === 'git') tasks.push(refreshGitPane(pid));
    Promise.all(tasks).then(renderCurrentPage);
  });
}

function enterProject() {
  var pid = state.route.pid;
  renderCurrentPage();
  // The scan and the transcript listing both start now, on this one project,
  // and each repaints as it lands - the sessions card does not wait for the
  // .work scan, and vice versa.
  (state.config ? Promise.resolve() : loadConfig()).then(renderCurrentPage);
  (state.dashboard ? Promise.resolve() : loadDashboard()).then(renderCurrentPage);
  loadJobs(pid).then(renderCurrentPage);
  loadSessions(pid).then(renderCurrentPage);
  // Covers revisiting this project with the git tab already selected from an
  // earlier visit - setProjectTab only fires enterGitPane on an actual click.
  if (state.projectTab[pid] === 'git') enterGitPane(pid);
  timers.dashboard = setInterval(function () {
    Promise.all([loadJobs(pid), loadSessions(pid)]).then(renderCurrentPage);
  }, 30000);
}

registerView('project', { render: renderProject, enter: enterProject });
