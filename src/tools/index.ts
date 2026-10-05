/**
 * Tool registration entry point for Google Docs MCP.
 * Delegates to modular domain tool modules:
 * - discovery: doc_get_metadata, doc_get_outline, doc_get_changes_summary, doc_search_text, doc_list_suggestions
 * - reading: doc_read_document, doc_read_range, doc_read_comment_context, doc_inspect_tables, doc_read_table, doc_read_table_cell
 * - comments: doc_list_comments, doc_suggest_comment_revision, doc_add_comment, doc_reply_comment, doc_delete_comment, doc_batch_manage_comments, doc_batch_add_comments
 * - edits: doc_suggest_deletion, doc_suggest_edit_range, doc_apply_direct_edit, doc_suggest_redline_edit, doc_batch_suggest_edits, doc_batch_manage_suggestions, doc_suggest_replace_all, doc_raw_batch_update, doc_create_document, doc_manage_suggestion
 * - formatting: doc_format_text, doc_format_paragraph, doc_insert_table, doc_modify_table, doc_insert_table_row, doc_insert_image, doc_append_to_table_cell
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './common.js';
import { registerDiscoveryTools } from './discovery.js';
import { registerReadingTools } from './reading.js';
import { registerCommentsTools } from './comments.js';
import { registerEditTools } from './edits.js';
import { registerFormattingTools } from './formatting.js';

export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerDiscoveryTools(server, ctx);
  registerReadingTools(server, ctx);
  registerCommentsTools(server, ctx);
  registerEditTools(server, ctx);
  registerFormattingTools(server, ctx);
}

export * from './common.js';
export * from './discovery.js';
export * from './reading.js';
export * from './comments.js';
export * from './edits.js';
export * from './formatting.js';
