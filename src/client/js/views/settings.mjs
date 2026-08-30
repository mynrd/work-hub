// Settings: the monitored folder list, and the composer defaults every
// conversation starts from.

import { esc, emptyState, errorCard } from '../dom.mjs';
import { state } from '../state.mjs';
import { loadConfig, saveConfig, loadAuthStatus } from '../data.mjs';
import { api } from '../api.mjs';
import { app, registerView, renderCurrentPage, setApp } from '../render.mjs';

// The Sign-in PIN card. Only a gated server has one to set, and only a session
// that was opened with the authenticator code may set it - a PIN session sees
// the card disabled with the reason.
function renderPinCard(auth) {
  if (!auth || !auth.required) return '';
  var viaPin = auth.via === 'pin';
  var dis = viaPin ? ' disabled' : '';
  return '<div class="card mt-5" id="pinCard"><div class="card__head"><div><h3>Sign-in PIN</h3>' +
      '<p>A 6 digit PIN as a second way in, beside your authenticator code. After 10 minutes idle the page locks and asks for it.</p></div>' +
      '<span class="badge ' + (auth.pinSet ? 'badge-success' : 'badge-neutral') + '" id="pinState">' + (auth.pinSet ? 'A PIN is set' : 'No PIN yet') + '</span></div>' +
    '<div class="card__body col gap-4">' +
      (viaPin ? '<p class="fs-sm muted" id="pinLocked">Sign in with your authenticator code to change the PIN.</p>' : '') +
      '<div class="row gap-3 wrap field-row">' +
        '<div class="col gap-2"><label class="fs-xs muted" for="pinNew">' + (auth.pinSet ? 'New PIN' : 'PIN') + '</label>' +
          '<input class="input" id="pinNew" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="000000"' + dis + ' /></div>' +
        '<div class="col gap-2"><label class="fs-xs muted" for="pinConfirm">Confirm</label>' +
          '<input class="input" id="pinConfirm" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="000000"' + dis + ' /></div>' +
      '</div>' +
      '<div id="pinError" class="fs-sm" style="color:var(--danger-fg)" hidden></div>' +
      '<div class="row gap-2"><button type="button" class="btn btn-primary" id="savePinBtn"' + dis + '>Save PIN</button><span class="fs-sm muted" id="pinSaved" hidden>PIN set</span></div>' +
    '</div></div>';
}

function wirePinCard() {
  var saveBtn = document.getElementById('savePinBtn');
  if (!saveBtn) return;
  var errorEl = document.getElementById('pinError');
  function showError(message) { errorEl.textContent = message; errorEl.hidden = !message; }
  saveBtn.addEventListener('click', function () {
    var pin = document.getElementById('pinNew').value;
    var confirm = document.getElementById('pinConfirm').value;
    if (!/^\d{6}$/.test(pin)) { showError('A PIN is exactly 6 digits.'); return; }
    if (pin !== confirm) { showError('The two PINs do not match.'); return; }
    showError('');
    saveBtn.disabled = true;
    api('/api/auth/pin', { method: 'PUT', body: JSON.stringify({ pin: pin }) })
      .then(function () { return loadAuthStatus(); })
      .then(function () {
        renderSettings();
        var note = document.getElementById('pinSaved');
        if (note) { note.hidden = false; setTimeout(function () { note.hidden = true; }, 2000); }
      })
      .catch(function (err) { saveBtn.disabled = false; showError(err.message); });
  });
}

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
      '</div></div>' +
    renderPinCard(state.auth)
  );
  wirePinCard();

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
  // Always re-read: whether a PIN exists and how this session signed in can
  // both change without a reload.
  loadAuthStatus().then(renderCurrentPage);
  renderCurrentPage();
}

registerView('settings', { render: renderSettings, enter: enterSettings });
