/**
 * Category A: Discovery & Survey tools.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GAP,
  collectSuggestionIds,
  getTab,
  getTableColumnHeaders,
  renderText,
  searchText,
  truncate,
  type TabModel,
} from '../docModel.js';
import { parseDocumentId } from '../docsClient.js';
import {
  RO,
  anchorSummary,
  documentIdSchema,
  ok,
  preview,
  safe,
  tabIdSchema,
  type ToolContext,
} from './common.js';

export function registerDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  const load = (documentId: string, fresh = false) => ctx.cache.get(parseDocumentId(documentId), fresh);

  server.registerTool(
    'doc_get_metadata',
    {
      title: 'Get document metadata',
      description:
        'Quick, text-free status check of a Google Doc: title, revisionId, tabs, character counts, table counts, image counts, comment counts, and pending suggestion counts. Use refresh=true to force a full re-fetch.',
      inputSchema: {
        documentId: documentIdSchema,
        refresh: z.boolean().optional().describe('Bypass the cache and re-fetch the document.'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, refresh }) => {
      const id = parseDocumentId(documentId);
      if (refresh) {
        ctx.cache.invalidate(id);
        ctx.backend.resetCommentSupport?.(id);
      }
      const m = await ctx.cache.get(id);
      const charCount = (t: TabModel) => t.text.length - (t.text.split(GAP).length - 1);

      return ok({
        documentId: m.documentId,
        title: m.title,
        revisionId: m.revisionId,
        characterCount: m.tabs.reduce((n, t) => n + charCount(t), 0),
        tableCount: m.tabs.reduce((n, t) => n + t.tables.length, 0),
        imageCount: m.tabs.reduce((n, t) => n + t.images.length, 0),
        tabs: m.tabs.map((t) => ({
          tabId: t.tabId || undefined,
          title: t.title || undefined,
          nestingLevel: t.nestingLevel || undefined,
          endIndex: t.endIndex,
          characterCount: charCount(t),
          headings: t.outline.length,
          tables: t.tables.length,
          images: t.images.length,
        })),
        comments: m.commentsAvailable
          ? {
              total: m.comments.length,
              open: m.comments.filter((c) => c.status === 'OPEN').length,
              resolved: m.comments.filter((c) => c.status === 'RESOLVED').length,
            }
          : { available: false, reason: m.commentsUnavailableReason },
        suggestionCount: collectSuggestionIds(m).size,
      });
    }),
  );

  server.registerTool(
    'doc_get_outline',
    {
      title: 'Get document outline',
      description:
        'Retrieves the structural outline of the document: formal headings (TITLE=level 0, HEADING_n=level n) plus visually bolded / enlarged single-line section dividers (isPseudo=true), with exact indices, without downloading document text. sectionEndIndex marks where the section ends, so doc_read_range(startIndex, sectionEndIndex) reads one section. ' +
        'Set includeTables: true to also see which tables are located within each section and their column headers.',
      inputSchema: {
        documentId: documentIdSchema,
        tabId: tabIdSchema,
        includePseudo: z.boolean().optional().describe('Include pseudo-headings (default true).'),
        includeTables: z
          .boolean()
          .optional()
          .describe('Include tables located within each section, along with dimensions and column headers (default false).'),
        maxLevel: z.number().int().min(0).max(6).optional().describe('Only return entries with level <= maxLevel.'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, tabId, includePseudo, includeTables, maxLevel }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      const outline = tab.outline.filter(
        (o) => (includePseudo !== false || !o.isPseudo) && (maxLevel === undefined || o.level <= maxLevel),
      );

      const items = outline.map((o) => {
        if (!includeTables) return o;
        const sectionTables = tab.tables
          .filter((t) => t.startIndex >= o.startIndex && t.startIndex < o.sectionEndIndex)
          .map((t) => ({
            tableIndex: t.tableIndex,
            startIndex: t.startIndex,
            endIndex: t.endIndex,
            rows: t.rows,
            columns: t.columns,
            totalCharacters: t.cells.reduce((sum, c) => sum + (c.endIndex - c.startIndex), 0),
            columnHeaders: getTableColumnHeaders(tab, t),
          }));
        return {
          ...o,
          tables: sectionTables.length ? sectionTables : undefined,
        };
      });

      let unsectionedTables: Array<{
        tableIndex: number;
        startIndex: number;
        endIndex: number;
        rows: number;
        columns: number;
        totalCharacters: number;
        columnHeaders: string[];
      }> | undefined;

      if (includeTables) {
        if (outline.length > 0) {
          const firstStart = outline[0].startIndex;
          const beforeFirst = tab.tables.filter((t) => t.startIndex < firstStart);
          if (beforeFirst.length > 0) {
            unsectionedTables = beforeFirst.map((t) => ({
              tableIndex: t.tableIndex,
              startIndex: t.startIndex,
              endIndex: t.endIndex,
              rows: t.rows,
              columns: t.columns,
              totalCharacters: t.cells.reduce((sum, c) => sum + (c.endIndex - c.startIndex), 0),
              columnHeaders: getTableColumnHeaders(tab, t),
            }));
          }
        } else if (tab.tables.length > 0) {
          unsectionedTables = tab.tables.map((t) => ({
            tableIndex: t.tableIndex,
            startIndex: t.startIndex,
            endIndex: t.endIndex,
            rows: t.rows,
            columns: t.columns,
            totalCharacters: t.cells.reduce((sum, c) => sum + (c.endIndex - c.startIndex), 0),
            columnHeaders: getTableColumnHeaders(tab, t),
          }));
        }
      }

      return ok({
        revisionId: m.revisionId,
        tabId: tab.tabId || undefined,
        outline: items,
        ...(unsectionedTables ? { unsectionedTables } : {}),
      });
    }),
  );

  server.registerTool(
    'doc_get_changes_summary',
    {
      title: 'Get document changes summary & editorial digest',
      description:
        'Provides a high-level changelog and editorial digest of all pending suggestions and open comments grouped by outline section. ' +
        'Ideal for summarizing changes, drafting revision cover letters, and updating version history tables.',
      inputSchema: {
        documentId: documentIdSchema,
        tabId: tabIdSchema,
      },
      annotations: RO,
    },
    safe(async ({ documentId, tabId }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      const outline = tab.outline ?? [];
      const threads = new Map(m.suggestionThreads.map((s) => [s.suggestionId, s]));
      const suggestions: Array<{
        suggestionId: string;
        kinds: string[];
        startIndex: number;
        endIndex: number;
        text: string;
        author?: string;
      }> = [];

      for (const [id, span] of tab.suggestionSpans) {
        const th = threads.get(id);
        const sStart = span.ranges[0].startIndex;
        const sEnd = span.ranges[span.ranges.length - 1].endIndex;
        suggestions.push({
          suggestionId: id,
          kinds: [...span.kinds],
          startIndex: sStart,
          endIndex: sEnd,
          text: truncate(span.ranges.map((r) => renderText(tab, r.startIndex, r.endIndex)).join(' … '), 120),
          author: th?.author,
        });
      }

      const comments = m.commentsAvailable ? m.comments : [];

      const suggestionsByAuthor: Record<string, number> = {};
      const suggestionsByKind: Record<string, number> = {};
      for (const s of suggestions) {
        const author = s.author ?? 'Unknown';
        suggestionsByAuthor[author] = (suggestionsByAuthor[author] ?? 0) + 1;
        for (const k of s.kinds) {
          suggestionsByKind[k] = (suggestionsByKind[k] ?? 0) + 1;
        }
      }

      const openComments = comments.filter((c) => c.status === 'OPEN');
      const commentsByAuthor: Record<string, number> = {};
      for (const c of openComments) {
        const author = c.head?.author ?? 'Unknown';
        commentsByAuthor[author] = (commentsByAuthor[author] ?? 0) + 1;
      }

      const sectionsWithChanges: any[] = [];
      for (const heading of outline) {
        const sStart = heading.startIndex;
        const sEnd = heading.sectionEndIndex ?? tab.endIndex;

        const secSuggestions = suggestions.filter((s) => s.endIndex > sStart && s.startIndex < sEnd);
        const secComments = openComments.filter((c) => {
          const a = anchorSummary(m, c);
          return a.anchored && a.endIndex !== undefined && a.startIndex !== undefined && a.endIndex > sStart && a.startIndex < sEnd;
        });

        if (secSuggestions.length > 0 || secComments.length > 0) {
          sectionsWithChanges.push({
            title: heading.title,
            level: heading.level,
            startIndex: sStart,
            endIndex: sEnd,
            suggestionCount: secSuggestions.length,
            openCommentCount: secComments.length,
            suggestionsSummary: secSuggestions.slice(0, 10).map((s) => ({
              suggestionId: s.suggestionId,
              author: s.author,
              kinds: s.kinds,
              summary: s.text,
            })),
            openCommentsSummary: secComments.slice(0, 10).map((c) => ({
              commentId: c.commentId,
              author: c.head?.author,
              content: truncate(c.head?.content ?? '', 120),
            })),
          });
        }
      }

      // Collect preamble / unsectioned items (before first heading or if outline is empty)
      const firstHeadingStart = outline.length > 0 ? outline[0].startIndex : tab.endIndex;
      const preambleSuggestions = suggestions.filter((s) => s.startIndex < firstHeadingStart);
      const preambleComments = openComments.filter((c) => {
        const a = anchorSummary(m, c);
        return a.anchored && a.startIndex !== undefined && a.startIndex < firstHeadingStart;
      });

      if (preambleSuggestions.length > 0 || preambleComments.length > 0) {
        sectionsWithChanges.unshift({
          title: 'Preamble / Untitled Document Head',
          level: 0,
          startIndex: 1,
          endIndex: firstHeadingStart,
          suggestionCount: preambleSuggestions.length,
          openCommentCount: preambleComments.length,
          suggestionsSummary: preambleSuggestions.slice(0, 10).map((s) => ({
            suggestionId: s.suggestionId,
            author: s.author,
            kinds: s.kinds,
            summary: s.text,
          })),
          openCommentsSummary: preambleComments.slice(0, 10).map((c) => ({
            commentId: c.commentId,
            author: c.head?.author,
            content: truncate(c.head?.content ?? '', 120),
          })),
        });
      }

      return ok({
        revisionId: m.revisionId,
        tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
        totalPendingSuggestions: suggestions.length,
        totalOpenComments: openComments.length,
        totalResolvedComments: comments.length - openComments.length,
        suggestionsByAuthor,
        suggestionsByKind,
        openCommentsByAuthor: commentsByAuthor,
        sectionsWithChangesCount: sectionsWithChanges.length,
        sectionsWithChanges,
      });
    }),
  );

  server.registerTool(
    'doc_search_text',
    {
      title: 'Search document text',
      description:
        'Finds exact-string matches across the document text buffer without downloading full text. Returns the exact startIndex and endIndex for every occurrence, plus a surrounding 80-character snippet with <match>…</match> tags. ALWAYS use this to obtain fresh indices before editing.',
      inputSchema: {
        documentId: documentIdSchema,
        query: z.string().min(1).describe('The search needle (plain text).'),
        tabId: tabIdSchema,
        caseSensitive: z.boolean().optional().describe('Default false.'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Default 5.'),
        previewRadius: z.number().int().min(10).max(300).optional().describe('Surrounding chars on each side (default 40).'),
        markSuggestions: z.boolean().optional().describe('Show pending suggestions in snippets as [-deleted-]/{+inserted+} (default true).'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, query, tabId, caseSensitive, maxResults, previewRadius, markSuggestions }) => {
      const m = await load(documentId);
      const tab = getTab(m, tabId);
      const max = maxResults ?? 5;
      const radius = previewRadius ?? 40;
      const mark = markSuggestions !== false;
      const res = searchText(tab, query, { caseSensitive, maxResults: max });
      return ok({
        revisionId: m.revisionId,
        tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
        query,
        totalMatches: res.totalMatches,
        matches: res.matches.map((r) => {
          const prev = preview(tab, r.startIndex, r.endIndex, radius, 'match', mark);
          return {
            startIndex: r.startIndex,
            endIndex: r.endIndex,
            snippet: prev,
            preview: prev,
          };
        }),
      });
    }),
  );

  server.registerTool(
    'doc_list_suggestions',
    {
      title: 'List suggestions',
      description:
        'Lists pending suggested changes (tracked changes) with suggestionId, kind (insertion/deletion/textStyle/paragraphStyle), location and a short preview. Use the IDs with doc_manage_suggestion.',
      inputSchema: {
        documentId: documentIdSchema,
        tabId: tabIdSchema,
        maxPreviewChars: z.number().int().min(10).max(2000).optional().describe('Default 120.'),
      },
      annotations: RO,
    },
    safe(async ({ documentId, tabId, maxPreviewChars }) => {
      const m = await load(documentId);
      const max = maxPreviewChars ?? 120;
      const tabs = tabId ? [getTab(m, tabId)] : m.tabs;
      const threads = new Map(m.suggestionThreads.map((s) => [s.suggestionId, s]));
      const rows: any[] = [];
      const seen = new Set<string>();
      for (const tab of tabs) {
        for (const [id, span] of tab.suggestionSpans) {
          seen.add(id);
          const th = threads.get(id);
          rows.push({
            suggestionId: id,
            kinds: [...span.kinds],
            tabId: tab.tabId && m.tabs.length > 1 ? tab.tabId : undefined,
            startIndex: span.ranges[0].startIndex,
            endIndex: span.ranges[span.ranges.length - 1].endIndex,
            text: truncate(span.ranges.map((r) => renderText(tab, r.startIndex, r.endIndex)).join(' … '), max),
            author: th?.author,
            status: th?.status,
            summary: th?.summary ? truncate(th.summary, max) : undefined,
          });
        }
      }
      if (!tabId) {
        for (const th of m.suggestionThreads) {
          if (seen.has(th.suggestionId) || th.status === 'ACCEPTED' || th.status === 'REJECTED') continue;
          rows.push({ suggestionId: th.suggestionId, author: th.author, status: th.status, summary: th.summary && truncate(th.summary, max) });
        }
      }
      rows.sort((a, b) => (a.startIndex ?? Number.MAX_SAFE_INTEGER) - (b.startIndex ?? Number.MAX_SAFE_INTEGER));
      return ok({ revisionId: m.revisionId, total: rows.length, suggestions: rows });
    }),
  );
}
