import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_INSTRUCTIONS = `You are connected to an optimized Google Docs editorial MCP server (native comments, comment anchors and suggestion mode).

1. WORKFLOW DISCOVERY FIRST
   - Start with doc_list_comments to survey open review threads, or doc_get_outline / doc_get_metadata to orient yourself.
   - Do NOT read the whole document unless explicitly asked. Use doc_read_comment_context(commentId) for a comment's anchored text plus surrounding paragraphs, and doc_read_range for an outline section (startIndex..sectionEndIndex).

2. EDITORIAL SUGGESTION POLICY
   - By default ALL revisions must be submitted as SUGGESTIONS (tracked changes), never direct overwrites.
   - For comment-driven edits use doc_suggest_comment_revision: it replaces exactly the comment's anchored text in suggestion mode and resolves the thread in one batchUpdate.
   - For several edits at once use doc_batch_suggest_edits (applied bottom-up automatically).
   - Use doc_apply_direct_edit ONLY if the user explicitly says e.g. "overwrite directly", "do not use suggestions" or "make definitive edits".

3. CHARACTER COORDINATES & INDEX INTEGRITY
   - Indices are exact 0-based UTF-16 code unit offsets, global to the document tab. Never approximate, guess or re-base them.
   - Always take indices from doc_list_comments, doc_read_comment_context, doc_search_text, doc_get_outline or doc_list_suggestions.
   - Pass expectedText (the exact current text of the range) to range-based edit tools whenever you can; the edit is rejected instead of corrupting text if the document changed.
   - Each mutation changes indices below/after the edit point. If you need several independent range edits, submit them together via doc_batch_suggest_edits, or apply them one by one from the highest startIndex to the lowest.
   - Keep each edit scoped to the minimum span (the comment's highlighted anchor or the exact phrase) to avoid unintended deletions.

4. READING CONVENTIONS
   - Snippets mark the comment anchor as <target>…</target> and search hits as <match>…</match>; these markers are not document text.
   - When suggestion markup is enabled, pending suggested deletions appear as [-text-] and insertions as {+text+}.
   - U+FFFC (￼) stands for a non-text element (image, smart chip, etc.). Table/section structure markers are omitted from rendered text, so rendered text length may differ from endIndex - startIndex inside tables; rely on the reported indices.`;

export function reviewCommentsPrompt(documentId: string, tone?: string): string {
  return `Review the open comments in Google Doc ${documentId} and propose revisions.

Steps:
1. Call doc_list_comments with status "OPEN".
2. For each comment that requests a wording change, call doc_read_comment_context to see the anchor and its surrounding paragraph(s).
3. Draft replacement text that addresses the feedback while fitting the surrounding sentence (grammar, capitalisation, punctuation at the anchor boundaries).${
    tone ? `\n   Target tone: ${tone}.` : ''
  }
4. Submit each revision with doc_suggest_comment_revision (suggestion mode, resolves the thread). For several comments you may use doc_batch_suggest_edits with commentId items.
5. For comments that are questions or need the author's judgement, reply with doc_reply_comment instead of editing.
6. Finish with a short summary table: commentId, action taken, and the suggested text.`;
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'review_comments',
    {
      title: 'Review comments and suggest revisions',
      description: 'Reviews open comments in a Google Doc and proposes suggested revisions in suggestion mode.',
      argsSchema: {
        documentId: z.string().describe('Google Doc ID or URL'),
        tone: z.string().optional().describe('Target tone for revisions (e.g. "executive", "friendly", "concise")'),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: reviewCommentsPrompt(args.documentId, args.tone),
          },
        },
      ],
    }),
  );
}

