'use strict';
const vscode = require('vscode');
const path = require('path');
const cp = require('child_process');
const F = require('./filter');
const IT = require('./iconTheme');
const PR = require('./pullRequest');
const GM = require('./gitMenu');
const { QuickOpen } = require('./quickOpen');

const VIEW_ID = 'workspaceChanges.view';
const CFG = 'workspaceChanges';
const TEXT_FILTER_KEY = 'workspaceChanges.textFilter';
const MAX_FILES_PER_GROUP = 500;

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

async function getGitApi() {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) throw new Error('The built-in Git extension is not available.');
  const exports = ext.isActive ? ext.exports : await ext.activate();
  const api = exports.getAPI(1);
  if (api.state !== 'initialized') {
    await new Promise((resolve) => {
      const d = api.onDidChangeState((s) => { if (s === 'initialized') { d.dispose(); resolve(); } });
    });
  }
  return api;
}

function execGit(gitPath, cwd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(gitPath || 'git', args, { cwd, timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout).trim());
    });
  });
}

/** Read the remote default branch from refs/remotes/<remote>/HEAD. */
async function detectDefaultBranch(gitPath, repo) {
  const remotes = (repo.state.remotes || []).map((r) => r.name);
  const ordered = remotes.includes('origin') ? ['origin', ...remotes.filter((r) => r !== 'origin')] : remotes;
  for (const remote of ordered) {
    try {
      const ref = await execGit(gitPath, repo.rootUri.fsPath, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
      if (ref) return ref.slice(remote.length + 1);
    } catch (_) { /* not set for this remote */ }
  }
  return undefined;
}

const GROUPS = [
  { key: 'merge', label: 'Merge Changes' },
  { key: 'index', label: 'Staged Changes' },
  { key: 'working', label: 'Changes' },
];

function statusClass(status) {
  const S = F.Status;
  if (status >= S.ADDED_BY_US) return 'conflict';
  switch (status) {
    case S.INDEX_ADDED: case S.INTENT_TO_ADD: return 'added';
    case S.UNTRACKED: return 'untracked';
    case S.INDEX_DELETED: case S.DELETED: return 'deleted';
    case S.INDEX_RENAMED: case S.INTENT_TO_RENAME: case S.INDEX_COPIED: return 'renamed';
    case S.IGNORED: return 'ignored';
    default: return 'modified';
  }
}

function nonce() {
  let s = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += c.charAt(Math.floor(Math.random() * c.length));
  return s;
}

async function showError(prefix, err) {
  const msg = (err && (err.stderr || err.message)) || String(err);
  const pick = await vscode.window.showErrorMessage(`${prefix}: ${String(msg).trim()}`, 'Show Command Output');
  if (pick) vscode.commands.executeCommand('git.showOutput');
}

/** Run one of the Git extension's own commands for a repository (same code path as the native buttons). */
function git(command, repo, ...args) {
  return vscode.commands.executeCommand(command, repo.rootUri, ...args);
}

// ---------------------------------------------------------------------------
// the view
// ---------------------------------------------------------------------------

class WorkspaceChangesView {
  constructor(context, api) {
    this.context = context;
    this.api = api;
    this.defaultBranchCache = new Map(); // root -> Promise<string|undefined>
    this.repoSubs = new Map(); // root -> Disposable
    this.showAll = false;
    this.view = undefined;
    this.lastEvaluation = [];
    this._timer = undefined;
    this._onDidRender = new vscode.EventEmitter();
    this.onDidRender = this._onDidRender.event; // for tests
    this.loadIcons();

    for (const repo of api.repositories) this.watch(repo);
    context.subscriptions.push(
      api.onDidOpenRepository((r) => { this.watch(r); this.refreshSoon(); }),
      api.onDidCloseRepository((r) => { this.unwatch(r); this.refreshSoon(); }),
      { dispose: () => { for (const d of this.repoSubs.values()) d.dispose(); this.repoSubs.clear(); } },
    );
  }

  // --- icons -------------------------------------------------------------

  /** Load the active file icon theme + language associations, exactly as the workbench resolves them. */
  loadIcons() {
    const all = vscode.extensions.all;
    const themeId = vscode.workspace.getConfiguration('workbench').get('iconTheme', 'vs-seti');
    this.languages = new IT.LanguageRegistry(all, vscode.workspace.getConfiguration('files').get('associations', {}));
    this.iconTheme = IT.loadIconTheme(all, themeId);
  }

  /** Reload icons and, if the view is open, rebuild the page (fonts / roots may have changed). */
  reloadIcons() {
    this.loadIcons();
    if (this.view) {
      this.configureWebview(this.view.webview);
    }
  }

  languageOf(uri) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc && doc.languageId && doc.languageId !== 'plaintext') return doc.languageId;
    return this.languages.languageFor(uri.fsPath);
  }

  localResourceRoots() {
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'media')];
    if (this.iconTheme && this.iconTheme.doc) roots.push(vscode.Uri.file(this.iconTheme.extensionPath));
    const seen = new Set();
    for (const ic of this.languages.icons.values()) {
      for (const p of [path.dirname(ic.light), path.dirname(ic.dark)]) {
        if (!seen.has(p)) { seen.add(p); roots.push(vscode.Uri.file(p)); }
      }
    }
    return roots;
  }

  iconCss(webview) {
    const t = this.iconTheme;
    if (!t || !t.doc) return '';
    const toUrl = (abs) => webview.asWebviewUri(vscode.Uri.file(abs)).toString();
    const languageIcons = [...this.languages.icons.entries()].map(([id, ic]) => ({ id, light: toUrl(ic.light), dark: toUrl(ic.dark) }));
    return IT.buildIconThemeCss(t.doc, (rel) => toUrl(path.join(t.dir, rel)), languageIcons);
  }

  // --- state -------------------------------------------------------------

  get config() { return vscode.workspace.getConfiguration(CFG); }
  get criteria() { return this.config.get('criteria', ['changes', 'nonDefaultBranch']); }
  get textFilter() { return this.context.workspaceState.get(TEXT_FILTER_KEY, ''); }

  async setTextFilter(value) {
    await this.context.workspaceState.update(TEXT_FILTER_KEY, value || '');
    vscode.commands.executeCommand('setContext', 'workspaceChanges.textFilterActive', !!value);
    return this.refresh();
  }

  setShowAll(value) {
    this.showAll = value;
    vscode.commands.executeCommand('setContext', 'workspaceChanges.showAll', value);
    return this.refresh();
  }

  watch(repo) {
    const root = repo.rootUri.fsPath;
    if (this.repoSubs.has(root)) return;
    this.repoSubs.set(root, repo.state.onDidChange(() => this.refreshSoon()));
  }

  unwatch(repo) {
    const root = repo.rootUri.fsPath;
    const d = this.repoSubs.get(root);
    if (d) d.dispose();
    this.repoSubs.delete(root);
    this.defaultBranchCache.delete(root);
  }

  defaultBranch(repo) {
    const root = repo.rootUri.fsPath;
    if (!this.defaultBranchCache.has(root)) {
      const gitPath = this.api.git && this.api.git.path;
      this.defaultBranchCache.set(root, detectDefaultBranch(gitPath, repo).catch(() => undefined));
    }
    return this.defaultBranchCache.get(root);
  }

  clearDefaultBranchCache() { this.defaultBranchCache.clear(); }

  setAllCollapsed(collapsed) {
    if (this.view) this.view.webview.postMessage({ type: 'setAllCollapsed', collapsed });
  }

  refreshSoon() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), 150);
  }

  repoName(repo) { return path.basename(repo.rootUri.fsPath); }
  relPath(repo) { return vscode.workspace.asRelativePath(repo.rootUri, false); }

  async factsFor(repo) {
    const fallback = this.config.get('defaultBranchNames', ['main', 'master']);
    return F.repoFacts(repo.state, await this.defaultBranch(repo), fallback);
  }

  /** All repos with facts, flagged visible or not, sorted by label. */
  async evaluate() {
    const hidden = this.config.get('hiddenRepositories', []);
    const text = this.textFilter;
    const all = [];
    for (const repo of this.api.repositories) {
      const name = this.repoName(repo);
      const rel = this.relPath(repo);
      const facts = await this.factsFor(repo);
      const isHid = F.isHidden(hidden, name, rel);
      const visible = this.showAll
        || (!isHid && F.matchesCriteria(facts, this.criteria) && F.matchesText(text, [name, rel, facts.branch]));
      all.push({ kind: 'repo', repo, name, rel, facts, visible, hidden: isHid });
    }
    const counts = {};
    for (const r of all) counts[r.name] = (counts[r.name] || 0) + 1;
    for (const r of all) r.label = counts[r.name] > 1 ? r.rel : r.name;
    all.sort((a, b) => a.label.localeCompare(b.label));
    this.lastEvaluation = all;
    return all;
  }

  entryFor(root) {
    const found = this.lastEvaluation.find((e) => e.repo.rootUri.fsPath === root);
    if (found) return found;
    const repo = this.api.repositories.find((r) => r.rootUri.fsPath === root);
    return repo && { kind: 'repo', repo, name: this.repoName(repo), rel: this.relPath(repo), label: this.repoName(repo), facts: F.repoFacts(repo.state, undefined, []) };
  }

  // --- model sent to the webview ------------------------------------------

  repoModel(entry) {
    const { repo, facts } = entry;
    const groups = F.groupsOf(repo.state);
    const root = repo.rootUri.fsPath;
    const hasRemote = (repo.state.remotes || []).length > 0;
    let primary;
    if (facts.changes > 0) primary = { kind: 'commit', label: 'Commit', enabled: true };
    else if (facts.unpublished && hasRemote) primary = { kind: 'publish', label: 'Publish Branch', enabled: true };
    else if (facts.ahead || facts.behind) {
      let label = 'Sync Changes';
      if (facts.behind) label += ` ${facts.behind}↓`;
      if (facts.ahead) label += ` ${facts.ahead}↑`;
      primary = { kind: 'sync', label, enabled: true };
    } else primary = { kind: 'commit', label: 'Commit', enabled: false };

    return {
      root,
      label: entry.label,
      branch: facts.detached ? (facts.commit || '').slice(0, 8) : facts.branch,
      detached: facts.detached,
      isDefault: facts.isDefault,
      defaultBranch: facts.defaultBranch,
      defaultDetected: facts.defaultDetected,
      ahead: facts.ahead,
      behind: facts.behind,
      unpublished: facts.unpublished,
      hasUpstream: facts.hasUpstream,
      hasRemote,
      canCreatePr: hasRemote && !facts.detached && !facts.isDefault,
      changes: facts.changes,
      staged: groups.index.length,
      inputValue: repo.inputBox ? repo.inputBox.value : '',
      primary,
      groups: GROUPS.filter((g) => groups[g.key].length).map((g) => {
        const all = groups[g.key].slice().sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
        return {
          key: g.key,
          label: g.label,
          count: all.length,
          files: all.slice(0, MAX_FILES_PER_GROUP).map((c) => {
            const [letter, statusText] = F.STATUS_LABEL[c.status] || ['?', 'Changed'];
            const relDir = path.relative(root, path.dirname(c.uri.fsPath)).split(path.sep).join('/');
            return {
              uri: c.uri.toString(),
              name: path.basename(c.uri.fsPath),
              dir: relDir === '.' ? '' : relDir,
              letter,
              statusText,
              cls: statusClass(c.status),
              untracked: c.status === F.Status.UNTRACKED,
              iconClasses: IT.getIconClasses(c.uri.path || c.uri.fsPath, this.languageOf(c.uri)).join(' '),
            };
          }),
        };
      }),
    };
  }

  async buildModel() {
    const all = await this.evaluate();
    const visible = all.filter((r) => r.visible);
    return {
      mac: process.platform === 'darwin',
      total: all.length,
      showAll: this.showAll,
      textFilter: this.textFilter,
      fileIcons: !!(this.iconTheme && this.iconTheme.doc),
      repos: visible.map((e) => this.repoModel(e)),
    };
  }

  async refresh() {
    const model = await this.buildModel();
    this.updateChrome(model);
    if (this.view) this.view.webview.postMessage({ type: 'render', model });
    this._onDidRender.fire(model);
    return model;
  }

  updateChrome(model) {
    if (!this.view) return;
    const parts = [];
    if (model.showAll) parts.push(`all ${model.total}`);
    else {
      parts.push(`${model.repos.length}/${model.total}`);
      if (model.textFilter) parts.push(`“${model.textFilter}”`);
    }
    this.view.description = parts.join(' · ');
    const changes = model.repos.reduce((n, r) => n + r.changes, 0);
    this.view.badge = changes > 0 ? { value: changes, tooltip: `${changes} changes in ${model.repos.length} repositories` } : undefined;
  }

  // --- WebviewViewProvider ------------------------------------------------

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.configureWebview(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => showError('Workspace Changes', e)));
    webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this.refresh(); });
    webviewView.onDidDispose(() => { if (this.view === webviewView) this.view = undefined; });
  }

  configureWebview(webview) {
    webview.options = { enableScripts: true, localResourceRoots: this.localResourceRoots() };
    webview.html = this.html(webview);
  }

  html(webview) {
    const n = nonce();
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'));
    const icons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicons.js'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'));
    const src = webview.cspSource;
    const themeCss = this.iconCss(webview).replace(/<\/style/gi, '<\\/style');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${src} 'nonce-${n}'; font-src ${src}; img-src ${src} data:; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<style nonce="${n}" id="file-icon-theme">${themeCss}</style></head>
