/**
 * Edit planning: validates index ranges against the cached document and builds
 * Docs API batchUpdate requests that are safe to submit together.
 *
 * Ordering rule (CRITICAL): edits are always emitted in DESCENDING startIndex
 * order (bottom-to-top) so earlier requests never shift the indices of later
 * ones.
 *
 * Replacement strategy: each replacement is emitted as
 *     insertText @ endIndex   followed by   deleteContentRange [startIndex, endIndex)
 * Inserting at the END of the range first means
 *   - in SUGGEST mode the result reads "old (struck through) → new (green)", and
 *     the deletion range is still valid because nothing before it moved;
 *   - in EDIT mode the result is identical to delete-then-insert, but the new
 *     text inherits the styling of the replaced text (the Docs API styles
 *     inserted text like the character immediately before the insertion point).
 * If endIndex sits on a structural marker (e.g. the start of a table) where
 * text cannot be inserted, we fall back to delete-then-insert @ startIndex.
 */

import { GAP, type IndexRange, type TabModel, truncate } from './docModel.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type DocsRequest = Record<string, any>;

export class EditValidationError extends Error {}

export interface RangeEdit extends IndexRange {
  text: string;
}

export interface PlannedEdit extends RangeEdit {
  /** Human-readable notes about automatic adjustments. */
  notes: string[];
  /** Original text being replaced (raw buffer slice). */
  originalText: string;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Validates a single range edit against the tab buffer and normalises it.
 * Throws EditValidationError with an actionable message on failure.
 */
export function planRangeEdit(tab: TabModel, edit: RangeEdit, expectedText?: string): PlannedEdit {
  let { startIndex, endIndex, text } = edit;
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
    throw new EditValidationError(
      `Text at [${startIndex}, ${endIndex}) does not match expectedText. Current text: ${JSON.stringify(
        truncate(originalText, 300),
      )}. The document may have changed; re-read the range or re-run doc_search_text to get fresh indices.`,
    );
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

  if (endIndex === startIndex && text.length === 0) {
    throw new EditValidationError('Edit is a no-op (empty range and empty text).');
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

  return { startIndex, endIndex, text, notes, originalText: tab.text.slice(startIndex, endIndex) };
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

function withTab<T extends Record<string, any>>(obj: T, tabId: string): T {
  return tabId ? { ...obj, tabId } : obj;
}

/** Builds the requests for one replacement (see module docs for the strategy). */
export function buildReplaceRequests(tab: TabModel, edit: RangeEdit): DocsRequest[] {
  const { startIndex, endIndex, text } = edit;
  const reqs: DocsRequest[] = [];
  const del: DocsRequest | null =
    endIndex > startIndex
      ? { deleteContentRange: { range: withTab({ startIndex, endIndex }, tab.tabId) } }
      : null;
  if (!text) return del ? [del] : [];

  const canInsertAtEnd = endIndex < tab.endIndex && tab.text[endIndex] !== GAP;
  if (canInsertAtEnd || !del) {
    reqs.push({ insertText: { location: withTab({ index: endIndex }, tab.tabId), text } });
    if (del) reqs.push(del);
  } else {
    reqs.push(del);
    reqs.push({ insertText: { location: withTab({ index: startIndex }, tab.tabId), text } });
  }
  return reqs;
}

/** Builds requests for many edits, applied strictly bottom-to-top. */
export function buildMultiEditRequests(tab: TabModel, edits: RangeEdit[]): DocsRequest[] {
  return sortEditsDescending(edits).flatMap((e) => buildReplaceRequests(tab, e));
}
