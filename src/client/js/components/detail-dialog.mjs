// The job detail dialog: one progress.json rendered across seven tabs, plus
// Resolve - the only action in Work Hub that writes into a monitored folder.
//
// The dialog shell is static markup in index.html; this module fills it.

import {
  esc, badge, relativeTime, acText, listLen, stamp, elapsed,
  AC_COLORS, CASE_COLORS, STATUS_COLORS, TASK_COLORS, TIER_COLORS, WORKFLOW_COLORS,
} from '../dom.mjs';
import { api } from '../api.mjs';
import { loadJobs, findJob } from '../data.mjs';
import { renderCurrentPage } from '../render.mjs';

const FULLSCREEN_KEY = 'work-hub-modal-fullscreen';

// ---- Panel renderers --------------------------------------------------------

// `Aug 30, 14:02 → Aug 30, 17:45 (3h 43m)` under a step's badge; only one
// half when only one stamp exists; nothing at all for a step with neither.
function stepTime(step) {
  var from = stamp(step.startedAt);
  var to = stamp(step.endedAt);
  if (!from && !to) return '';
  var text;
  if (from && to) {
    var took = elapsed(step.startedAt, step.endedAt);
    text = from + ' &#8594; ' + to + (took ? ' (' + took + ')' : '');
  } else if (from) {
    text = 'started ' + from;
  } else {
    text = 'ended ' + to;
  }
  return '<div class="wf-step__time">' + text + '</div>';
}

function renderWorkflow(progress) {
  var workflow = (progress && Array.isArray(progress.workflow)) ? progress.workflow : [];
  if (workflow.length === 0) return '<p class="muted">None recorded.</p>';
  return '<div class="wf-track">' + workflow.map(function (step) {
    var isObj = step && typeof step === 'object';
    var name = isObj ? step.step : step;
    var reason = isObj && step.reason ? '<div class="wf-step__reason">' + esc(step.reason) + '</div>' : '';
    return '<div class="wf-step"><div class="wf-step__name">' + esc(name === null || name === undefined ? '(unnamed)' : name) + '</div>' +
      badge(isObj ? step.status : undefined, WORKFLOW_COLORS) + (isObj ? stepTime(step) : '') + reason + '</div>';
  }).join('<div class="wf-arrow">&#8594;</div>') + '</div>';
}

function renderAcTable(progress) {
  var list = (progress && Array.isArray(progress.acceptanceCriteria)) ? progress.acceptanceCriteria : [];
  if (list.length === 0) return '<p class="muted">None recorded.</p>';
  var rows = list.map(function (ac) {
    if (!ac || typeof ac !== 'object') return '';
    var impl = Array.isArray(ac.implementedIn) ? ac.implementedIn.map(esc).join('<br/>') : esc(ac.implementedIn);
    return '<tr><td class="cell-mono" data-label="ID">' + esc(ac.id) + '</td><td data-label="Text">' + esc(ac.text) + '</td><td data-label="Status">' + badge(ac.status, AC_COLORS) + '</td>' +
      '<td data-label="Evidence">' + esc(ac.evidence) + '</td><td class="cell-mono" data-label="Task">' + esc(ac.task) + '</td><td class="cell-mono" data-label="In">' + impl + '</td></tr>';
  }).join('');
  return '<div class="table-wrap"><table class="table table--stack"><thead><tr><th>ID</th><th>Text</th><th>Status</th><th>Evidence</th><th>Task</th><th>Implemented in</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function renderTasks(progress) {
  var list = (progress && Array.isArray(progress.tasks)) ? progress.tasks : [];
  if (list.length === 0) return '<p class="muted">None recorded.</p>';
  var rows = list.map(function (t) {
    if (!t || typeof t !== 'object') return '';
    var commits = Array.isArray(t.commits) ? t.commits.join(', ') : '';
    return '<tr><td class="cell-mono" data-label="ID">' + esc(t.id) + '</td><td data-label="Title">' + esc(t.title) + '</td><td data-label="State">' + badge(t.state ?? t.status, TASK_COLORS) + '</td><td class="cell-mono" data-label="Commits">' + esc(commits) + '</td></tr>';
  }).join('');
  return '<div class="table-wrap"><table class="table table--stack"><thead><tr><th>ID</th><th>Title</th><th>State</th><th>Commits</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function renderTestTier(tier, label) {
  if (!tier || typeof tier !== 'object') return '<div><h4 class="mb-2">' + esc(label) + '</h4><p class="muted">None recorded.</p></div>';
  var cases = Array.isArray(tier.cases) ? tier.cases : [];
  var caseRows = cases.map(function (c) {
    if (!c || typeof c !== 'object') return '';
    return '<tr><td data-label="Case">' + esc(c.name) + '</td><td data-label="Status">' + badge(c.status, CASE_COLORS) + '</td>' +
      '<td class="cell-mono" data-label="AC">' + esc(Array.isArray(c.ac) ? c.ac.join(', ') : '') + '</td><td data-label="Note">' + esc(c.message) + '</td></tr>';
  }).join('');
  return '<div><h4 class="row gap-2 mb-2">' + esc(label) + ' ' + badge(tier.status, TIER_COLORS) + '</h4>' +
    (tier.command ? '<div class="cell-mono mb-2">' + esc(tier.command) + '</div>' : '') +
    (cases.length
      ? '<div class="table-wrap"><table class="table table--stack"><thead><tr><th>Case</th><th>Status</th><th>AC</th><th>Note</th></tr></thead><tbody>' + caseRows + '</tbody></table></div>'
      : '<p class="muted">No cases recorded.</p>') + '</div>';
}

