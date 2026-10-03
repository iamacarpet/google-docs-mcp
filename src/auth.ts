/**
 * Authentication management.
 *
 * Supports:
 *   1. Environment variables (standard in MCP server ecosystems):
 *      GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
 *      (or DOCS_MCP_CLIENT_ID / DOCS_MCP_CLIENT_SECRET).
 *   2. OAuth 2.0 client secret file:
 *      $GOOGLE_OAUTH_CREDENTIALS or ~/.config/docs-mcp/credentials.json.
 *   3. Semi-interactive browser loopback authorization:
 *      When credentials are present but no cached token exists, the server
 *      automatically starts a local loopback server, launches the user's
 *      browser to grant consent, saves the token with 0600 permissions,
 *      and resumes seamlessly.
 *   4. Persistent automatic token refresh:
 *      Whenever an access token expires, Google Auth automatically exchanges
 *      the refresh_token and persists the new tokens back to disk.
 *   5. Google Application Default Credentials (ADC) as a zero-config fallback.
 *
 * NOTE: The MCP stdio transport owns stdout! Everything logged here MUST go to
 * process.stderr.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { auth } from '@googleapis/docs';

export const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
];

export type OAuth2Client = InstanceType<typeof auth.OAuth2>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAuthClient = any;

const CONFIG_DIR = join(homedir(), '.config', 'docs-mcp');

export function getScopes(): string[] {
  const env = process.env.DOCS_MCP_SCOPES;
  return env ? env.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES;
}

export function credentialsPath(): string {
  return process.env.GOOGLE_OAUTH_CREDENTIALS ?? join(CONFIG_DIR, 'credentials.json');
}

export function tokenPath(): string {
  return process.env.DOCS_MCP_TOKEN_PATH ?? join(CONFIG_DIR, 'token.json');
}

export interface ClientSecret {
  client_id: string;
  client_secret: string;
  source: 'env' | 'file';
}

/** Resolves client credentials from environment variables or credentials file. */
export function resolveClientSecret(): ClientSecret | null {
  // 1. Environment variables (highest priority)
  const envId = process.env.GOOGLE_CLIENT_ID || process.env.DOCS_MCP_CLIENT_ID || process.env.CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.DOCS_MCP_CLIENT_SECRET || process.env.CLIENT_SECRET;
  if (envId && envSecret) {
    return {
      client_id: envId.trim(),
      client_secret: envSecret.trim(),
      source: 'env',
    };
  }

  // 2. Credentials file
  const credPath = credentialsPath();
  if (existsSync(credPath)) {
    try {
      const json = JSON.parse(readFileSync(credPath, 'utf8'));
      const secret = json.installed ?? json.web ?? json;
      if (secret.client_id && secret.client_secret) {
        return {
          client_id: secret.client_id,
          client_secret: secret.client_secret,
          source: 'file',
        };
      }
    } catch {
      /* ignore parse error here and proceed to fallback */
    }
  }

  return null;
}

export function loadClientSecret(path = credentialsPath()): ClientSecret {
  const secret = resolveClientSecret();
  if (secret) return secret;
  throw new Error(
    `No OAuth client credentials found. Either set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables, ` +
      `or place a Google Cloud OAuth client JSON at ${path}.`,
  );
}

