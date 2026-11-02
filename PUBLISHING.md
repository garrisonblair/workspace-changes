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

## Releasing (automatic)

`.github/workflows/release.yml` runs on every push to `main`. When `package.json`'s `version` has no `v<version>` tag yet, it tests and packages the extension, publishes it, then creates the tag and a GitHub Release with the `.vsix` (notes taken from that version's `CHANGELOG.md` section). Otherwise it does nothing.

To release:

```sh
# bump "version" in package.json and add a "## <version>" section to CHANGELOG.md, then:
git commit -am "Release 0.5.3"
git push
```

Installed copies update themselves: VS Code and Cursor check the registries and auto-update extensions by default.

### Open VSX: trusted publishing (set up)

No token: the workflow gets a short-lived token from Open VSX using GitHub's OIDC identity (`ovsx publish --trusted-publishing`). The trusted publisher registered on open-vsx.org (Settings → Trusted Publishers) must name repository `garrisonblair/workspace-changes` and workflow file `release.yml`, with no deployment environment (or add the same `environment:` to the job).

Don't add an `OVSX_TOKEN` / `--pat`: a token takes precedence over trusted publishing.

### VS Code Marketplace (off until you turn it on)

1. On <https://marketplace.visualstudio.com/manage> → publisher → **Trusted Publishing**, add a policy for repository `garrisonblair/workspace-changes` and workflow `release.yml`.
2. Repo **Settings → Secrets and variables → Actions → Variables**: add `VSCE_PUBLISH` = `true`.

The first Marketplace version still has to be uploaded by hand (step 2 above), using the `.vsix` from a GitHub Release or CI run. Azure DevOps personal access tokens, the old method, are retired on 1 December 2026.
