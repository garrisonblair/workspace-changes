'use strict';
// Port of VS Code's Quick Open (Cmd+P) file scorer, so "Go to File in Shown Repositories" ranks
// results exactly like Cmd+P:
//   src/vs/base/common/fuzzyScorer.ts  (scoreFuzzy, scoreItemFuzzy, compareItemsByFuzzyScore, prepareQuery)
//   src/vs/base/common/comparers.ts    (compareAnything, compareFileNames)
//   src/vs/base/common/filters.ts      (matchesPrefix, isUpper)
// Copyright (c) Microsoft Corporation. MIT License. Ported to plain JavaScript; the symbol-search
// variant (scoreFuzzy2) is left out. test/vscode-fuzzyScorer.js runs VS Code's own test suite on it.

const path = require('path');

const sep = path.sep;
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

const NO_MATCH = 0;
const NO_SCORE = [NO_MATCH, []];

// ------------------------------------------------------------------ helpers (filters.ts, strings.ts)

function isUpper(code) { return code >= 65 && code <= 90; }

function equalsIgnoreCase(a, b) { return a.length === b.length && a.toLowerCase() === b.toLowerCase(); }

function matchesPrefix(word, wordToMatchAgainst) {
  if (!wordToMatchAgainst || wordToMatchAgainst.length < word.length) return null;
  if (!wordToMatchAgainst.toLowerCase().startsWith(word.toLowerCase())) return null;
  return word.length > 0 ? [{ start: 0, end: word.length }] : [];
}

// ------------------------------------------------------------------ comparers.ts

let collator;
function fileNameCollator() {
  if (!collator) {
    const c = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    collator = { collator: c, collatorIsNumeric: c.resolvedOptions().numeric };
  }
  return collator;
}

function compareFileNames(one, other) {
  const a = one || '';
  const b = other || '';
  const { collator: c, collatorIsNumeric } = fileNameCollator();
  const result = c.compare(a, b);
  if (collatorIsNumeric && result === 0 && a !== b) return a < b ? -1 : 1;
  return result;
}

function compareByPrefix(one, other, lookFor) {
  const a = one.toLowerCase();
  const b = other.toLowerCase();
  const aPrefix = a.startsWith(lookFor);
  const bPrefix = b.startsWith(lookFor);
  if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
  if (aPrefix && bPrefix) {
    if (a.length < b.length) return -1;
    if (a.length > b.length) return 1;
  }
  return 0;
}

function compareAnything(one, other, lookFor) {
  const a = one.toLowerCase();
  const b = other.toLowerCase();
  const prefixCompare = compareByPrefix(one, other, lookFor);
  if (prefixCompare) return prefixCompare;
  const aSuffix = a.endsWith(lookFor);
  const bSuffix = b.endsWith(lookFor);
  if (aSuffix !== bSuffix) return aSuffix ? -1 : 1;
  const r = compareFileNames(a, b);
  if (r !== 0) return r;
  return a.localeCompare(b);
}

// ------------------------------------------------------------------ fuzzy scorer

function scoreFuzzy(target, query, queryLower, allowNonContiguousMatches) {
  if (!target || !query) return NO_SCORE;
  const targetLength = target.length;
  const queryLength = query.length;
  if (targetLength < queryLength) return NO_SCORE;
  const targetLower = target.toLowerCase();
  return doScoreFuzzy(query, queryLower, queryLength, target, targetLower, targetLength, allowNonContiguousMatches);
}

// Score matrices, reused across calls (perf; the algorithm is unchanged).
let scoresBuf = new Int32Array(4096);
let matchesBuf = new Int32Array(4096);

