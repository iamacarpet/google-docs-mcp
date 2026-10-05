import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_INSTRUCTIONS = `You are connected to an optimized Google Docs editorial MCP server with first-class support for native comments, comment anchors, suggestion mode, redline amendments, rich text formatting, tables, images, and paragraph layout.

1. DOCUMENT READING & NAVIGATION
   - Quick orientation:
     * doc_get_changes_summary provides an immediate high-level digest of all pending suggestions and open comments grouped by section.
     * doc_list_comments surveys review threads (supports author, query, startIndex/endIndex range filters, and groupBySection: true).
     * doc_get_outline / doc_get_metadata to orient yourself with document structure and statistics.
   - Low-token reading: doc_read_range returns plain text and compact Markdown annotatedText by default (with **bold**, *italic*, <u>underline</u>, ~~strikethrough~~, links, and image placeholders). Omit startIndex and endIndex to read the full active tab.
   - Full document reading:
     * Use doc_read_document to read the entire document in token-optimized Markdown with outline hierarchy, section markers, pending suggestions summary, and tables overview.
     * When raw Google Docs REST API AST is needed (e.g. for official Google Workspace MCP read_doc parity), pass format: "raw_json".
   - Context reading: Use doc_read_comment_context(commentId) for a comment's anchored text plus surrounding paragraphs.
   - Suggestions vs. Document Formatting:
     * In annotatedText, ~~strikethrough~~ (and **~~bold strikethrough~~**) represents INTENTIONAL document-level text formatting (such as retained wording under formal style guides, or form options). It is NOT a Google Docs suggestion!
     * Google Docs pending suggestions are tracked changes, rendered as [-deleted text-] and {+inserted text+} (markSuggestions is enabled by default).
     * Range queries report hasPendingSuggestions and pendingSuggestions metadata with exact suggestion IDs, kinds, and bounds.
   - Selective granular flags in doc_read_range / doc_read_document:
     * includeRuns: false (default). Set true ONLY when you need exact integer index bounds for each individual styled word or span. Styled runs include suggestion metadata (suggestion.kind: 'deletion' | 'insertion') to distinguish native suggestions from formatting.
     * includeParagraphs: false (default). Set true ONLY when inspecting paragraph layout, spacing, padding, margins, or borders.
     * In doc_inspect_tables: set includeCellText: false if you only need table dimensions, column counts, and index coordinates.

2. EDITORIAL SUGGESTION POLICY & THREE EDITING PATTERNS
   - By default ALL revisions must be submitted as SUGGESTIONS (tracked changes), never direct overwrites.
   - Explanatory Comments / Rationale:
     * doc_suggest_edit_range, doc_suggest_redline_edit, and items in doc_batch_suggest_edits accept an optional commentText parameter to anchor a rationale/review comment to the edited range in the same atomic call!
   - Pattern A: Native Docs Tracked Changes (Full Deletion / Standard Revisions):
     * To delete/remove text: use doc_suggest_deletion (or doc_suggest_edit_range with suggestedText: ""). Google Docs marks the text as a suggested deletion. When accepted, the text is removed.
     * To replace text: use doc_suggest_edit_range with [startIndex, endIndex) and suggestedText.
     * To insert text: use doc_suggest_edit_range with startIndex === endIndex and suggestedText.
     * Optional textStyle on edit tools formats ONLY the newly inserted text. NEVER apply textStyle.strikethrough to simulate deletion.
   - Pattern B: Styled Redline / Formal Amendments (Retain Original Wording alongside New Text):
     * When a style guide requires RETAINING original wording (e.g. as bold strikethrough) rather than removing it, and adding new text (e.g. as bold):
     * Use doc_suggest_redline_edit! It automatically executes the Docs API sequence to avoid the boundary-swallowing bug (placing and styling inserted text first, and formatting retained original text second).
     * Fully configurable: specify retainedStyle (default: { bold: true, strikethrough: true }) and replacementStyle (default: { bold: true, strikethrough: false }), or customize colors/italics for any role or process stage.
     * In batch edits: set redline: true on any item in doc_batch_suggest_edits.
   - Pattern C: Search & Replace:
     * Use doc_suggest_replace_all to propose search-and-replace revisions across the entire tab (or bound to a specific range via startIndex/endIndex) in suggestion mode in ONE atomic call. Supports both native tracked replacements and redline mode.

3. BATCH OPERATIONS & WORKFLOW AUTOMATION
   - Batch Suggest Edits: Use doc_batch_suggest_edits to submit up to 50 edits across comments or ranges in one atomic batchUpdate. Automatically sorted bottom-up to prevent index drift. Supports standard edits, pure insertions, deletions, redline amendments, and commentText rationales.
   - Batch Manage Comments: Use doc_batch_manage_comments to bulk resolve, reopen, delete, or reply to comment threads (including action: "RESOLVE_ALL" / "REOPEN_ALL" or explicit commentIds / heterogeneous operations).
   - Batch Add Comments: Use doc_batch_add_comments to anchor multiple comments across the document in one atomic call with expectedText safety guards.
   - Batch Manage Suggestions: Use doc_batch_manage_suggestions to accept or reject multiple suggestions at once (specify suggestionIds or pass action: "ACCEPT_ALL" / "REJECT_ALL").
   - Raw Docs API Escape Hatch: Use doc_raw_batch_update to send ANY raw Google Docs REST API requests (parity with official Google Workspace MCP update_doc), with writeMode: "SUGGEST" or "EDIT".
   - Document Creation: Use doc_create_document to create a new document in Google Drive with an optional initial text body.

4. RICH TEXT FORMATTING & INLINE STYLES
   - Format existing spans: Use doc_format_text to apply styling properties (bold, italic, underline, strikethrough, fontSize, foregroundColor, backgroundColor, linkUrl) to any range in SUGGEST or EDIT mode.
   - Warning on strikethrough: doc_format_text with strikethrough: true applies a font style and keeps the text in the document. Never use it to delete text (use doc_suggest_deletion instead).
   - Style while editing: Edit tools accept an optional textStyle object to style inserted or replaced text immediately in the same call.

5. PARAGRAPH STYLES, SPACING & PADDING
   - Use doc_format_paragraph to customize paragraphs overlapping [startIndex, endIndex):
     * Headings: namedStyleType ('TITLE', 'SUBTITLE', 'HEADING_1' through 'HEADING_6', 'NORMAL_TEXT').
     * Alignment: alignment ('START', 'CENTER', 'END', 'JUSTIFIED').
     * Spacing: spaceAbove (points), spaceBelow (points), lineSpacing (percentage e.g. 100 for single, 115 for 1.15x, 150 for 1.5x, 200 for double), spacingMode.
     * Margins & Indentation: indentStart (left margin in PT), indentEnd (right margin in PT), indentFirstLine (first-line indent in PT).
     * Border Padding: padding (shorthand across all borders in PT) or individual borderTop, borderBottom, borderLeft, borderRight, borderBetween with { padding, width, dashStyle, color }.
     * Background Shading: shadingColor (hex color string e.g. "#F0F0F0").
     * Pagination Controls: keepWithNext (keeps headings with the following paragraph), keepLinesTogether, avoidWidowAndOrphan, pageBreakBefore.
     * Lists: bulletPreset ('BULLET_DISC_CIRCLE_SQUARE', 'BULLET_CHECKBOX', 'NUMBERED_DECIMAL_ALPHA_ROMAN', etc.) or removeBullets.

6. TABLES (INCLUDING LARGE MULTI-LINE / MULTI-PARAGRAPH CELLS) & IMAGES
   - Fresh Chat Table Discovery (Finding Tables & Headers Fast):
     * Option A (Integrated Outline): Run doc_get_outline(documentId, includeTables: true). Each section in the outline shows which tables are inside it, their dimensions, total character count, and column headers!
     * Option B (Dedicated Table Directory): Run doc_inspect_tables(documentId, headersOnly: true). Returns a lightweight catalog of all tables in the document with their preceding heading context, column headers, rows/columns, and total character sizes, without dumping cell text.
   - Working with Tables & Multi-Line Cells (e.g. Legal briefs, Tribunals, EHCPs, or complex forms):
     * The Single-Line Markdown Trap: Standard Markdown grid tables flatten multi-line cells into giant single lines (destroying paragraph breaks, lists, and formatting).
     * BEST PRACTICE FOR MULTI-LINE CELLS: Use doc_read_table with format: "record" (or format: "all"). This outputs a structured block/card view per row and column that preserves all paragraphs, bullet points, headers, rich formatting (bold, strikethrough), and tracked changes ([-deleted-]/{+inserted+}), alongside exact character coordinates!
     * Single-Cell Inspection: Use doc_read_table_cell to target a specific cell by (tableIndex, rowIndex, columnIndex). It returns the resolved column header, paragraph count, exact bounds, and safe insertion offsets without loading unnecessary document content.
     * Table Inspection: Use doc_inspect_tables to survey table dimensions, rows, columns, character sizes, and index coordinates.
     * Cell Insertion / Appending (Avoiding Docs API Delimiter Errors):
       - Google Docs API table cells end with a structural newline delimiter. Inserting at cell.endIndex triggers an invalid index error!
       - ALWAYS use doc_append_to_table_cell (or insert at safeAppendIndex = cell.endIndex - 1) to append text to a table cell safely.
       - Supports position: 'END' (default) or position: 'START', writeMode: 'SUGGEST' (default) or 'EDIT', textStyle formatting, and rationale comments.
     * Insert & Modify Structure:
       - Use doc_insert_table to create a new table (supports optional cells 2D array).
       - Use doc_insert_table_row to add a row ABOVE or BELOW an existing row, optionally populating cells with text atomically.
       - Use doc_modify_table to insert/delete rows and columns.
   - Images: Insert inline images via doc_insert_image from public HTTPS URLs with optional widthPt and heightPt.

7. CHARACTER COORDINATES & INDEX INTEGRITY
   - Indices are exact 0-based UTF-16 code unit offsets, global to the document tab. Never approximate, guess or re-base them.
   - Pass expectedText to edit tools; smart normalization tolerates unicode curly quotes, dashes, and non-breaking spaces while protecting against conflicting concurrent edits.
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
2. Fetch the document outline hierarchy with doc_get_outline (use includeTables=true to map tables within sections).
3. If tables are present, inspect their headers and dimensions with doc_inspect_tables (using headersOnly=true for a compact survey).
4. Provide a structured report of the document's sections, tables, and formatting profile.`;
}