function renderProgressRuns(progress) {
  var runs = (progress && Array.isArray(progress.runs)) ? progress.runs.slice().reverse() : [];
  if (runs.length === 0) return '<p class="muted">None recorded.</p>';
  return runs.map(function (run) {
    if (!run || typeof run !== 'object') return '';
    var agents = Array.isArray(run.agents) ? run.agents : [];
    var agentsHtml = agents.map(function (a) {
      if (!a || typeof a !== 'object') return '';
      var files = Array.isArray(a.files)
        ? '<details><summary>files (' + a.files.length + ')</summary>' + a.files.map(function (f) { return '<div class="cell-mono">' + esc(f) + '</div>'; }).join('') + '</details>'
        : '';
      return '<div class="run-agent"><div><span class="cell-mono">' + esc(a.agent) + '</span> — ' + esc(a.task) +
        ' <span class="muted fs-sm">(AC ' + esc(Array.isArray(a.ac) ? a.ac.join(', ') : '') + ')</span></div>' +
        '<div class="run-agent__outcome">' + esc(a.outcome) + '</div>' +
        (a.flag ? '<div class="run-agent__flag">&#9873; ' + esc(a.flag) + '</div>' : '') + files + '</div>';
    }).join('');
    return '<div class="run-card"><div class="run-head"><span class="cell-mono">round ' + esc(run.round) + '</span>' +
      '<span class="muted">' + esc(run.started) + '</span>' +
      '<span class="cell-mono">tasks: ' + esc(Array.isArray(run.tasks) ? run.tasks.join(', ') : '') + '</span></div>' + agentsHtml + '</div>';
  }).join('');
}

