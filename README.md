# Google Docs Suggestion & Comment MCP Server (`docs-mcp`)

A production-grade Model Context Protocol (MCP) server that runs locally via Node.js, providing native Google Docs comments, comment anchors, and suggestion tracking (`writeMode: "SUGGEST"`) to AI coding assistants and editorial workflows (Antigravity, Claude, Gemini, Cursor).

---

## 1. Overview & Problem Solved

Standard community Google Docs MCP servers convert documents to Markdown or perform direct overwriting edits, destroying native comment anchors and bypassing reviewer change tracking. Meanwhile, raw Docs API integrations dump massive JSON trees (50k–100k+ tokens for medium/large documents) into the LLM context window on every turn.

`docs-mcp` solves both issues:

- **Local & Private Execution:** Runs entirely on your local machine using Node.js and standard MCP `stdio` transport. No remote servers or cloud hosting needed; your MCP client spawns the process directly.
- **In-Memory Cache & Slicer:** Fetches the document DOM once into an in-memory buffer and serves targeted, low-token slices (100–500 tokens each) with exact coordinates.
- **Native Comment & Anchor Highlighting:** Reads and creates native inline comments and comment anchors using the GA Google Docs API v1.
- **Suggestion Mode by Default:** Revisions default to suggestion mode (`writeControl: { writeMode: "SUGGEST" }`), displaying track changes (strikethroughs and author checkmarks) in the Google Docs web UI.
- **Reverse-Index Multi-Edits:** Multi-edits are automatically validated, overlap-checked, and applied in descending order of `startIndex` (bottom-to-top), preventing coordinate drift.
- **Atomic Comment Revisions:** `doc_suggest_comment_revision` atomically applies the replacement in suggestion mode and resolves the comment thread in a single `batchUpdate`.

---

## 2. Architecture: In-Memory Document Cache & Slicer

```
[Google Docs REST API v1]
        ▲
        │ Full fetch (documents.get) ONLY on cache miss or revision mismatch
        ▼
[Local MCP Server In-Memory Cache]
  ├─ Raw Doc DOM & documentId
  ├─ revisionId (for cache validity & optimistic concurrency)
  ├─ UTF-16 Full Text Buffer & Fast Offset Index
  ├─ Comment & Anchor Index (commentAnchors + comments)
  └─ Heuristic Outline Tree (formal headings + pseudo-headings)
        ▲
        │ Sub-second, low-token slices (100–500 tokens each)
        ▼
[Antigravity / Claude / LLM Client]  (via stdio)
```

### Coordinate & Index Fidelity
- **UTF-16 Code Unit Fidelity:** Google Docs uses 0-indexed UTF-16 code units. Slices never re-base indices to `0`; global document indices are always returned.
- **Cache Invalidation:** Any mutation (`documents.batchUpdate`) automatically invalidates the cached entry.
- **`expectedText` Safety Guard:** Range edit tools accept an optional `expectedText` parameter. If collaborator edits shifted text out of alignment, the server immediately aborts the edit rather than corrupting content.

---

## 3. Google Cloud OAuth 2.0 Setup Guide

To connect `docs-mcp` to your Google account, you will set up a free Google Cloud project and download an OAuth 2.0 Desktop Client secret.

### Step 1: Create a Google Cloud Project
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown in the top bar and select **New Project**.
3. Name it (e.g. `docs-mcp-local`) and click **Create**.

### Step 2: Enable the Google Docs & Drive APIs
1. In your project, go to **APIs & Services > Library**.
2. Search for **Google Docs API** and click **Enable**.
3. Search for **Google Drive API** and click **Enable**.

### Step 3: Configure the OAuth Consent Screen
1. Go to **APIs & Services > OAuth consent screen**.
2. Select User Type:
   - **Internal** (if you have a Google Workspace organization and only members of your domain will use it).
   - **External** (if using a personal `@gmail.com` account or multi-domain accounts).
3. Click **Create** and fill in the required fields:
   - **App name:** `Docs Editorial MCP`
   - **User support email:** Your email address
   - **Developer contact information:** Your email address
4. Click **Save and Continue**.
5. **Scopes:** Click **Add or Remove Scopes**, and select or manually enter:
   - `https://www.googleapis.com/auth/documents` (View and manage Google Docs documents)
   - `https://www.googleapis.com/auth/drive.file` (View and manage Google Drive files created or opened by this app)
6. Click **Save and Continue**.
7. **Test Users (Crucial for External apps in Testing mode):**
   - Click **Add Users** and enter your Google account email address.
   - Click **Save and Continue**.

### Step 4: Create OAuth 2.0 Client Credentials
1. Go to **APIs & Services > Credentials**.
2. Click **+ Create Credentials** at the top and select **OAuth client ID**.
3. In the **Application type** dropdown, select **Desktop app**.
4. Name it `Docs MCP Desktop Client` and click **Create**.
5. Click **Download JSON** on the confirmation dialog.

### Step 5: Save Credentials & Authorize
1. Save the downloaded file to:
   ```bash
   mkdir -p ~/.config/docs-mcp
   mv /path/to/downloaded-client-secret.json ~/.config/docs-mcp/credentials.json
   ```
   *(Or set `export GOOGLE_OAUTH_CREDENTIALS=/path/to/credentials.json`)*.
