'use strict';
// Test harness: unit tests for filter.js + an end-to-end run of extension.js
// against a fake `vscode` module and a fake git API backed by real git repos.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const Module = require('module');

let passed = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓', name); });

// ---------------------------------------------------------------- unit tests
const F = require('../src/filter');

async function unit() {
  console.log('filter.js');
  const st = (o) => Object.assign({ HEAD: { name: 'main', upstream: { name: 'main', remote: 'origin' }, ahead: 0, behind: 0 }, mergeChanges: [], indexChanges: [], workingTreeChanges: [] }, o);

  await t('clean repo on default is filtered out', () => {
    const f = F.repoFacts(st({}), 'main', ['main']);
    assert.strictEqual(F.matchesCriteria(f, ['changes', 'nonDefaultBranch']), false);
  });
  await t('dirty repo is shown', () => {
    const f = F.repoFacts(st({ workingTreeChanges: [{}] }), 'main', ['main']);
    assert.strictEqual(F.matchesCriteria(f, ['changes']), true);
    assert.strictEqual(f.changes, 1);
  });
  await t('untrackedChanges (separate mode) counted', () => {
    assert.strictEqual(F.changeCount(st({ untrackedChanges: [{}, {}] })), 2);
  });
  await t('non-default branch shown, detected default wins over fallback', () => {
    const s = st({ HEAD: { name: 'master', upstream: {} } });
    assert.strictEqual(F.repoFacts(s, 'main', ['main', 'master']).isDefault, false);
    assert.strictEqual(F.repoFacts(s, undefined, ['main', 'master']).isDefault, true);
  });
  await t('detached HEAD counts as non-default', () => {
    const f = F.repoFacts(st({ HEAD: { commit: 'abc1234def' } }), 'main', ['main']);
    assert.strictEqual(f.isDefault, false);
    assert.match(F.branchLabel(f), /detached @ abc1234/);
  });
  await t('unpushed / behind criteria', () => {
    const ahead = F.repoFacts(st({ HEAD: { name: 'main', upstream: {}, ahead: 2, behind: 0 } }), 'main', []);
    const unpub = F.repoFacts(st({ HEAD: { name: 'feat/x' } }), 'main', []);
    const behind = F.repoFacts(st({ HEAD: { name: 'main', upstream: {}, ahead: 0, behind: 3 } }), 'main', []);
    assert.ok(F.matchesCriteria(ahead, ['unpushed']));
    assert.ok(F.matchesCriteria(unpub, ['unpushed']));
    assert.ok(!F.matchesCriteria(behind, ['unpushed']));
    assert.ok(F.matchesCriteria(behind, ['behind']));
    assert.strictEqual(F.branchLabel(ahead), 'main ↑2');
    assert.strictEqual(F.branchLabel(unpub), 'feat/x (unpublished)');
  });
  await t('empty criteria shows everything', () => {
    assert.ok(F.matchesCriteria(F.repoFacts(st({}), 'main', []), []));
  });
  await t('text filter: OR terms, ! excludes, branch matches', () => {
    assert.ok(F.matchesText('', ['api']));
    assert.ok(F.matchesText('api web', ['web-app']));
    assert.ok(!F.matchesText('api web', ['billing']));
    assert.ok(!F.matchesText('!legacy', ['legacy-api']));
    assert.ok(F.matchesText('!legacy', ['api']));
    assert.ok(F.matchesText('auth', ['api', 'feat/auth']));
    assert.ok(F.matchesText('API, Web', ['api-gateway']));
  });
  await t('hidden globs', () => {
    assert.ok(F.isHidden(['docs'], 'docs', 'docs'));
    assert.ok(F.isHidden(['legacy-*'], 'legacy-billing', 'x'));
    assert.ok(F.isHidden(['tools/*'], 'cli', 'tools/cli'));
    assert.ok(!F.isHidden(['legacy-*'], 'billing', 'billing'));
  });
}

// ---------------------------------------------------------------- icon theme + PR unit tests
const IT = require('../src/iconTheme');
const PR = require('../src/pullRequest');
const FIX = path.join(__dirname, 'fixtures', 'extensions');
const fixtureExtensions = () => fs.readdirSync(FIX).map((d) => ({
  id: `vscode.${d}`, extensionPath: path.join(FIX, d), extensionUri: { fsPath: path.join(FIX, d) },
  packageJSON: JSON.parse(fs.readFileSync(path.join(FIX, d, 'package.json'), 'utf8')),
}));

