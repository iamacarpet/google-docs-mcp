/**
 * Edit planning: validates index ranges against the cached document and builds
 * Docs API batchUpdate requests that are safe to submit together.
 *
 * Supports plain replacements, rich text styling, paragraph styles, bullets,
 * tables, and images.
 *
 * Ordering rule (CRITICAL): edits are always emitted in DESCENDING startIndex
 * order (bottom-to-top) so earlier requests never shift the indices of later
 * ones.
 */

import { GAP, type IndexRange, type TabModel, truncate } from './docModel.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type DocsRequest = Record<string, any>;

export class EditValidationError extends Error {}

export interface TextStyleInput {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  foregroundColor?: string | { red: number; green: number; blue: number };
  backgroundColor?: string | { red: number; green: number; blue: number };
  linkUrl?: string;
}

export interface RangeEdit extends IndexRange {
  text: string;
  textStyle?: TextStyleInput;
}

export interface PlannedEdit extends RangeEdit {
  /** Human-readable notes about automatic adjustments. */
  notes: string[];
  /** Original text being replaced (raw buffer slice). */
  originalText: string;
}

export interface ParagraphBorderInput {
  padding?: number;
  width?: number;
  dashStyle?: 'SOLID' | 'DOT' | 'DASH' | string;
  color?: string | { red: number; green: number; blue: number };
}

export interface ParagraphStyleInput {
  namedStyleType?: string;
  alignment?: 'START' | 'CENTER' | 'END' | 'JUSTIFIED';
  spaceAbove?: number;
  spaceBelow?: number;
  lineSpacing?: number;
  spacingMode?: 'SPACING_MODE_UNSPECIFIED' | 'NEVER_COLLAPSE' | 'COLLAPSE_LISTS';
  indentStart?: number;
  indentEnd?: number;
  indentFirstLine?: number;
  padding?: number;
  shadingColor?: string | { red: number; green: number; blue: number };
  keepLinesTogether?: boolean;
  keepWithNext?: boolean;
  avoidWidowAndOrphan?: boolean;
  pageBreakBefore?: boolean;
  borderTop?: ParagraphBorderInput;
  borderBottom?: ParagraphBorderInput;
  borderLeft?: ParagraphBorderInput;
  borderRight?: ParagraphBorderInput;
  borderBetween?: ParagraphBorderInput;
}

export function hasStyle(s?: TextStyleInput): boolean {
  if (!s) return false;
  return (
    s.bold !== undefined ||
    s.italic !== undefined ||
    s.underline !== undefined ||
    s.strikethrough !== undefined ||
    s.fontSize !== undefined ||
    s.foregroundColor !== undefined ||
    s.backgroundColor !== undefined ||
    s.linkUrl !== undefined
  );
}

export function parseColor(c: string | { red: number; green: number; blue: number }): { red: number; green: number; blue: number } {
  if (typeof c === 'object' && c !== null) return c;
  let hex = String(c).replace('#', '').trim();
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  const num = parseInt(hex, 16);
  if (isNaN(num)) return { red: 0, green: 0, blue: 0 };
  return {
    red: Math.max(0, Math.min(1, ((num >> 16) & 255) / 255)),
    green: Math.max(0, Math.min(1, ((num >> 8) & 255) / 255)),
    blue: Math.max(0, Math.min(1, (num & 255) / 255)),
  };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function normalizeExpectedText(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u02BC\u02BB]/g, "'")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u2013\u2014\u2212]/g, '-');
}

/**
 * Validates a single range edit against the tab buffer and normalises it.
 * Throws EditValidationError with an actionable message on failure.
 */
