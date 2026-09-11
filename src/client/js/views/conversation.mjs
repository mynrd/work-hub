// Conversation page: one transcript, the composer under it, and the session
// list beside it (under it, below 1080px).

import { esc, shortId, emptyState, errorCard } from '../dom.mjs';
import { state, composerDraft } from '../state.mjs';
import { loadChat, loadConfig, loadDashboard, loadSessions, projectOf } from '../data.mjs';
import { registerView, renderCurrentPage, setApp } from '../render.mjs';
import { messageHtml } from '../components/chat.mjs';
import { composerHtml, wireComposer } from '../components/composer.mjs';
import { sessionsCardHtml, wireSessionPager, wireNewConversation, wireTerminal, resetSessionSnap } from '../components/sessions-card.mjs';
import { chatView, chatToolsHtml, chatPagerHtml, wireChatTools, highlightChat, resetChatTools } from '../components/chat-tools.mjs';

function renderConversation() {
  var pid = state.route.pid;
  var sid = state.route.sid;
  var isNew = sid === 'new';
  var project = projectOf(pid);
  var data = state.sessions[pid];
  var summary = data ? data.sessions.filter(function (s) { return s.sessionId === sid; })[0] : null;

  var view = null;
  var tools = '';
  var body;
  if (isNew) {
    body = '<div class="card"><div class="card__body">' +
      emptyState('New conversation', 'Type below and send. Work Hub runs claude with this project folder as the working directory, then opens the session it creates.') +
      '</div></div>';
  } else if (state.error && !state.chat) {
    body = errorCard(state.error);
  } else if (!state.chat) {
    body = '<p class="muted">Loading…</p>';
  } else if (state.chat.messages.length === 0) {
    body = '<div class="card"><div class="card__body">' + emptyState('Empty transcript', 'This session file holds no renderable records yet.') + '</div></div>';
  } else {
    view = chatView(sid);
    tools = chatToolsHtml(view);
    body = view.total === 0
      ? '<div class="card"><div class="card__body">' + emptyState('No matches', 'No message in this conversation contains “' + view.query + '”.') + '</div></div>'
      : '<div class="chat">' + view.messages.map(messageHtml).join('') + '</div>' + chatPagerHtml(view);
  }

  // Full screen is for reading a transcript: topbar, page head, session list and
  // composer all go (see .is-conv-max in views.css), leaving the token/find
  // strip pinned above the messages. Everything still scrolls the window, so
  // auto-follow and the scroll-jump button behave exactly as they do normally.
  var max = !!state.chatMax;
  document.body.classList.toggle('is-conv-max', max);

  setApp(
    (max
      ? '<button type="button" class="icon-btn conv-restore" id="convRestoreBtn" title="Restore" aria-label="Restore">' +
          '<svg class="icon icon-sm"><use href="#i-minimize"/></svg></button>'
      : '') +
    '<div class="page-head"><div>' +
      '<h1>' + esc(isNew ? 'New conversation' : (summary ? summary.title : shortId(sid))) + '</h1>' +
      '<p class="mono">' + esc(project ? project.path : '') + (isNew ? '' : ' · ' + esc(shortId(sid))) + '</p></div>' +
      '<div class="row gap-2">' +
        '<a class="btn btn-secondary" href="#/p/' + esc(pid) + '"><svg class="icon"><use href="#i-back"/></svg> ' + esc(project ? project.name : 'Project') + '</a>' +
        '<button type="button" class="icon-btn" id="convMaxBtn" title="Maximise" aria-label="Maximise">' +
          '<svg class="icon"><use href="#i-maximize"/></svg></button>' +
      '</div>' +
    '</div>' +
    '<div class="conv-layout">' +
      '<div class="conv-list">' + sessionsCardHtml(pid, sid) + '</div>' +
      '<div class="col gap-4">' + tools + body + composerHtml(isNew ? null : sid) + '</div>' +
    '</div>'
  );
  wireConvMax();
  wireComposer(pid, isNew ? null : sid);
  wireNewConversation(pid);
  wireTerminal(pid);
  wireSessionPager(pid);
  if (view) {
    wireChatTools(view);
    if (view.searching) highlightChat(view.query);
  }
  scrollChatToEnd(sid, view);
}

/* Full screen is a repaint like any other: the flag lives in state, so the 3
   second poll cannot undo it. A reader already at the newest message stays
   there - removing the page head and the composer changes the page height, and
   without this the last line would drift off the bottom. */
function setConvMax(on) {
  state.chatMax = on;
  var wasAtEnd = chatScroll.atEnd;
  renderCurrentPage();
  if (!wasAtEnd) return;
  requestAnimationFrame(function () {
    var el = document.scrollingElement || document.documentElement;
    el.scrollTop = el.scrollHeight;
    chatScroll.atEnd = true;
  });
}

function wireConvMax() {
  var maxBtn = document.getElementById('convMaxBtn');
  if (maxBtn) maxBtn.addEventListener('click', function () { setConvMax(true); });
  var restoreBtn = document.getElementById('convRestoreBtn');
  if (restoreBtn) restoreBtn.addEventListener('click', function () { setConvMax(false); });
}

/* A conversation opens at its newest message, the way every chat client does.
   Once open it only auto-follows while the reader is already at the bottom AND
   still on the newest page - the transcript is re-read every 3 seconds during a
   run, and yanking someone back down mid-scroll, or forward off the page they
   paged back to, would make an in-flight reply unreadable. */
let chatScroll = { sid: null, count: -1, atEnd: true };

function scrollerAtEnd() {
  var el = document.scrollingElement || document.documentElement;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

window.addEventListener('scroll', function () {
  if (state.route.name === 'conversation') chatScroll.atEnd = scrollerAtEnd();
}, { passive: true });

function scrollChatToEnd(sid, view) {
  if (!state.chat || !state.chat.messages || state.chat.messages.length === 0) return;
  var count = state.chat.messages.length;
  var isNewView = chatScroll.sid !== sid;
  var grew = count !== chatScroll.count;
  chatScroll.sid = sid;
  chatScroll.count = count;
  // Only the newest page holds the message that just arrived. A reader parked
  // on an older page, or reading search results, has nothing to follow to.
  var follows = grew && chatScroll.atEnd && !!view && view.pinned;
  if (!isNewView && !follows) return;
  // After setApp() the new markup is in the DOM but not laid out yet, so the
  // scrollHeight to jump to does not exist until the next frame.
  requestAnimationFrame(function () {
    var el = document.scrollingElement || document.documentElement;
    el.scrollTop = el.scrollHeight;
    chatScroll.atEnd = true;
  });
}

function enterConversation() {
  var pid = state.route.pid;
  var sid = state.route.sid;
  state.chat = null;
  composerDraft.text = '';
  state.activeRun = null;
  state.chatPage = {};
  state.chatSearch = '';
  state.chatSearchPage = 0;
  state.chatUsageOpen = false;
  state.chatMax = false;
  chatScroll = { sid: null, count: -1, atEnd: true };
  resetSessionSnap();
  resetChatTools();
  renderCurrentPage();
  Promise.all([
    state.config ? Promise.resolve() : loadConfig(),
    state.dashboard ? Promise.resolve() : loadDashboard(),
    loadSessions(pid),
    loadChat(pid, sid),
  ]).then(renderCurrentPage);
}

registerView('conversation', { render: renderConversation, enter: enterConversation });
