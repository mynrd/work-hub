// The Terminal tab: several real shells on the server machine, each rendered
// by xterm.js, switched with a `Terminal 1 | Terminal 2 | +` strip.
//
// The pane has to survive the 30 second repaint that rebuilds the project
// page, so everything live - the xterm instances, their DOM containers, the
// output streams, the keystroke queues - lives in this module keyed by
// shellId, and each repaint only re-adopts the active shell's container into
// the fresh placeholder. The shells themselves live in the server
// (src/lib/shell.mjs) and keep running whether or not any page is attached;
// reattaching replays each shell's buffer so the screen comes back as it was.
//
// Per project this module tracks: which shellIds it knows, which one is
// active, and whether the tab is maximised. That survives repaints too, so a
// switch or a maximise is not undone by the next poll.
//
// Wire protocol: output is a streaming fetch of newline-delimited JSON events
// ({type:'data'|'exit'|'ping'}); keystrokes go up as POSTs, chained one at a
// time (flushInput) because two in flight could arrive swapped, and in a shell
// "ls" arriving as "sl" matters.

import { api, apiStream } from '../api.mjs';
import { esc } from '../dom.mjs';

// pid -> { shells: [shellId...], active: shellId|null, maximised: bool, loaded: bool }
var projects = {};
// shellId -> pane { container, term, fit, projectId, status, ... }
var panes = {};

var TERM_THEME = {
  background: '#0e0f17',
  foreground: '#d6d9e4',
  cursor: '#a3a9ff',
  selectionBackground: 'rgba(98, 88, 239, .35)',
};

function proj(pid) {
  if (!projects[pid]) projects[pid] = { shells: [], active: null, maximised: false, loaded: false, names: {} };
  return projects[pid];
}

function shellUrl(shellId, tail) {
  return '/api/shells/' + encodeURIComponent(shellId) + (tail ? '/' + tail : '');
}

// ── Markup ───────────────────────────────────────────────────────────────────

function tabName(pid, sid, i) {
  return proj(pid).names[sid] || ('Terminal ' + (i + 1));
}

function stripInnerHtml(pid) {
  var p = proj(pid);
  return p.shells.map(function (sid, i) {
    var active = sid === p.active;
    var name = tabName(pid, sid, i);
    return '<button type="button" class="term-tab' + (active ? ' is-active' : '') + '" data-shell="' + esc(sid) + '" title="' + esc(name) + ' (double-click to rename)">' +
      '<span class="term-tab__label">' + esc(name) + '</span>' +
      '<span class="term-tab__close" data-close="' + esc(sid) + '" title="Close this terminal" aria-label="Close">&times;</span>' +
    '</button>';
  }).join('') +
    '<button type="button" class="term-tab term-tab--new" id="termNewBtn" title="Open another terminal">+</button>';
}

export function terminalPaneHtml(pid) {
  var p = proj(pid);
  return '<div class="card term-card' + (p.maximised ? ' is-max' : '') + '" id="termCard">' +
    '<div class="card__head"><div><h3>Terminal</h3><p>Real shells running in this folder on the server machine. Everything they print shows here; everything typed here goes to them.</p></div>' +
      '<div class="row gap-2">' +
        '<button type="button" class="btn btn-secondary btn-sm" id="termRestartBtn" title="Kill the active shell and start a fresh one">' +
          '<svg class="icon icon-sm"><use href="#i-refresh"/></svg> Restart</button>' +
        '<button type="button" class="icon-btn" id="termMaxBtn" aria-pressed="' + (p.maximised ? 'true' : 'false') + '" title="' + (p.maximised ? 'Restore' : 'Maximise') + '" aria-label="' + (p.maximised ? 'Restore' : 'Maximise') + '">' +
          '<svg class="icon"><use href="#i-' + (p.maximised ? 'minimize' : 'maximize') + '"/></svg></button>' +
      '</div></div>' +
    '<div class="term-strip" id="termStrip">' + stripInnerHtml(pid) + '</div>' +
    '<div class="term-host" id="termHost" data-pid="' + esc(pid) + '"></div>' +
    '<div class="term-status" id="termPaneStatus" hidden></div>' +
  '</div>';
}

// ── Status line ────────────────────────────────────────────────────────────

function setStatus(pane, text, isError) {
  pane.statusText = text || '';
  pane.statusIsError = Boolean(isError);
  if (isActivePane(pane)) paintStatus(pane);
}

function isActivePane(pane) {
  return pane && projects[pane.projectId] && projects[pane.projectId].active === pane.shellId;
}

