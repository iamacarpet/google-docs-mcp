/**
 * MCP tool registrations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { docs_v1 } from '@googleapis/docs';
import {
  GAP,
  collectSuggestionIds,
  findComment,
  getImagesInRange,
  getParagraphsInRange,
  getRunsInRange,
  getTableContext,
  getTablesInRange,
  getSuggestionsInRange,
  getTab,
  paragraphIndexAt,
  renderAnnotatedText,
  renderText,
  resolveCommentAnchor,
  searchText,
  truncate,
  type CommentInfo,
  type DocModel,
  type IndexRange,
  type TabModel,
} from './docModel.js';
import {
  EditValidationError,
  buildBulletsRequest,
  buildDeleteTableColumnRequest,
  buildDeleteTableRowRequest,
  buildInsertImageRequest,
  buildInsertTableColumnRequest,
  buildInsertTableRowRequest,
  buildInsertTableRequest,
  buildReplaceRequests,
  buildUpdateParagraphStyleRequest,
  buildUpdateTextStyleRequest,
  hasStyle,
  planRangeEdit,
  sortEditsDescending,
  type DocsRequest,
  type PlannedEdit,
  type TextStyleInput,
} from './edits.js';
import { DocCache, apiErrorMessage, httpStatus, parseDocumentId, type DocsBackend } from './docsClient.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ToolContext {
  cache: DocCache;
  backend: DocsBackend & { resetCommentSupport?(documentId: string): void };
  requireRevision: boolean;
}

const DEFAULT_RESOLVE_REPLY = 'Suggested revision proposed for review.';
const MAX_READ_CHARS = 20000;

// ---------------------------------------------------------------------------
// Shared schemas & helpers
// ---------------------------------------------------------------------------

const documentIdSchema = z.string().min(1).describe('Google Doc ID or full docs.google.com document URL.');
const tabIdSchema = z
  .string()
  .optional()
  .describe('Document tab ID (see doc_get_metadata). Omit for the first tab.');
const indexSchema = z.number().int().nonnegative();
const expectedTextSchema = z
  .string()
  .optional()
  .describe(
    'Strongly recommended safety guard: the exact current text of [startIndex, endIndex) as returned by a read/search tool. The edit is rejected if the document text differs.',
  );
const revisionIdSchema = z
  .string()
  .optional()
  .describe('Optional revisionId you read the indices from. The edit is rejected if the document has changed since.');

const textStyleSchema = z
  .object({
    bold: z.boolean().optional().describe('Whether the text is rendered as bold.'),
    italic: z.boolean().optional().describe('Whether the text is italicized.'),
    underline: z.boolean().optional().describe('Whether the text is underlined.'),
    strikethrough: z.boolean().optional().describe('Whether the text is struck through.'),
    fontSize: z.number().positive().optional().describe('Font size in points (e.g. 11, 12, 14).'),
    foregroundColor: z.string().optional().describe('Hex color string (e.g. "#FF0000" or "#000000").'),
    backgroundColor: z.string().optional().describe('Hex background color string.'),
    linkUrl: z.string().url().optional().describe('Hyperlink URL.'),
  })
  .optional()
  .describe('Explicit text formatting options.');

const paragraphBorderSchema = z
  .object({
    padding: z.number().min(0).optional().describe('Border padding in points.'),
    width: z.number().min(0).optional().describe('Border width in points (0 removes border).'),
    dashStyle: z.enum(['SOLID', 'DOT', 'DASH']).optional().describe('Border dash style.'),
    color: z.string().optional().describe('Hex border color string (e.g. "#000000").'),
  })
  .optional()
  .describe('Paragraph border settings.');

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export class DocsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly revisionMismatch = false,
  ) {
    super(message);
  }
}

function toDocsApiError(e: unknown): DocsApiError {
  if (e instanceof DocsApiError) return e;
  const status = httpStatus(e);
  const msg = apiErrorMessage(e);
  if (status === 400 && /revision/i.test(msg)) {
    return new DocsApiError(
      `The document changed since it was read (revision mismatch: ${msg}). Re-read with doc_read_comment_context / doc_search_text and retry with fresh indices.`,
      status,
      true,
    );
  }
  let hint = '';
  if (status === 401) hint = ' Credentials are invalid or expired; re-run `npm run auth`.';
  else if (status === 403) hint = ' Check that the authorised account can edit/comment on this document, and that the account has permissions.';
  else if (status === 404) hint = ' Document not found or not shared with the authorised account.';
  return new DocsApiError(`Google Docs API error${status ? ` ${status}` : ''}: ${msg}.${hint}`, status);
}

type Handler<A> = (args: A) => Promise<CallToolResult>;

function safe<A>(fn: Handler<A>): Handler<A> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof EditValidationError || e instanceof DocsApiError) return fail(e.message);
      const status = httpStatus(e);
      if (status) return fail(toDocsApiError(e).message);
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

function preview(tab: TabModel, s: number, e: number, radius: number, tag: string, mark = false): string {
  const cs = Math.max(0, s - radius);
  const ce = Math.min(tab.endIndex, e + radius);
  const flat = (x: string) => x.replace(/\n/g, ' ⏎ ');
  return (
    (cs > 0 ? '…' : '') +
    flat(renderText(tab, cs, s, mark)) +
    `<${tag}>` +
    flat(renderText(tab, s, e, mark)) +
    `</${tag}>` +
    flat(renderText(tab, e, ce, mark)) +
    (ce < tab.endIndex ? '…' : '')
  );
}

function suggestionIdsFrom(res: docs_v1.Schema$BatchUpdateDocumentResponse, key: string): string[] {
  const out = new Set<string>();
  for (const r of (res as any).suggestionResponses ?? []) for (const id of r?.[key] ?? []) out.add(id);
  return [...out];
}

function anchorSummary(model: DocModel, c: CommentInfo) {
  const a = resolveCommentAnchor(model, c);
  if (!a) {
    return {
      anchored: false as const,
      anchorStatus: c.anchorId ? 'anchor_not_found' : 'unanchored',
      anchorText: c.quote,
    };
  }
  const start = a.ranges[0].startIndex;
  const end = a.ranges[a.ranges.length - 1].endIndex;
  return {
    anchored: true as const,
    tab: a.tab,
    startIndex: start,
    endIndex: end,
    ranges: a.ranges.length > 1 ? a.ranges : undefined,
    contiguous: !!a.merged,
    anchorText: a.ranges.map((r) => renderText(a.tab, r.startIndex, r.endIndex)).join(' … '),
  };
}

// ---------------------------------------------------------------------------
// Mutation Helpers
// ---------------------------------------------------------------------------

function checkRevision(m: DocModel, expected?: string): void {
  if (expected && m.revisionId && m.revisionId !== expected) {
    throw new DocsApiError(
      `Revision mismatch: you based this edit on revision ${expected}, but the current document revision is ${m.revisionId}. Re-read the document to obtain fresh indices.`,
      400,
      true,
    );
  }
}

function writeControlFor(ctx: ToolContext, model: DocModel, mode?: 'SUGGEST' | 'EDIT'): docs_v1.Schema$WriteControl {
  const wc: docs_v1.Schema$WriteControl = {};
  if (mode === 'SUGGEST') wc.writeMode = 'SUGGEST';
  else if (mode === 'EDIT') wc.writeMode = 'EDIT';
  if (ctx.requireRevision && model.revisionId) wc.requiredRevisionId = model.revisionId;
  return wc;
}

function commentReplyRequest(commentId: string, content?: string, action?: 'RESOLVE' | 'REOPEN'): DocsRequest {
  const post: Record<string, unknown> = {};
  if (content) post.content = content;
  if (action === 'RESOLVE') post.commentAction = 'RESOLVE';
  else if (action === 'REOPEN') post.commentAction = 'REOPEN';
  return { addCommentReply: { commentId, post } };
}

function commentEditRange(
  model: DocModel,
  commentId: string,
): { comment: CommentInfo; tab: TabModel; range: IndexRange } {
  const comment = findComment(model, commentId);
  const a = resolveCommentAnchor(model, comment);
  if (!a) {
    throw new EditValidationError(
      comment.anchorId
        ? `Comment "${commentId}" is anchored to text that no longer exists in the document.`
        : `Comment "${commentId}" is a document-level comment without anchored text. Use doc_suggest_edit_range instead.`,
    );
  }
  if (!a.merged) {
    throw new EditValidationError(
      `Comment "${commentId}" spans non-contiguous ranges (${a.ranges.map((r) => `[${r.startIndex}, ${r.endIndex})`).join(', ')}). Edit each range separately with doc_suggest_edit_range.`,
    );
  }
  return { comment, tab: a.tab, range: a.merged };
}

async function runBatch(
  ctx: ToolContext,
  documentId: string,
  requests: DocsRequest[],
  writeControl?: docs_v1.Schema$WriteControl,
): Promise<{ response: docs_v1.Schema$BatchUpdateDocumentResponse; newRevisionId?: string }> {
  try {
    const res = await ctx.backend.batchUpdate(documentId, requests, writeControl);
    const newRev = res.writeControl?.requiredRevisionId ?? (res as any).revisionId;
    ctx.cache.invalidate(documentId);
    return { response: res, newRevisionId: newRev };
  } catch (e) {
    throw toDocsApiError(e);
  }
}

async function runContentWithComments(
  ctx: ToolContext,
  documentId: string,
  contentReqs: DocsRequest[],
  commentReqs: DocsRequest[],
  writeControl: docs_v1.Schema$WriteControl,
): Promise<{
  response: docs_v1.Schema$BatchUpdateDocumentResponse;
  newRevisionId?: string;
  commentsApplied: boolean;
  atomic: boolean;
  warnings: string[];
}> {
  const warnings: string[] = [];
  try {
    const combined = [...contentReqs, ...commentReqs];
    const out = await runBatch(ctx, documentId, combined, writeControl);
    return { ...out, commentsApplied: commentReqs.length > 0, atomic: true, warnings };
  } catch (e) {
    if (commentReqs.length === 0) throw e;
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    const commentRelated = /comment|developer preview|forbidden|403|unsupported/i.test(msg);
    if (!commentRelated) throw e;

    warnings.push(
      `Comment update could not be applied in the same batch (${apiErrorMessage(e)}). Applying text edits separately.`,
    );
    const out = await runBatch(ctx, documentId, contentReqs, writeControl);
    return { ...out, commentsApplied: false, atomic: false, warnings };
  }
}

// ---------------------------------------------------------------------------
// Tool Registrations
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const load = (documentId: string, fresh = false) => ctx.cache.get(parseDocumentId(documentId), fresh);
  const RO = { readOnlyHint: true, openWorldHint: true } as const;

  // ---- Category A: Discovery & survey ------------------------------------

  server.registerTool(
    'doc_get_metadata',
    {
      title: 'Get document metadata',
      description:
        'Quick, text-free status check of a Google Doc: title, revisionId, tabs, character counts, table counts, image counts, comment counts, and pending suggestion counts. Use refresh=true to force a full re-fetch.',
      inputSchema: {
        documentId: documentIdSchema,
        refresh: z.boolean().optional().describe('Bypass the cache and re-fetch the document.'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, refresh }) => {
      const id = parseDocumentId(documentId);
      if (refresh) {
        ctx.cache.invalidate(id);
        ctx.backend.resetCommentSupport?.(id);
      }
      const m = await ctx.cache.get(id);
      const charCount = (t: TabModel) => t.text.length - (t.text.split(GAP).length - 1);

      return ok({
        documentId: m.documentId,
        title: m.title,
        revisionId: m.revisionId,
        characterCount: m.tabs.reduce((n, t) => n + charCount(t), 0),
        tableCount: m.tabs.reduce((n, t) => n + t.tables.length, 0),
        imageCount: m.tabs.reduce((n, t) => n + t.images.length, 0),
        tabs: m.tabs.map((t) => ({
          tabId: t.tabId || undefined,
          title: t.title || undefined,
          nestingLevel: t.nestingLevel || undefined,
          endIndex: t.endIndex,
          characterCount: charCount(t),
          headings: t.outline.length,
          tables: t.tables.length,
          images: t.images.length,
        })),
        comments: m.commentsAvailable
          ? {
              total: m.comments.length,
              open: m.comments.filter((c) => c.status === 'OPEN').length,
              resolved: m.comments.filter((c) => c.status === 'RESOLVED').length,
            }
          : { available: false, reason: m.commentsUnavailableReason },
        suggestionCount: collectSuggestionIds(m).size,
      });
    }),
  );

  server.registerTool(
    'doc_get_outline',
    {
      title: 'Get document outline',
      description:
        'Retrieves the structural outline of the document: formal headings (TITLE=level 0, HEADING_n=level n) plus visually bolded / enlarged single-line section dividers (isPseudo=true), with exact indices, without downloading document text. sectionEndIndex marks where the section ends, so doc_read_range(startIndex, sectionEndIndex) reads one section.',
      inputSchema: {
        documentId: documentIdSchema,
        tabId: tabIdSchema,
        includePseudo: z.boolean().optional().describe('Include pseudo-headings (default true).'),
        maxLevel: z.number().int().min(0).max(6).optional().describe('Only return entries with level <= maxLevel.'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, tabId, includePseudo, maxLevel }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      const outline = tab.outline.filter(
        (o) => (includePseudo !== false || !o.isPseudo) && (maxLevel === undefined || o.level <= maxLevel),
      );
      return ok({ revisionId: m.revisionId, tabId: tab.tabId || undefined, outline });
    }),
  );

  server.registerTool(
    'doc_list_comments',
    {
      title: 'List comments',
      description:
        'Surveys all comments in the document. Returns compact summaries (author, status, anchor text, content snippet, and exact [startIndex, endIndex) coordinates). Prefer status="OPEN" to find unresolved feedback.',
      inputSchema: {
        documentId: documentIdSchema,
        status: z.enum(['OPEN', 'RESOLVED', 'ALL']).optional().describe('Default "OPEN".'),
        tabId: tabIdSchema.describe('Only return comments anchored in this tab (omit for all tabs).'),
        maxResults: z.number().int().min(1).max(500).optional().describe('Default 100.'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, status, tabId, maxResults }) => {
      const m = await load(documentId);
      if (!m.commentsAvailable) {
        return ok({
          available: false,
          reason: m.commentsUnavailableReason,
          comments: [],
          hint: 'Comments require an authenticated Google account with access to the document.',
        });
      }
      const st = status ?? 'OPEN';
      const max = maxResults ?? 100;
      const rows: any[] = [];
      for (const c of m.comments) {
        if (st !== 'ALL' && c.status !== st) continue;
        const a = anchorSummary(m, c);
        if (tabId && a.anchored && a.tab.tabId !== tabId) continue;
        rows.push({
          commentId: c.commentId,
          status: c.status,
          author: c.head.author,
          createTime: c.head.createTime,
          content: truncate(c.head.content, 400),
          replyCount: c.replies.length,
          lastReply: c.replies.length ? truncate(c.replies[c.replies.length - 1].content, 200) : undefined,
          anchored: a.anchored,
          anchorStatus: a.anchorStatus,
          tabId: a.anchored && m.tabs.length > 1 ? a.tab.tabId : undefined,
          startIndex: a.startIndex,
          endIndex: a.endIndex,
          anchorText: a.anchorText ? truncate(a.anchorText, 200) : undefined,
        });
        if (rows.length >= max) break;
      }
      return ok({ revisionId: m.revisionId, totalMatched: rows.length, comments: rows });
    }),
  );

  server.registerTool(
    'doc_search_text',
    {
      title: 'Search document text',
      description:
        'Finds exact-string matches across the document text buffer without downloading full text. Returns the exact startIndex and endIndex for every occurrence, plus a surrounding 80-character snippet with <match>…</match> tags. ALWAYS use this to obtain fresh indices before editing.',
      inputSchema: {
        documentId: documentIdSchema,
        query: z.string().min(1).describe('The search needle (plain text).'),
        tabId: tabIdSchema,
        caseSensitive: z.boolean().optional().describe('Default false.'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Default 5.'),
        previewRadius: z.number().int().min(10).max(300).optional().describe('Surrounding chars on each side (default 40).'),
        markSuggestions: z.boolean().optional().describe('Show pending suggestions in snippets as [-deleted-]/{+inserted+} (default true).'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, query, tabId, caseSensitive, maxResults, previewRadius, markSuggestions }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      const max = maxResults ?? 5;
      const radius = previewRadius ?? 40;
      const mark = markSuggestions !== false;
      const res = searchText(tab, query, { caseSensitive, maxResults: max });
      return ok({
        revisionId: m.revisionId,
        tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
        query,
        totalMatches: res.totalMatches,
        matches: res.matches.map((r) => {
          const prev = preview(tab, r.startIndex, r.endIndex, radius, 'match', mark);
          return {
            startIndex: r.startIndex,
            endIndex: r.endIndex,
            snippet: prev,
            preview: prev,
          };
        }),
      });
    }),
  );

  server.registerTool(
    'doc_list_suggestions',
    {
      title: 'List suggestions',
      description:
        'Lists pending suggested changes (tracked changes) with suggestionId, kind (insertion/deletion/textStyle/paragraphStyle), location and a short preview. Use the IDs with doc_manage_suggestion.',
      inputSchema: {
        documentId: documentIdSchema,
        tabId: tabIdSchema,
        maxPreviewChars: z.number().int().min(10).max(2000).optional().describe('Default 120.'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, tabId, maxPreviewChars }) => {
      const m = await load(documentId);
      const max = maxPreviewChars ?? 120;
      const tabs = tabId ? [getTab(m, tabId)] : m.tabs;
      const threads = new Map(m.suggestionThreads.map((s) => [s.suggestionId, s]));
      const rows: any[] = [];
      const seen = new Set<string>();
      for (const tab of tabs) {
        for (const [id, span] of tab.suggestionSpans) {
          seen.add(id);
          const th = threads.get(id);
          rows.push({
            suggestionId: id,
            kinds: [...span.kinds],
            tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
            startIndex: span.ranges[0].startIndex,
            endIndex: span.ranges[span.ranges.length - 1].endIndex,
            text: truncate(span.ranges.map((r) => renderText(tab, r.startIndex, r.endIndex)).join(' … '), max),
            author: th?.author,
            status: th?.status,
            summary: th?.summary ? truncate(th.summary, max) : undefined,
          });
        }
      }
      if (!tabId) {
        for (const th of m.suggestionThreads) {
          if (seen.has(th.suggestionId) || th.status === 'ACCEPTED' || th.status === 'REJECTED') continue;
          rows.push({ suggestionId: th.suggestionId, author: th.author, status: th.status, summary: th.summary && truncate(th.summary, max) });
        }
      }
      rows.sort((a, b) => (a.startIndex ?? Number.MAX_SAFE_INTEGER) - (b.startIndex ?? Number.MAX_SAFE_INTEGER));
      return ok({ revisionId: m.revisionId, total: rows.length, suggestions: rows });
    }),
  );

  // ---- Category B: Targeted context reading -------------------------------

  server.registerTool(
    'doc_read_comment_context',
    {
      title: 'Read comment context',
      description:
        'Fetches the exact text anchor and surrounding paragraph(s) for a given commentId, plus the full thread. The anchor is wrapped in <target>…</target> inside the snippet. Returns global start/end coordinates so no index math is needed.',
      inputSchema: {
        documentId: documentIdSchema,
        commentId: z.string().min(1),
        surroundingParagraphs: z.number().int().min(0).max(5).optional().describe('Non-empty paragraphs before/after the anchor (default 1).'),
        maxContextChars: z.number().int().min(50).max(5000).optional().describe('Max context characters on each side of the anchor (default 1200).'),
        markSuggestions: z.boolean().optional().describe('Show pending suggestions as [-deleted-]/{+inserted+} (default true).'),
        includeRuns: z.boolean().optional().describe('Include detailed styled runs array for the anchor text (default false to save tokens).'),
        includeParagraphStyle: z.boolean().optional().describe('Include paragraph style/spacing metadata for the anchor (default false).'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, commentId, surroundingParagraphs, maxContextChars, markSuggestions, includeRuns, includeParagraphStyle }) => {
      const m = await load(documentId);
      const c = findComment(m, commentId);
      const a = resolveCommentAnchor(m, c);
      const thread = {
        commentId: c.commentId,
        status: c.status,
        author: c.head.author,
        feedback: c.head.content,
        replies: c.replies.length
          ? c.replies.map((r) => ({ author: r.author, content: r.content, action: r.commentAction }))
          : undefined,
      };
      if (!a) {
        return ok({
          ...thread,
          revisionId: m.revisionId,
          anchor: null,
          quotedText: c.quote,
          note: c.anchorId
            ? 'The anchored text is no longer present in the document.'
            : 'Document-level comment (not anchored to text).',
        });
      }
      const tab = a.tab;
      const s = a.ranges[0].startIndex;
      const e = a.ranges[a.ranges.length - 1].endIndex;
      const n = surroundingParagraphs ?? 1;
      const maxChars = maxContextChars ?? 1200;
      const mark = markSuggestions !== false;
      const ps = tab.paragraphs;
      let i = Math.max(0, paragraphIndexAt(tab, s));
      let j = Math.max(0, paragraphIndexAt(tab, Math.max(s, e - 1)));
      const nonEmpty = (k: number) => ps[k].endIndex - ps[k].startIndex > 1;
      for (let cnt = 0; cnt < n && i > 0; ) if (nonEmpty(--i)) cnt++;
      for (let cnt = 0; cnt < n && j < ps.length - 1; ) if (nonEmpty(++j)) cnt++;
      let cs = ps.length ? Math.min(ps[i].startIndex, s) : s;
      let ce = ps.length ? Math.max(ps[j].endIndex, e) : e;
      const clippedStart = cs < s - maxChars;
      const clippedEnd = ce > e + maxChars;
      if (clippedStart) cs = s - maxChars;
      if (clippedEnd) ce = e + maxChars;
      let target = renderText(tab, s, e, mark);
      if (target.length > 4000) target = target.slice(0, 2000) + ' …[anchor truncated]… ' + target.slice(-1500);
      const snippet =
        (clippedStart ? '…' : '') +
        renderText(tab, cs, s, mark) +
        `<target>${target}</target>` +
        renderText(tab, e, ce, mark) +
        (clippedEnd ? '…' : '');

      const anchorRuns = includeRuns ? getRunsInRange(tab, s, e) : undefined;
      const tblCtx = getTableContext(tab, s);
      const paraStyle = includeParagraphStyle && ps[i] ? ps[i].style : undefined;

      return ok({
        ...thread,
        revisionId: m.revisionId,
        anchor: {
          startIndex: s,
          endIndex: e,
          text: renderText(tab, s, e),
          tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
          ranges: a.ranges.length > 1 ? a.ranges : undefined,
          runs: anchorRuns && anchorRuns.length ? anchorRuns : undefined,
          paragraphStyle: paraStyle || undefined,
        },
        context: { contextStartIndex: cs, contextEndIndex: ce, snippet },
        tableContext: tblCtx || undefined,
      });
    }),
  );

  server.registerTool(
    'doc_read_range',
    {
      title: 'Read text range',
      description:
        'Reads text strictly between global startIndex (inclusive) and endIndex (exclusive). By default (includeFormatting=true), returns both raw plain text and rich Markdown annotatedText (bold, italic, underline, strikethrough, images), plus structured styled runs, and table context if inside a table. Large ranges are truncated at 20,000 chars.\n\n' +
        'CRITICAL ON STRIKETHROUGH VS SUGGESTIONS:\n' +
        '- In annotatedText, ~~strikethrough~~ (and **~~bold strikethrough~~**) represents INTENTIONAL document-level text formatting (such as retained wording under formal style guides, or form options). It is NOT a Google Docs suggestion!\n' +
        '- Google Docs pending suggestions are tracked changes, shown as [-deleted text-] and {+inserted text+} when markSuggestions is enabled (default true).\n' +
        '- When pending suggestions exist within the range, they are reported with their exact suggestionId, kind, and bounds in pendingSuggestions.',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        tabId: tabIdSchema,
        includeFormatting: z.boolean().optional().describe('Master toggle for rich formatting. If false, returns raw plain text only (default true).'),
        includeAnnotatedText: z.boolean().optional().describe('Include Markdown annotatedText with **bold**, *italic*, <u>underline</u>, ~~strike~~, and links. Very low token cost (default true when formatting is enabled).'),
        includeRuns: z.boolean().optional().describe('Include verbose styled runs array with exact coordinates, style objects, and suggestion metadata (default false to save tokens).'),
        includeParagraphs: z.boolean().optional().describe('Include verbose paragraph layout/styling objects (spacing, margins, borders, padding). Set true only when inspecting or adjusting paragraph layout (default false to save tokens).'),
        includeTables: z.boolean().optional().describe('Include table structure and coordinates if range intersects tables (default true).'),
        includeImages: z.boolean().optional().describe('Include inline image metadata if present (default true).'),
        markSuggestions: z.boolean().optional().describe('Show pending suggestions as [-deleted-]/{+inserted+} (default true). When false, returns raw buffer without diff markers.'),
      },
      annotations: RO,
    },
    safe(async ({
      documentId,
      startIndex,
      endIndex,
      tabId,
      includeFormatting,
      includeAnnotatedText,
      includeRuns,
      includeParagraphs,
      includeTables,
      includeImages,
      markSuggestions,
    }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      if (endIndex < startIndex) return fail('endIndex must be >= startIndex.');
      if (startIndex >= tab.endIndex) return fail(`startIndex ${startIndex} is beyond the end of the tab (${tab.endIndex}).`);
      const end = Math.min(endIndex, tab.endIndex, startIndex + MAX_READ_CHARS);
      const truncated = end < Math.min(endIndex, tab.endIndex);
      const mark = markSuggestions !== false;
      const plainText = renderText(tab, startIndex, end, mark);
      const pendingSuggestions = getSuggestionsInRange(tab, startIndex, end);

      const formatting = includeFormatting !== false;
      const res: Record<string, any> = {
        revisionId: m.revisionId,
        tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
        startIndex,
        endIndex: end,
        text: plainText,
        hasPendingSuggestions: pendingSuggestions.length > 0,
      };
      if (pendingSuggestions.length > 0) {
        res.pendingSuggestions = pendingSuggestions;
      }

      if (formatting) {
        if (includeAnnotatedText !== false) {
          res.annotatedText = renderAnnotatedText(tab, startIndex, end, mark);
        }
        if (includeRuns === true) {
          const runs = getRunsInRange(tab, startIndex, end);
          if (runs.length) res.runs = runs;
        }
        const tblContext = getTableContext(tab, startIndex);
        if (tblContext) res.tableContext = tblContext;
        if (includeTables !== false) {
          const tablesInRange = getTablesInRange(tab, startIndex, end);
          if (tablesInRange.length) {
            res.tables = tablesInRange.map((t) => ({
              tableIndex: t.tableIndex,
              rows: t.rows,
              columns: t.columns,
              startIndex: t.startIndex,
              endIndex: t.endIndex,
            }));
          }
        }
        if (includeImages !== false) {
          const imagesInRange = getImagesInRange(tab, startIndex, end);
          if (imagesInRange.length) res.images = imagesInRange;
        }
        if (includeParagraphs === true) {
          const paragraphsInRange = getParagraphsInRange(tab, startIndex, end);
          if (paragraphsInRange.length) {
            res.paragraphs = paragraphsInRange.map((p) => ({
              startIndex: p.startIndex,
              endIndex: p.endIndex,
              namedStyleType: p.namedStyleType,
              alignment: p.alignment,
              hasBullet: p.hasBullet,
              inTable: p.inTable,
              style: p.style,
              tableContext: p.tableContext,
            }));
          }
        }
      }

      if (truncated) res.truncated = true;
      if (truncated) res.nextStartIndex = end;
      return ok(res);
    }),
  );

  // ---- Category C: Safe mutation, formatting & structure ------------------

  server.registerTool(
    'doc_suggest_comment_revision',
    {
      title: 'Suggest revision for a comment',
      description:
        "PREFERRED tool for addressing comments. Atomically proposes a suggested revision in Google Docs suggestion mode for exactly the text anchored by commentId, and (by default) marks the comment thread resolved — all in a single batchUpdate. Optionally specify textStyle.",
      inputSchema: {
        documentId: documentIdSchema,
        commentId: z.string().min(1),
        suggestedText: z.string().describe('Replacement for the anchored text (may be empty to suggest deletion).'),
        resolveComment: z.boolean().optional().describe('Resolve the thread in the same batch (default true).'),
        replyMessage: z
          .string()
          .max(2048)
          .optional()
          .describe(`Reply posted to the thread. Default when resolving: "${DEFAULT_RESOLVE_REPLY}"`),
        textStyle: textStyleSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, commentId, suggestedText, resolveComment, replyMessage, textStyle }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      const { comment, tab, range } = commentEditRange(m, commentId);
      const planned = planRangeEdit(tab, { ...range, text: suggestedText, textStyle });
      const resolve = resolveComment !== false;
      const commentReqs: DocsRequest[] = [];
      if (resolve) commentReqs.push(commentReplyRequest(commentId, replyMessage ?? DEFAULT_RESOLVE_REPLY, 'RESOLVE'));
      else if (replyMessage) commentReqs.push(commentReplyRequest(commentId, replyMessage));
      const out = await runContentWithComments(
        ctx,
        id,
        buildReplaceRequests(tab, planned),
        commentReqs,
        writeControlFor(ctx, m, 'SUGGEST'),
      );
      const warnings = [...planned.notes, ...out.warnings];
      if (comment.status === 'RESOLVED') warnings.push('Comment was already resolved before this edit.');
      return ok({
        status: 'ok',
        mode: 'SUGGEST',
        commentId,
        replaced: { startIndex: planned.startIndex, endIndex: planned.endIndex, originalText: truncate(planned.originalText, 500) },
        suggestedText: planned.text,
        appliedStyle: planned.textStyle,
        createdSuggestionIds: suggestionIdsFrom(out.response, 'createdSuggestionIds'),
        commentResolved: resolve && out.commentsApplied,
        replyPosted: commentReqs.length > 0 && out.commentsApplied,
        atomic: out.atomic,
        newRevisionId: out.newRevisionId,
        warnings: warnings.length ? warnings : undefined,
      });
    }),
  );

  const rangeEditHandler = (mode: 'SUGGEST' | 'EDIT') =>
    safe(
      async (args: {
        documentId: string;
        startIndex: number;
        endIndex: number;
        text: string;
        expectedText?: string;
        revisionId?: string;
        tabId?: string;
        textStyle?: TextStyleInput;
      }) => {
        const id = parseDocumentId(args.documentId);
        const m = await ctx.cache.get(id, true);
        checkRevision(m, args.revisionId);
        const tab = getTab(m, args.tabId);
        const planned = planRangeEdit(
          tab,
          {
            startIndex: args.startIndex,
            endIndex: args.endIndex,
            text: args.text,
            textStyle: args.textStyle,
          },
          args.expectedText,
        );
        const out = await runBatch(ctx, id, buildReplaceRequests(tab, planned), writeControlFor(ctx, m, mode));
        return ok({
          status: 'ok',
          mode,
          replaced: { startIndex: planned.startIndex, endIndex: planned.endIndex, originalText: truncate(planned.originalText, 500) },
          newText: planned.text,
          appliedStyle: planned.textStyle,
          createdSuggestionIds: mode === 'SUGGEST' ? suggestionIdsFrom(out.response, 'createdSuggestionIds') : undefined,
          newRevisionId: out.newRevisionId,
          warnings: planned.notes.length ? planned.notes : undefined,
        });
      },
    );

  const suggestRange = rangeEditHandler('SUGGEST');

  server.registerTool(
    'doc_suggest_deletion',
    {
      title: 'Suggest deletion of text range',
      description:
        'Submits a suggested revision (tracked change) to DELETE the text in [startIndex, endIndex). ' +
        'In Google Docs, this creates a native tracked deletion suggestion (which Docs displays visually with strikethrough in its web UI). ' +
        'When accepted, the text is removed from the document.\n\n' +
        'CRITICAL DISTINCTION:\n' +
        '- Use doc_suggest_deletion when you want to DELETE/REMOVE text as a tracked change.\n' +
        '- If your style guide requires RETAINING original wording formatted as bold strikethrough (and not removing it), do NOT use this tool; use doc_format_text with bold: true and strikethrough: true instead.',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        expectedText: expectedTextSchema,
        revisionId: revisionIdSchema,
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => suggestRange({ ...args, text: '' }),
  );

  server.registerTool(
    'doc_suggest_edit_range',
    {
      title: 'Suggest edit for a range',
      description:
        'Submits a suggested revision (tracked change) replacing [startIndex, endIndex) with suggestedText. ' +
        'Optionally format the NEW suggested text using textStyle (bold, italic, underline, etc.).\n\n' +
        'USAGE PATTERNS:\n' +
        '- To suggest REPLACING text: provide [startIndex, endIndex) and suggestedText.\n' +
        '- To suggest INSERTING new text: pass startIndex === endIndex (pure insertion), along with suggestedText and optional textStyle (e.g. bold: true).\n' +
        '- To suggest DELETING text: pass suggestedText: "" (or use the dedicated doc_suggest_deletion tool).\n' +
        '- NOTE ON textStyle: textStyle formats ONLY the newly inserted text. It does NOT format the deleted text. Do NOT pass textStyle: { strikethrough: true } to simulate deletion; Google Docs tracks deletions natively.\n' +
        '- NOTE ON STYLE-GUIDE AMENDMENTS: If your style guide requires RETAINING original wording as bold strikethrough rather than deleting it, use doc_format_text(bold: true, strikethrough: true) on the original text, and use doc_suggest_edit_range with startIndex === endIndex to insert the new wording as bold.',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        suggestedText: z
          .string()
          .describe('The new replacement text. Pass empty string "" to suggest deleting the range. For pure insertion, set startIndex equal to endIndex.'),
        expectedText: expectedTextSchema,
        textStyle: textStyleSchema.describe('Styling applied to the NEW replacement text (e.g. bold: true). Does not affect deleted text.'),
        revisionId: revisionIdSchema,
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ suggestedText, ...rest }) => suggestRange({ ...rest, text: suggestedText }),
  );

  const directEdit = rangeEditHandler('EDIT');
  server.registerTool(
    'doc_apply_direct_edit',
    {
      title: 'Apply DIRECT edit (no suggestion)',
      description:
        'DIRECTLY overwrites [startIndex, endIndex) with newText, bypassing suggestion mode (no tracked change). Optionally format the new text using textStyle. Use ONLY when the user explicitly asks to "overwrite directly".',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        newText: z.string(),
        expectedText: expectedTextSchema,
        textStyle: textStyleSchema,
        revisionId: revisionIdSchema,
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ newText, ...rest }) => directEdit({ ...rest, text: newText }),
  );

  server.registerTool(
    'doc_batch_suggest_edits',
    {
      title: 'Batch suggest edits',
      description:
        'Submits several suggested revisions in ONE batchUpdate (suggestion mode). Each item targets either a commentId or an explicit [startIndex, endIndex) range, with optional textStyle. The server sorts edits bottom-to-top so indices never drift.\n\n' +
        'USAGE PATTERNS:\n' +
        '- Pure insertion: set startIndex === endIndex with suggestedText and optional textStyle (e.g. bold: true).\n' +
        '- Deletion: set suggestedText: "" to suggest deleting the target range.\n' +
        '- Replacement: provide target range and suggestedText.\n' +
        '- NOTE ON STYLE-GUIDE AMENDMENTS: If your style guide requires retaining original wording as bold strikethrough, use doc_format_text on original text and insert new text as bold with startIndex === endIndex.',
      inputSchema: {
        documentId: documentIdSchema,
        edits: z
          .array(
            z.object({
              commentId: z.string().optional().describe('Target the anchored text of this comment.'),
              startIndex: indexSchema.optional(),
              endIndex: indexSchema.optional(),
              expectedText: expectedTextSchema,
              suggestedText: z
                .string()
                .describe('Replacement text. Pass empty string "" to suggest deleting the target text. For pure insertion, set startIndex equal to endIndex.'),
              textStyle: textStyleSchema.describe('Styling applied to the NEW replacement text (e.g. bold: true). Does not affect deleted text.'),
            }),
          )
          .min(1)
          .max(50),
        resolveComments: z.boolean().optional().describe('Resolve comment-targeted threads (default true).'),
        replyMessage: z.string().max(2048).optional().describe(`Reply for resolved threads (default "${DEFAULT_RESOLVE_REPLY}").`),
        tabId: tabIdSchema.describe('Tab for range-based items (comment items use their anchor tab). All edits must be in one tab.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, edits, resolveComments, replyMessage, tabId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      let tab: TabModel | undefined;
      const planned: (PlannedEdit & { item: number; commentId?: string })[] = [];
      edits.forEach((e, item) => {
        let t: TabModel;
        let range: IndexRange;
        if (e.commentId) {
          const r = commentEditRange(m, e.commentId);
          t = r.tab;
          range = r.range;
        } else {
          if (e.startIndex === undefined || e.endIndex === undefined) {
            throw new EditValidationError(`edits[${item}]: provide either commentId or both startIndex and endIndex.`);
          }
          t = getTab(m, tabId);
          range = { startIndex: e.startIndex, endIndex: e.endIndex };
        }
        if (tab && t !== tab) throw new EditValidationError('All edits in one batch must target the same document tab.');
        tab = t;
        try {
          planned.push({
            ...planRangeEdit(
              t,
              {
                ...range,
                text: e.suggestedText,
                textStyle: e.textStyle,
              },
              e.expectedText,
            ),
            item,
            commentId: e.commentId,
          });
        } catch (err) {
          if (err instanceof EditValidationError) throw new EditValidationError(`edits[${item}]: ${err.message}`);
          throw err;
        }
      });
      const ordered = sortEditsDescending(planned);
      const contentReqs = ordered.flatMap((p) => buildReplaceRequests(tab!, p));
      const resolve = resolveComments !== false;
      const commentIds = [...new Set(ordered.filter((p) => p.commentId).map((p) => p.commentId!))];
      const commentReqs = resolve
        ? commentIds.map((cid) => commentReplyRequest(cid, replyMessage ?? DEFAULT_RESOLVE_REPLY, 'RESOLVE'))
        : replyMessage
          ? commentIds.map((cid) => commentReplyRequest(cid, replyMessage))
          : [];
      const out = await runContentWithComments(ctx, id, contentReqs, commentReqs, writeControlFor(ctx, m, 'SUGGEST'));
      const notes = planned.flatMap((p) => p.notes.map((n) => `edits[${p.item}]: ${n}`));
      return ok({
        status: 'ok',
        mode: 'SUGGEST',
        appliedOrder: ordered.map((p) => ({ item: p.item, commentId: p.commentId, startIndex: p.startIndex, endIndex: p.endIndex })),
        createdSuggestionIds: suggestionIdsFrom(out.response, 'createdSuggestionIds'),
        resolvedComments: resolve && out.commentsApplied ? commentIds : [],
        atomic: out.atomic,
        newRevisionId: out.newRevisionId,
        warnings: [...notes, ...out.warnings].length ? [...notes, ...out.warnings] : undefined,
      });
    }),
  );

  // ---- Category D: Rich text formatting & Elements ------------------------

  server.registerTool(
    'doc_format_text',
    {
      title: 'Format text style',
      description:
        'Applies inline text formatting (bold, italic, underline, strikethrough, fontSize, colors, link) to a range [startIndex, endIndex). Can run in SUGGEST mode (tracked formatting suggestion) or EDIT mode (direct formatting).\n\n' +
        'CRITICAL GUIDANCE ON STRIKETHROUGH VS DELETIONS:\n' +
        '- Applying strikethrough formats the text with a strikethrough font; it RETAINS the text in the document.\n' +
        '- Use this tool for STYLE-GUIDE FORMAL AMENDMENTS where the requirement is to retain original wording in the document as bold strikethrough (bold: true, strikethrough: true).\n' +
        '- Do NOT use this tool if you want to DELETE or REMOVE text as a native tracked change! For native tracked deletion, use doc_suggest_deletion or doc_suggest_edit_range with suggestedText: "".',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        tabId: tabIdSchema,
        bold: z.boolean().optional().describe('Bold styling.'),
        italic: z.boolean().optional().describe('Italic styling.'),
        underline: z.boolean().optional().describe('Underline styling.'),
        strikethrough: z
          .boolean()
          .optional()
          .describe(
            'Strikethrough styling. Formats text with strikethrough font while keeping text in the document. Do NOT use to suggest deleting text (use doc_suggest_deletion instead).',
          ),
        fontSize: z.number().positive().optional().describe('Font size in points.'),
        foregroundColor: z.string().optional().describe('Hex color string (e.g. "#FF0000").'),
        backgroundColor: z.string().optional().describe('Hex background color string.'),
        linkUrl: z.string().url().optional().describe('Hyperlink URL.'),
        textStyle: textStyleSchema
          .optional()
          .describe('Optional textStyle object (can be used instead of or in addition to individual style fields).'),
        writeMode: z
          .enum(['SUGGEST', 'EDIT'])
          .optional()
          .describe('SUGGEST (default) proposes a tracked suggestion; EDIT applies directly.'),
        expectedText: expectedTextSchema,
        revisionId: revisionIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(
      async ({
        documentId,
        startIndex,
        endIndex,
        tabId,
        bold,
        italic,
        underline,
        strikethrough,
        fontSize,
        foregroundColor,
        backgroundColor,
        linkUrl,
        textStyle,
        writeMode,
        expectedText,
        revisionId,
      }) => {
        const id = parseDocumentId(documentId);
        const m = await ctx.cache.get(id, true);
        checkRevision(m, revisionId);
        const tab = getTab(m, tabId);
        if (startIndex < 1 || endIndex <= startIndex || endIndex > tab.endIndex) {
          return fail(`Invalid range [${startIndex}, ${endIndex}) for tab ending at ${tab.endIndex}.`);
        }
        if (expectedText !== undefined) {
          const actual = tab.text.slice(startIndex, endIndex);
          if (actual !== expectedText) {
            return fail(
              `Text at [${startIndex}, ${endIndex}) does not match expectedText. Current text: ${JSON.stringify(
                truncate(actual, 300),
              )}.`,
            );
          }
        }
        const explicitStyle: TextStyleInput = { ...textStyle };
        if (bold !== undefined) explicitStyle.bold = bold;
        if (italic !== undefined) explicitStyle.italic = italic;
        if (underline !== undefined) explicitStyle.underline = underline;
        if (strikethrough !== undefined) explicitStyle.strikethrough = strikethrough;
        if (fontSize !== undefined) explicitStyle.fontSize = fontSize;
        if (foregroundColor !== undefined) explicitStyle.foregroundColor = foregroundColor;
        if (backgroundColor !== undefined) explicitStyle.backgroundColor = backgroundColor;
        if (linkUrl !== undefined) explicitStyle.linkUrl = linkUrl;

        if (!hasStyle(explicitStyle)) {
          return fail('No formatting styles specified. Provide at least one style property (bold, italic, etc.).');
        }

        const mode = writeMode ?? 'SUGGEST';
        const notes: string[] = [];
        if (explicitStyle.strikethrough) {
          if (mode === 'SUGGEST' && !explicitStyle.bold) {
            notes.push(
              'Applied strikethrough styling as a suggestion. NOTE: This formats the text with a strikethrough font and retains it in the document. If your goal was to propose DELETING/REMOVING this text from the document, use doc_suggest_deletion or doc_suggest_edit_range with suggestedText: "" instead.',
            );
          } else if (mode === 'SUGGEST' && explicitStyle.bold) {
            notes.push(
              'Applied bold strikethrough styling as a suggestion (standard for style-guide formal amendments that retain original wording).',
            );
          }
        }

        const req = buildUpdateTextStyleRequest(
          { startIndex, endIndex, ...(tab.tabId ? { tabId: tab.tabId } : {}) },
          explicitStyle,
        );
        const out = await runBatch(ctx, id, [req], writeControlFor(ctx, m, mode));
        return ok({
          status: 'ok',
          mode,
          startIndex,
          endIndex,
          styledText: truncate(renderText(tab, startIndex, endIndex), 300),
          appliedStyle: explicitStyle,
          createdSuggestionIds: mode === 'SUGGEST' ? suggestionIdsFrom(out.response, 'createdSuggestionIds') : undefined,
          newRevisionId: out.newRevisionId,
          notes: notes.length ? notes : undefined,
        });
      },
    ),
  );

  server.registerTool(
    'doc_format_paragraph',
    {
      title: 'Format paragraph / bullets',
      description:
        'Updates paragraph styles (headings, alignment, line spacing) or bullet/numbered lists for paragraphs overlapping [startIndex, endIndex).',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        tabId: tabIdSchema,
        namedStyleType: z
          .enum(['NORMAL_TEXT', 'TITLE', 'SUBTITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'])
          .optional()
          .describe('Heading / named style type.'),
        alignment: z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']).optional().describe('Text alignment.'),
        bulletPreset: z
          .enum([
            'BULLET_DISC_CIRCLE_SQUARE',
            'BULLET_DIAMONDX_ARROW3D_SQUARE',
            'BULLET_CHECKBOX',
            'BULLET_ARROW_CIRCLE_DISC',
            'NUMBERED_DECIMAL_ALPHA_ROMAN',
            'NUMBERED_DECIMAL_NESTED',
          ])
          .optional()
          .describe('Bullet or numbering list style to apply.'),
        removeBullets: z.boolean().optional().describe('Set true to remove bullets/numbering from the range.'),
        spaceAbove: z.number().min(0).optional().describe('Space above paragraph in points (e.g. 0, 6, 12, 18).'),
        spaceBelow: z.number().min(0).optional().describe('Space below paragraph in points (e.g. 0, 6, 12).'),
        lineSpacing: z.number().positive().optional().describe('Line spacing percentage (e.g. 100 for single, 115 for 1.15x, 150 for 1.5x, 200 for double).'),
        spacingMode: z
          .enum(['SPACING_MODE_UNSPECIFIED', 'NEVER_COLLAPSE', 'COLLAPSE_LISTS'])
          .optional()
          .describe('Spacing mode (e.g. NEVER_COLLAPSE or COLLAPSE_LISTS).'),
        indentStart: z.number().min(0).optional().describe('Left indentation in points (e.g. 36 for 0.5 inch, 72 for 1 inch).'),
        indentEnd: z.number().min(0).optional().describe('Right indentation in points.'),
        indentFirstLine: z.number().optional().describe('First line indentation in points.'),
        padding: z.number().min(0).optional().describe('Paragraph border padding in points (shorthand across all borders).'),
        shadingColor: z.string().optional().describe('Hex background color / shading for the paragraph (e.g. "#F0F0F0").'),
        keepLinesTogether: z.boolean().optional().describe('Keep all lines of paragraph on the same page.'),
        keepWithNext: z.boolean().optional().describe('Keep paragraph on the same page as the next paragraph.'),
        avoidWidowAndOrphan: z.boolean().optional().describe('Avoid widow and orphan lines.'),
        pageBreakBefore: z.boolean().optional().describe('Start paragraph on a new page.'),
        borderTop: paragraphBorderSchema.describe('Top border settings (padding, width, dashStyle, color).'),
        borderBottom: paragraphBorderSchema.describe('Bottom border settings.'),
        borderLeft: paragraphBorderSchema.describe('Left border settings.'),
        borderRight: paragraphBorderSchema.describe('Right border settings.'),
        borderBetween: paragraphBorderSchema.describe('Between border settings for adjacent matching paragraphs.'),
        writeMode: z.enum(['SUGGEST', 'EDIT']).optional().default('EDIT'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(
      async ({
        documentId,
        startIndex,
        endIndex,
        tabId,
        namedStyleType,
        alignment,
        bulletPreset,
        removeBullets,
        spaceAbove,
        spaceBelow,
        lineSpacing,
        spacingMode,
        indentStart,
        indentEnd,
        indentFirstLine,
        padding,
        shadingColor,
        keepLinesTogether,
        keepWithNext,
        avoidWidowAndOrphan,
        pageBreakBefore,
        borderTop,
        borderBottom,
        borderLeft,
        borderRight,
        borderBetween,
        writeMode,
      }) => {
        const id = parseDocumentId(documentId);
        const m = await ctx.cache.get(id, true);
        const tab = getTab(m, tabId);
        if (startIndex < 0 || endIndex <= startIndex || endIndex > tab.endIndex) {
          return fail(`Invalid range [${startIndex}, ${endIndex}) for tab ending at ${tab.endIndex}.`);
        }

        const reqs: DocsRequest[] = [];
        const rangeObj = { startIndex, endIndex, ...(tab.tabId ? { tabId: tab.tabId } : {}) };

        const hasParaStyle =
          namedStyleType !== undefined ||
          alignment !== undefined ||
          spaceAbove !== undefined ||
          spaceBelow !== undefined ||
          lineSpacing !== undefined ||
          spacingMode !== undefined ||
          indentStart !== undefined ||
          indentEnd !== undefined ||
          indentFirstLine !== undefined ||
          padding !== undefined ||
          shadingColor !== undefined ||
          keepLinesTogether !== undefined ||
          keepWithNext !== undefined ||
          avoidWidowAndOrphan !== undefined ||
          pageBreakBefore !== undefined ||
          borderTop !== undefined ||
          borderBottom !== undefined ||
          borderLeft !== undefined ||
          borderRight !== undefined ||
          borderBetween !== undefined;

        if (hasParaStyle) {
          reqs.push(
            buildUpdateParagraphStyleRequest(rangeObj, {
              namedStyleType,
              alignment,
              spaceAbove,
              spaceBelow,
              lineSpacing,
              spacingMode,
              indentStart,
              indentEnd,
              indentFirstLine,
              padding,
              shadingColor,
              keepLinesTogether,
              keepWithNext,
              avoidWidowAndOrphan,
              pageBreakBefore,
              borderTop,
              borderBottom,
              borderLeft,
              borderRight,
              borderBetween,
            }),
          );
        }

        if (bulletPreset || removeBullets) {
          reqs.push(buildBulletsRequest(rangeObj, bulletPreset, removeBullets));
        }

        if (reqs.length === 0) {
          return fail('No paragraph style or bullet options specified.');
        }

        const mode = writeMode ?? 'EDIT';
        const out = await runBatch(ctx, id, reqs, writeControlFor(ctx, m, mode));
        return ok({
          status: 'ok',
          mode,
          startIndex,
          endIndex,
          appliedParagraphStyle: hasParaStyle
            ? {
                namedStyleType,
                alignment,
                spaceAbove,
                spaceBelow,
                lineSpacing,
                spacingMode,
                indentStart,
                indentEnd,
                indentFirstLine,
                padding,
                shadingColor,
                keepLinesTogether,
                keepWithNext,
                avoidWidowAndOrphan,
                pageBreakBefore,
                borderTop,
                borderBottom,
                borderLeft,
                borderRight,
                borderBetween,
              }
            : undefined,
          bulletPreset,
          removeBullets,
          newRevisionId: out.newRevisionId,
        });
      },
    ),
  );

  server.registerTool(
    'doc_inspect_tables',
    {
      title: 'Inspect document tables',
      description:
        'Lists all tables in the document (or tab) with their dimensions, index bounds, and matrix of cells (row, column, text, startIndex, endIndex). Essential for navigating and editing tabular sections.',
      inputSchema: {
        documentId: documentIdSchema,
        tabId: tabIdSchema,
        tableIndex: z.number().int().nonnegative().optional().describe('Inspect only this specific table index (0-indexed).'),
        includeCellText: z
          .boolean()
          .optional()
          .describe('Include cell text contents (default true). Set false to inspect only table dimensions, rows, columns, and index coordinates without text.'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, tabId, tableIndex, includeCellText }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      let tables = tab.tables;
      if (tableIndex !== undefined) {
        const found = tables.find((t) => t.tableIndex === tableIndex);
        if (!found) return fail(`Table with index ${tableIndex} not found. Total tables in tab: ${tables.length}.`);
        tables = [found];
      }
      return ok({
        revisionId: m.revisionId,
        tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
        totalTables: tab.tables.length,
        tables: tables.map((t) => ({
          tableIndex: t.tableIndex,
          startIndex: t.startIndex,
          endIndex: t.endIndex,
          rows: t.rows,
          columns: t.columns,
          cells: t.cells.map((c) => ({
            row: c.rowIndex,
            col: c.columnIndex,
            startIndex: c.startIndex,
            endIndex: c.endIndex,
            ...(includeCellText !== false ? { text: c.text } : {}),
          })),
        })),
      });
    }),
  );

  server.registerTool(
    'doc_insert_table',
    {
      title: 'Insert table',
      description:
        'Inserts a table with the specified number of rows and columns at index. The table must be inserted inside an existing paragraph (not at index 0 or inside another table).',
      inputSchema: {
        documentId: documentIdSchema,
        index: indexSchema.describe('Document model index to insert the table at.'),
        rows: z.number().int().min(1).max(100).describe('Number of rows.'),
        columns: z.number().int().min(1).max(50).describe('Number of columns.'),
        tabId: tabIdSchema,
        revisionId: revisionIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, index, rows, columns, tabId, revisionId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      checkRevision(m, revisionId);
      const tab = getTab(m, tabId);
      if (index < 1 || index > tab.endIndex) return fail(`Invalid index ${index} for tab ending at ${tab.endIndex}.`);
      if (tab.text[index] === GAP) return fail(`Cannot insert table at index ${index}: it is a structural marker.`);
      const req = buildInsertTableRequest({ index, ...(tab.tabId ? { tabId: tab.tabId } : {}) }, rows, columns);
      const out = await runBatch(ctx, id, [req], writeControlFor(ctx, m, 'EDIT'));
      return ok({
        status: 'ok',
        index,
        rows,
        columns,
        newRevisionId: out.newRevisionId,
      });
    }),
  );

  server.registerTool(
    'doc_modify_table',
    {
      title: 'Modify table structure (rows / columns)',
      description:
        'Inserts or deletes a row or column in an existing table. Requires the tableStartIndex (found via doc_inspect_tables) and cell row/column coordinates.',
      inputSchema: {
        documentId: documentIdSchema,
        tableStartIndex: indexSchema.describe('Start index of the table (see doc_inspect_tables).'),
        action: z
          .enum(['INSERT_ROW_ABOVE', 'INSERT_ROW_BELOW', 'DELETE_ROW', 'INSERT_COLUMN_LEFT', 'INSERT_COLUMN_RIGHT', 'DELETE_COLUMN'])
          .describe('Modification action.'),
        rowIndex: z.number().int().nonnegative().describe('Target row index (0-indexed).'),
        columnIndex: z.number().int().nonnegative().describe('Target column index (0-indexed).'),
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, tableStartIndex, action, rowIndex, columnIndex, tabId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      const tab = getTab(m, tabId);
      const tId = tab.tabId;

      let req: DocsRequest;
      switch (action) {
        case 'INSERT_ROW_ABOVE':
          req = buildInsertTableRowRequest(tableStartIndex, rowIndex, columnIndex, false, tId);
          break;
        case 'INSERT_ROW_BELOW':
          req = buildInsertTableRowRequest(tableStartIndex, rowIndex, columnIndex, true, tId);
          break;
        case 'DELETE_ROW':
          req = buildDeleteTableRowRequest(tableStartIndex, rowIndex, columnIndex, tId);
          break;
        case 'INSERT_COLUMN_LEFT':
          req = buildInsertTableColumnRequest(tableStartIndex, rowIndex, columnIndex, false, tId);
          break;
        case 'INSERT_COLUMN_RIGHT':
          req = buildInsertTableColumnRequest(tableStartIndex, rowIndex, columnIndex, true, tId);
          break;
        case 'DELETE_COLUMN':
          req = buildDeleteTableColumnRequest(tableStartIndex, rowIndex, columnIndex, tId);
          break;
      }

      const out = await runBatch(ctx, id, [req], writeControlFor(ctx, m, 'EDIT'));
      return ok({
        status: 'ok',
        action,
        tableStartIndex,
        rowIndex,
        columnIndex,
        newRevisionId: out.newRevisionId,
      });
    }),
  );

  server.registerTool(
    'doc_insert_image',
    {
      title: 'Insert inline image',
      description:
        'Inserts an inline image from a publicly accessible URI (HTTPS, <50MB, PNG/JPEG/GIF) at index. Optionally specify widthPt and heightPt (in points).',
      inputSchema: {
        documentId: documentIdSchema,
        index: indexSchema.describe('Document model index to insert image at.'),
        imageUri: z.string().url().describe('Publicly accessible HTTPS image URL.'),
        widthPt: z.number().positive().optional().describe('Display width in points.'),
        heightPt: z.number().positive().optional().describe('Display height in points.'),
        tabId: tabIdSchema,
        revisionId: revisionIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, index, imageUri, widthPt, heightPt, tabId, revisionId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      checkRevision(m, revisionId);
      const tab = getTab(m, tabId);
      if (index < 1 || index > tab.endIndex) return fail(`Invalid index ${index} for tab ending at ${tab.endIndex}.`);
      if (tab.text[index] === GAP) return fail(`Cannot insert image at index ${index}: it is a structural marker.`);
      const req = buildInsertImageRequest(
        { index, ...(tab.tabId ? { tabId: tab.tabId } : {}) },
        imageUri,
        widthPt,
        heightPt,
      );
      const out = await runBatch(ctx, id, [req], writeControlFor(ctx, m, 'EDIT'));
      return ok({
        status: 'ok',
        index,
        imageUri,
        newRevisionId: out.newRevisionId,
      });
    }),
  );

  // ---- Category E: Native comments & suggestions management --------------

  server.registerTool(
    'doc_add_comment',
    {
      title: 'Add anchored comment',
      description:
        'Creates a new inline comment anchored (highlighted) to the exact span [startIndex, endIndex). Take indices from doc_search_text and pass expectedText.',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        commentText: z.string().min(1).max(2048),
        expectedText: expectedTextSchema,
        assigneeEmail: z.string().email().optional().describe('Optionally assign the comment to this user.'),
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, startIndex, endIndex, commentText, expectedText, assigneeEmail, tabId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      const tab = getTab(m, tabId);
      if (startIndex < 1 || endIndex <= startIndex || endIndex > tab.endIndex) {
        return fail(`Invalid range [${startIndex}, ${endIndex}) for a tab ending at ${tab.endIndex}; a comment needs a non-empty range.`);
      }
      const actual = tab.text.slice(startIndex, endIndex);
      if (expectedText !== undefined && actual !== expectedText) {
        return fail(`Text at [${startIndex}, ${endIndex}) does not match expectedText. Current text: ${JSON.stringify(truncate(actual, 300))}.`);
      }
      const range: Record<string, unknown> = { startIndex, endIndex };
      if (tab.tabId) range.tabId = tab.tabId;
      const insertComment: Record<string, unknown> = { range, content: commentText };
      if (assigneeEmail) insertComment.assigneeEmailAddress = assigneeEmail;
      const out = await runBatch(ctx, id, [{ insertComment }], writeControlFor(ctx, m));
      if ((out.response as any).commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON') {
        return fail('The API reported that the comment could not be saved (commentUpdateState=ALL_FAILED_UNKNOWN_REASON).');
      }
      const thread = (out.response.replies?.[0] as any)?.insertComment?.commentThread;
      return ok({
        status: 'ok',
        commentId: thread?.commentId,
        anchorText: truncate(renderText(tab, startIndex, endIndex), 300),
        startIndex,
        endIndex,
        newRevisionId: out.newRevisionId,
      });
    }),
  );

  server.registerTool(
    'doc_reply_comment',
    {
      title: 'Reply to comment',
      description:
        'Adds a reply to a comment thread. Optionally RESOLVE or REOPEN the thread with the reply (replyText may be omitted when an action is given). Does not modify document text.',
      inputSchema: {
        documentId: documentIdSchema,
        commentId: z.string().min(1),
        replyText: z.string().max(2048).optional(),
        commentAction: z.enum(['RESOLVE', 'REOPEN']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, commentId, replyText, commentAction }) => {
      if (!replyText && !commentAction) return fail('Provide replyText and/or commentAction.');
      const id = parseDocumentId(documentId);
      const m = await load(documentId);
      findComment(m, commentId);
      const out = await runBatch(ctx, id, [commentReplyRequest(commentId, replyText, commentAction)]);
      if ((out.response as any).commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON') {
        return fail('The API reported that the reply could not be saved (commentUpdateState=ALL_FAILED_UNKNOWN_REASON).');
      }
      const post = (out.response.replies?.[0] as any)?.addCommentReply?.post;
      return ok({ status: 'ok', commentId, postId: post?.postId, action: commentAction, newRevisionId: out.newRevisionId });
    }),
  );

  server.registerTool(
    'doc_delete_comment',
    {
      title: 'Delete comment',
      description:
        'PERMANENTLY deletes a whole comment thread, or a single reply when postId is given. Only the author may delete. Prefer resolving (doc_reply_comment with RESOLVE) unless deletion is explicitly requested.',
      inputSchema: {
        documentId: documentIdSchema,
        commentId: z.string().min(1),
        postId: z.string().optional().describe('Delete only this reply post instead of the whole thread.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ documentId, commentId, postId }) => {
      const id = parseDocumentId(documentId);
      const req = postId ? { deleteCommentReply: { commentId, postId } } : { deleteComment: { commentId } };
      const out = await runBatch(ctx, id, [req]);
      if ((out.response as any).commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON') {
        return fail('The API reported that the deletion failed (commentUpdateState=ALL_FAILED_UNKNOWN_REASON).');
      }
      return ok({ status: 'ok', deleted: postId ? { commentId, postId } : { commentId }, newRevisionId: out.newRevisionId });
    }),
  );

  server.registerTool(
    'doc_manage_suggestion',
    {
      title: 'Accept or reject suggestion',
      description:
        'Programmatically ACCEPTs or REJECTs a pending suggestion by suggestionId (from doc_list_suggestions or a previous suggest tool result). Only do this when the user asks.',
      inputSchema: {
        documentId: documentIdSchema,
        suggestionId: z.string().min(1),
        action: z.enum(['ACCEPT', 'REJECT']),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ documentId, suggestionId, action }) => {
      const id = parseDocumentId(documentId);
      const req = action === 'ACCEPT' ? { acceptSuggestion: { suggestionId } } : { rejectSuggestion: { suggestionId } };
      const out = await runBatch(ctx, id, [req]);
      return ok({
        status: 'ok',
        action,
        suggestionId,
        accepted: suggestionIdsFrom(out.response, 'acceptedSuggestionIds'),
        rejected: suggestionIdsFrom(out.response, 'rejectedSuggestionIds'),
        newRevisionId: out.newRevisionId,
      });
    }),
  );
}
