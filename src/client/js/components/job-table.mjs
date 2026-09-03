// The `.work/` job tables, shared by the dashboard and the project page.
//
// Every <td> carries a data-label. On a phone the responsive sheet hides the
// header row and prints that label beside the value instead, so a seven column
// table becomes a stack of cards rather than a 900px sideways scroll.

import { esc, badge, relativeTime, acText, emptyState, STATUS_COLORS } from '../dom.mjs';
import { state } from '../state.mjs';
import { app, renderCurrentPage } from '../render.mjs';
import { findJob } from '../data.mjs';
import { openDetail } from './detail-dialog.mjs';

export function matchesSearch(job, q) {
  if (!q) return true;
  var hay = [job.folder, job.title, job.id, job.status, job.projectName].map(function (v) {
    return v === null || v === undefined ? '' : String(v).toLowerCase();
  }).join(' ');
  return hay.indexOf(q.toLowerCase()) !== -1;
}

function jobRow(job, showProject) {
  var idLabel = job.id !== null && job.id !== undefined ? String(job.id) : job.folder;
  var live = job.activeReason ? '<span class="badge badge-info">' + esc(job.activeReason) + '</span>' : '';
  return '<tr data-project="' + esc(job.projectId) + '" data-folder="' + esc(job.folder) + '" tabindex="0">' +
    (showProject ? '<td class="cell-mono" data-label="Project">' + esc(job.projectName) + '</td>' : '') +
    // One cell, two lines. The wrapper div is load-bearing on a phone: the
    // stacked cell is a two-column grid whose first item is the ::before label,
    // so two bare divs would put the title under the label instead of under
    // the id. One wrapper keeps it `label | (id + title)`.
    '<td class="cell-title" data-label="Job / Title"><div class="cell-job">' +
      '<div class="cell-job__id cell-mono">' + esc(idLabel) + '</div>' +
      '<div class="cell-job__title" title="' + esc(job.title || '(untitled)') + '">' + esc(job.title || '(untitled)') + '</div>' +
    '</div></td>' +
    '<td data-label="Status">' + badge(job.status, STATUS_COLORS) + '</td>' +
    '<td class="cell-mono" data-label="Step">' + esc(job.currentStep || '—') + '</td>' +
    '<td class="cell-mono" data-label="AC">' + esc(acText(job)) + '</td>' +
    '<td class="cell-mono" data-label="Activity" title="' + esc(job.lastActivity ? new Date(job.lastActivity).toISOString() : '') + '">' + esc(relativeTime(job.lastActivity)) + ' ' + live + '</td>' +
  '</tr>';
}

/* The in-card search box, only on the card that asked for one (the project
   page's Others table). Same markup and the same .sess-find* classes as the
   conversations card, so there is one search box design in the app. */
function jobFindHtml(find, shown) {
  var q = find.value || '';
  return '<div class="sess-find">' +
    '<div class="sess-find__box">' +
      '<svg class="icon icon-sm"><use href="#i-search"/></svg>' +
      '<input type="search" id="' + esc(find.id) + '" autocomplete="off" placeholder="Search jobs…" aria-label="Search jobs" value="' + esc(q) + '" />' +
      (q
        ? '<button type="button" class="sess-find__clear" id="' + esc(find.id) + 'Clear" aria-label="Clear search" title="Clear search"><svg class="icon icon-sm"><use href="#i-x"/></svg></button>'
        : '') +
    '</div>' +
    (q.trim() ? '<span class="sess-find__count">' + shown + ' match' + (shown === 1 ? '' : 'es') + '</span>' : '') +
  '</div>';
}

