import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_INSTRUCTIONS = `You are connected to an optimized Google Docs editorial MCP server with first-class support for native comments, comment anchors, suggestion mode, rich text formatting, tables, images, and paragraph layout.

1. WORKFLOW DISCOVERY FIRST & LOW-TOKEN READING
   - Start with doc_list_comments to survey open review threads, or doc_get_outline / doc_get_metadata to orient yourself.
   - Do NOT read the whole document unless explicitly asked. Use doc_read_comment_context(commentId) for a comment's anchored text plus surrounding paragraphs, and doc_read_range for an outline section (startIndex..sectionEndIndex).
   - Low-token reading: doc_read_range returns plain text and compact Markdown annotatedText by default (with **bold**, *italic*, <u>underline</u>, ~~strikethrough~~, links, and image placeholders). This conveys full formatting without context bloat.
   - Suggestions vs. Document Formatting:
     * In annotatedText, ~~strikethrough~~ (and **~~bold strikethrough~~**) represents INTENTIONAL document-level text formatting (such as retained wording under formal style guides, or form options). It is NOT a Google Docs suggestion!
     * Google Docs pending suggestions are tracked changes, rendered as [-deleted text-] and {+inserted text+} (markSuggestions is enabled by default).
     * Range queries report hasPendingSuggestions and pendingSuggestions metadata with exact suggestion IDs, kinds, and bounds.
   - Selective granular flags in doc_read_range:
     * includeRuns: false (default). Set true ONLY when you need exact integer index bounds for each individual styled word or span. Styled runs include suggestion metadata (suggestion.kind: 'deletion' | 'insertion') to distinguish native suggestions from formatting.
     * includeParagraphs: false (default). Set true ONLY when inspecting paragraph layout, spacing, padding, margins, or borders.
     * In doc_inspect_tables: set includeCellText: false if you only need table dimensions, column counts, and index coordinates.

2. EDITORIAL SUGGESTION POLICY & TWO EDITING PATTERNS
   - By default ALL revisions must be submitted as SUGGESTIONS (tracked changes), never direct overwrites.
   - Pattern A: Native Docs Tracked Changes (Full Deletion / Standard Revisions):
     * To delete/remove text: use doc_suggest_deletion (or doc_suggest_edit_range with suggestedText: ""). Google Docs marks the text as a suggested deletion (which Docs displays visually with strikethrough in its web UI). When accepted, the text is removed.
     * To replace text: use doc_suggest_edit_range with [startIndex, endIndex) and suggestedText.
     * To insert text: use doc_suggest_edit_range with startIndex === endIndex and suggestedText.
     * Optional textStyle on edit tools formats ONLY the newly inserted text. NEVER apply textStyle.strikethrough to simulate deletion.
   - Pattern B: Style-Guide Formal Amendments (Retain Original Wording as Bold Strikethrough):
     * When a formal style guide requires RETAINING original wording as bold strikethrough rather than removing it, and adding new text as bold:
       CRITICAL SEQUENCING: ALWAYS insert the new text FIRST, and format the original text SECOND!
       If you format first, Google Docs will automatically expand the bold strikethrough suggestion to swallow the inserted text at the boundary, striking through both!
       1) Do NOT use doc_suggest_deletion.
       2) Insert the new text FIRST: use doc_suggest_edit_range with startIndex === endIndex (at the boundary of original text), suggestedText: " new text", and textStyle: { bold: true, strikethrough: false }.
       3) Format the original text SECOND: use doc_format_text with startIndex and endIndex matching the original text, expectedText, bold: true, strikethrough: true, and writeMode: "SUGGEST".
   - For comment-driven edits: use doc_suggest_comment_revision (replaces comment's anchored text in suggestion mode and resolves thread).
   - For several edits at once: use doc_batch_suggest_edits (applied bottom-up automatically).
   - Use doc_apply_direct_edit ONLY if the user explicitly says e.g. "overwrite directly", "do not use suggestions" or "make definitive edits".

3. RICH TEXT FORMATTING & INLINE STYLES
   - Format existing spans: Use doc_format_text to apply styling properties (bold, italic, underline, strikethrough, fontSize, foregroundColor, backgroundColor, linkUrl) to any range in SUGGEST or EDIT mode.
   - Warning on strikethrough: doc_format_text with strikethrough: true applies a font style and keeps the text in the document. Never use it to delete text (use doc_suggest_deletion instead).
   - Style while editing: Edit tools (doc_suggest_edit_range, doc_apply_direct_edit, doc_suggest_comment_revision, doc_batch_suggest_edits) accept an optional textStyle object ({ bold, italic, underline, strikethrough, fontSize, foregroundColor, backgroundColor, linkUrl }) to style inserted or replaced text immediately in the same call.

4. PARAGRAPH STYLES, SPACING & PADDING
   - Use doc_format_paragraph to customize paragraphs overlapping [startIndex, endIndex):
     * Headings: namedStyleType ('TITLE', 'SUBTITLE', 'HEADING_1' through 'HEADING_6', 'NORMAL_TEXT').
     * Alignment: alignment ('START', 'CENTER', 'END', 'JUSTIFIED').
     * Spacing: spaceAbove (points), spaceBelow (points), lineSpacing (percentage e.g. 100 for single, 115 for 1.15x, 150 for 1.5x, 200 for double), spacingMode.
     * Margins & Indentation: indentStart (left margin in PT), indentEnd (right margin in PT), indentFirstLine (first-line indent in PT).
     * Border Padding: padding (shorthand across all borders in PT) or individual borderTop, borderBottom, borderLeft, borderRight, borderBetween with { padding, width, dashStyle, color }.
     * Background Shading: shadingColor (hex color string e.g. "#F0F0F0").
     * Pagination Controls: keepWithNext (keeps headings with the following paragraph), keepLinesTogether, avoidWidowAndOrphan, pageBreakBefore.
     * Lists: bulletPreset ('BULLET_DISC_CIRCLE_SQUARE', 'BULLET_CHECKBOX', 'NUMBERED_DECIMAL_ALPHA_ROMAN', etc.) or removeBullets.

5. TABLES & IMAGES
   - Tables: Inspect tables via doc_inspect_tables. Insert tables via doc_insert_table. Add or remove rows/columns via doc_modify_table.
   - Images: Insert inline images via doc_insert_image from public HTTPS URLs with optional widthPt and heightPt.

6. CHARACTER COORDINATES & INDEX INTEGRITY
   - Indices are exact 0-based UTF-16 code unit offsets, global to the document tab. Never approximate, guess or re-base them.
   - Always take indices from doc_list_comments, doc_read_comment_context, doc_search_text, doc_get_outline, doc_inspect_tables, or doc_list_suggestions.
   - Pass expectedText (the exact current text of the range) to range-based edit tools whenever you can; the edit is rejected instead of corrupting text if the document changed.
   - Keep each edit scoped to the minimum span (the comment's highlighted anchor or the exact phrase) to avoid unintended deletions.`;

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

