// The "Branch and Commits" tab: current working-tree changes, a branch
// selector, that branch's commit history, and a before/after compare view
// reached either from a commit's changed files or from a current change.
//
// Everything below is read-only against src/lib/git.mjs's endpoints. Per-pid
// state (which branch is selected, which commit is expanded, cached commit
// lists/files/blobs) lives in state.gitView, never in the DOM - render is a
// pure function of that state, same as the rest of the project page.

import { esc, badge, relativeTime, errorCard } from '../dom.mjs';
import { state } from '../state.mjs';
import { api } from '../api.mjs';
import { renderCurrentPage } from '../render.mjs';

const GIT_STATUS_COLORS = { added: 'success', modified: 'info', deleted: 'danger', renamed: 'warning', new: 'success' };

function gitApiPath(pid, suffix) {
  return '/api/projects/' + encodeURIComponent(pid) + '/git' + suffix;
}

function defaultGitView() {
  return {
    status: null, statusError: null,
    branchInfo: null, branchInfoError: null,
    branch: null,
    commitsByBranch: {},   // branch -> 'loading' | { commits[], hasMore, loadingMore?, loadMoreError?, error? }
    openCommit: null,      // sha of the commit whose file list is expanded, or null
    commitFilesBySha: {},  // sha -> 'loading' | { files[], error? }
    compare: null,         // { key, path, label } or null
    compareCache: {},      // key -> 'loading' | { data } | { error }
  };
}

function ensureGitView(pid) {
  if (!state.gitView[pid]) state.gitView[pid] = defaultGitView();
  return state.gitView[pid];
}

// ---- Fetching ---------------------------------------------------------------

function loadGitStatus(pid) {
  var gv = ensureGitView(pid);
  gv.statusError = null;
  return api(gitApiPath(pid, '/status')).then(function (data) {
    gv.status = data;
  }).catch(function (err) {
    gv.statusError = err.message;
  });
}

function loadCommitsFresh(pid, branch) {
  var gv = ensureGitView(pid);
  gv.commitsByBranch[branch] = 'loading';
  return api(gitApiPath(pid, '/commits?branch=' + encodeURIComponent(branch) + '&skip=0')).then(function (data) {
    gv.commitsByBranch[branch] = { commits: data.commits, hasMore: data.hasMore };
  }).catch(function (err) {
    gv.commitsByBranch[branch] = { commits: [], hasMore: false, error: err.message };
  });
}

function loadGitBranches(pid) {
  var gv = ensureGitView(pid);
  gv.branchInfoError = null;
  return api(gitApiPath(pid, '/branches')).then(function (data) {
    gv.branchInfo = data;
    if (data.isRepo && data.branches.length > 0) {
      if (!gv.branch || data.branches.indexOf(gv.branch) === -1) gv.branch = data.current;
      return loadCommitsFresh(pid, gv.branch);
    }
    return null;
  }).catch(function (err) {
    gv.branchInfoError = err.message;
  });
}

/** Called from project.mjs whenever the git tab is (re)opened: the working
 *  tree status is cheap and volatile, so it always refetches; branches (and,
 *  through them, the current branch's commits) load once and stay cached. */
export function enterGitPane(pid) {
  var gv = ensureGitView(pid);
  loadGitStatus(pid).then(renderCurrentPage);
  if (!gv.branchInfo) loadGitBranches(pid).then(renderCurrentPage);
}

/** Called from project.mjs's Refresh button when the git tab is active: wipes
 *  the whole per-pid cache (branches/commits/files/blobs) and reloads it. */
export function refreshGitPane(pid) {
  state.gitView[pid] = defaultGitView();
  return Promise.all([loadGitStatus(pid), loadGitBranches(pid)]);
}

function selectBranch(pid, branch) {
  var gv = ensureGitView(pid);
  gv.branch = branch;
  gv.openCommit = null;
  gv.compare = null;
  renderCurrentPage();
  if (!gv.commitsByBranch[branch] || gv.commitsByBranch[branch].error) loadCommitsFresh(pid, branch).then(renderCurrentPage);
}

