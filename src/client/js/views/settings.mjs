// Settings: the monitored folder list, and the composer defaults every
// conversation starts from.

import { esc, emptyState, errorCard } from '../dom.mjs';
import { state } from '../state.mjs';
import { loadConfig, saveConfig, loadAuthStatus } from '../data.mjs';
import { api } from '../api.mjs';
import { app, registerView, renderCurrentPage, setApp } from '../render.mjs';

// ---- Path helpers for the new-folder input's directory suggestions --------

/** Index of the last path separator (`\` or `/`) in `value`, or -1. */
function lastSepIndex(value) {
  return Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
}

/** `dirWithSep` ends in a separator (e.g. `D:\Work\`). GET /api/fs/dirs wants an
 *  absolute dir with no trailing separator - except a bare drive root
 *  (`C:\`), where stripping it would turn `C:\` into `C:`, which Windows
 *  resolves against the current directory on that drive rather than its root. */
function dirQueryPath(dirWithSep) {
  var stripped = dirWithSep.slice(0, -1);
  if (stripped === '' || /^[A-Za-z]:$/.test(stripped)) return dirWithSep;
  return stripped;
}

/** Last path segment of an absolute path, either separator, trailing separators ignored. */
function basename(p) {
  var trimmed = String(p).replace(/[\\/]+$/, '');
  var idx = lastSepIndex(trimmed);
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

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
        '<div class="row gap-2 wrap">' +
          '<div class="field-suggest grow">' +
            '<input class="input" id="newProjectInput" placeholder="D:\\Work\\git\\mynrd\\some-repo" autocomplete="off" />' +
            '<div class="suggest-list" id="projectSuggest" hidden></div>' +
          '</div>' +
          '<button type="button" class="btn btn-primary" id="addProjectBtn"><svg class="icon"><use href="#i-plus"/></svg> Add folder</button>' +
        '</div>' +
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
    renderPinCard(state.auth) +
    // The project-name dialog: only Add folder opens it, so it lives entirely
    // in this view rather than as global static markup like the job detail
    // dialog and the OTP prompt.
    '<div class="overlay" id="projectNameOverlay" role="dialog" aria-modal="true" aria-labelledby="projectNameTitle">' +
      '<div class="modal modal--sm">' +
        '<div class="modal__head"><div><h3 id="projectNameTitle">Name this folder</h3></div></div>' +
        '<div class="modal__body">' +
          '<div class="col gap-2"><label class="fs-xs muted" for="projectNameInput">Project name</label>' +
            '<input class="input" id="projectNameInput" /></div>' +
          '<div class="row gap-2">' +
            '<button type="button" class="btn btn-primary" id="projectNameSaveBtn">Save</button>' +
            '<button type="button" class="btn btn-secondary" id="projectNameCancelBtn">Cancel</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
  wirePinCard();

  var errorEl = document.getElementById('settingsError');
  function showError(message) { errorEl.textContent = message; errorEl.hidden = !message; }

  // ---- Directory suggestions for #newProjectInput --------------------------
  // A trailing `\` or `/` opens a subfolder list fetched from GET /api/fs/dirs;
  // characters typed after that separator filter it client-side. Editing the
  // part of the value before the separator changes the directory being
  // browsed, which re-fetches.
  var newProjectInput = document.getElementById('newProjectInput');
  var suggestEl = document.getElementById('projectSuggest');
  var suggest = { allDirs: [], fetchedDirPath: null, timer: null, reqSeq: 0, items: [], highlighted: -1 };

  function closeSuggest() {
    if (suggest.timer) { clearTimeout(suggest.timer); suggest.timer = null; }
    suggest.reqSeq++; // any fetch already in flight is now stale
    suggest.fetchedDirPath = null;
    suggest.items = [];
    suggest.highlighted = -1;
    suggestEl.hidden = true;
    suggestEl.innerHTML = '';
  }

  function renderSuggestList() {
    if (suggest.items.length === 0) { suggestEl.hidden = true; suggestEl.innerHTML = ''; return; }
    suggestEl.hidden = false;
    suggestEl.innerHTML = suggest.items.map(function (name, i) {
      return '<button type="button" class="suggest-list__item' + (i === suggest.highlighted ? ' is-active' : '') +
        '" data-idx="' + i + '">' + esc(name) + '</button>';
    }).join('');
  }

  // Re-reads the input rather than trusting the caller's snapshot: the value
  // may have moved on while a debounced fetch was in flight.
  function applyFilter(dirPath) {
    var value = newProjectInput.value;
    var idx = lastSepIndex(value);
    if (idx === -1 || value.slice(0, idx + 1) !== dirPath) return;
    var filterText = value.slice(idx + 1).toLowerCase();
    suggest.items = suggest.allDirs.filter(function (d) { return d.toLowerCase().indexOf(filterText) === 0; });
    suggest.highlighted = suggest.items.length ? 0 : -1;
    renderSuggestList();
  }

  function handleInputChange() {
    var value = newProjectInput.value;
    if (!value) { closeSuggest(); return; }
    var idx = lastSepIndex(value);
    if (idx === -1) { closeSuggest(); return; }
    var dirPath = value.slice(0, idx + 1);
    if (dirPath === suggest.fetchedDirPath) { applyFilter(dirPath); return; }
    if (suggest.timer) clearTimeout(suggest.timer);
    suggest.timer = setTimeout(function () {
      suggest.timer = null;
      var seq = ++suggest.reqSeq;
      api('/api/fs/dirs?path=' + encodeURIComponent(dirQueryPath(dirPath)))
        .then(function (data) {
          if (seq !== suggest.reqSeq) return; // superseded by a later edit
          suggest.fetchedDirPath = dirPath;
          suggest.allDirs = (data && Array.isArray(data.dirs)) ? data.dirs : [];
          applyFilter(dirPath);
        })
        .catch(function () {
          if (seq !== suggest.reqSeq) return;
          suggest.fetchedDirPath = dirPath;
          suggest.allDirs = [];
          applyFilter(dirPath);
        });
    }, 150);
  }

  // Inserts `name` at the last separator and appends the same separator again,
  // so the field is left ready to keep browsing into that folder - never adds
  // the project.
  function insertSuggestion(name) {
    var value = newProjectInput.value;
    var idx = lastSepIndex(value);
    var sep = idx === -1 ? '\\' : value.charAt(idx);
    var dirPath = idx === -1 ? '' : value.slice(0, idx + 1);
    newProjectInput.value = dirPath + name + sep;
    closeSuggest();
    newProjectInput.focus();
    handleInputChange(); // browsing continues: fetch the new folder's children
  }

  newProjectInput.addEventListener('input', handleInputChange);
  suggestEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.suggest-list__item');
    if (!btn) return;
    insertSuggestion(suggest.items[Number(btn.getAttribute('data-idx'))]);
  });

  newProjectInput.addEventListener('keydown', function (e) {
    var open = !suggestEl.hidden;
    if (open && e.key === 'ArrowDown') {
      e.preventDefault();
      suggest.highlighted = (suggest.highlighted + 1) % suggest.items.length;
      renderSuggestList();
      return;
    }
    if (open && e.key === 'ArrowUp') {
      e.preventDefault();
      suggest.highlighted = (suggest.highlighted - 1 + suggest.items.length) % suggest.items.length;
      renderSuggestList();
      return;
    }
    if (open && e.key === 'Enter') {
      e.preventDefault();
      if (suggest.highlighted >= 0) insertSuggestion(suggest.items[suggest.highlighted]);
      return;
    }
    if (open && e.key === 'Escape') {
      e.preventDefault();
      closeSuggest();
      return;
    }
    // The suggestion list is closed (or was never opened): Enter adds the
    // folder, same as clicking Add folder.
    if (e.key === 'Enter') document.getElementById('addProjectBtn').click();
  });

  // ---- Add folder: opens the project-name dialog rather than saving directly
  var nameOverlay = document.getElementById('projectNameOverlay');
  var nameInput = document.getElementById('projectNameInput');
  var pendingPath = null;

  function openNameDialog(folderPath) {
    pendingPath = folderPath;
    closeSuggest();
    nameInput.value = basename(folderPath);
    nameOverlay.classList.add('is-open');
    nameInput.focus();
    nameInput.select();
  }
  function closeNameDialog() { nameOverlay.classList.remove('is-open'); pendingPath = null; }

  document.getElementById('addProjectBtn').addEventListener('click', function () {
    var value = newProjectInput.value.trim();
    if (!value) { showError('Enter a folder path.'); return; }
    showError('');
    openNameDialog(value);
  });

  document.getElementById('projectNameSaveBtn').addEventListener('click', function () {
    var folderPath = pendingPath;
    if (!folderPath) return;
    var name = nameInput.value.trim() || basename(folderPath);
    closeNameDialog();
    var names = Object.assign({}, state.config.projectNames || {});
    names[folderPath] = name;
    saveConfig({ projects: state.config.projects.concat([folderPath]), projectNames: names })
      .then(function () { state.dashboard = null; renderSettings(); })
      .catch(function (err) { showError(err.message); });
  });
  document.getElementById('projectNameCancelBtn').addEventListener('click', closeNameDialog);
  nameOverlay.addEventListener('click', function (e) { if (e.target === nameOverlay) closeNameDialog(); });
  nameOverlay.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNameDialog(); });

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
