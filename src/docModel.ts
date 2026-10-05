/**
 * Document model: converts a raw Google Docs `documents.get` response into a
 * compact, index-faithful in-memory representation with rich-text, layout,
 * table, and image support.
 *
 * Coordinate contract
 * -------------------
 * Every TabModel owns a `text` buffer where `text[i]` corresponds EXACTLY to
 * Google Docs index `i` (0-based UTF-16 code units). JavaScript strings are
 * UTF-16, so `text.slice(start, end)` is the content of Docs range [start, end).
 *
 *  - Text runs are written verbatim at their `startIndex`.
 *  - Non-text paragraph elements (images, chips, page breaks, ...) are filled
 *    with OBJ (U+FFFC), one per code unit they occupy.
 *  - Structural markers that occupy an index but carry no text (section breaks,
 *    table / row / cell starts, table-of-contents starts) are filled with GAP
 *    (U+0000). Ranges containing GAP cross structural boundaries and are
 *    generally not editable as plain text.
 */

import type { docs_v1 } from '@googleapis/docs';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

export const GAP = '\u0000';
export const OBJ = '\uFFFC';
const PUA_OBJ = '\uE907'; // Docs' own placeholder for non-text content inside text runs

export interface IndexRange {
  startIndex: number;
  endIndex: number;
}

export interface ParagraphBorderInfo {
  padding?: number;
  width?: number;
  dashStyle?: string;
  color?: string;
}

export interface ParagraphStyleInfo {
  namedStyleType?: string;
  alignment?: 'START' | 'CENTER' | 'END' | 'JUSTIFIED';
  lineSpacing?: number;
  spaceAbove?: number;
  spaceBelow?: number;
  spacingMode?: string;
  indentStart?: number;
  indentEnd?: number;
  indentFirstLine?: number;
  keepLinesTogether?: boolean;
  keepWithNext?: boolean;
  avoidWidowAndOrphan?: boolean;
  pageBreakBefore?: boolean;
  shadingColor?: string;
  borderTop?: ParagraphBorderInfo;
  borderBottom?: ParagraphBorderInfo;
  borderLeft?: ParagraphBorderInfo;
  borderRight?: ParagraphBorderInfo;
  borderBetween?: ParagraphBorderInfo;
}

export interface ParagraphInfo extends IndexRange {
  namedStyleType: string;
  alignment?: string;
  style?: ParagraphStyleInfo;
  hasBullet: boolean;
  inTable: boolean;
  tableContext?: {
    tableIndex: number;
    rowIndex: number;
    columnIndex: number;
  };
}

export interface SuggestionMark extends IndexRange {
  kind: 'insertion' | 'deletion';
  suggestionIds: string[];
}

export interface SuggestionSpan {
  kinds: Set<string>;
  ranges: IndexRange[];
}

export interface OutlineEntry {
  level: number;
  title: string;
  startIndex: number;
  endIndex: number;
  /** End of the section this heading introduces (start of next heading of same/higher rank, or end of tab). */
  sectionEndIndex: number;
  isPseudo: boolean;
  inTable?: boolean;
}

export interface TextStyleInfo {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  foregroundColor?: string;
  backgroundColor?: string;
  linkUrl?: string;
}

export interface StyledRun extends IndexRange {
  text: string;
  style: TextStyleInfo;
  suggestion?: {
    kind: 'insertion' | 'deletion';
    suggestionIds: string[];
  };
}

export interface TableCellModel extends IndexRange {
  rowIndex: number;
  columnIndex: number;
  text: string;
  contentStartIndex?: number;
}

export interface TableModel extends IndexRange {
  tableIndex: number;
  rows: number;
  columns: number;
  cells: TableCellModel[];
}

export interface ImageModel extends IndexRange {
  objectId: string;
  title?: string;
  description?: string;
  contentUri?: string;
  width?: number;
  height?: number;
}

export interface DocumentElementModel extends IndexRange {
  type: 'image' | 'horizontalRule' | 'pageBreak' | 'columnBreak' | 'equation' | 'date' | 'richLink';
  detail?: string;
}

export interface TabModel {
  tabId: string;
  title: string;
  nestingLevel: number;
  text: string;
  endIndex: number;
  paragraphs: ParagraphInfo[];
  outline: OutlineEntry[];
  /** anchorId -> merged, sorted ranges */
  commentAnchors: Map<string, IndexRange[]>;
  suggestionMarks: SuggestionMark[];
  suggestionSpans: Map<string, SuggestionSpan>;
  styledRuns: StyledRun[];
  tables: TableModel[];
  images: ImageModel[];
  elements: DocumentElementModel[];
  /** Lazily computed case-folded copy of `text` (same length). */
  foldedText?: string;
}

export interface PostInfo {
  postId?: string;
  author: string;
  me?: boolean;
  content: string;
  createTime?: string;
  commentAction?: string;
}

