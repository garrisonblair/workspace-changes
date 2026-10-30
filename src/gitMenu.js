'use strict';
// The repo "…" / right-click menu. Mirrors the Source Control view's "…" menu from the built-in
// Git extension (extensions/git/package.json: scm/title + git.commit / git.changes / git.pullpush /
// git.branch / git.stash submenus): same entries, labels, order, groups and `when` conditions.
//
// It is shown with VS Code's own context menu (webview/context), so it looks and behaves natively.
// Native git.* commands can't tell which repo a webview menu was opened on (they'd show a repo picker),
// so each entry is a thin `workspaceChanges.git.*` wrapper that runs the native command for that repo.
//
// scripts/gen-manifest.js writes this into package.json; a test checks they stay in sync.

const SUBMENUS = [
  { id: 'workspaceChanges.commit', label: 'Commit' },
  { id: 'workspaceChanges.changes', label: 'Changes' },
  { id: 'workspaceChanges.pullpush', label: 'Pull, Push' },
  { id: 'workspaceChanges.branch', label: 'Branch' },
  { id: 'workspaceChanges.stash', label: 'Stash' },
];

const NOVERIFY = 'config.git.allowNoVerifyCommit';
const FORCE = 'config.git.allowForcePush';

/** [nativeCommand, title, group, when?, { noRepoArg }] grouped by where they appear */
const MENU = {
  root: [
    ['git.pull', 'Pull', '1_header@1'],
    ['git.push', 'Push', '1_header@2'],
    ['git.clone', 'Clone', '1_header@3', undefined, { noRepoArg: true }],
    ['git.checkout', 'Checkout to...', '1_header@4'],
    ['git.fetch', 'Fetch', '1_header@5'],
    // 2_main: submenus (below)
    // 3_workspace: this extension's own repo actions (registered in extension.js)
    ['git.showOutput', 'Show Git Output', '9_footer@1', undefined, { noRepoArg: true }],
  ],
  'workspaceChanges.commit': [
    ['git.commit', 'Commit', '1_commit@1'],
    ['git.commitStaged', 'Commit Staged', '1_commit@2'],
    ['git.commitAll', 'Commit All', '1_commit@3'],
    ['git.undoCommit', 'Undo Last Commit', '1_commit@4'],
    ['git.rebaseAbort', 'Abort Rebase', '1_commit@5'],
    ['git.commitNoVerify', 'Commit (No Verify)', '2_commit_noverify@1', NOVERIFY],
    ['git.commitStagedNoVerify', 'Commit Staged (No Verify)', '2_commit_noverify@2', NOVERIFY],
    ['git.commitAllNoVerify', 'Commit All (No Verify)', '2_commit_noverify@3', NOVERIFY],
    ['git.commitAmend', 'Commit (Amend)', '3_amend@1'],
    ['git.commitStagedAmend', 'Commit Staged (Amend)', '3_amend@2'],
    ['git.commitAllAmend', 'Commit All (Amend)', '3_amend@3'],
    ['git.commitAmendNoVerify', 'Commit (Amend, No Verify)', '4_amend_noverify@1', NOVERIFY],
    ['git.commitStagedAmendNoVerify', 'Commit Staged (Amend, No Verify)', '4_amend_noverify@2', NOVERIFY],
    ['git.commitAllAmendNoVerify', 'Commit All (Amend, No Verify)', '4_amend_noverify@3', NOVERIFY],
    ['git.commitSigned', 'Commit (Signed Off)', '5_signoff@1'],
    ['git.commitStagedSigned', 'Commit Staged (Signed Off)', '5_signoff@2'],
    ['git.commitAllSigned', 'Commit All (Signed Off)', '5_signoff@3'],
    ['git.commitSignedNoVerify', 'Commit (Signed Off, No Verify)', '6_signoff_noverify@1', NOVERIFY],
    ['git.commitStagedSignedNoVerify', 'Commit Staged (Signed Off, No Verify)', '6_signoff_noverify@2', NOVERIFY],
    ['git.commitAllSignedNoVerify', 'Commit All (Signed Off, No Verify)', '6_signoff_noverify@3', NOVERIFY],
  ],
  'workspaceChanges.changes': [
    ['git.stageAll', 'Stage All Changes', 'changes@1'],
    ['git.unstageAll', 'Unstage All Changes', 'changes@2'],
    ['git.cleanAll', 'Discard All Changes', 'changes@3'],
  ],
  'workspaceChanges.pullpush': [
    ['git.sync', 'Sync', '1_sync@1'],
    ['git.syncRebase', 'Sync (Rebase)', '1_sync@2'],
    ['git.pull', 'Pull', '2_pull@1'],
    ['git.pullRebase', 'Pull (Rebase)', '2_pull@2'],
    ['git.pullFrom', 'Pull from...', '2_pull@3'],
    ['git.push', 'Push', '3_push@1'],
    ['git.pushForce', 'Push (Force)', '3_push@2', FORCE],
    ['git.pushTo', 'Push to...', '3_push@3'],
    ['git.pushToForce', 'Push to... (Force)', '3_push@4', FORCE],
    ['git.fetch', 'Fetch', '4_fetch@1'],
    ['git.fetchPrune', 'Fetch (Prune)', '4_fetch@2'],
    ['git.fetchAll', 'Fetch From All Remotes', '4_fetch@3'],
  ],
  'workspaceChanges.branch': [
    ['git.merge', 'Merge...', '1_merge@1'],
    ['git.rebase', 'Rebase Branch...', '1_merge@2'],
    ['git.branch', 'Create Branch...', '2_branch@1'],
    ['git.branchFrom', 'Create Branch From...', '2_branch@2'],
    ['git.renameBranch', 'Rename Branch...', '3_modify@1'],
    ['git.deleteBranch', 'Delete Branch...', '3_modify@2'],
    ['git.deleteRemoteBranch', 'Delete Remote Branch...', '3_modify@3'],
    ['git.publish', 'Publish Branch...', '4_publish@1'],
  ],
  'workspaceChanges.stash': [
    ['git.stash', 'Stash', '1_stash@1'],
    ['git.stashIncludeUntracked', 'Stash (Include Untracked)', '1_stash@2'],
    ['git.stashStaged', 'Stash Staged', '1_stash@3', 'gitVersion2.35'],
    ['git.stashApplyLatest', 'Apply Latest Stash', '2_apply@1'],
    ['git.stashApply', 'Apply Stash...', '2_apply@2'],
    ['git.stashPopLatest', 'Pop Latest Stash', '3_pop@1'],
    ['git.stashPop', 'Pop Stash...', '3_pop@2'],
    ['git.stashDrop', 'Drop Stash...', '4_drop@1'],
    ['git.stashDropAll', 'Drop All Stashes...', '4_drop@2'],
    ['git.stashView', 'View Stash...', '5_preview@1'],
  ],
};

