'use strict';
// Turn glyphs of an icon-theme font (e.g. Seti's seti.woff) into SVG images, so font-based file icon
// themes can be shown where only image icons are supported (QuickPickItem.iconPath on VS Code < the
// version that derives icons from resourceUri, which includes Cursor).
// Supports TrueType outlines in .ttf and WOFF 1.0 (zlib) files. CFF (.otf) and WOFF2 return null.

const zlib = require('zlib');

function tag(buf, off) { return buf.toString('latin1', off, off + 4); }

/** Table directory → { tag: Buffer } (decompressing WOFF tables). */
function readTables(buf) {
  const sig = tag(buf, 0);
  const tables = {};
  if (sig === 'wOFF') {
    const flavor = buf.readUInt32BE(4);
    if (flavor !== 0x00010000 && tag(buf, 4) !== 'true') return null; // CFF flavored
    const num = buf.readUInt16BE(12);
    for (let i = 0; i < num; i++) {
      const p = 44 + i * 20;
      const t = tag(buf, p);
      const off = buf.readUInt32BE(p + 4);
      const compLen = buf.readUInt32BE(p + 8);
      const origLen = buf.readUInt32BE(p + 12);
      const data = buf.subarray(off, off + compLen);
      tables[t] = compLen < origLen ? zlib.inflateSync(data) : data;
    }
    return tables;
  }
  if (buf.readUInt32BE(0) === 0x00010000 || sig === 'true') {
    const num = buf.readUInt16BE(4);
    for (let i = 0; i < num; i++) {
      const p = 12 + i * 16;
      tables[tag(buf, p)] = buf.subarray(buf.readUInt32BE(p + 8), buf.readUInt32BE(p + 8) + buf.readUInt32BE(p + 12));
    }
    return tables;
  }
  return null; // OTTO (CFF), wOF2, unknown
}

function parseCmap(t) {
  // prefer full-repertoire (3,10 / 0,4+) format 12, else BMP format 4
  const n = t.readUInt16BE(2);
  const subs = [];
  for (let i = 0; i < n; i++) {
    const p = 4 + i * 8;
    subs.push({ platform: t.readUInt16BE(p), encoding: t.readUInt16BE(p + 2), offset: t.readUInt32BE(p + 4) });
  }
  const pick = (fmt) => subs.find((s) => t.readUInt16BE(s.offset) === fmt && (s.platform === 3 || s.platform === 0));
  const s12 = pick(12);
  if (s12) {
    const o = s12.offset;
    const groups = t.readUInt32BE(o + 12);
    return (cp) => {
      for (let g = 0; g < groups; g++) {
        const q = o + 16 + g * 12;
        const start = t.readUInt32BE(q);
        const end = t.readUInt32BE(q + 4);
        if (cp >= start && cp <= end) return t.readUInt32BE(q + 8) + (cp - start);
      }
      return 0;
    };
  }
  const s4 = pick(4);
  if (!s4) return () => 0;
  const o = s4.offset;
  const segX2 = t.readUInt16BE(o + 6);
  const ends = o + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let i = 0; i < segX2; i += 2) {
      const end = t.readUInt16BE(ends + i);
      if (cp > end) continue;
      const start = t.readUInt16BE(starts + i);
      if (cp < start) return 0;
      const delta = t.readInt16BE(deltas + i);
      const rangeOff = t.readUInt16BE(ranges + i);
      if (!rangeOff) return (cp + delta) & 0xffff;
      const gi = t.readUInt16BE(ranges + i + rangeOff + (cp - start) * 2);
      return gi ? (gi + delta) & 0xffff : 0;
    }
    return 0;
  };
}

class Font {
  constructor(tables) {
    this.t = tables;
    const head = tables.head;
    this.unitsPerEm = head.readUInt16BE(18);
    this.longLoca = head.readInt16BE(50) === 1;
    this.ascent = tables.hhea.readInt16BE(4);
    this.descent = tables.hhea.readInt16BE(6);
    this.numGlyphs = tables.maxp.readUInt16BE(4);
    this.glyphIndex = parseCmap(tables.cmap);
  }

  glyphRange(gid) {
    const loca = this.t.loca;
    if (gid >= this.numGlyphs) return [0, 0];
    return this.longLoca
      ? [loca.readUInt32BE(gid * 4), loca.readUInt32BE(gid * 4 + 4)]
      : [loca.readUInt16BE(gid * 2) * 2, loca.readUInt16BE(gid * 2 + 2) * 2];
  }

