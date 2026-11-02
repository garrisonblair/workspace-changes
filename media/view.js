// Webview script for the Workspace Changes view.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  /** ui state persisted across reloads: collapsed sections + unsent commit message drafts */
  const ui = Object.assign({ collapsed: {}, drafts: {} }, vscode.getState() || {});
  const save = () => vscode.setState(ui);

  let model = null;
  let lastJson = '';

  // ------------------------------------------------------------------ icons: official codicons (media/codicons.js)
  const C = window.CODICONS || {};
  const I = {
    chevronRight: C['chevron-right'], chevronDown: C['chevron-down'], check: C.check, add: C.add, remove: C.remove,
    discard: C.discard, openFile: C['go-to-file'], branch: C['git-branch'], sync: C.sync, cloudUp: C['cloud-upload'],
    more: C.ellipsis, caretDown: C['chevron-down'], arrowUp: C['arrow-up'], arrowDown: C['arrow-down'],
    pr: C['git-pull-request-create'], loading: C.loading,
  };
  /** codicon with VS Code's `~spin` modifier (codicon-modifier-spin) */
  const spin = (svg) => (svg || '').replace('class="codicon ', 'class="codicon codicon-modifier-spin ');

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = (o) => esc(JSON.stringify(Object.assign({ preventDefaultContextMenuItems: true }, o)));
  const btn = (act, icon, title, extra = '') => `<button class="icon-btn" data-act="${act}" data-tip="${esc(title)}" aria-label="${esc(title)}" ${extra}>${icon}</button>`;

  function isCollapsed(key, defaultCollapsed) {
    return key in ui.collapsed ? ui.collapsed[key] : defaultCollapsed;
  }

  // ------------------------------------------------------------------ render
  function renderRepo(r) {
    const key = r.root;
    const collapsed = isCollapsed(key, !(r.changes > 0 || r.primary.enabled));
    const dirtyStar = r.changes > 0 ? '*' : '';
    const sync = [];
    if (r.behind) sync.push(`${r.behind}↓`);
    if (r.ahead) sync.push(`${r.ahead}↑`);
    const branchTitle = r.detached
      ? `Detached HEAD at ${r.branch}`
      : (r.isDefault ? `${r.branch} (default branch)` : `${r.branch}: not the default branch (${r.defaultBranch || '?'}${r.defaultDetected ? '' : ', guessed'})`);

    const b = r.busy || {};
    const actions = [];
    if (r.canCreatePr) actions.push(btn('createPr', I.pr, 'Create Pull Request'));
    if (r.unpublished && r.hasRemote) {
      actions.push(b.sync
        ? btn('publish', spin(I.sync), `Publishing Branch "${r.branch}"...`, 'disabled data-busy')
        : btn('publish', I.cloudUp, 'Publish Branch'));
    } else if (r.ahead || r.behind || b.sync) {
      actions.push(b.sync
        ? btn('sync', spin(I.sync), 'Synchronizing Changes...', 'disabled data-busy')
        : btn('sync', I.sync, `Synchronize Changes ${sync.join(' ')}`));
    }
    if (r.changes > 0 || b.commit) {
      actions.push(b.commit
        ? btn('commit', I.check, 'Committing Changes...', 'disabled')
        : btn('commit', I.check, 'Commit'));
    }
    actions.push(btn('more', I.more, 'More Actions…'));

    const counts = [];
    const syncOff = b.sync ? ` disabled data-tip="${b.syncDetail === 'pull' ? 'Pulling' : b.syncDetail === 'push' ? 'Pushing' : 'Synchronizing'} Changes..."` : '';
    if (r.behind) counts.push(`<button class="link ahead-behind" data-act="pull" ${syncOff || `data-tip="Pull ${r.behind} incoming commit${r.behind > 1 ? 's' : ''}"`}>${I.arrowDown}<span>${r.behind}</span></button>`);
    if (r.ahead) counts.push(`<button class="link ahead-behind" data-act="push" ${syncOff || `data-tip="Push ${r.ahead} outgoing commit${r.ahead > 1 ? 's' : ''}"`}>${I.arrowUp}<span>${r.ahead}</span></button>`);

    let html = `<section class="repo${collapsed ? ' collapsed' : ''}" data-root="${esc(r.root)}">`;
    html += `<div class="row repo-header" data-toggle="${esc(key)}" data-vscode-context="${ctx({ webviewSection: 'repo', root: r.root, nondefault: !r.isDefault, dirty: r.changes > 0 })}">`
      + `<span class="twistie">${collapsed ? I.chevronRight : I.chevronDown}</span>`
      + `<span class="repo-name" data-tip="${esc(r.root)}">${esc(r.label)}</span>`
      + (b.checkout
        ? `<button class="link branch${r.isDefault ? '' : ' nondefault'}" data-act="checkoutBranch" disabled data-tip="Checking Out Branch...">${spin(I.loading)}<span class="branch-name">${esc(r.branch)}${dirtyStar}</span></button>`
        : `<button class="link branch${r.isDefault ? '' : ' nondefault'}" data-act="checkoutBranch" data-tip="${esc(branchTitle)}\nClick to checkout another branch">${I.branch}<span class="branch-name">${esc(r.branch)}${dirtyStar}</span></button>`)
      + counts.join('')
      + (r.unpublished ? '<span class="tag" data-tip="This branch has no upstream branch on the remote yet">unpublished</span>' : '')
      + `<span class="spacer"></span><span class="actions always">${actions.join('')}</span>`
      + '</div>';

    if (!collapsed) {
      const draft = key in ui.drafts ? ui.drafts[key] : r.inputValue;
      const shortcut = model.mac ? '⌘⏎' : 'Ctrl+Enter';
      const placeholder = `Message (${shortcut} to commit on "${r.branch}")`;
      html += '<div class="repo-body">';
      html += `<div class="input-wrap"><textarea rows="1" class="message" data-root="${esc(r.root)}" placeholder="${esc(placeholder)}" aria-label="Commit message for ${esc(r.label)}" spellcheck="true">${esc(draft)}</textarea></div>`;
      const p = r.primary;
      // like the native action button: the icon becomes a spinning `sync` while the operation runs
      const pIcon = p.busy ? spin(I.sync) : p.kind === 'publish' ? I.cloudUp : p.kind === 'sync' ? I.sync : I.check;
      const pTip = p.busy ? p.tip : p.kind === 'publish' ? `Publish Branch "${r.branch}"` : p.kind === 'sync' ? `Synchronize Changes (${sync.join(' ')})` : `Commit Changes on "${r.branch}"`;
      html += `<div class="commit-row"><button class="primary" data-act="primary" data-tip="${esc(pTip)}" ${p.enabled ? '' : 'disabled'}>${pIcon}<span>${esc(p.label)}</span></button>`
        + `<button class="primary dropdown" data-act="commitMenu" data-tip="More Actions…" aria-label="More commit actions" data-vscode-context="${ctx({ webviewSection: 'commit', root: r.root })}" ${r.changes > 0 && !p.busy ? '' : 'disabled'}>${I.caretDown}</button></div>`;

      for (const g of r.groups) {
        const gkey = `${key}|${g.key}`;
        const gcol = isCollapsed(gkey, false);
        const gacts = g.key === 'index'
          ? btn('group:unstage', I.remove, 'Unstage All Changes')
          : (g.key === 'working' ? btn('group:discard', I.discard, 'Discard All Changes') : '') + btn('group:stage', I.add, 'Stage All Changes');
        html += `<div class="group${gcol ? ' collapsed' : ''}" data-group="${g.key}">`;
        html += `<div class="row group-header" data-toggle="${esc(gkey)}" data-vscode-context="${ctx({ webviewSection: 'group', root: r.root, group: g.key })}">`
          + `<span class="twistie">${gcol ? I.chevronRight : I.chevronDown}</span><span class="group-label">${esc(g.label)}</span>`
          + `<span class="spacer"></span><span class="actions">${gacts}</span><span class="count" data-tip="${g.count} ${g.count === 1 ? 'change' : 'changes'}">${g.count}</span></div>`;
        if (!gcol) {
          html += '<div class="files">';
          for (const f of g.files) {
            let facts = btn('file:openFile', I.openFile, 'Open File');
            if (g.key === 'working') facts += btn('file:discard', I.discard, 'Discard Changes') + btn('file:stage', I.add, 'Stage Changes');
            else if (g.key === 'merge') facts += btn('file:stage', I.add, 'Stage Changes');
            else facts += btn('file:unstage', I.remove, 'Unstage Changes');
            html += `<div class="row file ${f.cls}" tabindex="0" data-uri="${esc(f.uri)}" data-tip="${esc((f.dir ? f.dir + '/' : '') + f.name)} • ${esc(f.statusText)}" `
              + `data-vscode-context="${ctx({ webviewSection: 'file', root: r.root, group: g.key, uri: f.uri, untracked: f.untracked })}">`
              + `<span class="file-icon-label ${esc(f.iconClasses || 'file-icon')}"></span><span class="file-name">${esc(f.name)}</span><span class="file-dir">${esc(f.dir)}</span>`
              + `<span class="spacer"></span><span class="actions">${facts}</span><span class="letter" data-tip="${esc(f.statusText)}">${esc(f.letter)}</span></div>`;
          }
          if (g.count > g.files.length) html += `<div class="row more-files">… and ${g.count - g.files.length} more</div>`;
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    return html + '</section>';
  }

  function renderEmpty() {
    const why = model.textFilter
      ? `No repositories match the current filter and “${esc(model.textFilter)}”.`
      : 'No repositories match the current filter.';
    return `<div class="empty"><p>${model.total === 0 ? 'No Git repositories found in this workspace.' : why}</p>`
      + (model.total ? '<button class="primary" data-cmd="workspaceChanges.chooseCriteria">Change Filter</button>'
        + '<button class="secondary" data-cmd="workspaceChanges.showAll">Show All Repositories</button>'
        + (model.textFilter ? '<button class="secondary" data-cmd="workspaceChanges.clearTextFilter">Clear Name Filter</button>' : '') : '')
      + '</div>';
  }

  function render() {
    if (!model) return;
    // keep focus, caret and scroll across re-renders
    const ae = document.activeElement;
    const focus = ae && ae.classList && ae.classList.contains('message')
      ? { root: ae.dataset.root, s: ae.selectionStart, e: ae.selectionEnd } : null;
    const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;

    app.className = model.fileIcons ? 'show-file-icons' : '';
    app.innerHTML = model.repos.length ? model.repos.map(renderRepo).join('') : renderEmpty();

    document.querySelectorAll('textarea.message').forEach(autoGrow);
    if (focus) {
      const ta = findTextarea(focus.root);
      if (ta) { ta.focus(); ta.setSelectionRange(focus.s, focus.e); }
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
    if (tipFor && !document.body.contains(tipFor)) hideTip(); // hovered element was replaced
    reportCollapseState();
    updateStuck();
  }

  /** Mark the lowest header currently stuck to the top, so it can draw the sticky-scroll shadow. */
  function updateStuck() {
    let last = null;
    for (const section of document.querySelectorAll('section.repo')) {
      const top = section.getBoundingClientRect().top;
      const header = section.querySelector('.repo-header');
      if (!header || top >= 0 || section.getBoundingClientRect().bottom <= header.offsetHeight) continue;
      last = header; // this repo is scrolled under the top: its header is stuck
      for (const group of section.querySelectorAll('.group')) {
        const g = group.getBoundingClientRect();
        if (g.top < header.offsetHeight && g.bottom > header.offsetHeight * 2) last = group.querySelector('.group-header');
      }
    }
    for (const el of document.querySelectorAll('.stuck-last')) if (el !== last) el.classList.remove('stuck-last');
    if (last) last.classList.add('stuck-last');
  }
  let stuckFrame = 0;
  window.addEventListener('scroll', () => {
    if (!stuckFrame) stuckFrame = requestAnimationFrame(() => { stuckFrame = 0; updateStuck(); });
  }, { passive: true });
  window.addEventListener('resize', () => updateStuck());

  /** Drives the title bar toggle: Collapse All ⇄ Expand All, like the native views. */
  let lastAllCollapsed;
  function reportCollapseState() {
    const all = model.repos.length > 0 && model.repos.every((r) => isCollapsed(r.root, !(r.changes > 0 || r.primary.enabled)));
    if (all === lastAllCollapsed) return;
    lastAllCollapsed = all;
    vscode.postMessage({ type: 'collapseState', allCollapsed: all });
  }

  function findTextarea(root) {
    return [...document.querySelectorAll('textarea.message')].find((t) => t.dataset.root === root);
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    // an empty box stays one line even if the placeholder would wrap
    if (!ta.value) { ta.style.height = '26px'; return; }
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }

  // ------------------------------------------------------------------ actions
  function repoRootOf(el) {
    const s = el.closest('section.repo');
    return s && s.dataset.root;
  }

  function messageFor(root) {
    const ta = findTextarea(root);
    if (ta) return ta.value;
    return root in ui.drafts ? ui.drafts[root] : ((model.repos.find((r) => r.root === root) || {}).inputValue || '');
  }

  function commit(root, mode) {
    const value = messageFor(root);
    if (!value.trim() && mode !== 'amend') {
      const ta = findTextarea(root);
      if (ta) {
        ta.parentElement.classList.add('error');
        ta.focus();
        setTimeout(() => ta.parentElement.classList.remove('error'), 1500);
      } else {
        // collapsed: expand so the user can type
        ui.collapsed[root] = false; save(); render();
        const t = findTextarea(root); if (t) t.focus();
      }
      return;
    }
    vscode.postMessage({ type: 'commit', root, value, mode: mode || 'commit' });
  }

  app.addEventListener('click', (ev) => {
    const cmd = ev.target.closest('[data-cmd]');
    if (cmd) { vscode.postMessage({ type: 'command', id: cmd.dataset.cmd }); return; }

    const actEl = ev.target.closest('[data-act]');
    if (actEl) {
      ev.stopPropagation();
      if (actEl.disabled) return;
      const root = repoRootOf(actEl);
      const act = actEl.dataset.act;
      if (act === 'commit') return commit(root, 'commit');
      if (act === 'primary') {
        const r = model.repos.find((x) => x.root === root);
        if (r && r.primary.kind === 'commit') return commit(root, 'commit');
        return vscode.postMessage({ type: 'primary', root, value: messageFor(root) });
      }
      if (act === 'more' || act === 'commitMenu') return openNativeMenu(actEl);
      if (['publish', 'sync', 'pull', 'push', 'checkoutBranch', 'createPr'].includes(act)) {
        return vscode.postMessage({ type: 'repoAction', root, action: act });
      }
      const [scope, action] = act.split(':');
      const groupEl = actEl.closest('.group');
      const group = groupEl && groupEl.dataset.group;
      if (scope === 'group') return vscode.postMessage({ type: 'groupAction', root, group, action });
      if (scope === 'file') {
        const fileEl = actEl.closest('.file');
        return vscode.postMessage({ type: 'fileAction', root, group, uri: fileEl.dataset.uri, action });
      }
      return;
    }

    const file = ev.target.closest('.row.file');
    if (file) {
      const groupEl = file.closest('.group');
      vscode.postMessage({ type: 'fileAction', root: repoRootOf(file), group: groupEl.dataset.group, uri: file.dataset.uri, action: 'open' });
      return;
    }

    const toggle = ev.target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      const section = toggle.closest('.group') || toggle.closest('section.repo');
      ui.collapsed[key] = !section.classList.contains('collapsed');
      save();
      render();
    }
  });

  app.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (t.classList && t.classList.contains('message') && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      commit(t.dataset.root, 'commit');
      return;
    }
    if (t.classList && t.classList.contains('file') && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      t.click();
    }
  });

  const inputTimers = {};
  function postInput(root) {
    clearTimeout(inputTimers[root]);
    inputTimers[root] = null;
    const ta = findTextarea(root);
    if (ta) vscode.postMessage({ type: 'input', root, value: ta.value });
  }
  /** Send any not-yet-synced commit messages now (native git commands read the repo's input box). */
  function flushInputs() {
    for (const root of Object.keys(inputTimers)) if (inputTimers[root]) postInput(root);
  }

  /**
   * Show VS Code's own context menu (webview/context) for this element, anchored under it,
   * exactly like the native "…" in the Source Control view. VS Code's webview host turns a
   * contextmenu event into its native menu, using the nearest data-vscode-context.
   */
  function openNativeMenu(el) {
    flushInputs();
    hideTip();
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: Math.round(r.left), clientY: Math.round(r.bottom) }));
  }
  // right-click menus run native commands too: make sure they see the latest message
  document.addEventListener('contextmenu', flushInputs, true);

  app.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t.classList.contains('message')) return;
    const root = t.dataset.root;
    ui.drafts[root] = t.value;
    save();
    autoGrow(t);
    t.parentElement.classList.remove('error');
    clearTimeout(inputTimers[root]);
    inputTimers[root] = setTimeout(() => postInput(root), 300);
  });

  /**
   * The repo's input box can change outside this page (a commit from the native menu or the
   * native view clears it, the native view's box is edited...). Take that value unless the user
   * is typing here right now.
   */
  const lastInput = {};
  function adoptExternalInput() {
    for (const r of model.repos) {
      const prev = lastInput[r.root];
      lastInput[r.root] = r.inputValue;
      if (prev === undefined || r.inputValue === prev || inputTimers[r.root]) continue;
      const ta = findTextarea(r.root);
      const typingHere = ta && document.activeElement === ta;
      if (typingHere && r.inputValue !== '') continue;
      ui.drafts[r.root] = r.inputValue;
    }
    save();
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'render') {
      const json = JSON.stringify(m.model);
      if (json === lastJson) return;
      lastJson = json;
      model = m.model;
      adoptExternalInput();
      render();
    } else if (m.type === 'setAllCollapsed') {
      if (!model) return;
      for (const r of model.repos) ui.collapsed[r.root] = m.collapsed;
      save();
      render();
    } else if (m.type === 'committed') {
      delete ui.drafts[m.root];
      save();
      const ta = findTextarea(m.root);
      if (ta) { ta.value = ''; autoGrow(ta); }
    }
  });

  // ------------------------------------------------------------------ tooltips (VS Code-style hover; native title tooltips are unreliable in webviews)
  const tip = document.createElement('div');
  tip.className = 'hover-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let tipTimer = null;
  let tipFor = null;
  let tipShownAt = 0;

  function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = null;
    tipFor = null;
    if (tip.classList.contains('visible')) tipShownAt = Date.now();
    tip.classList.remove('visible');
  }

  function showTip(el) {
    if (!document.body.contains(el)) return;
    tip.textContent = el.dataset.tip;
    tip.classList.add('visible');
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let left = Math.round(r.left + r.width / 2 - t.width / 2);
    left = Math.max(4, Math.min(left, vw - t.width - 4));
    let top = Math.round(r.bottom + 4);
    if (top + t.height > vh - 4) top = Math.round(r.top - t.height - 4);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(4, top) + 'px';
  }

  document.addEventListener('mouseover', (ev) => {
    const el = ev.target.closest && ev.target.closest('[data-tip]');
    if (el === tipFor) return;
    const wasVisible = tip.classList.contains('visible') || Date.now() - tipShownAt < 300;
    hideTip();
    if (!el || !el.dataset.tip) return;
    tipFor = el;
    // moving between controls while a hover is up shows the next one immediately, like the workbench
    tipTimer = setTimeout(() => showTip(el), wasVisible ? 0 : 500);
  });
  document.addEventListener('mouseleave', hideTip);
  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('keydown', hideTip, true);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);

  vscode.postMessage({ type: 'ready' });
}());
