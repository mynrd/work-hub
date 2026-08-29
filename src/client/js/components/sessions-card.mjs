// The "Conversations" card: the Claude Code sessions whose working directory is
// this project folder, plus the two buttons that start a new one.

import { esc, shortId, relativeTime, emptyState } from '../dom.mjs';
import { state } from '../state.mjs';
import { api } from '../api.mjs';
import { app, renderCurrentPage } from '../render.mjs';

const SESSIONS_PER_PAGE = 20;
let snappedSid = null;   // the conversation the pager has already jumped to

/** Called when a conversation is opened, so the next paint re-snaps the pager. */
export function resetSessionSnap() { snappedSid = null; }

function sessionRowHtml(pid, s, activeSid) {
  var meta = [shortId(s.sessionId), s.messages + ' msg', relativeTime(s.lastWrite)];
  if (s.models && s.models.length) meta.push(s.models.map(function (m) { return m.replace(/^claude-/, ''); }).join(', '));
  if (s.subagents) meta.push(s.subagents + ' subagent' + (s.subagents === 1 ? '' : 's'));
  return '<a class="sess__row' + (s.sessionId === activeSid ? ' is-active' : '') + '" href="#/p/' + esc(pid) + '/s/' + esc(s.sessionId) + '">' +
    '<span class="sess__title">' + (s.live ? '<span class="dot-live"></span>' : '') + '<span class="txt">' + esc(s.title) + '</span></span>' +
    '<span class="sess__meta">' + meta.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('') + '</span>' +
  '</a>';
}

/** Clamps the stored page to what the current list actually has. */
function sessionPage(pid, total) {
  var pages = Math.max(1, Math.ceil(total / SESSIONS_PER_PAGE));
  var page = state.sessPage[pid] || 0;
  if (page > pages - 1) page = pages - 1;
  if (page < 0) page = 0;
  state.sessPage[pid] = page;
  return page;
}

function pagerHtml(page, total) {
  var pages = Math.max(1, Math.ceil(total / SESSIONS_PER_PAGE));
  if (pages < 2) return '';
  var from = page * SESSIONS_PER_PAGE + 1;
  var to = Math.min(total, (page + 1) * SESSIONS_PER_PAGE);
  return '<div class="pager">' +
    '<span class="pager__info">' + from + '-' + to + ' of ' + total + '</span>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-page="' + (page - 1) + '"' + (page === 0 ? ' disabled' : '') + '>Prev</button>' +
    '<span class="pager__info">' + (page + 1) + ' / ' + pages + '</span>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-page="' + (page + 1) + '"' + (page >= pages - 1 ? ' disabled' : '') + '>Next</button>' +
  '</div>';
}

export function sessionsCardHtml(pid, activeSid) {
  var data = state.sessions[pid];
  var head = '<div class="card__head"><div><h3>Conversations</h3><p>Claude Code sessions whose working directory is this folder.</p></div>' +
    '<div class="row gap-2">' +
      '<button type="button" class="btn btn-primary btn-sm" id="newConvBtn"><svg class="icon icon-sm"><use href="#i-plus"/></svg> New</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" id="terminalBtn" title="Open a terminal in this folder running: claude remote-control --spawn same-dir, with the session named &lt;computer name&gt; - &lt;folder name&gt;">' +
        '<svg class="icon icon-sm"><use href="#i-terminal"/></svg> <span id="terminalBtnLabel">Terminal</span></button>' +
    '</div></div>' +
    '<div class="term-status" id="terminalStatus" hidden></div>';
  if (!data) {
    return '<div class="card">' + head + '<div class="card__body row gap-2"><span class="spinner" aria-hidden="true"></span><span class="muted fs-sm">Loading…</span></div></div>';
  }
  if (!data.transcriptDir) {
    return '<div class="card">' + head + emptyState('No conversations yet', 'Claude Code has never run with this folder as its working directory.') + '</div>';
  }
  if (data.sessions.length === 0) {
    return '<div class="card">' + head + emptyState('No conversations yet', 'The transcript folder exists but holds no sessions.') + '</div>';
  }
  // The open conversation must stay visible even if it sits on page 4, so
  // opening one moves the pager to whichever page holds it. Once only: the
  // chat repaints every 3 seconds during a run, and re-snapping each time
  // would undo a Next click the moment the poll came back.
  if (activeSid && snappedSid !== activeSid) {
    for (var i = 0; i < data.sessions.length; i++) {
      if (data.sessions[i].sessionId === activeSid) { state.sessPage[pid] = Math.floor(i / SESSIONS_PER_PAGE); break; }
    }
    snappedSid = activeSid;
  }
  var page = sessionPage(pid, data.sessions.length);
  var slice = data.sessions.slice(page * SESSIONS_PER_PAGE, (page + 1) * SESSIONS_PER_PAGE);
  return '<div class="card">' + head + '<div class="sess">' +
    slice.map(function (s) { return sessionRowHtml(pid, s, activeSid); }).join('') + '</div>' +
    pagerHtml(page, data.sessions.length) + '</div>';
}

export function wireSessionPager(pid) {
  var pager = app.querySelector('.pager');
  if (!pager) return;
  pager.querySelectorAll('button[data-page]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      state.sessPage[pid] = Number(btn.getAttribute('data-page'));
      renderCurrentPage();
    });
  });
}

export function wireNewConversation(pid) {
  var btn = document.getElementById('newConvBtn');
  if (!btn) return;
  btn.addEventListener('click', function () { location.hash = '#/p/' + pid + '/s/new'; });
}

/* The one control that opens a window on the machine running the server -
   `claude remote-control --spawn same-dir`, in this project's folder, with
   `--remote-control-session-name-prefix "<computer name> - <folder name>"` so
   the session is identifiable from the phone. Nothing comes back but "it
   launched"; the session itself lives in that terminal. */
export function wireTerminal(pid) {
  var btn = document.getElementById('terminalBtn');
  var status = document.getElementById('terminalStatus');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var label = document.getElementById('terminalBtnLabel');
    btn.disabled = true;
    if (label) label.textContent = 'Opening…';
    var show = function (text, isError) {
      if (!status) return;
      status.hidden = false;
      status.className = 'term-status' + (isError ? ' is-error' : '');
      status.textContent = text;
    };
    api('/api/projects/' + encodeURIComponent(pid) + '/terminal', { method: 'POST' })
      .then(function (r) { show('Terminal opened in ' + r.cwd + ' running: ' + r.command, false); })
      .catch(function (err) { show(err.message, true); })
      .then(function () {
        btn.disabled = false;
        if (label) label.textContent = 'Terminal';
      });
  });
}
