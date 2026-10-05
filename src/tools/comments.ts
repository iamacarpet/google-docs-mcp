/**
 * Category C: Comment Management, Anchoring & Review tools.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  findComment,
  getTab,
  renderText,
  truncate,
} from '../docModel.js';
import { parseDocumentId } from '../docsClient.js';
import {
  EditValidationError,
  buildReplaceRequests,
  normalizeExpectedText,
  planRangeEdit,
  type DocsRequest,
} from '../edits.js';
import {
  DEFAULT_RESOLVE_REPLY,
  RO,
  anchorSummary,
  commentEditRange,
  commentReplyRequest,
  documentIdSchema,
  expectedTextSchema,
  fail,
  indexSchema,
  ok,
  runBatch,
  runContentWithComments,
  safe,
  suggestionIdsFrom,
  tabIdSchema,
  textStyleSchema,
  writeControlFor,
  type ToolContext,
} from './common.js';

export function registerCommentsTools(server: McpServer, ctx: ToolContext): void {
  const load = (documentId: string, fresh = false) => ctx.cache.get(parseDocumentId(documentId), fresh);

  server.registerTool(
    'doc_list_comments',
    {
      title: 'List comments',
      description:
        'Surveys all comments in the document. Returns compact summaries (author, status, anchor text, content snippet, and exact [startIndex, endIndex) coordinates). Prefer status="OPEN" to find unresolved feedback. Supports filtering by author, keyword query, range, and grouping by outline section.',
      inputSchema: {
        documentId: documentIdSchema,
        status: z.enum(['OPEN', 'RESOLVED', 'ALL']).optional().describe('Default "OPEN".'),
        author: z.string().optional().describe('Filter by author name or email (case-insensitive substring).'),
        query: z.string().optional().describe('Search in comment content, anchor text, or replies (case-insensitive substring).'),
        startIndex: indexSchema.optional().describe('Filter comments anchored at or after this character index.'),
        endIndex: indexSchema.optional().describe('Filter comments anchored at or before this character index.'),
        groupBySection: z.boolean().optional().describe('Group returned comments under document outline section headings (default false).'),
        tabId: tabIdSchema.describe('Only return comments anchored in this tab (omit for all tabs).'),
        maxResults: z.number().int().min(1).max(500).optional().describe('Default 100.'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, status, author, query, startIndex, endIndex, groupBySection, tabId, maxResults }) => {
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
        if (author && !c.head?.author?.toLowerCase().includes(author.toLowerCase())) continue;
        if (query) {
          const q = query.toLowerCase();
          const matchContent = c.head?.content?.toLowerCase().includes(q) ?? false;
          const matchAnchor = a.anchorText ? a.anchorText.toLowerCase().includes(q) : false;
          const matchReplies = c.replies.some((r) => r.content?.toLowerCase().includes(q));
          if (!matchContent && !matchAnchor && !matchReplies) continue;
        }
        if (startIndex !== undefined && a.endIndex !== undefined && a.endIndex < startIndex) continue;
        if (endIndex !== undefined && a.startIndex !== undefined && a.startIndex > endIndex) continue;

        let sectionTitle = 'Preamble / Untitled';
        if (a.anchored && a.startIndex !== undefined) {
          const outline = a.tab.outline ?? [];
          const heading = outline.slice().reverse().find((h) => h.startIndex <= a.startIndex! && (h.sectionEndIndex ? a.startIndex! < h.sectionEndIndex : true));
          if (heading) sectionTitle = heading.title;
        }

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
          section: sectionTitle,
          tabId: a.anchored && m.tabs.length > 1 ? a.tab.tabId : undefined,
          startIndex: a.startIndex,
          endIndex: a.endIndex,
          anchorText: a.anchorText ? truncate(a.anchorText, 200) : undefined,
        });
        if (rows.length >= max) break;
      }

      if (groupBySection) {
        const sectionsMap = new Map<string, typeof rows>();
        for (const r of rows) {
          const sec = r.section ?? 'Preamble / Untitled';
          if (!sectionsMap.has(sec)) sectionsMap.set(sec, []);
          sectionsMap.get(sec)!.push(r);
        }
        const sections = Array.from(sectionsMap.entries()).map(([secTitle, cList]) => ({
          sectionTitle: secTitle,
          count: cList.length,
          comments: cList,
        }));
        return ok({ revisionId: m.revisionId, totalMatched: rows.length, sections });
      }

      return ok({ revisionId: m.revisionId, totalMatched: rows.length, comments: rows });
    }),
  );

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
    'doc_batch_manage_comments',
    {
      title: 'Batch manage comments (reply, resolve, reopen, delete)',
      description:
        'Performs bulk comment operations in ONE atomic batchUpdate. Supports bulk resolving or reopening (including RESOLVE_ALL / REOPEN_ALL), bulk replies, bulk deletions, or heterogeneous operations per comment.',
      inputSchema: {
        documentId: documentIdSchema,
        action: z
          .enum(['RESOLVE', 'REOPEN', 'DELETE', 'RESOLVE_ALL', 'REOPEN_ALL'])
          .optional()
          .describe('Batch action to apply across commentIds (or whole doc for RESOLVE_ALL / REOPEN_ALL).'),
        commentIds: z
          .array(z.string().min(1))
          .optional()
          .describe('List of commentIds to apply action to. Required when action is RESOLVE, REOPEN, or DELETE without operations.'),
        replyText: z
          .string()
          .max(2048)
          .optional()
          .describe('Optional reply text attached to each resolved/reopened comment.'),
        operations: z
          .array(
            z.object({
              commentId: z.string().min(1),
              action: z.enum(['RESOLVE', 'REOPEN', 'DELETE']).optional(),
              replyText: z.string().max(2048).optional(),
              postId: z.string().optional().describe('For DELETE: deletes specific reply instead of entire thread.'),
            }),
          )
          .optional()
          .describe('Heterogeneous per-comment operations list (alternative to uniform action + commentIds).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ documentId, action, commentIds, replyText, operations }) => {
      const id = parseDocumentId(documentId);
      const m = await load(documentId);
      const reqs: DocsRequest[] = [];
      const affectedCommentIds: string[] = [];

      if (action === 'RESOLVE_ALL' || action === 'REOPEN_ALL') {
        const targetStatus = action === 'RESOLVE_ALL' ? 'OPEN' : 'RESOLVED';
        const newStatusAction = action === 'RESOLVE_ALL' ? 'RESOLVE' : 'REOPEN';
        const eligible = m.comments.filter((c) => c.status === targetStatus);
        for (const c of eligible) {
          reqs.push(commentReplyRequest(c.commentId, replyText ?? DEFAULT_RESOLVE_REPLY, newStatusAction));
          affectedCommentIds.push(c.commentId);
        }
      } else if (action && commentIds && commentIds.length > 0) {
        for (const cid of commentIds) {
          affectedCommentIds.push(cid);
          if (action === 'DELETE') {
            reqs.push({ deleteComment: { commentId: cid } });
          } else {
            reqs.push(commentReplyRequest(cid, replyText ?? DEFAULT_RESOLVE_REPLY, action));
          }
        }
      } else if (operations && operations.length > 0) {
        for (const op of operations) {
          affectedCommentIds.push(op.commentId);
          if (op.action === 'DELETE') {
            reqs.push(op.postId ? { deleteCommentReply: { commentId: op.commentId, postId: op.postId } } : { deleteComment: { commentId: op.commentId } });
          } else if (op.action || op.replyText) {
            reqs.push(commentReplyRequest(op.commentId, op.replyText ?? (op.action === 'RESOLVE' ? DEFAULT_RESOLVE_REPLY : undefined), op.action));
          }
        }
      } else {
        return fail('Specify either action="RESOLVE_ALL"|"REOPEN_ALL", or action + commentIds, or an operations array.');
      }

      if (reqs.length === 0) {
        return ok({
          status: 'ok',
          action: action ?? 'CUSTOM_OPERATIONS',
          count: 0,
          affectedCommentIds: [],
          message: 'No eligible comments found matching criteria.',
        });
      }

      const out = await runBatch(ctx, id, reqs);
      if ((out.response as any).commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON') {
        return fail('The API reported that comment updates failed (commentUpdateState=ALL_FAILED_UNKNOWN_REASON).');
      }

      return ok({
        status: 'ok',
        action: action ?? 'CUSTOM_OPERATIONS',
        count: reqs.length,
        affectedCommentIds: [...new Set(affectedCommentIds)],
        newRevisionId: out.newRevisionId,
      });
    }),
  );

  server.registerTool(
    'doc_batch_add_comments',
    {
      title: 'Batch add anchored comments',
      description:
        'Creates multiple new inline comments anchored to spans across the document in ONE atomic batchUpdate. ' +
        'Each item must specify startIndex, endIndex, and commentText, with optional expectedText validation and assigneeEmail.',
      inputSchema: {
        documentId: documentIdSchema,
        comments: z
          .array(
            z.object({
              startIndex: indexSchema,
              endIndex: indexSchema,
              commentText: z.string().min(1).max(2048),
              expectedText: expectedTextSchema,
              assigneeEmail: z.string().email().optional(),
            }),
          )
          .min(1)
          .max(50),
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, comments, tabId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      const tab = getTab(m, tabId);
      const reqs: DocsRequest[] = [];
      const itemSummaries: any[] = [];

      comments.forEach((c, idx) => {
        if (c.startIndex < 1 || c.endIndex <= c.startIndex || c.endIndex > tab.endIndex) {
          throw new EditValidationError(`comments[${idx}]: Invalid range [${c.startIndex}, ${c.endIndex}) for tab ending at ${tab.endIndex}.`);
        }
        const actual = tab.text.slice(c.startIndex, c.endIndex);
        if (c.expectedText !== undefined && actual !== c.expectedText) {
          if (normalizeExpectedText(actual) !== normalizeExpectedText(c.expectedText)) {
            throw new EditValidationError(
              `comments[${idx}]: Text at [${c.startIndex}, ${c.endIndex}) does not match expectedText. Current text: ${JSON.stringify(truncate(actual, 200))}.`,
            );
          }
        }
        const range: Record<string, unknown> = { startIndex: c.startIndex, endIndex: c.endIndex };
        if (tab.tabId) range.tabId = tab.tabId;
        const insertComment: Record<string, unknown> = { range, content: c.commentText };
        if (c.assigneeEmail) insertComment.assigneeEmailAddress = c.assigneeEmail;
        reqs.push({ insertComment });
        itemSummaries.push({
          startIndex: c.startIndex,
          endIndex: c.endIndex,
          anchorText: truncate(renderText(tab, c.startIndex, c.endIndex), 200),
          commentText: truncate(c.commentText, 200),
        });
      });

      const out = await runBatch(ctx, id, reqs, writeControlFor(ctx, m));
      if ((out.response as any).commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON') {
        return fail('The API reported that comments could not be saved (commentUpdateState=ALL_FAILED_UNKNOWN_REASON).');
      }

      const createdCommentIds: string[] = [];
      if (out.response.replies) {
        for (const reply of out.response.replies as any[]) {
          const cid = reply?.insertComment?.commentThread?.commentId;
          if (cid) createdCommentIds.push(cid);
        }
      }

      return ok({
        status: 'ok',
        count: reqs.length,
        createdCommentIds,
        comments: itemSummaries,
        newRevisionId: out.newRevisionId,
      });
    }),
  );
}