export function jobTable(title, subtitle, jobs, badgeClass, showProject, emptyText, opts) {
  // `find` is optional: the dashboard and the other project-page tables pass
  // nothing and keep the topbar search as their only filter.
  var find = opts && opts.find ? opts.find : null;
  var filtered = (jobs || []).filter(function (j) {
    return matchesSearch(j, state.search.trim()) && (!find || matchesSearch(j, (find.value || '').trim()));
  });
  var head = '<div class="card__head"><div><h3>' + esc(title) + '</h3><p>' + subtitle + '</p></div>' +
    '<span class="badge badge-' + badgeClass + '">' + filtered.length + '</span></div>';
  // Rendered in the empty case too - a filter that matched nothing must still
  // be clearable.
  var findBlock = find ? jobFindHtml(find, filtered.length) : '';
  if (filtered.length === 0) {
    var searching = state.search.trim() || (find && (find.value || '').trim());
    return '<div class="card mb-5">' + head + findBlock +
      emptyState('No jobs here', searching ? 'No jobs match your search.' : emptyText) + '</div>';
  }
  // The colgroup is load-bearing: `.cell-title { max-width: 1px }` only
  // ellipsises inside a table whose column widths are declared, otherwise
  // auto-layout shrinks Title to its truncated content and the long titles
  // are unreadable.
  var cols = (showProject ? '<col style="width:150px">' : '') +
    '<col><col style="width:120px"><col style="width:170px"><col style="width:210px"><col style="width:150px">';
  return '<div class="card mb-5">' + head + findBlock +
    '<div class="table-wrap"><table class="table table--stack table--rows-clickable"><colgroup>' + cols + '</colgroup><thead><tr>' +
    (showProject ? '<th>Project</th>' : '') +
    '<th>Job / Title</th><th>Status</th><th>Step</th><th>AC progress</th><th>Activity</th>' +
    '</tr></thead><tbody>' + filtered.map(function (j) { return jobRow(j, showProject); }).join('') + '</tbody></table></div></div>';
}

export function unreadableTable(list, showProject) {
  var rows = (list || []).map(function (u) {
    return '<tr>' + (showProject ? '<td class="cell-mono" data-label="Project">' + esc(u.projectName) + '</td>' : '') +
      '<td class="cell-mono" data-label="Folder">' + esc(u.folder) + '</td><td data-label="Reason">' + esc(u.reason) + '</td></tr>';
  }).join('');
  var head = '<div class="card__head"><div><h3>Unreadable</h3><p>A folder under <span class="mono">.work/</span> with no readable <span class="mono">progress.json</span>.</p></div>' +
    '<span class="badge badge-warning">' + (list || []).length + '</span></div>';
  if (!list || list.length === 0) {
    return '<div class="card mb-5">' + head + emptyState('None', 'Every job folder has a readable progress.json.') + '</div>';
  }
  return '<div class="card mb-5">' + head + '<div class="table-wrap"><table class="table table--stack"><thead><tr>' +
    (showProject ? '<th>Project</th>' : '') + '<th>Folder</th><th>Reason</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}

export function wireJobRows() {
  app.querySelectorAll('tr[data-folder]').forEach(function (row) {
    var open = function (ev) {
      if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.type === 'keydown') ev.preventDefault();
      var job = findJob(row.getAttribute('data-project'), row.getAttribute('data-folder'));
      if (job) openDetail(job);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', open);
  });
}

// Where the caret was when the repaint took the focused search box away with it.
var findFocus = { on: false, start: 0, end: 0 };
var findTimer = null;

/* The project page is rebuilt on the 30s tick and on Refresh, which replaces
   the input this caret was in. Without putting it back, typing in the Others
   search box would be interrupted every half minute. */
export function wireJobFind(pid) {
  var clear = document.getElementById('jobFindClear');
  if (clear) {
    clear.addEventListener('click', function () {
      state.jobFind[pid] = '';
      findFocus.on = false;
      renderCurrentPage();
    });
  }

  var find = document.getElementById('jobFind');
  if (!find) return;
  var remember = function () { findFocus = { on: true, start: find.selectionStart, end: find.selectionEnd }; };
  find.addEventListener('focus', remember);
  find.addEventListener('keyup', remember);
  find.addEventListener('click', remember);
  // Only a blur the reader caused counts. The repaint fires one too when it
  // tears the input out of the document, and that must not read as "they left
  // the box". Chromium fires that blur while the old input is still connected,
  // so the answer is only reliable once the repaint has finished: by then a
  // torn-out input is disconnected and one the reader tabbed out of is not.
  find.addEventListener('blur', function () {
    setTimeout(function () { if (find.isConnected) findFocus.on = false; }, 0);
  });
  find.addEventListener('input', function () {
    remember();
    state.jobFind[pid] = find.value;
    if (findTimer) clearTimeout(findTimer);
    findTimer = setTimeout(function () { findTimer = null; renderCurrentPage(); }, 200);
  });
  find.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && find.value) {
      e.preventDefault();
      state.jobFind[pid] = '';
      renderCurrentPage();
    }
  });

  if (findFocus.on) {
    var start = findFocus.start;
    var end = findFocus.end;
    find.focus();
    find.setSelectionRange(start, end);
    findFocus = { on: true, start: start, end: end };
  }
}
