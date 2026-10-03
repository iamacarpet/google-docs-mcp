/**
 * Authentication.
 *
 * Resolution order:
 *   1. OAuth 2.0 client credentials (Desktop app) — file at
 *      $GOOGLE_OAUTH_CREDENTIALS or ~/.config/docs-mcp/credentials.json,
 *      with a token produced by `npm run auth` stored at
 *      $DOCS_MCP_TOKEN_PATH or ~/.config/docs-mcp/token.json.
 *   2. Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS,
 *      `gcloud auth application-default login --scopes=...`, or a metadata server).
 *
 * NOTE: the MCP stdio transport owns stdout, so nothing here may write to stdout.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
  redirect_uris?: string[];
}

export function loadClientSecret(path = credentialsPath()): ClientSecret {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const secret = json.installed ?? json.web ?? json;
  if (!secret.client_id || !secret.client_secret) {
    throw new Error(`${path} does not look like an OAuth client secret file (missing client_id/client_secret).`);
  }
  return secret;
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

/** Creates an authenticated client, preferring OAuth user credentials, falling back to ADC. */
export async function createAuthClient(): Promise<AnyAuthClient> {
  const credPath = credentialsPath();
  if (existsSync(credPath)) {
    const secret = loadClientSecret(credPath);
    const tPath = tokenPath();
    if (!existsSync(tPath)) {
      throw new Error(
        `OAuth client found at ${credPath} but no token at ${tPath}. Run \`npm run auth\` (in the docs-mcp directory) to authorize.`,
      );
    }
    const client: OAuth2Client = new auth.OAuth2(secret.client_id, secret.client_secret);
    const stored = JSON.parse(readFileSync(tPath, 'utf8'));
    client.setCredentials(stored);
    // Persist refreshed access tokens (refresh_token is only sent once, so merge).
    client.on('tokens', (tokens) => {
      try {
        const current = existsSync(tPath) ? JSON.parse(readFileSync(tPath, 'utf8')) : {};
        saveToken({ ...current, ...tokens });
      } catch (e) {
        process.stderr.write(`[docs-mcp] failed to persist refreshed token: ${String(e)}\n`);
      }
    });
    return client;
  }

  try {
    const google = new auth.GoogleAuth({ scopes: getScopes() });
    return await google.getClient();
  } catch (e) {
    throw new Error(
      `No Google credentials available. Either place an OAuth Desktop client JSON at ${credPath} and run \`npm run auth\`, ` +
        `or configure Application Default Credentials. Underlying error: ${(e as Error).message}`,
    );
  }
}