function loadMoreCommits(pid) {
  var gv = ensureGitView(pid);
  var branch = gv.branch;
  var existing = gv.commitsByBranch[branch];
  if (!existing || existing === 'loading' || !existing.hasMore || existing.loadingMore) return;
  existing.loadingMore = true;
  existing.loadMoreError = null;
  renderCurrentPage();
  var skip = existing.commits.length;
  api(gitApiPath(pid, '/commits?branch=' + encodeURIComponent(branch) + '&skip=' + skip)).then(function (data) {
    gv.commitsByBranch[branch] = { commits: existing.commits.concat(data.commits), hasMore: data.hasMore };
  }).catch(function (err) {
    existing.loadingMore = false;
    existing.loadMoreError = err.message;
  }).then(renderCurrentPage);
}

function toggleCommit(pid, sha) {
  var gv = ensureGitView(pid);
  if (gv.openCommit === sha) {
    gv.openCommit = null;
    renderCurrentPage();
    return;
  }
  gv.openCommit = sha;
  var alreadyCached = !!gv.commitFilesBySha[sha];
  if (!alreadyCached) gv.commitFilesBySha[sha] = 'loading';
  renderCurrentPage();
  if (alreadyCached) return;
  api(gitApiPath(pid, '/commits/' + encodeURIComponent(sha) + '/files')).then(function (data) {
    gv.commitFilesBySha[sha] = { files: data.files };
  }).catch(function (err) {
    gv.commitFilesBySha[sha] = { files: [], error: err.message };
  }).then(renderCurrentPage);
}

function openCompareFromCommit(pid, sha, path) {
  var gv = ensureGitView(pid);
  var key = 'c:' + sha + ':' + path;
  gv.compare = { key: key, path: path, label: 'Commit ' + sha.slice(0, 7) };
  if (!gv.compareCache[key]) {
    gv.compareCache[key] = 'loading';
    api(gitApiPath(pid, '/commits/' + encodeURIComponent(sha) + '/file?path=' + encodeURIComponent(path))).then(function (data) {
      gv.compareCache[key] = { data: data };
    }).catch(function (err) {
      gv.compareCache[key] = { error: err.message };
    }).then(renderCurrentPage);
  }
  renderCurrentPage();
}

function currentAreaLabel(area) {
  if (area === 'staged') return 'Staged change - HEAD vs the index.';
  if (area === 'unstaged') return 'Unstaged change - the index vs the file on disk.';
  return 'Untracked file - nothing vs the file on disk.';
}

function openCompareFromCurrent(pid, area, path) {
  var gv = ensureGitView(pid);
  var key = 'w:' + area + ':' + path;
  gv.compare = { key: key, path: path, label: currentAreaLabel(area) };
  if (!gv.compareCache[key]) {
    gv.compareCache[key] = 'loading';
    api(gitApiPath(pid, '/status/file?path=' + encodeURIComponent(path) + '&area=' + encodeURIComponent(area))).then(function (data) {
      gv.compareCache[key] = { data: data };
    }).catch(function (err) {
      gv.compareCache[key] = { error: err.message };
    }).then(renderCurrentPage);
  }
  renderCurrentPage();
}

function closeCompare(pid) {
  var gv = ensureGitView(pid);
  gv.compare = null;
  renderCurrentPage();
}

// ---- Line diff (client-side, capped) -----------------------------------------

const LINE_DIFF_MAX_LINES = 5000;    // per side
const LINE_DIFF_MAX_CELLS = 4000000; // n*m upper bound on the LCS table, so a worst-case pair still falls back instead of freezing the tab

function linesOf(text) {
  if (!text) return [];
  var t = text.replace(/\r\n/g, '\n');
  if (t.charAt(t.length - 1) === '\n') t = t.slice(0, -1);
  return t.split('\n');
}

/** A plain LCS (longest common subsequence) diff over lines: same lines are
 *  marked 'same' in both outputs, a before-only line is 'removed', an
 *  after-only line is 'added'. Returns null (caller falls back to unmarked
 *  panes) once the two sides are too large to diff without hanging the tab. */
