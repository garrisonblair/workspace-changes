'use strict';
// File icons exactly like VS Code: a port of
//   src/vs/workbench/services/themes/browser/fileIconThemeData.ts  (theme JSON -> CSS rules)
//   src/vs/editor/common/services/getIconClasses.ts                (file -> CSS classes)
//   src/vs/editor/common/services/languagesAssociations.ts          (file -> language id)
// so a file gets the same icon here as in the Explorer and the native Source Control view.
// No `vscode` import: everything host-specific is passed in, so this is unit-testable.

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ JSONC (theme files may have comments / trailing commas)

function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas (outside strings: strings were copied verbatim, commas inside them are followed by other chars)
  out = out.replace(/,(\s*[}\]])/g, '$1');
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return JSON.parse(out);
}

// ------------------------------------------------------------------ CSS helpers (port of base/browser/cssValue.ts)

/** CSS.escape polyfill (https://drafts.csswg.org/cssom/#serialize-an-identifier) */
function cssEscape(value) {
  const s = String(value);
  const len = s.length;
  let result = '';
  const first = s.charCodeAt(0);
  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    if (code === 0) { result += '�'; continue; }
    if ((code >= 0x1 && code <= 0x1f) || code === 0x7f
      || (i === 0 && code >= 0x30 && code <= 0x39)
      || (i === 1 && code >= 0x30 && code <= 0x39 && first === 0x2d)) {
      result += '\\' + code.toString(16) + ' ';
      continue;
    }
    if (i === 0 && len === 1 && code === 0x2d) { result += '\\' + s.charAt(i); continue; }
    if (code >= 0x80 || code === 0x2d || code === 0x5f
      || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      result += s.charAt(i);
      continue;
    }
    result += '\\' + s.charAt(i);
  }
  return result;
}