<body><div id="app" class="loading">Loading repositories…</div>
<script nonce="${n}" src="${icons}"></script>
<script nonce="${n}" src="${js}"></script></body></html>`;
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': return this.refresh();
      case 'collapseState': return vscode.commands.executeCommand('setContext', 'workspaceChanges.allCollapsed', !!m.allCollapsed);
      case 'command': return vscode.commands.executeCommand(m.id);
      case 'input': {
        const e = this.entryFor(m.root);
        if (e && e.repo.inputBox) e.repo.inputBox.value = m.value;
        return;
      }
      case 'commit': return this.commitFromView(m.root, m.value, m.mode || 'commit');
      case 'primary': {
        const e = this.entryFor(m.root);
        if (!e) return;
        const kind = this.repoModel(e).primary.kind;
        if (kind === 'publish') return actions.publish(e);
        if (kind === 'sync') return actions.sync(e);
        return this.commitFromView(m.root, m.value, 'commit');
      }
      case 'repoAction': {
        const e = this.entryFor(m.root);
        if (!e) return;
        if (actions[m.action]) return actions[m.action](e);
        return;
      }
      case 'groupAction': case 'fileAction': {
        const node = this.resolveNode({ webviewSection: m.type === 'fileAction' ? 'file' : 'group', root: m.root, group: m.group, uri: m.uri });
        if (!node) return;
        const fn = { open: 'openChange', openFile: 'openFile', stage: 'stage', unstage: 'unstage', discard: 'discard' }[m.action];
        if (fn) return vscode.commands.executeCommand(`workspaceChanges.${fn}`, node);
        return;
      }
      default: return;
    }
  }

  /** Turn a webview context / message payload into a node the commands understand. */
  resolveNode(arg) {
    if (!arg || !arg.webviewSection) return arg;
    const entry = this.entryFor(arg.root);
    if (!entry) return undefined;
    // 'repo' (header / … menu) and 'commit' (Commit button dropdown) both mean "this repository"
    if (arg.webviewSection !== 'group' && arg.webviewSection !== 'file') return entry;
    const groups = F.groupsOf(entry.repo.state);
    const changes = groups[arg.group] || [];
    if (arg.webviewSection === 'group') return { kind: 'group', repo: entry.repo, group: arg.group, changes };
    const change = changes.find((c) => c.uri.toString() === arg.uri);
    return change && { kind: 'file', repo: entry.repo, group: arg.group, change };
  }

  async commitFromView(root, message, mode) {
    const e = this.entryFor(root);
    if (!e) return false;
    const ok = await doCommit(e, message, mode);
    if (ok && this.view) this.view.webview.postMessage({ type: 'committed', root });
    return ok;
  }



}

// ---------------------------------------------------------------------------
// repo actions: all delegate to the Git extension's own commands, so behavior
// (commit hooks, save-before-commit, smart commit, branch protection, auth,
// publish prompts, post-commit push/sync, error dialogs) is identical to native.
// ---------------------------------------------------------------------------

/**
 * Commit through `git.commit` / `git.commitAmend`. The native command reads the message
 * from the repository's input box, so we put the message there first.
 * Returns true when HEAD moved (a commit was created).
 */
async function doCommit(entry, message, mode = 'commit') {
  const { repo } = entry;
  const before = repo.state.HEAD && repo.state.HEAD.commit;
  if (repo.inputBox && typeof message === 'string') repo.inputBox.value = message;
  // git.commit's 2nd argument is the post-commit *command id* (see postCommitCommands.ts executePostCommitCommand)
  if (mode === 'amend') await git('git.commitAmend', repo);
  else if (mode === 'push') await git('git.commit', repo, 'git.push');
  else if (mode === 'sync') await git('git.commit', repo, 'git.sync');
  else await git('git.commit', repo);
  const after = repo.state.HEAD && repo.state.HEAD.commit;
  return !!after && after !== before;
}

const actions = {
  stageAll: (e) => git('git.stageAll', e.repo),
  unstageAll: (e) => git('git.unstageAll', e.repo),
  push: (e) => (e.repo.state.HEAD && !e.repo.state.HEAD.upstream && e.repo.state.HEAD.name ? git('git.publish', e.repo) : git('git.push', e.repo)),
  pull: (e) => git('git.pull', e.repo),
  sync: (e) => (e.repo.state.HEAD && !e.repo.state.HEAD.upstream && e.repo.state.HEAD.name ? git('git.publish', e.repo) : git('git.sync', e.repo)),
  publish: (e) => git('git.publish', e.repo),
  checkoutBranch: (e) => git('git.checkout', e.repo),
  checkoutDefault(e) {
    const target = e.facts.defaultBranch;
    if (!target) { vscode.window.showWarningMessage('Could not determine the default branch.'); return; }
    return git('git.checkout', e.repo, target);
  },
  async createPr(e) {
    const head = e.repo.state.HEAD || {};
    const branch = head.name;
    if (!branch) { vscode.window.showWarningMessage('Check out a branch to create a pull request.'); return; }
    const remotes = e.repo.state.remotes || [];
    const remote = remotes.find((r) => r.name === (head.upstream && head.upstream.remote)) || remotes.find((r) => r.name === 'origin') || remotes[0];
    if (!remote) { vscode.window.showWarningMessage(`${e.label} has no remote.`); return; }
    const remoteUrl = remote.fetchUrl || remote.pushUrl || '';
    const host = PR.parseRemote(remoteUrl);
    const mode = vscode.workspace.getConfiguration(CFG).get('createPullRequest', 'auto');

    // GitHub Pull Requests extension: opens its "Create Pull Request" view for this repo, like its SCM button.
    if (mode !== 'browser' && host && host.kind === 'github') {
      const cmds = await vscode.commands.getCommands(true);
      if (cmds.includes('pr.create')) return vscode.commands.executeCommand('pr.create', { repoPath: e.repo.rootUri.fsPath, compareBranch: branch });
    }
    if (!head.upstream) {
      const ok = await vscode.window.showInformationMessage(`The branch '${branch}' has not been published yet. Publish it to create a pull request?`, { modal: true }, 'Publish Branch');
      if (ok !== 'Publish Branch') return;
      await git('git.publish', e.repo);
      if (!(e.repo.state.HEAD || {}).upstream) return; // publish cancelled / failed
    }
    const url = PR.createPullRequestUrl(remoteUrl, branch, e.facts.defaultBranch);
    if (!url) { vscode.window.showWarningMessage(`Don't know how to open a pull request for ${remoteUrl}.`); return; }
    return vscode.env.openExternal(vscode.Uri.parse(url));
  },
  openTerminal(e) {
    vscode.window.createTerminal({ cwd: e.repo.rootUri.fsPath, name: e.label }).show();
  },
  revealInExplorer(e) {
    return vscode.commands.executeCommand('revealInExplorer', e.repo.rootUri);
  },
};