function diffLines(beforeLines, afterLines) {
  var n = beforeLines.length, m = afterLines.length;
  if (n > LINE_DIFF_MAX_LINES || m > LINE_DIFF_MAX_LINES || n * m > LINE_DIFF_MAX_CELLS) return null;

  var dp = new Array(n + 1);
  var i, j;
  for (i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (i = 1; i <= n; i++) {
    for (j = 1; j <= m; j++) {
      dp[i][j] = beforeLines[i - 1] === afterLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  var beforeOut = [], afterOut = [];
  i = n; j = m;
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      beforeOut.push({ type: 'same', text: beforeLines[i - 1] });
      afterOut.push({ type: 'same', text: afterLines[j - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      beforeOut.push({ type: 'removed', text: beforeLines[i - 1] });
      i--;
    } else {
      afterOut.push({ type: 'added', text: afterLines[j - 1] });
      j--;
    }
  }
  while (i > 0) beforeOut.push({ type: 'removed', text: beforeLines[--i] });
  while (j > 0) afterOut.push({ type: 'added', text: afterLines[--j] });
  beforeOut.reverse();
  afterOut.reverse();
  return { before: beforeOut, after: afterOut };
}

// ---- Rendering ----------------------------------------------------------------

function gitGroupHtml(title, rows) {
  return '<div class="git-group"><h4 class="git-group__title">' + esc(title) + '</h4><div class="git-file-list">' + rows.join('') + '</div></div>';
}

function currentFileRow(file, area) {
  var label = area === 'untracked' ? 'new' : file.status;
  return '<button type="button" class="git-file-row" data-area="' + esc(area) + '" data-path="' + esc(file.path) + '">' +
    badge(label, GIT_STATUS_COLORS) + '<span class="mono git-file-row__path">' + esc(file.path) + '</span></button>';
}

function currentChangesCardHtml(gv) {
  var head = '<div class="card__head"><div><h3>Current changes</h3><p>Staged changes and changes in the working tree, including untracked files.</p></div></div>';

  if (gv.statusError) return '<div class="card mb-5">' + head + errorCard(gv.statusError) + '</div>';
  if (!gv.status) {
    return '<div class="card mb-5">' + head + '<div class="card__body row gap-2"><span class="spinner" aria-hidden="true"></span><span class="muted fs-sm">Loading…</span></div></div>';
  }

  var s = gv.status;
  var staged = s.staged || [];
  var unstaged = s.unstaged || [];
  var untracked = s.untracked || [];
  var body;
  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    body = '<div class="card__body"><p class="muted">Working tree clean.</p></div>';
  } else {
    var groups = '';
    if (staged.length) groups += gitGroupHtml('Staged changes', staged.map(function (f) { return currentFileRow(f, 'staged'); }));
    var changesRows = unstaged.map(function (f) { return currentFileRow(f, 'unstaged'); })
      .concat(untracked.map(function (p) { return currentFileRow({ path: p }, 'untracked'); }));
    if (changesRows.length) groups += gitGroupHtml('Changes', changesRows);
    body = '<div class="card__body col gap-4">' + groups + '</div>';
  }
  return '<div class="card mb-5">' + head + body + '</div>';
}

function commitFilesHtml(gv, sha) {
  var entry = gv.commitFilesBySha[sha];
  if (entry === undefined || entry === 'loading') {
    return '<div class="row gap-2"><span class="spinner" aria-hidden="true"></span><span class="muted fs-sm">Loading files…</span></div>';
  }
  if (entry.error) return errorCard(entry.error);
  if (entry.files.length === 0) return '<p class="muted">No files changed.</p>';
  return '<div class="git-file-list">' + entry.files.map(function (f) {
    var pathLabel = f.oldPath ? (f.oldPath + ' → ' + f.path) : f.path;
    var counts = (f.additions === null ? '' : '+' + f.additions) + ' ' + (f.deletions === null ? '' : '−' + f.deletions);
    return '<button type="button" class="git-file-row" data-sha="' + esc(sha) + '" data-path="' + esc(f.path) + '">' +
      badge(f.status, GIT_STATUS_COLORS) + '<span class="mono git-file-row__path">' + esc(pathLabel) + '</span>' +
      '<span class="mono fs-xs muted git-file-row__counts">' + esc(counts.trim()) + '</span></button>';
  }).join('') + '</div>';
}

function commitRowHtml(gv, c) {
  var mainRow = '<tr class="git-commit-row" data-sha="' + esc(c.sha) + '" tabindex="0">' +
    '<td class="cell-mono" data-label="Commit">' + esc(c.sha) + '</td>' +
    '<td data-label="Subject">' + esc(c.subject) + '</td>' +
    '<td class="cell-mono" data-label="Author">' + esc(c.author) + '</td>' +
    '<td class="cell-mono" data-label="When">' + esc(relativeTime(Date.parse(c.date))) + '</td>' +
  '</tr>';
  if (gv.openCommit !== c.sha) return mainRow;
  return mainRow + '<tr class="git-commit-detail"><td colspan="4">' + commitFilesHtml(gv, c.sha) + '</td></tr>';
}

function commitsBlockHtml(gv) {
  if (!gv.branch) return '<p class="muted">No branches.</p>';
  var entry = gv.commitsByBranch[gv.branch];
  if (entry === undefined || entry === 'loading') {
    return '<div class="row gap-2"><span class="spinner" aria-hidden="true"></span><span class="muted fs-sm">Loading commits…</span></div>';
  }
  if (entry.error) return errorCard(entry.error);
  if (entry.commits.length === 0) return '<p class="muted">No commits on this branch.</p>';

  var rows = entry.commits.map(function (c) { return commitRowHtml(gv, c); }).join('');
  var loadMoreHtml = '';
  if (entry.hasMore) {
    loadMoreHtml = '<button type="button" class="btn btn-secondary btn-sm" id="gitLoadMoreBtn"' + (entry.loadingMore ? ' disabled' : '') + '>' +
      (entry.loadingMore ? 'Loading…' : 'Load more') + '</button>';
  }
  var loadMoreError = entry.loadMoreError ? errorCard(entry.loadMoreError) : '';
  return '<div class="table-wrap"><table class="table table--stack table--rows-clickable"><colgroup><col style="width:100px"><col><col style="width:160px"><col style="width:130px"></colgroup>' +
    '<thead><tr><th>Commit</th><th>Subject</th><th>Author</th><th>When</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    loadMoreHtml + loadMoreError;
}

function branchesCardHtml(gv) {
  var head = '<div class="card__head"><div><h3>Branches and commits</h3><p>Local branches and their commit history, newest first.</p></div></div>';
  if (gv.branchInfoError) return '<div class="card">' + head + errorCard(gv.branchInfoError) + '</div>';
  if (!gv.branchInfo) {
    return '<div class="card">' + head + '<div class="card__body row gap-2"><span class="spinner" aria-hidden="true"></span><span class="muted fs-sm">Loading…</span></div></div>';
  }

  var bi = gv.branchInfo;
  if (bi.branches.length === 0) return '<div class="card">' + head + '<div class="card__body"><p class="muted">No local branches.</p></div></div>';

  var select = '<select class="select" id="gitBranchSelect" aria-label="Branch">' + bi.branches.map(function (b) {
    var selected = b === gv.branch ? ' selected' : '';
    return '<option value="' + esc(b) + '"' + selected + '>' + esc(b) + (b === bi.current ? ' (current)' : '') + '</option>';
  }).join('') + '</select>';

  return '<div class="card">' + head + '<div class="card__body col gap-4"><div class="row gap-3">' + select + '</div>' + commitsBlockHtml(gv) + '</div></div>';
}

function comparePaneHtml(side, label, rawText, sideLines) {
  var body;
  if (rawText === '') {
    body = '<p class="muted">(empty)</p>';
  } else {
    body = '<div class="compare__code">' + sideLines.map(function (l) {
      var cls = l.type === 'removed' ? ' is-removed' : (l.type === 'added' ? ' is-added' : '');
      return '<div class="compare__line' + cls + '">' + esc(l.text) + '</div>';
    }).join('') + '</div>';
  }
  return '<div class="compare__pane" data-side="' + side + '"><div class="compare__pane-head">' + esc(label) + '</div><div class="compare__pane-body">' + body + '</div></div>';
}

function compareLayoutHtml(before, after) {
  var beforeLines = linesOf(before);
  var afterLines = linesOf(after);
  var beforeSide, afterSide;
  if (before === '' && after === '') {
    beforeSide = []; afterSide = [];
  } else if (before === '') {
    beforeSide = [];
    afterSide = afterLines.map(function (t) { return { type: 'added', text: t }; });
  } else if (after === '') {
    beforeSide = beforeLines.map(function (t) { return { type: 'removed', text: t }; });
    afterSide = [];
  } else {
    var diff = diffLines(beforeLines, afterLines);
    beforeSide = diff ? diff.before : beforeLines.map(function (t) { return { type: 'same', text: t }; });
    afterSide = diff ? diff.after : afterLines.map(function (t) { return { type: 'same', text: t }; });
  }
  return '<div class="compare">' + comparePaneHtml('before', 'Before', before, beforeSide) + comparePaneHtml('after', 'After', after, afterSide) + '</div>';
}

function compareViewHtml(gv) {
  var cmp = gv.compare;
  var entry = gv.compareCache[cmp.key];
  var head = '<div class="card__head"><div><h3 class="mono">' + esc(cmp.path) + '</h3><p>' + esc(cmp.label) + '</p></div>' +
    '<button type="button" class="btn btn-secondary btn-sm" id="gitCompareBackBtn"><svg class="icon icon-sm"><use href="#i-back"/></svg> Back</button></div>';

  var body;
  if (entry === undefined || entry === 'loading') {
    body = '<div class="card__body row gap-2"><span class="spinner" aria-hidden="true"></span><span class="muted fs-sm">Loading…</span></div>';
  } else if (entry.error) {
    body = errorCard(entry.error);
  } else if (entry.data.binary) {
    body = '<div class="card__body"><p class="muted">Binary file — no preview.</p></div>';
  } else if (entry.data.tooLarge) {
    body = '<div class="card__body"><p class="muted">File too large to preview.</p></div>';
  } else {
    body = '<div class="card__body">' + compareLayoutHtml(entry.data.before, entry.data.after) + '</div>';
  }
  return '<div class="card">' + head + body + '</div>';
}

/** The whole tab's content - replaces the placeholder inside #gitPane. */
export function gitPaneHtml(pid) {
  var gv = ensureGitView(pid);
  if (gv.compare) return compareViewHtml(gv);

  var isRepo = gv.branchInfo ? gv.branchInfo.isRepo : (gv.status ? gv.status.isRepo : null);
  if (isRepo === false) {
    return '<div class="card"><div class="card__body"><p class="muted">Not a git repository.</p></div></div>';
  }

  return currentChangesCardHtml(gv) + branchesCardHtml(gv);
}

export function wireGitPane(pid) {
  var pane = document.getElementById('gitPane');
  if (!pane) return;

  var select = document.getElementById('gitBranchSelect');
  if (select) select.addEventListener('change', function () { selectBranch(pid, select.value); });

  var loadMoreBtn = document.getElementById('gitLoadMoreBtn');
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', function () { loadMoreCommits(pid); });

  pane.querySelectorAll('.git-commit-row').forEach(function (row) {
    var open = function (ev) {
      if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.type === 'keydown') ev.preventDefault();
      toggleCommit(pid, row.getAttribute('data-sha'));
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', open);
  });

  pane.querySelectorAll('.git-file-row[data-area]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openCompareFromCurrent(pid, btn.getAttribute('data-area'), btn.getAttribute('data-path'));
    });
  });

  pane.querySelectorAll('.git-file-row[data-sha]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openCompareFromCommit(pid, btn.getAttribute('data-sha'), btn.getAttribute('data-path'));
    });
  });

  var backBtn = document.getElementById('gitCompareBackBtn');
  if (backBtn) backBtn.addEventListener('click', function () { closeCompare(pid); });
}
