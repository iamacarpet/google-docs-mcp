/**
 * Category D: Edits, Tracked Suggestions, Mutations & REST Parity tools.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { docs_v1 } from '@googleapis/docs';
import {
  GAP,
  getTab,
  truncate,
  type IndexRange,
  type TabModel,
} from '../docModel.js';
import { parseDocumentId } from '../docsClient.js';
import {
  DEFAULT_REDLINE_REPLACEMENT_STYLE,
  DEFAULT_REDLINE_RETAINED_STYLE,
  EditValidationError,
  buildMultiEditRequests,
  buildMultiRedlineRequests,
  buildRedlineRequests,
  buildReplaceRequests,
  normalizeExpectedText,
  planRangeEdit,
  sortEditsDescending,
  type DocsRequest,
  type PlannedEdit,
  type RangeEdit,
  type RedlineEdit,
  type TextStyleInput,
} from '../edits.js';
import {
  DEFAULT_RESOLVE_REPLY,
  checkRevision,
  commentEditRange,
  commentReplyRequest,
  documentIdSchema,
  expectedTextSchema,
  fail,
  indexSchema,
  ok,
  revisionIdSchema,
  runBatch,
  runContentWithComments,
  safe,
  suggestionIdsFrom,
  tabIdSchema,
  textStyleSchema,
  writeControlFor,
  type ToolContext,
} from './common.js';

export function registerEditTools(server: McpServer, ctx: ToolContext): void {
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
        commentText?: string;
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
        const contentReqs = buildReplaceRequests(tab, planned);
        const commentReqs: DocsRequest[] = [];
        if (args.commentText) {
          const cStart = planned.startIndex;
          const cEnd = Math.max(cStart + 1, planned.endIndex);
          const range: Record<string, unknown> = { startIndex: cStart, endIndex: Math.min(cEnd, tab.endIndex) };
          if (tab.tabId) range.tabId = tab.tabId;
          commentReqs.push({ insertComment: { range, content: args.commentText } });
        }
        const out =
          commentReqs.length > 0
            ? await runContentWithComments(ctx, id, contentReqs, commentReqs, writeControlFor(ctx, m, mode))
            : await runBatch(ctx, id, contentReqs, writeControlFor(ctx, m, mode));
        return ok({
          status: 'ok',
          mode,
          replaced: { startIndex: planned.startIndex, endIndex: planned.endIndex, originalText: truncate(planned.originalText, 500) },
          newText: planned.text,
          appliedStyle: planned.textStyle,
          createdSuggestionIds: mode === 'SUGGEST' ? suggestionIdsFrom(out.response, 'createdSuggestionIds') : undefined,
          commentCreated: commentReqs.length > 0 && ('commentsApplied' in out ? (out as any).commentsApplied : true),
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
        '- NOTE ON STYLE-GUIDE AMENDMENTS: If your style guide requires RETAINING original wording as bold strikethrough rather than deleting it, ALWAYS insert the new wording FIRST using doc_suggest_edit_range with startIndex === endIndex and textStyle: { bold: true, strikethrough: false }, and THEN format the original text SECOND using doc_format_text(bold: true, strikethrough: true). Never format first, or Google Docs will expand the strikethrough suggestion to swallow the inserted text.',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        suggestedText: z
          .string()
          .describe('The new replacement text. Pass empty string "" to suggest deleting the range. For pure insertion, set startIndex equal to endIndex.'),
        expectedText: expectedTextSchema,
        textStyle: textStyleSchema.describe('Styling applied to the NEW replacement text (e.g. bold: true). Does not affect deleted text.'),
        commentText: z
          .string()
          .max(2048)
          .optional()
          .describe('Optional review comment / rationale to anchor to the edited range in the same atomic batch.'),
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
    'doc_suggest_redline_edit',
    {
      title: 'Suggest redline / styled amendment',
      description:
        'Submits a redline revision (tracked change) where original text is RETAINED with custom formatting ' +
        '(e.g. bold strikethrough, italic strikethrough) rather than deleted, and optional replacement text is inserted alongside it with custom formatting (e.g. bold, italic, color).\n\n' +
        'HOW IT WORKS:\n' +
        '- Retained deletion: formats original [startIndex, endIndex) with retainedStyle (default: bold + strikethrough).\n' +
        '- Addition: inserts replacementText with replacementStyle (default: bold, strikethrough: false).\n' +
        '- Pure deletion (no replacement text): omit replacementText; original text is retained and marked with retainedStyle.\n' +
        '- Pure insertion: set startIndex === endIndex with replacementText and replacementStyle.\n' +
        '- Solves the Google Docs boundary-swallowing bug by automatically placing and styling the inserted text first and original text second in one atomic batch.',
      inputSchema: {
        documentId: documentIdSchema,
        startIndex: indexSchema,
        endIndex: indexSchema,
        expectedText: expectedTextSchema,
        replacementText: z.string().optional().describe('New wording to insert. If omitted, original text is retained and marked with retainedStyle without replacement.'),
        retainedStyle: textStyleSchema.describe('Styling for retained original text (default: { bold: true, strikethrough: true }). Set italic, color, etc. to match any party/stage guide.'),
        replacementStyle: textStyleSchema.describe('Styling for inserted replacement text (default: { bold: true, strikethrough: false }). Set italic, underline, color, etc.'),
        insertionPosition: z.enum(['AFTER', 'BEFORE']).optional().default('AFTER').describe('Whether replacement text appears AFTER original text (default) or BEFORE it.'),
        commentText: z
          .string()
          .max(2048)
          .optional()
          .describe('Optional review comment / rationale to anchor to the amended range in the same atomic batch.'),
        revisionId: revisionIdSchema,
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({
      documentId,
      startIndex,
      endIndex,
      expectedText,
      replacementText,
      retainedStyle,
      replacementStyle,
      insertionPosition,
      commentText,
      revisionId,
      tabId,
    }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      checkRevision(m, revisionId);
      const tab = getTab(m, tabId);

      const originalText = tab.text.slice(startIndex, endIndex);
      if (expectedText !== undefined && originalText !== expectedText) {
        if (normalizeExpectedText(originalText) !== normalizeExpectedText(expectedText)) {
          throw new EditValidationError(
            `Text at [${startIndex}, ${endIndex}) does not match expectedText. Current text: ${JSON.stringify(
              truncate(originalText, 300),
            )}. The document may have changed; re-read the range or re-run doc_search_text to get fresh indices.`,
          );
        }
      }

      const reqs = buildRedlineRequests(tab, {
        startIndex,
        endIndex,
        replacementText,
        retainedStyle,
        replacementStyle,
        insertionPosition,
      });

      const commentReqs: DocsRequest[] = [];
      if (commentText) {
        const range: Record<string, unknown> = { startIndex, endIndex };
        if (tab.tabId) range.tabId = tab.tabId;
        commentReqs.push({ insertComment: { range, content: commentText } });
      }

      const wc = writeControlFor(ctx, m, 'SUGGEST');
      const out =
        commentReqs.length > 0
          ? await runContentWithComments(ctx, id, reqs, commentReqs, wc)
          : await runBatch(ctx, id, reqs, wc);
      return ok({
        status: 'ok',
        documentId: id,
        newRevisionId: out.newRevisionId,
        createdSuggestionIds: suggestionIdsFrom(out.response, 'createdSuggestionIds'),
        commentCreated: commentReqs.length > 0 && ('commentsApplied' in out ? (out as any).commentsApplied : true),
        notes: [
          `Applied redline amendment at [${startIndex}, ${endIndex}): retained original text styled with ` +
            JSON.stringify(retainedStyle ?? DEFAULT_REDLINE_RETAINED_STYLE) +
            (replacementText
              ? ` and inserted new text styled with ${JSON.stringify(replacementStyle ?? DEFAULT_REDLINE_REPLACEMENT_STYLE)}`
              : ''),
        ],
      });
    }),
  );

  server.registerTool(
    'doc_batch_suggest_edits',
    {
      title: 'Batch suggest edits',
      description:
        'Submits several suggested revisions in ONE batchUpdate (suggestion mode). Each item targets either a commentId or an explicit [startIndex, endIndex) range, with optional textStyle or redline formatting. The server sorts edits bottom-to-top so indices never drift.\n\n' +
        'USAGE PATTERNS:\n' +
        '- Pure insertion: set startIndex === endIndex with suggestedText and optional textStyle (e.g. bold: true).\n' +
        '- Deletion: set suggestedText: "" to suggest deleting the target range.\n' +
        '- Replacement: provide target range and suggestedText.\n' +
        '- Redline / styled amendment: set redline: true with retainedStyle (default bold strikethrough) and replacementStyle (default bold) to keep original text formatted in the doc alongside new text.',
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
              redline: z
                .boolean()
                .optional()
                .describe('If true, performs a styled redline amendment: original text is retained with retainedStyle (default bold strikethrough), and suggestedText is inserted with replacementStyle or textStyle (default bold).'),
              retainedStyle: textStyleSchema.describe('Style for retained original text when redline is true (default: bold strikethrough).'),
              replacementStyle: textStyleSchema.describe('Style for inserted replacement text when redline is true (defaults to textStyle or bold).'),
              commentText: z
                .string()
                .max(2048)
                .optional()
                .describe('Optional review comment / rationale to anchor alongside this edit.'),
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
      const planned: (PlannedEdit & {
        item: number;
        commentId?: string;
        commentText?: string;
        isRedline?: boolean;
        retainedStyle?: TextStyleInput;
        replacementStyle?: TextStyleInput;
      })[] = [];
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
          const isRedline = !!(e.redline || e.retainedStyle || e.replacementStyle);
          const plan = planRangeEdit(
            t,
            {
              ...range,
              text: e.suggestedText,
              textStyle: e.textStyle,
            },
            e.expectedText,
          );
          planned.push({
            ...plan,
            item,
            commentId: e.commentId,
            commentText: e.commentText,
            isRedline,
            retainedStyle: e.retainedStyle,
            replacementStyle: e.replacementStyle,
          });
        } catch (err) {
          if (err instanceof EditValidationError) throw new EditValidationError(`edits[${item}]: ${err.message}`);
          throw err;
        }
      });
      const ordered = sortEditsDescending(planned);
      const contentReqs = ordered.flatMap((p) => {
        if (p.isRedline) {
          return buildRedlineRequests(tab!, {
            startIndex: p.startIndex,
            endIndex: p.endIndex,
            replacementText: p.text,
            retainedStyle: p.retainedStyle,
            replacementStyle: p.replacementStyle ?? p.textStyle,
          });
        }
        return buildReplaceRequests(tab!, p);
      });
      const resolve = resolveComments !== false;
      const commentIds = [...new Set(ordered.filter((p) => p.commentId).map((p) => p.commentId!))];
      const commentReqs: DocsRequest[] = resolve
        ? commentIds.map((cid) => commentReplyRequest(cid, replyMessage ?? DEFAULT_RESOLVE_REPLY, 'RESOLVE'))
        : replyMessage
          ? commentIds.map((cid) => commentReplyRequest(cid, replyMessage))
          : [];

      for (const p of ordered) {
        if (p.commentText && p.startIndex < p.endIndex) {
          const range: Record<string, unknown> = { startIndex: p.startIndex, endIndex: p.endIndex };
          if (tab!.tabId) range.tabId = tab!.tabId;
          commentReqs.push({ insertComment: { range, content: p.commentText } });
        }
      }

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
    'doc_batch_manage_suggestions',
    {
      title: 'Batch accept or reject suggestions',
      description:
        'Accepts or rejects multiple pending suggestions in ONE atomic batchUpdate. Can accept/reject an explicit list of suggestionIds or ACCEPT_ALL / REJECT_ALL across the document.',
      inputSchema: {
        documentId: documentIdSchema,
        action: z.enum(['ACCEPT', 'REJECT', 'ACCEPT_ALL', 'REJECT_ALL']).describe('Batch action to perform.'),
        suggestionIds: z
          .array(z.string().min(1))
          .optional()
          .describe('List of suggestionIds to accept or reject. Required for ACCEPT / REJECT; omitted or ignored for ACCEPT_ALL / REJECT_ALL.'),
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ documentId, action, suggestionIds, tabId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      let targetIds: string[] = [];

      if (action === 'ACCEPT_ALL' || action === 'REJECT_ALL') {
        const tabs = tabId ? [getTab(m, tabId)] : m.tabs;
        const set = new Set<string>();
        for (const tab of tabs) {
          for (const [sid] of tab.suggestionSpans) set.add(sid);
        }
        for (const th of m.suggestionThreads) {
          if (th.status !== 'ACCEPTED' && th.status !== 'REJECTED') set.add(th.suggestionId);
        }
        targetIds = [...set];
        if (targetIds.length === 0) {
          return ok({ status: 'ok', action, message: 'No pending suggestions to process.', count: 0 });
        }
      } else {
        if (!suggestionIds || suggestionIds.length === 0) {
          return fail('suggestionIds array is required when action is ACCEPT or REJECT.');
        }
        targetIds = suggestionIds;
      }

      const isAccept = action === 'ACCEPT' || action === 'ACCEPT_ALL';
      const requests = targetIds.map((sid) =>
        isAccept ? { acceptSuggestion: { suggestionId: sid } } : { rejectSuggestion: { suggestionId: sid } },
      );

      const out = await runBatch(ctx, id, requests);
      return ok({
        status: 'ok',
        action,
        count: targetIds.length,
        suggestionIds: targetIds,
        accepted: suggestionIdsFrom(out.response, 'acceptedSuggestionIds'),
        rejected: suggestionIdsFrom(out.response, 'rejectedSuggestionIds'),
        newRevisionId: out.newRevisionId,
      });
    }),
  );

  server.registerTool(
    'doc_suggest_replace_all',
    {
      title: 'Suggest search and replace all',
      description:
        'Finds all occurrences of searchText and proposes replacements across the document in ONE atomic batchUpdate in SUGGEST mode. Supports standard tracked replacements (native deletion + insertion) or redline mode (original retained as bold strikethrough, new text inserted as bold).',
      inputSchema: {
        documentId: documentIdSchema,
        searchText: z.string().min(1).describe('The exact text string to search for and replace.'),
        replacementText: z.string().describe('The new replacement text.'),
        matchCase: z.boolean().optional().default(true).describe('Case-sensitive matching (default true).'),
        redline: z.boolean().optional().default(false).describe('If true, retains original matches formatted as bold strikethrough and inserts replacementText as bold. If false (default), proposes native tracked deletion + replacement.'),
        retainedStyle: textStyleSchema.describe('Style for retained original text when redline is true (default: bold strikethrough).'),
        replacementStyle: textStyleSchema.describe('Style for inserted replacement text (default: bold, strikethrough: false).'),
        textStyle: textStyleSchema.describe('Styling for the replacement text in standard mode.'),
        startIndex: indexSchema.optional().describe('Optional start index to bound the search/replace range.'),
        endIndex: indexSchema.optional().describe('Optional end index to bound the search/replace range.'),
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({
      documentId,
      searchText: target,
      replacementText,
      matchCase,
      redline,
      retainedStyle,
      replacementStyle,
      textStyle,
      startIndex,
      endIndex,
      tabId,
    }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      const tab = getTab(m, tabId);
      const isCase = matchCase !== false;

      const matches: { startIndex: number; endIndex: number }[] = [];
      const text = tab.text;
      const needle = isCase ? target : target.toLowerCase();
      const haystack = isCase ? text : text.toLowerCase();
      let pos = startIndex ?? 0;
      const limit = endIndex ?? haystack.length;
      while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        const start = pos;
        const end = pos + target.length;
        if (end > limit) break;
        if (!text.slice(start, end).includes(GAP)) {
          matches.push({ startIndex: start, endIndex: end });
        }
        pos = end;
      }

      if (matches.length === 0) {
        return ok({
          status: 'ok',
          matchesFound: 0,
          message: `No occurrences of ${JSON.stringify(target)} found in tab.`,
        });
      }

      const sortedMatches = [...matches].sort((a, b) => b.startIndex - a.startIndex);

      let requests: DocsRequest[] = [];
      if (redline) {
        const redlines: RedlineEdit[] = sortedMatches.map((m) => ({
          startIndex: m.startIndex,
          endIndex: m.endIndex,
          replacementText,
          retainedStyle: retainedStyle ?? DEFAULT_REDLINE_RETAINED_STYLE,
          replacementStyle: replacementStyle ?? textStyle ?? DEFAULT_REDLINE_REPLACEMENT_STYLE,
        }));
        requests = buildMultiRedlineRequests(tab, redlines);
      } else {
        const edits: RangeEdit[] = sortedMatches.map((m) => ({
          startIndex: m.startIndex,
          endIndex: m.endIndex,
          text: replacementText,
          textStyle,
        }));
        requests = buildMultiEditRequests(tab, edits);
      }

      const wc = writeControlFor(ctx, m, 'SUGGEST');
      const out = await runBatch(ctx, id, requests, wc);
      return ok({
        status: 'ok',
        matchesReplaced: matches.length,
        ranges: matches,
        mode: redline ? 'redline' : 'native_suggestion',
        newRevisionId: out.newRevisionId,
        createdSuggestionIds: suggestionIdsFrom(out.response, 'createdSuggestionIds'),
      });
    }),
  );

  server.registerTool(
    'doc_raw_batch_update',
    {
      title: 'Raw Docs API batchUpdate (Escape Hatch)',
      description:
        'Direct passthrough to the Google Docs API documents.batchUpdate endpoint (parity with Google Workspace MCP update_doc). ' +
        'Allows executing ANY native Google Docs REST API requests (e.g. insertText, updateTextStyle, replaceAllText, updateDocumentStyle, deleteContentRange, createNamedRange). ' +
        'By default runs with writeMode: "SUGGEST" (tracked suggestion mode), or pass writeMode: "EDIT" for direct modification.',
      inputSchema: {
        documentId: documentIdSchema,
        requests: z.array(z.record(z.any())).min(1).describe('Array of raw Google Docs REST API Request objects.'),
        writeMode: z
          .enum(['SUGGEST', 'EDIT'])
          .optional()
          .default('SUGGEST')
          .describe('Whether changes are submitted as suggestions (SUGGEST, default) or applied directly (EDIT).'),
        targetRevisionId: revisionIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, requests, writeMode, targetRevisionId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      checkRevision(m, targetRevisionId);
      const wc: docs_v1.Schema$WriteControl = {};
      if (writeMode === 'EDIT') wc.writeMode = 'EDIT';
      else wc.writeMode = 'SUGGEST';
      if (ctx.requireRevision && m.revisionId) wc.requiredRevisionId = m.revisionId;

      const out = await runBatch(ctx, id, requests as DocsRequest[], wc);
      return ok({
        status: 'ok',
        writeMode: writeMode ?? 'SUGGEST',
        newRevisionId: out.newRevisionId,
        response: out.response,
      });
    }),
  );

  server.registerTool(
    'doc_create_document',
    {
      title: 'Create new Google Doc',
      description:
        'Creates a new blank Google Document in Google Drive with the given title, and optionally inserts initial text content.',
      inputSchema: {
        title: z.string().min(1).describe('The title for the new Google Document.'),
        initialText: z.string().optional().describe('Optional initial text to insert into the document body upon creation.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ title, initialText }) => {
      if (!ctx.backend.createDocument) {
        return fail('createDocument is not supported by the current backend.');
      }
      const created = await ctx.backend.createDocument(title);
      const docId = created.documentId;
      if (!docId) return fail('Failed to obtain documentId from Google Docs API.');

      let revisionId = created.revisionId;
      if (initialText && initialText.length > 0) {
        const req = { insertText: { location: { index: 1 }, text: initialText } };
        const out = await runBatch(ctx, docId, [req], { writeMode: 'EDIT' });
        revisionId = out.newRevisionId;
      }

      return ok({
        status: 'ok',
        documentId: docId,
        title: created.title ?? title,
        revisionId,
        url: `https://docs.google.com/document/d/${docId}/edit`,
      });
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
