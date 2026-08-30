// Project page: the .work/ scan for one folder, beside its conversation list.

import { esc, errorCard, loadingCard } from '../dom.mjs';
import { state, timers } from '../state.mjs';
import { loadConfig, loadDashboard, loadJobs, loadSessions, projectOf } from '../data.mjs';
import { registerView, renderCurrentPage, setApp } from '../render.mjs';
import { jobTable, unreadableTable, wireJobRows } from '../components/job-table.mjs';
import { sessionsCardHtml, wireSessionPager, wireNewConversation, wireTerminal } from '../components/sessions-card.mjs';
import { gitPaneHtml, wireGitPane, enterGitPane, refreshGitPane } from '../components/git-card.mjs';

// The page-level tab strip: which pid maps to which tab lives in
// state.projectTab, so the 30s repaint (renderCurrentPage) keeps whatever was
// selected instead of snapping back to Work Items.
var PROJECT_TABS = [
  { id: 'work', label: 'Work Items' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'git', label: 'Branch and Commits' },
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
  } else {
    paneHtml = jobs
      ? jobTable('Worked today', 'A file under the job folder changed today.', jobs.today, 'info', false, 'Nothing has been touched today.') +
        jobTable('Not yet started', 'Build is still pending and no run has been recorded.', jobs.notStarted, 'accent', false, 'Every job has been started.') +
        jobTable('Others', 'Everything else.', jobs.others, 'neutral', false, 'Nothing here.') +
        unreadableTable(jobs.unreadable, false)
      : loadingCard('Jobs', 'Scanning .work/ in this folder.');
  }

  setApp(
    '<div class="page-head"><div><h1>' + esc(project.name) + '</h1><p class="mono">' + esc(project.path) + '</p></div>' +
    '<div class="row gap-2">' +
      '<a class="btn btn-secondary" href="#/"><svg class="icon"><use href="#i-back"/></svg> Dashboard</a>' +
      '<button type="button" class="btn btn-secondary" id="projectRefreshBtn" title="Re-scan .work/ and re-read the transcripts for this folder">' +
        '<svg class="icon"><use href="#i-refresh"/></svg> <span id="projectRefreshLabel">Refresh</span></button>' +
    '</div></div>' +
    (project.missing ? errorCard('This folder does not exist on disk right now.') : '') +
    projectTabsHtml(tab) +
    '<div class="tabpanel" id="panel-' + tab + '" role="tabpanel" aria-labelledby="ptab-' + tab + '">' + paneHtml + '</div>'
  );
  if (tab === 'work') wireJobRows();
  if (tab === 'conversation') { wireNewConversation(pid); wireTerminal(pid); wireSessionPager(pid); }
  if (tab === 'git') wireGitPane(pid);
  wireProjectTabs(pid);
  wireProjectRefresh(pid);
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
