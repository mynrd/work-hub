// The view registry.
//
// Each view module registers itself by route name at import time. Everything
// that needs to repaint calls renderCurrentPage() from here, so no component
// has to import the view it happens to be sitting inside - which is what would
// otherwise make dashboard -> job-table -> detail-dialog -> dashboard a cycle.

import { state } from './state.mjs';

export const app = document.getElementById('app');

export function setApp(html) { app.innerHTML = html; }

const views = new Map();

/** `enter` runs once on navigation (fetch + start timers); `render` repaints. */
export function registerView(name, { render, enter }) {
  views.set(name, { render: render, enter: enter });
}

export function renderCurrentPage() {
  var view = views.get(state.route.name);
  if (view) view.render();
}

export function enterCurrentPage() {
  var view = views.get(state.route.name);
  if (view) view.enter();
}
