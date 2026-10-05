/**
 * Thin wrapper over the Docs REST API plus the in-memory document cache.
 *
 * Cache policy
 *  - Full `documents.get` happens only on a cache miss or a revision mismatch.
 *  - Within `ttlMs` of the last validation the cached model is trusted as-is.
 *  - After `ttlMs`, a cheap probe (`fields=revisionId`) decides whether to refetch.
 *  - Any successful (or failed) mutation invalidates the entry.
 */

import { docs, type docs_v1 } from '@googleapis/docs';
import { buildDocModel, type DocModel } from './docModel.js';
import type { AnyAuthClient } from './auth.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FullFetch {
  raw: docs_v1.Schema$Document;
  commentsAvailable: boolean;
  commentsUnavailableReason?: string;
}

export interface DocsBackend {
  getRevisionId(documentId: string): Promise<string | undefined>;
  fetchFull(documentId: string): Promise<FullFetch>;
  batchUpdate(
    documentId: string,
    requests: any[],
    writeControl?: docs_v1.Schema$WriteControl,
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse>;
  createDocument?(title: string): Promise<docs_v1.Schema$Document>;
}

export function httpStatus(e: unknown): number | undefined {
  const err = e as any;
  return err?.status ?? err?.response?.status ?? (typeof err?.code === 'number' ? err.code : undefined);
}

export function apiErrorMessage(e: unknown): string {
  const err = e as any;
  return err?.response?.data?.error?.message ?? err?.message ?? String(e);
}

export class GoogleDocsBackend implements DocsBackend {
  private api: docs_v1.Docs;
  /** Docs where the comments view failed (not enrolled in preview / no permission). */
  private commentsUnsupported = new Map<string, string>();

  constructor(authClient: AnyAuthClient) {
    this.api = docs({ version: 'v1', auth: authClient });
  }

  async getRevisionId(documentId: string): Promise<string | undefined> {
    const res = await this.api.documents.get({ documentId, fields: 'revisionId' });
    return res.data.revisionId ?? undefined;
  }

  async fetchFull(documentId: string): Promise<FullFetch> {
    const base = { documentId, includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE' };
    const knownReason = this.commentsUnsupported.get(documentId);
    if (!knownReason) {
      try {
        const res = await this.api.documents.get({ ...base, commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED' } as any);
        return { raw: res.data, commentsAvailable: true };
      } catch (e) {
        const status = httpStatus(e);
        if (status !== 400 && status !== 403) throw e;
        // Retry without comments; if this also fails the doc itself is inaccessible.
        const res = await this.api.documents.get(base as any);
        const reason = `comments view rejected by API (${status}: ${apiErrorMessage(e)}). Comment features require the Google Workspace Developer Preview and comment access.`;
        this.commentsUnsupported.set(documentId, reason);
        return { raw: res.data, commentsAvailable: false, commentsUnavailableReason: reason };
      }
    }
    const res = await this.api.documents.get(base as any);
    return { raw: res.data, commentsAvailable: false, commentsUnavailableReason: knownReason };
  }

  /** Clears the "comments unsupported" memo (e.g. on explicit refresh). */
  resetCommentSupport(documentId: string): void {
    this.commentsUnsupported.delete(documentId);
  }

  async batchUpdate(documentId: string, requests: any[], writeControl?: docs_v1.Schema$WriteControl) {
    const res = await this.api.documents.batchUpdate({
      documentId,
      requestBody: { requests, ...(writeControl ? { writeControl } : {}) },
    });
    return res.data;
  }

  async createDocument(title: string): Promise<docs_v1.Schema$Document> {
    const res = await this.api.documents.create({
      requestBody: { title },
    });
    return res.data;
  }
}

interface Entry {
  model: DocModel;
  validatedAt: number;
}

export interface CacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export class DocCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<DocModel>>();

  constructor(
    private backend: DocsBackend,
    private opts: CacheOptions,
  ) {}

  /**
   * @param fresh  when true, always revalidate the revision against the server
   *               (used before mutations so validation runs on current content).
   */
  async get(documentId: string, fresh = false): Promise<DocModel> {
    const entry = this.entries.get(documentId);
    const now = Date.now();
    if (entry) {
      if (!fresh && now - entry.validatedAt < this.opts.ttlMs) return this.touch(documentId, entry).model;
      const rev = await this.backend.getRevisionId(documentId);
      if (rev && rev === entry.model.revisionId) {
        entry.validatedAt = Date.now();
        return this.touch(documentId, entry).model;
      }
    }
    return this.load(documentId);
  }

  invalidate(documentId: string): void {
    this.entries.delete(documentId);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  peek(documentId: string): DocModel | undefined {
    return this.entries.get(documentId)?.model;
  }

  private touch(id: string, entry: Entry): Entry {
    // Map preserves insertion order -> re-insert for LRU.
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry;
  }

  private load(documentId: string): Promise<DocModel> {
    const existing = this.inflight.get(documentId);
    if (existing) return existing;
    const p = (async () => {
      try {
        const f = await this.backend.fetchFull(documentId);
        const model = buildDocModel(f.raw, {
          commentsAvailable: f.commentsAvailable,
          commentsUnavailableReason: f.commentsUnavailableReason,
        });
        this.entries.set(documentId, { model, validatedAt: Date.now() });
        while (this.entries.size > this.opts.maxEntries) {
          const oldest = this.entries.keys().next().value as string;
          this.entries.delete(oldest);
        }
        return model;
      } finally {
        this.inflight.delete(documentId);
      }
    })();
    this.inflight.set(documentId, p);
    return p;
  }
}

/** Accepts a raw document ID or any Google Docs URL. */
export function parseDocumentId(input: string): string {
  const s = input.trim();
  const m = s.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  throw new Error(`"${input}" is not a valid Google Docs document ID or URL.`);
}
