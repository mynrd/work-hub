// The `.work/` job tables, shared by the dashboard and the project page.
//
// Every <td> carries a data-label. On a phone the responsive sheet hides the
// header row and prints that label beside the value instead, so a seven column
// table becomes a stack of cards rather than a 900px sideways scroll.

import { esc, badge, relativeTime, acText, emptyState, STATUS_COLORS } from '../dom.mjs';
import { state } from '../state.mjs';
import { app } from '../render.mjs';
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

export function jobTable(title, subtitle, jobs, badgeClass, showProject, emptyText) {
  var filtered = (jobs || []).filter(function (j) { return matchesSearch(j, state.search.trim()); });
  var head = '<div class="card__head"><div><h3>' + esc(title) + '</h3><p>' + subtitle + '</p></div>' +
    '<span class="badge badge-' + badgeClass + '">' + filtered.length + '</span></div>';
  if (filtered.length === 0) {
    return '<div class="card mb-5">' + head + emptyState('No jobs here', state.search.trim() ? 'No jobs match your search.' : emptyText) + '</div>';
  }
  // The colgroup is load-bearing: `.cell-title { max-width: 1px }` only
  // ellipsises inside a table whose column widths are declared, otherwise
  // auto-layout shrinks Title to its truncated content and the long titles
  // are unreadable.
  var cols = (showProject ? '<col style="width:150px">' : '') +
    '<col><col style="width:120px"><col style="width:170px"><col style="width:210px"><col style="width:150px">';
  return '<div class="card mb-5">' + head +
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