async function unitIcons() {
  console.log('iconTheme.js (real Seti theme + VS Code built-in languages)');
  const exts = fixtureExtensions();
  const langs = new IT.LanguageRegistry(exts, {});

  await t('language detection like VS Code (extensions, filenames, patterns)', () => {
    const cases = {
      '/r/src/a.ts': 'typescript', '/r/App.tsx': 'typescriptreact', '/r/x.js': 'javascript', '/r/package.json': 'json',
      '/r/tsconfig.json': 'jsonc', '/r/README.md': 'markdown', '/r/Dockerfile': 'dockerfile', '/r/api.Dockerfile': 'dockerfile',
      '/r/compose.yaml': 'dockercompose', '/r/ci.yml': 'yaml', '/r/run.sh': 'shellscript', '/r/.bashrc': 'shellscript',
      '/r/main.py': 'python', '/r/notes.txt': null, '/r/LICENSE': null,
    };
    for (const [p, id] of Object.entries(cases)) assert.strictEqual(langs.languageFor(p), id, p);
  });
  await t('files.associations override built-ins (pattern on name and on path)', () => {
    const l = new IT.LanguageRegistry(exts, { '*.foo': 'yaml', '**/config/*.json': 'jsonc', 'Makefile.local': 'shellscript' });
    assert.strictEqual(l.languageFor('/r/x.foo'), 'yaml');
    assert.strictEqual(l.languageFor('/r/app/config/a.json'), 'jsonc');
    assert.strictEqual(l.languageFor('/r/app/a.json'), 'json');
    assert.strictEqual(l.languageFor('/r/Makefile.local'), 'shellscript');
  });
  await t('getIconClasses matches VS Code', () => {
    assert.deepStrictEqual(IT.getIconClasses('/repo/src/foo.test.ts', 'typescript'),
      ['file-icon', 'src-name-dir-icon', 'foo.test.ts-name-file-icon', 'name-file-icon', 'test.ts-ext-file-icon', 'ts-ext-file-icon', 'ext-file-icon', 'typescript-lang-file-icon']);
    assert.deepStrictEqual(IT.getIconClasses('/Dockerfile', 'dockerfile'),
      ['file-icon', 'dockerfile-name-file-icon', 'name-file-icon', 'ext-file-icon', 'dockerfile-lang-file-icon']);
    assert.ok(IT.getIconClasses('/a/my file.md', null).includes('my/file.md-name-file-icon'), 'whitespace escaped like VS Code');
  });
  await t('loads the active theme by id from installed extensions (JSONC ok)', () => {
    const seti = IT.loadIconTheme(exts, 'vs-seti');
    assert.ok(seti.doc.iconDefinitions._default);
    assert.strictEqual(path.basename(seti.dir), 'icons');
    const svg = IT.loadIconTheme(exts, 'svg-icons');
    assert.ok(svg.doc.iconDefinitions.typescript, 'parsed JSONC with comments + trailing commas');
    assert.strictEqual(IT.loadIconTheme(exts, null), null, 'no icon theme');
    assert.strictEqual(IT.loadIconTheme(exts, 'not-installed'), null);
  });
  await t('Seti → CSS: @font-face, default size, glyph + color rules, light variants', () => {
    const seti = IT.loadIconTheme(exts, 'vs-seti');
    const css = IT.buildIconThemeCss(seti.doc, (rel) => `https://res/${rel.replace('./', '')}`);
    assert.ok(css.includes(`@font-face { src: url('${IT.cssEscape('https://res/seti.woff')}') format('woff'); font-family: 'seti'`), 'font-face');
    assert.match(css, /\.show-file-icons \.file-icon::before \{ font-family: 'seti'; font-size: 150%; \}/);
    assert.match(css, /\.show-file-icons \.typescript-lang-file-icon\.file-icon::before[^{]*\{ color: #[0-9a-f]+; content: '\\E[0-9A-F]+'/i);
    assert.match(css, /\.vscode-light \.show-file-icons \.typescript-lang-file-icon\.file-icon::before/);
    assert.ok(css.split('\n').length > 100);
  });
  await t('SVG theme → CSS: emQuad + background-image, name beats extension beats language', () => {
    const t2 = IT.loadIconTheme(exts, 'svg-icons');
    const css = IT.buildIconThemeCss(t2.doc, (rel) => `https://res/${rel.replace('./', '')}`);
    assert.ok(css.includes(`.show-file-icons .package\\.json-name-file-icon.name-file-icon.json-ext-file-icon.ext-file-icon.file-icon::before { content: '\\2001'; background-image: url('${IT.cssEscape('https://res/icons/nodejs.svg')}');`), 'fileNames rule');
    assert.match(css, /\.test\\\.ts-ext-file-icon\.ts-ext-file-icon\.ext-file-icon\.file-icon::before/);
    assert.ok(css.includes(`.vscode-light .show-file-icons .markdown-lang-file-icon.file-icon::before { content: '\\2001'; background-image: url('${IT.cssEscape('https://res/icons/markdown_light.svg')}');`), 'light rule');
  });
  await t('usesCurrentColor themes render as masks, like VS Code', () => {
    const css = IT.buildIconThemeCss({ usesCurrentColor: true, iconDefinitions: { f: { iconPath: 'f.svg' } }, file: 'f' }, (r) => r);
    assert.match(css, /background-color: currentColor; background-image: none; mask: url\('f\\\.svg'\)/);
  });
  await t('CSS.escape port', () => {
    assert.strictEqual(IT.cssEscape('a.b'), 'a\\.b');
    assert.strictEqual(IT.cssEscape('1x'), '\\31 x');
    assert.strictEqual(IT.cssEscape('c++'), 'c\\+\\+');
    assert.strictEqual(IT.cssEscape('-'), '\\-');
  });

  console.log('pullRequest.js');
  await t('remote parsing + create-PR URLs per host', () => {
    assert.deepStrictEqual(PR.parseRemote('git@github.com:acme/front.git'), { kind: 'github', host: 'github.com', path: 'acme/front' });
    assert.deepStrictEqual(PR.parseRemote('https://user@github.example.com/acme/front'), { kind: 'github', host: 'github.example.com', path: 'acme/front' });
    assert.strictEqual(PR.createPullRequestUrl('git@github.com:acme/front.git', 'feat/x', 'main'), 'https://github.com/acme/front/compare/main...feat/x?expand=1');
    assert.strictEqual(PR.createPullRequestUrl('ssh://git@gitlab.com:2222/grp/sub/app.git', 'feat/x', 'main'),
      'https://gitlab.com/grp/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx&merge_request%5Btarget_branch%5D=main');
    assert.strictEqual(PR.createPullRequestUrl('git@bitbucket.org:team/repo.git', 'fix', 'main'), 'https://bitbucket.org/team/repo/pull-requests/new?source=fix&dest=main');
    assert.strictEqual(PR.createPullRequestUrl('git@ssh.dev.azure.com:v3/org/proj/repo', 'b', 'main'), 'https://dev.azure.com/org/proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main');
    assert.strictEqual(PR.createPullRequestUrl('https://org.visualstudio.com/DefaultCollection/proj/_git/repo', 'b'), 'https://dev.azure.com/org/proj/_git/repo/pullrequestcreate?sourceRef=b');
    assert.strictEqual(PR.createPullRequestUrl('/local/path/repo.git', 'b', 'main'), null);
  });
}

// ---------------------------------------------------------------- fake vscode

class EventEmitter {
  constructor() { this.l = new Set(); this.event = (fn) => { this.l.add(fn); return { dispose: () => this.l.delete(fn) }; }; }
  fire(v) { for (const fn of [...this.l]) fn(v); }
  dispose() { this.l.clear(); }
}
class Uri {
  constructor(fsPath, scheme = 'file', query = '') { this.fsPath = fsPath; this.scheme = scheme; this.query = query; this.path = fsPath.split(path.sep).join('/'); }
  static file(p) { return new Uri(p); }
  static joinPath(u, ...p) { return new Uri(path.join(u.fsPath, ...p)); }
  static parse(s) { const u = new Uri(s, s.split(':')[0]); u.external = s; return u; }
  toString() { return this.external || `${this.scheme}://${this.fsPath}${this.query ? '?' + this.query : ''}`; }
}

function makeVscode(workspaceRoot) {
  const config = { criteria: ['changes', 'nonDefaultBranch'], defaultBranchNames: ['main', 'master'], hiddenRepositories: [], createPullRequest: 'auto' };
  const sections = { workspaceChanges: config, git: {}, workbench: { iconTheme: 'vs-seti' }, files: { associations: {} } };
  const configEmitter = new EventEmitter();
  const commands = new Map();
  const executed = [];
  const context = new Map();
  const ui = { quickPicks: [], inputBoxes: [], errors: [], infos: [], warnings: [], opened: [], progress: [] };
  let provider;

  const vscode = {
    EventEmitter, Uri,
    ThemeIcon: Object.assign(class { constructor(id) { this.id = id; } }, { File: { id: 'file' }, Folder: { id: 'folder' } }),
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    ViewColumn: { Active: -1, Beside: -2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    extensions: { getExtension: () => null, all: fixtureExtensions(), onDidChange: new EventEmitter().event },
    env: { openExternal: async (u) => { ui.opened.push(u.toString()); return true; } },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(workspaceRoot) }],
      getWorkspaceFolder: (u) => ((u.fsPath + path.sep).startsWith(workspaceRoot + path.sep) ? { uri: Uri.file(workspaceRoot) } : undefined),
      onDidCreateFiles: new EventEmitter().event, onDidDeleteFiles: new EventEmitter().event, onDidRenameFiles: new EventEmitter().event,
      textDocuments: [],
      asRelativePath: (u) => path.relative(workspaceRoot, u.fsPath || u),
      getConfiguration: (section) => {
        const store = sections[section || ''] || (sections[section] = {});
        return {
          get: (k, d) => (k in store ? store[k] : d),
          update: async (k, v) => { store[k] = v; configEmitter.fire({ affectsConfiguration: (s) => s === section || s === `${section}.${k}` }); },
        };
      },
      onDidChangeConfiguration: configEmitter.event,
      onDidOpenTextDocument: new EventEmitter().event,
    },
    window: {
      registerWebviewViewProvider: (id, p) => { provider = { id, p }; return { dispose() {} }; },
      activeTextEditor: undefined,
      withProgress: async (opts, fn) => { ui.progress.push(opts); ui.progressActive = (ui.progressActive || 0) + 1; try { return await fn({ report() {} }); } finally { ui.progressActive -= 1; } },
      onDidChangeActiveTextEditor: (() => { const e = new EventEmitter(); ui.fireActiveEditor = (ed) => e.fire(ed); return e.event; })(),
      showErrorMessage: async (m) => { ui.errors.push(m); },
      showInformationMessage: async (m) => { ui.infos.push(m); const r = ui.nextInfo; ui.nextInfo = undefined; return r; },
      showWarningMessage: async (m) => { ui.warnings.push(m); ui.lastWarning = m; const r = ui.nextWarning; ui.nextWarning = undefined; return r; },
      showInputBox: async (o) => { ui.lastInputOpts = o; return ui.nextInput; },
      showQuickPick: async (items) => { ui.lastPickItems = items; return ui.nextPick ? ui.nextPick(items) : undefined; },
      createQuickPick: () => {
        const sel = new EventEmitter(); const hide = new EventEmitter();
        const val = new EventEmitter(); const acc = new EventEmitter(); const btn = new EventEmitter();
        const qp = { items: [], selectedItems: [], activeItems: [], value: '', busy: false, shown: false, disposed: false,
          onDidChangeSelection: sel.event, onDidHide: hide.event, onDidChangeValue: val.event, onDidAccept: acc.event, onDidTriggerItemButton: btn.event,
          show() { qp.shown = true; }, hide() { qp.shown = false; hide.fire(); }, dispose() { qp.disposed = true; },
          _select: (s) => { qp.selectedItems = s; sel.fire(s); },
          _type: (v) => { qp.value = v; val.fire(v); },
          _accept: (item) => { qp.activeItems = [item || qp.items.find((i) => i.kind !== -1)]; acc.fire(); },
          _button: (item) => btn.fire({ item, button: item.buttons[0] }),
          get visibleItems() { return qp.items.filter((i) => i.kind !== -1); } };
        ui.quickPicks.push(qp); return qp;
      },
      createInputBox: () => {
        const ch = new EventEmitter(); const acc = new EventEmitter(); const hide = new EventEmitter();
        const box = { value: '', onDidChangeValue: ch.event, onDidAccept: acc.event, onDidHide: hide.event, show() {}, dispose() {},
          hide() { hide.fire(); }, _type: (v) => { box.value = v; ch.fire(v); }, _accept: () => acc.fire() };
        ui.inputBoxes.push(box); return box;
      },
      createTerminal: (o) => ({ show() { ui.terminal = o; } }),
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      getCommands: async () => [...commands.keys()],
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') { context.set(args[0], args[1]); return; }
        executed.push({ id, args });
        if (commands.has(id)) return commands.get(id)(...args);
      },
    },
  };

  /** Simulate VS Code resolving the webview view. */
  function openView() {
    const posted = [];
    const recv = new EventEmitter();
    const vis = new EventEmitter(); const disp = new EventEmitter();
    const view = {
      visible: true,
      webview: {
        options: {}, html: '', cspSource: 'https://res.test',
        asWebviewUri: (u) => ({ toString: () => `https://res.test${u.fsPath}` }),
        postMessage: async (m) => { posted.push(m); return true; },
        onDidReceiveMessage: recv.event,
      },
      onDidChangeVisibility: vis.event, onDidDispose: disp.event,
    };
    provider.p.resolveWebviewView(view);
    return { view, posted, send: (m) => provider.p.onMessage(m), lastModel: () => [...posted].reverse().find((m) => m.type === 'render').model };
  }

  return { vscode, config, sections, commands, executed, context, ui, openView };
}

/**
 * Stand-in for the built-in Git extension's commands, implemented the way extensions/git does it
 * (checked against microsoft/vscode extensions/git/src/commands.ts + git.ts):
 * message from repository.inputBox, `git commit --quiet --file -` WITHOUT --no-verify (so hooks run),
 * input box cleared on success, error dialog on failure.
 */