// ---------------------------------------------------------------------------
// file / group commands
// ---------------------------------------------------------------------------

function filesOf(nodes) {
  const out = [];
  for (const n of nodes) {
    if (!n) continue;
    if (n.kind === 'file') out.push(n);
    else if (n.kind === 'group') for (const c of n.changes) out.push({ kind: 'file', repo: n.repo, group: n.group, change: c });
  }
  return out;
}

function byRepo(files) {
  const map = new Map();
  for (const f of files) {
    const k = f.repo.rootUri.fsPath;
    if (!map.has(k)) map.set(k, { repo: f.repo, files: [] });
    map.get(k).files.push(f);
  }
  return [...map.values()];
}

async function openChange(api, node) {
  const { change, group } = node;
  const uri = change.uri;
  const original = change.originalUri || uri;
  const name = path.basename(uri.fsPath);
  const S = F.Status;
  try {
    if (group === 'merge' || change.status === S.UNTRACKED || change.status === S.INTENT_TO_ADD) {
      return await vscode.commands.executeCommand('vscode.open', uri);
    }
    if (group === 'index') {
      if (change.status === S.INDEX_ADDED || change.status === S.INDEX_COPIED) {
        return await vscode.commands.executeCommand('vscode.open', api.toGitUri(uri, ''));
      }
      if (change.status === S.INDEX_DELETED) {
        return await vscode.commands.executeCommand('vscode.open', api.toGitUri(original, 'HEAD'));
      }
      return await vscode.commands.executeCommand('vscode.diff', api.toGitUri(original, 'HEAD'), api.toGitUri(uri, ''), `${name} (Index)`);
    }
    if (change.status === S.DELETED) {
      return await vscode.commands.executeCommand('vscode.open', api.toGitUri(original, '~'));
    }
    return await vscode.commands.executeCommand('vscode.diff', api.toGitUri(original, '~'), uri, `${name} (Working Tree)`);
  } catch (err) {
    return vscode.commands.executeCommand('vscode.open', uri);
  }
}

