// The strip above a transcript: the session's token box, find-in-conversation,
// and the pager that walks the 50-message pages.
//
// Every bit of this state lives in state.mjs. The transcript is re-read and the
// whole page repainted every 3 seconds during a run, so a page number, a query
// or a collapsed flag left in the DOM would be wiped on each tick.

import { esc, fmtTokens, fmtDuration } from '../dom.mjs';
import { state } from '../state.mjs';
import { app, renderCurrentPage } from '../render.mjs';

const MESSAGES_PER_PAGE = 50;

// Where the caret was when the repaint took the focused input away with it.
let findFocus = { on: false, start: 0, end: 0 };
let findTimer = null;

/** Called when a conversation is opened, so no caret is restored into the next one. */
export function resetChatTools() {
  findFocus = { on: false, start: 0, end: 0 };
  if (findTimer) { clearTimeout(findTimer); findTimer = null; }
}

// ---- The visible slice -----------------------------------------------------

/** Everything in a message that a find should look at, joined for one scan. */
function messageText(m) {
  return (m.parts || []).map(function (p) {
    switch (p.kind) {
      case 'text':
      case 'thinking':
      case 'tool_result':
        return p.text || '';
      case 'tool_use':
        return (p.tool || '') + ' ' + (p.input || '');
      case 'event':
        return (p.label || '') + ' ' + (p.text || '');
      default:
        return '';
    }
  }).join('\n');
}

/**
 * The messages this paint shows, plus what the pager needs to describe them.
 * A search filters the whole conversation, not the page, and pages the matches
 * as its own set.
 */
export function chatView(sid) {
  var all = (state.chat && state.chat.messages) || [];
  var query = state.chatSearch.trim();
  var searching = query.length > 0;
  var needle = query.toLowerCase();
  var list = searching
    ? all.filter(function (m) { return messageText(m).toLowerCase().indexOf(needle) !== -1; })
    : all;

  var pages = Math.max(1, Math.ceil(list.length / MESSAGES_PER_PAGE));
  var stored = searching ? state.chatSearchPage : state.chatPage[sid];
  // A null page means "pinned to the newest page": what a conversation opens
  // on, and the only state in which an arriving message may pull the reader
  // forward. Paging back stores a number instead and the pin is gone.
  var pinned = !searching && (stored === null || stored === undefined);
  var page = pinned ? pages - 1 : (stored || 0);
  if (page > pages - 1) page = pages - 1;
  if (page < 0) page = 0;

  return {
    sid: sid,
    messages: list.slice(page * MESSAGES_PER_PAGE, (page + 1) * MESSAGES_PER_PAGE),
    total: list.length,
    page: page,
    pages: pages,
    from: list.length === 0 ? 0 : page * MESSAGES_PER_PAGE + 1,
    to: Math.min(list.length, (page + 1) * MESSAGES_PER_PAGE),
    searching: searching,
    query: query,
    pinned: pinned,
  };
}

// ---- Markup ----------------------------------------------------------------

/* Not `.pager`: wireSessionPager() wires the first `.pager` it finds under the
   app, and would grab this one whenever the sessions list is short enough to
   have none of its own. */
export function chatPagerHtml(view) {
  if (view.pages < 2) return '';
  return '<div class="chat-pager">' +
    '<span class="pager__info">' + view.from + '-' + view.to + ' of ' + view.total + (view.searching ? ' matching' : '') + '</span>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-chatpage="' + (view.page - 1) + '"' + (view.page === 0 ? ' disabled' : '') + '>Prev</button>' +
    '<span class="pager__info">' + (view.page + 1) + ' / ' + view.pages + '</span>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-chatpage="' + (view.page + 1) + '"' + (view.page >= view.pages - 1 ? ' disabled' : '') + '>Next</button>' +
  '</div>';
}

function tokCell(label, value) {
  return '<td class="mono" data-label="' + label + '">' + esc(fmtTokens(value)) + '</td>';
}

function countCell(label, value) {
  return '<td class="mono" data-label="' + label + '">' + esc(String(Number(value) || 0)) + '</td>';
}

/** A model as the chip the tables show it in. The `claude-` prefix is on every
 *  one of them and costs a third of the column. */
function modelChip(model) {
  if (!model) return '<span class="tok-chip">—</span>';
  return '<span class="tok-chip">' + esc(String(model).replace(/^claude-/, '')) + '</span>';
}

function section(title, count, head, rows) {
  return '<section class="tok-sec">' +
    '<div class="tok-sec__head"><span class="tok-sec__title">' + esc(title) + '</span>' +
    (count ? '<span class="tok-sec__count">' + esc(count) + '</span>' : '') + '</div>' +
    '<div class="table-wrap"><table class="table table--stack"><thead><tr>' + head + '</tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></section>';
}

