'use strict';
// Build "create pull request" URLs from a git remote. Pure, unit-testable.

/**
 * Parse a git remote URL into { kind, host, path }.
 * Handles https://host/a/b(.git), ssh://git@host[:port]/a/b(.git), git@host:a/b(.git),
 * and Azure DevOps (dev.azure.com, *.visualstudio.com, ssh.dev.azure.com:v3/org/project/repo).
 */
function parseRemote(url) {
  if (!url) return null;
  let host;
  let p;
  let m;
  if ((m = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i))) { host = m[1]; p = m[2]; }
  else if ((m = url.match(/^(?:[^@]+@)?([^:/]+):(.+)$/))) { host = m[1]; p = m[2]; }
  else return null;
  host = host.toLowerCase();
  p = p.replace(/\.git$/i, '').replace(/\/+$/, '');

  // Azure DevOps
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    const seg = p.replace(/^v3\//, '').split('/');
    if (seg.length >= 3) return { kind: 'azure', host: 'dev.azure.com', path: `${seg[0]}/${seg[1]}/_git/${seg.slice(2).join('/')}` };
  }
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
    if (host.endsWith('.visualstudio.com')) {
      const org = host.split('.')[0];
      p = p.replace(/^DefaultCollection\//i, '');
      return { kind: 'azure', host: 'dev.azure.com', path: `${org}/${p}` };
    }
    return { kind: 'azure', host, path: p };
  }
  let kind = 'github';
  if (host.includes('gitlab')) kind = 'gitlab';
  else if (host.includes('bitbucket')) kind = 'bitbucket';
  return { kind, host, path: p };
}

/** Web URL that opens the "new pull request" page for `branch` (into `base` when known). */
function createPullRequestUrl(remoteUrl, branch, base) {
  const r = parseRemote(remoteUrl);
  if (!r || !branch) return null;
  const enc = encodeURIComponent;
  const web = `https://${r.host}/${r.path}`;
  switch (r.kind) {
    case 'gitlab': {
      let u = `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${enc(branch)}`;
      if (base) u += `&merge_request%5Btarget_branch%5D=${enc(base)}`;
      return u;
    }
    case 'bitbucket':
      return `${web}/pull-requests/new?source=${enc(branch)}${base ? `&dest=${enc(base)}` : ''}`;
    case 'azure':
      return `${web}/pullrequestcreate?sourceRef=${enc(branch)}${base ? `&targetRef=${enc(base)}` : ''}`;
    default: {
      // keep "/" readable in branch names inside the path (feat/x)
      const seg = (s) => enc(s).replace(/%2F/gi, '/');
      return base
        ? `${web}/compare/${seg(base)}...${seg(branch)}?expand=1`
        : `${web}/compare/${seg(branch)}?expand=1`;
    }
  }
}

module.exports = { parseRemote, createPullRequestUrl };
