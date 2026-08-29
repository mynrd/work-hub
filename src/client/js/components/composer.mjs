// The reply box, the run it starts, and the poll that follows that run.

import { esc, relativeTime } from '../dom.mjs';
import { state, timers, composerDraft } from '../state.mjs';
import { api } from '../api.mjs';
import { loadChat, loadSessions } from '../data.mjs';
import { renderCurrentPage } from '../render.mjs';

function composerDefaults() {
  var d = (state.config && state.config.defaults) || {};
  return {
    model: composerDraft.model || d.model || 'opus',
    effort: composerDraft.effort || d.effort || 'high',
    permissionMode: composerDraft.permissionMode || d.permissionMode || 'default',
  };
}

// Mirrors buildArgs() in claude-run.mjs so the preview is exactly what runs.
function commandPreview(sid, sel) {
  var args = ['claude', '-p'];
  if (sid) args.push('-r', sid);
  args.push('--model', sel.model, '--effort', sel.effort, '--output-format', 'json');
  if (sel.permissionMode === 'acceptEdits') args.push('--permission-mode', 'acceptEdits');
  else if (sel.permissionMode === 'plan') args.push('--permission-mode', 'plan');
  else if (sel.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  return args.join(' ');
}

export function composerHtml(sid) {
  var c = state.config || {};
  var sel = composerDefaults();
  var run = state.activeRun;
  var busy = run && (run.state === 'running' || run.state === 'queued');
  var opts = function (list, selected) {
    return (list || []).map(function (v) { return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
  };
  // Each label stays glued to its own select inside a .field, so on a phone the
  // three of them wrap as three whole rows instead of six loose items.
  var field = function (id, label, list, selected) {
    return '<div class="field"><label for="' + id + '">' + label + '</label>' +
      '<select class="select" id="' + id + '">' + opts(list, selected) + '</select></div>';
  };

  var status = '';
  if (run) {
    if (busy) status = '<span class="composer__status">Running… ' + esc(relativeTime(run.startedAt)) + ' · ' + esc(run.command) + '</span>';
    else if (run.state === 'failed') status = '<span class="composer__status is-error">Failed: ' + esc(run.error || '') + (run.stderr ? '\n' + esc(run.stderr) : '') + '</span>';
    else if (run.state === 'done') status = '<span class="composer__status">Done in ' + esc(run.durationMs === null ? '?' : Math.round(run.durationMs / 1000) + 's') + '.</span>';
  }

  return '<div class="composer">' +
    '<div class="composer__preview" id="cmdPreview">' + esc(commandPreview(sid, sel)) + '</div>' +
    '<textarea id="composerText" placeholder="' + (sid ? 'Reply to this conversation…' : 'Start a new conversation…') + '"' + (busy ? ' disabled' : '') + '>' + esc(composerDraft.text) + '</textarea>' +
    '<div class="composer__controls">' +
      field('cmpModel', 'Model', c.models, sel.model) +
      field('cmpEffort', 'Effort', c.efforts, sel.effort) +
      field('cmpPerm', 'Permissions', c.permissionModes, sel.permissionMode) +
      '<span class="grow"></span>' +
      '<button type="button" class="btn btn-primary" id="sendBtn"' + (busy ? ' disabled' : '') + '>' +
        '<svg class="icon' + (busy ? ' spin' : '') + '"><use href="#' + (busy ? 'i-refresh' : 'i-send') + '"/></svg> ' + (busy ? 'Running' : 'Send') + '</button>' +
      status +
    '</div></div>';
}

export function wireComposer(pid, sid) {
  var textEl = document.getElementById('composerText');
  var preview = document.getElementById('cmdPreview');
  if (!textEl) return;

  var refreshPreview = function () {
    composerDraft.model = document.getElementById('cmpModel').value;
    composerDraft.effort = document.getElementById('cmpEffort').value;
    composerDraft.permissionMode = document.getElementById('cmpPerm').value;
    preview.textContent = commandPreview(sid, composerDefaults());
  };
  ['cmpModel', 'cmpEffort', 'cmpPerm'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', refreshPreview);
  });
  textEl.addEventListener('input', function () { composerDraft.text = textEl.value; });

  var send = function () {
    var message = textEl.value.trim();
    if (!message) return;
    var sel = composerDefaults();
    var url = sid
      ? '/api/projects/' + encodeURIComponent(pid) + '/sessions/' + encodeURIComponent(sid) + '/reply'
      : '/api/projects/' + encodeURIComponent(pid) + '/sessions';
    api(url, { method: 'POST', body: JSON.stringify({ message: message, model: sel.model, effort: sel.effort, permissionMode: sel.permissionMode }) })
      .then(function (run) {
        composerDraft.text = '';
        state.activeRun = run;
        renderCurrentPage();
        pollRun(pid, sid, run.runId);
      })
      .catch(function (err) {
        state.activeRun = { state: 'failed', error: err.message, command: commandPreview(sid, sel), startedAt: Date.now() };
        renderCurrentPage();
      });
  };

  document.getElementById('sendBtn').addEventListener('click', send);
  textEl.addEventListener('keydown', function (e) {
    // Ctrl/Cmd+Enter sends; a bare Enter stays a newline because these prompts
    // are usually several lines long.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  });
}

/* Polls the run every second, and re-reads the transcript every 3 s while it is
   in flight (claude appends to the same .jsonl), plus once on completion. */
function pollRun(pid, sid, runId) {
  if (timers.run) clearInterval(timers.run);
  if (timers.chat) clearInterval(timers.chat);

  var ticks = 0;
  timers.run = setInterval(function () {
    api('/api/runs/' + encodeURIComponent(runId)).then(function (run) {
      state.activeRun = run;
      if (run.state === 'running' || run.state === 'queued') {
        ticks++;
        if (ticks % 3 === 0 && sid) loadChat(pid, sid).then(renderCurrentPage);
        else renderCurrentPage();
        return;
      }
      clearInterval(timers.run); timers.run = null;
      // A new conversation only learns its session id when the child reports
      // it; hop to that conversation's own route.
      if (!sid && run.resultSessionId) {
        loadSessions(pid).then(function () { location.hash = '#/p/' + pid + '/s/' + run.resultSessionId; });
        return;
      }
      Promise.all([sid ? loadChat(pid, sid) : Promise.resolve(), loadSessions(pid)]).then(renderCurrentPage);
    }).catch(function (err) {
      clearInterval(timers.run); timers.run = null;
      state.activeRun = { state: 'failed', error: err.message, startedAt: Date.now() };
      renderCurrentPage();
    });
  }, 1000);
}
