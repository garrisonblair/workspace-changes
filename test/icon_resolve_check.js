// Prints JSON for test/webview_test.py: theme CSS + per-file expected icon from resolveFileIcon.
// Usage: node test/icon_resolve_check.js <themeId>
const fs = require('fs');
const path = require('path');
const IT = require('../src/iconTheme');
const FIX = path.join(__dirname, 'fixtures', 'extensions');
const exts = fs.readdirSync(FIX).map((d) => ({ extensionPath: path.join(FIX, d), packageJSON: JSON.parse(fs.readFileSync(path.join(FIX, d, 'package.json'), 'utf8')) }));
const theme = IT.loadIconTheme(exts, process.argv[2]);
const langs = new IT.LanguageRegistry(exts, {});
const names = new Set(['a.ts', 'App.tsx', 'x.test.ts', 'index.js', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'notes.txt',
  'Dockerfile', 'api.Dockerfile', 'docker-compose.yml', 'ci.yml', 'run.sh', '.bashrc', 'main.py', 'style.css', 'index.html', 'LICENSE', 'Makefile',
  '.gitignore', '.eslintrc.json', 'yarn.lock', 'favicon.ico', 'logo.svg', 'photo.png', 'data.csv', 'go.mod', 'main.go', 'Cargo.toml', 'lib.rs']);
const d = theme.doc;
for (const k of Object.keys(d.fileNames || {})) names.add(k.split('/').pop());
for (const k of Object.keys(d.fileExtensions || {})) names.add(`file.${k}`);
for (const k of Object.keys((d.light || {}).fileExtensions || {})) names.add(`light.${k}`);
const files = [...names].slice(0, 600).map((n) => {
  const p = `/repo/src/${n}`;
  const classes = IT.getIconClasses(p, langs.languageFor(p));
  return { name: n, classes: classes.join(' '), dark: IT.resolveFileIcon(d, classes, 'dark'), light: IT.resolveFileIcon(d, classes, 'light') };
});
const css = IT.buildIconThemeCss(d, (rel) => `/${path.relative(path.join(__dirname, '..'), path.join(theme.dir, rel)).split(path.sep).join('/')}`);
process.stdout.write(JSON.stringify({ css, files }));