export function reviewTableSectionPrompt(documentId: string, tableIndex?: number): string {
  return `Review and analyze tabular sections in Google Doc ${documentId}${tableIndex !== undefined ? ` (table index: ${tableIndex})` : ''}.

Steps:
1. In a fresh chat or document analysis, discover tables and their locations:
   - Call doc_inspect_tables with headersOnly: true (or doc_get_outline with includeTables: true) to survey all tables, their surrounding section headings, dimensions, character counts, and column headers with zero token bloat.
2. For tables containing large multi-line or multi-paragraph cells (e.g. legal working documents, tribunal schedules, EHCPs), call doc_read_table with format: "record".
   - This preserves all paragraphs, bullet points, headers, and tracked suggestions without flattening them into an unreadable single line.
3. To inspect a specific cell or column (e.g. provision vs needs), use doc_read_table_cell with the target rowIndex and columnIndex.
4. If appending new points or amendments to a table cell, use doc_append_to_table_cell in SUGGEST mode to automatically prevent Google Docs API cell delimiter errors.`;
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

  server.registerPrompt(
    'review_table_section',
    {
      title: 'Review tabular sections and multi-line cells',
      description: 'Surveys and inspects tabular document sections with multi-line paragraphs, bullets, and tracked changes.',
      argsSchema: {
        documentId: z.string().describe('Google Doc ID or URL'),
        tableIndex: z.number().int().nonnegative().optional().describe('0-based table index to focus on (optional)'),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: reviewTableSectionPrompt(args.documentId, args.tableIndex),
          },
        },
      ],
    }),
  );
}