const stringValue = (v) => `'${String(v).replace(/'/g, '\\000027')}'`;
const sizeValue = (v) => String(v).replace(/[^\w.%+-]/gi, '');
const hexColorValue = (v) => String(v).replace(/[^0-9a-fA-F#]/g, '');
const identValue = (v) => String(v || '').replace(/[^_\-a-z0-9]/gi, '');
const asCSSUrl = (url) => `url('${cssEscape(url)}')`;
const fontColorRegex = /^#[0-9A-Fa-f]{3,8}$/;
const fontSizeRegex = /^([\w_.%+-]+)$/;

function fileIconSelectorEscape(str) { return str.replace(/[\s]/g, '/'); }
function classSelectorPart(str) { return cssEscape(fileIconSelectorEscape(str)); }

function handleParentFolder(key, selectors) {
  const i = key.lastIndexOf('/');
  if (i >= 0) {
    selectors.push(`.${classSelectorPart(key.substring(0, i))}-name-dir-icon`);
    return key.substring(i + 1);
  }
  return key;
}

function tryNormalizeFontSize(size) {
  if (!size) return undefined;
  if (size.endsWith('px')) {
    const v = parseInt(size, 10);
    if (!isNaN(v)) return Math.round((v / 13) * 100) + '%';
  }
  return size;
}

/**
 * Theme qualifiers. VS Code puts `.vs` / `.hc-black` / `.hc-light` on the workbench;
 * webviews get `vscode-light` / `vscode-dark` / `vscode-high-contrast[-light]` on <body>.
 */
const QUALIFIERS = {
  base: '.show-file-icons',
  light: 'body.vscode-light .show-file-icons',
  hcDark: 'body.vscode-high-contrast:not(.vscode-high-contrast-light) .show-file-icons',
  hcLight: 'body.vscode-high-contrast-light .show-file-icons',
};

/**
 * Turn an icon theme document into CSS, like FileIconThemeData.processIconThemeDocument (file icons only).
 * @param doc            parsed icon theme JSON
 * @param resolveUrl     (relativePath) => browser URL string for a file next to the theme JSON
 * @param languageIcons  [{ id, light, dark }] browser URLs of language default icons (contributes.languages[].icon)
 */
function buildIconThemeCss(doc, resolveUrl, languageIcons = []) {
  if (!doc || !doc.iconDefinitions) return '';
  const selectorByDefinitionId = {};
  const coveredLanguages = {};
  let hasSpecificFileIcons = false;
  let hasFileIcons = false;

  function collectSelectors(associations, qualifier) {
    if (!associations) return;
    const addSelector = (selector, defId) => {
      if (!defId) return;
      (selectorByDefinitionId[defId] = selectorByDefinitionId[defId] || []).push(selector);
    };
    if (associations.file) {
      addSelector(`${qualifier} .file-icon::before`, associations.file);
      hasFileIcons = true;
    }
    const languageIds = associations.languageIds;
    if (languageIds) {
      if (!languageIds.jsonc && languageIds.json) languageIds.jsonc = languageIds.json;
      for (const languageId in languageIds) {
        addSelector(`${qualifier} .${classSelectorPart(languageId)}-lang-file-icon.file-icon::before`, languageIds[languageId]);
        hasFileIcons = true;
        hasSpecificFileIcons = true;
        coveredLanguages[languageId] = true;
      }
    }
    const fileExtensions = associations.fileExtensions;
    if (fileExtensions) {
      for (const key in fileExtensions) {
        const selectors = [];
        const name = handleParentFolder(key.toLowerCase(), selectors);
        const segments = name.split('.');
        if (segments.length) {
          for (let i = 0; i < segments.length; i++) selectors.push(`.${classSelectorPart(segments.slice(i).join('.'))}-ext-file-icon`);
          selectors.push('.ext-file-icon');
        }
        addSelector(`${qualifier} ${selectors.join('')}.file-icon::before`, fileExtensions[key]);
        hasFileIcons = true;
        hasSpecificFileIcons = true;
      }
    }
    const fileNames = associations.fileNames;
    if (fileNames) {
      for (const key in fileNames) {
        const selectors = [];
        const fileName = handleParentFolder(key.toLowerCase(), selectors);
        selectors.push(`.${classSelectorPart(fileName)}-name-file-icon`);
        selectors.push('.name-file-icon');
        const segments = fileName.split('.');
        if (segments.length) {
          for (let i = 1; i < segments.length; i++) selectors.push(`.${classSelectorPart(segments.slice(i).join('.'))}-ext-file-icon`);
          selectors.push('.ext-file-icon');
        }
        addSelector(`${qualifier} ${selectors.join('')}.file-icon::before`, fileNames[key]);
        hasFileIcons = true;
        hasSpecificFileIcons = true;
      }
    }
  }
  collectSelectors(doc, QUALIFIERS.base);
  collectSelectors(doc.light, QUALIFIERS.light);
  collectSelectors(doc.highContrast, QUALIFIERS.hcDark);
  collectSelectors(doc.highContrast, QUALIFIERS.hcLight);
  if (!hasFileIcons) return '';

  const showLanguageModeIcons = doc.showLanguageModeIcons === true || (hasSpecificFileIcons && doc.showLanguageModeIcons !== false);
  const rules = [];
  const fonts = doc.fonts;
  const fontSizes = new Map();
  if (Array.isArray(fonts) && fonts.length) {
    const defaultFontSize = tryNormalizeFontSize(fonts[0].size) || '150%';
    for (const font of fonts) {
      const srcs = (font.src || []).map((l) => `${asCSSUrl(resolveUrl(l.path))} format(${stringValue(l.format)})`);
      rules.push(`@font-face { src: ${srcs.join(', ')}; font-family: ${stringValue(font.id)}; font-weight: ${identValue(font.weight)}; font-style: ${identValue(font.style)}; font-display: block; }`);
      const fontSize = tryNormalizeFontSize(font.size);
      if (fontSize !== undefined && fontSize !== defaultFontSize) fontSizes.set(font.id, fontSize);
    }
    rules.push(`.show-file-icons .file-icon::before { font-family: ${stringValue(fonts[0].id)}; font-size: ${sizeValue(defaultFontSize)}; }`);
  }

  const emQuad = stringValue('\\2001');
  const imageIconStyle = (url) => (doc.usesCurrentColor
    ? `background-color: currentColor; background-image: none; mask: ${url} no-repeat var(--file-icon-mask-position, left center); mask-size: var(--file-icon-mask-size, 16px); -webkit-mask: ${url} no-repeat var(--file-icon-mask-position, left center); -webkit-mask-size: var(--file-icon-mask-size, 16px);`
    : `background-image: ${url};`);

  for (const defId in selectorByDefinitionId) {
    const selectors = selectorByDefinitionId[defId];
    const def = doc.iconDefinitions[defId];
    if (!def) continue;
    if (def.iconPath) {
      rules.push(`${selectors.join(', ')} { content: ${emQuad}; ${imageIconStyle(asCSSUrl(resolveUrl(def.iconPath)))} }`);
    } else if (def.fontCharacter || def.fontColor) {
      const body = [];
      if (def.fontColor && fontColorRegex.test(def.fontColor)) body.push(`color: ${hexColorValue(def.fontColor)};`);
      if (def.fontCharacter) body.push(`content: ${stringValue(def.fontCharacter)};`);
      const fontSize = def.fontSize || (def.fontId ? fontSizes.get(def.fontId) : undefined);
      if (fontSize && fontSizeRegex.test(fontSize)) body.push(`font-size: ${sizeValue(fontSize)};`);
      if (def.fontId) body.push(`font-family: ${stringValue(def.fontId)};`);
      if (showLanguageModeIcons) body.push('background-image: unset;');
      rules.push(`${selectors.join(', ')} { ${body.join(' ')} }`);
    }
  }

  if (showLanguageModeIcons) {
    for (const li of languageIcons) {
      if (coveredLanguages[li.id]) continue;
      const selector = `.show-file-icons .${classSelectorPart(li.id)}-lang-file-icon.file-icon::before`;
      rules.push(`${selector} { content: ${emQuad}; ${imageIconStyle(asCSSUrl(li.dark))} }`);
      rules.push(`body.vscode-light ${selector} { content: ${emQuad}; ${imageIconStyle(asCSSUrl(li.light))} }`);
    }
  }
  return rules.join('\n');
}

// ------------------------------------------------------------------ file -> classes (port of getIconClasses)

const fileIconDirectoryRegex = /(?:\/|^)(?:([^/]+)\/)?([^/]+)$/;

/** @param uriPath forward-slash path (uri.path); @param languageId detected language or null */
function getIconClasses(uriPath, languageId) {
  const classes = ['file-icon'];
  const match = uriPath.match(fileIconDirectoryRegex);
  if (!match) return classes;
  const name = fileIconSelectorEscape(match[2].toLowerCase());
  if (match[1]) classes.push(`${fileIconSelectorEscape(match[1].toLowerCase())}-name-dir-icon`);
  classes.push(`${name}-name-file-icon`);
  classes.push('name-file-icon');
  if (name.length <= 255) {
    const dotSegments = name.split('.');
    for (let i = 1; i < dotSegments.length; i++) classes.push(`${dotSegments.slice(i).join('.')}-ext-file-icon`);
  }
  classes.push('ext-file-icon');
  if (languageId) classes.push(`${fileIconSelectorEscape(languageId)}-lang-file-icon`);
  return classes;
}

// ------------------------------------------------------------------ language detection (port of languagesAssociations.getAssociationByPath)

function globToRegExp(glob) {
  let re = '';
  let i = 0;
  let inGroup = false;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { inGroup = true; re += '(?:'; } else if (c === '}' && inGroup) { inGroup = false; re += ')'; } else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const j = glob.indexOf(']', i);
      if (j > i) { re += '[' + glob.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j + 1; continue; }
      re += '\\[';
    } else re += c.replace(/[.+^$()|\\/]/g, '\\$&');
    i++;
  }
  return new RegExp('^' + re + '$', 'i');
}