function registerFakeGitCommands(fake, api) {
  const repoFor = (uri) => api.repositories.find((r) => r.rootUri.fsPath === (uri && uri.fsPath));
  const reg = (id, fn) => fake.commands.set(id, async (uri, ...rest) => {
    const repo = repoFor(uri);
    if (!repo) throw new Error(`${id}: repository not resolved from ${uri}`);
    try { return await fn(repo, ...rest); } catch (e) { fake.ui.errors.push(`${id}: ${String(e.stderr || e.message).trim()}`); }
  });
  const run = (repo, args, input) => {
    const r = cp.spawnSync('git', args, { cwd: repo.rootUri.fsPath, input, encoding: 'utf8' });
    repo._reload();
    if (r.status !== 0) { const err = new Error(r.stderr || r.stdout); err.stderr = r.stderr || r.stdout; throw err; }
    return r.stdout;
  };
  const commit = async (repo, opts) => {
    let message = repo.inputBox.value;
    if (!message && !opts.amend) { message = fake.ui.nextInput; if (!message) return; }
    const g = F.groupsOf(repo.state);
    if (!g.index.length && !opts.amend) {
      if (!g.working.length) return;
      const smart = fake.sections.git.enableSmartCommit;
      if (!smart) {
        const pick = fake.ui.nextSmartCommit; fake.ui.nextSmartCommit = undefined;
        fake.ui.warnings.push('There are no staged changes to commit.');
        if (!pick) return;
      }
      run(repo, ['add', '-A']);
    }
    const args = ['commit', '--quiet'];
    if (opts.amend && !message) args.push('--amend', '--no-edit');
    else { args.push('--allow-empty-message', '--file', '-'); if (opts.amend) args.push('--amend'); }
    run(repo, args, message);
    repo.inputBox.value = '';
    if (opts.postCommitCommand) {
      if (!fake.commands.has(opts.postCommitCommand)) throw new Error(`command '${opts.postCommitCommand}' not found`);
      await fake.commands.get(opts.postCommitCommand)(repo.rootUri);
    }
  };
  reg('git.commit', (repo, postCommitCommand) => commit(repo, { postCommitCommand }));
  reg('git.commitAmend', (repo) => commit(repo, { amend: true }));
  reg('git.stageAll', (repo) => run(repo, ['add', '-A']));
  reg('git.unstageAll', (repo) => run(repo, ['reset', '-q']));
  reg('git.push', (repo) => run(repo, ['push', '-q']));
  reg('git.pull', (repo) => run(repo, ['pull', '-q']));
  reg('git.sync', (repo) => { run(repo, ['pull', '-q']); run(repo, ['push', '-q']); });
  reg('git.publish', (repo) => run(repo, ['push', '-q', '-u', 'origin', repo.state.HEAD.name]));
  reg('git.checkout', (repo, treeish) => {
    if (!treeish) { treeish = fake.ui.nextBranch; fake.ui.branchPickerShown = true; if (!treeish) return; }
    run(repo, ['checkout', '-q', treeish]);
  });
  reg('git.stash', (repo) => run(repo, ['stash', '-q', '-u']));
  reg('git.stashPopLatest', (repo) => run(repo, ['stash', 'pop', '-q']));
  fake.commands.set('git.showOutput', () => {});
}

// ---------------------------------------------------------------- fake git API over real repos

const sh = (cwd, cmd) => cp.execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function statusOf(xy) {
  const [x, y] = xy;
  const idx = { M: 0, A: 1, D: 2, R: 3, C: 4, T: 0 }[x];
  const wt = { M: 5, D: 6, T: 11 }[y];
  return { idx, wt };
}

function readState(root) {
  const S = F.Status;
  const out = sh(root, 'git status --porcelain=v1 -b');
  const lines = out.split('\n');
  const head = lines.shift();
  const st = { HEAD: {}, indexChanges: [], workingTreeChanges: [], mergeChanges: [], remotes: [] };
  const remotes = sh(root, 'git remote').split('\n').filter(Boolean);
  st.remotes = remotes.map((name) => ({ name, fetchUrl: sh(root, `git remote get-url ${name}`) }));
  let m;
  if ((m = head.match(/^## HEAD \(no branch\)/))) st.HEAD = { commit: sh(root, 'git rev-parse HEAD') };
  else if ((m = head.match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/))) {
    st.HEAD = { name: m[1], commit: cp.spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root }).stdout.toString().trim(), ahead: 0, behind: 0 };
    if (m[2]) st.HEAD.upstream = { name: m[2] };
    if (m[3]) { const a = m[3].match(/ahead (\d+)/); const b = m[3].match(/behind (\d+)/); if (a) st.HEAD.ahead = +a[1]; if (b) st.HEAD.behind = +b[1]; }
  }
  for (const l of lines.filter(Boolean)) {
    const xy = l.slice(0, 2); const file = l.slice(3);
    const uri = Uri.file(path.join(root, file));
    if (xy === '??') { st.workingTreeChanges.push({ uri, status: S.UNTRACKED }); continue; }
    if (/U|AA|DD/.test(xy)) { st.mergeChanges.push({ uri, status: S.BOTH_MODIFIED }); continue; }
    const { idx, wt } = statusOf(xy);
    if (idx !== undefined) st.indexChanges.push({ uri, status: idx });
    if (wt !== undefined) st.workingTreeChanges.push({ uri, status: wt });
  }
  return st;
}

function makeRepo(root) {
  const em = new EventEmitter();
  const repo = {
    rootUri: Uri.file(root),
    state: Object.assign(readState(root), { onDidChange: em.event }),
    inputBox: { value: '' },
    _reload() { Object.assign(repo.state, readState(root)); em.fire(); },
    add: async (paths) => { sh(root, `git add -- ${paths.map((p) => JSON.stringify(p)).join(' ')}`); repo._reload(); },
    revert: async (paths) => { sh(root, `git reset -q -- ${paths.map((p) => JSON.stringify(p)).join(' ')}`); repo._reload(); },
    clean: async (paths) => {
      for (const p of paths) {
        const tracked = cp.spawnSync('git', ['ls-files', '--error-unmatch', p], { cwd: root }).status === 0;
        if (tracked) sh(root, `git checkout -- ${JSON.stringify(p)}`); else fs.unlinkSync(p);
      }
      repo._reload();
    },
    commit: async (msg, opts) => { sh(root, `git commit -q ${opts && opts.amend ? '--amend ' : ''}-m ${JSON.stringify(msg)}`); repo._reload(); },
    checkout: async (ref) => { sh(root, `git checkout -q ${ref}`); repo._reload(); },
    push: async (remote, branch, setUp) => { sh(root, setUp ? `git push -q -u ${remote} ${branch}` : 'git push -q'); repo._reload(); },
    pull: async () => { sh(root, 'git pull -q'); repo._reload(); },
  };
  return repo;
}

function makeGitApi(roots) {
  const open = new EventEmitter(); const close = new EventEmitter();
  return {
    state: 'initialized', onDidChangeState: () => ({ dispose() {} }),
    git: { path: 'git' },
    repositories: roots.map(makeRepo),
    onDidOpenRepository: open.event, onDidCloseRepository: close.event,
    toGitUri: (uri, ref) => new Uri(uri.fsPath, 'git', `ref=${ref}`),
    _open: open, _close: close,
  };
}

// ---------------------------------------------------------------- fixture

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  const ws = path.join(base, 'ws'); fs.mkdirSync(ws);
  const git = (cwd, c) => sh(cwd, c);
  const env = 'git -c user.email=t@t -c user.name=t';
  const mk = (name, fn) => {
    const remote = path.join(base, 'remotes', name + '.git');
    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'git init -q --bare -b main');
    const dir = path.join(ws, ...name.split('/')); fs.mkdirSync(dir, { recursive: true });
    git(dir, 'git init -q -b main');
    git(dir, 'git config user.email t@t && git config user.name t');
    fs.writeFileSync(path.join(dir, 'README.md'), name + '\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'a\n');
    git(dir, `git add -A && ${env} commit -q -m init`);
    git(dir, `git remote add origin ${remote} && git push -q -u origin main && git remote set-head origin main`);
    if (fn) fn(dir);
    return dir;
  };
  const repos = {
    clean: mk('clean'),
    dirty: mk('dirty', (d) => { fs.writeFileSync(path.join(d, 'src', 'a.ts'), 'changed\n'); fs.writeFileSync(path.join(d, 'new.txt'), 'x'); }),
    staged: mk('staged', (d) => { fs.writeFileSync(path.join(d, 'README.md'), 'staged change\n'); git(d, 'git add README.md'); }),
    feature: mk('feature', (d) => git(d, 'git checkout -q -b feat/auth')),
    ahead: mk('ahead', (d) => { fs.writeFileSync(path.join(d, 'x'), '1'); git(d, `git add x && ${env} commit -q -m x`); }),
    legacy: mk('legacy-billing', (d) => fs.writeFileSync(path.join(d, 'README.md'), 'dirty\n')),
    nested: mk('tools/cli', (d) => fs.writeFileSync(path.join(d, 'README.md'), 'dirty\n')),
    // no origin/HEAD set, on master => fallback says default
    master: mk('mastery', (d) => { git(d, 'git checkout -q -b master && git branch -q -D main && git remote set-head origin -d'); }),
  };
  return { base, ws, repos };
}

// ---------------------------------------------------------------- e2e

