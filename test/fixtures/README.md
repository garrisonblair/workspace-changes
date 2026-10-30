# Test fixtures

Copied from [microsoft/vscode](https://github.com/microsoft/vscode) (MIT License) so the icon-theme port can be tested against real data:

- `extensions/theme-seti/`: the built-in Seti file icon theme (`vs-seti-icon-theme.json`, `seti.woff`). Seti UI is by Jesse Weed, MIT License.
- `extensions/*/package.json`: the `contributes.languages` section of built-in language extensions.
- `vscode/fuzzyScorer.test.ts`: VS Code's Quick Open scorer test suite (`src/vs/base/test/common/fuzzyScorer.test.ts`), run unmodified against `src/fuzzyScorer.js` by `test/vscode-fuzzyScorer.js`.

`extensions/svg-icons/` is a small made-up SVG theme for testing image-based themes.
