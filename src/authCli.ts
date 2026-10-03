#!/usr/bin/env node
/**
 * Interactive OAuth authorization (loopback flow). Run once: `npm run auth`.
 * Requires an OAuth client of type "Desktop app" saved at
 * $GOOGLE_OAUTH_CREDENTIALS or ~/.config/docs-mcp/credentials.json.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { auth } from '@googleapis/docs';
import { credentialsPath, getScopes, loadClientSecret, saveToken, tokenPath } from './auth.js';

function tryOpenBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* user can open the URL manually */
  }
}

async function main(): Promise<void> {
  const secret = loadClientSecret(credentialsPath());
  const scopes = getScopes();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = new auth.OAuth2(secret.client_id, secret.client_secret, redirectUri);

  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes });
  console.log(`\nAuthorize docs-mcp by opening this URL in your browser:\n\n${url}\n`);
  tryOpenBrowser(url);

  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      const err = u.searchParams.get('error');
      const c = u.searchParams.get('code');
      if (!c && !err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(err ? `<h3>Authorization failed: ${err}</h3>` : '<h3>docs-mcp authorized. You can close this tab.</h3>');
      if (err) reject(new Error(`Authorization failed: ${err}`));
      else resolve(c!);
    });
  });
  server.close();

  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  if (!tokens.refresh_token) {
    console.warn('Warning: no refresh_token returned; you may need to re-run auth when the access token expires.');
  }
  saveToken(tokens);
  console.log(`Token saved to ${tokenPath()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
