// Dashboard: the configured folders, and nothing that costs a disk walk.
// Jobs and conversations are read when you open a project, not before.

import { esc, emptyState, errorCard } from '../dom.mjs';
import { state, timers } from '../state.mjs';
import { loadConfig, loadDashboard, loadUsage, setProjectFavorite, saveGroups } from '../data.mjs';
import { registerView, renderCurrentPage, setApp } from '../render.mjs';
import { usageCardHtml, wireUsageCard } from '../components/usage-card.mjs';

function matchesProjectSearch(p, q) {
  if (!q) return true;
  return (p.name + ' ' + p.path).toLowerCase().indexOf(q.toLowerCase()) !== -1;
}

// Survives the innerHTML repaint every poll tick triggers, like composerDraft:
// the open create/rename form and its half-typed name live here, not in the DOM.
var groupDraft = { mode: null, index: -1, text: '', focused: false, error: '' };
// The project being dragged. dataTransfer cannot be read during dragover, so
// the pid has to sit in module state for the drop targets to react to.
var dragPid = null;
// Which card's "move to group" menu is open, by project id.
var menuPid = null;

function closeGroupDraft() {
  groupDraft = { mode: null, index: -1, text: '', focused: false, error: '' };
}

function projCellHtml(p, groups) {
  var starred = Boolean(p.favorite);
  var hasGroups = groups.length > 0;
  var menu = '';
  if (hasGroups && menuPid === p.id) {
    var options = '';
    var grouped = false;
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].ids.indexOf(p.id) !== -1) { grouped = true; continue; }
      options += '<button type="button" data-move-to="' + i + '">' + esc(groups[i].name) + '</button>';
    }
    if (grouped) options += '<button type="button" data-move-to="-1">Ungrouped</button>';
    menu = '<div class="proj__menu">' + (options || '<span class="proj__menu-none">No other group</span>') + '</div>';
  }
  return '<div class="proj-cell" data-pid="' + esc(p.id) + '"' + (hasGroups ? ' draggable="true"' : '') + '>' +
    '<a class="proj' + (p.missing ? ' is-missing' : '') + '" href="#/p/' + esc(p.id) + '"' + (hasGroups ? ' draggable="false"' : '') + '>' +
      '<span class="proj__name">' + esc(p.name) + '</span>' +
      '<span class="proj__path">' + esc(p.path) + '</span>' +
      (p.missing
        ? '<span class="badge badge-danger">folder is missing</span>'
        : (p.hasWorkDir ? '' : '<span class="proj__stats"><span class="badge badge-neutral">no .work/</span></span>')) +
    '</a>' +
    (hasGroups
      ? '<button type="button" class="proj__move" data-move="' + esc(p.id) + '"' +
        ' aria-label="Move ' + esc(p.name) + ' to a group" title="Move to group">' +
        '<svg class="icon icon-sm"><use href="#i-folder"/></svg></button>'
      : '') +
    '<button type="button" class="proj__fav" data-fav="' + esc(p.id) + '"' +
      ' aria-pressed="' + (starred ? 'true' : 'false') + '"' +
      ' aria-label="' + (starred ? 'Unstar ' : 'Star ') + esc(p.name) + '"' +
      ' title="' + (starred ? 'Remove from favourites' : 'Add to favourites') + '">' +
      '<svg class="icon icon-sm"><use href="#i-star"/></svg></button>' +
    menu +
  '</div>';
}

function groupFormHtml(submitLabel) {
  return '<span class="grpform">' +
    '<input class="input" id="groupNameInput" maxlength="60" placeholder="Group name" autocomplete="off" value="' + esc(groupDraft.text) + '" />' +
    '<button type="button" class="btn btn-primary btn-sm" id="groupNameSave">' + submitLabel + '</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" id="groupNameCancel">Cancel</button>' +
    (groupDraft.error ? '<span class="grpform__error">' + esc(groupDraft.error) + '</span>' : '') +
  '</span>';
}

/** One group section: header (or the rename form) and its strip. `index` is the
 *  group's position in state.dashboard.groups; -1 is the Ungrouped section. */
function groupSectionHtml(name, index, cells) {
  var head;
  if (groupDraft.mode === 'rename' && groupDraft.index === index) {
    head = groupFormHtml('Rename');
  } else {
    head = '<h4 class="pgroup__name">' + esc(name) + '</h4>' +
      '<span class="badge badge-neutral">' + cells.length + '</span>' +
      (index >= 0
        ? '<span class="pgroup__actions">' +
          '<button type="button" class="pgroup__btn" data-grp-rename="' + index + '" aria-label="Rename ' + esc(name) + '" title="Rename group">' +
            '<svg class="icon icon-sm"><use href="#i-pencil"/></svg></button>' +
          '<button type="button" class="pgroup__btn" data-grp-delete="' + index + '" aria-label="Delete ' + esc(name) + '" title="Delete group (its projects stay)">' +
            '<svg class="icon icon-sm"><use href="#i-x"/></svg></button>' +
        '</span>'
        : '');
  }
  return '<div class="pgroup" data-group-index="' + index + '">' +
    '<div class="pgroup__head">' + head + '</div>' +
    (cells.length
      ? '<div class="strip">' + cells.join('') + '</div>'
      : '<div class="pgroup__empty">Drag a project here.</div>') +
  '</div>';
}

