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
  getTab,
  paragraphIndexAt,
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
  buildReplaceRequests,
  planRangeEdit,
  sortEditsDescending,
  type DocsRequest,
  type PlannedEdit,
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
  else if (status === 403) hint = ' Check that the authorised account can edit/comment on this document, and that your Cloud project is enrolled in the Google Workspace Developer Preview (required for comments & suggestion-mode APIs).';
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
// Mutation plumbing
// ---------------------------------------------------------------------------

interface BatchOutcome {
  response: docs_v1.Schema$BatchUpdateDocumentResponse;
  newRevisionId?: string;
}

async function runBatch(
  ctx: ToolContext,
  documentId: string,
  requests: DocsRequest[],
  writeControl?: docs_v1.Schema$WriteControl,
): Promise<BatchOutcome> {
  try {
    const response = await ctx.backend.batchUpdate(documentId, requests, writeControl);
    return { response, newRevisionId: response.writeControl?.requiredRevisionId ?? undefined };
  } catch (e) {
    throw toDocsApiError(e);
  } finally {
    // Content and/or comments changed (or state is unknown): drop the cached model.
    ctx.cache.invalidate(documentId);
  }
}

interface CombinedOutcome extends BatchOutcome {
  atomic: boolean;
  commentsApplied: boolean;
  warnings: string[];
}

/**
 * Applies content edits and comment operations in ONE batchUpdate when possible.
 * Falls back to two sequential requests if the API rejects the combination
 * (nothing is applied when a batch is rejected, so the retry is safe) or if it
 * reports that the comment part failed.
 */
async function runContentWithComments(
  ctx: ToolContext,
  documentId: string,
  contentReqs: DocsRequest[],
  commentReqs: DocsRequest[],
  writeControl: docs_v1.Schema$WriteControl,
): Promise<CombinedOutcome> {
  const warnings: string[] = [];
  if (commentReqs.length === 0) {
    const out = await runBatch(ctx, documentId, contentReqs, writeControl);
    return { ...out, atomic: true, commentsApplied: false, warnings };
  }
  let out: BatchOutcome;
  try {
    out = await runBatch(ctx, documentId, [...contentReqs, ...commentReqs], writeControl);
  } catch (e) {
    const err = toDocsApiError(e);
    if (err.revisionMismatch || err.status !== 400) throw err;
    out = await runBatch(ctx, documentId, contentReqs, writeControl);
    warnings.push(`Combined edit+comment request was rejected (${err.message}); edits and comment updates were applied as separate requests.`);
    try {
      const c = await runBatch(ctx, documentId, commentReqs);
      const failed = (c.response as any).commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON';
      if (failed) warnings.push('Comment update failed (commentUpdateState=ALL_FAILED_UNKNOWN_REASON).');
      return { ...out, newRevisionId: c.newRevisionId ?? out.newRevisionId, atomic: false, commentsApplied: !failed, warnings };
    } catch (e2) {
      warnings.push(`Comment update failed: ${toDocsApiError(e2).message}`);
      return { ...out, atomic: false, commentsApplied: false, warnings };
    }
  }
  if ((out.response as any).commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON') {
    warnings.push('Edits applied but the comment update in the same batch failed; retried separately.');
    try {
      const c = await runBatch(ctx, documentId, commentReqs);
      const failed = (c.response as any).commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON';
      if (failed) warnings.push('Comment update retry also failed.');
      return { ...out, newRevisionId: c.newRevisionId ?? out.newRevisionId, atomic: false, commentsApplied: !failed, warnings };
    } catch (e2) {
      warnings.push(`Comment update retry failed: ${toDocsApiError(e2).message}`);
      return { ...out, atomic: false, commentsApplied: false, warnings };
    }
  }
  return { ...out, atomic: true, commentsApplied: true, warnings };
}

function writeControlFor(ctx: ToolContext, model: DocModel, writeMode?: 'SUGGEST' | 'EDIT'): docs_v1.Schema$WriteControl {
  const wc: docs_v1.Schema$WriteControl = {};
  if (writeMode) wc.writeMode = writeMode;
  if (ctx.requireRevision && model.revisionId) wc.requiredRevisionId = model.revisionId;
  return wc;
}

function checkRevision(model: DocModel, revisionId?: string): void {
  if (revisionId && model.revisionId && revisionId !== model.revisionId) {
    throw new EditValidationError(
      `Document has changed since revision ${revisionId} (current: ${model.revisionId}); the indices you hold may be stale. Re-read the target text, or pass expectedText instead of revisionId.`,
    );
  }
}

function commentReplyRequest(commentId: string, content: string | undefined, action?: 'RESOLVE' | 'REOPEN'): DocsRequest {
  const post: Record<string, string> = {};
  if (content) post.content = content;
  if (action) post.commentAction = action;
  return { addCommentReply: { commentId, post } };
}