function renderIntake(progress) {
  var intake = progress && typeof progress.intake === 'object' ? progress.intake : null;
  if (!intake) return '<p class="muted">None recorded.</p>';
  var brief = intake.brief && typeof intake.brief === 'object' ? intake.brief : null;
  var dup = intake.duplicateCheck && typeof intake.duplicateCheck === 'object' ? intake.duplicateCheck : null;

  var topRows = [['At', intake.at ? esc(intake.at) : '—'], ['Route', intake.route ? esc(intake.route) : '—']];
  if (brief && brief.project) topRows.push(['Project', esc(brief.project)]);
  var topKv = '<div class="kv">' + topRows.map(function (r) {
    return '<div class="kv__row"><span class="kv__key">' + r[0] + '</span><span class="kv__val">' + r[1] + '</span></div>';
  }).join('') + '</div>';

  var briefBody = '<p class="muted">None recorded.</p>';
  if (brief) {
    var unknowns = Array.isArray(brief.unknowns) ? brief.unknowns : [];
    var built = ['what', 'whoWhy', 'signal', 'urgency'].map(function (key) {
      if (!brief[key]) return '';
      var label = key === 'whoWhy' ? 'Who / why' : key.charAt(0).toUpperCase() + key.slice(1);
      return '<div><div class="fs-xs muted mb-2">' + esc(label) + '</div><p>' + esc(brief[key]) + '</p></div>';
    }).join('') + (unknowns.length
      ? '<div><div class="fs-xs muted mb-2">Unknowns</div><ul>' + unknowns.map(function (u) { return '<li>' + esc(u) + '</li>'; }).join('') + '</ul></div>'
      : '');
    if (built) briefBody = built;
  }

  var dupBody = '<p class="muted">None recorded.</p>';
  if (dup) {
    var terms = Array.isArray(dup.terms) ? dup.terms : [];
    var candidates = Array.isArray(dup.candidates) ? dup.candidates : [];
    dupBody = (terms.length
      ? '<div class="row wrap gap-2">' + terms.map(function (t) { return '<span class="badge badge-neutral">' + esc(t) + '</span>'; }).join('') + '</div>'
      : '<p class="muted">No search terms recorded.</p>') +
      (candidates.length
        ? '<div class="table-wrap"><table class="table table--stack"><thead><tr><th>ID</th><th>State</th><th>Title</th><th>Verdict</th></tr></thead><tbody>' +
          candidates.map(function (c) {
            if (!c || typeof c !== 'object') return '';
            return '<tr><td class="cell-mono" data-label="ID">' + esc(c.id) + '</td><td data-label="State">' + badge(c.state) + '</td><td data-label="Title">' + esc(c.title) + '</td><td data-label="Verdict">' + esc(c.verdict) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="muted">No candidates recorded.</p>');
  }

  var findingsCard = '';
  if (Array.isArray(intake.findings) && intake.findings.length > 0) {
    findingsCard = '<div class="card"><div class="card__head"><div><h3>Findings</h3>' +
      '<p>Not part of the canonical schema - rendered because this job carries it.</p></div></div>' +
      '<div class="card__body"><ul>' + intake.findings.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul></div></div>';
  }

  return '<div class="col gap-5">' + topKv +
    '<div class="card"><div class="card__head"><div><h3>Brief</h3></div></div><div class="card__body col gap-3">' + briefBody + '</div></div>' +
    '<div class="card"><div class="card__head"><div><h3>Duplicate check</h3></div></div><div class="card__body col gap-3">' + dupBody + '</div></div>' +
    findingsCard + '</div>';
}

// ---- Tabs -------------------------------------------------------------------

const DETAIL_TABS = [
  { id: 'ac', label: 'Acceptance Criteria', count: function (job) { return listLen(job.progress && job.progress.acceptanceCriteria); } },
  { id: 'intake', label: 'Intake' },
  { id: 'tasks', label: 'Tasks', count: function (job) { return listLen(job.progress && job.progress.tasks); } },
  { id: 'tests', label: 'Tests', count: function (job) {
      var t = job.progress && job.progress.tests;
      var unit = t && t.unit && Array.isArray(t.unit.cases) ? t.unit.cases.length : 0;
      var ui = t && t.ui && Array.isArray(t.ui.cases) ? t.ui.cases.length : 0;
      return unit + ui;
    } },
  { id: 'runs', label: 'Runs', count: function (job) { return listLen(job.progress && job.progress.runs); } },
  { id: 'docs', label: 'Docs', count: function (job) { return listLen(job.mdFiles); } },
  { id: 'raw', label: 'Raw' },
];

const detailTabsEl = document.getElementById('detailTabs');

function setActiveTab(id) {
  // Reader mode only makes sense on the Docs tab. The tab strip is hidden
  // while reading, so this is a safety net rather than the normal exit path.
  if (id !== 'docs' && modalEl.classList.contains('is-reading')) applyReading(false);
  detailTabsEl.querySelectorAll('.tab').forEach(function (btn) {
    var active = btn.getAttribute('data-tab') === id;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.setAttribute('tabindex', active ? '0' : '-1');
  });
  DETAIL_TABS.forEach(function (t) {
    var panel = document.getElementById('panel-' + t.id);
    if (panel) panel.hidden = t.id !== id;
  });
}

detailTabsEl.addEventListener('click', function (e) {
  var btn = e.target.closest('.tab');
  if (btn) setActiveTab(btn.getAttribute('data-tab'));
});
detailTabsEl.addEventListener('keydown', function (e) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  var tabs = Array.prototype.slice.call(detailTabsEl.querySelectorAll('.tab'));
  var idx = tabs.indexOf(document.activeElement);
  if (idx === -1) return;
  e.preventDefault();
  var next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
  setActiveTab(tabs[next].getAttribute('data-tab'));
  tabs[next].focus();
});

// ---- Docs tab ---------------------------------------------------------------

let mdCache = {};

function loadMdFile(job, file) {
  var container = document.getElementById('mdContent');
  if (!container) return;
  if (Object.prototype.hasOwnProperty.call(mdCache, file)) { container.innerHTML = mdCache[file]; return; }
  container.innerHTML = '<p class="muted">Loading…</p>';
  api('/api/projects/' + encodeURIComponent(job.projectId) + '/jobs/' + encodeURIComponent(job.folder) + '/md/' + encodeURIComponent(file))
    .then(function (html) { mdCache[file] = html; container.innerHTML = html; })
    .catch(function (err) { container.innerHTML = '<p class="muted">Failed to load ' + esc(file) + ': ' + esc(err.message) + '</p>'; });
}

// ---- Fullscreen -------------------------------------------------------------

const overlay = document.getElementById('detailOverlay');
const modalEl = overlay.querySelector('.modal');
const fullscreenBtn = document.getElementById('detailFullscreenBtn');
const fullscreenIconUse = document.getElementById('fullscreenIconUse');

function applyFullscreen(on) {
  modalEl.classList.toggle('is-fullscreen', on);
  fullscreenBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  fullscreenBtn.setAttribute('aria-label', on ? 'Restore' : 'Maximise');
  fullscreenBtn.setAttribute('title', on ? 'Restore' : 'Maximise');
  fullscreenIconUse.setAttribute('href', on ? '#i-minimize' : '#i-maximize');
  try { localStorage.setItem(FULLSCREEN_KEY, on ? '1' : '0'); } catch (e) { /* storage blocked */ }
}

(function initFullscreen() {
  var stored = false;
  try { stored = localStorage.getItem(FULLSCREEN_KEY) === '1'; } catch (e) { /* default off */ }
  applyFullscreen(stored);
})();
fullscreenBtn.addEventListener('click', function () { applyFullscreen(!modalEl.classList.contains('is-fullscreen')); });

// ---- Reader mode --------------------------------------------------------------
// Docs tab only, and never persisted (unlike FULLSCREEN_KEY): every dialog
// open starts in normal mode regardless of how the previous one was left.

const mdReadBtn = document.getElementById('mdReadBtn');
const mdReadIconUse = document.getElementById('mdReadIconUse');
const mdReadLabel = document.getElementById('mdReadLabel');

function applyReading(on) {
  modalEl.classList.toggle('is-reading', on);
  mdReadBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  mdReadBtn.setAttribute('title', on ? 'Exit reader' : 'Read');
  mdReadIconUse.setAttribute('href', on ? '#i-x' : '#i-book');
  mdReadLabel.textContent = on ? 'Exit' : 'Read';
}

mdReadBtn.addEventListener('click', function () { applyReading(!modalEl.classList.contains('is-reading')); });

// ---- Open / close -----------------------------------------------------------

// The job the dialog is currently showing - Resolve acts on this one.
let currentJob = null;

export function openDetail(job) {
  currentJob = job;
  applyReading(false);
  var idLabel = job.id !== null && job.id !== undefined ? String(job.id) : job.folder;
  document.getElementById('detailIdLabel').textContent = idLabel + ' ';
  document.getElementById('detailTitleId').textContent = job.title || '(untitled)';
  document.getElementById('detailStatusBadge').innerHTML = ' ' + badge(job.status, STATUS_COLORS);
  document.getElementById('detailSubline').textContent = (job.projectName ? job.projectName + ' · ' : '') + job.folder;

  document.getElementById('detailMeta').innerHTML = [
    ['Folder', esc(job.folder)],
    ['Type', esc(job.type) || '—'],
    ['Current step', esc(job.currentStep) || '—'],
    ['AC', esc(acText(job))],
    ['Last activity', esc(relativeTime(job.lastActivity))],
  ].map(function (r) {
    return '<div class="kv__row"><span class="kv__key">' + r[0] + '</span><span class="kv__val">' + r[1] + '</span></div>';
  }).join('');

  document.getElementById('detailWorkflow').innerHTML = renderWorkflow(job.progress);
  document.getElementById('detailAc').innerHTML = renderAcTable(job.progress);
  document.getElementById('detailTasks').innerHTML = renderTasks(job.progress);
  document.getElementById('detailTests').innerHTML =
    renderTestTier(job.progress && job.progress.tests && job.progress.tests.unit, 'Unit') +
    renderTestTier(job.progress && job.progress.tests && job.progress.tests.ui, 'UI');
  document.getElementById('detailRuns').innerHTML = renderProgressRuns(job.progress);
  document.getElementById('detailIntake').innerHTML = renderIntake(job.progress);

  var raw;
  try { raw = JSON.stringify(job.progress, null, 2); } catch (e) { raw = String(job.progress); }
  document.getElementById('detailRaw').textContent = raw || '';

  mdCache = {};
  var files = Array.isArray(job.mdFiles) ? job.mdFiles : [];
  var mdTabs = document.getElementById('mdTabs');
  var mdContent = document.getElementById('mdContent');
  mdReadBtn.hidden = files.length === 0;
  if (files.length === 0) {
    mdTabs.innerHTML = '';
    mdTabs.hidden = true;
    mdContent.innerHTML = '<p class="muted">No markdown files for this job.</p>';
  } else {
    mdTabs.hidden = false;
    mdTabs.innerHTML = files.map(function (f) { return '<button type="button" class="chip" data-file="' + esc(f) + '">' + esc(f) + '</button>'; }).join('');
    var chips = mdTabs.querySelectorAll('.chip');
    chips.forEach(function (btn) {
      btn.addEventListener('click', function () {
        chips.forEach(function (c) { c.classList.remove('is-active'); });
        btn.classList.add('is-active');
        loadMdFile(job, btn.getAttribute('data-file'));
      });
    });
    chips[0].classList.add('is-active');
    loadMdFile(job, chips[0].getAttribute('data-file'));
  }

  detailTabsEl.innerHTML = DETAIL_TABS.map(function (t) {
    var n = typeof t.count === 'function' ? t.count(job) : null;
    return '<button type="button" class="tab' + (n === 0 ? ' is-empty' : '') + '" id="tab-' + t.id + '" role="tab" ' +
      'aria-selected="false" aria-controls="panel-' + t.id + '" tabindex="-1" data-tab="' + t.id + '">' +
      esc(t.label) + (n === null ? '' : ' <span class="badge badge-neutral">' + n + '</span>') + '</button>';
  }).join('');
  setActiveTab('ac');
  setResolveState(job);
  setVerifiedState(job);

  overlay.classList.add('is-open');
  document.getElementById('detailCloseBtn').focus();
}

function closeDetail() { overlay.classList.remove('is-open'); disarmResolve(); stopVerifyWatch(); applyReading(false); }

document.getElementById('detailCloseBtn').addEventListener('click', closeDetail);
overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDetail(); });
document.addEventListener('keydown', function (e) {
  if (!overlay.classList.contains('is-open')) return;
  if (e.key === 'Escape') {
    // Reader mode swallows the first Escape - it exits reading and leaves the
    // dialog open; a second Escape then closes the dialog as it always has.
    if (modalEl.classList.contains('is-reading')) { applyReading(false); return; }
    closeDetail();
    return;
  }
  if (e.key === 'f' || e.key === 'F') {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    applyFullscreen(!modalEl.classList.contains('is-fullscreen'));
  }
});

