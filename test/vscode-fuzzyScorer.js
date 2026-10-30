'use strict';
// Runs VS Code's own Quick Open scorer test suite (test/fixtures/vscode/fuzzyScorer.test.ts, copied
// unmodified from microsoft/vscode) against our port in src/fuzzyScorer.js.
// The test file's imports are replaced by shims; Node strips the TypeScript types.
// Usage: node test/vscode-fuzzyScorer.js   (exit code 1 on failure)
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// Tests for parts we did not port (symbol scorer, VS Code's internal cache-hash function).
const SKIP = [
  /fuzzyScore2/, /Workspace symbol search/, /cache key/, /repeated scoring hits the cache/, /mutating a prepared query/,
];

const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'vscode', 'fuzzyScorer.test.ts'), 'utf8')
  .replace(/^import [\s\S]*?;\s*$/gm, '');
const scorer = path.join(__dirname, '..', 'src', 'fuzzyScorer.js');

const prelude = `
import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as nodePath from 'node:path';
const require = createRequire(${JSON.stringify(__filename)});
const { compareItemsByFuzzyScore, prepareQuery, scoreFuzzy, scoreItemFuzzy, pieceToQuery } = require(${JSON.stringify(scorer)});
const scoreFuzzy2 = (): any => { throw new Error('scoreFuzzy2 is not ported'); };
const hash = (): any => { throw new Error('hash is not ported'); };
const { basename, dirname, posix, win32, sep } = nodePath;
const isWindows = process.platform === 'win32';
const Schemas = { file: 'file', vscodeRemote: 'vscode-remote' };
class URI {
  scheme: string; authority: string; path: string; fsPath: string;
  constructor(scheme: string, authority: string, p: string) {
    this.scheme = scheme; this.authority = authority || '';
    p = p.replace(/\\\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    this.path = p;
    this.fsPath = (this.authority && p.length > 1 && scheme === 'file') ? '//' + this.authority + p : (isWindows ? p.replace(/\\//g, '\\\\') : p);
  }
  static file(p: string) { return new URI('file', '', p); }
  static from(c: any) { return new URI(c.scheme, c.authority, c.path || ''); }
}
const ensureNoDisposablesAreLeakedInTestSuite = () => {};
const __tests: Array<[string, () => void]> = [];
const suite = (_name: string, fn: () => void) => fn();
const test = (name: string, fn: () => void) => { __tests.push([name, fn]); };
`;

const runner = `
const SKIP = [${SKIP.map(String).join(', ')}];
let passed = 0, skipped = 0, failed = 0;
for (const [name, fn] of __tests) {
  if (SKIP.some((r) => r.test(name))) { skipped++; continue; }
  try { fn(); passed++; } catch (e) { failed++; console.log('  ✗ ' + name + '\\n    ' + String(e && e.message).split('\\n').join('\\n    ')); }
}
console.log('  ✓ VS Code fuzzyScorer.test.ts: ' + passed + ' passed, ' + skipped + ' skipped (not ported), ' + failed + ' failed');
if (failed) process.exitCode = 1;
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fuzzy-'));
const file = path.join(tmp, 'fuzzyScorer.test.mts');
fs.writeFileSync(file, prelude + src + runner);
const r = cp.spawnSync(process.execPath, ['--no-warnings', file], { encoding: 'utf8' });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = r.status;