export function planRangeEdit(tab: TabModel, edit: RangeEdit, expectedText?: string): PlannedEdit {
  let { startIndex, endIndex, text, textStyle } = edit;
  const notes: string[] = [];
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    throw new EditValidationError('startIndex and endIndex must be integers.');
  }
  if (startIndex < 1) throw new EditValidationError('startIndex must be >= 1 (index 0 is the document section break).');
  if (endIndex < startIndex) throw new EditValidationError(`endIndex (${endIndex}) is before startIndex (${startIndex}).`);
  if (endIndex > tab.endIndex) {
    throw new EditValidationError(`endIndex (${endIndex}) is beyond the end of the tab body (${tab.endIndex}).`);
  }

  const originalText = tab.text.slice(startIndex, endIndex);
  if (expectedText !== undefined && originalText !== expectedText) {
    if (normalizeExpectedText(originalText) === normalizeExpectedText(expectedText)) {
      notes.push('expectedText matched current document text after normalizing unicode quotes/whitespace/dashes.');
    } else {
      throw new EditValidationError(
        `Text at [${startIndex}, ${endIndex}) does not match expectedText. Current text: ${JSON.stringify(
          truncate(originalText, 300),
        )}. The document may have changed; re-read the range or re-run doc_search_text to get fresh indices.`,
      );
    }
  }

  // The final newline of the body can never be deleted.
  if (endIndex === tab.endIndex && endIndex > startIndex) {
    endIndex -= 1;
    notes.push('Range end clamped by 1: the final newline of the document body cannot be deleted.');
    if (text.endsWith('\n') && originalText.endsWith('\n')) text = text.slice(0, -1);
  } else if (endIndex > startIndex && originalText.endsWith('\n') && text.endsWith('\n')) {
    // Replacing a whole paragraph including its newline with text that also
    // ends in a newline: keep the original paragraph break (and its style).
    endIndex -= 1;
    text = text.slice(0, -1);
    notes.push('Trailing newline preserved: both the original range and the new text ended with a newline.');
  }

  const hasFormatting = hasStyle(textStyle);

  if (endIndex === startIndex && text.length === 0 && !hasFormatting) {
    throw new EditValidationError('Edit is a no-op (empty range, empty text, and no style).');
  }
  if (startIndex < tab.endIndex && isLowSurrogate(tab.text.charCodeAt(startIndex))) {
    throw new EditValidationError(`startIndex ${startIndex} splits a surrogate pair (emoji / astral character).`);
  }
  if (endIndex < tab.endIndex && isLowSurrogate(tab.text.charCodeAt(endIndex))) {
    throw new EditValidationError(`endIndex ${endIndex} splits a surrogate pair (emoji / astral character).`);
  }
  const span = tab.text.slice(startIndex, endIndex);
  if (span.includes(GAP)) {
    throw new EditValidationError(
      `Range [${startIndex}, ${endIndex}) crosses a structural boundary (table, table cell, section break or table of contents). Edit each cell/paragraph separately.`,
    );
  }
  if (endIndex === startIndex && tab.text[startIndex] === GAP) {
    throw new EditValidationError(`Cannot insert text at index ${startIndex}: it is a structural marker (e.g. table start).`);
  }

  return { startIndex, endIndex, text, textStyle, notes, originalText: tab.text.slice(startIndex, endIndex) };
}

/** Sorts edits bottom-up and rejects overlaps. Returns a new array. */
export function sortEditsDescending<T extends IndexRange>(edits: T[]): T[] {
  const sorted = [...edits].sort((a, b) => b.startIndex - a.startIndex || b.endIndex - a.endIndex);
  for (let i = 1; i < sorted.length; i++) {
    const upper = sorted[i - 1];
    const lower = sorted[i];
    if (lower.endIndex > upper.startIndex || lower.startIndex === upper.startIndex) {
      throw new EditValidationError(
        `Edits overlap: [${lower.startIndex}, ${lower.endIndex}) and [${upper.startIndex}, ${upper.endIndex}). Merge them into a single edit.`,
      );
    }
  }
  return sorted;
}

export function withTab<T extends Record<string, any>>(obj: T, tabId?: string): T {
  return tabId ? { ...obj, tabId } : obj;
}

export function buildUpdateTextStyleRequest(
  range: { startIndex: number; endIndex: number; tabId?: string },
  style: TextStyleInput,
): DocsRequest {
  const textStyle: Record<string, any> = {};
  const fields: string[] = [];

  if (style.bold !== undefined) {
    textStyle.bold = style.bold;
    fields.push('bold');
  }
  if (style.italic !== undefined) {
    textStyle.italic = style.italic;
    fields.push('italic');
  }
  if (style.underline !== undefined) {
    textStyle.underline = style.underline;
    fields.push('underline');
  }
  if (style.strikethrough !== undefined) {
    textStyle.strikethrough = style.strikethrough;
    fields.push('strikethrough');
  }
  if (style.fontSize !== undefined) {
    textStyle.fontSize = { magnitude: style.fontSize, unit: 'PT' };
    fields.push('fontSize');
  }
  if (style.foregroundColor !== undefined) {
    const rgb = parseColor(style.foregroundColor);
    textStyle.foregroundColor = { color: { rgbColor: rgb } };
    fields.push('foregroundColor');
  }
  if (style.backgroundColor !== undefined) {
    const rgb = parseColor(style.backgroundColor);
    textStyle.backgroundColor = { color: { rgbColor: rgb } };
    fields.push('backgroundColor');
  }
  if (style.linkUrl !== undefined) {
    textStyle.link = style.linkUrl ? { url: style.linkUrl } : {};
    fields.push('link');
  }

  return {
    updateTextStyle: {
      range: {
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        ...(range.tabId ? { tabId: range.tabId } : {}),
      },
      textStyle,
      fields: fields.join(','),
    },
  };
}