document.getElementById('detailRawCopyBtn').addEventListener('click', function () {
  var text = document.getElementById('detailRaw').textContent || '';
  var iconUse = document.getElementById('detailRawCopyIconUse');
  var btn = document.getElementById('detailRawCopyBtn');
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  navigator.clipboard.writeText(text).then(function () {
    iconUse.setAttribute('href', '#i-check');
    btn.setAttribute('title', 'Copied');
    setTimeout(function () { iconUse.setAttribute('href', '#i-copy'); btn.setAttribute('title', 'Copy'); }, 1500);
  }).catch(function () { /* clipboard blocked */ });
});

// ---- Verified ---------------------------------------------------------------
// Shown only while the job's human-verification step is in_progress. One click
// asks the server to open a PowerShell window running
// `claude -p '/mynrd-flow:mynrd-verified .work\<folder>'` in the project
// folder; the AI in that window does the write, not this page. No arming step:
// nothing here edits a file, and the window is on screen and stoppable.

const verifiedBtn = document.getElementById('detailVerifiedBtn');
const verifiedLabel = document.getElementById('detailVerifiedLabel');

function awaitingVerification(progress) {
  var list = progress && Array.isArray(progress.workflow) ? progress.workflow : [];
  return list.some(function (s) {
    return s && typeof s === 'object' && s.step === 'human-verification' && s.status === 'in_progress';
  });
}

