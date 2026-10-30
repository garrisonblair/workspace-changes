'use strict';
// File icons for QuickPick items, as images (QuickPickItem.iconPath).
//
// Newer VS Code derives a quick pick item's icon from `resourceUri` + ThemeIcon.File, but older hosts
// (including Cursor, based on VS Code 1.99) don't, and show no icon. So we resolve the icon ourselves
// from the active file icon theme (same rules as VS Code's CSS, see iconTheme.resolveFileIcon):
//  - image themes (Material Icon Theme, vscode-icons...): the theme's own SVG/PNG file
//  - font themes (Seti, the default): the glyph converted to an SVG file in global storage
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const IT = require('./iconTheme');
const FG = require('./fontGlyph');

class FileIconImages {
  /** @param view WorkspaceChangesView (owns the loaded icon theme and language registry) */
  constructor(context, view) {
    this.context = context;
    this.view = view;
    this.cache = new Map(); // `${themeKey}\0${classes}` -> iconPath
    this.fonts = new Map(); // fontId -> Font | null
    this.themeKey = undefined;
  }

  get theme() { return this.view.iconTheme && this.view.iconTheme.doc ? this.view.iconTheme : null; }

  /** Reset caches when the icon theme changed. */
  sync() {
    const t = this.theme;
    const key = t ? `${t.id}\0${t.dir}` : '';
    if (key !== this.themeKey) {
      this.themeKey = key;
      this.cache.clear();
      this.fonts.clear();
    }
    return t;
  }

  /** iconPath for a file: { light, dark } image URIs, ThemeIcon.File as a fallback, undefined with no icon theme. */
  iconFor(uri) {
    const t = this.sync();
    if (!t) return undefined;
    const classes = IT.getIconClasses(uri.path || uri.fsPath, this.view.languageOf(uri));
    const key = classes.join(' ');
    if (this.cache.has(key)) return this.cache.get(key);
    let icon;
    try {
      const dark = this.image(t, IT.resolveFileIcon(t.doc, classes, 'dark'));
      const light = this.image(t, IT.resolveFileIcon(t.doc, classes, 'light')) || dark;
      icon = dark ? { light, dark } : vscode.ThemeIcon.File;
    } catch (_) {
      icon = vscode.ThemeIcon.File;
    }
    this.cache.set(key, icon);
    return icon;
  }

  image(t, def) {
    if (!def) return undefined;
    if (def.iconPath) return vscode.Uri.file(path.join(t.dir, def.iconPath));
    if (!def.fontCharacter) return undefined;
    const fontId = def.fontId || (t.doc.fonts && t.doc.fonts[0] && t.doc.fonts[0].id);
    const font = this.font(t, fontId);
    if (!font) return undefined;
    const cp = parseInt(String(def.fontCharacter).replace(/^\\+/, ''), 16);
    if (!cp) return undefined;
    const pct = (v) => parseFloat(IT.tryNormalizeFontSize(v) || '') || undefined;
    const fonts = t.doc.fonts || [];
    const defaultSize = pct(fonts[0] && fonts[0].size) || 150; // VS Code's default when the theme sets none
    const fontEntry = fonts.find((f) => f.id === fontId);
    const size = pct(def.fontSize) || (fontEntry && pct(fontEntry.size)) || defaultSize;
    const svg = FG.glyphSvg(font, cp, def.fontColor, size / 100); // e.g. Seti 150% → 1.5 × 13px
    if (!svg) return undefined;
    const dir = path.join(this.context.globalStorageUri.fsPath, 'file-icons');
    const name = crypto.createHash('sha1').update(svg).digest('hex').slice(0, 16) + '.svg';
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, svg);
    }
    return vscode.Uri.file(file);
  }

  font(t, fontId) {
    if (this.fonts.has(fontId)) return this.fonts.get(fontId);
    let font = null;
    const def = (t.doc.fonts || []).find((f) => f.id === fontId);
    for (const src of (def && def.src) || []) {
      try {
        font = FG.loadFont(fs.readFileSync(path.join(t.dir, src.path)));
      } catch (_) { font = null; }
      if (font) break;
    }
    this.fonts.set(fontId, font);
    return font;
  }
}

module.exports = { FileIconImages };