export interface CommentInfo {
  commentId: string;
  anchorId?: string;
  status: 'OPEN' | 'RESOLVED' | 'UNKNOWN';
  quote?: string;
  head: PostInfo;
  replies: PostInfo[];
}

export interface SuggestionThreadInfo {
  suggestionId: string;
  status: string;
  author?: string;
  summary?: string;
  replyCount: number;
}

export interface DocModel {
  documentId: string;
  title: string;
  revisionId?: string;
  fetchedAt: number;
  tabs: TabModel[];
  comments: CommentInfo[];
  suggestionThreads: SuggestionThreadInfo[];
  commentsAvailable: boolean;
  commentsUnavailableReason?: string;
  inlineObjects?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface BuildOptions {
  commentsAvailable: boolean;
  commentsUnavailableReason?: string;
  fetchedAt?: number;
}

export function formatColor(rgb?: { red?: number | null; green?: number | null; blue?: number | null }): string | undefined {
  if (!rgb) return undefined;
  const r = Math.round((rgb.red ?? 0) * 255)
    .toString(16)
    .padStart(2, '0');
  const g = Math.round((rgb.green ?? 0) * 255)
    .toString(16)
    .padStart(2, '0');
  const b = Math.round((rgb.blue ?? 0) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${r}${g}${b}`;
}

export function parseParagraphBorder(b?: any): ParagraphBorderInfo | undefined {
  if (!b) return undefined;
  const res: ParagraphBorderInfo = {};
  if (b.padding?.magnitude !== undefined && b.padding?.magnitude !== null) res.padding = b.padding.magnitude;
  if (b.width?.magnitude !== undefined && b.width?.magnitude !== null) res.width = b.width.magnitude;
  if (b.dashStyle) res.dashStyle = b.dashStyle;
  const c = formatColor(b.color?.color?.rgbColor);
  if (c) res.color = c;
  return Object.keys(res).length > 0 ? res : undefined;
}

export function parseParagraphStyle(ps?: any): ParagraphStyleInfo | undefined {
  if (!ps) return undefined;
  const res: ParagraphStyleInfo = {};
  if (ps.namedStyleType) res.namedStyleType = ps.namedStyleType;
  if (ps.alignment) res.alignment = ps.alignment;
  if (ps.lineSpacing !== undefined && ps.lineSpacing !== null) res.lineSpacing = ps.lineSpacing;
  if (ps.spaceAbove?.magnitude !== undefined && ps.spaceAbove?.magnitude !== null) res.spaceAbove = ps.spaceAbove.magnitude;
  if (ps.spaceBelow?.magnitude !== undefined && ps.spaceBelow?.magnitude !== null) res.spaceBelow = ps.spaceBelow.magnitude;
  if (ps.spacingMode) res.spacingMode = ps.spacingMode;
  if (ps.indentStart?.magnitude !== undefined && ps.indentStart?.magnitude !== null) res.indentStart = ps.indentStart.magnitude;
  if (ps.indentEnd?.magnitude !== undefined && ps.indentEnd?.magnitude !== null) res.indentEnd = ps.indentEnd.magnitude;
  if (ps.indentFirstLine?.magnitude !== undefined && ps.indentFirstLine?.magnitude !== null) res.indentFirstLine = ps.indentFirstLine.magnitude;
  if (ps.keepLinesTogether !== undefined && ps.keepLinesTogether !== null) res.keepLinesTogether = ps.keepLinesTogether;
  if (ps.keepWithNext !== undefined && ps.keepWithNext !== null) res.keepWithNext = ps.keepWithNext;
  if (ps.avoidWidowAndOrphan !== undefined && ps.avoidWidowAndOrphan !== null) res.avoidWidowAndOrphan = ps.avoidWidowAndOrphan;
  if (ps.pageBreakBefore !== undefined && ps.pageBreakBefore !== null) res.pageBreakBefore = ps.pageBreakBefore;
  const bg = formatColor(ps.shading?.backgroundColor?.color?.rgbColor);
  if (bg) res.shadingColor = bg;
  const bt = parseParagraphBorder(ps.borderTop);
  if (bt) res.borderTop = bt;
  const bb = parseParagraphBorder(ps.borderBottom);
  if (bb) res.borderBottom = bb;
  const bl = parseParagraphBorder(ps.borderLeft);
  if (bl) res.borderLeft = bl;
  const br = parseParagraphBorder(ps.borderRight);
  if (br) res.borderRight = br;
  const bbw = parseParagraphBorder(ps.borderBetween);
  if (bbw) res.borderBetween = bbw;

  return Object.keys(res).length > 0 ? res : undefined;
}

function sameStyle(a: TextStyleInfo, b: TextStyleInfo): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strikethrough === !!b.strikethrough &&
    a.fontSize === b.fontSize &&
    a.foregroundColor === b.foregroundColor &&
    a.backgroundColor === b.backgroundColor &&
    a.linkUrl === b.linkUrl
  );
}

export function buildDocModel(raw: docs_v1.Schema$Document, opts: BuildOptions): DocModel {
  const tabs: TabModel[] = [];
  const inlineObjects = raw.inlineObjects ?? {};

  if (Array.isArray(raw.tabs) && raw.tabs.length > 0) {
    const visit = (tab: Raw, level: number) => {
      const props = tab.tabProperties ?? {};
      if (tab.documentTab) {
        tabs.push(buildTab(props.tabId ?? '', props.title ?? '', level, tab.documentTab, inlineObjects));
      }
      for (const child of tab.childTabs ?? []) visit(child, level + 1);
    };
    for (const t of raw.tabs) visit(t, 0);
  } else {
    // Legacy single-tab shape (includeTabsContent=false).
    tabs.push(buildTab('', raw.title ?? '', 0, raw, inlineObjects));
  }

  return {
    documentId: raw.documentId ?? '',
    title: raw.title ?? '',
    revisionId: raw.revisionId ?? undefined,
    fetchedAt: opts.fetchedAt ?? Date.now(),
    tabs,
    comments: (raw.comments ?? []).map(parseComment),
    suggestionThreads: (raw.suggestions ?? []).map(parseSuggestionThread),
    commentsAvailable: opts.commentsAvailable,
    commentsUnavailableReason: opts.commentsUnavailableReason,
    inlineObjects,
  };
}

function namedStyleMap(namedStyles: Raw): Map<string, Raw> {
  const m = new Map<string, Raw>();
  for (const s of namedStyles?.styles ?? []) {
    if (s.namedStyleType) m.set(s.namedStyleType, s);
  }
  return m;
}

/** Returns the single "payload" object of a ParagraphElement other than textRun (e.g. inlineObjectElement). */
function elementPayload(pe: Raw): Raw | undefined {
  for (const [k, v] of Object.entries(pe)) {
    if (k !== 'startIndex' && k !== 'endIndex' && v && typeof v === 'object') return v;
  }
  return undefined;
}

function buildTab(tabId: string, title: string, nestingLevel: number, dt: Raw, inlineObjects?: Record<string, any>): TabModel {
  const content: Raw[] = dt.body?.content ?? [];
  const endIndex: number = content.length ? content[content.length - 1].endIndex ?? 0 : 0;
  const chars: string[] = new Array(endIndex).fill(GAP);
  const paragraphs: ParagraphInfo[] = [];
  const marks: SuggestionMark[] = [];
  const spans = new Map<string, SuggestionSpan>();
  const styles = namedStyleMap(dt.namedStyles);
  const baseSize: number = styles.get('NORMAL_TEXT')?.textStyle?.fontSize?.magnitude ?? 11;

  const styledRuns: StyledRun[] = [];
  const tables: TableModel[] = [];
  const images: ImageModel[] = [];
  const elements: DocumentElementModel[] = [];

  interface Candidate {
    level: number;
    title: string;
    startIndex: number;
    endIndex: number;
    isPseudo: boolean;
    inTable?: boolean;
  }
  const candidates: Candidate[] = [];
  let lastFormalLevel = 0;

  const write = (start: number, s: string, end: number) => {
    const n = Math.min(s.length, end - start);
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= endIndex) continue;
      const c = s[i];
      chars[idx] = c === PUA_OBJ ? OBJ : c;
    }
  };
  const fill = (start: number, end: number, c: string) => {
    for (let i = Math.max(0, start); i < Math.min(end, endIndex); i++) chars[i] = c;
  };
  const addSpan = (id: string, kind: string, start: number, end: number) => {
    let span = spans.get(id);
    if (!span) {
      span = { kinds: new Set(), ranges: [] };
      spans.set(id, span);
    }
    span.kinds.add(kind);
    const last = span.ranges[span.ranges.length - 1];
    if (last && start <= last.endIndex) last.endIndex = Math.max(last.endIndex, end);
    else span.ranges.push({ startIndex: start, endIndex: end });
  };
  const addMark = (kind: 'insertion' | 'deletion', ids: string[], start: number, end: number) => {
    const last = marks[marks.length - 1];
    if (last && last.kind === kind && last.endIndex === start && sameIds(last.suggestionIds, ids)) {
      last.endIndex = end;
    } else {
      marks.push({ kind, suggestionIds: [...ids], startIndex: start, endIndex: end });
    }
  };
  const trackSuggestions = (holder: Raw, start: number, end: number) => {
    const ins: string[] = holder?.suggestedInsertionIds ?? [];
    const del: string[] = holder?.suggestedDeletionIds ?? [];
    for (const id of ins) addSpan(id, 'insertion', start, end);
    for (const id of del) addSpan(id, 'deletion', start, end);
    if (del.length) addMark('deletion', del, start, end);
    else if (ins.length) addMark('insertion', ins, start, end);
  };

  const walk = (
    elementList: Raw[],
    inTable: boolean,
    tableCtx?: { tableIndex: number; rowIndex: number; columnIndex: number },
  ) => {
    for (const el of elementList) {
      const elStart: number = el.startIndex ?? 0;
      const elEnd: number = el.endIndex ?? elStart;
      if (el.paragraph) {
        const p = el.paragraph;
        const nst: string = p.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
        const ns = styles.get(nst);
        let text = '';
        let anyVisible = false;
        let allBold = true;
        let maxSize = 0;
        for (const pe of p.elements ?? []) {
          const s: number = pe.startIndex ?? elStart;
          const e: number = pe.endIndex ?? s;
          if (pe.textRun) {
            const c: string = pe.textRun.content ?? '';
            write(s, c, e);
            text += c;
            const ts = pe.textRun.textStyle ?? {};
            if (c.trim()) {
              anyVisible = true;
              const bold = ts.bold ?? ns?.textStyle?.bold ?? false;
              if (!bold) allBold = false;
              const size: number = ts.fontSize?.magnitude ?? ns?.textStyle?.fontSize?.magnitude ?? baseSize;
              maxSize = Math.max(maxSize, size);
            }
            trackSuggestions(pe.textRun, s, e);
            for (const [id, change] of Object.entries(pe.textRun.suggestedTextStyleChanges ?? {})) {
              addSpan(id, 'textStyle', s, e);
              const st = (change as any)?.textStyleSuggestionState;
              if (st?.strikethroughSuggested) addSpan(id, 'format:strikethrough', s, e);
              if (st?.boldSuggested) addSpan(id, 'format:bold', s, e);
            }

            const style: TextStyleInfo = {
              bold: ts.bold ?? ns?.textStyle?.bold ?? false,
              italic: ts.italic ?? ns?.textStyle?.italic ?? false,
              underline: ts.underline ?? ns?.textStyle?.underline ?? false,
              strikethrough: ts.strikethrough ?? ns?.textStyle?.strikethrough ?? false,
              fontSize: ts.fontSize?.magnitude ?? ns?.textStyle?.fontSize?.magnitude ?? undefined,
              foregroundColor: formatColor(ts.foregroundColor?.color?.rgbColor),
              backgroundColor: formatColor(ts.backgroundColor?.color?.rgbColor),
              linkUrl: ts.link?.url ?? undefined,
            };

            const ins: string[] = pe.textRun.suggestedInsertionIds ?? [];
            const del: string[] = pe.textRun.suggestedDeletionIds ?? [];
            const sug = del.length
              ? { kind: 'deletion' as const, suggestionIds: [...del] }
              : ins.length
                ? { kind: 'insertion' as const, suggestionIds: [...ins] }
                : undefined;

            const sameSuggestion = (a?: StyledRun['suggestion'], b?: StyledRun['suggestion']) => {
              if (!a && !b) return true;
              if (!a || !b) return false;
              return a.kind === b.kind && sameIds(a.suggestionIds, b.suggestionIds);
            };

            const lastRun = styledRuns[styledRuns.length - 1];
            if (lastRun && lastRun.endIndex === s && sameStyle(lastRun.style, style) && sameSuggestion(lastRun.suggestion, sug)) {
              lastRun.endIndex = e;
              lastRun.text += c;
            } else {
              styledRuns.push({
                startIndex: s,
                endIndex: e,
                text: c,
                style,
                suggestion: sug,
              });
            }
          } else if (pe.inlineObjectElement) {
            fill(s, e, OBJ);
            text += OBJ.repeat(Math.max(0, e - s));
            trackSuggestions(elementPayload(pe), s, e);
            const objId: string = pe.inlineObjectElement.inlineObjectId ?? '';
            const objProp = inlineObjects?.[objId]?.inlineObjectProperties?.embeddedObject;
            images.push({
              startIndex: s,
              endIndex: e,
              objectId: objId,
              title: objProp?.title ?? undefined,
              description: objProp?.description ?? undefined,
              contentUri: objProp?.imageProperties?.contentUri ?? undefined,
              width: objProp?.size?.width?.magnitude ?? undefined,
              height: objProp?.size?.height?.magnitude ?? undefined,
            });
            elements.push({
              type: 'image',
              startIndex: s,
              endIndex: e,
              detail: objProp?.title || objProp?.description || objId,
            });
          } else if (pe.horizontalRule) {
            fill(s, e, OBJ);
            text += OBJ.repeat(Math.max(0, e - s));
            elements.push({ type: 'horizontalRule', startIndex: s, endIndex: e });
          } else if (pe.pageBreak) {
            fill(s, e, OBJ);
            text += OBJ.repeat(Math.max(0, e - s));
            elements.push({ type: 'pageBreak', startIndex: s, endIndex: e });
          } else {
            fill(s, e, OBJ);
            text += OBJ.repeat(Math.max(0, e - s));
            trackSuggestions(elementPayload(pe), s, e);
          }
        }
        for (const id of Object.keys(p.suggestedParagraphStyleChanges ?? {})) addSpan(id, 'paragraphStyle', elStart, elEnd);
        for (const id of Object.keys(p.suggestedBulletChanges ?? {})) addSpan(id, 'bullet', elStart, elEnd);

        paragraphs.push({
          startIndex: elStart,
          endIndex: elEnd,
          namedStyleType: nst,
          alignment: p.paragraphStyle?.alignment ?? undefined,
          style: parseParagraphStyle(p.paragraphStyle),
          hasBullet: !!p.bullet,
          inTable,
          tableContext: tableCtx,
        });

        const clean = text.replace(/\n$/, '').replace(new RegExp(OBJ, 'g'), '').trim();
        if (clean) {
          if (nst.startsWith('HEADING_') || nst === 'TITLE') {
            const level = nst === 'TITLE' ? 0 : parseInt(nst.slice('HEADING_'.length), 10) || 1;
            lastFormalLevel = level;
            candidates.push({ level, title: clean, startIndex: elStart, endIndex: elEnd, isPseudo: false, inTable });
          } else if (
            !inTable &&
            !p.bullet &&
            clean.length < 80 &&
            !clean.includes('\u000b') &&
            anyVisible &&
            (allBold || maxSize > baseSize)
          ) {
            candidates.push({
              level: Math.min(6, lastFormalLevel + 1),
              title: clean,
              startIndex: elStart,
              endIndex: elEnd,
              isPseudo: true,
              inTable: false,
            });
          }
        }
      } else if (el.table) {
        const tableStart = el.startIndex ?? 0;
        const tableEnd = el.endIndex ?? tableStart;
        const tableRows = el.table.tableRows ?? [];
        const rowCount = tableRows.length;
        const colCount = el.table.columns ?? (tableRows[0]?.tableCells?.length ?? 0);
        const cells: TableCellModel[] = [];
        const currentTableIndex = tables.length;

        for (let rIdx = 0; rIdx < rowCount; rIdx++) {
          const row = tableRows[rIdx];
          const rowCells = row.tableCells ?? [];
          for (let cIdx = 0; cIdx < rowCells.length; cIdx++) {
            const cell = rowCells[cIdx];
            const cellStart = cell.startIndex ?? 0;
            const cellEnd = cell.endIndex ?? cellStart;
            const contentStart = cell.content?.[0]?.startIndex ?? (cellStart + 1);
            walk(cell.content ?? [], true, { tableIndex: currentTableIndex, rowIndex: rIdx, columnIndex: cIdx });
            cells.push({
              rowIndex: rIdx,
              columnIndex: cIdx,
              startIndex: cellStart,
              endIndex: cellEnd,
              contentStartIndex: contentStart,
              text: '', // populated below after walk
            });
          }
        }
        tables.push({
          tableIndex: currentTableIndex,
          startIndex: tableStart,
          endIndex: tableEnd,
          rows: rowCount,
          columns: colCount,
          cells,
        });
      } else if (el.tableOfContents) {
        walk(el.tableOfContents.content ?? [], true);
      }
      // sectionBreak: occupies its index, no text (left as GAP).
    }
  };
  walk(content, false);

  // Populate cell text from chars buffer
  for (const table of tables) {
    for (const cell of table.cells) {
      const rawCell = chars.slice(cell.startIndex, cell.endIndex).join('');
      cell.text = sanitize(rawCell).trim();
    }
  }

  const outline: OutlineEntry[] = candidates.map((c, i) => {
    let sectionEnd = endIndex;
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[j].level <= c.level) {
        sectionEnd = candidates[j].startIndex;
        break;
      }
    }
    return { ...c, sectionEndIndex: sectionEnd };
  });

  const commentAnchors = new Map<string, IndexRange[]>();
  for (const [key, anchor] of Object.entries<Raw>(dt.commentAnchors ?? {})) {
    const id: string = anchor?.anchorId ?? key;
    const ranges: IndexRange[] = (anchor?.ranges ?? [])
      .map((r: Raw) => ({ startIndex: r.startIndex ?? 0, endIndex: r.endIndex ?? 0 }))
      .filter((r: IndexRange) => r.endIndex >= r.startIndex);
    commentAnchors.set(id, mergeRanges(ranges));
  }

  return {
    tabId,
    title,
    nestingLevel,
    text: chars.join(''),
    endIndex,
    paragraphs,
    outline,
    commentAnchors,
    suggestionMarks: marks,
    suggestionSpans: spans,
    styledRuns,
    tables,
    images,
    elements,
  };
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Sorts and merges overlapping or touching ranges. */
export function mergeRanges(ranges: IndexRange[]): IndexRange[] {
  const sorted = [...ranges].sort((a, b) => a.startIndex - b.startIndex);
  const out: IndexRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startIndex <= last.endIndex) last.endIndex = Math.max(last.endIndex, r.endIndex);
    else out.push({ ...r });
  }
  return out;
}

function parsePost(p: Raw): PostInfo {
  const a = p?.author ?? {};
  return {
    postId: p?.postId,
    author: a.displayName ?? (a.anonymous ? 'Anonymous' : 'Unknown'),
    me: a.me || undefined,
    content: p?.content ?? '',
    createTime: p?.createTime,
    commentAction:
      p?.commentAction && p.commentAction !== 'COMMENT_ACTION_TYPE_UNSPECIFIED' && p.commentAction !== 'NO_COMMENT_ACTION_CHANGE'
        ? p.commentAction
        : undefined,
  };
}

function parseComment(c: Raw): CommentInfo {
  const status = c.status === 'OPEN' || c.status === 'RESOLVED' ? c.status : 'UNKNOWN';
  return {
    commentId: c.commentId,
    anchorId: c.anchorId || undefined,
    status,
    quote: c.plainTextQuote || undefined,
    head: parsePost(c.headPost),
    replies: (c.replies ?? []).filter((r: Raw) => !r.deleted).map(parsePost),
  };
}

function parseSuggestionThread(s: Raw): SuggestionThreadInfo {
  return {
    suggestionId: s.suggestionId,
    status: s.status ?? 'STATUS_UNSPECIFIED',
    author: s.headPost?.author?.displayName,
    summary: s.summaryText || undefined,
    replyCount: (s.replies ?? []).filter((r: Raw) => !r.deleted).length,
  };
}

// ---------------------------------------------------------------------------
// Queries & Slicers
// ---------------------------------------------------------------------------

export function getTab(model: DocModel, tabId?: string): TabModel {
  if (!tabId) {
    const t = model.tabs[0];
    if (!t) throw new Error('Document has no readable tabs.');
    return t;
  }
  const t = model.tabs.find((x) => x.tabId === tabId);
  if (!t) {
    throw new Error(`Tab "${tabId}" not found. Available tabs: ${model.tabs.map((x) => `${x.tabId} (${x.title})`).join(', ')}`);
  }
  return t;
}

/** Index of the paragraph containing `index` (last paragraph whose start <= index), or -1. */
export function paragraphIndexAt(tab: TabModel, index: number): number {
  const ps = tab.paragraphs;
  let lo = 0;
  let hi = ps.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ps[mid].startIndex <= index) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function sanitize(s: string): string {
  return s.split(GAP).join('');
}

/**
 * Renders [start, end) as plain human-readable text. GAP markers are dropped.
 * When `markSuggestions` is set, pending suggested deletions are wrapped as
 * `[-text-]` and suggested insertions as `{+text+}`.
 */
export function renderText(tab: TabModel, start: number, end: number, markSuggestions = false): string {
  start = Math.max(0, start);
  end = Math.min(tab.endIndex, end);
  if (end <= start) return '';
  if (!markSuggestions || tab.suggestionMarks.length === 0) return sanitize(tab.text.slice(start, end));
  let out = '';
  let pos = start;
  for (const m of tab.suggestionMarks) {
    if (m.endIndex <= start) continue;
    if (m.startIndex >= end) break;
    const s = Math.max(m.startIndex, start);
    const e = Math.min(m.endIndex, end);
    if (s > pos) out += sanitize(tab.text.slice(pos, s));
    const body = sanitize(tab.text.slice(s, e));
    out += m.kind === 'deletion' ? `[-${body}-]` : `{+${body}+}`;
    pos = e;
  }
  if (pos < end) out += sanitize(tab.text.slice(pos, end));
  return out;
}

/**
 * Renders [start, end) as rich Markdown-annotated text preserving formatting:
 *  - Bold: **text**
 *  - Italic: *text*
 *  - Underline: <u>text</u>
 *  - Strikethrough: ~~text~~
 *  - Links: [text](url)
 *  - Images: [Image: title (WxH)]
 */
export function renderAnnotatedText(tab: TabModel, start: number, end: number, markSuggestions = false): string {
  start = Math.max(0, start);
  end = Math.min(tab.endIndex, end);
  if (end <= start) return '';

  const runs = tab.styledRuns.filter((r) => r.endIndex > start && r.startIndex < end);
  if (runs.length === 0) return renderText(tab, start, end, markSuggestions);

  let out = '';
  let pos = start;

  for (const run of runs) {
    const s = Math.max(run.startIndex, start);
    const e = Math.min(run.endIndex, end);

    if (s > pos) {
      out += renderText(tab, pos, s, markSuggestions);
    }

    let textSlice = sanitize(tab.text.slice(s, e));
    if (textSlice.length > 0) {
      if (markSuggestions && tab.suggestionMarks.length > 0) {
        textSlice = renderText(tab, s, e, true);
      }

      // Preserve leading and trailing whitespace outside formatting markdown
      const match = textSlice.match(/^(\s*)(.*?)(\s*)$/s);
      const leading = match ? match[1] : '';
      let body = match ? match[2] : textSlice;
      const trailing = match ? match[3] : '';

      if (body) {
        const { bold, italic, underline, strikethrough, linkUrl } = run.style;
        if (strikethrough) body = `~~${body}~~`;
        if (underline) body = `<u>${body}</u>`;
        if (italic) body = `*${body}*`;
        if (bold) body = `**${body}**`;
        if (linkUrl) body = `[${body}](${linkUrl})`;
      }

      out += leading + body + trailing;
    }
    pos = e;
  }

  if (pos < end) {
    out += renderText(tab, pos, end, markSuggestions);
  }

  // Annotate inline images
  for (const img of tab.images) {
    if (img.startIndex >= start && img.endIndex <= end) {
      const label = img.title || img.description || 'Image';
      const dim = img.width && img.height ? ` (${Math.round(img.width)}x${Math.round(img.height)})` : '';
      out = out.split(OBJ).join(`[Image: ${label}${dim}]`);
    }
  }

  return out;
}

export function getRunsInRange(tab: TabModel, start: number, end: number): StyledRun[] {
  return tab.styledRuns
    .filter((r) => r.endIndex > start && r.startIndex < end)
    .map((r) => {
      const s = Math.max(r.startIndex, start);
      const e = Math.min(r.endIndex, end);
      return {
        startIndex: s,
        endIndex: e,
        text: sanitize(tab.text.slice(s, e)),
        style: r.style,
        suggestion: r.suggestion,
      };
    });
}

export interface SuggestionInRange {
  suggestionId: string;
  kind: string;
  startIndex: number;
  endIndex: number;
  text: string;
}

export function getSuggestionsInRange(tab: TabModel, start: number, end: number): SuggestionInRange[] {
  const list: SuggestionInRange[] = [];
  for (const [id, span] of tab.suggestionSpans) {
    for (const r of span.ranges) {
      if (r.endIndex > start && r.startIndex < end) {
        const s = Math.max(r.startIndex, start);
        const e = Math.min(r.endIndex, end);
        list.push({
          suggestionId: id,
          kind: [...span.kinds].join('/'),
          startIndex: s,
          endIndex: e,
          text: sanitize(tab.text.slice(s, e)),
        });
      }
    }
  }
  return list.sort((a, b) => a.startIndex - b.startIndex);
}

export function getTablesInRange(tab: TabModel, start: number, end: number): TableModel[] {
  return tab.tables.filter((t) => t.endIndex > start && t.startIndex < end);
}

export function getParagraphsInRange(tab: TabModel, start: number, end: number): ParagraphInfo[] {
  return tab.paragraphs.filter((p) => Math.max(p.startIndex, start) < Math.min(p.endIndex, end));
}

export function getTableContext(
  tab: TabModel,
  index: number,
): { tableIndex: number; tableStart: number; tableEnd: number; rowIndex: number; columnIndex: number; cellRange: IndexRange } | null {
  for (const table of tab.tables) {
    if (index >= table.startIndex && index < table.endIndex) {
      for (const cell of table.cells) {
        if (index >= cell.startIndex && index < cell.endIndex) {
          return {
            tableIndex: table.tableIndex,
            tableStart: table.startIndex,
            tableEnd: table.endIndex,
            rowIndex: cell.rowIndex,
            columnIndex: cell.columnIndex,
            cellRange: { startIndex: cell.startIndex, endIndex: cell.endIndex },
          };
        }
      }
      if (table.cells.length > 0 && index < table.cells[0].startIndex) {
        const first = table.cells[0];
        return {
          tableIndex: table.tableIndex,
          tableStart: table.startIndex,
          tableEnd: table.endIndex,
          rowIndex: first.rowIndex,
          columnIndex: first.columnIndex,
          cellRange: { startIndex: first.startIndex, endIndex: first.endIndex },
        };
      }
      return {
        tableIndex: table.tableIndex,
        tableStart: table.startIndex,
        tableEnd: table.endIndex,
        rowIndex: -1,
        columnIndex: -1,
        cellRange: { startIndex: table.startIndex, endIndex: table.endIndex },
      };
    }
  }
  return null;
}

export interface TableCellWithContext extends TableCellModel {
  tableIndex: number;
  tableStartIndex: number;
  tableEndIndex: number;
  safeAppendIndex: number;
  safePrependIndex: number;
}

export function getCellsInRange(tab: TabModel, start: number, end: number): TableCellWithContext[] {
  const out: TableCellWithContext[] = [];
  for (const table of tab.tables) {
    if (table.endIndex <= start || table.startIndex >= end) continue;
    for (const cell of table.cells) {
      if (cell.endIndex > start && cell.startIndex < end) {
        const safePrepend = cell.contentStartIndex ?? (cell.startIndex + 1);
        const safeAppend = Math.max(safePrepend, cell.endIndex - 1);
        out.push({
          ...cell,
          tableIndex: table.tableIndex,
          tableStartIndex: table.startIndex,
          tableEndIndex: table.endIndex,
          safeAppendIndex: safeAppend,
          safePrependIndex: safePrepend,
        });
      }
    }
  }
  return out;
}

export function getImagesInRange(tab: TabModel, start: number, end: number): ImageModel[] {
  return tab.images.filter((img) => img.endIndex > start && img.startIndex < end);
}

export interface HeadingContext {
  title: string;
  level: number;
  startIndex: number;
  isPseudo?: boolean;
}

export function getPrecedingHeading(tab: TabModel, startIndex: number): HeadingContext | null {
  let best: HeadingContext | null = null;
  for (const o of tab.outline) {
    if (o.startIndex <= startIndex) {
      if (!best || o.startIndex > best.startIndex) {
        best = { title: o.title, level: o.level, startIndex: o.startIndex, isPseudo: o.isPseudo };
      }
    }
  }
  return best;
}

export function getTableColumnHeaders(tab: TabModel, table: TableModel): string[] {
  const headers: string[] = [];
  for (let c = 0; c < table.columns; c++) {
    const cell = table.cells.find((cl) => cl.rowIndex === 0 && cl.columnIndex === c);
    if (cell) {
      const text = renderText(tab, cell.startIndex, cell.endIndex, false)
        .replace(/[\x00\x0B]/g, '')
        .trim();
      const firstLine = text.split('\n')[0]?.trim() || '';
      headers.push(firstLine && firstLine.length < 120 ? firstLine : (text.slice(0, 120).trim() || `Column ${c}`));
    } else {
      headers.push(`Column ${c}`);
    }
  }
  return headers;
}

function foldChar(c: string): string {
  const l = c.toLowerCase();
  return l.length === 1 ? l : c; // keep length identical to preserve indices
}

function foldString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]);
  return out;
}

export interface SearchResult {
  matches: IndexRange[];
  totalMatches: number;
  totalCapped: boolean;
}

export function searchText(
  tab: TabModel,
  query: string,
  opts: { caseSensitive?: boolean; maxResults?: number; countLimit?: number } = {},
): SearchResult {
  if (!query) return { matches: [], totalMatches: 0, totalCapped: false };
  const maxResults = opts.maxResults ?? 5;
  const countLimit = opts.countLimit ?? 1000;
  let hay = tab.text;
  let needle = query;
  if (!opts.caseSensitive) {
    if (tab.foldedText === undefined) tab.foldedText = foldString(tab.text);
    hay = tab.foldedText;
    needle = foldString(query);
  }
  const matches: IndexRange[] = [];
  let total = 0;
  let from = 0;
  while (total < countLimit) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    total++;
    if (matches.length < maxResults) matches.push({ startIndex: i, endIndex: i + needle.length });
    from = i + Math.max(1, needle.length);
  }
  return { matches, totalMatches: total, totalCapped: total >= countLimit };
}

export interface ResolvedAnchor {
  tab: TabModel;
  ranges: IndexRange[];
  /** Single bounding range when all ranges are contiguous, else null. */
  merged: IndexRange | null;
}

export function resolveCommentAnchor(model: DocModel, comment: CommentInfo): ResolvedAnchor | null {
  if (!comment.anchorId) return null;
  for (const tab of model.tabs) {
    const ranges = tab.commentAnchors.get(comment.anchorId);
    if (ranges && ranges.length) {
      const merged = ranges.length === 1 ? { ...ranges[0] } : null;
      return { tab, ranges, merged };
    }
  }
  return null;
}

export function findComment(model: DocModel, commentId: string): CommentInfo {
  if (!model.commentsAvailable) {
    throw new Error(
      `Comments are not available for this document: ${model.commentsUnavailableReason ?? 'unknown reason'}`,
    );
  }
  const c = model.comments.find((x) => x.commentId === commentId);
  if (!c) throw new Error(`Comment "${commentId}" not found. Use doc_list_comments with status "ALL" to see valid IDs.`);
  return c;
}

/** All suggestion IDs present in the document (inline spans + threads). */
export function collectSuggestionIds(model: DocModel): Set<string> {
  const ids = new Set<string>();
  for (const t of model.tabs) for (const id of t.suggestionSpans.keys()) ids.add(id);
  for (const s of model.suggestionThreads) if (s.status === 'OPEN' || s.status === 'STATUS_UNSPECIFIED') ids.add(s.suggestionId);
  return ids;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}
