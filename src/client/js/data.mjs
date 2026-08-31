// Every server read/write, and the state it lands in. These all resolve rather
// than reject: a failed load parks its message in state and the view draws it.

import { api } from './api.mjs';
import { state } from './state.mjs';

export function loadConfig() {
  return api('/api/config').then(function (c) { state.config = c; return c; });
}

export function saveConfig(patch) {
  var next = {
    projects: patch.projects !== undefined ? patch.projects : state.config.projects,
    usageIntervalMinutes: patch.usageIntervalMinutes !== undefined ? patch.usageIntervalMinutes : state.config.usageIntervalMinutes,
    defaults: patch.defaults !== undefined ? patch.defaults : state.config.defaults,
  };
  // projectNames is optional and additive - only sent when the caller built one, so a
  // save that has nothing to do with names does not force the field into existence.
  if (patch.projectNames !== undefined) next.projectNames = patch.projectNames;
  else if (state.config.projectNames !== undefined) next.projectNames = state.config.projectNames;
  return api('/api/config', { method: 'PUT', body: JSON.stringify(next) })
    .then(function (saved) {
      state.config = Object.assign({}, state.config, saved);
      return state.config;
    });
}

/** { required, pinSet, via, idleMinutes } - through api() so the token goes along and `via` comes back. */
export function loadAuthStatus() {
  return api('/api/auth/status').then(function (a) { state.auth = a; return a; }).catch(function () {
    state.auth = null;
  });
}

export function loadUsage() {
  return api('/api/usage').then(function (u) { state.usage = u; }).catch(function (err) {
    state.usage = { ok: false, error: err.message, fetchedAt: 0 };
  });
}

export function loadDashboard() {
  return api('/api/dashboard').then(function (d) { state.dashboard = d; }).catch(function (err) {
    state.error = err.message;
  });
}

/** Stars or unstars one folder. The server answers with the whole dashboard,
 *  already re-sorted, so the strip repaints from the write rather than waiting
 *  for the 30s poll to agree. */
export function setProjectFavorite(pid, favorite) {
  return api('/api/projects/' + encodeURIComponent(pid) + '/favorite', {
    method: 'PUT',
    body: JSON.stringify({ favorite: favorite }),
  }).then(function (d) { state.dashboard = d; return d; });
}

/** Replaces the dashboard group list - create, rename, delete, and drag all go
 *  through this one write. Same contract as the favourite PUT: the server
 *  answers with the whole dashboard, so the page repaints from the response. */
export function saveGroups(groups) {
  return api('/api/groups', {
    method: 'PUT',
    body: JSON.stringify({ groups: groups }),
  }).then(function (d) { state.dashboard = d; return d; });
}

export function loadJobs(pid) {
  return api('/api/projects/' + encodeURIComponent(pid) + '/jobs')
    .then(function (data) { state.jobs[pid] = data; })
    .catch(function (err) { state.error = err.message; });
}

export function loadSessions(pid) {
  return api('/api/projects/' + encodeURIComponent(pid) + '/sessions')
    .then(function (data) { state.sessions[pid] = data; })
    .catch(function (err) { state.error = err.message; });
}

export function loadChat(pid, sid) {
  if (sid === 'new') { state.chat = { sessionId: 'new', messages: [] }; return Promise.resolve(); }
  return api('/api/projects/' + encodeURIComponent(pid) + '/sessions/' + encodeURIComponent(sid))
    .then(function (chat) { state.chat = chat; })
    .catch(function (err) { state.chat = null; state.error = err.message; });
}

// ---- Lookups over what is already loaded ------------------------------------

export function findJob(pid, folder) {
  var j = state.jobs[pid];
  if (!j) return null;
  var all = j.today.concat(j.notStarted, j.others);
  for (var i = 0; i < all.length; i++) {
    if (all[i].folder === folder) return all[i];
  }
  return null;
}

export function projectOf(pid) {
  if (!state.dashboard) return null;
  for (var i = 0; i < state.dashboard.projects.length; i++) {
    if (state.dashboard.projects[i].id === pid) return state.dashboard.projects[i];
  }
  return null;
}
