/**
 * Common types, schemas, and API execution helpers for MCP tools.
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { docs_v1 } from '@googleapis/docs';
import {
  findComment,
  renderText,
  resolveCommentAnchor,
  truncate,
  type CommentInfo,
  type DocModel,
  type IndexRange,
  type TabModel,
} from '../docModel.js';
import {
  EditValidationError,
  type DocsRequest,
} from '../edits.js';
import {
  apiErrorMessage,
  httpStatus,
  parseDocumentId,
  type DocCache,
  type DocsBackend,
} from '../docsClient.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ToolContext {
  cache: DocCache;
  backend: DocsBackend & { resetCommentSupport?(documentId: string): void };
  requireRevision: boolean;
}

export const DEFAULT_RESOLVE_REPLY = 'Suggested revision proposed for review.';
export const MAX_READ_CHARS = 20000;

export const RO = { readOnlyHint: true, openWorldHint: true } as const;
export const MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Shared Zod Schemas
// ---------------------------------------------------------------------------

export const documentIdSchema = z.string().min(1).describe('Google Doc ID or full docs.google.com document URL.');
export const tabIdSchema = z
  .string()
  .optional()
  .describe('Document tab ID (see doc_get_metadata). Omit for the first tab.');
export const indexSchema = z.number().int().nonnegative();
export const expectedTextSchema = z
  .string()
  .optional()
  .describe(
    'Strongly recommended safety guard: the exact current text of [startIndex, endIndex) as returned by a read/search tool. The edit is rejected if the document text differs.',
  );
export const revisionIdSchema = z
  .string()
  .optional()
  .describe('Optional revisionId you read the indices from. The edit is rejected if the document has changed since.');

export const textStyleSchema = z
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

export const paragraphBorderSchema = z
  .object({
    padding: z.number().min(0).optional().describe('Border padding in points.'),
    width: z.number().min(0).optional().describe('Border width in points (0 removes border).'),
    dashStyle: z.enum(['SOLID', 'DOT', 'DASH']).optional().describe('Border dash style.'),
    color: z.string().optional().describe('Hex border color string (e.g. "#000000").'),
  })
  .optional()
  .describe('Paragraph border settings.');

// ---------------------------------------------------------------------------
// Response helpers & Error handling
// ---------------------------------------------------------------------------

export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function fail(message: string): CallToolResult {
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

export function toDocsApiError(e: unknown): DocsApiError {
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

export type Handler<A> = (args: A) => Promise<CallToolResult>;

export function safe<A>(fn: Handler<A>): Handler<A> {
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

export function preview(tab: TabModel, s: number, e: number, radius: number, tag: string, mark = false): string {
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

export function suggestionIdsFrom(res: docs_v1.Schema$BatchUpdateDocumentResponse, key: string): string[] {
  const out = new Set<string>();
  for (const r of (res as any).suggestionResponses ?? []) for (const id of r?.[key] ?? []) out.add(id);
  return [...out];
}

export function anchorSummary(model: DocModel, c: CommentInfo) {
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

export function checkRevision(m: DocModel, expected?: string): void {
  if (expected && m.revisionId && m.revisionId !== expected) {
    throw new DocsApiError(
      `Revision mismatch: you based this edit on revision ${expected}, but the current document revision is ${m.revisionId}. Re-read the document to obtain fresh indices.`,
      400,
      true,
    );
  }
}

export function writeControlFor(ctx: ToolContext, model: DocModel, mode?: 'SUGGEST' | 'EDIT'): docs_v1.Schema$WriteControl {
  const wc: docs_v1.Schema$WriteControl = {};
  if (mode === 'SUGGEST') wc.writeMode = 'SUGGEST';
  else if (mode === 'EDIT') wc.writeMode = 'EDIT';
  if (ctx.requireRevision && model.revisionId) wc.requiredRevisionId = model.revisionId;
  return wc;
}

export function commentReplyRequest(commentId: string, content?: string, action?: 'RESOLVE' | 'REOPEN'): DocsRequest {
  const post: Record<string, unknown> = {};
  if (content) post.content = content;
  if (action === 'RESOLVE') post.commentAction = 'RESOLVE';
  else if (action === 'REOPEN') post.commentAction = 'REOPEN';
  return { addCommentReply: { commentId, post } };
}

export function commentEditRange(
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

export async function runBatch(
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

export async function runContentWithComments(
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
