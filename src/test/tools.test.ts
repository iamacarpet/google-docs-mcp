import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { docs_v1 } from '@googleapis/docs';
import { registerTools, type ToolContext } from '../tools.js';
import { DocCache, type DocsBackend, type FullFetch } from '../docsClient.js';
import { createSampleDocument } from './fixtures.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

class MockDocsBackend implements DocsBackend {
  public batchCalls: {
    documentId: string;
    requests: any[];
    writeControl?: docs_v1.Schema$WriteControl;
  }[] = [];

  public rawDoc: any;
  public commentsAvailable = true;

  constructor() {
    this.rawDoc = createSampleDocument();
  }

  async createDocument(title: string): Promise<docs_v1.Schema$Document> {
    return {
      documentId: 'new_created_doc_123',
      title,
      revisionId: 'rev_created_1',
    };
  }

  async getRevisionId(_documentId: string): Promise<string | undefined> {
    return this.rawDoc.revisionId;
  }

  async fetchFull(_documentId: string): Promise<FullFetch> {
    return {
      raw: this.rawDoc,
      commentsAvailable: this.commentsAvailable,
    };
  }

  async batchUpdate(
    documentId: string,
    requests: any[],
    writeControl?: docs_v1.Schema$WriteControl,
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    this.batchCalls.push({ documentId, requests, writeControl });
    const newRev = `rev_updated_${Date.now()}`;
    this.rawDoc.revisionId = newRev;
    const acceptedSuggestionIds = requests.filter((r) => r.acceptSuggestion).map((r) => r.acceptSuggestion.suggestionId);
    const rejectedSuggestionIds = requests.filter((r) => r.rejectSuggestion).map((r) => r.rejectSuggestion.suggestionId);
    return {
      documentId,
      writeControl: {
        requiredRevisionId: newRev,
      },
      replies: requests.map((_r) => ({})),
      suggestionResponses: [
        {
          createdSuggestionIds: ['sug_new_1'],
          ...(acceptedSuggestionIds.length ? { acceptedSuggestionIds } : {}),
          ...(rejectedSuggestionIds.length ? { rejectedSuggestionIds } : {}),
        },
      ],
      commentUpdateState: 'ALL_SAVED',
    };
  }
}