var MAIN_HEAD = '<th>Model</th><th>Input</th><th>C.write</th><th>C.read</th><th>Output</th><th>Total</th>';

function mainRow(first, u, cls) {
  var t = u || {};
  return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' +
    '<td data-label="Model">' + first + '</td>' +
    tokCell('Input', t.input) + tokCell('Cache write', t.cacheCreate) +
    tokCell('Cache read', t.cacheRead) + tokCell('Output', t.output) + tokCell('Total', t.total) +
  '</tr>';
}

var AGENT_HEAD = '<th>Teammate / subagent</th><th>Model</th><th>Turns</th><th>Tools</th>' +
  '<th>Input</th><th>C.write</th><th>C.read</th><th>Output</th><th>Tokens</th><th>Time</th>';

function agentRow(a) {
  // Spawns is the count of transcripts one named agent produced; a single run
  // is the norm, so the marker only earns its space above one.
  var repeat = a.spawns > 1 ? '<span class="tok-chip tok-chip--spawns">×' + esc(String(a.spawns)) + '</span>' : '';
  var time = fmtDuration(a.durationMs);
  return '<tr>' +
    // One wrapper, not name-plus-chip loose in the cell: stacked on a phone the
    // cell is a grid and each loose child would take a row of its own.
    '<td data-label="Subagent"><span class="tok-agent">' + esc(a.name || 'agent') + repeat + '</span></td>' +
    '<td data-label="Model">' + modelChip(a.model) + '</td>' +
    countCell('Turns', a.turns) + countCell('Tools', a.toolUses) +
    tokCell('Input', a.input) + tokCell('Cache write', a.cacheCreate) +
    tokCell('Cache read', a.cacheRead) + tokCell('Output', a.output) +
    tokCell('Tokens', a.total) +
    '<td class="mono" data-label="Time">' + esc(time || '—') + '</td>' +
  '</tr>';
}

function sumBy(list, key) {
  return list.reduce(function (n, a) { return n + (Number(a[key]) || 0); }, 0);
}

function agentTotalRow(agents, totals) {
  var total = totals && totals.total !== undefined && totals.total !== null ? totals.total : sumBy(agents, 'total');
  return '<tr class="tok-row--total">' +
    '<td data-label="Subagent">Total</td><td data-label="Model"></td>' +
    countCell('Turns', sumBy(agents, 'turns')) + countCell('Tools', sumBy(agents, 'toolUses')) +
    tokCell('Input', sumBy(agents, 'input')) + tokCell('Cache write', sumBy(agents, 'cacheCreate')) +
    tokCell('Cache read', sumBy(agents, 'cacheRead')) + tokCell('Output', sumBy(agents, 'output')) +
    tokCell('Tokens', total) +
    '<td class="mono" data-label="Time"></td>' +
  '</tr>';
}

/* Tokens only. This box never shows a price: the numbers come from the
   transcript, and what they would cost depends on a plan this tool cannot see.
   Head and body are returned apart - the head shares a flex row with the find
   box, the tables are a block under it. */
function usageHtml() {
  var none = { head: '', body: '' };
  var u = state.chat && state.chat.usage;
  if (!u || !u.totals) return none;
  var subs = u.subagents || {};
  var agents = subs.agents || [];
  var agentCount = typeof subs.agentCount === 'number' ? subs.agentCount : agents.length;
  if (!(u.totals.total > 0) && agentCount === 0) return none;

  var summary = fmtTokens(u.totals.total) + ' tokens';
  if (agentCount > 0) summary += ' · ' + agentCount + ' transcript' + (agentCount === 1 ? '' : 's');
  var open = !!state.chatUsageOpen;

  var head = '<button type="button" class="tok__head" id="tokToggle" aria-expanded="' + (open ? 'true' : 'false') + '">' +
    '<span class="tok__title">Tokens</span>' +
    '<span class="tok__sum">' + esc(summary) + '</span></button>';
  if (!open) return { head: head, body: '' };

  var body = '';
  if (u.main) {
    var byModel = u.main.byModel || [];
    var mainRows = byModel.map(function (m) { return mainRow(modelChip(m.model), m, ''); }).join('');
    mainRows += mainRow('Total', u.main.totals, 'tok-row--total');
    body += section('Main thread', '', MAIN_HEAD, mainRows);
  }
  if (agentCount > 0 && agents.length) {
    var agentRows = agents.map(agentRow).join('') + agentTotalRow(agents, subs.totals);
    body += section('Subagents & team', agentCount + ' transcript' + (agentCount === 1 ? '' : 's'), AGENT_HEAD, agentRows);
  }
  body += '<div class="tok-foot"><span>Session + subagents</span>' +
    '<span class="tok-foot__value">' + esc(fmtTokens(u.totals.total)) + ' tokens</span></div>';

  return { head: head, body: '<div class="tok__body">' + body + '</div>' };
}

