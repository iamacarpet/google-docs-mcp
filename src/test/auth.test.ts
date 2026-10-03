import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientSecret, getScopes, tokenPath } from '../auth.js';

describe('auth', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.DOCS_MCP_CLIENT_ID;
    delete process.env.DOCS_MCP_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_CREDENTIALS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves client credentials from GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET', () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id-123.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret-xyz';

    const secret = resolveClientSecret();
    assert.ok(secret);
    assert.equal(secret.client_id, 'test-client-id-123.apps.googleusercontent.com');
    assert.equal(secret.client_secret, 'test-secret-xyz');
    assert.equal(secret.source, 'env');
  });

  it('resolves client credentials from DOCS_MCP_CLIENT_ID alias', () => {
    process.env.DOCS_MCP_CLIENT_ID = 'alias-id.apps.googleusercontent.com';
    process.env.DOCS_MCP_CLIENT_SECRET = 'alias-secret';

    const secret = resolveClientSecret();
    assert.ok(secret);
    assert.equal(secret.client_id, 'alias-id.apps.googleusercontent.com');
    assert.equal(secret.client_secret, 'alias-secret');
    assert.equal(secret.source, 'env');
  });

  it('returns null when no environment variables or file exist', () => {
    process.env.GOOGLE_OAUTH_CREDENTIALS = '/non/existent/path/credentials.json';
    const secret = resolveClientSecret();
    assert.equal(secret, null);
  });

  it('returns default documents and drive.file scopes', () => {
    const scopes = getScopes();
    assert.ok(scopes.includes('https://www.googleapis.com/auth/documents'));
    assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'));
  });

  it('resolves custom token path if set in environment', () => {
    process.env.DOCS_MCP_TOKEN_PATH = '/custom/path/token.json';
    assert.equal(tokenPath(), '/custom/path/token.json');
  });
});