describe('MCP Tools', () => {
  let backend: MockDocsBackend;
  let cache: DocCache;
  let server: McpServer;
  let ctx: ToolContext;

  beforeEach(() => {
    backend = new MockDocsBackend();
    cache = new DocCache(backend, { ttlMs: 30000, maxEntries: 10 });
    ctx = {
      cache,
      backend,
      requireRevision: true,
    };
    server = new McpServer({ name: 'test-docs-mcp', version: '0.1.0' });
    registerTools(server, ctx);
  });

  async function callTool(name: string, args: Record<string, any>): Promise<any> {
    const reg = (server as any)._registeredTools?.[name];
    if (!reg) throw new Error(`Tool ${name} not registered`);
    const res = await reg.handler(args, {});
    assert.ok(res.content && res.content.length > 0);
    if (res.isError) {
      throw new Error(`Tool returned error: ${res.content[0].text}`);
    }
    return JSON.parse(res.content[0].text);
  }

  it('doc_get_metadata: returns document overview without dumping text', async () => {
    const res = await callTool('doc_get_metadata', { documentId: 'doc_test_123' });
    assert.equal(res.documentId, 'doc_test_123');
    assert.equal(res.title, 'Editorial Test Document');
    assert.equal(res.comments.total, 1);
    assert.equal(res.comments.open, 1);
    assert.equal(res.suggestionCount, 1);
  });

  it('doc_get_outline: returns headings and pseudo-headings with coordinates', async () => {
    const res = await callTool('doc_get_outline', { documentId: 'doc_test_123' });
    assert.equal(res.outline.length, 2);
    assert.equal(res.outline[0].title, 'Introduction to Editorial');
    assert.equal(res.outline[0].isPseudo, false);
    assert.equal(res.outline[1].title, 'Key Action Items');
    assert.equal(res.outline[1].isPseudo, true);
  });

  it('doc_list_comments: lists open comments with authors and anchors', async () => {
    const res = await callTool('doc_list_comments', { documentId: 'doc_test_123', status: 'OPEN' });
    assert.equal(res.comments.length, 1);
    const c = res.comments[0];
    assert.equal(c.commentId, 'c.123456');
    assert.equal(c.author, 'Alice Smith');
    assert.equal(c.anchorText, 'we must move rapidly');
    assert.equal(c.startIndex, 69);
    assert.equal(c.endIndex, 89);
  });

  it('doc_search_text: finds text matches and returns surrounding context preview', async () => {
    const res = await callTool('doc_search_text', { documentId: 'doc_test_123', query: 'enterprise' });
    assert.equal(res.totalMatches, 1);
    const m = res.matches[0];
    assert.equal(m.startIndex, 47);
    assert.equal(m.endIndex, 57);
    assert.ok(m.preview.includes('<match>enterprise</match>'));
  });

  it('doc_read_comment_context: returns targeted paragraph with <target> tags', async () => {
    const res = await callTool('doc_read_comment_context', {
      documentId: 'doc_test_123',
      commentId: 'c.123456',
    });
    assert.equal(res.commentId, 'c.123456');
    assert.equal(res.anchor.startIndex, 69);
    assert.equal(res.anchor.endIndex, 89);
    assert.equal(res.anchor.text, 'we must move rapidly');
    assert.ok(res.context.snippet.includes('<target>we must move rapidly</target>'));
  });

  it('doc_read_range: reads exact text slice without re-basing indices', async () => {
    const res = await callTool('doc_read_range', {
      documentId: 'doc_test_123',
      startIndex: 1,
      endIndex: 27,
    });
    assert.equal(res.startIndex, 1);
    assert.equal(res.endIndex, 27);
    assert.equal(res.text, 'Introduction to Editorial\n');
  });

  it('doc_suggest_comment_revision: atomically creates suggestion and resolves comment', async () => {
    const res = await callTool('doc_suggest_comment_revision', {
      documentId: 'doc_test_123',
      commentId: 'c.123456',
      suggestedText: 'accelerate execution',
      resolveComment: true,
      replyMessage: 'Proposed revision for review.',
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.mode, 'SUGGEST');
    assert.equal(res.commentResolved, true);

    // Verify batchUpdate sent to Google Docs backend
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];
    assert.equal(call.writeControl?.writeMode, 'SUGGEST');
    assert.equal(call.writeControl?.requiredRevisionId, 'rev_initial_001');

    // Should contain: insertText (at 89), deleteContentRange (69..89), and addCommentReply (resolve)
    assert.equal(call.requests.length, 3);
    assert.deepEqual(call.requests[0], {
      insertText: {
        location: { index: 89 },
        text: 'accelerate execution',
      },
    });
    assert.deepEqual(call.requests[1], {
      deleteContentRange: {
        range: { startIndex: 69, endIndex: 89 },
      },
    });
    assert.deepEqual(call.requests[2], {
      addCommentReply: {
        commentId: 'c.123456',
        post: {
          content: 'Proposed revision for review.',
          commentAction: 'RESOLVE',
        },
      },
    });
  });

  it('doc_suggest_edit_range: submits suggested edit in SUGGEST mode', async () => {
    const res = await callTool('doc_suggest_edit_range', {
      documentId: 'doc_test_123',
      startIndex: 69,
      endIndex: 89,
      suggestedText: 'move quickly',
      expectedText: 'we must move rapidly',
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.mode, 'SUGGEST');
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];
    assert.equal(call.writeControl?.writeMode, 'SUGGEST');
  });

  it('doc_apply_direct_edit: submits direct edit in EDIT mode', async () => {
    const res = await callTool('doc_apply_direct_edit', {
      documentId: 'doc_test_123',
      startIndex: 69,
      endIndex: 89,
      newText: 'move decisively',
      expectedText: 'we must move rapidly',
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.mode, 'EDIT');
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];
    assert.equal(call.writeControl?.writeMode, 'EDIT');
  });

  it('doc_batch_suggest_edits: applies multi-edits in bottom-to-top order', async () => {
    const res = await callTool('doc_batch_suggest_edits', {
      documentId: 'doc_test_123',
      edits: [
        {
          startIndex: 27,
          endIndex: 35,
          suggestedText: 'To',
          expectedText: 'In order',
        },
        {
          commentId: 'c.123456',
          suggestedText: 'accelerate execution',
        },
      ],
      resolveComments: true,
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.mode, 'SUGGEST');
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];

    // Edits must be sorted bottom-to-top (index 89/69 before index 35/27)
    assert.equal(call.requests[0].insertText.location.index, 89);
    assert.equal(call.requests[1].deleteContentRange.range.startIndex, 69);
    assert.equal(call.requests[2].insertText.location.index, 35);
    assert.equal(call.requests[3].deleteContentRange.range.startIndex, 27);
    // Comment resolve reply
    assert.ok(call.requests[4].addCommentReply);
  });

  it('doc_add_comment: adds anchored comment', async () => {
    const res = await callTool('doc_add_comment', {
      documentId: 'doc_test_123',
      startIndex: 1,
      endIndex: 27,
      commentText: 'Check heading style.',
      expectedText: 'Introduction to Editorial\n',
    });

    assert.equal(res.status, 'ok');
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];
    assert.deepEqual(call.requests[0], {
      insertComment: {
        range: { startIndex: 1, endIndex: 27 },
        content: 'Check heading style.',
      },
    });
  });

  it('doc_reply_comment: posts reply to comment thread', async () => {
    const res = await callTool('doc_reply_comment', {
      documentId: 'doc_test_123',
      commentId: 'c.123456',
      replyText: 'Working on this revision now.',
    });

    assert.equal(res.status, 'ok');
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];
    assert.deepEqual(call.requests[0], {
      addCommentReply: {
        commentId: 'c.123456',
        post: {
          content: 'Working on this revision now.',
        },
      },
    });
  });

  it('doc_delete_comment: deletes comment thread', async () => {
    const res = await callTool('doc_delete_comment', {
      documentId: 'doc_test_123',
      commentId: 'c.123456',
    });

    assert.equal(res.status, 'ok');
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];
    assert.deepEqual(call.requests[0], {
      deleteComment: {
        commentId: 'c.123456',
      },
    });
  });

  it('doc_manage_suggestion: accepts or rejects suggestions', async () => {
    const resAccept = await callTool('doc_manage_suggestion', {
      documentId: 'doc_test_123',
      suggestionId: 'sug_ins_1',
      action: 'ACCEPT',
    });
    assert.equal(resAccept.status, 'ok');
    assert.equal(backend.batchCalls[0].requests[0].acceptSuggestion.suggestionId, 'sug_ins_1');

    const resReject = await callTool('doc_manage_suggestion', {
      documentId: 'doc_test_123',
      suggestionId: 'sug_ins_1',
      action: 'REJECT',
    });
    assert.equal(resReject.status, 'ok');
    assert.equal(backend.batchCalls[1].requests[0].rejectSuggestion.suggestionId, 'sug_ins_1');
  });

  it('doc_suggest_deletion: creates native tracked deletion suggestion', async () => {
    const res = await callTool('doc_suggest_deletion', {
      documentId: 'doc_test_123',
      startIndex: 69,
      endIndex: 89,
      expectedText: 'we must move rapidly',
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.mode, 'SUGGEST');
    assert.equal(res.newText, '');
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];
    assert.equal(call.writeControl?.writeMode, 'SUGGEST');
    assert.deepEqual(call.requests[0], {
      deleteContentRange: {
        range: { startIndex: 69, endIndex: 89 },
      },
    });
  });

  it('doc_read_range: defaults markSuggestions to true and reports pendingSuggestions metadata', async () => {
    const res = await callTool('doc_read_range', {
      documentId: 'doc_test_123',
      startIndex: 136,
      endIndex: 193,
    });

    assert.equal(res.startIndex, 136);
    assert.equal(res.endIndex, 193);
    assert.equal(res.hasPendingSuggestions, true);
    assert.ok(Array.isArray(res.pendingSuggestions));
    assert.equal(res.pendingSuggestions.length, 1);
    assert.equal(res.pendingSuggestions[0].suggestionId, 'sug_ins_1');
    assert.equal(res.pendingSuggestions[0].kind, 'insertion');
    assert.equal(res.pendingSuggestions[0].startIndex, 148);
    assert.equal(res.pendingSuggestions[0].endIndex, 155);
    // Diff markers should be present by default
    assert.ok(res.text.includes('{+public +}'));
    assert.ok(res.annotatedText.includes('{+public +}'));
  });

  it('doc_format_text: returns guidance note when strikethrough alone is applied in SUGGEST mode', async () => {
    const res = await callTool('doc_format_text', {
      documentId: 'doc_test_123',
      startIndex: 69,
      endIndex: 89,
      strikethrough: true,
      writeMode: 'SUGGEST',
    });

    assert.equal(res.status, 'ok');
    assert.ok(res.notes && res.notes.length > 0);
    assert.ok(res.notes[0].includes('formats the text with a strikethrough font and retains it'));
  });

  it('doc_format_text: acknowledges bold strikethrough for formal amendments in SUGGEST mode', async () => {
    const res = await callTool('doc_format_text', {
      documentId: 'doc_test_123',
      startIndex: 69,
      endIndex: 89,
      bold: true,
      strikethrough: true,
      writeMode: 'SUGGEST',
    });

    assert.equal(res.status, 'ok');
    assert.ok(res.notes && res.notes.length > 0);
    assert.ok(res.notes[0].includes('Applied bold strikethrough styling as a suggestion'));
  });

  it('style-guide amendment pattern: supports inserting new text first as bold and retaining original wording as bold strikethrough second', async () => {
    // Step 1: Insert replacement text as bold at boundary FIRST (with strikethrough: false)
    const resInsert = await callTool('doc_suggest_edit_range', {
      documentId: 'doc_test_123',
      startIndex: 89,
      endIndex: 89,
      suggestedText: ' advance expeditiously',
      textStyle: { bold: true, strikethrough: false },
    });
    assert.equal(resInsert.status, 'ok');
    assert.equal(backend.batchCalls[0].writeControl?.writeMode, 'SUGGEST');
    assert.equal(backend.batchCalls[0].requests[0].insertText.text, ' advance expeditiously');
    assert.equal(backend.batchCalls[0].requests[1].updateTextStyle.textStyle.bold, true);
    assert.equal(backend.batchCalls[0].requests[1].updateTextStyle.textStyle.strikethrough, false);

    // Step 2: Format original text as bold strikethrough SECOND
    const resFormat = await callTool('doc_format_text', {
      documentId: 'doc_test_123',
      startIndex: 69,
      endIndex: 89,
      bold: true,
      strikethrough: true,
      writeMode: 'SUGGEST',
    });
    assert.equal(resFormat.status, 'ok');
    assert.equal(backend.batchCalls[1].writeControl?.writeMode, 'SUGGEST');
    assert.equal(backend.batchCalls[1].requests[0].updateTextStyle.textStyle.bold, true);
    assert.equal(backend.batchCalls[1].requests[0].updateTextStyle.textStyle.strikethrough, true);
  });

  it('doc_read_document: reads full document in markdown format by default', async () => {
    const res = await callTool('doc_read_document', {
      documentId: 'doc_test_123',
    });

    assert.equal(res.documentId, 'doc_test_123');
    assert.ok(res.title);
    assert.ok(res.text && res.text.length > 0);
    assert.ok(res.annotatedText && res.annotatedText.length > 0);
    assert.ok(Array.isArray(res.outline));
    assert.equal(res.startIndex, 1);
    assert.ok(res.endIndex > 1);
  });

  it('doc_read_document: returns raw JSON when format: raw_json', async () => {
    const res = await callTool('doc_read_document', {
      documentId: 'doc_test_123',
      format: 'raw_json',
    });

    assert.equal(res.documentId, 'doc_test_123');
    assert.ok(res.rawDocument);
    assert.equal(res.rawDocument.documentId, 'doc_test_123');
  });

  it('doc_read_range: reads full tab when startIndex and endIndex are omitted', async () => {
    const res = await callTool('doc_read_range', {
      documentId: 'doc_test_123',
    });

    assert.equal(res.startIndex, 1);
    assert.ok(res.endIndex > 1);
    assert.ok(res.text && res.text.length > 0);
  });

  it('expectedText resilience: normalizes unicode quotes and whitespace', async () => {
    // In sample document, indices 69-89 is "we must move rapidly"
    // Test that unicode non-breaking space \u00A0 or curly quotes matches standard text
    const res = await callTool('doc_suggest_edit_range', {
      documentId: 'doc_test_123',
      startIndex: 69,
      endIndex: 89,
      expectedText: 'we\u00A0must move rapidly', // contains non-breaking space
      suggestedText: 'continue promptly',
    });
    assert.equal(res.status, 'ok');
  });

  it('doc_suggest_redline_edit: inserts new text first and styles retained text second', async () => {
    const res = await callTool('doc_suggest_redline_edit', {
      documentId: 'doc_test_123',
      startIndex: 69,
      endIndex: 89,
      replacementText: 'continue promptly',
      expectedText: 'we must move rapidly',
    });

    assert.equal(res.status, 'ok');
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];
    assert.equal(call.writeControl?.writeMode, 'SUGGEST');
    // First request: insert replacement text at endIndex
    assert.equal(call.requests[0].insertText.location.index, 89);
    assert.equal(call.requests[0].insertText.text, 'continue promptly');
    // Second request: format replacement text with bold: true, strikethrough: false
    assert.equal(call.requests[1].updateTextStyle.textStyle.bold, true);
    assert.equal(call.requests[1].updateTextStyle.textStyle.strikethrough, false);
    // Third request: format retained text with bold: true, strikethrough: true
    assert.equal(call.requests[2].updateTextStyle.range.startIndex, 69);
    assert.equal(call.requests[2].updateTextStyle.range.endIndex, 89);
    assert.equal(call.requests[2].updateTextStyle.textStyle.bold, true);
    assert.equal(call.requests[2].updateTextStyle.textStyle.strikethrough, true);
  });

  it('doc_batch_suggest_edits: supports redline items mixed with standard edits', async () => {
    const res = await callTool('doc_batch_suggest_edits', {
      documentId: 'doc_test_123',
      edits: [
        {
          startIndex: 69,
          endIndex: 89,
          suggestedText: 'continue promptly',
          redline: true,
        },
      ],
    });

    assert.equal(res.status, 'ok');
    assert.equal(backend.batchCalls.length, 1);
    const call = backend.batchCalls[0];
    assert.equal(call.writeControl?.writeMode, 'SUGGEST');
    // Request contains redline insertion + styling
    assert.ok(call.requests.some((r: any) => r.insertText?.text === 'continue promptly'));
    assert.ok(call.requests.some((r: any) => r.updateTextStyle?.textStyle?.strikethrough === true));
  });

  it('doc_batch_manage_suggestions: bulk accepts or rejects suggestions', async () => {
    // Explicit list
    const resExplicit = await callTool('doc_batch_manage_suggestions', {
      documentId: 'doc_test_123',
      action: 'ACCEPT',
      suggestionIds: ['sug_1', 'sug_2'],
    });
    assert.equal(resExplicit.status, 'ok');
    assert.equal(resExplicit.action, 'ACCEPT');
    assert.deepEqual(resExplicit.suggestionIds, ['sug_1', 'sug_2']);

    // ACCEPT_ALL across document
    const resAll = await callTool('doc_batch_manage_suggestions', {
      documentId: 'doc_test_123',
      action: 'ACCEPT_ALL',
    });
    assert.equal(resAll.status, 'ok');
    assert.ok(resAll.count > 0);
  });

  it('doc_suggest_replace_all: proposes search and replace in suggestion mode', async () => {
    const res = await callTool('doc_suggest_replace_all', {
      documentId: 'doc_test_123',
      searchText: 'must',
      replacementText: 'shall',
      matchCase: false,
    });

    assert.equal(res.status, 'ok');
    assert.ok(res.matchesReplaced > 0);
    assert.equal(backend.batchCalls[backend.batchCalls.length - 1].writeControl?.writeMode, 'SUGGEST');
  });

  it('doc_raw_batch_update: executes raw Docs API requests', async () => {
    const res = await callTool('doc_raw_batch_update', {
      documentId: 'doc_test_123',
      requests: [{ insertText: { location: { index: 1 }, text: 'Hello' } }],
      writeMode: 'EDIT',
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.writeMode, 'EDIT');
    assert.equal(backend.batchCalls[backend.batchCalls.length - 1].writeControl?.writeMode, 'EDIT');
    assert.equal(backend.batchCalls[backend.batchCalls.length - 1].requests[0].insertText.text, 'Hello');
  });

  it('doc_create_document: creates new doc with title and initial text', async () => {
    const res = await callTool('doc_create_document', {
      title: 'New Research Document',
      initialText: 'Initial Content\n',
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.documentId, 'new_created_doc_123');
    assert.equal(res.title, 'New Research Document');
    assert.ok(res.url.includes('new_created_doc_123'));
  });

  it('doc_insert_table: supports populating initial cells matrix', async () => {
    const res = await callTool('doc_insert_table', {
      documentId: 'doc_test_123',
      index: 10,
      rows: 2,
      columns: 2,
      cells: [
        ['Header 1', 'Header 2'],
        ['Val 1', 'Val 2'],
      ],
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.rows, 2);
    assert.equal(res.columns, 2);
  });
});
