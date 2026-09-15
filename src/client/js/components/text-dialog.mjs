// The read-only text viewer the Files tab opens for .txt / .log / .csv / .json.
//
// Read-only is the markup, not a flag: the file lands in a <pre>, and the
// dialog holds no input, textarea or contenteditable of any kind. It opens
// large (see .modal--text) and maximises from there, the same way the job
// dialog does.
//
// The dialog shell is static markup in index.html; this module fills it.

import { apiStream } from '../api.mjs';

const FULLSCREEN_KEY = 'work-hub-text-fullscreen';

const overlay = document.getElementById('textOverlay');
const modalEl = overlay.querySelector('.modal');
const titleEl = document.getElementById('textTitle');
const sublineEl = document.getElementById('textSubline');
const bodyEl = document.getElementById('textBody');
const copyBtn = document.getElementById('textCopyBtn');
const copyIconUse = document.getElementById('textCopyIconUse');
const fullscreenBtn = document.getElementById('textFullscreenBtn');
const fullscreenIconUse = document.getElementById('textFullscreenIconUse');

/** So the job dialog behind this one can ignore keys while it is up. */
export function isTextDialogOpen() { return overlay.classList.contains('is-open'); }

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

function closeTextDialog() {
  overlay.classList.remove('is-open');
  bodyEl.textContent = '';
}

document.getElementById('textCloseBtn').addEventListener('click', closeTextDialog);
overlay.addEventListener('click', function (e) { if (e.target === overlay) closeTextDialog(); });

// Registered before the job dialog's handler would see the key, and stopped
// there: Escape over this dialog closes this one, never the one behind it.
document.addEventListener('keydown', function (e) {
  if (!isTextDialogOpen()) return;
  if (e.key === 'Escape') { e.stopPropagation(); closeTextDialog(); return; }
  if (e.key === 'f' || e.key === 'F') {
    e.stopPropagation();
    e.preventDefault();
    applyFullscreen(!modalEl.classList.contains('is-fullscreen'));
  }
}, true);

copyBtn.addEventListener('click', function () {
  var text = bodyEl.textContent || '';
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  navigator.clipboard.writeText(text).then(function () {
    copyIconUse.setAttribute('href', '#i-check');
    copyBtn.setAttribute('title', 'Copied');
    setTimeout(function () { copyIconUse.setAttribute('href', '#i-copy'); copyBtn.setAttribute('title', 'Copy'); }, 1500);
  }).catch(function () { /* clipboard blocked */ });
});

/**
 * Opens `url` in the viewer. `apiStream` rather than `api` so a `.json` file is
 * shown as the bytes on disk instead of being parsed and re-serialised.
 */
export function openTextFile(url, name, subline) {
  titleEl.textContent = name;
  sublineEl.textContent = subline || '';
  bodyEl.textContent = 'Loading…';
  overlay.classList.add('is-open');
  document.getElementById('textCloseBtn').focus();

  apiStream(url)
    .then(function (res) { return res.text(); })
    .then(function (text) {
      if (!isTextDialogOpen()) return;
      // An empty file would leave the <pre> looking like it failed to load.
      bodyEl.textContent = text === '' ? '(empty file)' : text;
      bodyEl.scrollTop = 0;
    })
    .catch(function (err) {
      if (isTextDialogOpen()) bodyEl.textContent = 'Failed to load ' + name + ': ' + err.message;
    });
}