function findHtml(view) {
  return '<div class="chat-find">' +
    '<svg class="icon icon-sm"><use href="#i-search"/></svg>' +
    '<input type="search" id="chatFind" autocomplete="off" placeholder="Find in this conversation…" aria-label="Find in this conversation" value="' + esc(state.chatSearch) + '" />' +
    (state.chatSearch
      ? '<button type="button" class="chat-find__clear" id="chatFindClear" aria-label="Clear search" title="Clear search"><svg class="icon icon-sm"><use href="#i-x"/></svg></button>'
      : '') +
    '</div>' +
    (view.searching ? '<span class="chat-find__count">' + view.total + ' match' + (view.total === 1 ? '' : 'es') + '</span>' : '');
}

/** The sticky strip itself. Pinned above the chat so it survives scrolling. */
export function chatToolsHtml(view) {
  var usage = usageHtml();
  return '<div class="convtools">' +
    '<div class="convtools__bar">' + usage.head + findHtml(view) + '</div>' +
    usage.body +
    chatPagerHtml(view) +
    '</div>';
}

// ---- Wiring ----------------------------------------------------------------

function setChatPage(view, page) {
  if (view.searching) {
    state.chatSearchPage = page;
  } else {
    // Landing on the last page re-pins the view to the newest, so an arriving
    // message follows the reader forward again.
    state.chatPage[view.sid] = page >= view.pages - 1 ? null : page;
  }
  renderCurrentPage();
}

export function wireChatTools(view) {
  var toggle = document.getElementById('tokToggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      state.chatUsageOpen = !state.chatUsageOpen;
      renderCurrentPage();
    });
  }

  app.querySelectorAll('button[data-chatpage]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      setChatPage(view, Number(btn.getAttribute('data-chatpage')));
    });
  });

  var clear = document.getElementById('chatFindClear');
  if (clear) {
    clear.addEventListener('click', function () {
      // The normal page was never touched while searching, so dropping the
      // query puts the reader back exactly where they left off.
      state.chatSearch = '';
      state.chatSearchPage = 0;
      findFocus.on = false;
      renderCurrentPage();
    });
  }

  var find = document.getElementById('chatFind');
  if (!find) return;
  var remember = function () { findFocus = { on: true, start: find.selectionStart, end: find.selectionEnd }; };
  find.addEventListener('focus', remember);
  find.addEventListener('keyup', remember);
  find.addEventListener('click', remember);
  // Only a blur the reader caused counts. Firefox also fires one when the
  // repaint tears the input out of the document, and that must not read as
  // "they left the box".
  find.addEventListener('blur', function () { if (find.isConnected) findFocus.on = false; });
  find.addEventListener('input', function () {
    remember();
    state.chatSearch = find.value;
    state.chatSearchPage = 0;
    if (findTimer) clearTimeout(findTimer);
    findTimer = setTimeout(function () { findTimer = null; renderCurrentPage(); }, 200);
  });
  find.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && find.value) {
      e.preventDefault();
      state.chatSearch = '';
      state.chatSearchPage = 0;
      renderCurrentPage();
    }
  });

  // setApp() replaced the input this caret was in. Put it back, or typing here
  // would be impossible during a run: the poll repaints every second.
  if (findFocus.on) {
    var start = findFocus.start;
    var end = findFocus.end;
    find.focus();
    find.setSelectionRange(start, end);
    findFocus = { on: true, start: start, end: end };
  }
}

/**
 * Highlights the query inside the already-rendered chat.
 *
 * It has to happen here rather than in messageHtml(): every message body is
 * built by escaping its text, so wrapping matches before that would escape the
 * wrapper too, and wrapping after it would mean splicing into escaped markup.
 * Walking the rendered text nodes touches text only - no markup is ever parsed
 * from the transcript or from the query.
 */
export function highlightChat(query) {
  var root = app.querySelector('.chat');
  var needle = String(query || '').toLowerCase();
  if (!root || !needle) return;

  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  var nodes = [];
  var node;
  while ((node = walker.nextNode())) nodes.push(node);

  nodes.forEach(function (n) {
    var text = n.nodeValue;
    var hay = text.toLowerCase();
    if (hay.indexOf(needle) === -1) return;
    var frag = document.createDocumentFragment();
    var at = 0;
    var found;
    while ((found = hay.indexOf(needle, at)) !== -1) {
      if (found > at) frag.appendChild(document.createTextNode(text.slice(at, found)));
      var mark = document.createElement('mark');
      mark.className = 'hl';
      mark.textContent = text.slice(found, found + needle.length);
      frag.appendChild(mark);
      at = found + needle.length;
    }
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
    n.parentNode.replaceChild(frag, n);
  });
}