  /** Contours: arrays of { x, y, on } in font units. */
  contours(gid, depth = 0) {
    const [start, end] = this.glyphRange(gid);
    if (end <= start || depth > 8) return [];
    const g = this.t.glyf.subarray(start, end);
    const nContours = g.readInt16BE(0);
    if (nContours >= 0) return simpleGlyph(g, nContours);
    // composite
    const out = [];
    let p = 10;
    let more = true;
    while (more) {
      const flags = g.readUInt16BE(p);
      const glyph = g.readUInt16BE(p + 2);
      p += 4;
      let dx;
      let dy;
      if (flags & 1) { dx = g.readInt16BE(p); dy = g.readInt16BE(p + 2); p += 4; } else { dx = g.readInt8(p); dy = g.readInt8(p + 1); p += 2; }
      if (!(flags & 2)) { dx = 0; dy = 0; } // point-matching anchors: not supported, no offset
      let a = 1; let b = 0; let c = 0; let d = 1;
      const f2 = (o) => g.readInt16BE(o) / 16384;
      if (flags & 8) { a = d = f2(p); p += 2; } else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; } else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      for (const contour of this.contours(glyph, depth + 1)) {
        out.push(contour.map((pt) => ({ x: a * pt.x + c * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
      }
      more = !!(flags & 0x20);
    }
    return out;
  }

  /** SVG path data for a code point, y flipped around `baseline` (font units). */
  pathFor(codePoint, baseline) {
    const gid = this.glyphIndex(codePoint);
    if (!gid) return null;
    return this.contours(gid).map((c) => contourToPath(c, baseline)).join('');
  }
}

function simpleGlyph(g, nContours) {
  let p = 10;
  const endPts = [];
  for (let i = 0; i < nContours; i++) { endPts.push(g.readUInt16BE(p)); p += 2; }
  const nPoints = nContours ? endPts[nContours - 1] + 1 : 0;
  p += 2 + g.readUInt16BE(p); // instructions
  const flags = [];
  while (flags.length < nPoints) {
    const f = g.readUInt8(p++);
    flags.push(f);
    if (f & 8) { let r = g.readUInt8(p++); while (r-- > 0) flags.push(f); }
  }
  const xs = [];
  let v = 0;
  for (const f of flags) {
    if (f & 2) { const dv = g.readUInt8(p++); v += (f & 16) ? dv : -dv; } else if (!(f & 16)) { v += g.readInt16BE(p); p += 2; }
    xs.push(v);
  }
  const ys = [];
  v = 0;
  for (const f of flags) {
    if (f & 4) { const dv = g.readUInt8(p++); v += (f & 32) ? dv : -dv; } else if (!(f & 32)) { v += g.readInt16BE(p); p += 2; }
    ys.push(v);
  }
  const contours = [];
  let s = 0;
  for (const e of endPts) {
    const c = [];
    for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
    contours.push(c);
    s = e + 1;
  }
  return contours;
}

const r2 = (n) => Math.round(n * 100) / 100;

/** TrueType quadratic contour → SVG path (implied on-curve midpoints between off-curve points). */
function contourToPath(pts, baseline) {
  if (!pts.length) return '';
  const P = (pt) => `${r2(pt.x)} ${r2(baseline - pt.y)}`;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
  // start at an on-curve point (or the midpoint of the first two off-curve points)
  let startIdx = pts.findIndex((q) => q.on);
  let ring;
  let start;
  if (startIdx === -1) {
    start = mid(pts[0], pts[1]);
    ring = pts.slice(1).concat(pts.slice(0, 1));
  } else {
    start = pts[startIdx];
    ring = pts.slice(startIdx + 1).concat(pts.slice(0, startIdx));
  }
  let d = `M${P(start)}`;
  let ctrl = null;
  for (const pt of ring.concat([start])) {
    if (pt.on) {
      d += ctrl ? `Q${P(ctrl)} ${P(pt)}` : `L${P(pt)}`;
      ctrl = null;
    } else if (ctrl) {
      const m = mid(ctrl, pt);
      d += `Q${P(ctrl)} ${P(m)}`;
      ctrl = pt;
    } else {
      ctrl = pt;
    }
  }
  return `${d}Z`;
}

function loadFont(buffer) {
  try {
    const tables = readTables(buffer);
    if (!tables || !tables.glyf || !tables.loca || !tables.cmap || !tables.head || !tables.hhea || !tables.maxp) return null;
    return new Font(tables);
  } catch (_) {
    return null;
  }
}

/**
 * SVG for a file-icon glyph in the 16×22 box QuickPick image icons use, laid out like the Explorer
 * draws it: font size `relSize` × 13px (Seti: 150%), left-aligned, vertically centred in a 22px row.
 * An image can't overflow its box like the Explorer's ::before can, so glyphs reaching past 16px are
 * shifted left, and glyphs wider than 16px are scaled down to fit; everything else is pixel-identical.
 */
function glyphSvg(font, codePoint, color, relSize = 1.5) {
  const gid = font.glyphIndex(codePoint);
  if (!gid) return null;
  const contours = font.contours(gid);
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const c of contours) for (const p of c) { if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x; }
  if (!contours.length) { xMin = 0; xMax = 0; }
  let s = (13 * relSize) / font.unitsPerEm; // px per font unit, as in the Explorer
  let x0 = 0; // left edge of the box, font units
  if ((xMax - xMin) * s > 16) { s = 16 / (xMax - xMin); x0 = xMin; } else if (xMax * s > 16) x0 = xMax - 16 / s;
  else if (xMin < 0) x0 = xMin;
  const boxW = 16 / s;
  const boxH = 22 / s;
  const top = (boxH - (font.ascent - font.descent)) / 2; // half-leading, like CSS line-height
  const path = contours.map((c) => contourToPath(c, font.ascent)).join('');
  const fill = /^#[0-9a-fA-F]{3,8}$/.test(color || '') ? color : 'currentColor';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="22" viewBox="${r2(x0)} ${r2(-top)} ${r2(boxW)} ${r2(boxH)}"><path fill="${fill}" d="${path}"/></svg>`;
}

module.exports = { loadFont, glyphSvg, contourToPath };
