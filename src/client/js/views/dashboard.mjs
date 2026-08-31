// Dashboard: the configured folders, and nothing that costs a disk walk.
// Jobs and conversations are read when you open a project, not before.

import { esc, emptyState, errorCard } from '../dom.mjs';
import { state, timers } from '../state.mjs';
import { loadConfig, loadDashboard, loadUsage, setProjectFavorite } from '../data.mjs';
import { registerView, renderCurrentPage, setApp } from '../render.mjs';
import { usageCardHtml, wireUsageCard } from '../components/usage-card.mjs';

function matchesProjectSearch(p, q) {
  if (!q) return true;
  return (p.name + ' ' + p.path).toLowerCase().indexOf(q.toLowerCase()) !== -1;
}

function projectsStripHtml(projects) {
  if (!projects || projects.length === 0) {
    return '<div class="card mb-5"><div class="card__head"><div><h3>Projects</h3><p>Nothing is being monitored yet.</p></div></div>' +
      emptyState('No projects configured', 'Add a folder in Settings. Work Hub reads its .work/ jobs and its Claude Code conversations.') + '</div>';
  }
  var filtered = projects.filter(function (p) { return matchesProjectSearch(p, state.search.trim()); });
  var head = '<div class="card__head"><div><h3>Projects</h3><p>Every monitored folder. Click one to scan its jobs and list its conversations.</p></div>' +
    '<span class="badge badge-neutral">' + filtered.length + '</span></div>';
  if (filtered.length === 0) {
    return '<div class="card mb-5">' + head + emptyState('No match', 'No monitored folder matches your search.') + '</div>';
  }
  return '<div class="card mb-5">' + head + '<div class="card__body"><div class="strip">' +
    filtered.map(function (p) {
      var starred = Boolean(p.favorite);
      return '<div class="proj-cell">' +
        '<a class="proj' + (p.missing ? ' is-missing' : '') + '" href="#/p/' + esc(p.id) + '">' +
          '<span class="proj__name">' + esc(p.name) + '</span>' +
          '<span class="proj__path">' + esc(p.path) + '</span>' +
          (p.missing
            ? '<span class="badge badge-danger">folder is missing</span>'
            : (p.hasWorkDir ? '' : '<span class="proj__stats"><span class="badge badge-neutral">no .work/</span></span>')) +
        '</a>' +
        '<button type="button" class="proj__fav" data-fav="' + esc(p.id) + '"' +
          ' aria-pressed="' + (starred ? 'true' : 'false') + '"' +
          ' aria-label="' + (starred ? 'Unstar ' : 'Star ') + esc(p.name) + '"' +
          ' title="' + (starred ? 'Remove from favourites' : 'Add to favourites') + '">' +
          '<svg class="icon icon-sm"><use href="#i-star"/></svg></button>' +
      '</div>';
    }).join('') + '</div></div></div>';
}

// One listener on the strip rather than one per card: the whole dashboard is an
// innerHTML rewrite every 30s, so anything bound to a card dies with it.
function wireProjectStars() {
  var strip = document.querySelector('.strip');
  if (!strip) return;
  strip.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.proj__fav') : null;
    if (!btn || !strip.contains(btn)) return;
    e.preventDefault();   // the star sits over an <a>
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    setProjectFavorite(btn.getAttribute('data-fav'), btn.getAttribute('aria-pressed') !== 'true')
      .then(renderCurrentPage, function (err) {
        btn.disabled = false;
        state.error = err.message;
      });
  });
}

function renderDashboard() {
  var d = state.dashboard;
  if (!d) { setApp(usageCardHtml() + '<p class="muted">Loading…</p>'); wireUsageCard(); return; }

  setApp(
    '<div class="page-head"><div><h1>Dashboard</h1>' +
    '<p>Every monitored folder. Jobs and conversations are read when you open one, not before.</p></div></div>' +
    (d.loadError ? errorCard(d.loadError) : '') +
    usageCardHtml() +
    projectsStripHtml(d.projects)
  );
  wireUsageCard();
  wireProjectStars();
}

function enterDashboard() {
  renderCurrentPage();
  Promise.all([state.config ? Promise.resolve() : loadConfig(), loadDashboard(), loadUsage()]).then(renderCurrentPage);
  // Only the usage card and the folder list can change here now; neither
  // touches .work/ or a transcript.
  timers.dashboard = setInterval(function () {
    Promise.all([loadDashboard(), loadUsage()]).then(renderCurrentPage);
  }, 30000);
}

registerView('dashboard', { render: renderDashboard, enter: enterDashboard });