function doScoreFuzzy(query, queryLower, queryLength, target, targetLower, targetLength, allowNonContiguousMatches) {
  const size = queryLength * targetLength;
  if (scoresBuf.length < size) {
    scoresBuf = new Int32Array(size * 2);
    matchesBuf = new Int32Array(size * 2);
  }
  const scores = scoresBuf;
  const matches = matchesBuf;

  for (let queryIndex = 0; queryIndex < queryLength; queryIndex++) {
    const queryIndexOffset = queryIndex * targetLength;
    const queryIndexPreviousOffset = queryIndexOffset - targetLength;
    const queryIndexGtNull = queryIndex > 0;
    const queryCharAtIndex = query[queryIndex];
    const queryLowerCharAtIndex = queryLower[queryIndex];

    for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
      const targetIndexGtNull = targetIndex > 0;
      const currentIndex = queryIndexOffset + targetIndex;
      const leftIndex = currentIndex - 1;
      const diagIndex = queryIndexPreviousOffset + targetIndex - 1;

      const leftScore = targetIndexGtNull ? scores[leftIndex] : 0;
      const diagScore = queryIndexGtNull && targetIndexGtNull ? scores[diagIndex] : 0;
      const matchesSequenceLength = queryIndexGtNull && targetIndexGtNull ? matches[diagIndex] : 0;

      let score;
      if (!diagScore && queryIndexGtNull) score = 0;
      else score = computeCharScore(queryCharAtIndex, queryLowerCharAtIndex, target, targetLower, targetIndex, matchesSequenceLength);

      const isValidScore = score && diagScore + score >= leftScore;
      if (isValidScore && (allowNonContiguousMatches || queryIndexGtNull || targetLower.startsWith(queryLower, targetIndex))) {
        matches[currentIndex] = matchesSequenceLength + 1;
        scores[currentIndex] = diagScore + score;
      } else {
        matches[currentIndex] = NO_MATCH;
        scores[currentIndex] = leftScore;
      }
    }
  }

  const positions = [];
  let queryIndex = queryLength - 1;
  let targetIndex = targetLength - 1;
  while (queryIndex >= 0 && targetIndex >= 0) {
    const currentIndex = queryIndex * targetLength + targetIndex;
    if (matches[currentIndex] === NO_MATCH) {
      targetIndex--;
    } else {
      positions.push(targetIndex);
      queryIndex--;
      targetIndex--;
    }
  }
  return [scores[queryLength * targetLength - 1], positions.reverse()];
}

function computeCharScore(queryCharAtIndex, queryLowerCharAtIndex, target, targetLower, targetIndex, matchesSequenceLength) {
  let score = 0;
  if (!considerAsEqual(queryLowerCharAtIndex, targetLower[targetIndex])) return score;
  score += 1; // character match
  if (matchesSequenceLength > 0) {
    score += (Math.min(matchesSequenceLength, 3) * 6) + (Math.max(0, matchesSequenceLength - 3) * 3); // consecutive
  }
  if (queryCharAtIndex === target[targetIndex]) score += 1; // same case
  if (targetIndex === 0) {
    score += 8; // start of word
  } else {
    const separatorBonus = scoreSeparatorAtPos(target.charCodeAt(targetIndex - 1));
    if (separatorBonus) score += separatorBonus;
    else if (isUpper(target.charCodeAt(targetIndex)) && matchesSequenceLength === 0) score += 2; // camel case
  }
  return score;
}

function considerAsEqual(a, b) {
  if (a === b) return true;
  if (a === '/' || a === '\\') return b === '/' || b === '\\';
  return false;
}

function scoreSeparatorAtPos(charCode) {
  switch (charCode) {
    case 47: case 92: return 5; // / \
    case 95: case 45: case 46: case 32: case 39: case 34: case 58: return 4; // _ - . space ' " :
    default: return 0;
  }
}

// ------------------------------------------------------------------ item scoring

const NO_ITEM_SCORE = Object.freeze({ score: 0 });
const PATH_IDENTITY_SCORE = 1 << 18;
const LABEL_PREFIX_SCORE_THRESHOLD = 1 << 17;
const LABEL_SCORE_THRESHOLD = 1 << 16;

function cacheKey(label, description, allowNonContiguousMatches, query) {
  const values = query.values ? query.values.map((v) => `${v.normalized}\u0001${v.expectContiguousMatch}`).join('\u0002') : '';
  return `${label}\u0000${description || ''}\u0000${allowNonContiguousMatches}\u0000${query.normalized}\u0000${query.expectContiguousMatch}\u0000${values}`;
}

