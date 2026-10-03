#!/usr/bin/env node
/**
 * Main entry point for the Google Docs Suggestion & Comment MCP Server.
 * Runs on stdio transport for integration with MCP clients (Antigravity, Claude, etc.).
 *
 * NOTE: stdout is exclusively reserved for JSON-RPC MCP messages.
 * All diagnostic messages, banners, and errors MUST be written to process.stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAuthClient } from './auth.js';
import { DocCache, GoogleDocsBackend } from './docsClient.js';
import { registerPrompts, SERVER_INSTRUCTIONS } from './prompts.js';
import { registerTools } from './tools.js';

const VERSION = '0.1.0';

function printHelp(): void {
  process.stderr.write(`
docs-mcp v${VERSION}
Model Context Protocol (MCP) server for Google Docs with native comment,
anchor, and suggestion-mode support.

Usage:
  docs-mcp [options]

Options:
  -h, --help       Show this help message and exit
  -v, --version    Show version number and exit

Environment Variables:
  GOOGLE_OAUTH_CREDENTIALS     Path to OAuth 2.0 client secret JSON (desktop app)
  DOCS_MCP_TOKEN_PATH          Path to stored OAuth token JSON
  DOCS_MCP_CACHE_TTL_MS        In-memory cache validation TTL in ms (default: 30000)
  DOCS_MCP_CACHE_MAX_ENTRIES   Max number of documents in cache (default: 20)
  DOCS_MCP_REQUIRE_REVISION    Enforce revision checks on mutation (default: true)
  DOCS_MCP_SCOPES              Space-separated OAuth scopes to request

Authentication Setup:
  Run \`npm run auth\` once to generate token.json from your OAuth credentials.
  Alternatively, configure Google Cloud Application Default Credentials (ADC).
\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }
  if (args.includes('-v') || args.includes('--version')) {
    process.stderr.write(`docs-mcp v${VERSION}\n`);
    process.exit(0);
  }

  const ttlMs = parseInt(process.env.DOCS_MCP_CACHE_TTL_MS || '30000', 10);
  const maxEntries = parseInt(process.env.DOCS_MCP_CACHE_MAX_ENTRIES || '20', 10);
  const requireRevision = process.env.DOCS_MCP_REQUIRE_REVISION !== 'false';

  process.stderr.write(`[docs-mcp] Initializing Google Docs MCP Server v${VERSION}...\n`);

  let authClient;
  try {
    authClient = await createAuthClient();
  } catch (err) {
    process.stderr.write(`[docs-mcp] Authentication setup error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const backend = new GoogleDocsBackend(authClient);
  const cache = new DocCache(backend, { ttlMs, maxEntries });

  const server = new McpServer(
    {
      name: 'docs-mcp',
      version: VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerPrompts(server);
  registerTools(server, {
    cache,
    backend,
    requireRevision,
  });

  const transport = new StdioServerTransport();

  const shutdown = async () => {
    process.stderr.write('[docs-mcp] Shutting down...\n');
    try {
      await server.close();
    } catch {
      /* ignore close errors */
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
  process.stderr.write('[docs-mcp] Server running on stdio transport.\n');
}

main().catch((err) => {
  process.stderr.write(`[docs-mcp] Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
