// Pure helpers: escaping, formatting, and the small HTML fragments every view
// builds on. Nothing here reads state or touches the network.

export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function relativeTime(ms) {
  if (!ms) return 'never';
  var diff = Date.now() - ms;
  if (diff < 0) diff = 0;
  var sec = Math.floor(diff / 1000);
  if (sec < 60) return sec + 's ago';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + ' minute' + (min === 1 ? '' : 's') + ' ago';
  var hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' hour' + (hr === 1 ? '' : 's') + ' ago';
  var day = Math.floor(hr / 24);
  if (day < 30) return day + ' day' + (day === 1 ? '' : 's') + ' ago';
  var mo = Math.floor(day / 30);
  if (mo < 12) return mo + ' month' + (mo === 1 ? '' : 's') + ' ago';
  return Math.floor(mo / 12) + ' year' + (Math.floor(mo / 12) === 1 ? '' : 's') + ' ago';
}

export function clockTime(ms) {
  if (!ms) return '—';
  var d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A workflow stamp (`startedAt` / `endedAt`, ISO with offset) as local
 * `Aug 30, 14:02`, with the year in front only when it is not this year.
 * '' for a missing or unparsable value, so callers can skip the line.
 */
export function stamp(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var dayPart = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  var timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  var year = d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + ' ';
  return year + dayPart + ', ' + timePart;
}

/** `40s`, `12m`, `3h 43m`, `2d 5h` between two stamps; '' unless both parse and end >= start. */
export function elapsed(startIso, endIso) {
  if (!startIso || !endIso) return '';
  var a = new Date(startIso).getTime();
  var b = new Date(endIso).getTime();
  if (isNaN(a) || isNaN(b) || b < a) return '';
  var sec = Math.floor((b - a) / 1000);
  if (sec < 60) return sec + 's';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + 'm';
  var hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h' + (min % 60 ? ' ' + (min % 60) + 'm' : '');
  var day = Math.floor(hr / 24);
  return day + 'd' + (hr % 24 ? ' ' + (hr % 24) + 'h' : '');
}

/** A span of milliseconds in the width of a table cell: `45s`, `4m 50s`, `1h 12m`.
 *  '' for anything that is not a positive number, so callers can print a dash. */
export function fmtDuration(ms) {
  var v = Number(ms);
  if (!isFinite(v) || v <= 0) return '';
  var sec = Math.round(v / 1000);
  if (sec < 60) return sec + 's';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + 'm' + (sec % 60 ? ' ' + (sec % 60) + 's' : '');
  var hr = Math.floor(min / 60);
  return hr + 'h' + (min % 60 ? ' ' + (min % 60) + 'm' : '');
}

export function shortId(sid) { return String(sid || '').slice(0, 8); }

/** A token count in the width a table cell has: `512`, `38.4k`, `1.2M`. */
export function fmtTokens(n) {
  var v = Number(n);
  if (!isFinite(v) || v <= 0) return '0';
  var scaled = function (x, suffix) {
    var s = x.toFixed(1);
    if (s.slice(-2) === '.0') s = s.slice(0, -2);
    return s + suffix;
  };
  if (v < 1000) return String(Math.round(v));
  // 999999 reads as 1M, not 1000k: rounding to one decimal is what decides the unit.
  if (v < 999950) return scaled(v / 1000, 'k');
  return scaled(v / 1000000, 'M');
}

export function listLen(v) { return Array.isArray(v) ? v.length : 0; }

export function truncated(text, limit) {
  var s = String(text == null ? '' : text);
  return s.length > limit ? s.slice(0, limit) + '\n… (' + (s.length - limit) + ' more characters)' : s;
}

/* Both passes are needed: the second catches a `[0m` whose ESC a writer upstream
   already stripped, which would otherwise be shown as literal text. */
export function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '').replace(/\[[0-9;]*m/g, '');
}

export function acText(job) {
  var text = (job.acPass || 0) + ' pass / ' + (job.acTotal || 0) + ' total';
  if (job.acImplemented > 0) text += ' · ' + job.acImplemented + ' implemented';
  return text;
}

// ---- Badges ----------------------------------------------------------------

export function badge(value, colorMap) {
  var label = value === null || value === undefined ? '(none)' : String(value);
  var cls = (colorMap && Object.prototype.hasOwnProperty.call(colorMap, label)) ? colorMap[label] : 'neutral';
  return '<span class="badge badge-' + cls + ' mono">' + esc(label) + '</span>';
}

export const STATUS_COLORS = { intake: 'neutral', planned: 'info', in_progress: 'info', building: 'info', green: 'success', done: 'success', blocked: 'danger' };
export const WORKFLOW_COLORS = { done: 'success', skipped: 'neutral', in_progress: 'info', pending: 'neutral', blocked: 'danger' };
export const AC_COLORS = { pass: 'success', implemented: 'info', pending: 'neutral', blocked: 'danger', fail: 'danger' };
export const TASK_COLORS = { done: 'success', in_progress: 'info', pending: 'neutral', blocked: 'danger' };
export const CASE_COLORS = { pass: 'success', fail: 'danger', blocked: 'danger' };
export const TIER_COLORS = { pass: 'success', fail: 'danger', blocked: 'danger' };

// ---- Stock fragments -------------------------------------------------------

export function errorCard(message) {
  return '<div class="card"><div class="card__body"><div class="empty-state empty-state--sm">' +
    '<span class="empty-state__ic"><svg class="icon icon-lg"><use href="#i-alert"/></svg></span>' +
    '<strong>Something went wrong</strong><p class="mono">' + esc(message) + '</p></div></div></div>';
}

export function emptyState(title, text) {
  return '<div class="empty-state empty-state--sm">' +
    '<span class="empty-state__ic"><svg class="icon icon-lg"><use href="#i-inbox"/></svg></span>' +
    '<strong>' + esc(title) + '</strong><p>' + esc(text) + '</p></div>';
}

export function loadingCard(title, text) {
  return '<div class="card mb-5"><div class="card__head"><div><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p></div>' +
    '<span class="spinner" aria-hidden="true"></span></div>' +
    '<div class="card__body"><p class="muted fs-sm">Loading…</p></div></div>';
}
