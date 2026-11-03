# Changelog

## 1.0.0
- Sync status in the repo header like the native view: `⟳ 4↓ 0↑`, both counts whenever there is anything to pull or push (only `↓` for read-only remotes), with the native tooltips ("Pull 4 commits from origin/main"). Click `↓` to pull, `↑` to push, `⟳` (or a `0`) to sync; it spins while syncing. It replaces the separate sync button next to Commit.

## 0.5.6
- Pending states like the native view: while committing, the Commit button is disabled with a spinning icon ("Committing Changes...", "Committing & Pushing Changes..."); publish, sync, pull and push spin the sync button and disable ↓/↑; switching to the default branch spins the branch. A progress bar runs at the top of the panel while an operation is running. Covers operations started from the panel and its menus.

## 0.5.5
- Long file names no longer push the hover actions out of the row: the folder path gives way first, then the name truncates with an ellipsis, like the native view.

## 0.5.4
- First release published to the VS Code Marketplace by the release workflow (0.5.3 reached Open VSX only).

## 0.5.3
- Published automatically to both the VS Code Marketplace and Open VSX on every release, so VS Code and Cursor keep it up to date.

## 0.5.2
- Repo headers and their Staged Changes / Changes headers stay pinned at the top while scrolling, like the native view's sticky scroll (with its shadow); the next repo pushes them away.

## 0.5.1
- Go to File: file type icons now show in Cursor and other editors based on older VS Code versions. Icons are resolved from the active file icon theme with the same rules as VS Code's CSS; font-based themes like Seti are converted to SVG images.

## 0.5.0
- **Go to File in Shown Repositories** (`Cmd+Alt+P` / `Ctrl+Alt+P`): Cmd+P-style file search limited to the repos shown in the panel, with VS Code's Quick Open ranking, file icons, recently opened files, `:line:col` and open to the side.

## 0.4.1
- Collapse All / Expand All is a single title-bar toggle, like the native views.

## 0.4.0
- The repo `…` menu and right-click menu are VS Code's native menu, mirroring the Source Control `…` menu (Pull, Push, Clone, Checkout to..., Fetch, Commit ▸, Changes ▸, Pull, Push ▸, Branch ▸, Stash ▸, Show Git Output). Every entry acts on that repo.
- The Commit button dropdown is a native menu: Commit, Commit (Amend), Commit & Push, Commit & Sync.
- Collapse All button.
- Fix: Commit & Push / Commit & Sync now run the push / sync after committing.
- The message box follows the repo's input box (cleared after commits from menus, edits from the native view show up).

## 0.3.1
- Repo names in normal case, indented from the view edge; smaller branch label; tighter file rows.
- File names are never clipped by long folder paths.
- Tooltips on every action, styled like the workbench hover.

## 0.3.0
- File icons from the active file icon theme (port of VS Code's icon theme loader); official codicons everywhere.
- Header: click the branch to switch branch, click ↓/↑ to pull/push, Create Pull Request button.
- All repo actions go through the Git extension's own commands, so commit hooks, smart commit, save-before-commit and post-commit commands behave natively.

## 0.2.0
- Per-repo header with commit message box and Commit button, like the native view.

## 0.1.0
- First version: filtered Changes panel with live filters.
