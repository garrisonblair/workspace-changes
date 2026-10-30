'use strict';
// "Go to File in Shown Repositories": a Cmd+P-style picker limited to the repos currently shown in
// the Workspace Changes panel. Ranking is VS Code's own Quick Open scorer (src/fuzzyScorer.js);
// icons come from the active file icon theme (QuickPickItem.resourceUri + ThemeIcon.File).
const vscode = require('vscode');
const path = require('path');
const FS = require('./fuzzyScorer');
const FI = require('./fileIndex');
const { FileIconImages } = require('./fileIconImages');

const MAX_RESULTS = 200;
const MAX_HISTORY = 50;
const HISTORY_KEY = 'workspaceChanges.quickOpen.history';

const accessor = {
  getItemLabel: (e) => e.label,
  getItemDescription: (e) => e.description,
  getItemPath: (e) => e.fsPath,
};

/**
 * Necessary condition for a fuzzy match: every query piece's characters appear in order in
 * "description/label" (case-insensitive, / and \\ equal). Lets us skip most files cheaply.
 */
function couldMatch(e, pieces) {
  const hay = e._hay || (e._hay = `${e.description}/${e.label}`.toLowerCase().replace(/\\/g, '/'));
  for (const p of pieces) {
    let i = 0;
    for (let j = 0; j < hay.length && i < p.length; j++) if (hay.charCodeAt(j) === p.charCodeAt(i)) i++;
    if (i < p.length) return false;
  }
  return true;
}

/**
 * Rank entries for a query exactly like Cmd+P (VS Code's scoreItemFuzzy + compareItemsByFuzzyScore).
 * Pure (no vscode), exported for tests. Returns all matches when limit is Infinity, best first.
 */
function rank(entries, query, limit = MAX_RESULTS) {
  return search(entries, query, limit).top;
}

/**
 * Matches for a query: `all` (unsorted, for narrowing as the user keeps typing),
 * `top` (best `limit`, sorted like Cmd+P) and `sort` (sorts any subset the same way).
 */
function search(entries, query, limit = MAX_RESULTS) {
  const prepared = FS.prepareQuery(query);
  if (!prepared.normalized) return { all: [], top: [], sort: (x) => x };
  const pieces = (prepared.values || [prepared]).map((v) => v.normalizedLowercase.replace(/\\/g, '/'));
  const cache = new Map();
  const matches = [];
  for (const e of entries) {
    if (!couldMatch(e, pieces)) continue;
    if (FS.scoreItemFuzzy(e, prepared, true, accessor, cache).score > 0) matches.push(e);
  }
  const cmp = (a, b) => FS.compareItemsByFuzzyScore(a, b, prepared, true, accessor, cache);
  const top = matches.length <= limit ? matches.slice().sort(cmp) : topK(matches, limit, cmp);
  return { all: matches, top, sort: (subset) => subset.slice().sort(cmp) };
}

/** The k smallest items under cmp, sorted (binary-insertion into a bounded list). */
function topK(items, k, cmp) {
  const best = [];
  for (const it of items) {
    if (best.length === k && cmp(it, best[k - 1]) >= 0) continue;
    let lo = 0;
    let hi = best.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(it, best[mid]) < 0) hi = mid; else lo = mid + 1; }
    best.splice(lo, 0, it);
    if (best.length > k) best.pop();
  }
  return best;
}