function buildParagraphBorder(b: ParagraphBorderInput, defaultPadding?: number): Record<string, any> {
  const pad = b.padding !== undefined ? b.padding : defaultPadding !== undefined ? defaultPadding : 0;
  const w = b.width !== undefined ? b.width : 1;
  const c = b.color ? parseColor(b.color) : { red: 0, green: 0, blue: 0 };
  return {
    padding: { magnitude: pad, unit: 'PT' },
    width: { magnitude: w, unit: 'PT' },
    dashStyle: b.dashStyle ?? 'SOLID',
    color: { color: { rgbColor: c } },
  };
}

export function buildUpdateParagraphStyleRequest(
  range: { startIndex: number; endIndex: number; tabId?: string },
  style: ParagraphStyleInput,
): DocsRequest {
  const paragraphStyle: Record<string, any> = {};
  const fields: string[] = [];

  if (style.namedStyleType) {
    paragraphStyle.namedStyleType = style.namedStyleType;
    fields.push('namedStyleType');
  }
  if (style.alignment) {
    paragraphStyle.alignment = style.alignment;
    fields.push('alignment');
  }
  if (style.spaceAbove !== undefined) {
    paragraphStyle.spaceAbove = { magnitude: style.spaceAbove, unit: 'PT' };
    fields.push('spaceAbove');
  }
  if (style.spaceBelow !== undefined) {
    paragraphStyle.spaceBelow = { magnitude: style.spaceBelow, unit: 'PT' };
    fields.push('spaceBelow');
  }
  if (style.lineSpacing !== undefined) {
    paragraphStyle.lineSpacing = style.lineSpacing;
    fields.push('lineSpacing');
  }
  if (style.spacingMode) {
    paragraphStyle.spacingMode = style.spacingMode;
    fields.push('spacingMode');
  }
  if (style.indentStart !== undefined) {
    paragraphStyle.indentStart = { magnitude: style.indentStart, unit: 'PT' };
    fields.push('indentStart');
  }
  if (style.indentEnd !== undefined) {
    paragraphStyle.indentEnd = { magnitude: style.indentEnd, unit: 'PT' };
    fields.push('indentEnd');
  }
  if (style.indentFirstLine !== undefined) {
    paragraphStyle.indentFirstLine = { magnitude: style.indentFirstLine, unit: 'PT' };
    fields.push('indentFirstLine');
  }
  if (style.shadingColor !== undefined) {
    paragraphStyle.shading = {
      backgroundColor: { color: { rgbColor: parseColor(style.shadingColor) } },
    };
    fields.push('shading.backgroundColor');
  }
  if (style.keepLinesTogether !== undefined) {
    paragraphStyle.keepLinesTogether = style.keepLinesTogether;
    fields.push('keepLinesTogether');
  }
  if (style.keepWithNext !== undefined) {
    paragraphStyle.keepWithNext = style.keepWithNext;
    fields.push('keepWithNext');
  }
  if (style.avoidWidowAndOrphan !== undefined) {
    paragraphStyle.avoidWidowAndOrphan = style.avoidWidowAndOrphan;
    fields.push('avoidWidowAndOrphan');
  }
  if (style.pageBreakBefore !== undefined) {
    paragraphStyle.pageBreakBefore = style.pageBreakBefore;
    fields.push('pageBreakBefore');
  }

  if (style.padding !== undefined && !style.borderTop && !style.borderBottom && !style.borderLeft && !style.borderRight) {
    const zeroBorder = (pad: number) => ({
      padding: { magnitude: pad, unit: 'PT' },
      width: { magnitude: 0, unit: 'PT' },
      dashStyle: 'SOLID',
      color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
    });
    paragraphStyle.borderTop = zeroBorder(style.padding);
    paragraphStyle.borderBottom = zeroBorder(style.padding);
    paragraphStyle.borderLeft = zeroBorder(style.padding);
    paragraphStyle.borderRight = zeroBorder(style.padding);
    fields.push('borderTop', 'borderBottom', 'borderLeft', 'borderRight');
  } else {
    if (style.borderTop) {
      paragraphStyle.borderTop = buildParagraphBorder(style.borderTop, style.padding);
      fields.push('borderTop');
    }
    if (style.borderBottom) {
      paragraphStyle.borderBottom = buildParagraphBorder(style.borderBottom, style.padding);
      fields.push('borderBottom');
    }
    if (style.borderLeft) {
      paragraphStyle.borderLeft = buildParagraphBorder(style.borderLeft, style.padding);
      fields.push('borderLeft');
    }
    if (style.borderRight) {
      paragraphStyle.borderRight = buildParagraphBorder(style.borderRight, style.padding);
      fields.push('borderRight');
    }
    if (style.borderBetween) {
      paragraphStyle.borderBetween = buildParagraphBorder(style.borderBetween, style.padding);
      fields.push('borderBetween');
    }
  }

  return {
    updateParagraphStyle: {
      range: {
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        ...(range.tabId ? { tabId: range.tabId } : {}),
      },
      paragraphStyle,
      fields: fields.join(','),
    },
  };
}

