// Helper for webview_test.py: prints { css, classes } for a theme using the real port in src/iconTheme.js.
// Usage: node test/icon_fixture.js <themeId> <baseUrl> <file paths...>
const fs = require('fs');
const path = require('path');
const IT = require('../src/iconTheme');
const [themeId, baseUrl, ...files] = process.argv.slice(2);
const root = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'extensions');
const exts = fs.readdirSync(FIX).map((d) => ({ extensionPath: path.join(FIX, d), packageJSON: JSON.parse(fs.readFileSync(path.join(FIX, d, 'package.json'), 'utf8')) }));
const theme = IT.loadIconTheme(exts, themeId);
const langs = new IT.LanguageRegistry(exts, {});
const url = (abs) => baseUrl + '/' + path.relative(root, abs).split(path.sep).join('/');
const css = IT.buildIconThemeCss(theme.doc, (rel) => url(path.join(theme.dir, rel)));
const classes = {};
for (const f of files) classes[f] = IT.getIconClasses(f, langs.languageFor(f)).join(' ');
process.stdout.write(JSON.stringify({ css, classes }));