function paintStatus(pane) {
  var el = document.getElementById('termPaneStatus');
  if (!el) return;
  el.hidden = !pane.statusText;
  el.className = 'term-status' + (pane.statusIsError ? ' is-error' : '');
  el.textContent = pane.statusText;
}

// ── Keystroke + output plumbing ────────────────────────────────────────────

/** Serialises keystroke POSTs so input can never arrive out of order. */
function queueInput(pane, data) {
  pane.inputQueue += data;
  if (pane.flushing) return;
  pane.flushing = true;
  (function flush() {
    var chunk = pane.inputQueue;
    if (!chunk) { pane.flushing = false; return; }
    pane.inputQueue = '';
    api(shellUrl(pane.shellId, 'input'), { method: 'POST', body: JSON.stringify({ data: chunk }) })
      .then(flush, function (err) {
        pane.flushing = false;
        pane.inputQueue = '';
        if (pane.status === 'running') setStatus(pane, 'Sending input failed: ' + err.message, true);
      });
  })();
}

/** Reads the ndjson output stream and feeds the terminal until exit or drop. */
function streamOutput(pane) {
  var abort = new AbortController();
  pane.streamAbort = abort;
  var decoder = new TextDecoder();
  var tail = '';
  var sawExit = false;

  function handleLine(line) {
    if (!line) return;
    var event;
    try { event = JSON.parse(line); } catch (e) { return; }
    if (event.type === 'data') pane.term.write(event.data);
    else if (event.type === 'exit') {
      sawExit = true;
      pane.status = 'exited';
      pane.term.write('\r\n\x1b[90m[shell exited' + (event.exitCode === null || event.exitCode === undefined ? '' : ' with code ' + event.exitCode) + ' - Restart starts a new one]\x1b[0m\r\n');
      setStatus(pane, '', false);
    }
  }

  apiStream(shellUrl(pane.shellId, 'stream'), { signal: abort.signal }).then(function (res) {
    var reader = res.body.getReader();
    pane.retries = 0;
    function pump() {
      return reader.read().then(function (step) {
        if (step.done) {
          if (!sawExit && pane.status === 'running') retryStream(pane);
          return;
        }
        tail += decoder.decode(step.value, { stream: true });
        var lines = tail.split('\n');
        tail = lines.pop();
        lines.forEach(handleLine);
        return pump();
      });
    }
    return pump();
  }).catch(function (err) {
    if (abort.signal.aborted) return;
    if (pane.status === 'running') retryStream(pane);
    else setStatus(pane, 'Output stream failed: ' + err.message, true);
  });
}

/* A dropped connection while the shell is alive (sleep, network blip) is
   reattached quietly - the server replays its buffer, so nothing is lost.
   Repeated failure stops with an error rather than hammering the server. */
function retryStream(pane) {
  pane.retries = (pane.retries || 0) + 1;
  if (pane.retries > 5) {
    setStatus(pane, 'Lost the output stream. Switch terminals and back, or Restart, to reconnect.', true);
    return;
  }
  setStatus(pane, 'Reconnecting…', false);
  setTimeout(function () {
    if (pane.status !== 'running') return;
    pane.term.reset();
    streamOutput(pane);
    setStatus(pane, '', false);
  }, 1500 * pane.retries);
}

function postResize(pane) {
  if (pane.status !== 'running') return;
  api(shellUrl(pane.shellId, 'resize'), {
    method: 'POST',
    body: JSON.stringify({ cols: pane.term.cols, rows: pane.term.rows }),
  }).catch(function () { /* a dead shell answers 409; the stream's exit event covers it */ });
}

// ── Pane (one xterm per shell) ─────────────────────────────────────────────

