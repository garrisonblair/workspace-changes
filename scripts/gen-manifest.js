// Writes the repo menu from src/gitMenu.js into package.json (idempotent).
// Usage: node scripts/gen-manifest.js [--check]   (--check: exit 1 if package.json is out of date)
const fs = require('fs');
const path = require('path');
const GM = require('../src/gitMenu');

const file = path.join(__dirname, '..', 'package.json');
const before = fs.readFileSync(file, 'utf8');
const pkg = JSON.parse(before);
const c = pkg.contributes;
const gen = GM.manifest();
const isRepoEntry = (e) => /webviewSection == '(repo|commit)'/.test(e.when || '');
const isGenerated = (id) => id && id.startsWith('workspaceChanges.git.');

c.submenus = gen.submenus;
c.commands = c.commands.filter((x) => !isGenerated(x.command)).concat(gen.commands);
c.menus['webview/context'] = gen.menus['webview/context'].concat(c.menus['webview/context'].filter((e) => !isRepoEntry(e)));
for (const s of GM.SUBMENUS) c.menus[s.id] = gen.menus[s.id];
c.menus.commandPalette = c.menus.commandPalette.filter((e) => !isGenerated(e.command))
  .concat(gen.hiddenFromPalette.map((id) => ({ command: id, when: 'false' })));

const after = JSON.stringify(pkg, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (after !== before) { console.error('package.json is out of date: run node scripts/gen-manifest.js'); process.exit(1); }
  console.log('package.json up to date');
} else {
  fs.writeFileSync(file, after);
  console.log(`menu: ${gen.menus['webview/context'].length} root entries, ${GM.SUBMENUS.length} submenus, ${gen.commands.length} git commands`);
}
