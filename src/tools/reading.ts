/**
 * Category B: Reading, Range & Table Inspection tools.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  findComment,
  getCellsInRange,
  getImagesInRange,
  getParagraphsInRange,
  getRunsInRange,
  getSuggestionsInRange,
  getTab,
  getTableContext,
  getTablesInRange,
  paragraphIndexAt,
  renderAnnotatedText,
  renderText,
  resolveCommentAnchor,
  type TableModel,
} from '../docModel.js';
import { parseDocumentId } from '../docsClient.js';
import {
  MAX_READ_CHARS,
  RO,
  documentIdSchema,
  fail,
  indexSchema,
  ok,
  safe,
  tabIdSchema,
  type ToolContext,
} from './common.js';

export function registerReadingTools(server: McpServer, ctx: ToolContext): void {
  const load = (documentId: string, fresh = false) => ctx.cache.get(parseDocumentId(documentId), fresh);

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
    'doc_read_document',
    {
      title: 'Read whole document',
      description:
        'Reads an entire Google Doc (or tab) in one call. By default returns clean, token-efficient Markdown annotatedText plus outline and pending suggestions metadata. For Google Workspace MCP parity, pass format: "raw_json" to retrieve the full, unreduced Google Docs API document structure.',
      inputSchema: {
        documentId: documentIdSchema,
        tabId: tabIdSchema,
        format: z
          .enum(['markdown', 'raw_json'])
          .optional()
          .default('markdown')
          .describe('Output format. "markdown" (default) returns token-efficient Markdown + outline. "raw_json" returns full raw Google Docs API JSON structure (parity with official read_doc).'),
        includeFormatting: z.boolean().optional().describe('Master toggle for rich formatting in markdown mode (default true).'),
        includeAnnotatedText: z.boolean().optional().describe('Include Markdown annotatedText with formatting (default true).'),
        includeRuns: z.boolean().optional().describe('Include verbose styled runs array with exact coordinates (default false).'),
        includeParagraphs: z.boolean().optional().describe('Include verbose paragraph layout/styling objects (default false).'),
        includeTables: z.boolean().optional().describe('Include table structure and coordinates (default true).'),
        includeImages: z.boolean().optional().describe('Include inline image metadata (default true).'),
        markSuggestions: z.boolean().optional().describe('Show pending suggestions as [-deleted-]/{+inserted+} (default true).'),
        maxCharacters: z
          .number()
          .int()
          .positive()
          .optional()
          .default(50000)
          .describe('Safety limit on returned character length (default 50,000). If exceeded, truncated: true and nextStartIndex are returned.'),
      },
      annotations: RO,
    },
    safe(async ({
      documentId,
      tabId,
      format,
      includeFormatting,
      includeAnnotatedText,
      includeRuns,
      includeParagraphs,
      includeTables,
      includeImages,
      markSuggestions,
      maxCharacters,
    }) => {
      const id = parseDocumentId(documentId);
      if (format === 'raw_json') {
        const full = await ctx.backend.fetchFull(id);
        const m = await load(id);
        return ok({
          documentId: id,
          title: m.title,
          revisionId: m.revisionId,
          rawDocument: full.raw,
        });
      }

      const m = await load(id);
      const tab = getTab(m, tabId);
      const start = 1;
      const maxChars = maxCharacters ?? 50000;
      const targetEnd = tab.endIndex;
      const end = Math.min(targetEnd, start + maxChars);
      const truncated = end < targetEnd;
      const mark = markSuggestions !== false;
      const plainText = renderText(tab, start, end, mark);
      const pendingSuggestions = getSuggestionsInRange(tab, start, end);

      const formatting = includeFormatting !== false;
      const res: Record<string, any> = {
        documentId: id,
        title: m.title,
        revisionId: m.revisionId,
        tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
        totalCharacters: tab.endIndex,
        startIndex: start,
        endIndex: end,
        text: plainText,
        hasPendingSuggestions: pendingSuggestions.length > 0,
        outline: tab.outline.map((h) => ({
          title: h.title,
          level: h.level,
          startIndex: h.startIndex,
          endIndex: h.endIndex,
          sectionEndIndex: h.sectionEndIndex,
        })),
      };
      if (pendingSuggestions.length > 0) {
        res.pendingSuggestionsSummary = {
          count: pendingSuggestions.length,
          suggestions: pendingSuggestions.slice(0, 50),
        };
      }

      if (formatting) {
        if (includeAnnotatedText !== false) {
          res.annotatedText = renderAnnotatedText(tab, start, end, mark);
        }
        if (includeRuns === true) {
          const runs = getRunsInRange(tab, start, end);
          if (runs.length) res.runs = runs;
        }
        if (includeTables !== false) {
          const tablesInRange = getTablesInRange(tab, start, end);
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
          const imagesInRange = getImagesInRange(tab, start, end);
          if (imagesInRange.length) res.images = imagesInRange;
        }
        if (includeParagraphs === true) {
          const paragraphsInRange = getParagraphsInRange(tab, start, end);
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

      if (truncated) {
        res.truncated = true;
        res.nextStartIndex = end;
        res.notice = `Document content truncated at ${maxChars} characters (${end}/${targetEnd}). Use doc_read_range to read subsequent sections.`;
      }
      return ok(res);
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
        startIndex: indexSchema.optional().describe('Start index (inclusive). Defaults to 1 (beginning of body).'),
        endIndex: indexSchema.optional().describe('End index (exclusive). Defaults to end of tab body.'),
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
      const start = startIndex ?? 1;
      const targetEnd = endIndex ?? tab.endIndex;
      if (targetEnd < start) return fail('endIndex must be >= startIndex.');
      if (start >= tab.endIndex && tab.endIndex > 1) return fail(`startIndex ${start} is beyond the end of the tab (${tab.endIndex}).`);
      const end = Math.min(targetEnd, tab.endIndex, start + MAX_READ_CHARS);
      const truncated = end < Math.min(targetEnd, tab.endIndex);
      const mark = markSuggestions !== false;
      const plainText = renderText(tab, start, end, mark);
      const pendingSuggestions = getSuggestionsInRange(tab, start, end);

      const formatting = includeFormatting !== false;
      const res: Record<string, any> = {
        revisionId: m.revisionId,
        tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
        startIndex: start,
        endIndex: end,
        text: plainText,
        hasPendingSuggestions: pendingSuggestions.length > 0,
      };
      if (pendingSuggestions.length > 0) {
        res.pendingSuggestions = pendingSuggestions;
      }

      if (formatting) {
        if (includeAnnotatedText !== false) {
          res.annotatedText = renderAnnotatedText(tab, start, end, mark);
        }
        if (includeRuns === true) {
          const runs = getRunsInRange(tab, start, end);
          if (runs.length) res.runs = runs;
        }
        const tblContext = getTableContext(tab, start);
        if (tblContext) res.tableContext = tblContext;
        const cellsInRange = getCellsInRange(tab, start, end);
        if (cellsInRange.length > 0) {
          res.cells = cellsInRange.map((c) => ({
            tableIndex: c.tableIndex,
            rowIndex: c.rowIndex,
            columnIndex: c.columnIndex,
            startIndex: c.startIndex,
            endIndex: c.endIndex,
            safeAppendIndex: c.safeAppendIndex,
          }));
        }
        if (includeTables !== false) {
          const tablesInRange = getTablesInRange(tab, start, end);
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
          const imagesInRange = getImagesInRange(tab, start, end);
          if (imagesInRange.length) res.images = imagesInRange;
        }
        if (includeParagraphs === true) {
          const paragraphsInRange = getParagraphsInRange(tab, start, end);
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
    'doc_read_table',
    {
      title: 'Read table contents & structure',
      description:
        'Reads a specific table from the document and returns it formatted as a structured Record view ("record"), a standard GFM Markdown table ("markdown"), a 2D text matrix ("matrix"), or "both"/"all". ' +
        'CRITICAL FOR LARGE MULTI-LINE CELLS (e.g. tribunal or legal documents): Use format: "record" (or "all") to view multi-paragraph cells cleanly with intact paragraph breaks, bullet points, headers, and tracked suggestions, avoiding the single-line collapse of standard Markdown tables.',
      inputSchema: {
        documentId: documentIdSchema,
        tableIndex: z.number().int().nonnegative().optional().describe('0-based table index (first table is 0, second is 1, etc.).'),
        tableStartIndex: indexSchema.optional().describe('Character start index of the table (from doc_inspect_tables).'),
        format: z
          .enum(['markdown', 'matrix', 'record', 'both', 'all'])
          .optional()
          .default('both')
          .describe(
            'Output format: "record" (best for large multi-line cells; preserves paragraphs and bullets), "markdown" (standard GFM table), "matrix" (2D text array), "both" (default: markdown + matrix), or "all" (record + markdown + matrix).'
          ),
        includeAnnotatedText: z
          .boolean()
          .optional()
          .default(true)
          .describe('Preserve rich text styling (bold, italic, strikethrough, links) in cell content. Default true.'),
        markSuggestions: z
          .boolean()
          .optional()
          .default(true)
          .describe('Show pending suggestions as [-deleted-] and {+inserted+}. Default true.'),
        tabId: tabIdSchema,
      },
      annotations: RO,
    },
    safe(async ({ documentId, tableIndex, tableStartIndex, format, includeAnnotatedText, markSuggestions, tabId }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      if (tab.tables.length === 0) {
        return fail('No tables found in this tab.');
      }

      let targetTable: TableModel | undefined;
      let resolvedIndex = 0;
      if (tableStartIndex !== undefined) {
        targetTable = tab.tables.find((t) => t.startIndex === tableStartIndex);
        if (!targetTable) {
          return fail(`No table found at tableStartIndex=${tableStartIndex}. Available table start indices: ${tab.tables.map((t) => t.startIndex).join(', ')}`);
        }
        resolvedIndex = tab.tables.indexOf(targetTable);
      } else if (tableIndex !== undefined) {
        if (tableIndex >= tab.tables.length) {
          return fail(`tableIndex ${tableIndex} out of bounds. This tab has ${tab.tables.length} table(s) (indices 0 to ${tab.tables.length - 1}).`);
        }
        targetTable = tab.tables[tableIndex];
        resolvedIndex = tableIndex;
      } else {
        targetTable = tab.tables[0];
        resolvedIndex = 0;
      }

      const mark = markSuggestions !== false;
      const rich = includeAnnotatedText !== false;

      // Build 2D matrix of cell content and coordinates
      const matrix: {
        text: string;
        annotatedText: string;
        startIndex: number;
        endIndex: number;
        safeAppendIndex: number;
      }[][] = [];

      for (let r = 0; r < targetTable.rows; r++) {
        const row: {
          text: string;
          annotatedText: string;
          startIndex: number;
          endIndex: number;
          safeAppendIndex: number;
        }[] = [];
        for (let c = 0; c < targetTable.columns; c++) {
          const cell = targetTable.cells.find((cl) => cl.rowIndex === r && cl.columnIndex === c);
          if (cell) {
            const rawCellText = renderText(tab, cell.startIndex, cell.endIndex, mark)
              .replace(/\x0B/g, '')
              .replace(/\n+$/, '')
              .trim();
            const annCellText = renderAnnotatedText(tab, cell.startIndex, cell.endIndex, mark)
              .replace(/\x0B/g, '')
              .replace(/\n+$/, '')
              .trim();
            row.push({
              text: rawCellText,
              annotatedText: annCellText,
              startIndex: cell.startIndex,
              endIndex: cell.endIndex,
              safeAppendIndex: Math.max(cell.startIndex, cell.endIndex - 1),
            });
          } else {
            row.push({ text: '', annotatedText: '', startIndex: 0, endIndex: 0, safeAppendIndex: 0 });
          }
        }
        matrix.push(row);
      }

      // Infer column headers from row 0 if multi-row table
      const columnHeaders: string[] = [];
      if (matrix.length > 0) {
        for (let c = 0; c < targetTable.columns; c++) {
          const firstRowCellText = matrix[0][c]?.text ?? '';
          const firstLine = firstRowCellText.split('\n')[0]?.trim();
          columnHeaders.push(firstLine && firstLine.length < 80 ? firstLine : `Column ${c}`);
        }
      }

      // Build Record representation (blocks per row and column)
      let recordMarkdown: string | undefined;
      if (format === 'record' || format === 'all') {
        const recLines: string[] = [];
        recLines.push(`### Table ${resolvedIndex} (${targetTable.rows} rows × ${targetTable.columns} columns, range [${targetTable.startIndex}, ${targetTable.endIndex}))`);
        recLines.push('');

        for (let r = 0; r < matrix.length; r++) {
          const isHeaderRow = r === 0 && matrix.length > 1;
          recLines.push('---');
          recLines.push(`#### Row ${r}${isHeaderRow ? ' (Header Row)' : ''}`);
          recLines.push('');

          for (let c = 0; c < targetTable.columns; c++) {
            const cell = matrix[r][c];
            const headerLabel = columnHeaders[c] || `Column ${c}`;
            const content = rich ? cell.annotatedText : cell.text;
            recLines.push(`##### Row ${r}, Col ${c}: ${headerLabel} \`[${cell.startIndex}, ${cell.endIndex})\` (safeAppendIndex: \`${cell.safeAppendIndex}\`)`);
            recLines.push('');
            if (content) {
              recLines.push(content);
            } else {
              recLines.push('*(empty)*');
            }
            recLines.push('');
          }
        }
        recordMarkdown = recLines.join('\n');
      }

      // Build standard GFM Markdown representation
      let markdown: string | undefined;
      if (format === 'markdown' || format === 'both' || format === 'all') {
        const lines: string[] = [];
        if (matrix.length > 0) {
          const getCellGfm = (c: typeof matrix[0][0]) => {
            const t = rich ? c.annotatedText : c.text;
            return t.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
          };
          const header = '| ' + matrix[0].map(getCellGfm).join(' | ') + ' |';
          const sep = '| ' + matrix[0].map(() => '---').join(' | ') + ' |';
          lines.push(header);
          lines.push(sep);
          for (let r = 1; r < matrix.length; r++) {
            lines.push('| ' + matrix[r].map(getCellGfm).join(' | ') + ' |');
          }
        }
        markdown = lines.join('\n');
      }

      const textMatrix = matrix.map((row) => row.map((c) => (rich ? c.annotatedText : c.text)));
      const coordsMatrix = matrix.map((row) =>
        row.map((c) => ({
          text: rich ? c.annotatedText : c.text,
          startIndex: c.startIndex,
          endIndex: c.endIndex,
          safeAppendIndex: c.safeAppendIndex,
        }))
      );

      return ok({
        tableIndex: resolvedIndex,
        startIndex: targetTable.startIndex,
        endIndex: targetTable.endIndex,
        rows: targetTable.rows,
        columns: targetTable.columns,
        columnHeaders,
        record: format === 'record' || format === 'all' ? recordMarkdown : undefined,
        markdown: format === 'markdown' || format === 'both' || format === 'all' ? markdown : undefined,
        matrix: format === 'matrix' || format === 'both' || format === 'all' ? textMatrix : undefined,
        cellCoordinates: format === 'matrix' || format === 'both' || format === 'all' ? coordsMatrix : undefined,
      });
    }),
  );

  server.registerTool(
    'doc_read_table_cell',
    {
      title: 'Read single table cell',
      description:
        'Reads a single cell from a table by rowIndex and columnIndex. ' +
        'Preserves multi-paragraph layouts, bullet points, rich text annotations (bold, strikethrough), and tracked suggestions ([-deleted-]/{+inserted+}). ' +
        'Returns exact character coordinates, paragraph count, safeAppendIndex (for appending without Google Docs API cell delimiter errors), safePrependIndex, and resolved column header.',
      inputSchema: {
        documentId: documentIdSchema,
        tableIndex: z.number().int().nonnegative().optional().describe('0-based table index (omit if tableStartIndex is provided).'),
        tableStartIndex: indexSchema.optional().describe('Start index of the table (from doc_inspect_tables).'),
        rowIndex: z.number().int().nonnegative().describe('Target row index (0-indexed).'),
        columnIndex: z.number().int().nonnegative().describe('Target column index (0-indexed).'),
        includeAnnotatedText: z
          .boolean()
          .optional()
          .default(true)
          .describe('Preserve rich text formatting (bold, italic, etc.). Default true.'),
        markSuggestions: z
          .boolean()
          .optional()
          .default(true)
          .describe('Show pending suggestions as [-deleted-] and {+inserted+}. Default true.'),
        tabId: tabIdSchema,
      },
      annotations: RO,
    },
    safe(async ({ documentId, tableIndex, tableStartIndex, rowIndex, columnIndex, includeAnnotatedText, markSuggestions, tabId }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      if (tab.tables.length === 0) return fail('No tables found in this tab.');

      let targetTable: TableModel | undefined;
      let resolvedIndex = 0;
      if (tableStartIndex !== undefined) {
        targetTable = tab.tables.find((t) => t.startIndex === tableStartIndex);
        if (!targetTable) return fail(`No table found at tableStartIndex=${tableStartIndex}. Available table start indices: ${tab.tables.map((t) => t.startIndex).join(', ')}`);
        resolvedIndex = tab.tables.indexOf(targetTable);
      } else if (tableIndex !== undefined) {
        if (tableIndex >= tab.tables.length) return fail(`tableIndex ${tableIndex} out of bounds (${tab.tables.length} tables in tab).`);
        targetTable = tab.tables[tableIndex];
        resolvedIndex = tableIndex;
      } else {
        targetTable = tab.tables[0];
        resolvedIndex = 0;
      }

      if (rowIndex >= targetTable.rows) {
        return fail(`rowIndex ${rowIndex} out of bounds for table with ${targetTable.rows} row(s).`);
      }
      if (columnIndex >= targetTable.columns) {
        return fail(`columnIndex ${columnIndex} out of bounds for table with ${targetTable.columns} column(s).`);
      }

      const cell = targetTable.cells.find((c) => c.rowIndex === rowIndex && c.columnIndex === columnIndex);
      if (!cell) {
        return fail(`Cell at row ${rowIndex}, column ${columnIndex} not found.`);
      }

      // Column header lookup
      let columnHeader: string | undefined;
      if (targetTable.rows > 1 && rowIndex > 0) {
        const headerCell = targetTable.cells.find((c) => c.rowIndex === 0 && c.columnIndex === columnIndex);
        if (headerCell) {
          const hText = renderText(tab, headerCell.startIndex, headerCell.endIndex, false)
            .replace(/[\x00\x0B]/g, '')
            .trim();
          columnHeader = hText.split('\n')[0]?.trim();
        }
      }

      const mark = markSuggestions !== false;
      const plainText = renderText(tab, cell.startIndex, cell.endIndex, mark).replace(/\x0B/g, '').replace(/\n+$/, '');
      const annotated = renderAnnotatedText(tab, cell.startIndex, cell.endIndex, mark).replace(/\x0B/g, '').replace(/\n+$/, '');
      const safeAppendIndex = Math.max(cell.startIndex, cell.endIndex - 1);
      const safePrependIndex = cell.startIndex;
      const suggestions = getSuggestionsInRange(tab, cell.startIndex, cell.endIndex);
      const paragraphs = getParagraphsInRange(tab, cell.startIndex, cell.endIndex);

      return ok({
        tableIndex: resolvedIndex,
        tableStartIndex: targetTable.startIndex,
        tableEndIndex: targetTable.endIndex,
        rowIndex,
        columnIndex,
        columnHeader,
        startIndex: cell.startIndex,
        endIndex: cell.endIndex,
        safeAppendIndex,
        safePrependIndex,
        characterCount: cell.endIndex - cell.startIndex,
        paragraphCount: paragraphs.length,
        text: plainText,
        annotatedText: includeAnnotatedText !== false ? annotated : undefined,
        pendingSuggestions: suggestions.length ? suggestions : undefined,
      });
    }),
  );
}
