// Project page: the .work/ scan for one folder, beside its conversation list.

import { esc, errorCard, loadingCard } from '../dom.mjs';
import { state, timers } from '../state.mjs';
import { loadConfig, loadDashboard, loadJobs, loadSessions, projectOf } from '../data.mjs';
import { registerView, renderCurrentPage, setApp } from '../render.mjs';
import { jobTable, unreadableTable, wireJobRows } from '../components/job-table.mjs';
import { sessionsCardHtml, wireSessionPager, wireNewConversation, wireTerminal } from '../components/sessions-card.mjs';

function renderProject() {
  var pid = state.route.pid;
  var project = projectOf(pid);
  if (!project) {
    if (!state.dashboard) { setApp(loadingCard('Project', 'Reading the configured folders.')); return; }
    setApp(errorCard('No configured project with id ' + pid + '. It may have been removed in Settings.'));
    return;
  }
  var jobs = state.jobs[pid];

  setApp(
    '<div class="page-head"><div><h1>' + esc(project.name) + '</h1><p class="mono">' + esc(project.path) + '</p></div>' +
    '<div class="row gap-2">' +
      '<a class="btn btn-secondary" href="#/"><svg class="icon"><use href="#i-back"/></svg> Dashboard</a>' +
      '<button type="button" class="btn btn-secondary" id="projectRefreshBtn" title="Re-scan .work/ and re-read the transcripts for this folder">' +
        '<svg class="icon"><use href="#i-refresh"/></svg> <span id="projectRefreshLabel">Refresh</span></button>' +
    '</div></div>' +
    (project.missing ? errorCard('This folder does not exist on disk right now.') : '') +
    '<div class="split">' +
      '<div>' +
        (jobs
          ? jobTable('Worked today', 'A file under the job folder changed today.', jobs.today, 'info', false, 'Nothing has been touched today.') +
            jobTable('Not yet started', 'Build is still pending and no run has been recorded.', jobs.notStarted, 'accent', false, 'Every job has been started.') +
            jobTable('Others', 'Everything else.', jobs.others, 'neutral', false, 'Nothing here.') +
            unreadableTable(jobs.unreadable, false)
          : loadingCard('Jobs', 'Scanning .work/ in this folder.')) +
      '</div>' +
      '<div>' + sessionsCardHtml(pid, null) + '</div>' +
    '</div>'
  );
  wireJobRows();
  wireNewConversation(pid);
  wireTerminal(pid);
  wireSessionPager(pid);
  wireProjectRefresh(pid);
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
    Promise.all([loadJobs(pid), loadSessions(pid)]).then(renderCurrentPage);
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
  timers.dashboard = setInterval(function () {
    Promise.all([loadJobs(pid), loadSessions(pid)]).then(renderCurrentPage);
  }, 30000);
}

registerView('project', { render: renderProject, enter: enterProject });