export function buildBulletsRequest(
  range: { startIndex: number; endIndex: number; tabId?: string },
  preset?: string,
  remove?: boolean,
): DocsRequest {
  const r = {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    ...(range.tabId ? { tabId: range.tabId } : {}),
  };
  if (remove) {
    return { deleteParagraphBullets: { range: r } };
  }
  return {
    createParagraphBullets: {
      range: r,
      bulletPreset: preset || 'BULLET_DISC_CIRCLE_SQUARE',
    },
  };
}

export function buildInsertTableRequest(
  location: { index: number; tabId?: string },
  rows: number,
  columns: number,
): DocsRequest {
  return {
    insertTable: {
      rows,
      columns,
      location: {
        index: location.index,
        ...(location.tabId ? { tabId: location.tabId } : {}),
      },
    },
  };
}

export function buildInsertTableRowRequest(
  tableStart: number,
  rowIndex: number,
  columnIndex: number,
  insertBelow: boolean,
  tabId?: string,
): DocsRequest {
  return {
    insertTableRow: {
      insertBelow,
      tableCellLocation: {
        tableStartLocation: { index: tableStart, ...(tabId ? { tabId } : {}) },
        rowIndex,
        columnIndex,
      },
    },
  };
}

export function buildDeleteTableRowRequest(
  tableStart: number,
  rowIndex: number,
  columnIndex: number,
  tabId?: string,
): DocsRequest {
  return {
    deleteTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: tableStart, ...(tabId ? { tabId } : {}) },
        rowIndex,
        columnIndex,
      },
    },
  };
}

export function buildInsertTableColumnRequest(
  tableStart: number,
  rowIndex: number,
  columnIndex: number,
  insertRight: boolean,
  tabId?: string,
): DocsRequest {
  return {
    insertTableColumn: {
      insertRight,
      tableCellLocation: {
        tableStartLocation: { index: tableStart, ...(tabId ? { tabId } : {}) },
        rowIndex,
        columnIndex,
      },
    },
  };
}

export function buildDeleteTableColumnRequest(
  tableStart: number,
  rowIndex: number,
  columnIndex: number,
  tabId?: string,
): DocsRequest {
  return {
    deleteTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: tableStart, ...(tabId ? { tabId } : {}) },
        rowIndex,
        columnIndex,
      },
    },
  };
}

export function buildInsertImageRequest(
  location: { index: number; tabId?: string },
  uri: string,
  widthPt?: number,
  heightPt?: number,
): DocsRequest {
  const objectSize: Record<string, any> = {};
  if (widthPt) objectSize.width = { magnitude: widthPt, unit: 'PT' };
  if (heightPt) objectSize.height = { magnitude: heightPt, unit: 'PT' };

  return {
    insertInlineImage: {
      uri,
      location: {
        index: location.index,
        ...(location.tabId ? { tabId: location.tabId } : {}),
      },
      ...(Object.keys(objectSize).length ? { objectSize } : {}),
    },
  };
}