let verifyPollTimer = null;

function stopVerifyWatch() {
  if (verifyPollTimer) { clearInterval(verifyPollTimer); verifyPollTimer = null; }
}

function verifyUrl(job) {
  return '/api/projects/' + encodeURIComponent(job.projectId) + '/jobs/' + encodeURIComponent(job.folder) + '/verify';
}

function setVerifiedState(job) {
  stopVerifyWatch();
  verifiedBtn.hidden = !awaitingVerification(job.progress);
  verifiedBtn.disabled = false;
  verifiedLabel.textContent = 'Verified';
  verifiedBtn.title = 'Open a PowerShell window running /mynrd-flow:mynrd-verified for this job';
}

// The human-verification box in the workflow track gets a spinner while the
// run's window is open.
function markVerificationBusy(on) {
  var steps = document.querySelectorAll('#detailWorkflow .wf-step');
  for (var i = 0; i < steps.length; i++) {
    var name = steps[i].querySelector('.wf-step__name');
    if (!name || name.textContent !== 'human-verification') continue;
    var busy = steps[i].querySelector('.wf-step__busy');
    if (on && !busy) {
      steps[i].classList.add('is-busy');
      steps[i].insertAdjacentHTML('beforeend', '<div class="wf-step__busy"><span class="spinner"></span> verifying…</div>');
    } else if (!on && busy) {
      steps[i].classList.remove('is-busy');
      busy.remove();
    }
  }
}

