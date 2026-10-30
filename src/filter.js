'use strict';
// Pure logic (no vscode import) so it can be unit-tested with plain node.

/** git extension Status enum values we care about */
const Status = {
  INDEX_MODIFIED: 0, INDEX_ADDED: 1, INDEX_DELETED: 2, INDEX_RENAMED: 3, INDEX_COPIED: 4,
  MODIFIED: 5, DELETED: 6, UNTRACKED: 7, IGNORED: 8, INTENT_TO_ADD: 9, INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11, ADDED_BY_US: 12, ADDED_BY_THEM: 13, DELETED_BY_US: 14, DELETED_BY_THEM: 15,
  BOTH_ADDED: 16, BOTH_DELETED: 17, BOTH_MODIFIED: 18,
};

const STATUS_LABEL = {
  0: ['M', 'Index Modified'], 1: ['A', 'Index Added'], 2: ['D', 'Index Deleted'],
  3: ['R', 'Index Renamed'], 4: ['C', 'Index Copied'], 5: ['M', 'Modified'], 6: ['D', 'Deleted'],
  7: ['U', 'Untracked'], 8: ['I', 'Ignored'], 9: ['A', 'Intent to Add'], 10: ['R', 'Intent to Rename'],
  11: ['T', 'Type Changed'], 12: ['!', 'Added by Us'], 13: ['!', 'Added by Them'],
  14: ['!', 'Deleted by Us'], 15: ['!', 'Deleted by Them'], 16: ['!', 'Both Added'],
  17: ['!', 'Both Deleted'], 18: ['!', 'Both Modified'],
};

const CRITERIA = [
  { id: 'changes', label: 'Has changes', detail: 'Staged, unstaged, untracked or merge conflicts' },
  { id: 'nonDefaultBranch', label: 'Not on default branch', detail: 'Includes detached HEAD' },
  { id: 'unpushed', label: 'Has unpushed commits', detail: 'Ahead of upstream, or a non-default branch that is not published' },
  { id: 'behind', label: 'Behind upstream', detail: 'The remote has commits you have not pulled' },
];

/**
 * Collect the change groups of a repository state.
 * Untracked files can live in workingTreeChanges (git.untrackedChanges = "mixed")
 * or in untrackedChanges ("separate"); both end up in the "Changes" group, like the native view's default.
 */
function groupsOf(state) {
  const merge = state.mergeChanges || [];
  const index = state.indexChanges || [];
  const working = (state.workingTreeChanges || []).concat(state.untrackedChanges || []);
  return { merge, index, working };
}

function changeCount(state) {
  const g = groupsOf(state);
  return g.merge.length + g.index.length + g.working.length;
}

/**
 * Facts about a repo used for filtering and display.
 * @param state        git API RepositoryState
 * @param detected     default branch read from origin/HEAD, or undefined
 * @param fallbackNames branch names treated as default when detection fails
 */
function repoFacts(state, detected, fallbackNames) {
  const head = state.HEAD || {};
  const branch = head.name;
  const detached = !branch;
  let isDefault;
  if (detached) isDefault = false;
  else if (detected) isDefault = branch === detected;
  else isDefault = (fallbackNames || []).includes(branch);
  const hasUpstream = !!head.upstream;
  const ahead = head.ahead || 0;
  const behind = head.behind || 0;
  return {
    branch,
    detached,
    commit: head.commit,
    defaultBranch: detected || (fallbackNames && fallbackNames[0]),
    defaultDetected: !!detected,
    isDefault,
    hasUpstream,
    ahead,
    behind,
    changes: changeCount(state),
    unpublished: !detached && !hasUpstream && !isDefault,
  };
}

/** A repo is shown if it matches ANY selected criterion. No criteria = show everything. */
function matchesCriteria(facts, criteria) {
  if (!criteria || criteria.length === 0) return true;
  return criteria.some((c) => {
    switch (c) {
      case 'changes': return facts.changes > 0;
      case 'nonDefaultBranch': return !facts.isDefault;
      case 'unpushed': return facts.ahead > 0 || facts.unpublished;
      case 'behind': return facts.behind > 0;
      default: return false;
    }
  });
}

/**
 * Text filter on repo name/path and branch.
 * Terms separated by spaces or commas. Plain terms are OR'ed (repo shown if any matches),
 * "!term" excludes. Case-insensitive substring match. Empty filter matches everything.
 */
function matchesText(filter, haystacks) {
  const terms = String(filter || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = haystacks.filter(Boolean).map((h) => String(h).toLowerCase());
  const includes = terms.filter((t) => !t.startsWith('!'));
  const excludes = terms.filter((t) => t.startsWith('!')).map((t) => t.slice(1)).filter(Boolean);
  if (excludes.some((t) => hay.some((h) => h.includes(t)))) return false;
  if (includes.length === 0) return true;
  return includes.some((t) => hay.some((h) => h.includes(t)));
}

function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

/** hidden entries match the repo folder name or its workspace-relative path; * and ? wildcards allowed */
function isHidden(hiddenList, name, relPath) {
  return (hiddenList || []).some((p) => {
    const re = globToRegExp(p);
    return re.test(name) || (relPath && re.test(relPath));
  });
}

function branchLabel(facts) {
  if (facts.detached) return `detached @ ${(facts.commit || '').slice(0, 7)}`;
  let s = facts.branch;
  if (facts.ahead || facts.behind) {
    s += ' ';
    if (facts.ahead) s += `↑${facts.ahead}`;
    if (facts.behind) s += `↓${facts.behind}`;
  } else if (facts.unpublished) {
    s += ' (unpublished)';
  }
  return s;
}

module.exports = {
  Status, STATUS_LABEL, CRITERIA,
  groupsOf, changeCount, repoFacts, matchesCriteria, matchesText, isHidden, globToRegExp, branchLabel,
};
