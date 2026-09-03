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

  setApp(
    '<div class="page-head"><div>' +
      '<h1>' + esc(isNew ? 'New conversation' : (summary ? summary.title : shortId(sid))) + '</h1>' +
      '<p class="mono">' + esc(project ? project.path : '') + (isNew ? '' : ' · ' + esc(shortId(sid))) + '</p></div>' +
      '<a class="btn btn-secondary" href="#/p/' + esc(pid) + '"><svg class="icon"><use href="#i-back"/></svg> ' + esc(project ? project.name : 'Project') + '</a>' +
    '</div>' +
    '<div class="conv-layout">' +
      '<div class="conv-list">' + sessionsCardHtml(pid, sid) + '</div>' +
      '<div class="col gap-4">' + tools + body + composerHtml(isNew ? null : sid) + '</div>' +
    '</div>'
  );
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