export function formatDocumentSectionPrompt(documentId: string, sectionTitle?: string, goal?: string): string {
  return `Review and refine typography, paragraph spacing, and layout consistency for Google Doc ${documentId}${sectionTitle ? ` (section: "${sectionTitle}")` : ''}.

Steps:
1. Locate the target section using doc_get_outline or doc_search_text.
2. Call doc_read_range with includeAnnotatedText=true (and includeParagraphs=true if inspecting paragraph spacing or margins) to analyze the section.
3. Identify formatting or layout improvements:${goal ? `\n   Goal: ${goal}.` : ''}
   - Inconsistent heading styles, line spacing, or paragraph gaps (spaceAbove / spaceBelow).
   - Missing emphasis (bold, italic) or unstyled terms.
   - Lists that should use bulletPreset.
4. Apply improvements:
   - For paragraph layout (spacing, alignment, indentation, border padding, shading), use doc_format_paragraph.
   - For text styling (bold, italic, links, colors), use doc_format_text or edit tools with textStyle.
5. Summarize the changes and layout parameters applied.`;
}

export function inspectLayoutPrompt(documentId: string): string {
  return `Inspect and summarize the structural layout, tables, and typography hierarchy for Google Doc ${documentId}.

Steps:
1. Check overall document statistics with doc_get_metadata (character count, table count, image count).
2. Fetch the document outline hierarchy with doc_get_outline.
3. If tables are present, inspect their dimensions and structure with doc_inspect_tables (using includeCellText=false for a compact survey).
4. Provide a structured report of the document's sections, tables, and formatting profile.`;
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

  server.registerPrompt(
    'format_document_section',
    {
      title: 'Format and restyle document section',
      description: 'Reviews and refines typography, paragraph spacing, and layout consistency for a section of a Google Doc.',
      argsSchema: {
        documentId: z.string().describe('Google Doc ID or URL'),
        sectionTitle: z.string().optional().describe('Title of the section to format (or omit for the whole document)'),
        goal: z.string().optional().describe('Specific styling objective (e.g. "executive memo layout", "consistent 12pt with 6pt space below")'),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: formatDocumentSectionPrompt(args.documentId, args.sectionTitle, args.goal),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'inspect_layout',
    {
      title: 'Inspect layout and document structure',
      description: 'Surveys document headings, table dimensions, and layout elements with minimal token consumption.',
      argsSchema: {
        documentId: z.string().describe('Google Doc ID or URL'),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: inspectLayoutPrompt(args.documentId),
          },
        },
      ],
    }),
  );
}