function scoreItemFuzzy(item, query, allowNonContiguousMatches, accessor, cache) {
  if (!item || !query.normalized) return NO_ITEM_SCORE;
  if (cache instanceof Map) {
    // fast path: caller guarantees one query + mode per Map, so the item itself is the key
    let s = cache.get(item);
    if (!s) {
      const label = accessor.getItemLabel(item);
      s = label ? doScoreItemFuzzy(label, accessor.getItemDescription(item), accessor.getItemPath(item), query, allowNonContiguousMatches) : NO_ITEM_SCORE;
      cache.set(item, s);
    }
    return s;
  }
  const label = accessor.getItemLabel(item);
  if (!label) return NO_ITEM_SCORE;
  const description = accessor.getItemDescription(item);
  const key = cacheKey(label, description, allowNonContiguousMatches, query);
  const cached = cache[key];
  if (cached) return cached;
  const itemScore = doScoreItemFuzzy(label, description, accessor.getItemPath(item), query, allowNonContiguousMatches);
  cache[key] = itemScore;
  return itemScore;
}

function doScoreItemFuzzy(label, description, itemPath, query, allowNonContiguousMatches) {
  const preferLabelMatches = !itemPath || !query.containsPathSeparator;
  if (itemPath && (isLinux ? query.pathNormalized === itemPath : equalsIgnoreCase(query.pathNormalized, itemPath))) {
    return { score: PATH_IDENTITY_SCORE, labelMatch: [{ start: 0, end: label.length }], descriptionMatch: description ? [{ start: 0, end: description.length }] : undefined };
  }
  if (query.values && query.values.length > 1) {
    return doScoreItemFuzzyMultiple(label, description, itemPath, query.values, preferLabelMatches, allowNonContiguousMatches);
  }
  return doScoreItemFuzzySingle(label, description, itemPath, query, preferLabelMatches, allowNonContiguousMatches);
}

function doScoreItemFuzzyMultiple(label, description, itemPath, query, preferLabelMatches, allowNonContiguousMatches) {
  let totalScore = 0;
  const totalLabelMatches = [];
  const totalDescriptionMatches = [];
  for (const queryPiece of query) {
    const { score, labelMatch, descriptionMatch } = doScoreItemFuzzySingle(label, description, itemPath, queryPiece, preferLabelMatches, allowNonContiguousMatches);
    if (score === NO_MATCH) return NO_ITEM_SCORE;
    totalScore += score;
    if (labelMatch) totalLabelMatches.push(...labelMatch);
    if (descriptionMatch) totalDescriptionMatches.push(...descriptionMatch);
  }
  return { score: totalScore, labelMatch: normalizeMatches(totalLabelMatches), descriptionMatch: normalizeMatches(totalDescriptionMatches) };
}

function doScoreItemFuzzySingle(label, description, itemPath, query, preferLabelMatches, allowNonContiguousMatches) {
  if (preferLabelMatches || !description) {
    const [labelScore, labelPositions] = scoreFuzzy(label, query.normalized, query.normalizedLowercase, allowNonContiguousMatches && !query.expectContiguousMatch);
    if (labelScore) {
      const labelPrefixMatch = matchesPrefix(query.normalized, label);
      let baseScore;
      if (labelPrefixMatch) {
        baseScore = LABEL_PREFIX_SCORE_THRESHOLD;
        baseScore += Math.round((query.normalized.length / label.length) * 100);
      } else {
        baseScore = LABEL_SCORE_THRESHOLD;
      }
      return { score: baseScore + labelScore, labelMatch: labelPrefixMatch || createMatches(labelPositions) };
    }
  }

  if (description) {
    let descriptionPrefix = description;
    if (itemPath) descriptionPrefix = `${description}${sep}`;
    const descriptionPrefixLength = descriptionPrefix.length;
    const descriptionAndLabel = `${descriptionPrefix}${label}`;
    const [labelDescriptionScore, labelDescriptionPositions] = scoreFuzzy(descriptionAndLabel, query.normalized, query.normalizedLowercase, allowNonContiguousMatches && !query.expectContiguousMatch);
    if (labelDescriptionScore) {
      const labelDescriptionMatches = createMatches(labelDescriptionPositions);
      const labelMatch = [];
      const descriptionMatch = [];
      labelDescriptionMatches.forEach((h) => {
        if (h.start < descriptionPrefixLength && h.end > descriptionPrefixLength) {
          labelMatch.push({ start: 0, end: h.end - descriptionPrefixLength });
          descriptionMatch.push({ start: h.start, end: descriptionPrefixLength });
        } else if (h.start >= descriptionPrefixLength) {
          labelMatch.push({ start: h.start - descriptionPrefixLength, end: h.end - descriptionPrefixLength });
        } else {
          descriptionMatch.push(h);
        }
      });
      return { score: labelDescriptionScore, labelMatch, descriptionMatch };
    }
  }
  return NO_ITEM_SCORE;
}