class QuickOpen {
  /**
   * @param view   WorkspaceChangesView (for the list of shown repos)
   * @param api    Git extension API (git path, repository change events)
   */
  constructor(context, view, api) {
    this.context = context;
    this.view = view;
    this.api = api;
    this.cache = new Map(); // root -> { entries, stale, promise }
    this.icons = new FileIconImages(context, view);
    this.subs = new Map();
    for (const r of api.repositories) this.watch(r);
    context.subscriptions.push(
      api.onDidOpenRepository((r) => this.watch(r)),
      api.onDidCloseRepository((r) => this.forget(r.rootUri.fsPath)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude')) this.invalidateAll();
      }),
      vscode.workspace.onDidCreateFiles(() => this.invalidateAll()),
      vscode.workspace.onDidDeleteFiles(() => this.invalidateAll()),
      vscode.workspace.onDidRenameFiles(() => this.invalidateAll()),
      vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed) this.remember(ed.document.uri); }),
      { dispose: () => { for (const d of this.subs.values()) d.dispose(); } },
    );
    if (vscode.window.activeTextEditor) this.remember(vscode.window.activeTextEditor.document.uri);
  }

  // --- file lists -------------------------------------------------------------

  watch(repo) {
    const root = repo.rootUri.fsPath;
    if (this.subs.has(root)) return;
    // git status refreshes after file changes on disk, so this also catches new / deleted files
    this.subs.set(root, repo.state.onDidChange(() => { const c = this.cache.get(root); if (c) c.stale = true; }));
  }

  forget(root) {
    const d = this.subs.get(root);
    if (d) d.dispose();
    this.subs.delete(root);
    this.cache.delete(root);
  }

  invalidateAll() { for (const c of this.cache.values()) c.stale = true; }

  /** Entries for one shown repo (cached; rebuilt in the background when stale). */
  entriesFor(entry) {
    const root = entry.repo.rootUri.fsPath;
    let c = this.cache.get(root);
    if (c && !c.stale && c.label === entry.label) return c.promise;
    const promise = (async () => {
      const files = await FI.listRepoFiles(this.api.git && this.api.git.path, root);
      const folder = vscode.workspace.getWorkspaceFolder(entry.repo.rootUri);
      const folderPrefix = folder ? path.relative(folder.uri.fsPath, root).split(path.sep).join('/') : '';
      const scope = folder ? folder.uri : entry.repo.rootUri;
      const isExcluded = FI.excludeMatcher(
        vscode.workspace.getConfiguration('files', scope).get('exclude', {}),
        vscode.workspace.getConfiguration('search', scope).get('exclude', {}),
      );
      return FI.buildEntries(root, entry.label, files, folderPrefix, isExcluded);
    })();
    c = { promise, stale: false, label: entry.label };
    this.cache.set(root, c);
    promise.catch(() => this.cache.delete(root));
    return promise;
  }

  // --- recently opened ------------------------------------------------------------

  get history() { return this.context.workspaceState.get(HISTORY_KEY, []); }

  remember(uri) {
    if (!uri || uri.scheme !== 'file') return;
    const h = this.history.filter((p) => p !== uri.fsPath);
    h.unshift(uri.fsPath);
    this.context.workspaceState.update(HISTORY_KEY, h.slice(0, MAX_HISTORY));
  }

  // --- the picker -----------------------------------------------------------------

  toItem(e, buttons) {
    return {
      label: e.label,
      description: e.description,
      resourceUri: vscode.Uri.file(e.fsPath),
      // image from the active file icon theme (works on hosts that don't derive icons from resourceUri)
      iconPath: this.icons.iconFor(vscode.Uri.file(e.fsPath)),
      alwaysShow: true, // we filter and rank; Quick Pick only highlights
      buttons,
      entry: e,
    };
  }

  async show() {
    const shown = (await this.view.evaluate()).filter((r) => r.visible);
    if (!shown.length) {
      const pick = await vscode.window.showInformationMessage('No repositories are shown in Workspace Changes.', 'Search All Files');
      if (pick) vscode.commands.executeCommand('workbench.action.quickOpen');
      return;
    }

    const qp = vscode.window.createQuickPick();
    const n = shown.length;
    qp.placeholder = `Search files by name in ${n} shown ${n === 1 ? 'repository' : 'repositories'} (append : to go to line)`;
    qp.matchOnDescription = true;
    qp.busy = true;
    const sideButton = { iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open to the Side' };

    let entries = [];
    let byPath = new Map();
    let lastQuery = null;
    let lastMatches = null;

    const update = () => {
      const { query } = FI.parseLineSuffix(qp.value);
      const history = this.history.filter((p) => byPath.has(p)).map((p) => byPath.get(p));
      if (!FS.prepareQuery(query).normalized) {
        lastQuery = null;
        lastMatches = null;
        qp.items = history.length
          ? [{ label: 'recently opened', kind: vscode.QuickPickItemKind.Separator }, ...history.map((e) => this.toItem(e, [sideButton]))]
          : [];
        return;
      }
      // typing more of the same word can only narrow the matches: rescore just those
      const extends_ = lastQuery !== null && lastMatches && query.startsWith(lastQuery) && !/[\s"]/.test(query);
      const pool = extends_ ? lastMatches : entries;
      const recent = new Set(history);
      const result = search(pool, query, MAX_RESULTS + recent.size);
      lastQuery = query;
      lastMatches = result.all;
      // like Cmd+P: matching recently opened files first, then the other results
      const recentHits = result.sort(result.all.filter((e) => recent.has(e)));
      const others = result.top.filter((e) => !recent.has(e));
      const items = [];
      if (recentHits.length) items.push({ label: 'recently opened', kind: vscode.QuickPickItemKind.Separator }, ...recentHits.map((e) => this.toItem(e, [sideButton])));
      if (others.length) items.push({ label: 'file results', kind: vscode.QuickPickItemKind.Separator }, ...others.slice(0, MAX_RESULTS).map((e) => this.toItem(e, [sideButton])));
      qp.items = items;
    };

    const open = async (item, sideBySide) => {
      if (!item || !item.entry) return;
      const { line, column } = FI.parseLineSuffix(qp.value);
      const opts = { preview: !sideBySide };
      if (sideBySide) opts.viewColumn = vscode.ViewColumn.Beside;
      if (line) {
        const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, (column || 1) - 1));
        opts.selection = new vscode.Range(pos, pos);
      }
      const uri = vscode.Uri.file(item.entry.fsPath);
      this.remember(uri);
      await vscode.commands.executeCommand('vscode.open', uri, opts);
    };

    qp.onDidChangeValue(update);
    qp.onDidAccept(() => { const item = qp.activeItems[0]; qp.hide(); return open(item, false); });
    qp.onDidTriggerItemButton((e) => open(e.item, true));
    qp.onDidHide(() => qp.dispose());
    qp.show();

    try {
      const lists = await Promise.all(shown.map((s) => this.entriesFor(s).catch(() => [])));
      entries = lists.flat();
      byPath = new Map(entries.map((e) => [e.fsPath, e]));
    } finally {
      qp.busy = false;
    }
    update();
    return qp;
  }
}

module.exports = { QuickOpen, rank, search, topK };
