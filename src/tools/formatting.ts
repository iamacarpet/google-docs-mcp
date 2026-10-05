/**
 * Category E: Text Formatting, Paragraph Layout, Tables & Images tools.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GAP,
  getTab,
  renderText,
  truncate,
  type TableModel,
} from '../docModel.js';
import { parseDocumentId } from '../docsClient.js';
import {
  buildBulletsRequest,
  buildDeleteTableColumnRequest,
  buildDeleteTableRowRequest,
  buildInsertImageRequest,
  buildInsertTableColumnRequest,
  buildInsertTableRowRequest,
  buildInsertTableRequest,
  buildUpdateParagraphStyleRequest,
  buildUpdateTextStyleRequest,
  hasStyle,
  normalizeExpectedText,
  type DocsRequest,
  type TextStyleInput,
} from '../edits.js';
import {
  checkRevision,
  documentIdSchema,
  expectedTextSchema,
  fail,
  indexSchema,
  ok,
  paragraphBorderSchema,
  revisionIdSchema,
  runBatch,
  safe,
  suggestionIdsFrom,
  tabIdSchema,
  textStyleSchema,
  writeControlFor,
  type ToolContext,
} from './common.js';

export function registerFormattingTools(server: McpServer, ctx: ToolContext): void {
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
            if (normalizeExpectedText(actual) !== normalizeExpectedText(expectedText)) {
              return fail(
                `Text at [${startIndex}, ${endIndex}) does not match expectedText. Current text: ${JSON.stringify(
                  truncate(actual, 300),
                )}.`,
              );
            }
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
        cells: z
          .array(z.array(z.string()))
          .optional()
          .describe('Optional initial 2D cell text matrix [rows][columns] to populate into the new table. Avoids needing separate insert calls for each cell.'),
        tabId: tabIdSchema,
        revisionId: revisionIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, index, rows, columns, cells, tabId, revisionId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      checkRevision(m, revisionId);
      const tab = getTab(m, tabId);
      if (index < 1 || index > tab.endIndex) return fail(`Invalid index ${index} for tab ending at ${tab.endIndex}.`);
      if (tab.text[index] === GAP) return fail(`Cannot insert table at index ${index}: it is a structural marker.`);
      const req = buildInsertTableRequest({ index, ...(tab.tabId ? { tabId: tab.tabId } : {}) }, rows, columns);
      const out = await runBatch(ctx, id, [req], writeControlFor(ctx, m, 'EDIT'));

      if (cells && cells.length > 0) {
        const freshModel = await ctx.cache.get(id, true);
        const freshTab = getTab(freshModel, tabId);
        const insertedTable = freshTab.tables.find((t) => t.startIndex >= index) ?? freshTab.tables[freshTab.tables.length - 1];
        if (insertedTable) {
          const populateReqs: DocsRequest[] = [];
          const tId = freshTab.tabId;
          const numRows = Math.min(rows, cells.length);
          for (let r = numRows - 1; r >= 0; r--) {
            const rowCells = cells[r] ?? [];
            const numCols = Math.min(columns, rowCells.length);
            for (let c = numCols - 1; c >= 0; c--) {
              const text = rowCells[c];
              if (!text) continue;
              const targetCell = insertedTable.cells.find((cell) => cell.rowIndex === r && cell.columnIndex === c);
              if (targetCell) {
                populateReqs.push({
                  insertText: {
                    location: { index: targetCell.startIndex, ...(tId ? { tabId: tId } : {}) },
                    text,
                  },
                });
              }
            }
          }
          if (populateReqs.length > 0) {
            const popOut = await runBatch(ctx, id, populateReqs, writeControlFor(ctx, freshModel, 'EDIT'));
            return ok({
              status: 'ok',
              index,
              rows,
              columns,
              cellsPopulated: populateReqs.length,
              newRevisionId: popOut.newRevisionId,
            });
          }
        }
      }

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
    'doc_insert_table_row',
    {
      title: 'Insert table row with contents',
      description:
        'Inserts a new row into an existing table and optionally populates its cells with text immediately in one atomic workflow. ' +
        'Specify tableStartIndex or tableIndex, target rowIndex, position ("ABOVE" or "BELOW"), and optional cells: string[] array.',
      inputSchema: {
        documentId: documentIdSchema,
        tableStartIndex: indexSchema.optional().describe('Start index of the table (from doc_inspect_tables or doc_read_table).'),
        tableIndex: z.number().int().nonnegative().optional().describe('0-based table index (omit if tableStartIndex is provided).'),
        rowIndex: z.number().int().nonnegative().describe('Target row index to insert next to (0-indexed).'),
        position: z.enum(['ABOVE', 'BELOW']).optional().default('BELOW').describe('Whether to insert row ABOVE or BELOW target rowIndex (default "BELOW").'),
        cells: z.array(z.string()).optional().describe('Optional array of strings to populate the newly inserted row cells with, from left to right.'),
        tabId: tabIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ documentId, tableStartIndex, tableIndex, rowIndex, position, cells, tabId }) => {
      const id = parseDocumentId(documentId);
      const m = await ctx.cache.get(id, true);
      const tab = getTab(m, tabId);
      const tId = tab.tabId;

      let targetTable: TableModel | undefined;
      if (tableStartIndex !== undefined) {
        targetTable = tab.tables.find((t) => t.startIndex === tableStartIndex);
        if (!targetTable) return fail(`No table found at tableStartIndex=${tableStartIndex}.`);
      } else if (tableIndex !== undefined) {
        if (tableIndex >= tab.tables.length) return fail(`tableIndex ${tableIndex} out of bounds (${tab.tables.length} tables).`);
        targetTable = tab.tables[tableIndex];
      } else {
        if (tab.tables.length === 0) return fail('No tables found in this tab.');
        targetTable = tab.tables[0];
      }

      const insertBelow = position !== 'ABOVE';
      const insertReq = buildInsertTableRowRequest(targetTable.startIndex, rowIndex, 0, insertBelow, tId);
      const out = await runBatch(ctx, id, [insertReq], writeControlFor(ctx, m, 'EDIT'));

      let cellsPopulated = 0;
      let newRevisionId = out.newRevisionId;

      if (cells && cells.length > 0) {
        const freshModel = await ctx.cache.get(id, true);
        const freshTab = getTab(freshModel, tabId);
        const freshTable = freshTab.tables.find((t) => t.startIndex === targetTable!.startIndex) ??
          freshTab.tables.find((t) => Math.abs(t.startIndex - targetTable!.startIndex) < 100);

        if (freshTable) {
          const newRowIdx = insertBelow ? rowIndex + 1 : rowIndex;
          const populateReqs: DocsRequest[] = [];
          const numCols = Math.min(freshTable.columns, cells.length);
          for (let c = numCols - 1; c >= 0; c--) {
            const text = cells[c];
            if (!text) continue;
            const targetCell = freshTable.cells.find((cell) => cell.rowIndex === newRowIdx && cell.columnIndex === c);
            if (targetCell) {
              populateReqs.push({
                insertText: {
                  location: { index: targetCell.startIndex, ...(tId ? { tabId: tId } : {}) },
                  text,
                },
              });
            }
          }
          if (populateReqs.length > 0) {
            const popOut = await runBatch(ctx, id, populateReqs, writeControlFor(ctx, freshModel, 'EDIT'));
            cellsPopulated = populateReqs.length;
            newRevisionId = popOut.newRevisionId;
          }
        }
      }

      return ok({
        status: 'ok',
        tableStartIndex: targetTable.startIndex,
        insertedRowIndex: insertBelow ? rowIndex + 1 : rowIndex,
        position: position ?? 'BELOW',
        cellsPopulated,
        newRevisionId,
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
}
