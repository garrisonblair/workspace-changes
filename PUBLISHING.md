# Publishing

The extension goes to two registries:

| Registry | Used by | Tool |
|---|---|---|
| [VS Code Marketplace](https://marketplace.visualstudio.com/vscode) | VS Code | `vsce` |
| [Open VSX](https://open-vsx.org) | Cursor, VSCodium, Windsurf, Gitpod… | `ovsx` |

The extension ID is `<publisher>.<name>` = `garrisonblair.workspace-changes` (from `package.json`). Use the same publisher ID on both registries.

## First release (by hand, once)

### 1. Get the `.vsix`

Every push to `main` runs **CI**, which tests and packages the extension with the official `vsce`. Open the repo's **Actions** tab → latest **CI** run → download the **vsix** artifact (it's a zip with the `.vsix` inside).

Or locally, with Node.js installed: `npx @vscode/vsce package`.

### 2. VS Code Marketplace

1. Go to <https://marketplace.visualstudio.com/manage> and sign in with a Microsoft account.
2. **Create publisher**: ID `garrisonblair` (permanent, must match `"publisher"` in `package.json`), any display name.
   If that ID is taken, pick another and change `"publisher"` in `package.json`.
3. On the publisher page: **New extension** → **Visual Studio Code** → upload the `.vsix`.
4. Wait for the validation scan (usually a few minutes); then it's live and searchable.

If the upload is rejected because the **display name already exists**, change `"displayName"` in `package.json` (e.g. *Workspace Changes – Multi-repo Git*), commit, and upload the new `.vsix`.

### 3. Open VSX (Cursor)

1. Sign in at <https://open-vsx.org> with GitHub.
2. Create an Eclipse account at <https://accounts.eclipse.org/user/register>, putting your GitHub username in the *GitHub Username* field.
3. On <https://open-vsx.org/user-settings/profile>: **Log in with Eclipse**, then **Show Publisher Agreement** → **Agree**.
4. On <https://open-vsx.org/user-settings/tokens>: **Generate New Token**, copy it (shown once).
5. In a terminal (Node.js needed):

   ```sh
   npx ovsx create-namespace garrisonblair -p <token>
   npx ovsx publish workspace-changes-0.4.1.vsix -p <token>
   ```

6. Cursor proxies Open VSX and scans new extensions before they show up in its search, so allow some time.
7. Optional: claim the namespace to get the *verified* mark (Open VSX wiki → Namespace Access).

### 4. Switch your own install

Uninstall the hand-installed build first (its ID is `local.workspace-changes`; having both would register the panel twice), then install *Workspace Changes* from the Extensions view.

## Later releases (automatic, on tag)

`.github/workflows/release.yml` publishes to both registries when you push a tag like `v0.4.2`, then creates a GitHub Release with the `.vsix`.

One-time setup:

1. **Marketplace, no token**: on <https://marketplace.visualstudio.com/manage> → your publisher → **Trusted Publishing**, add a policy for repository `garrisonblair/workspace-changes` and workflow `release.yml`. The workflow publishes with `vsce publish --oidc`, so there is no secret to store or rotate.
   (Azure DevOps personal access tokens, the old method, are retired on 1 December 2026.)
2. **Open VSX**: repo **Settings → Secrets and variables → Actions → New repository secret**, name `OVSX_TOKEN`, value = an Open VSX token. Without it, the Open VSX step is skipped.

Then for each release:

```sh
# bump "version" in package.json and add a CHANGELOG.md entry, then:
git commit -am "Release 0.4.2"
git tag v0.4.2
git push && git push --tags
```

The workflow refuses to publish if the tag doesn't match `package.json`'s version.
