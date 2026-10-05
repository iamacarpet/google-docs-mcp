import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocModel,
  formatColor,
  getRunsInRange,
  getTab,
  parseParagraphStyle,
  renderAnnotatedText,
  renderText,
} from '../docModel.js';
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
  parseColor,
} from '../edits.js';
import { createFormattedDocument } from './fixtures.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type ToolContext } from '../tools.js';
import { DocCache, type DocsBackend, type FullFetch } from '../docsClient.js';

class MockBackend implements DocsBackend {
  batchCalls: { documentId: string; requests: any[]; writeControl?: any }[] = [];
  constructor(private rawDoc: any) {}

  async getRevisionId(): Promise<string | undefined> {
    return this.rawDoc.revisionId;
  }
  async fetchFull(): Promise<FullFetch> {
    return { raw: this.rawDoc, commentsAvailable: true };
  }
  async batchUpdate(documentId: string, requests: any[], writeControl?: any): Promise<any> {
    this.batchCalls.push({ documentId, requests, writeControl });
    return {
      writeControl: { requiredRevisionId: 'rev_formatted_updated_002' },
      replies: [{}],
    };
  }
}

describe('Rich Text, Layout & Document Elements Support', () => {
  it('parses and formats colors accurately', () => {
    assert.deepEqual(parseColor('#ff0000'), { red: 1, green: 0, blue: 0 });
    assert.deepEqual(parseColor('#00ff00'), { red: 0, green: 1, blue: 0 });
    assert.deepEqual(parseColor({ red: 0.5, green: 0.5, blue: 0.5 }), { red: 0.5, green: 0.5, blue: 0.5 });
    assert.equal(formatColor({ red: 1, green: 0, blue: 0 }), '#ff0000');
    assert.equal(formatColor({ red: 0, green: 1, blue: 0 }), '#00ff00');
  });

  it('detects presence of text styles with hasStyle', () => {
    assert.equal(hasStyle(undefined), false);
    assert.equal(hasStyle({}), false);
    assert.equal(hasStyle({ bold: true }), true);
    assert.equal(hasStyle({ fontSize: 14 }), true);
    assert.equal(hasStyle({ foregroundColor: '#123456' }), true);
    assert.equal(hasStyle({ linkUrl: 'https://example.com' }), true);
  });

  it('parses paragraph spacing, borders, padding and indentation', () => {
    const rawStyle = {
      namedStyleType: 'HEADING_1',
      alignment: 'CENTER',
      lineSpacing: 115,
      spaceAbove: { magnitude: 18, unit: 'PT' },
      spaceBelow: { magnitude: 6, unit: 'PT' },
      indentStart: { magnitude: 36, unit: 'PT' },
      borderBottom: {
        padding: { magnitude: 4, unit: 'PT' },
        width: { magnitude: 1, unit: 'PT' },
        dashStyle: 'SOLID',
        color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
      },
      shading: {
        backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
      },
    };
    const parsed = parseParagraphStyle(rawStyle);
    assert.ok(parsed);
    assert.equal(parsed.namedStyleType, 'HEADING_1');
    assert.equal(parsed.alignment, 'CENTER');
    assert.equal(parsed.lineSpacing, 115);
    assert.equal(parsed.spaceAbove, 18);
    assert.equal(parsed.spaceBelow, 6);
    assert.equal(parsed.indentStart, 36);
    assert.equal(parsed.borderBottom?.padding, 4);
    assert.equal(parsed.borderBottom?.width, 1);
    assert.equal(parsed.borderBottom?.dashStyle, 'SOLID');
    assert.equal(parsed.borderBottom?.color, '#000000');
    assert.equal(parsed.shadingColor, '#f2f2f2');
  });

  it('extracts tables, images, and styled runs from document model', () => {
    const raw = createFormattedDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });
    const tab = getTab(model);

    // Document contains 1 table
    assert.equal(tab.tables.length, 1);
    const table = tab.tables[0];
    assert.equal(table.rows, 2);
    assert.equal(table.columns, 2);
    assert.equal(table.cells.length, 4);

    // Verify cell contents
    assert.equal(table.cells[0].text, 'Requirement Item');
    assert.equal(table.cells[1].text, 'Proposed Deliverables');
    assert.equal(table.cells[2].text, 'Feature & System Scope');
    assert.ok(table.cells[3].text.includes('Deliverable includes'));

    // Document contains 1 image
    assert.equal(tab.images.length, 1);
    const img = tab.images[0];
    assert.equal(img.objectId, 'kix.chart1');
    assert.equal(img.title, 'System Performance Metrics');
    assert.equal(img.width, 400);
    assert.equal(img.height, 250);

    // Document contains styled runs with exact styling
    const runs = getRunsInRange(tab, 132, 218);
    assert.ok(runs.length >= 3);
    const italicStrikeRun = runs.find((r) => r.style.italic && r.style.strikethrough);
    assert.ok(italicStrikeRun);
    assert.equal(tab.text.slice(italicStrikeRun.startIndex, italicStrikeRun.endIndex), '10 days ');

    const boldRun = runs.find((r) => r.style.bold);
    assert.ok(boldRun);
    assert.equal(tab.text.slice(boldRun.startIndex, boldRun.endIndex), '20 days ');

    const underlineRun = runs.find((r) => r.style.underline);
    assert.ok(underlineRun);
    assert.equal(tab.text.slice(underlineRun.startIndex, underlineRun.endIndex), 'dedicated QA support');
  });

  it('renders rich markdown annotations for styled runs and images', () => {
    const raw = createFormattedDocument();
    const model = buildDocModel(raw, { commentsAvailable: true });
    const tab = getTab(model);

    // Render provision cell range [132, 218)
    const annotated = renderAnnotatedText(tab, 132, 218);
    // Should have italic strikethrough for 10 days
    assert.ok(annotated.includes('*~~10 days~~*') || annotated.includes('~~*10 days*~~'));
    // Should have bold for 20 days
    assert.ok(annotated.includes('**20 days**'));
    // Should have underline for dedicated QA support
    assert.ok(annotated.includes('<u>dedicated QA support</u>'));

    // Render image range [220, 250)
    const imgAnnotated = renderAnnotatedText(tab, 220, 250);
    assert.ok(imgAnnotated.includes('[Image: System Performance Metrics (400x250)]'));
  });

  it('builds Docs API requests for layout, tables and text formatting', () => {
    // updateTextStyle
    const styleReq = buildUpdateTextStyleRequest({ startIndex: 10, endIndex: 20 }, { bold: true, strikethrough: true });
    assert.deepEqual(styleReq, {
      updateTextStyle: {
        range: { startIndex: 10, endIndex: 20 },
        textStyle: { bold: true, strikethrough: true },
        fields: 'bold,strikethrough',
      },
    });

    // updateParagraphStyle
    const paraReq = buildUpdateParagraphStyleRequest({ startIndex: 1, endIndex: 30 }, { namedStyleType: 'HEADING_1', alignment: 'CENTER' });
    assert.deepEqual(paraReq, {
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 30 },
        paragraphStyle: { namedStyleType: 'HEADING_1', alignment: 'CENTER' },
        fields: 'namedStyleType,alignment',
      },
    });

    const advParaReq = buildUpdateParagraphStyleRequest(
      { startIndex: 1, endIndex: 30 },
      {
        namedStyleType: 'HEADING_1',
        alignment: 'CENTER',
        spaceAbove: 18,
        spaceBelow: 6,
        lineSpacing: 115,
        indentStart: 36,
        padding: 4,
        shadingColor: '#f0f0f0',
        keepWithNext: true,
      },
    );
    assert.deepEqual(advParaReq, {
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 30 },
        paragraphStyle: {
          namedStyleType: 'HEADING_1',
          alignment: 'CENTER',
          spaceAbove: { magnitude: 18, unit: 'PT' },
          spaceBelow: { magnitude: 6, unit: 'PT' },
          lineSpacing: 115,
          indentStart: { magnitude: 36, unit: 'PT' },
          shading: { backgroundColor: { color: { rgbColor: parseColor('#f0f0f0') } } },
          keepWithNext: true,
          borderTop: { padding: { magnitude: 4, unit: 'PT' }, width: { magnitude: 0, unit: 'PT' }, dashStyle: 'SOLID', color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } } },
          borderBottom: { padding: { magnitude: 4, unit: 'PT' }, width: { magnitude: 0, unit: 'PT' }, dashStyle: 'SOLID', color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } } },
          borderLeft: { padding: { magnitude: 4, unit: 'PT' }, width: { magnitude: 0, unit: 'PT' }, dashStyle: 'SOLID', color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } } },
          borderRight: { padding: { magnitude: 4, unit: 'PT' }, width: { magnitude: 0, unit: 'PT' }, dashStyle: 'SOLID', color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } } },
        },
        fields: 'namedStyleType,alignment,spaceAbove,spaceBelow,lineSpacing,indentStart,shading.backgroundColor,keepWithNext,borderTop,borderBottom,borderLeft,borderRight',
      },
    });

    // bullets
    const bulletReq = buildBulletsRequest({ startIndex: 1, endIndex: 50 }, 'BULLET_CHECKBOX');
    assert.deepEqual(bulletReq, {
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 50 },
        bulletPreset: 'BULLET_CHECKBOX',
      },
    });

    // insertTable
    const tableReq = buildInsertTableRequest({ index: 50 }, 3, 4);
    assert.deepEqual(tableReq, {
      insertTable: {
        rows: 3,
        columns: 4,
        location: { index: 50 },
      },
    });

    // insertTableRow
    const rowReq = buildInsertTableRowRequest(60, 1, 0, true);
    assert.deepEqual(rowReq, {
      insertTableRow: {
        insertBelow: true,
        tableCellLocation: {
          tableStartLocation: { index: 60 },
          rowIndex: 1,
          columnIndex: 0,
        },
      },
    });

    // insertInlineImage
    const imgReq = buildInsertImageRequest({ index: 100 }, 'https://example.com/logo.png', 200, 150);
    assert.deepEqual(imgReq, {
      insertInlineImage: {
        uri: 'https://example.com/logo.png',
        location: { index: 100 },
        objectSize: {
          width: { magnitude: 200, unit: 'PT' },
          height: { magnitude: 150, unit: 'PT' },
        },
      },
    });
  });

  describe('MCP Tools with Formatting & Elements', () => {
    async function setupServer() {
      const raw = createFormattedDocument();
      const backend = new MockBackend(raw);
      const cache = new DocCache(backend, { ttlMs: 10000, maxEntries: 5 });
      const server = new McpServer({ name: 'test-docs-mcp', version: '1.0.0' });
      const ctx: ToolContext = {
        cache,
        backend,
        requireRevision: true,
      };
      registerTools(server, ctx);
      return { server, backend };
    }

    async function call(server: McpServer, name: string, args: Record<string, any>) {
      // @ts-expect-error accessing private tools map
      const tool = server._registeredTools[name];
      assert.ok(tool, `Tool ${name} not found`);
      const res = await tool.handler(args);
      return JSON.parse(res.content[0].text);
    }

    it('doc_get_metadata: reports tableCount and imageCount', async () => {
      const { server } = await setupServer();
      const res = await call(server, 'doc_get_metadata', { documentId: 'doc_formatted_001' });

      assert.equal(res.tableCount, 1);
      assert.equal(res.imageCount, 1);
      assert.equal(res.documentId, 'doc_formatted_001');
      assert.equal(res.title, 'Project Proposal & Review');
    });

    it('doc_read_range: returns compact annotatedText by default without runs or paragraphs bloat', async () => {
      const { server } = await setupServer();
      const res = await call(server, 'doc_read_range', {
        documentId: 'doc_formatted_001',
        startIndex: 132,
        endIndex: 218,
      });

      assert.equal(res.startIndex, 132);
      assert.equal(res.endIndex, 218);
      assert.ok(res.text.includes('Deliverable includes'));
      assert.ok(res.annotatedText.includes('**20 days**'));
      assert.equal(res.runs, undefined);
      assert.equal(res.paragraphs, undefined);
      assert.ok(res.tableContext);
      assert.equal(res.tableContext.rowIndex, 1);
      assert.equal(res.tableContext.columnIndex, 1);
    });

    it('doc_read_range: includes runs and paragraphs when specifically requested', async () => {
      const { server } = await setupServer();
      const res = await call(server, 'doc_read_range', {
        documentId: 'doc_formatted_001',
        startIndex: 132,
        endIndex: 218,
        includeRuns: true,
        includeParagraphs: true,
      });

      assert.ok(res.runs && res.runs.length >= 3);
      assert.ok(res.paragraphs && res.paragraphs.length >= 1);
      assert.equal(res.paragraphs[0].namedStyleType, 'NORMAL_TEXT');
    });

    it('doc_inspect_tables: omits cell text when includeCellText=false', async () => {
      const { server } = await setupServer();
      const res = await call(server, 'doc_inspect_tables', {
        documentId: 'doc_formatted_001',
        includeCellText: false,
      });

      assert.equal(res.totalTables, 1);
      assert.equal(res.tables[0].cells[0].row, 0);
      assert.equal(res.tables[0].cells[0].text, undefined);
      assert.ok(res.tables[0].columnHeaders);
      assert.equal(res.tables[0].columnHeaders[0], 'Requirement Item');
      assert.ok(res.tables[0].precedingHeading);
    });

    it('doc_inspect_tables: headersOnly returns compact directory without cells array', async () => {
      const { server } = await setupServer();
      const res = await call(server, 'doc_inspect_tables', {
        documentId: 'doc_formatted_001',
        headersOnly: true,
      });

      assert.equal(res.totalTables, 1);
      const t = res.tables[0];
      assert.equal(t.rows, 2);
      assert.equal(t.columns, 2);
      assert.equal(t.cells, undefined);
      assert.equal(t.columnHeaders[0], 'Requirement Item');
      assert.equal(t.columnHeaders[1], 'Proposed Deliverables');
      assert.equal(t.precedingHeading?.title, 'Section 1: Core Deliverables');
      assert.ok(t.totalCharacters > 0);
    });

    it('doc_format_paragraph: applies spacing, padding, indentation and borders', async () => {
      const { server, backend } = await setupServer();
      const res = await call(server, 'doc_format_paragraph', {
        documentId: 'doc_formatted_001',
        startIndex: 1,
        endIndex: 31,
        alignment: 'CENTER',
        spaceAbove: 18,
        spaceBelow: 6,
        lineSpacing: 115,
        indentStart: 36,
        padding: 4,
        shadingColor: '#f0f0f0',
        keepWithNext: true,
      });

      assert.equal(res.status, 'ok');
      assert.ok(res.appliedParagraphStyle);
      assert.equal(res.appliedParagraphStyle.spaceAbove, 18);
      assert.equal(res.appliedParagraphStyle.spaceBelow, 6);
      assert.equal(res.appliedParagraphStyle.padding, 4);

      assert.equal(backend.batchCalls.length, 1);
      const req = backend.batchCalls[0].requests[0].updateParagraphStyle;
      assert.equal(req.paragraphStyle.alignment, 'CENTER');
      assert.equal(req.paragraphStyle.spaceAbove.magnitude, 18);
      assert.equal(req.paragraphStyle.spaceBelow.magnitude, 6);
      assert.equal(req.paragraphStyle.lineSpacing, 115);
      assert.equal(req.paragraphStyle.indentStart.magnitude, 36);
      assert.equal(req.paragraphStyle.borderTop.padding.magnitude, 4);
      assert.ok(req.fields.includes('spaceAbove'));
      assert.ok(req.fields.includes('borderTop'));
    });

    it('doc_inspect_tables: lists tables and cell coordinates with text', async () => {
      const { server } = await setupServer();
      const res = await call(server, 'doc_inspect_tables', {
        documentId: 'doc_formatted_001',
      });

      assert.equal(res.totalTables, 1);
      const t = res.tables[0];
      assert.equal(t.rows, 2);
      assert.equal(t.columns, 2);
      assert.equal(t.cells[0].text, 'Requirement Item');
      assert.equal(t.cells[0].row, 0);
      assert.equal(t.cells[0].col, 0);
    });

    it('doc_format_text: applies styling properties', async () => {
      const { server, backend } = await setupServer();
      const res = await call(server, 'doc_format_text', {
        documentId: 'doc_formatted_001',
        startIndex: 132,
        endIndex: 153,
        textStyle: { bold: true, underline: true },
        writeMode: 'SUGGEST',
      });

      assert.equal(res.status, 'ok');
      assert.deepEqual(res.appliedStyle, { bold: true, underline: true });

      assert.equal(backend.batchCalls.length, 1);
      const callArgs = backend.batchCalls[0];
      assert.equal(callArgs.writeControl.writeMode, 'SUGGEST');
      assert.equal(callArgs.requests[0].updateTextStyle.range.startIndex, 132);
      assert.equal(callArgs.requests[0].updateTextStyle.range.endIndex, 153);
      assert.equal(callArgs.requests[0].updateTextStyle.textStyle.bold, true);
      assert.equal(callArgs.requests[0].updateTextStyle.textStyle.underline, true);
    });

    it('doc_suggest_edit_range: supports inline formatting with textStyle', async () => {
      const { server, backend } = await setupServer();
      const res = await call(server, 'doc_suggest_edit_range', {
        documentId: 'doc_formatted_001',
        startIndex: 107,
        endIndex: 125,
        suggestedText: 'Extended Feature Scope',
        textStyle: { bold: true },
      });

      assert.equal(res.status, 'ok');

      assert.equal(backend.batchCalls.length, 1);
      const reqs = backend.batchCalls[0].requests;
      // Should have insertText, updateTextStyle (bold: true), deleteContentRange
      assert.equal(reqs[0].insertText.text, 'Extended Feature Scope');
      assert.equal(reqs[1].updateTextStyle.textStyle.bold, true);
      assert.equal(reqs[2].deleteContentRange.range.startIndex, 107);
    });

    it('doc_insert_table: submits table insertion request in EDIT mode', async () => {
      const { server, backend } = await setupServer();
      const res = await call(server, 'doc_insert_table', {
        documentId: 'doc_formatted_001',
        index: 30,
        rows: 3,
        columns: 3,
      });

      assert.equal(res.status, 'ok');
      assert.equal(backend.batchCalls.length, 1);
      const callArgs = backend.batchCalls[0];
      assert.equal(callArgs.writeControl.writeMode, 'EDIT');
      assert.deepEqual(callArgs.requests[0], {
        insertTable: { rows: 3, columns: 3, location: { index: 30 } },
      });
    });

    it('doc_modify_table: submits table row/column operations', async () => {
      const { server, backend } = await setupServer();
      const res = await call(server, 'doc_modify_table', {
        documentId: 'doc_formatted_001',
        tableStartIndex: 60,
        action: 'INSERT_ROW_BELOW',
        rowIndex: 1,
        columnIndex: 0,
      });

      assert.equal(res.status, 'ok');
      assert.equal(backend.batchCalls.length, 1);
      assert.deepEqual(backend.batchCalls[0].requests[0], {
        insertTableRow: {
          insertBelow: true,
          tableCellLocation: {
            tableStartLocation: { index: 60 },
            rowIndex: 1,
            columnIndex: 0,
          },
        },
      });
    });

    it('doc_insert_image: submits inline image insertion request', async () => {
      const { server, backend } = await setupServer();
      const res = await call(server, 'doc_insert_image', {
        documentId: 'doc_formatted_001',
        index: 30,
        imageUri: 'https://example.com/system-diagram.png',
        widthPt: 350,
        heightPt: 200,
      });

      assert.equal(res.status, 'ok');
      assert.equal(backend.batchCalls.length, 1);
      assert.deepEqual(backend.batchCalls[0].requests[0], {
        insertInlineImage: {
          uri: 'https://example.com/system-diagram.png',
          location: { index: 30 },
          objectSize: {
            width: { magnitude: 350, unit: 'PT' },
            height: { magnitude: 200, unit: 'PT' },
          },
        },
      });
    });
  });
});