// Polls GET .../verify until the window has closed, then reloads the job so the
// dialog and the table show what the run wrote.
function watchVerifyRun(job) {
  stopVerifyWatch();
  verifiedBtn.disabled = true;
  verifiedLabel.textContent = 'Verifying…';
  verifiedBtn.title = 'The verification run is open in its own window. This updates when it closes.';
  markVerificationBusy(true);

  function finished(run) {
    stopVerifyWatch();
    if (currentJob !== job) return;
    loadJobs(job.projectId).then(function () {
      renderCurrentPage();
      var fresh = findJob(job.projectId, job.folder);
      if (!fresh || currentJob !== job) return;
      openDetail(fresh); // re-renders the workflow track from the new progress.json
      if (awaitingVerification(fresh.progress)) {
        // The window closed but the step is still in_progress: the run did not
        // (or could not) mark it. Leave the button ready for another go.
        verifiedLabel.textContent = 'Not verified - retry';
        verifiedBtn.title = 'The run ended' + (run && typeof run.exitCode === 'number' ? ' (exit code ' + run.exitCode + ')' : '') +
          ' without marking this job verified. Check the window output and try again.';
      }
    });
  }

  function poll() {
    api(verifyUrl(job)).then(function (run) {
      if (currentJob !== job) { stopVerifyWatch(); return; }
      if (!run || !run.running) finished(run);
    }).catch(function () { /* transient - keep polling */ });
  }
  verifyPollTimer = setInterval(poll, 2000);
  poll();
}