class LanguageRegistry {
  /**
   * @param extensions  vscode.extensions.all (or fakes with { extensionPath, packageJSON })
   * @param userAssociations files.associations setting: { pattern: languageId }
   */
  constructor(extensions, userAssociations) {
    this.user = [];
    this.builtin = [];
    this.icons = new Map(); // id -> { light, dark } absolute paths
    for (const [pattern, id] of Object.entries(userAssociations || {})) {
      this.user.push({ id, filepattern: pattern, filepatternLowercase: globToRegExp(pattern.toLowerCase()), filepatternOnPath: pattern.includes('/') });
    }
    for (const ext of extensions || []) {
      const langs = (ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.languages) || [];
      for (const l of langs) {
        if (!l || !l.id) continue;
        for (const e of l.extensions || []) this.builtin.push({ id: l.id, extensionLowercase: String(e).toLowerCase() });
        for (const f of l.filenames || []) this.builtin.push({ id: l.id, filenameLowercase: String(f).toLowerCase() });
        for (const p of l.filenamePatterns || []) {
          const pl = String(p).toLowerCase();
          this.builtin.push({ id: l.id, filepattern: p, filepatternLowercase: globToRegExp(pl), filepatternOnPath: pl.includes('/') });
        }
        if (l.icon && l.icon.light && l.icon.dark && ext.extensionPath) {
          this.icons.set(l.id, { light: path.join(ext.extensionPath, l.icon.light), dark: path.join(ext.extensionPath, l.icon.dark) });
        }
      }
    }
  }