async function pickRepo(view, node) {
  node = view.resolveNode(node);
  if (node && node.repo) return node.kind === 'repo' ? node : view.entryFor(node.repo.rootUri.fsPath);
  const all = view.lastEvaluation.length ? view.lastEvaluation : await view.evaluate();
  const pick = await vscode.window.showQuickPick(
    all.filter((r) => r.visible).map((r) => ({ label: r.label, description: F.branchLabel(r.facts), r })),
    { placeHolder: 'Select a repository' });
  return pick && pick.r;
}

function registerCommands(context, view, api) {
  const cfgTarget = () => (vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders || []).length)
    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`workspaceChanges.${id}`, fn));
  const nodes = (arg) => [view.resolveNode(arg)].filter(Boolean);

  // --- filters -------------------------------------------------------------

  reg('chooseCriteria', async () => {
    const qp = vscode.window.createQuickPick();
    qp.canSelectMany = true;
    qp.title = 'Show repositories that…';
    qp.placeholder = 'Repos matching ANY checked rule are shown. Uncheck everything to show all repos.';
    qp.items = F.CRITERIA.map((c) => ({ label: c.label, detail: c.detail, id: c.id }));
    const current = view.criteria;
    qp.selectedItems = qp.items.filter((i) => current.includes(i.id));
    qp.onDidChangeSelection((sel) => view.config.update('criteria', sel.map((s) => s.id), cfgTarget()));
    qp.onDidHide(() => qp.dispose());
    qp.show();
  });

  reg('filterText', async () => {
    const box = vscode.window.createInputBox();
    const before = view.textFilter;
    box.title = 'Filter repositories by name or branch';
    box.prompt = 'Space/comma separated, any term matches. Prefix with ! to exclude (e.g. "api web !legacy"). Enter keeps it, Esc reverts.';
    box.value = before;
    box.placeholder = 'e.g. api, web, !legacy';
    let accepted = false;
    box.onDidChangeValue((v) => view.setTextFilter(v));
    box.onDidAccept(() => { accepted = true; box.hide(); });
    box.onDidHide(() => { if (!accepted) view.setTextFilter(before); box.dispose(); });
    box.show();
  });

  reg('clearTextFilter', () => view.setTextFilter(''));
  reg('commitAndPush', async (arg) => { const e = await pickRepo(view, arg); if (e) return view.commitFromView(e.repo.rootUri.fsPath, undefined, 'push'); });
  reg('commitAndSync', async (arg) => { const e = await pickRepo(view, arg); if (e) return view.commitFromView(e.repo.rootUri.fsPath, undefined, 'sync'); });
  reg('collapseAll', () => view.setAllCollapsed(true));
  reg('expandAll', () => view.setAllCollapsed(false));

  // Repo "…" / right-click menu: run the Git extension's own command for the repo the menu was opened on.
  for (const w of GM.wrappers()) {
    context.subscriptions.push(vscode.commands.registerCommand(w.id, async (arg) => {
      if (w.noRepoArg) return vscode.commands.executeCommand(w.native);
      const e = await pickRepo(view, arg);
      if (e) return vscode.commands.executeCommand(w.native, e.repo.rootUri);
    }));
  }
  reg('showAll', () => view.setShowAll(true));
  reg('applyFilter', () => view.setShowAll(false));
  reg('refresh', () => { view.clearDefaultBranchCache(); view.reloadIcons(); return view.refresh(); });

  reg('hideRepo', async (arg) => {
    const e = await pickRepo(view, arg);
    if (!e) return;
    const list = view.config.get('hiddenRepositories', []);
    const entry = e.rel || e.name;
    if (!list.includes(entry)) await view.config.update('hiddenRepositories', [...list, entry], cfgTarget());
  });

  reg('manageHidden', async () => {
    const list = view.config.get('hiddenRepositories', []);
    if (!list.length) {
      vscode.window.showInformationMessage('No hidden repositories. Use "Always Hide Repository" from a repo\'s … menu, or the workspaceChanges.hiddenRepositories setting (supports * wildcards).');
      return;
    }
    const picks = await vscode.window.showQuickPick(list.map((l) => ({ label: l, picked: true })), {
      canPickMany: true, title: 'Hidden repositories', placeHolder: 'Uncheck the ones you want to show again',
    });
    if (picks) await view.config.update('hiddenRepositories', picks.map((p) => p.label), cfgTarget());
  });

  // --- files ---------------------------------------------------------------

  reg('openChange', (arg) => { const n = view.resolveNode(arg); return n && openChange(api, n); });

  reg('openFile', async (arg) => {
    for (const f of filesOf(nodes(arg))) {
      if (f.change.status === F.Status.DELETED || f.change.status === F.Status.INDEX_DELETED) continue;
      await vscode.commands.executeCommand('vscode.open', f.change.uri, { preview: false });
    }
  });

  reg('stage', async (arg) => {
    for (const { repo, files } of byRepo(filesOf(nodes(arg)))) {
      try { await repo.add(files.map((f) => f.change.uri.fsPath)); } catch (e) { showError('Stage failed', e); }
    }
  });

  reg('unstage', async (arg) => {
    for (const { repo, files } of byRepo(filesOf(nodes(arg)))) {
      try { await repo.revert(files.map((f) => f.change.uri.fsPath)); } catch (e) { showError('Unstage failed', e); }
    }
  });

  reg('discard', async (arg) => {
    const files = filesOf(nodes(arg)).filter((f) => f.group === 'working');
    if (!files.length) return;
    const untracked = files.filter((f) => f.change.status === F.Status.UNTRACKED).length;
    const what = files.length === 1 ? `'${path.basename(files[0].change.uri.fsPath)}'` : `${files.length} files`;
    const detail = untracked ? `${untracked} untracked file${untracked > 1 ? 's' : ''} will be DELETED. ` : '';
    const ok = await vscode.window.showWarningMessage(`Discard changes in ${what}?`,
      { modal: true, detail: detail + 'This is irreversible.' }, 'Discard');
    if (ok !== 'Discard') return;
    for (const { repo, files: fs } of byRepo(files)) {
      try { await repo.clean(fs.map((f) => f.change.uri.fsPath)); } catch (e) { showError('Discard failed', e); }
    }
  });

  // --- repos (context menu / palette) -------------------------------------

  reg('commit', async (arg) => {
    const e = await pickRepo(view, arg);
    if (!e) return;
    // Native flow: uses the repo's message box, or asks for a message if it is empty.
    const ok = await doCommit(e, undefined, 'commit');
    if (ok && view.view) view.view.webview.postMessage({ type: 'committed', root: e.repo.rootUri.fsPath });
  });

  for (const name of ['stageAll', 'unstageAll', 'push', 'pull', 'sync', 'publish', 'checkoutDefault', 'checkoutBranch', 'createPr', 'openTerminal', 'revealInExplorer']) {
    reg(name, async (arg) => { const e = await pickRepo(view, arg); if (e) return actions[name](e); });
  }
}

// ---------------------------------------------------------------------------

async function activate(context) {
  const api = await getGitApi();
  const view = new WorkspaceChangesView(context, api);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, view, {
    webviewOptions: { retainContextWhenHidden: true },
  }));

  vscode.commands.executeCommand('setContext', 'workspaceChanges.showAll', false);
  vscode.commands.executeCommand('setContext', 'workspaceChanges.textFilterActive', !!view.textFilter);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('files.associations')) {
      view.reloadIcons();
    }
    if (e.affectsConfiguration(CFG)) view.refresh();
  }));
  if (vscode.extensions.onDidChange) {
    context.subscriptions.push(vscode.extensions.onDidChange(() => view.reloadIcons()));
  }
  // a file's language can change once it's opened (e.g. language auto-detection), which can change its icon
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((d) => { if (d.uri.scheme === 'file') view.refreshSoon(); }));

  registerCommands(context, view, api);

  const quickOpen = new QuickOpen(context, view, api);
  context.subscriptions.push(vscode.commands.registerCommand('workspaceChanges.quickOpen', () => quickOpen.show()));
  return { view, quickOpen };
}

function deactivate() {}

module.exports = { activate, deactivate, WorkspaceChangesView };