function createMatches(offsets) {
  const ret = [];
  if (!offsets) return ret;
  let last;
  for (const pos of offsets) {
    if (last && last.end === pos) last.end += 1;
    else { last = { start: pos, end: pos + 1 }; ret.push(last); }
  }
  return ret;
}

function normalizeMatches(matches) {
  const sorted = matches.sort((a, b) => a.start - b.start);
  const normalized = [];
  let current;
  for (const match of sorted) {
    if (!current || !matchOverlaps(current, match)) { current = match; normalized.push(match); } else {
      current.start = Math.min(current.start, match.start);
      current.end = Math.max(current.end, match.end);
    }
  }
  return normalized;
}

function matchOverlaps(a, b) {
  if (a.end < b.start) return false;
  if (b.end < a.start) return false;
  return true;
}

// ------------------------------------------------------------------ comparers

function compareItemsByFuzzyScore(itemA, itemB, query, allowNonContiguousMatches, accessor, cache) {
  const itemScoreA = scoreItemFuzzy(itemA, query, allowNonContiguousMatches, accessor, cache);
  const itemScoreB = scoreItemFuzzy(itemB, query, allowNonContiguousMatches, accessor, cache);
  const scoreA = itemScoreA.score;
  const scoreB = itemScoreB.score;

  if (scoreA === PATH_IDENTITY_SCORE || scoreB === PATH_IDENTITY_SCORE) {
    if (scoreA !== scoreB) return scoreA === PATH_IDENTITY_SCORE ? -1 : 1;
  }
  if (scoreA > LABEL_SCORE_THRESHOLD || scoreB > LABEL_SCORE_THRESHOLD) {
    if (scoreA !== scoreB) return scoreA > scoreB ? -1 : 1;
    if (scoreA < LABEL_PREFIX_SCORE_THRESHOLD && scoreB < LABEL_PREFIX_SCORE_THRESHOLD) {
      const byLength = compareByMatchLength(itemScoreA.labelMatch, itemScoreB.labelMatch);
      if (byLength !== 0) return byLength;
    }
    const labelA = accessor.getItemLabel(itemA) || '';
    const labelB = accessor.getItemLabel(itemB) || '';
    if (labelA.length !== labelB.length) return labelA.length - labelB.length;
  }
  if (scoreA !== scoreB) return scoreA > scoreB ? -1 : 1;

  const aLabel = Array.isArray(itemScoreA.labelMatch) && itemScoreA.labelMatch.length > 0;
  const bLabel = Array.isArray(itemScoreB.labelMatch) && itemScoreB.labelMatch.length > 0;
  if (aLabel && !bLabel) return -1;
  if (bLabel && !aLabel) return 1;

  const distA = computeLabelAndDescriptionMatchDistance(itemA, itemScoreA, accessor);
  const distB = computeLabelAndDescriptionMatchDistance(itemB, itemScoreB, accessor);
  if (distA && distB && distA !== distB) return distB > distA ? -1 : 1;

  return fallbackCompare(itemA, itemB, query, accessor);
}

function computeLabelAndDescriptionMatchDistance(item, score, accessor) {
  let matchStart = -1;
  let matchEnd = -1;
  if (score.descriptionMatch && score.descriptionMatch.length) matchStart = score.descriptionMatch[0].start;
  else if (score.labelMatch && score.labelMatch.length) matchStart = score.labelMatch[0].start;
  if (score.labelMatch && score.labelMatch.length) {
    matchEnd = score.labelMatch[score.labelMatch.length - 1].end;
    if (score.descriptionMatch && score.descriptionMatch.length) {
      const d = accessor.getItemDescription(item);
      if (d) matchEnd += d.length;
    }
  } else if (score.descriptionMatch && score.descriptionMatch.length) {
    matchEnd = score.descriptionMatch[score.descriptionMatch.length - 1].end;
  }
  return matchEnd - matchStart;
}

