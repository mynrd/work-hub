// The Processes dialog behind the topbar button: every shell Work Hub started,
// across all projects, in one place - regardless of which page you are on.
//
// Two kinds of row (GET /api/shells, see lib/processes.mjs):
//   - `session`: a shell this server owns. Killed by shellId, which closes its
//     pty cleanly (DELETE /api/shells/:shellId).
//   - `external`: a straggler the OS still shows from a past run of the app.
//     Killed by pid with taskkill (DELETE /api/processes/:pid).
//
// It reads the list on open and on Refresh. It does not poll: a terminal you
// kill here is reflected in its own tab by the output stream's exit event.

import { api } from '../api.mjs';
import { esc, relativeTime } from '../dom.mjs';

var overlay, body, refreshBtn, refreshLabel;
var busy = false;

function rowHtml(p) {
  var who = p.projectName ? esc(p.projectName) : (p.projectId ? esc(p.projectId) : 'unknown project');
  var kind = p.source === 'external'
    ? '<span class="badge badge-warning mono">straggler</span>'
    : '<span class="badge badge-info mono">this session</span>';
  var pidText = p.pid ? 'pid ' + p.pid : 'no pid';
  var when = p.startedAt ? relativeTime(p.startedAt) : '';
  var killAttr = p.source === 'external'
    ? 'data-kill-pid="' + esc(p.pid) + '"'
    : 'data-kill-shell="' + esc(p.shellId) + '"';
  return '<div class="proc-row">' +
    '<div class="proc-row__main">' +
      '<div class="proc-row__title">' + who + ' ' + kind + '</div>' +
      '<div class="proc-row__meta mono">' + esc(pidText) + (when ? ' · started ' + esc(when) : '') + '</div>' +
    '</div>' +
    '<button type="button" class="btn btn-secondary btn-sm proc-row__kill" ' + killAttr +
      ' title="Force-kill this shell and everything running in it">Kill</button>' +
  '</div>';
}

function render(list) {
  if (!list.length) {
    body.innerHTML = '<div class="empty-state empty-state--sm">' +
      '<span class="empty-state__ic"><svg class="icon icon-lg"><use href="#i-terminal"/></svg></span>' +
      '<strong>No shells open</strong><p>Nothing Work Hub started is running.</p></div>';
    return;
  }
  body.innerHTML = '<div class="proc-list">' + list.map(rowHtml).join('') + '</div>';
}

function load() {
  if (busy) return;
  busy = true;
  if (refreshLabel) refreshLabel.textContent = 'Refreshing…';
  body.innerHTML = '<div class="row gap-2"><span class="spinner" aria-hidden="true"></span><span class="muted fs-sm">Reading…</span></div>';
  api('/api/shells')
    .then(function (data) { render(data.processes || []); })
    .catch(function (err) { body.innerHTML = '<p class="term-status is-error">' + esc(err.message) + '</p>'; })
    .then(function () { busy = false; if (refreshLabel) refreshLabel.textContent = 'Refresh'; });
}

function open() { overlay.classList.add('is-open'); load(); }
function close() { overlay.classList.remove('is-open'); }

export function initProcessesDialog() {
  overlay = document.getElementById('processesOverlay');
  body = document.getElementById('processesBody');
  refreshBtn = document.getElementById('processesRefreshBtn');
  refreshLabel = document.getElementById('processesRefreshLabel');
  var openBtn = document.getElementById('processesBtn');
  var closeBtn = document.getElementById('processesCloseBtn');
  if (!overlay || !openBtn) return;

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  refreshBtn.addEventListener('click', load);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  body.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-kill-shell],[data-kill-pid]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Killing…';
    var shellId = btn.getAttribute('data-kill-shell');
    var pid = btn.getAttribute('data-kill-pid');
    var url = shellId ? '/api/shells/' + encodeURIComponent(shellId) : '/api/processes/' + encodeURIComponent(pid);
    api(url, { method: 'DELETE' })
      .then(load)
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Kill';
        var meta = btn.parentNode.querySelector('.proc-row__meta');
        if (meta) meta.innerHTML += ' <span style="color:var(--danger-fg)">' + esc(err.message) + '</span>';
      });
  });
}
