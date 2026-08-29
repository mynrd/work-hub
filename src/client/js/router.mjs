// Hash router: #/ | #/settings | #/p/<pid> | #/p/<pid>/s/<sid>

import { state, clearTimers } from './state.mjs';
import { enterCurrentPage } from './render.mjs';

export function parseRoute() {
  var hash = (location.hash || '#/').replace(/^#/, '');
  var parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'p' && parts[1]) {
    if (parts[2] === 's' && parts[3]) return { name: 'conversation', pid: parts[1], sid: parts[3] };
    return { name: 'project', pid: parts[1] };
  }
  return { name: 'dashboard' };
}

export function navigate() {
  clearTimers();
  state.route = parseRoute();
  state.error = null;
  enterCurrentPage();
}

export function initRouter() {
  window.addEventListener('hashchange', navigate);
  navigate();
}
