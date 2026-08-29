// The "Plan usage" card at the top of the dashboard: whatever `claude /usage`
// last reported, plus the control for how often the server re-runs it.

import { esc, clockTime } from '../dom.mjs';
import { state } from '../state.mjs';
import { api } from '../api.mjs';
import { saveConfig } from '../data.mjs';
import { renderCurrentPage } from '../render.mjs';

export function usageCardHtml() {
  var u = state.usage;
  var interval = state.config ? state.config.usageIntervalMinutes : 5;
  var head =
    '<div class="usage__head">' +
      '<span class="usage__title">Plan usage</span>' +
      '<span class="usage__cmd">claude /usage</span>' +
      '<span class="usage__updated">' + (u && u.fetchedAt ? 'updated ' + esc(clockTime(u.fetchedAt)) : 'not fetched yet') + '</span>' +
      '<button type="button" class="btn btn-secondary btn-sm" id="usageRefreshBtn"><svg class="icon icon-sm"><use href="#i-refresh"/></svg> Refresh</button>' +
      '<span class="usage__interval">every <input class="input input-sm" id="usageIntervalInput" type="number" min="0" step="1" value="' + esc(interval) + '" /> min</span>' +
    '</div>';

  var body;
  if (!u) {
    body = '<p class="muted fs-sm">Loading…</p>';
  } else if (!u.ok) {
    body = '<div class="usage__error">' + esc(u.error || 'claude /usage failed') + '</div>';
  } else if (!u.limits || u.limits.length === 0) {
    body = '<p class="muted fs-sm">claude /usage returned no limit lines. Raw output:</p><pre class="chat-pre">' + esc(u.raw || '') + '</pre>';
  } else {
    body = (u.plan ? '<div class="usage__plan">' + esc(u.plan) + '</div>' : '') +
      u.limits.map(function (l) {
        var pct = Math.max(0, Math.min(100, Number(l.pct) || 0));
        var cls = pct >= 90 ? ' is-critical' : pct >= 70 ? ' is-high' : '';
        return '<div class="usage__row">' +
          '<div class="usage__rowhead"><span class="usage__label">' + esc(l.label) + '</span>' +
          '<span class="usage__pct">' + esc(l.pct) + '%</span>' +
          (l.resets ? '<span class="usage__resets">resets ' + esc(l.resets) + '</span>' : '') + '</div>' +
          '<div class="usage__bar"><div class="usage__fill' + cls + '" style="width:' + pct + '%"></div></div>' +
        '</div>';
      }).join('');
  }
  return '<div class="card usage mb-5">' + head + body + '</div>';
}

export function wireUsageCard() {
  var btn = document.getElementById('usageRefreshBtn');
  if (btn) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      api('/api/usage/refresh', { method: 'POST' })
        .then(function (u) { state.usage = u; renderCurrentPage(); })
        .catch(function (err) { state.usage = { ok: false, error: err.message, fetchedAt: Date.now() }; renderCurrentPage(); });
    });
  }
  var input = document.getElementById('usageIntervalInput');
  if (input) {
    input.addEventListener('change', function () {
      var minutes = Number(input.value);
      if (!isFinite(minutes) || minutes < 0) return;
      saveConfig({ usageIntervalMinutes: minutes });
    });
  }
}
