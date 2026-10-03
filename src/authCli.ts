#!/usr/bin/env node
/**
 * Standalone CLI command for pre-authorizing Google OAuth2: `npm run auth`.
 * Reads credentials from environment variables (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
 * or ~/.config/docs-mcp/credentials.json, opens the browser, and saves token.json.
 */

import { loadClientSecret, authorizeLoopback } from './auth.js';

async function main(): Promise<void> {
  const secret = loadClientSecret();
  await authorizeLoopback(secret);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