function projectsCardHtml(d) {
  var projects = d.projects || [];
  var groups = d.groups || [];
  if (projects.length === 0) {
    return '<div class="card mb-5"><div class="card__head"><div><h3>Projects</h3><p>Nothing is being monitored yet.</p></div></div>' +
      emptyState('No projects configured', 'Add a folder in Settings. Work Hub reads its .work/ jobs and its Claude Code conversations.') + '</div>';
  }
  var q = state.search.trim();
  var filtered = projects.filter(function (p) { return matchesProjectSearch(p, q); });
  var head = '<div class="card__head"><div><h3>Projects</h3><p>Every monitored folder. Click one to scan its jobs and list its conversations.</p></div>' +
    '<span class="card__head-actions">' +
      '<button type="button" class="btn btn-secondary btn-sm" id="newGroupBtn"><svg class="icon"><use href="#i-plus"/></svg> Group</button>' +
      '<span class="badge badge-neutral">' + filtered.length + '</span>' +
    '</span></div>';
  var newForm = groupDraft.mode === 'new' ? '<div class="grpform-row">' + groupFormHtml('Create') + '</div>' : '';
  if (filtered.length === 0) {
    return '<div class="card mb-5" id="projectsCard">' + head + '<div class="card__body">' + newForm +
      emptyState('No match', 'No monitored folder matches your search.') + '</div></div>';
  }

  var body;
  if (groups.length === 0) {
    body = '<div class="strip">' + filtered.map(function (p) { return projCellHtml(p, groups); }).join('') + '</div>';
  } else {
    var claimed = {};
    body = groups.map(function (g, i) {
      var cells = [];
      for (var j = 0; j < filtered.length; j++) {
        if (g.ids.indexOf(filtered[j].id) !== -1) {
          claimed[filtered[j].id] = true;
          cells.push(projCellHtml(filtered[j], groups));
        }
      }
      // While searching, a group with no hit disappears instead of showing an
      // empty drop target for a list the search already emptied.
      if (q && cells.length === 0) return '';
      return groupSectionHtml(g.name, i, cells);
    }).join('');
    var rest = filtered.filter(function (p) { return !claimed[p.id]; })
      .map(function (p) { return projCellHtml(p, groups); });
    if (!q || rest.length > 0) body += groupSectionHtml('Ungrouped', -1, rest);
  }

  return '<div class="card mb-5" id="projectsCard">' + head + '<div class="card__body">' + newForm + body + '</div></div>';
}

// ---- Group writes -----------------------------------------------------------

/** A mutable copy of the current group list, ready to edit and PUT back. */
function groupsForWrite() {
  return (state.dashboard.groups || []).map(function (g) {
    return { name: g.name, ids: g.ids.slice() };
  });
}

function commitGroups(groups) {
  saveGroups(groups).then(renderCurrentPage, function (err) {
    state.error = err.message;
    renderCurrentPage();
  });
}

/** Removes the project from every group, then adds it to `targetIndex` (-1 = ungrouped). */
function moveToGroup(pid, targetIndex) {
  var groups = groupsForWrite().map(function (g) {
    return { name: g.name, ids: g.ids.filter(function (id) { return id !== pid; }) };
  });
  if (targetIndex >= 0 && groups[targetIndex]) groups[targetIndex].ids.push(pid);
  commitGroups(groups);
}

function submitGroupForm() {
  var name = groupDraft.text.trim();
  if (!name) { closeGroupDraft(); renderCurrentPage(); return; }
  var groups = groupsForWrite();
  var skip = groupDraft.mode === 'rename' ? groupDraft.index : -1;
  for (var i = 0; i < groups.length; i++) {
    if (i !== skip && groups[i].name.toLowerCase() === name.toLowerCase()) {
      groupDraft.error = 'A group named "' + name + '" already exists.';
      groupDraft.focused = true;
      renderCurrentPage();
      return;
    }
  }
  if (groupDraft.mode === 'rename') groups[groupDraft.index].name = name;
  else groups.push({ name: name, ids: [] });
  closeGroupDraft();
  commitGroups(groups);
}

// ---- Wiring -----------------------------------------------------------------
// One listener set on the card rather than one per element: the whole dashboard
// is an innerHTML rewrite every 30s, so anything bound to a card dies with it.