async function e2e() {
  console.log('extension.js (mock VS Code + Git extension commands, real git repos)');
  const { base, ws, repos } = fixture();
  const fake = makeVscode(ws);
  const api = makeGitApi(Object.values(repos));
  fake.vscode.extensions.getExtension = () => ({ isActive: true, exports: { getAPI: () => api } });
  registerFakeGitCommands(fake, api);

  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
  require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: fake.vscode };

  const ext = require('../src/extension');
  const ctx = {
    subscriptions: [],
    extensionUri: Uri.file(path.join(__dirname, '..')),
    globalStorageUri: Uri.file(path.join(base, 'globalStorage')),
    workspaceState: (() => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => m.set(k, v) }; })(),
  };
  const { view } = await ext.activate(ctx);
  const panel = fake.openView();
  const wait = (ms = 220) => new Promise((r) => setTimeout(r, ms));
  const model = async () => view.refresh();
  const labels = async () => (await model()).repos.map((r) => r.label);
  const repo = async (label) => (await model()).repos.find((r) => r.label === label);
  const apiRepo = (dir) => api.repositories.find((r) => r.rootUri.fsPath === dir);
  const cmd = (id, ...a) => fake.commands.get(`workspaceChanges.${id}`)(...a);
  const head = (dir) => sh(dir, 'git log -1 --format=%s');
  const calls = (id) => fake.executed.filter((e) => e.id === id);
  const menuCtx = (section, root, extra = {}) => ({ webviewSection: section, root, preventDefaultContextMenuItems: true, ...extra, webview: 'workspaceChanges.view' });

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  await t('all manifest commands are registered', () => {
    for (const c of pkg.contributes.commands) assert.ok(fake.commands.has(c.command), c.command);
    for (const list of Object.values(pkg.contributes.menus)) {
      for (const m of list) {
        if (m.submenu) assert.ok(pkg.contributes.submenus.some((x) => x.id === m.submenu), m.submenu);
        else assert.ok(fake.commands.has(m.command), m.command);
      }
    }
  });

  await t('package.json menus are generated from src/gitMenu.js (in sync)', () => {
    const r = cp.spawnSync('node', [path.join(__dirname, '..', 'scripts', 'gen-manifest.js'), '--check'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  });

  await t('repo menu mirrors the native Source Control "…" menu', () => {
    const wc = pkg.contributes.menus['webview/context'].filter((e) => /webviewSection == 'repo'/.test(e.when));
    const order = (e) => { const [g, n] = e.group.split('@'); return [g, +n]; };
    wc.sort((a, b) => { const [ga, na] = order(a); const [gb, nb] = order(b); return ga < gb ? -1 : ga > gb ? 1 : na - nb; });
    const titles = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));
    const labels = Object.fromEntries(pkg.contributes.submenus.map((s) => [s.id, s.label]));
    const shown = wc.map((e) => (e.submenu ? `${labels[e.submenu]} >` : titles[e.command]));
    assert.deepStrictEqual(shown.slice(0, 10), ['Pull', 'Push', 'Clone', 'Checkout to...', 'Fetch', 'Commit >', 'Changes >', 'Pull, Push >', 'Branch >', 'Stash >']);
    assert.strictEqual(shown.at(-1), 'Show Git Output');
    const sub = (id) => pkg.contributes.menus[id].map((e) => titles[e.command]);
    assert.deepStrictEqual(sub('workspaceChanges.changes'), ['Stage All Changes', 'Unstage All Changes', 'Discard All Changes']);
    assert.ok(sub('workspaceChanges.commit').includes('Undo Last Commit'));
    assert.ok(pkg.contributes.menus['workspaceChanges.commit'].find((e) => e.command === 'workspaceChanges.git.commitNoVerify').when === 'config.git.allowNoVerifyCommit');
    const commitBtn = pkg.contributes.menus['webview/context'].filter((e) => /webviewSection == 'commit'/.test(e.when)).map((e) => titles[e.command]);
    assert.deepStrictEqual(commitBtn, ['Commit', 'Commit (Amend)', 'Commit & Push', 'Commit & Sync']);
  });

  await t('webview html: CSP, codicons, active icon theme CSS with fonts, resource roots', () => {
    const html = panel.view.webview.html;
    const n = html.match(/nonce-([A-Za-z0-9]+)/)[1];
    assert.match(html, /default-src 'none'/);
    assert.match(html, new RegExp(`style-src https://res.test 'nonce-${n}'; font-src https://res.test`));
    assert.ok(html.includes(`<style nonce="${n}" id="file-icon-theme">@font-face`), 'theme css inlined');
    assert.match(html, /seti\\\.woff/);
    assert.match(html, /media\/codicons\.js[\s\S]*media\/view\.js/);
    const roots = panel.view.webview.options.localResourceRoots.map((u) => u.fsPath);
    assert.ok(roots.some((r) => r.endsWith(path.join('media'))));
    assert.ok(roots.some((r) => r.endsWith(path.join('extensions', 'theme-seti'))), 'icon theme folder readable');
  });

  await t('ready → render with default filter; files carry VS Code icon classes', async () => {
    await panel.send({ type: 'ready' });
    const m = panel.lastModel();
    assert.deepStrictEqual(m.repos.map((r) => r.label), ['cli', 'dirty', 'feature', 'legacy-billing', 'staged']);
    assert.strictEqual(m.fileIcons, true);
    const dirty = m.repos.find((r) => r.label === 'dirty');
    const ts = dirty.groups[0].files.find((f) => f.name === 'a.ts');
    assert.strictEqual(ts.iconClasses, 'file-icon src-name-dir-icon a.ts-name-file-icon name-file-icon ts-ext-file-icon ext-file-icon typescript-lang-file-icon');
    const md = m.repos.find((r) => r.label === 'staged').groups[0].files[0];
    assert.match(md.iconClasses, /readme\.md-name-file-icon .* markdown-lang-file-icon$/);
  });

  await t('header model: PR availability, publish/sync/commit', async () => {
    const m = panel.lastModel();
    const feat = m.repos.find((r) => r.label === 'feature');
    assert.deepStrictEqual([feat.branch, feat.canCreatePr, feat.primary.kind], ['feat/auth', true, 'publish']);
    const dirty = m.repos.find((r) => r.label === 'dirty');
    assert.deepStrictEqual([dirty.canCreatePr, dirty.primary.kind], [false, 'commit']);
  });

  await t('icon theme switch → page rebuilt with the new theme (open docs win for language)', async () => {
    await fake.vscode.workspace.getConfiguration('workbench').update('iconTheme', 'svg-icons');
    assert.match(panel.view.webview.html, /nodejs\\\.svg/);
    assert.doesNotMatch(panel.view.webview.html, /seti\\\.woff/);
    assert.ok(panel.view.webview.options.localResourceRoots.some((u) => u.fsPath.endsWith('svg-icons')));
    fake.vscode.workspace.textDocuments.push({ uri: Uri.file(path.join(repos.dirty, 'new.txt')), languageId: 'markdown' });
    const f = (await repo('dirty')).groups[0].files.find((x) => x.name === 'new.txt');
    assert.match(f.iconClasses, /markdown-lang-file-icon$/);
    fake.vscode.workspace.textDocuments.length = 0;
    await fake.vscode.workspace.getConfiguration('workbench').update('iconTheme', null);
    assert.strictEqual((await model()).fileIcons, false, 'icon theme "None" → no file icons, like VS Code');
    await fake.vscode.workspace.getConfiguration('workbench').update('iconTheme', 'vs-seti');
  });

  await t('filters: live criteria, text, hidden, show all', async () => {
    await cmd('chooseCriteria');
    const qp = fake.ui.quickPicks.at(-1);
    qp._select(qp.items.filter((i) => i.id === 'unpushed'));
    await wait(5);
    assert.deepStrictEqual(await labels(), ['ahead', 'feature']);
    qp._select(qp.items.filter((i) => ['changes', 'nonDefaultBranch'].includes(i.id)));
    await cmd('filterText');
    const box = fake.ui.inputBoxes.at(-1);
    box._type('!legacy auth, sta'); box._accept();
    await wait(5);
    assert.deepStrictEqual(await labels(), ['feature', 'staged']);
    await cmd('clearTextFilter');
    await cmd('hideRepo', { webviewSection: 'repo', root: repos.legacy });
    assert.ok(!(await labels()).includes('legacy-billing'));
    await cmd('showAll');
    assert.strictEqual((await labels()).length, 8);
    await cmd('applyFilter');
    fake.config.hiddenRepositories = [];
    assert.strictEqual((await labels()).length, 5);
  });

  await t('commit goes through native git.commit with the message in the repo input box', async () => {
    fake.executed.length = 0;
    panel.posted.length = 0;
    await panel.send({ type: 'commit', root: repos.staged, value: 'feat: staged only' });
    const c = calls('git.commit')[0];
    assert.strictEqual(c.args[0].fsPath, repos.staged);
    assert.strictEqual(c.args.length, 1);
    assert.strictEqual(head(repos.staged), 'feat: staged only');
    assert.strictEqual(apiRepo(repos.staged).inputBox.value, '');
    assert.ok(panel.posted.some((m) => m.type === 'committed' && m.root === repos.staged));
  });

  await t('commit hooks run: pre-commit + commit-msg fire, failing hook blocks commit and keeps message', async () => {
    const hooks = path.join(repos.nested, '.git', 'hooks');
    const marker = path.join(base, 'hook-ran');
    fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\necho pre-commit >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(hooks, 'commit-msg'), `#!/bin/sh\necho "[hooked] $(cat "$1")" > "$1"\n`, { mode: 0o755 });
    fake.ui.nextSmartCommit = 'Yes';
    await panel.send({ type: 'commit', root: repos.nested, value: 'fix: cli' });
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'pre-commit\n');
    assert.strictEqual(head(repos.nested), '[hooked] fix: cli');
    // now a failing hook
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint failed: 3 problems" >&2\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(repos.nested, 'README.md'), 'again\n');
    apiRepo(repos.nested)._reload();
    panel.posted.length = 0;
    fake.ui.nextSmartCommit = 'Yes';
    await panel.send({ type: 'commit', root: repos.nested, value: 'fix: should not land' });
    assert.strictEqual(head(repos.nested), '[hooked] fix: cli');
    assert.ok(fake.ui.errors.some((e) => /lint failed: 3 problems/.test(e)), 'hook output surfaced');
    assert.strictEqual(apiRepo(repos.nested).inputBox.value, 'fix: should not land', 'message kept for retry');
    assert.ok(!panel.posted.some((m) => m.type === 'committed'), 'draft not cleared in the page');
    fake.ui.errors.length = 0;
    fs.unlinkSync(path.join(hooks, 'pre-commit'));
  });

  await t('smart commit prompt is the native one (cancel = no commit)', async () => {
    fake.ui.nextSmartCommit = undefined;
    await panel.send({ type: 'commit', root: repos.dirty, value: 'chore: all' });
    assert.ok(fake.ui.warnings.includes('There are no staged changes to commit.'));
    assert.strictEqual(head(repos.dirty), 'init');
  });

  await t('commit dropdown (native menu): Commit & Push → git.commit(repo, "git.push"); Amend → git.commitAmend', async () => {
    fake.executed.length = 0;
    fake.ui.nextSmartCommit = 'Yes';
    await panel.send({ type: 'input', root: repos.nested, value: 'fix: retry' }); // page flushes the draft before opening the menu
    await fake.commands.get('workspaceChanges.commitAndPush')(menuCtx('commit', repos.nested));
    assert.deepStrictEqual(calls('git.commit')[0].args.slice(1), ['git.push'], 'post-commit arg is the git.push command id');
    assert.strictEqual(head(repos.nested), '[hooked] fix: retry', 'committed (commit-msg hook from the earlier test still active)');
    assert.strictEqual(sh(repos.nested, 'git rev-list --count origin/main..main'), '0', 'pushed');
    fs.writeFileSync(path.join(repos.nested, 'more.txt'), 'x'); sh(repos.nested, 'git add more.txt'); apiRepo(repos.nested)._reload();
    await fake.commands.get('workspaceChanges.git.commitAmend')(menuCtx('commit', repos.nested));
    assert.strictEqual(calls('git.commitAmend')[0].args[0].fsPath, repos.nested);
    assert.match(sh(repos.nested, 'git show --stat --format= HEAD'), /more\.txt/);
  });

  await t('header: branch click → native branch picker for that repo', async () => {
    fake.executed.length = 0;
    fake.ui.nextBranch = 'main';
    await panel.send({ type: 'repoAction', root: repos.feature, action: 'checkoutBranch' });
    const c = calls('git.checkout')[0];
    assert.deepStrictEqual([c.args[0].fsPath, c.args.length], [repos.feature, 1]);
    assert.strictEqual(sh(repos.feature, 'git branch --show-current'), 'main');
    sh(repos.feature, 'git checkout -q feat/auth'); apiRepo(repos.feature)._reload();
    fake.ui.nextBranch = undefined;
  });

  await t('header: ↓ pulls, ↑ pushes (native git.pull / git.push)', async () => {
    fake.executed.length = 0;
    await panel.send({ type: 'repoAction', root: repos.ahead, action: 'push' });
    assert.strictEqual(calls('git.push').length, 1);
    assert.strictEqual(sh(repos.ahead, 'git rev-list --count origin/main..main'), '0');
    // make 'clean' behind: push a commit from another clone
    const other = path.join(base, 'other');
    sh(base, `git clone -q ${sh(repos.clean, 'git remote get-url origin')} other`);
    sh(other, 'git config user.email t@t && git config user.name t && echo z > z && git add z && git commit -qm remote && git push -q');
    sh(repos.clean, 'git fetch -q'); apiRepo(repos.clean)._reload();
    fake.config.criteria = ['behind'];
    assert.strictEqual((await repo('clean')).behind, 1);
    await panel.send({ type: 'repoAction', root: repos.clean, action: 'pull' });
    assert.strictEqual(calls('git.pull').length, 1);
    assert.strictEqual(head(repos.clean), 'remote');
    fake.config.criteria = ['changes', 'nonDefaultBranch'];
  });

  await t('primary: Publish Branch → git.publish; Sync → git.sync', async () => {
    fake.executed.length = 0;
    await panel.send({ type: 'primary', root: repos.feature, value: '' });
    assert.strictEqual(calls('git.publish').length, 1);
    assert.ok(sh(repos.feature, 'git rev-parse --abbrev-ref @{u}').endsWith('feat/auth'));
    sh(repos.feature, 'echo s > s && git add s && git commit -qm s'); apiRepo(repos.feature)._reload();
    const f = await repo('feature');
    assert.deepStrictEqual(f.primary, { kind: 'sync', label: 'Sync Changes 1↑', enabled: true });
    await panel.send({ type: 'primary', root: repos.feature, value: '' });
    assert.strictEqual(calls('git.sync').length, 1);
  });

  await t('Create PR: GitHub PR extension when installed, else browser compare page', async () => {
    sh(repos.feature, 'git remote set-url origin git@github.com:acme/front.git'); apiRepo(repos.feature)._reload();
    let prArgs;
    fake.commands.set('pr.create', async (a) => { prArgs = a; });
    await panel.send({ type: 'repoAction', root: repos.feature, action: 'createPr' });
    assert.deepStrictEqual(prArgs, { repoPath: repos.feature, compareBranch: 'feat/auth' });
    fake.commands.delete('pr.create');
    await panel.send({ type: 'repoAction', root: repos.feature, action: 'createPr' });
    assert.strictEqual(fake.ui.opened.at(-1), 'https://github.com/acme/front/compare/main...feat/auth?expand=1');
    fake.commands.set('pr.create', async () => { throw new Error('should not be used'); });
    fake.config.createPullRequest = 'browser';
    await panel.send({ type: 'repoAction', root: repos.feature, action: 'createPr' });
    assert.strictEqual(fake.ui.opened.length, 2);
    fake.commands.delete('pr.create');
    fake.config.createPullRequest = 'auto';
  });

  await t('Create PR on an unpublished branch asks to publish first', async () => {
    sh(repos.staged, 'git checkout -q -b feat/new');
    apiRepo(repos.staged)._reload();
    fake.ui.nextInfo = undefined;
    const before = fake.ui.opened.length;
    await panel.send({ type: 'repoAction', root: repos.staged, action: 'createPr' });
    assert.match(fake.ui.infos.at(-1), /has not been published yet/);
    assert.strictEqual(fake.ui.opened.length, before, 'cancelled → nothing opened');
    fake.ui.nextInfo = 'Publish Branch';
    await panel.send({ type: 'repoAction', root: repos.staged, action: 'createPr' });
    assert.ok(sh(repos.staged, 'git rev-parse --abbrev-ref @{u}').endsWith('feat/new'));
    assert.strictEqual(fake.ui.opened.length, before, 'local-path remote → no URL (warns instead)');
    assert.match(fake.ui.lastWarning, /Don't know how to open a pull request/);
  });

  await t('file + group actions from the page', async () => {
    fs.writeFileSync(path.join(repos.clean, 'README.md'), 'edit\n');
    fs.writeFileSync(path.join(repos.clean, 'tmp.log'), 'junk');
    apiRepo(repos.clean)._reload();
    let r = await repo('clean');
    const readme = r.groups[0].files.find((f) => f.name === 'README.md');
    fake.executed.length = 0;
    await panel.send({ type: 'fileAction', root: repos.clean, group: 'working', uri: readme.uri, action: 'open' });
    const diff = calls('vscode.diff')[0];
    assert.deepStrictEqual([diff.args[0].query, diff.args[2]], ['ref=~', 'README.md (Working Tree)']);
    await panel.send({ type: 'fileAction', root: repos.clean, group: 'working', uri: readme.uri, action: 'stage' });
    r = await repo('clean');
    assert.deepStrictEqual(r.groups.map((g) => [g.key, g.count]), [['index', 1], ['working', 1]]);
    await panel.send({ type: 'groupAction', root: repos.clean, group: 'index', action: 'unstage' });
    r = await repo('clean');
    assert.deepStrictEqual(r.groups.map((g) => [g.key, g.count]), [['working', 2]]);
    fake.ui.nextWarning = 'Discard';
    const log = r.groups[0].files.find((f) => f.name === 'tmp.log');
    await panel.send({ type: 'fileAction', root: repos.clean, group: 'working', uri: log.uri, action: 'discard' });
    assert.ok(!fs.existsSync(path.join(repos.clean, 'tmp.log')));
  });

  await t('repo context menu: stage all / unstage all via native commands', async () => {
    fake.executed.length = 0;
    await cmd('stageAll', { webviewSection: 'repo', root: repos.clean });
    assert.strictEqual(calls('git.stageAll')[0].args[0].fsPath, repos.clean);
    assert.strictEqual((await repo('clean')).staged, 1);
    await cmd('unstageAll', { webviewSection: 'repo', root: repos.clean });
    assert.strictEqual((await repo('clean')).staged, 0);
  });

  await t('… menu: checkout default branch → git.checkout(repo, "main")', async () => {
    fake.executed.length = 0;
    await cmd('checkoutDefault', menuCtx('repo', repos.feature, { nondefault: true }));
    assert.deepStrictEqual(calls('git.checkout')[0].args.slice(1), ['main']);
    assert.strictEqual(sh(repos.feature, 'git branch --show-current'), 'main');
  });

  await t('… menu: every entry runs the native git command for THAT repo (no repo picker)', async () => {
    const GM = require('../src/gitMenu');
    const saved = new Map();
    const seen = [];
    for (const w of GM.wrappers()) {
      saved.set(w.native, fake.commands.get(w.native));
      fake.commands.set(w.native, async (...args) => { seen.push([w.native, args]); });
    }
    try {
      for (const w of GM.wrappers()) {
        seen.length = 0;
        fake.ui.lastPickItems = undefined;
        await fake.commands.get(w.id)(menuCtx('repo', repos.legacy));
        assert.strictEqual(seen.length, 1, w.id);
        const [native, args] = seen[0];
        assert.strictEqual(native, w.native);
        if (w.noRepoArg) assert.deepStrictEqual(args, [], `${w.native} gets no repo arg`);
        else assert.deepStrictEqual(args.map((a) => a.fsPath), [repos.legacy], `${w.native} gets the repo root`);
        assert.strictEqual(fake.ui.lastPickItems, undefined, 'no repository picker');
      }
    } finally {
      for (const [id, fn] of saved) { if (fn) fake.commands.set(id, fn); else fake.commands.delete(id); }
    }
  });

  await t('collapse / expand all posts to the page', async () => {
    panel.posted.length = 0;
    await cmd('collapseAll');
    await cmd('expandAll');
    assert.deepStrictEqual(panel.posted.filter((m) => m.type === 'setAllCollapsed').map((m) => m.collapsed), [true, false]);
  });

  await t('title bar toggle: one button, Collapse All ⇄ Expand All, driven by the page state', async () => {
    const title = pkg.contributes.menus['view/title'];
    const col = title.find((e) => e.command === 'workspaceChanges.collapseAll');
    const exp = title.find((e) => e.command === 'workspaceChanges.expandAll');
    assert.strictEqual(col.group, exp.group, 'same slot');
    assert.match(col.when, /!workspaceChanges\.allCollapsed$/);
    assert.match(exp.when, /[^!]workspaceChanges\.allCollapsed$/);
    await panel.send({ type: 'collapseState', allCollapsed: true });
    assert.strictEqual(fake.context.get('workspaceChanges.allCollapsed'), true);
    await panel.send({ type: 'collapseState', allCollapsed: false });
    assert.strictEqual(fake.context.get('workspaceChanges.allCollapsed'), false);
  });

  await t('palette commit uses the native flow for the picked repo', async () => {
    fake.ui.nextPick = (items) => items.find((i) => i.label === 'clean');
    apiRepo(repos.clean).inputBox.value = 'chore: palette';
    fake.ui.nextSmartCommit = 'Yes';
    await cmd('commit');
    assert.strictEqual(head(repos.clean), 'chore: palette');
    fake.ui.nextPick = undefined;
  });

  // ------------------------------------------------------------ Go to File in Shown Repositories
  const showOnly = async (...names) => {
    fake.config.criteria = [];
    const all = (await view.evaluate()).map((r) => r.label);
    fake.config.hiddenRepositories = all.filter((l) => !names.includes(l));
    assert.deepStrictEqual((await labels()).sort(), names.slice().sort());
  };
  const openPicker = async () => fake.commands.get('workspaceChanges.quickOpen')();
  const files = (qp) => qp.visibleItems.map((i) => `${i.description}/${i.label}`);

  await t('Go to File: searches only the repos shown in the panel', async () => {
    fs.writeFileSync(path.join(repos.dirty, 'src', 'OnlyInShown.ts'), 'x');
    fs.writeFileSync(path.join(repos.ahead, 'OnlyInHidden.ts'), 'x');
    sh(repos.ahead, 'git add OnlyInHidden.ts && git commit -qm hidden');
    apiRepo(repos.dirty)._reload(); apiRepo(repos.ahead)._reload();
    await showOnly('dirty', 'cli');
    const qp = await openPicker();
    assert.match(qp.placeholder, /in 2 shown repositories/);
    assert.strictEqual(qp.busy, false);
    qp._type('Only');
    assert.deepStrictEqual(files(qp), ['dirty/src/OnlyInShown.ts']);
    qp._type('README');
    assert.deepStrictEqual(files(qp).sort(), ['cli/README.md', 'dirty/README.md']);
    qp.hide();
    assert.ok(qp.disposed);
  });

  await t('Go to File: items carry the file icon theme icon as an image (works without resourceUri support)', async () => {
    const qp = await openPicker();
    qp._type('OnlyInShown');
    const [item] = qp.visibleItems;
    assert.strictEqual(item.label, 'OnlyInShown.ts');
    assert.strictEqual(item.description, 'dirty/src');
    assert.strictEqual(item.resourceUri.fsPath, path.join(repos.dirty, 'src', 'OnlyInShown.ts'));
    // Seti (font theme): the TypeScript glyph, converted to SVG in global storage, in Seti's colors
    const seti = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'extensions', 'theme-seti', 'icons', 'vs-seti-icon-theme.json'), 'utf8'));
    const tsDef = seti.iconDefinitions[seti.languageIds.typescript];
    const tsLight = seti.iconDefinitions[seti.light.languageIds.typescript];
    const darkSvg = fs.readFileSync(item.iconPath.dark.fsPath, 'utf8');
    const lightSvg = fs.readFileSync(item.iconPath.light.fsPath, 'utf8');
    assert.ok(item.iconPath.dark.fsPath.startsWith(path.join(base, 'globalStorage', 'file-icons')), 'written to global storage');
    assert.match(darkSvg, new RegExp(`^<svg [^>]*width="16" height="22"[^>]*><path fill="${tsDef.fontColor}" d="M`));
    assert.match(lightSvg, new RegExp(`fill="${tsLight.fontColor}"`), 'light theme variant');
    const same = qp.visibleItems[0].iconPath;
    qp._type('OnlyInShown.ts');
    assert.strictEqual(qp.visibleItems[0].iconPath, same, 'cached per icon');
    assert.strictEqual(item.alwaysShow, true);
    assert.strictEqual(item.buttons[0].tooltip, 'Open to the Side');
    qp.hide();
  });

  await t('Go to File: image icon themes use the theme\'s own files; no theme → no icon', async () => {
    await fake.vscode.workspace.getConfiguration('workbench').update('iconTheme', 'svg-icons');
    let qp = await openPicker();
    qp._type('OnlyInShown');
    let { iconPath } = qp.visibleItems[0];
    assert.strictEqual(iconPath.dark.fsPath, path.join(__dirname, 'fixtures', 'extensions', 'svg-icons', 'icons', 'typescript.svg'));
    qp._type('README');
    iconPath = qp.visibleItems.find((i) => i.label === 'README.md').iconPath;
    assert.deepStrictEqual([path.basename(iconPath.dark.fsPath), path.basename(iconPath.light.fsPath)], ['markdown.svg', 'markdown_light.svg']);
    qp.hide();
    await fake.vscode.workspace.getConfiguration('workbench').update('iconTheme', null);
    qp = await openPicker();
    qp._type('OnlyInShown');
    assert.strictEqual(qp.visibleItems[0].iconPath, undefined, 'icon theme "None": no icons, like Cmd+P');
    qp.hide();
    await fake.vscode.workspace.getConfiguration('workbench').update('iconTheme', 'vs-seti');
  });

  await t('Go to File: Cmd+P ranking (prefix > fuzzy, path queries, multi-word)', async () => {
    for (const f of ['src/components/Header.tsx', 'src/components/HeaderMenu.tsx', 'src/hooks/useHeader.ts', 'docs/header-notes.md']) {
      fs.mkdirSync(path.dirname(path.join(repos.dirty, f)), { recursive: true });
      fs.writeFileSync(path.join(repos.dirty, f), 'x');
    }
    apiRepo(repos.dirty)._reload();
    const qp = await openPicker();
    qp._type('Header');
    assert.deepStrictEqual(files(qp).slice(0, 2), ['dirty/src/components/Header.tsx', 'dirty/src/components/HeaderMenu.tsx'], 'shortest prefix match first');
    qp._type('hooks/head');
    assert.strictEqual(files(qp)[0], 'dirty/src/hooks/useHeader.ts', 'path query');
    qp._type('comp menu');
    assert.deepStrictEqual(files(qp), ['dirty/src/components/HeaderMenu.tsx'], 'space-separated pieces must all match');
    qp._type('HeaderQ');
    assert.deepStrictEqual(files(qp), []);
    qp._type('"r-no"');
    assert.deepStrictEqual(files(qp), ['dirty/docs/header-notes.md'], 'quotes = contiguous match');
    qp.hide();
  });

  await t('Go to File: respects .gitignore, files.exclude/search.exclude, and skips deleted files', async () => {
    fs.writeFileSync(path.join(repos.dirty, '.gitignore'), 'secret.log\n');
    fs.writeFileSync(path.join(repos.dirty, 'secret.log'), 'x');
    fs.mkdirSync(path.join(repos.dirty, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repos.dirty, 'node_modules', 'pkg', 'index.js'), 'x');
    fs.mkdirSync(path.join(repos.dirty, 'build'), { recursive: true });
    fs.writeFileSync(path.join(repos.dirty, 'build', 'out.js'), 'x');
    fs.unlinkSync(path.join(repos.dirty, 'README.md'));
    apiRepo(repos.dirty)._reload();
    await fake.vscode.workspace.getConfiguration('search').update('exclude', { '**/node_modules': true, '**/build': { when: '$(basename).ts' } });
    await fake.vscode.workspace.getConfiguration('files').update('exclude', { '**/build': true, '**/.git': true });
    const qp = await openPicker();
    qp._type('secret'); assert.deepStrictEqual(files(qp), [], '.gitignore');
    qp._type('index.js'); assert.deepStrictEqual(files(qp), [], 'search.exclude');
    qp._type('out.js'); assert.deepStrictEqual(files(qp), [], 'files.exclude');
    qp._type('README'); assert.strictEqual(files(qp)[0], 'cli/README.md'); assert.ok(!files(qp).includes('dirty/README.md'), 'deleted file not offered');
    qp._type('.gitignore'); assert.deepStrictEqual(files(qp), ['dirty/.gitignore'], 'untracked, not ignored');
    qp.hide();
    sh(repos.dirty, 'git checkout -- README.md'); apiRepo(repos.dirty)._reload();
  });

  await t('Go to File: opens like Cmd+P (preview, :line:col, open to the side)', async () => {
    let qp = await openPicker();
    qp._type('OnlyInShown:12:3');
    fake.executed.length = 0;
    qp._accept();
    await wait(5);
    let call = calls('vscode.open')[0];
    assert.strictEqual(call.args[0].fsPath, path.join(repos.dirty, 'src', 'OnlyInShown.ts'));
    assert.deepStrictEqual([call.args[1].preview, call.args[1].selection.start.line, call.args[1].selection.start.character], [true, 11, 2]);
    assert.strictEqual(qp.shown, false, 'picker closes');
    qp = await openPicker();
    qp._type('HeaderMenu');
    fake.executed.length = 0;
    qp._button(qp.visibleItems[0]);
    await wait(5);
    call = calls('vscode.open')[0];
    assert.deepStrictEqual([call.args[1].viewColumn, call.args[1].preview], [fake.vscode.ViewColumn.Beside, false]);
    qp.hide();
  });

  await t('Go to File: recently opened files first, only from shown repos', async () => {
    fake.ui.fireActiveEditor({ document: { uri: Uri.file(path.join(repos.ahead, 'OnlyInHidden.ts')) } });
    const qp = await openPicker();
    assert.strictEqual(qp.items[0].label, 'recently opened');
    assert.deepStrictEqual(files(qp), ['dirty/src/components/HeaderMenu.tsx', 'dirty/src/OnlyInShown.ts'], 'most recent first; hidden repo file left out');
    qp._type('Header');
    assert.deepStrictEqual(qp.items.filter((i) => i.kind === -1).map((i) => i.label), ['recently opened', 'file results']);
    assert.strictEqual(files(qp)[0], 'dirty/src/components/HeaderMenu.tsx');
    qp.hide();
  });

  await t('Go to File: new files show up (index refreshes after repo changes)', async () => {
    let qp = await openPicker();
    qp._type('BrandNew'); assert.deepStrictEqual(files(qp), []); qp.hide();
    fs.writeFileSync(path.join(repos.nested, 'BrandNew.ts'), 'x');
    apiRepo(repos.nested)._reload();
    qp = await openPicker();
    qp._type('BrandNew'); assert.deepStrictEqual(files(qp), ['cli/BrandNew.ts']); qp.hide();
  });

  await t('Go to File: nothing shown → offers the normal Cmd+P', async () => {
    fake.config.criteria = ['changes'];
    fake.config.hiddenRepositories = (await view.evaluate()).map((r) => r.label);
    fake.ui.nextInfo = 'Search All Files';
    fake.executed.length = 0;
    await openPicker();
    assert.match(fake.ui.infos.at(-1), /No repositories are shown/);
    assert.strictEqual(calls('workbench.action.quickOpen').length, 1);
    fake.config.hiddenRepositories = [];
    fake.config.criteria = ['changes', 'nonDefaultBranch'];
  });

  await t('Go to File: fast path (prefilter, Map cache, top-k) ranks exactly like plain VS Code scoring', () => {
    const { rank } = require('../src/quickOpen');
    const FS = require('../src/fuzzyScorer');
    const acc = { getItemLabel: (e) => e.label, getItemDescription: (e) => e.description, getItemPath: (e) => e.fsPath };
    const segs = ['src', 'components', 'layout', 'features', 'onboarding', 'hooks', 'test', 'packages', 'api', 'routes', 'pages', 'utils'];
    const words = ['Header', 'Footer', 'useAuth', 'Button', 'Modal', 'Invoice', 'Billing', 'Session', 'Report', 'index', 'config'];
    const exts = ['.ts', '.tsx', '.test.ts', '.css', '.md', '.json'];
    let seed = 42;
    const rnd = (n) => { seed = (seed * 16807) % 2147483647; return seed % n; };
    const entries = [];
    for (let i = 0; i < 4000; i++) {
      const d = ['repo' + rnd(12), ...Array.from({ length: 1 + rnd(4) }, () => segs[rnd(segs.length)])].join('/');
      const label = words[rnd(words.length)] + (rnd(3) ? String(rnd(40)) : '') + exts[rnd(exts.length)];
      entries.push({ label, description: d, fsPath: `/ws/${d}/${label}` });
    }
    for (const q of ['h', 'Head', 'header.tsx', 'comp/head', 'use auth', 'repo3/hooks/use', '"invoice"', 'pages/inv', 'Bill12', 'x', 'idx']) {
      const p = FS.prepareQuery(q);
      const cache = Object.create(null);
      const ref = entries.filter((e) => FS.scoreItemFuzzy(e, p, true, acc, cache).score > 0)
        .sort((a, b) => FS.compareItemsByFuzzyScore(a, b, p, true, acc, cache)).slice(0, 100);
      assert.deepStrictEqual(rank(entries, q, 100), ref, q);
    }
  });

  await t('Go to File: command, shortcut and panel menu entry are contributed', () => {
    assert.ok(pkg.contributes.commands.some((c) => c.command === 'workspaceChanges.quickOpen'));
    assert.deepStrictEqual(pkg.contributes.keybindings, [{ command: 'workspaceChanges.quickOpen', key: 'ctrl+alt+p', mac: 'cmd+alt+p' }]);
    assert.ok(pkg.contributes.menus['view/title'].some((e) => e.command === 'workspaceChanges.quickOpen'));
  });

  // ------------------------------------------------------------ pending animations
  /** Replace a git command by one that waits until released; returns { release, fail, started }. */
  const hold = (id) => {
    const original = fake.commands.get(id);
    let release; let fail; let markStarted;
    const started = new Promise((r) => { markStarted = r; });
    const gate = new Promise((res, rej) => { release = res; fail = rej; });
    fake.commands.set(id, async (...args) => { markStarted(); try { await gate; } finally { fake.commands.set(id, original); } return original(...args); });
    return { release: () => release(), fail: (e) => fail(e), started };
  };
  const repoModel = async (root) => (await model()).repos.find((r) => r.root === root);

  await t('pending: Commit spins like native ("Committing Changes..."), then returns to normal', async () => {
    fake.config.criteria = []; fake.config.hiddenRepositories = [];
    fs.writeFileSync(path.join(repos.legacy, 'pending.txt'), 'x'); sh(repos.legacy, 'git add pending.txt'); apiRepo(repos.legacy)._reload();
    await model();
    const h = hold('git.commit');
    fake.ui.progress.length = 0;
    const done = panel.send({ type: 'commit', root: repos.legacy, value: 'feat: slow hooks' });
    await h.started;
    let r = (await repoModel(repos.legacy));
    assert.deepStrictEqual(r.primary, { kind: 'commit', label: 'Commit', enabled: false, busy: true, tip: 'Committing Changes...' });
    assert.strictEqual(r.busy.commit, true);
    assert.strictEqual(fake.ui.progressActive, 1, 'progress bar on the view while it runs');
    assert.deepStrictEqual(fake.ui.progress[0], { location: { viewId: 'workspaceChanges.view' } });
    h.release();
    await done;
    r = (await repoModel(repos.legacy));
    assert.strictEqual(r.busy.commit, false);
    assert.ok(!r.primary.busy);
    assert.strictEqual(fake.ui.progressActive, 0);
  });

  await t('pending: Commit & Push keeps the Commit button spinning through the push', async () => {
    sh(repos.legacy, 'git add -A && git commit -qm "clean slate" && git push -q'); // nothing else pending: after the commit the repo is clean + ahead
    fs.writeFileSync(path.join(repos.legacy, 'pending2.txt'), 'x'); sh(repos.legacy, 'git add pending2.txt'); apiRepo(repos.legacy)._reload();
    await panel.send({ type: 'input', root: repos.legacy, value: 'feat: and push' });
    const h = hold('git.push');
    const done = fake.commands.get('workspaceChanges.commitAndPush')(menuCtx('commit', repos.legacy));
    await h.started; // the commit is done, its post-commit push is running
    const r = (await repoModel(repos.legacy));
    assert.strictEqual(r.changes, 0);
    assert.deepStrictEqual([r.primary.kind, r.primary.busy, r.primary.tip], ['commit', true, 'Committing & Pushing Changes...'], 'not the Sync button');
    h.release();
    await done;
    assert.ok(!(await repoModel(repos.legacy)).busy.commit);
  });

  await t('pending: Publish / Sync / Pull / Push from the header spin the sync state', async () => {
    sh(repos.legacy, 'git checkout -q -b feat/pending'); apiRepo(repos.legacy)._reload();
    await model();
    let h = hold('git.publish');
    let done = panel.send({ type: 'primary', root: repos.legacy, value: '' });
    await h.started;
    let r = (await repoModel(repos.legacy));
    assert.deepStrictEqual([r.primary.kind, r.primary.busy, r.primary.tip], ['publish', true, 'Publishing Branch "feat/pending"...']);
    assert.deepStrictEqual([r.busy.sync, r.busy.syncDetail], [true, 'publish']);
    h.release(); await done;
    sh(repos.legacy, 'echo y > y && git add y && git commit -qm y'); apiRepo(repos.legacy)._reload();
    h = hold('git.push');
    done = panel.send({ type: 'repoAction', root: repos.legacy, action: 'push' });
    await h.started;
    r = (await repoModel(repos.legacy));
    assert.deepStrictEqual([r.primary.kind, r.primary.busy, r.primary.tip, r.busy.syncDetail], ['sync', true, 'Synchronizing Changes...', 'push']);
    h.release(); await done;
    assert.ok(!(await repoModel(repos.legacy)).busy.sync);
  });

  await t('pending: native menu entries — push/pull/sync/commit spin, fetch = progress bar only, others nothing', async () => {
    const cases = [['git.pullRebase', 'sync', 'pull'], ['git.pushForce', 'sync', 'push'], ['git.syncRebase', 'sync', 'sync'], ['git.commitStagedAmend', 'commit', null], ['git.fetchPrune', null, null], ['git.stashPop', undefined, null]];
    for (const [id, kind, detail] of cases) {
      const had = fake.commands.has(id);
      if (!had) fake.commands.set(id, async () => {});
      const h = hold(id);
      fake.ui.progress.length = 0;
      const done = fake.commands.get(`workspaceChanges.${id}`)(menuCtx('repo', repos.legacy));
      await h.started;
      const r = (await repoModel(repos.legacy));
      if (kind === 'sync') assert.deepStrictEqual([r.busy.sync, r.busy.syncDetail], [true, detail], id);
      else if (kind === 'commit') assert.strictEqual(r.busy.commit, true, id);
      else assert.deepStrictEqual([r.busy.sync, r.busy.commit], [false, false], id);
      assert.strictEqual(fake.ui.progress.length, kind === undefined ? 0 : 1, `${id}: progress bar`);
      h.release(); await done;
      if (!had) fake.commands.delete(id);
    }
  });

  await t('pending: a failed operation clears the spinner', async () => {
    const h = hold('git.pull');
    const done = panel.send({ type: 'repoAction', root: repos.legacy, action: 'pull' }).catch(() => {});
    await h.started;
    assert.ok((await repoModel(repos.legacy)).busy.sync);
    h.fail(new Error('auth failed'));
    await done;
    assert.ok(!(await repoModel(repos.legacy)).busy.sync);
    assert.strictEqual(fake.ui.progressActive, 0);
    fake.ui.errors.length = 0;
    fake.config.criteria = ['changes', 'nonDefaultBranch'];
  });

  // ------------------------------------------------------------ Pull All
  await t('Pull All: pulls every clean repo on its default branch (shown or not), skips the rest, one summary', async () => {
    const mkRepo = (name, setup) => {
      const remote = path.join(base, 'remotes', name + '.git');
      fs.mkdirSync(remote, { recursive: true });
      sh(remote, 'git init -q --bare -b main');
      const dir = path.join(ws, name);
      fs.mkdirSync(dir);
      sh(dir, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init');
      sh(dir, `git remote add origin ${remote} && git push -q -u origin main && git remote set-head origin main`);
      if (setup) setup(dir, remote);
      const r = makeRepo(dir); api.repositories.push(r); api._open.fire(r);
      return dir;
    };
    const behind = mkRepo('pa-behind', (dir, remote) => {
      sh(base, `git clone -q ${remote} pa-behind-other`);
      sh(path.join(base, 'pa-behind-other'), 'git config user.email t@t && git config user.name t && echo b > b && git add b && git commit -qm remote-change && git push -q');
    });
    const current = mkRepo('pa-current');
    const dirty = mkRepo('pa-dirty', (dir) => fs.writeFileSync(path.join(dir, 'a'), 'local edit'));
    const broken = mkRepo('pa-broken', (dir) => sh(dir, `git remote set-url origin ${path.join(base, 'does-not-exist.git')}`));
    const branch = mkRepo('pa-branch', (dir) => sh(dir, 'git checkout -q -b feat/x && git push -q -u origin feat/x'));
    for (const d of [behind, current, dirty, broken, branch]) apiRepo(d)._reload();

    fake.config.criteria = ['changes']; // panel hides clean repos: Pull All must not care
    const all = await view.evaluate();
    const eligible = all.filter((e) => !e.facts.detached && e.facts.isDefault && e.facts.changes === 0 && e.facts.hasUpstream).map((e) => e.label).sort();
    assert.ok(eligible.includes('pa-behind') && eligible.includes('pa-current') && eligible.includes('pa-broken'));
    assert.ok(!eligible.includes('pa-dirty') && !eligible.includes('pa-branch'));
    assert.ok(!(await labels()).includes('pa-behind'), 'pa-behind is hidden in the panel');

    fake.ui.progress.length = 0; fake.ui.infos.length = 0; fake.ui.warnings.length = 0;
    const res = await fake.commands.get('workspaceChanges.pullAll')();
    assert.deepStrictEqual([...res.updated, ...res.upToDate, ...res.failed.map((f) => f.label)].sort(), eligible, 'exactly the eligible repos were pulled');
    assert.ok(res.updated.includes('pa-behind'));
    assert.ok(fs.existsSync(path.join(behind, 'b')), 'remote change arrived');
    assert.ok(res.upToDate.includes('pa-current'));
    // pa-broken fails; so does 'feature', whose remote an earlier test pointed at an unreachable host
    const brokenFail = res.failed.find((f) => f.label === 'pa-broken');
    assert.ok(brokenFail, 'pa-broken reported as failed');
    assert.match(brokenFail.msg, /does-not-exist|not appear to be a git repository|Could not read/);
    assert.ok(res.failed.every((f) => f.msg && f.msg !== 'failed'), 'each failure has a reason');
    assert.strictEqual(res.skipped, all.length - eligible.length);
    assert.strictEqual(fs.readFileSync(path.join(dirty, 'a'), 'utf8'), 'local edit', 'dirty repo untouched');
    assert.strictEqual(sh(branch, 'git branch --show-current'), 'feat/x');
    const notif = fake.ui.progress.find((p) => p.location === fake.vscode.ProgressLocation.Notification);
    assert.ok(notif && notif.cancellable && /^Pulling \d+ repositories$/.test(notif.title), 'one progress notification with cancel');
    assert.strictEqual(fake.ui.warnings.length, 1, 'one summary, not one dialog per repo');
    assert.match(fake.ui.warnings[0], /^Pulled \d+ repositories: \d+ updated \(.*pa-behind.*\), \d+ already up to date\. Skipped \d+ with changes or not on their default branch\. \d+ failed: .*pa-broken \(/);
    assert.ok(!(await model()).repos.some((r) => r.busy && r.busy.sync), 'no spinner left');
    fake.ui.errors.length = 0;
    fake.config.criteria = ['changes', 'nonDefaultBranch'];
  });

  await t('Pull All: nothing to pull → one info message', async () => {
    const saved = api.repositories.splice(0);
    const d = path.join(ws, 'pa-only-dirty');
    fs.mkdirSync(d); sh(d, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a');
    api.repositories.push(makeRepo(d));
    fake.ui.infos.length = 0;
    const res = await fake.commands.get('workspaceChanges.pullAll')();
    assert.match(fake.ui.infos.at(-1), /no repository is on its default branch without changes/);
    assert.strictEqual(res.pulled.length, 0);
    api.repositories.splice(0, api.repositories.length, ...saved);
  });

  await t('Pull All: in the panel\'s … menu and the command palette', () => {
    assert.ok(pkg.contributes.menus['view/title'].some((e) => e.command === 'workspaceChanges.pullAll' && !/navigation/.test(e.group)));
    assert.ok(!pkg.contributes.menus.commandPalette.some((e) => e.command === 'workspaceChanges.pullAll'));
  });

  await t('no unexpected errors surfaced', () => assert.deepStrictEqual(fake.ui.errors, []));

  for (const d of ctx.subscriptions) d.dispose && d.dispose();
  fs.rmSync(base, { recursive: true, force: true });
}

(async () => {
  console.log('fuzzyScorer.js (port of VS Code Quick Open scorer)');
  const vs = cp.spawnSync(process.execPath, [path.join(__dirname, 'vscode-fuzzyScorer.js')], { encoding: 'utf8' });
  process.stdout.write(vs.stdout + vs.stderr);
  if (vs.status !== 0) throw new Error('VS Code fuzzyScorer tests failed');
  passed++;
  await unit();
  await unitIcons();
  await e2e();
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