export function saveToken(tokens: object, path = tokenPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

export function tryOpenBrowser(url: string): boolean {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Executes the semi-interactive OAuth loopback authorization flow.
 * Starts a local HTTP server on 127.0.0.1:<random-port>, launches the user's
 * browser to grant consent, captures the authorization code, exchanges it
 * for tokens, and persists the token to tokenPath().
 */
export async function authorizeLoopback(
  secret: ClientSecret,
  scopes = getScopes(),
  tPath = tokenPath(),
): Promise<OAuth2Client> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = new auth.OAuth2(secret.client_id, secret.client_secret, redirectUri);

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });

  process.stderr.write(
    `\n[docs-mcp] ==================== GOOGLE DOCS AUTHORIZATION ====================\n` +
      `[docs-mcp] No cached token found. Opening browser for one-time authorization:\n` +
      `[docs-mcp]   ${authUrl}\n` +
      `[docs-mcp] If the browser did not open automatically, visit the URL above.\n` +
      `[docs-mcp] ====================================================================\n\n`,
  );

  tryOpenBrowser(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    // 3 minute timeout for interactive login
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAuth authorization timed out after 3 minutes. Please re-run to authenticate.'));
    }, 180000);

    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      const err = u.searchParams.get('error');
      const c = u.searchParams.get('code');
      if (!c && !err) {
        res.writeHead(404).end();
        return;
      }
      clearTimeout(timer);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>docs-mcp Authorized</title></head>
        <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc;">
          <div style="background: #1e293b; padding: 2.5rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 480px;">
            ${
              err
                ? `<h2 style="color: #ef4444; margin-top: 0;">Authorization Failed</h2><p style="color: #94a3b8;">${err}</p>`
                : `<h2 style="color: #10b981; margin-top: 0;">✓ Authorization Successful!</h2>
                   <p style="color: #cbd5e1; margin-bottom: 1.5rem;">Google Docs Suggestion & Comment MCP Server is now authorized.</p>
                   <p style="color: #94a3b8; font-size: 0.9rem;">You can safely close this browser tab and return to your AI assistant.</p>`
            }
          </div>
        </body>
        </html>
      `);
      if (err) reject(new Error(`Authorization failed: ${err}`));
      else resolve(c!);
    });
  });

  server.close();

  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  if (!tokens.refresh_token) {
    process.stderr.write(
      '[docs-mcp] Warning: no refresh_token was returned by Google; re-authentication may be needed when the access token expires.\n',
    );
  }

  saveToken(tokens, tPath);
  process.stderr.write(`[docs-mcp] Authorization successful! Token saved to ${tPath}\n`);

  client.setCredentials(tokens);
  attachTokenRefreshListener(client, tPath);
  return client;
}

function attachTokenRefreshListener(client: OAuth2Client, tPath: string): void {
  client.on('tokens', (tokens) => {
    try {
      const current = existsSync(tPath) ? JSON.parse(readFileSync(tPath, 'utf8')) : {};
      saveToken({ ...current, ...tokens }, tPath);
      process.stderr.write('[docs-mcp] Persisted refreshed OAuth token to disk.\n');
    } catch (e) {
      process.stderr.write(`[docs-mcp] Failed to persist refreshed token: ${String(e)}\n`);
    }
  });
}

/**
 * Creates an authenticated client.
 *
 * Resolution Order:
 *  1. Checks for OAuth credentials (from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET or credentials file).
 *  2. If credentials exist:
 *     - If token.json exists, loads and returns client with auto-refresh listener.
 *     - If token.json is missing, triggers the semi-interactive loopback flow automatically.
 *  3. Falls back to Google Application Default Credentials (ADC).
 */
export async function createAuthClient(): Promise<AnyAuthClient> {
  const secret = resolveClientSecret();
  const tPath = tokenPath();

  if (secret) {
    if (existsSync(tPath)) {
      try {
        const stored = JSON.parse(readFileSync(tPath, 'utf8'));
        if (stored.access_token || stored.refresh_token) {
          const client: OAuth2Client = new auth.OAuth2(secret.client_id, secret.client_secret);
          client.setCredentials(stored);
          attachTokenRefreshListener(client, tPath);
          return client;
        }
      } catch (err) {
        process.stderr.write(`[docs-mcp] Cached token at ${tPath} was unreadable; re-authenticating...\n`);
      }
    }

    // Semi-interactive flow: trigger browser authorization automatically
    if (process.env.DOCS_MCP_NO_INTERACTIVE === 'true') {
      throw new Error(
        `OAuth credentials provided (via ${secret.source}) but no token exists at ${tPath}, and DOCS_MCP_NO_INTERACTIVE is set. ` +
          `Run \`npm run auth\` once to generate token.json.`,
      );
    }

    return await authorizeLoopback(secret, getScopes(), tPath);
  }

  // Fallback: Application Default Credentials (ADC)
  try {
    const google = new auth.GoogleAuth({ scopes: getScopes() });
    return await google.getClient();
  } catch (e) {
    throw new Error(
      `No Google credentials found.\n` +
        `Provide OAuth credentials via:\n` +
        `  - Environment variables: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET\n` +
        `  - Credentials file: ~/.config/docs-mcp/credentials.json\n` +
        `  - Or configure Application Default Credentials (gcloud auth application-default login)\n` +
        `Underlying error: ${(e as Error).message}`,
    );
  }
}
