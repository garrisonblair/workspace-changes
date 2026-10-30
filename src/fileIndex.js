'use strict';
// File lists for "Go to File in Shown Repositories". No `vscode` import (unit-testable).
//
// Files come from git, like Cmd+P with search.useIgnoreFiles: tracked + untracked files,
// minus .gitignore'd ones (`git ls-files --cached --others --exclude-standard`), minus files
// deleted from the working tree, minus `files.exclude` / `search.exclude` globs.

const cp = require('child_process');
const path = require('path');
const { globToRegExp } = require('./iconTheme');

function gitLines(gitPath, cwd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(gitPath || 'git', args, { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout.split('\0').filter(Boolean));
    });
  });
}

/** Repo-relative paths (forward slashes) of the files Cmd+P would offer in this repo. */
async function listRepoFiles(gitPath, root) {
  const [all, deleted] = await Promise.all([
    gitLines(gitPath, root, ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    gitLines(gitPath, root, ['-c', 'core.quotepath=off', 'ls-files', '-z', '--deleted']),
  ]);
  const gone = new Set(deleted);
  return [...new Set(all)].filter((f) => !gone.has(f));
}

/**
 * Matcher for `files.exclude` + `search.exclude` (only entries set to `true`, as in VS Code;
 * `{ when: ... }` sibling rules are not supported). Patterns are relative to the workspace folder;
 * a pattern matching a folder excludes everything inside it.
 */
function excludeMatcher(...settings) {
  const res = [];
  for (const s of settings) {
    for (const [pattern, on] of Object.entries(s || {})) if (on === true) res.push(globToRegExp(pattern.replace(/\/+$/, '')));
  }
  if (!res.length) return () => false;
  return (folderRelPath) => {
    const parts = folderRelPath.split('/');
    for (let i = parts.length; i > 0; i--) {
      const p = parts.slice(0, i).join('/');
      if (res.some((r) => r.test(p))) return true;
    }
    return false;
  };
}

/**
 * Build Quick Open entries for one repo.
 * @param root        absolute repo root
 * @param repoLabel   name shown for the repo (first segment of the description)
 * @param files       repo-relative paths from listRepoFiles
 * @param folderPrefix path of the repo relative to its workspace folder ('' when the repo is the folder)
 * @param isExcluded  matcher from excludeMatcher (gets workspace-folder-relative paths)
 * Description is "<repo>/<dir>", which is also what the scorer matches path queries against.
 */
function buildEntries(root, repoLabel, files, folderPrefix, isExcluded) {
  const out = [];
  for (const rel of files) {
    const folderRel = folderPrefix ? `${folderPrefix}/${rel}` : rel;
    if (isExcluded(folderRel)) continue;
    const slash = rel.lastIndexOf('/');
    const label = slash >= 0 ? rel.slice(slash + 1) : rel;
    const dir = slash >= 0 ? rel.slice(0, slash) : '';
    out.push({
      label,
      description: dir ? `${repoLabel}/${dir}` : repoLabel,
      fsPath: path.join(root, ...rel.split('/')),
      root,
    });
  }
  return out;
}

/**
 * Line/column suffix like Cmd+P: "file.ts:12", "file.ts:12:4", "file.ts#12".
 * Returns { query, line?, column? } with 1-based numbers.
 */
function parseLineSuffix(value) {
  const m = /^(.*?)(?::(\d+)(?::(\d+))?|#(\d+)(?:[,:](\d+))?):?$/.exec(value.trim());
  if (!m || !m[1]) return { query: value.trim().replace(/[:#]$/, '') };
  const line = Number(m[2] || m[4]);
  const column = m[3] || m[5] ? Number(m[3] || m[5]) : undefined;
  return { query: m[1], line, column };
}

module.exports = { listRepoFiles, excludeMatcher, buildEntries, parseLineSuffix };