function onCardClick(e) {
  var hit = function (sel) { return e.target.closest ? e.target.closest(sel) : null; };

  var fav = hit('.proj__fav');
  if (fav) {
    e.preventDefault();   // the star sits over an <a>
    e.stopPropagation();
    if (fav.disabled) return;
    fav.disabled = true;
    setProjectFavorite(fav.getAttribute('data-fav'), fav.getAttribute('aria-pressed') !== 'true')
      .then(renderCurrentPage, function (err) {
        fav.disabled = false;
        state.error = err.message;
      });
    return;
  }

  var move = hit('.proj__move');
  if (move) {
    e.preventDefault();
    e.stopPropagation();
    var pid = move.getAttribute('data-move');
    menuPid = menuPid === pid ? null : pid;
    renderCurrentPage();
    return;
  }

  var opt = hit('[data-move-to]');
  if (opt) {
    e.preventDefault();
    var cell = opt.closest('.proj-cell');
    menuPid = null;
    moveToGroup(cell.getAttribute('data-pid'), Number(opt.getAttribute('data-move-to')));
    return;
  }

  if (hit('#newGroupBtn')) {
    groupDraft = { mode: 'new', index: -1, text: '', focused: true, error: '' };
    renderCurrentPage();
    return;
  }

  var rename = hit('[data-grp-rename]');
  if (rename) {
    var ri = Number(rename.getAttribute('data-grp-rename'));
    groupDraft = { mode: 'rename', index: ri, text: state.dashboard.groups[ri].name, focused: true, error: '' };
    renderCurrentPage();
    return;
  }

  var del = hit('[data-grp-delete]');
  if (del) {
    var groups = groupsForWrite();
    groups.splice(Number(del.getAttribute('data-grp-delete')), 1);
    commitGroups(groups);
    return;
  }

  if (hit('#groupNameSave')) { submitGroupForm(); return; }
  if (hit('#groupNameCancel')) { closeGroupDraft(); renderCurrentPage(); return; }
}

function onCardDrag(e) {
  var section;
  if (e.type === 'dragstart') {
    var cell = e.target.closest ? e.target.closest('.proj-cell[draggable]') : null;
    if (!cell) return;
    dragPid = cell.getAttribute('data-pid');
    e.dataTransfer.setData('text/plain', dragPid);
    e.dataTransfer.effectAllowed = 'move';
    cell.classList.add('is-dragging');
  } else if (e.type === 'dragover') {
    section = e.target.closest ? e.target.closest('.pgroup') : null;
    if (!section || !dragPid) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    section.classList.add('is-dropover');
  } else if (e.type === 'dragleave') {
    section = e.target.closest ? e.target.closest('.pgroup') : null;
    if (section && !section.contains(e.relatedTarget)) section.classList.remove('is-dropover');
  } else if (e.type === 'drop') {
    section = e.target.closest ? e.target.closest('.pgroup') : null;
    if (!section || !dragPid) return;
    e.preventDefault();
    section.classList.remove('is-dropover');
    var pid = dragPid;
    dragPid = null;
    var index = Number(section.getAttribute('data-group-index'));
    var already = index === -1
      ? !state.dashboard.groups.some(function (g) { return g.ids.indexOf(pid) !== -1; })
      : state.dashboard.groups[index] && state.dashboard.groups[index].ids.indexOf(pid) !== -1;
    if (!already) moveToGroup(pid, index);
  } else if (e.type === 'dragend') {
    dragPid = null;
    var dragging = document.querySelector('.proj-cell.is-dragging');
    if (dragging) dragging.classList.remove('is-dragging');
    var over = document.querySelector('.pgroup.is-dropover');
    if (over) over.classList.remove('is-dropover');
  }
}

// A click anywhere off the open move-menu closes it. Registered once, on the
// document, so the per-repaint card listeners never stack a second copy.
var docWired = false;
function wireDocument() {
  if (docWired) return;
  docWired = true;
  document.addEventListener('click', function (e) {
    if (menuPid === null) return;
    if (e.target.closest && e.target.closest('.proj__menu, .proj__move')) return;
    menuPid = null;
    if (state.route.name === 'dashboard') renderCurrentPage();
  });
}

function wireProjects() {
  var card = document.getElementById('projectsCard');
  if (!card) return;
  card.addEventListener('click', onCardClick);
  card.addEventListener('input', function (e) {
    if (e.target.id === 'groupNameInput') groupDraft.text = e.target.value;
  });
  card.addEventListener('keydown', function (e) {
    if (e.target.id !== 'groupNameInput') return;
    if (e.key === 'Enter') { e.preventDefault(); submitGroupForm(); }
    if (e.key === 'Escape') { closeGroupDraft(); renderCurrentPage(); }
  });
  ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend'].forEach(function (type) {
    card.addEventListener(type, onCardDrag);
  });
  wireDocument();

  // The repaint that painted this card destroyed the previous input; put the
  // caret back where the user was typing.
  if (groupDraft.mode && groupDraft.focused) {
    var input = document.getElementById('groupNameInput');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function renderDashboard() {
  var d = state.dashboard;
  if (!d) { setApp(usageCardHtml() + '<p class="muted">Loading…</p>'); wireUsageCard(); return; }

  setApp(
    '<div class="page-head"><div><h1>Dashboard</h1>' +
    '<p>Every monitored folder. Jobs and conversations are read when you open one, not before.</p></div></div>' +
    (d.loadError ? errorCard(d.loadError) : '') +
    usageCardHtml() +
    projectsCardHtml(d)
  );
  wireUsageCard();
  wireProjects();
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