/** Resolves a comment's anchor to a single editable range, or throws. */
function commentEditRange(model: DocModel, commentId: string): { comment: CommentInfo; tab: TabModel; range: IndexRange } {
  const comment = findComment(model, commentId);
  const a = resolveCommentAnchor(model, comment);
  if (!a) {
    throw new EditValidationError(
      `Comment ${commentId} has no resolvable text anchor (${comment.anchorId ? 'anchor no longer in document' : 'document-level comment'}). ` +
        `Locate the text with doc_search_text and use doc_suggest_edit_range instead.`,
    );
  }
  if (!a.merged) {
    throw new EditValidationError(
      `Comment ${commentId} is anchored to ${a.ranges.length} disjoint ranges (${a.ranges
        .map((r) => `[${r.startIndex},${r.endIndex})`)
        .join(', ')}). Edit them individually with doc_suggest_edit_range or doc_batch_suggest_edits.`,
    );
  }
  if (a.merged.endIndex <= a.merged.startIndex) {
    throw new EditValidationError(`Comment ${commentId} has an empty anchor; nothing to replace.`);
  }
  return { comment, tab: a.tab, range: a.merged };
}

// ---------------------------------------------------------------------------
// Registration
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
        'Quick, text-free status check of a Google Doc: title, revisionId, tabs, character counts, comment counts (total/open/resolved) and pending suggestion count. Use refresh=true to force a full re-fetch.',
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
        tabs: m.tabs.map((t) => ({
          tabId: t.tabId || undefined,
          title: t.title || undefined,
          nestingLevel: t.nestingLevel || undefined,
          endIndex: t.endIndex,
          characterCount: charCount(t),
          headings: t.outline.length,
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
        'Surveys comment threads with their author, status, feedback text, current anchor text and exact global startIndex/endIndex. Start every review workflow here. Sorted by position in the document; unanchored comments last.',
      inputSchema: {
        documentId: documentIdSchema,
        status: z.enum(['OPEN', 'RESOLVED', 'ALL']).optional().describe('Filter by thread status (default OPEN).'),
        includeReplies: z.boolean().optional().describe('Include reply text (default false: only replyCount).'),
        maxContentChars: z.number().int().min(20).max(4000).optional().describe('Truncate feedback/anchor text (default 300).'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, status, includeReplies, maxContentChars }) => {
      const m = await load(documentId);
      if (!m.commentsAvailable) return fail(`Comments are not available: ${m.commentsUnavailableReason}`);
      const want = status ?? 'OPEN';
      const max = maxContentChars ?? 300;
      const rows = m.comments
        .filter((c) => want === 'ALL' || c.status === want)
        .map((c) => {
          const a = anchorSummary(m, c);
          return {
            commentId: c.commentId,
            author: c.head.author,
            status: c.status,
            anchorText: a.anchorText !== undefined ? truncate(a.anchorText, max) : undefined,
            startIndex: a.anchored ? a.startIndex : undefined,
            endIndex: a.anchored ? a.endIndex : undefined,
            tabId: a.anchored && a.tab.tabId && m.tabs.length > 1 ? a.tab.tabId : undefined,
            anchorStatus: a.anchored ? (a.contiguous ? undefined : 'multiple_ranges') : a.anchorStatus,
            content: truncate(c.head.content, max),
            replyCount: c.replies.length,
            replies: includeReplies
              ? c.replies.map((r) => ({ author: r.author, content: truncate(r.content, max), action: r.commentAction }))
              : undefined,
          };
        })
        .sort((x, y) => (x.startIndex ?? Number.MAX_SAFE_INTEGER) - (y.startIndex ?? Number.MAX_SAFE_INTEGER));
      return ok({ revisionId: m.revisionId, total: rows.length, comments: rows });
    }),
  );

  server.registerTool(
    'doc_search_text',
    {
      title: 'Search document text',
      description:
        'Finds occurrences of a term/phrase in the cached document text without dumping content into context. Returns exact global startIndex/endIndex, the exact matched text (usable as expectedText) and ~40 chars of preview on each side.',
      inputSchema: {
        documentId: documentIdSchema,
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(50).optional().describe('Default 5.'),
        caseSensitive: z.boolean().optional().describe('Default false.'),
        tabId: tabIdSchema,
      },
      annotations: RO,
    },
    safe(async ({ documentId, query, maxResults, caseSensitive, tabId }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      const r = searchText(tab, query, { caseSensitive, maxResults: maxResults ?? 5 });
      return ok({
        revisionId: m.revisionId,
        totalMatches: r.totalMatches,
        totalCapped: r.totalCapped || undefined,
        matches: r.matches.map((x) => ({
          startIndex: x.startIndex,
          endIndex: x.endIndex,
          text: tab.text.slice(x.startIndex, x.endIndex),
          preview: preview(tab, x.startIndex, x.endIndex, 40, 'match'),
        })),
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
      },
      annotations: RO,
    },
    safe(async ({ documentId, commentId, surroundingParagraphs, maxContextChars, markSuggestions }) => {
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
      return ok({
        ...thread,
        revisionId: m.revisionId,
        anchor: {
          startIndex: s,
          endIndex: e,
          text: renderText(tab, s, e),
          tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
          ranges: a.ranges.length > 1 ? a.ranges : undefined,
        },
        context: { contextStartIndex: cs, contextEndIndex: ce, snippet },
      });
    }),
  );

  server.registerTool(
    'doc_read_range',
    {
      title: 'Read text range',
      description:
        'Reads plain text strictly between global startIndex (inclusive) and endIndex (exclusive), preserving line breaks. Indices are never re-based. Large ranges are truncated at 20,000 chars with nextStartIndex for paging.',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        tabId: tabIdSchema,
        markSuggestions: z.boolean().optional().describe('Show pending suggestions as [-deleted-]/{+inserted+} (default false).'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, startIndex, endIndex, tabId, markSuggestions }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      if (endIndex < startIndex) return fail('endIndex must be >= startIndex.');
      if (startIndex >= tab.endIndex) return fail(`startIndex ${startIndex} is beyond the end of the tab (${tab.endIndex}).`);
      const end = Math.min(endIndex, tab.endIndex, startIndex + MAX_READ_CHARS);
      const truncated = end < Math.min(endIndex, tab.endIndex);
      return ok({
        revisionId: m.revisionId,
        tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
        startIndex,
        endIndex: end,
        text: renderText(tab, startIndex, end, !!markSuggestions),
        truncated: truncated || undefined,
        nextStartIndex: truncated ? end : undefined,
      });
    }),
  );

  // ---- Category C: Safe mutation & suggestions ----------------------------

  server.registerTool(
    'doc_suggest_comment_revision',
    {
      title: 'Suggest revision for a comment',
      description:
        "PREFERRED tool for addressing comments. Atomically proposes a suggested revision in Google Docs suggestion mode for exactly the text anchored by commentId, and (by default) marks the comment thread resolved — all in a single batchUpdate. Preserves track changes for user review. suggestedText replaces only the anchored text, so match the surrounding sentence's grammar, spacing and punctuation.",
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
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, commentId, suggestedText, resolveComment, replyMessage }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      const { comment, tab, range } = commentEditRange(m, commentId);
      const planned = planRangeEdit(tab, { ...range, text: suggestedText });
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
      }) => {
        const id = parseDocumentId(args.documentId);
        const m = await ctx.cache.get(id, true);
        checkRevision(m, args.revisionId);
        const tab = getTab(m, args.tabId);
        const planned = planRangeEdit(tab, { startIndex: args.startIndex, endIndex: args.endIndex, text: args.text }, args.expectedText);
        const out = await runBatch(ctx, id, buildReplaceRequests(tab, planned), writeControlFor(ctx, m, mode));
        return ok({
          status: 'ok',
          mode,
          replaced: { startIndex: planned.startIndex, endIndex: planned.endIndex, originalText: truncate(planned.originalText, 500) },
          newText: planned.text,
          createdSuggestionIds: mode === 'SUGGEST' ? suggestionIdsFrom(out.response, 'createdSuggestionIds') : undefined,
          newRevisionId: out.newRevisionId,
          warnings: planned.notes.length ? planned.notes : undefined,
        });
      },
    );

  const suggestRange = rangeEditHandler('SUGGEST');
  server.registerTool(
    'doc_suggest_edit_range',
    {
      title: 'Suggest edit for a range',
      description:
        'Submits a suggested revision (tracked change) replacing [startIndex, endIndex) with suggestedText. The old text appears struck-through and the new text in suggestion styling in Google Docs. Use startIndex == endIndex for a pure insertion, or empty suggestedText for a pure deletion. Take indices from doc_search_text / doc_read_comment_context and pass expectedText.',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        suggestedText: z.string(),
        expectedText: expectedTextSchema,
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
        'DIRECTLY overwrites [startIndex, endIndex) with newText, bypassing suggestion mode (no tracked change). Use ONLY when the user explicitly asks to "overwrite directly", "not use suggestions" or "make definitive edits". Otherwise use doc_suggest_edit_range.',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        newText: z.string(),
        expectedText: expectedTextSchema,
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
        'Submits several suggested revisions in ONE batchUpdate (suggestion mode). Each item targets either a commentId (its anchored text; thread resolved by default) or an explicit [startIndex, endIndex) range from the same document state. The server sorts edits bottom-to-top (descending startIndex) so indices never drift, and rejects overlapping edits.',
      inputSchema: {
        documentId: documentIdSchema,
        edits: z
          .array(
            z.object({
              commentId: z.string().optional().describe('Target the anchored text of this comment.'),
              startIndex: indexSchema.optional(),
              endIndex: indexSchema.optional(),
              expectedText: expectedTextSchema,
              suggestedText: z.string(),
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
          planned.push({ ...planRangeEdit(t, { ...range, text: e.suggestedText }, e.expectedText), item, commentId: e.commentId });
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