function compareByMatchLength(matchesA, matchesB) {
  if ((!matchesA && !matchesB) || ((!matchesA || !matchesA.length) && (!matchesB || !matchesB.length))) return 0;
  if (!matchesB || !matchesB.length) return -1;
  if (!matchesA || !matchesA.length) return 1;
  const lenA = matchesA[matchesA.length - 1].end - matchesA[0].start;
  const lenB = matchesB[matchesB.length - 1].end - matchesB[0].start;
  return lenA === lenB ? 0 : lenB < lenA ? 1 : -1;
}

function fallbackCompare(itemA, itemB, query, accessor) {
  const labelA = accessor.getItemLabel(itemA) || '';
  const labelB = accessor.getItemLabel(itemB) || '';
  const descriptionA = accessor.getItemDescription(itemA);
  const descriptionB = accessor.getItemDescription(itemB);
  const lenA = labelA.length + (descriptionA ? descriptionA.length : 0);
  const lenB = labelB.length + (descriptionB ? descriptionB.length : 0);
  if (lenA !== lenB) return lenA - lenB;
  const pathA = accessor.getItemPath(itemA);
  const pathB = accessor.getItemPath(itemB);
  if (pathA && pathB && pathA.length !== pathB.length) return pathA.length - pathB.length;
  if (labelA !== labelB) return compareAnything(labelA, labelB, query.normalized);
  if (descriptionA && descriptionB && descriptionA !== descriptionB) return compareAnything(descriptionA, descriptionB, query.normalized);
  if (pathA && pathB && pathA !== pathB) return compareAnything(pathA, pathB, query.normalized);
  return 0;
}

// ------------------------------------------------------------------ query normalizer

function queryExpectsExactMatch(query) { return query.startsWith('"') && query.endsWith('"'); }

const MULTIPLE_QUERY_VALUES_SEPARATOR = ' ';

function prepareQuery(original) {
  if (typeof original !== 'string') original = '';
  const originalLowercase = original.toLowerCase();
  const { pathNormalized, normalized, normalizedLowercase } = normalizeQuery(original);
  const containsPathSeparator = pathNormalized.indexOf(sep) >= 0;
  const expectExactMatch = queryExpectsExactMatch(original);
  let values;
  const originalSplit = original.split(MULTIPLE_QUERY_VALUES_SEPARATOR);
  if (originalSplit.length > 1) {
    for (const originalPiece of originalSplit) {
      const expectExactMatchPiece = queryExpectsExactMatch(originalPiece);
      const n = normalizeQuery(originalPiece);
      if (n.normalized) {
        if (!values) values = [];
        values.push({
          original: originalPiece,
          originalLowercase: originalPiece.toLowerCase(),
          pathNormalized: n.pathNormalized,
          normalized: n.normalized,
          normalizedLowercase: n.normalizedLowercase,
          expectContiguousMatch: expectExactMatchPiece,
        });
      }
    }
  }
  return { original, originalLowercase, pathNormalized, normalized, normalizedLowercase, values, containsPathSeparator, expectContiguousMatch: expectExactMatch };
}

function normalizeQuery(original) {
  const pathNormalized = isWindows ? original.replace(/\//g, sep) : original.replace(/\\/g, sep);
  const normalized = pathNormalized.replace(/[*…\s"]/g, '').replace(/(?<=.)#$/, '');
  return { pathNormalized, normalized, normalizedLowercase: normalized.toLowerCase() };
}

function pieceToQuery(arg) {
  if (Array.isArray(arg)) return prepareQuery(arg.map((p) => p.original).join(MULTIPLE_QUERY_VALUES_SEPARATOR));
  return prepareQuery(arg.original);
}

module.exports = {
  scoreFuzzy, scoreItemFuzzy, compareItemsByFuzzyScore, prepareQuery, pieceToQuery, compareAnything,
  PATH_IDENTITY_SCORE, LABEL_PREFIX_SCORE_THRESHOLD, LABEL_SCORE_THRESHOLD,
};