verifiedBtn.addEventListener('click', function () {
  if (!currentJob || verifiedBtn.disabled) return;
  var job = currentJob;
  verifiedBtn.disabled = true;
  verifiedLabel.textContent = 'Opening…';
  api(verifyUrl(job), { method: 'POST' })
    .then(function () {
      if (currentJob === job) watchVerifyRun(job);
    })
    .catch(function (err) {
      if (err.status === 409 && /already open/.test(err.message)) {
        // A window is already running for this job - just watch it.
        if (currentJob === job) watchVerifyRun(job);
        return;
      }
      verifiedBtn.disabled = false;
      verifiedLabel.textContent = 'Failed - retry';
      verifiedBtn.title = err.message;
    });
});

// ---- Resolve ----------------------------------------------------------------
// The only action in Work Hub that writes into a monitored folder: it sets
// every workflow step in the job's own progress.json to done, adding `build`
// and `human-verification` when the job's workflow never had them. Because it
// edits a real file in a real repo it takes two clicks, never one.

const REQUIRED_STEPS = ['build', 'human-verification'];
let resolveArmed = false;
let resolveTimer = null;
const resolveBtn = document.getElementById('detailResolveBtn');
const resolveLabel = document.getElementById('detailResolveLabel');

// Mirrors isResolved() in resolve-job.mjs.
function jobIsResolved(progress) {
  var list = (progress && Array.isArray(progress.workflow) ? progress.workflow : []).filter(function (s) { return s; });
  if (list.length === 0) return false;
  var allDone = list.every(function (s) { return s && typeof s === 'object' && s.status === 'done'; });
  var hasRequired = REQUIRED_STEPS.every(function (step) {
    return list.some(function (s) { return s && typeof s === 'object' && s.step === step; });
  });
  return allDone && hasRequired;
}

function disarmResolve() {
  resolveArmed = false;
  if (resolveTimer) { clearTimeout(resolveTimer); resolveTimer = null; }
  resolveBtn.classList.remove('btn-danger');
  resolveBtn.classList.add('btn-secondary');
}

function setResolveState(job) {
  disarmResolve();
  if (jobIsResolved(job.progress)) {
    resolveBtn.disabled = true;
    resolveLabel.textContent = 'Resolved';
    resolveBtn.title = 'Every workflow step is already done.';
  } else {
    resolveBtn.disabled = false;
    resolveLabel.textContent = 'Resolve';
    resolveBtn.title = "Mark every workflow step done in this job's progress.json";
  }
}

resolveBtn.addEventListener('click', function () {
  if (!currentJob || resolveBtn.disabled) return;

  if (!resolveArmed) {
    resolveArmed = true;
    resolveLabel.textContent = 'Write to progress.json?';
    resolveBtn.classList.remove('btn-secondary');
    resolveBtn.classList.add('btn-danger');
    // Arming lapses on its own, so a stray click never leaves the button
    // sitting one accidental click away from editing a file.
    resolveTimer = setTimeout(function () {
      if (resolveArmed) setResolveState(currentJob);
    }, 4000);
    return;
  }

  disarmResolve();
  resolveBtn.disabled = true;
  resolveLabel.textContent = 'Writing…';
  api('/api/projects/' + encodeURIComponent(currentJob.projectId) + '/jobs/' + encodeURIComponent(currentJob.folder) + '/resolve', { method: 'POST' })
    .then(function () {
      var pid = currentJob.projectId;
      closeDetail();
      // The job changes group, so that project is re-scanned rather than the
      // row patched in place. Only that project - nothing else moved.
      return loadJobs(pid).then(renderCurrentPage);
    })
    .catch(function (err) {
      resolveBtn.disabled = false;
      resolveLabel.textContent = 'Failed - retry';
      resolveBtn.title = err.message;
    });
});