/** Builds the requests for one replacement with optional formatting. */
export function buildReplaceRequests(tab: TabModel, edit: RangeEdit): DocsRequest[] {
  const { startIndex, endIndex, text, textStyle } = edit;
  const reqs: DocsRequest[] = [];
  const shouldStyle = hasStyle(textStyle);

  const del: DocsRequest | null =
    endIndex > startIndex
      ? { deleteContentRange: { range: withTab({ startIndex, endIndex }, tab.tabId) } }
      : null;

  // Case 1: Pure styling on existing text range (no new text inserted)
  if (!text) {
    if (shouldStyle && endIndex > startIndex) {
      reqs.push(buildUpdateTextStyleRequest(withTab({ startIndex, endIndex }, tab.tabId), textStyle!));
      return reqs;
    }
    return del ? [del] : [];
  }

  // Case 2: Text replacement / insertion with optional styling
  const canInsertAtEnd = endIndex < tab.endIndex && tab.text[endIndex] !== GAP;
  if (canInsertAtEnd || !del) {
    reqs.push({ insertText: { location: withTab({ index: endIndex }, tab.tabId), text } });
    if (shouldStyle) {
      reqs.push(
        buildUpdateTextStyleRequest(
          withTab({ startIndex: endIndex, endIndex: endIndex + text.length }, tab.tabId),
          textStyle!,
        ),
      );
    }
    if (del) reqs.push(del);
  } else {
    if (del) reqs.push(del);
    reqs.push({ insertText: { location: withTab({ index: startIndex }, tab.tabId), text } });
    if (shouldStyle) {
      reqs.push(
        buildUpdateTextStyleRequest(
          withTab({ startIndex, endIndex: startIndex + text.length }, tab.tabId),
          textStyle!,
        ),
      );
    }
  }
  return reqs;
}

/** Builds requests for many edits, applied strictly bottom-to-top. */
export function buildMultiEditRequests(tab: TabModel, edits: RangeEdit[]): DocsRequest[] {
  return sortEditsDescending(edits).flatMap((e) => buildReplaceRequests(tab, e));
}

export interface RedlineEdit extends IndexRange {
  expectedText?: string;
  replacementText?: string;
  retainedStyle?: TextStyleInput;
  replacementStyle?: TextStyleInput;
  insertionPosition?: 'AFTER' | 'BEFORE';
}

export const DEFAULT_REDLINE_RETAINED_STYLE: TextStyleInput = { bold: true, strikethrough: true };
export const DEFAULT_REDLINE_REPLACEMENT_STYLE: TextStyleInput = { bold: true, strikethrough: false };

/**
 * Builds Docs API requests for a redline amendment:
 * - Retained text in [startIndex, endIndex) is kept in the document and styled with retainedStyle
 * - Replacement text is inserted alongside it with replacementStyle (strikethrough explicitly false)
 * - Safe sequencing: inserted text is placed and styled FIRST so Docs API never expands the
 *   retained text's strikethrough to cover the newly inserted text.
 */
export function buildRedlineRequests(tab: TabModel, edit: RedlineEdit): DocsRequest[] {
  const {
    startIndex,
    endIndex,
    replacementText,
    retainedStyle = DEFAULT_REDLINE_RETAINED_STYLE,
    replacementStyle = DEFAULT_REDLINE_REPLACEMENT_STYLE,
    insertionPosition = 'AFTER',
  } = edit;
  const reqs: DocsRequest[] = [];

  const effReplacementStyle: TextStyleInput = {
    ...replacementStyle,
    strikethrough: replacementStyle.strikethrough ?? false,
  };

  const hasReplacement = replacementText !== undefined && replacementText.length > 0;
  const hasRange = endIndex > startIndex;

  if (hasReplacement) {
    if (insertionPosition === 'AFTER') {
      reqs.push({ insertText: { location: withTab({ index: endIndex }, tab.tabId), text: replacementText } });
      reqs.push(
        buildUpdateTextStyleRequest(
          withTab({ startIndex: endIndex, endIndex: endIndex + replacementText.length }, tab.tabId),
          effReplacementStyle,
        ),
      );
      if (hasRange) {
        reqs.push(buildUpdateTextStyleRequest(withTab({ startIndex, endIndex }, tab.tabId), retainedStyle));
      }
    } else {
      // insertionPosition === 'BEFORE'
      reqs.push({ insertText: { location: withTab({ index: startIndex }, tab.tabId), text: replacementText } });
      reqs.push(
        buildUpdateTextStyleRequest(
          withTab({ startIndex, endIndex: startIndex + replacementText.length }, tab.tabId),
          effReplacementStyle,
        ),
      );
      if (hasRange) {
        reqs.push(
          buildUpdateTextStyleRequest(
            withTab(
              { startIndex: startIndex + replacementText.length, endIndex: endIndex + replacementText.length },
              tab.tabId,
            ),
            retainedStyle,
          ),
        );
      }
    }
  } else if (hasRange) {
    // Retained deletion / strike-out only without replacement text
    reqs.push(buildUpdateTextStyleRequest(withTab({ startIndex, endIndex }, tab.tabId), retainedStyle));
  }

  return reqs;
}

/** Builds requests for many redline edits, applied strictly bottom-to-top. */
export function buildMultiRedlineRequests(tab: TabModel, edits: RedlineEdit[]): DocsRequest[] {
  return sortEditsDescending(edits).flatMap((e) => buildRedlineRequests(tab, e));
}