function createPane(projectId, shellId) {
  var pane = {
    projectId: projectId,
    shellId: shellId,
    container: document.createElement('div'),
    term: null,
    fit: null,
    status: 'starting',
    statusText: '',
    statusIsError: false,
    inputQueue: '',
    flushing: false,
    streamAbort: null,
    retries: 0,
  };
  pane.container.className = 'term-screen';
  panes[shellId] = pane;

  // xterm is only fetched when a terminal is first opened - it is by far the
  // largest script in the app and every other page works without it.
  Promise.all([import('/vendor/xterm.mjs'), import('/vendor/addon-fit.mjs')]).then(function (mods) {
    var Terminal = mods[0].Terminal;
    var FitAddon = mods[1].FitAddon;
    pane.term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
      theme: TERM_THEME,
      scrollback: 5000,
    });
    pane.fit = new FitAddon();
    pane.term.loadAddon(pane.fit);
    pane.term.open(pane.container);
    if (pane.container.isConnected) pane.fit.fit();
    pane.term.onData(function (data) { queueInput(pane, data); });
    pane.term.onResize(function () { postResize(pane); });

    var fitTimer = null;
    new ResizeObserver(function () {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(function () {
        if (pane.container.isConnected && pane.fit) pane.fit.fit();
      }, 100);
    }).observe(pane.container);

    pane.status = 'running';
    setStatus(pane, '', false);
    postResize(pane);
    streamOutput(pane);
    if (isActivePane(pane)) pane.term.focus();
  }).catch(function (err) {
    pane.status = 'error';
    setStatus(pane, 'Could not load the terminal renderer: ' + err.message, true);
  });

  return pane;
}

// ── Targeted DOM updates ───────────────────────────────────────────────────
// The project page's 30s repaint is blocked while a terminal is mounted (see
// terminalPaneIsLive), so terminal interactions update the DOM in place rather
// than triggering a full page rebuild that would drop focus mid-keystroke.

/** Rewrite the tab strip in place, keeping the delegated click listener. */
function repaintStrip(pid) {
  var strip = document.getElementById('termStrip');
  if (strip) strip.innerHTML = stripInnerHtml(pid);
}

/** Show the active project's active pane in the host, replacing whatever was there. */
function mountActive(pid) {
  var host = document.getElementById('termHost');
  if (!host) return;
  var p = proj(pid);
  var pane = p.active ? panes[p.active] : null;
  // Detach any other pane container currently shown.
  while (host.firstChild) host.removeChild(host.firstChild);
  if (pane) {
    host.appendChild(pane.container);
    paintStatus(pane);
    if (pane.fit) requestAnimationFrame(function () { if (pane.container.isConnected) pane.fit.fit(); });
    if (pane.term) pane.term.focus();
  } else {
    paintEmptyHost(pid);
  }
}

function paintEmptyHost(pid) {
  var el = document.getElementById('termPaneStatus');
  if (!el) return;
  el.hidden = false;
  el.className = 'term-status';
  el.textContent = proj(pid).loaded ? 'No terminal open. Use + to start one.' : 'Starting a terminal…';
}

function switchTo(pid, shellId) {
  var p = proj(pid);
  if (p.active === shellId) return;
  p.active = shellId;
  repaintStrip(pid);
  mountActive(pid);
}

// ── Server calls that change the shell set ─────────────────────────────────

function openNewShell(pid) {
  var cols = 80;
  var rows = 24;
  var active = panes[proj(pid).active];
  if (active && active.term) { cols = active.term.cols; rows = active.term.rows; }
  return api('/api/projects/' + encodeURIComponent(pid) + '/shells', {
    method: 'POST',
    body: JSON.stringify({ cols: cols, rows: rows }),
  }).then(function (info) {
    var p = proj(pid);
    p.shells.push(info.shellId);
    p.active = info.shellId;
    createPane(pid, info.shellId);
    repaintStrip(pid);
    mountActive(pid);
    return info;
  });
}

function closeShell(pid, shellId) {
  api(shellUrl(shellId), { method: 'DELETE' }).catch(function () { /* already gone is fine */ });
  forgetShell(pid, shellId);
  repaintStrip(pid);
  mountActive(pid);
}

function forgetShell(pid, shellId) {
  var p = proj(pid);
  var pane = panes[shellId];
  if (pane && pane.streamAbort) pane.streamAbort.abort();
  if (pane && pane.term) { try { pane.term.dispose(); } catch (e) { /* ignore */ } }
  delete panes[shellId];
  p.shells = p.shells.filter(function (s) { return s !== shellId; });
  if (p.active === shellId) p.active = p.shells.length ? p.shells[p.shells.length - 1] : null;
}

/** First visit to a project's terminal tab: adopt whatever shells the server
    already holds (from an earlier visit or another browser), else open one. */
function loadProjectShells(pid) {
  var p = proj(pid);
  p.loaded = true;
  return api('/api/projects/' + encodeURIComponent(pid) + '/shells').then(function (data) {
    var live = (data.shells || []).filter(function (s) { return s.running; });
    if (live.length) {
      live.forEach(function (s) {
        if (!panes[s.shellId]) { p.shells.push(s.shellId); createPane(pid, s.shellId); }
      });
      if (!p.active || p.shells.indexOf(p.active) === -1) p.active = p.shells[0];
      repaintStrip(pid);
      mountActive(pid);
      return;
    }
    return openNewShell(pid);
  }).catch(function () { return openNewShell(pid); });
}