/** This extension's own repo actions, shown in the root menu after the submenus. */
const WORKSPACE_ITEMS = [
  ['workspaceChanges.createPr', '3_workspace@1', "webviewSection == 'repo' && nondefault"],
  ['workspaceChanges.checkoutDefault', '3_workspace@2', "webviewSection == 'repo' && nondefault"],
  ['workspaceChanges.openTerminal', '4_open@1'],
  ['workspaceChanges.revealInExplorer', '4_open@2'],
  ['workspaceChanges.hideRepo', '4_open@3'],
];

/** The Commit button's dropdown: same entries as the native one (extensions/git/src/postCommitCommands.ts). */
const COMMIT_BUTTON = [
  ['workspaceChanges.git.commit', '1_commit@1'],
  ['workspaceChanges.git.commitAmend', '1_commit@2'],
  ['workspaceChanges.commitAndPush', '2_post@1'],
  ['workspaceChanges.commitAndSync', '2_post@2'],
];

const wrapperId = (nativeId) => `workspaceChanges.${nativeId}`; // workspaceChanges.git.pull

/** Unique native commands used by the menu: { native, id, title, noRepoArg } */
function wrappers() {
  const seen = new Map();
  for (const items of Object.values(MENU)) {
    for (const [native, title, , , opts] of items) {
      if (!seen.has(native)) seen.set(native, { native, id: wrapperId(native), title, noRepoArg: !!(opts && opts.noRepoArg) });
    }
  }
  return [...seen.values()];
}

/** package.json contributions for the menu. */
function manifest() {
  const W = "webviewId == 'workspaceChanges.view'";
  const REPO = `${W} && webviewSection == 'repo'`;
  const and = (a, b) => (b ? `${a} && ${b}` : a);
  const webviewContext = [];
  for (const [native, , group, when] of MENU.root) webviewContext.push({ command: wrapperId(native), when: and(REPO, when), group });
  SUBMENUS.forEach((s, i) => webviewContext.push({ submenu: s.id, when: REPO, group: `2_main@${i + 1}` }));
  for (const [cmd, group, when] of WORKSPACE_ITEMS) webviewContext.push({ command: cmd, when: when ? `${W} && ${when}` : REPO, group });
  const COMMIT = `${W} && webviewSection == 'commit'`;
  for (const [cmd, group] of COMMIT_BUTTON) webviewContext.push({ command: cmd, when: COMMIT, group });
  const menus = { 'webview/context': webviewContext };
  for (const s of SUBMENUS) {
    menus[s.id] = MENU[s.id].map(([native, , group, when]) => (when ? { command: wrapperId(native), when, group } : { command: wrapperId(native), group }));
  }
  return {
    submenus: SUBMENUS.map((s) => ({ id: s.id, label: s.label })),
    commands: wrappers().map((w) => ({ command: w.id, title: w.title, category: 'Git' })),
    menus,
    hiddenFromPalette: wrappers().map((w) => w.id),
  };
}

module.exports = { SUBMENUS, MENU, WORKSPACE_ITEMS, COMMIT_BUTTON, wrappers, manifest, wrapperId };