2. Run the one-time interactive authorization tool:
   ```bash
   npm run auth
   ```
3. A browser window will open automatically asking you to log into Google and grant consent.
4. Once granted, your tokens will be saved to `~/.config/docs-mcp/token.json` with secure file permissions (`0600`).
5. **You are done!** The server will automatically refresh expired access tokens in the background; you do not need to authenticate again.

---

## 4. Client Configuration

### Connecting to Google Antigravity

In Antigravity, add the server to your user or workspace configuration (e.g. `~/.gemini/antigravity/mcpSettings.json` or your project `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "docs-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/docs-mcp/dist/index.js"],
      "env": {
        "DOCS_MCP_CACHE_TTL_MS": "30000",
        "DOCS_MCP_REQUIRE_REVISION": "true"
      }
    }
  }
}
```

### Connecting to Claude Desktop

Add `docs-mcp` to your `claude_desktop_config.json` (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "google-docs": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/docs-mcp/dist/index.js"]
    }
  }
}
```

### Connecting to Cursor or other MCP Clients

Specify `node` as the executable and the absolute path to `dist/index.js` as the argument, using the standard `stdio` transport.

---

## 5. Tool Catalog

### Category A: Discovery & Survey (Low Token Footprint)

| Tool | Purpose | Description |
|---|---|---|
| `doc_get_metadata` | Document status | Returns title, revisionId, character count, tab listing, total comments, open comments, resolved comments, and suggestion count. |
| `doc_get_outline` | Document structure | Returns hierarchical outline of formal headings (`HEADING_1`..`HEADING_6`, `TITLE`) and pseudo-headings (bold/enlarged single-line section dividers < 80 chars) with exact global coordinates and `sectionEndIndex`. |
| `doc_list_comments` | Survey feedback | Surveys comment threads with author, status (`OPEN` / `RESOLVED`), feedback text, current anchor text, and coordinates. |
| `doc_search_text` | Find text | Finds occurrences of terms/phrases across the document buffer without dumping content into context; returns exact `startIndex`/`endIndex` and ~40 chars preview. |
| `doc_list_suggestions` | Tracked changes | Lists pending suggestions (insertions, deletions, text styles) with `suggestionId`, type, author, summary, and preview. |

### Category B: Targeted Context Reading

| Tool | Purpose | Description |
|---|---|---|
| `doc_read_comment_context` | Read around comment | Fetches the targeted sentence and surrounding paragraph(s) for a given `commentId`, wrapping the anchor in `<target>...</target>` tags. |
| `doc_read_range` | Read bounds | Reads plain text strictly between `startIndex` (inclusive) and `endIndex` (exclusive), preserving line breaks and global offsets. |

### Category C: Safe Mutation & Suggestions

| Tool | Purpose | Description |
|---|---|---|
| `doc_suggest_comment_revision` | **Core Review Automation** | Atomically replaces the anchored text of a comment with suggested wording in suggestion mode (`writeMode: "SUGGEST"`) and marks the comment thread resolved in a single `batchUpdate`. |
| `doc_suggest_edit_range` | Propose revision | Submits a suggested revision between `startIndex` and `endIndex` (struck-through original text, green suggestion styling in Google Docs). |
| `doc_apply_direct_edit` | Direct overwrite | Overwrites `[startIndex, endIndex)` directly (`writeMode: "EDIT"`). Used **only** when explicitly instructed to overwrite without suggestions. |
| `doc_batch_suggest_edits` | Batch revisions | Submits multiple suggested revisions in one `batchUpdate`. Automatically orders edits bottom-to-top (descending `startIndex`) and rejects overlaps. |
| `doc_add_comment` | Create comment | Creates a new inline comment anchored directly over the specified text span `[startIndex, endIndex)`. |
| `doc_reply_comment` | Reply to thread | Adds a reply to a comment thread without editing document text; optionally `RESOLVE`s or `REOPEN`s the thread. |
| `doc_delete_comment` | Delete comment | Permanently deletes a comment thread or reply post. |
| `doc_manage_suggestion` | Accept/reject | Programmatically accepts or rejects a pending suggestion by `suggestionId`. |

---

## 6. Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_OAUTH_CREDENTIALS` | `~/.config/docs-mcp/credentials.json` | Path to downloaded OAuth Desktop Client JSON |
| `DOCS_MCP_TOKEN_PATH` | `~/.config/docs-mcp/token.json` | Path to cached OAuth tokens file |
| `DOCS_MCP_CACHE_TTL_MS` | `30000` (30s) | In-memory cache validation TTL before checking revisionId |
| `DOCS_MCP_CACHE_MAX_ENTRIES` | `20` | Max documents held in LRU in-memory cache |
| `DOCS_MCP_REQUIRE_REVISION` | `true` | Enforces optimistic concurrency (`requiredRevisionId`) |
| `DOCS_MCP_SCOPES` | `documents, drive.file` | Space-separated OAuth scopes |

---

## 7. Development & Testing

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run unit and integration tests (24 automated tests)
npm test

# Typecheck without emitting
npm run typecheck
```

---

## 8. License

MIT License. See [LICENSE](LICENSE) for details.