// ── Repaint entry points ───────────────────────────────────────────────────

/**
 * True when this project's active terminal is already mounted in the current
 * DOM. The project view checks this before a periodic repaint: rebuilding the
 * page detaches the terminal and drops its focus mid-keystroke, so while a
 * pane is up the 30s repaint leaves the DOM alone.
 */
export function terminalPaneIsLive(pid) {
  var host = document.getElementById('termHost');
  return Boolean(host && host.getAttribute('data-pid') === pid && host.firstChild);
}

/** Called when the Terminal tab is (re)built: mount the active pane, wire controls. */
export function wireTerminalPane(pid) {
  var host = document.getElementById('termHost');
  if (!host) return;
  var p = proj(pid);

  if (!p.loaded) { loadProjectShells(pid); }

  mountActive(pid);
  wireStrip(pid);
  wireControls(pid);
}

function wireStrip(pid) {
  var strip = document.getElementById('termStrip');
  if (!strip) return;
  strip.addEventListener('click', function (e) {
    if (e.target.closest('.term-tab__rename')) return; // a click inside the rename box is not a switch
    var closeEl = e.target.closest('[data-close]');
    if (closeEl) { e.stopPropagation(); closeShell(pid, closeEl.getAttribute('data-close')); return; }
    if (e.target.closest('#termNewBtn')) { openNewShell(pid); return; }
    var tab = e.target.closest('.term-tab[data-shell]');
    if (tab) switchTo(pid, tab.getAttribute('data-shell'));
  });
  strip.addEventListener('dblclick', function (e) {
    var tab = e.target.closest('.term-tab[data-shell]');
    if (tab) startRename(pid, tab);
  });
}

/* Turn a tab's label into an input in place. Enter or blur saves (an empty name
   clears the custom label and the tab falls back to "Terminal N"); Escape
   cancels. repaintStrip rebuilds the strip from state.names afterwards. */
function startRename(pid, tab) {
  var sid = tab.getAttribute('data-shell');
  var labelEl = tab.querySelector('.term-tab__label');
  if (!labelEl || tab.querySelector('.term-tab__rename')) return;

  var input = document.createElement('input');
  input.className = 'term-tab__rename';
  input.value = labelEl.textContent;
  input.setAttribute('aria-label', 'Rename terminal');
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  var done = false;
  function commit(save) {
    if (done) return;
    done = true;
    if (save) {
      var v = input.value.trim();
      if (v) proj(pid).names[sid] = v; else delete proj(pid).names[sid];
    }
    repaintStrip(pid);
  }
  input.addEventListener('keydown', function (e) {
    e.stopPropagation(); // keep the global "/" search shortcut out of the box
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', function () { commit(true); });
}

function wireControls(pid) {
  var restartBtn = document.getElementById('termRestartBtn');
  var maxBtn = document.getElementById('termMaxBtn');

  if (restartBtn) restartBtn.addEventListener('click', function () {
    var p = proj(pid);
    if (!p.active) { openNewShell(pid); return; }
    restartBtn.disabled = true;
    var old = p.active;
    // Open the replacement first, then drop the old one, so the strip never
    // flickers to empty.
    openNewShell(pid).then(function () {
      api(shellUrl(old), { method: 'DELETE' }).catch(function () {});
      forgetShell(pid, old);
      repaintStrip(pid);
      restartBtn.disabled = false;
    }, function () { restartBtn.disabled = false; });
  });

  if (maxBtn) maxBtn.addEventListener('click', function () {
    var p = proj(pid);
    p.maximised = !p.maximised;
    var card = document.getElementById('termCard');
    if (card) card.classList.toggle('is-max', p.maximised);
    maxBtn.setAttribute('aria-pressed', p.maximised ? 'true' : 'false');
    maxBtn.setAttribute('title', p.maximised ? 'Restore' : 'Maximise');
    maxBtn.setAttribute('aria-label', p.maximised ? 'Restore' : 'Maximise');
    var use = maxBtn.querySelector('use');
    if (use) use.setAttribute('href', '#i-' + (p.maximised ? 'minimize' : 'maximize'));
    // The pane changed size; refit after the layout settles.
    var pane = p.active ? panes[p.active] : null;
    if (pane && pane.fit) requestAnimationFrame(function () { if (pane.container.isConnected) pane.fit.fit(); });
  });
}
