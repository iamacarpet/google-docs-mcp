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
    return {
      documentId,
      writeControl: {
        requiredRevisionId: newRev,
      },
      replies: requests.map((_r) => ({})),
      suggestionResponses: [
        {
          createdSuggestionIds: ['sug_new_1'],
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
});
