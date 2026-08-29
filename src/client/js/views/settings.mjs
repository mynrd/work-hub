// Settings: the monitored folder list, and the composer defaults every
// conversation starts from.

import { esc, emptyState, errorCard } from '../dom.mjs';
import { state } from '../state.mjs';
import { loadConfig, saveConfig } from '../data.mjs';
import { app, registerView, renderCurrentPage, setApp } from '../render.mjs';

function renderSettings() {
  var c = state.config;
  if (!c) { setApp('<p class="muted">Loading…</p>'); return; }
  var d = c.defaults || {};
  var opts = function (list, selected) {
    return (list || []).map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('');
  };

  setApp(
    '<div class="page-head"><div><h1>Settings</h1><p>Stored in <span class="mono">' + esc(c.configPath) + '</span>.</p></div></div>' +
    (c.loadError ? errorCard(c.loadError) : '') +
    '<div class="card mb-5"><div class="card__head"><div><h3>Monitored folders</h3>' +
      '<p>Absolute paths. Each is scanned for <span class="mono">.work/</span> jobs and for its Claude Code conversations.</p></div></div>' +
      '<div class="card__body col gap-4">' +
        '<div class="row gap-2 wrap"><input class="input grow" id="newProjectInput" placeholder="D:\\Work\\git\\mynrd\\some-repo" />' +
        '<button type="button" class="btn btn-primary" id="addProjectBtn"><svg class="icon"><use href="#i-plus"/></svg> Add folder</button></div>' +
        '<div id="settingsError" class="fs-sm" style="color:var(--danger-fg)" hidden></div>' +
        (c.projects.length === 0 ? emptyState('No folders yet', 'Add the absolute path of a repo or working folder.') :
          '<div class="table-wrap"><table class="table table--stack"><thead><tr><th>Path</th><th style="width:110px"></th></tr></thead><tbody>' +
          c.projects.map(function (p) {
            return '<tr><td class="cell-mono" data-label="Path">' + esc(p) + '</td><td><button type="button" class="btn btn-danger btn-sm" data-remove="' + esc(p) + '">Remove</button></td></tr>';
          }).join('') + '</tbody></table></div>') +
      '</div></div>' +
    '<div class="card"><div class="card__head"><div><h3>Composer defaults</h3><p>Pre-selected in every reply composer. Each conversation can still override them.</p></div></div>' +
      '<div class="card__body col gap-4">' +
        // .field-row is what the phone breakpoint targets to give each control a full row.
        '<div class="row gap-3 wrap field-row">' +
          '<div class="col gap-2"><label class="fs-xs muted" for="defModel">Model</label><select class="select" id="defModel">' + opts(c.models, d.model) + '</select></div>' +
          '<div class="col gap-2"><label class="fs-xs muted" for="defEffort">Effort</label><select class="select" id="defEffort">' + opts(c.efforts, d.effort) + '</select></div>' +
          '<div class="col gap-2"><label class="fs-xs muted" for="defPerm">Permissions</label><select class="select" id="defPerm">' + opts(c.permissionModes, d.permissionMode) + '</select></div>' +
          '<div class="col gap-2"><label class="fs-xs muted" for="defInterval">Usage refresh (min, 0 = manual)</label><input class="input" id="defInterval" type="number" min="0" step="1" value="' + esc(c.usageIntervalMinutes) + '" /></div>' +
        '</div>' +
        '<div class="row gap-2"><button type="button" class="btn btn-primary" id="saveDefaultsBtn">Save</button><span class="fs-sm muted" id="defaultsSaved" hidden>Saved.</span></div>' +
      '</div></div>'
  );

  var errorEl = document.getElementById('settingsError');
  function showError(message) { errorEl.textContent = message; errorEl.hidden = !message; }

  document.getElementById('addProjectBtn').addEventListener('click', function () {
    var value = document.getElementById('newProjectInput').value.trim();
    if (!value) { showError('Enter a folder path.'); return; }
    showError('');
    saveConfig({ projects: state.config.projects.concat([value]) })
      .then(function () { state.dashboard = null; renderSettings(); })
      .catch(function (err) { showError(err.message); });
  });
  document.getElementById('newProjectInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('addProjectBtn').click();
  });

  app.querySelectorAll('[data-remove]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute('data-remove');
      saveConfig({ projects: state.config.projects.filter(function (p) { return p !== target; }) })
        .then(function () { state.dashboard = null; renderSettings(); })
        .catch(function (err) { showError(err.message); });
    });
  });

  document.getElementById('saveDefaultsBtn').addEventListener('click', function () {
    saveConfig({
      usageIntervalMinutes: Number(document.getElementById('defInterval').value),
      defaults: {
        model: document.getElementById('defModel').value,
        effort: document.getElementById('defEffort').value,
        permissionMode: document.getElementById('defPerm').value,
      },
    }).then(function () {
      var note = document.getElementById('defaultsSaved');
      note.hidden = false;
      setTimeout(function () { note.hidden = true; }, 2000);
    }).catch(function (err) { showError(err.message); });
  });
}

function enterSettings() {
  (state.config ? Promise.resolve() : loadConfig()).then(renderCurrentPage);
  renderCurrentPage();
}

registerView('settings', { render: renderSettings, enter: enterSettings });