  static match(associations, pathLower, filenameLower) {
    let patternMatch = null;
    let extensionMatch = null;
    for (let i = associations.length - 1; i >= 0; i--) {
      const a = associations[i];
      if (filenameLower === a.filenameLowercase) return a;
      if (a.filepattern && (!patternMatch || a.filepattern.length > patternMatch.filepattern.length)) {
        const target = a.filepatternOnPath ? pathLower : filenameLower;
        if (a.filepatternLowercase.test(target)) patternMatch = a;
      }
      if (a.extensionLowercase && (!extensionMatch || a.extensionLowercase.length > extensionMatch.extensionLowercase.length)) {
        if (filenameLower.endsWith(a.extensionLowercase)) extensionMatch = a;
      }
    }
    return patternMatch || extensionMatch || null;
  }

  /** @param fsPath absolute file path; returns a language id, or null for plain text */
  languageFor(fsPath) {
    const p = fsPath.split(path.sep).join('/').toLowerCase();
    const name = p.slice(p.lastIndexOf('/') + 1);
    const a = LanguageRegistry.match(this.user, p, name) || LanguageRegistry.match(this.builtin, p, name);
    return a && a.id !== 'plaintext' ? a.id : null;
  }
}

// ------------------------------------------------------------------ active theme lookup

/**
 * Find and load the icon theme with this id among installed extensions.
 * @returns { id, label, dir, extensionPath, doc } or null (no theme / theme disabled / not found)
 */
function loadIconTheme(extensions, themeId) {
  if (!themeId) return null;
  for (const ext of extensions || []) {
    const themes = (ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.iconThemes) || [];
    const t = themes.find((x) => x.id === themeId);
    if (!t) continue;
    const file = path.join(ext.extensionPath, t.path);
    try {
      const doc = parseJsonc(fs.readFileSync(file, 'utf8'));
      return { id: t.id, label: t.label, dir: path.dirname(file), extensionPath: ext.extensionPath, doc };
    } catch (e) {
      return { id: t.id, label: t.label, dir: path.dirname(file), extensionPath: ext.extensionPath, doc: null, error: String(e && e.message || e) };
    }
  }
  return null;
}

module.exports = { parseJsonc, cssEscape, buildIconThemeCss, getIconClasses, LanguageRegistry, loadIconTheme, globToRegExp, QUALIFIERS };
