# Google Docs Suggestion & Comment MCP Server (`docs-mcp`)

A production-grade Model Context Protocol (MCP) server that runs locally via Node.js, providing native Google Docs comments, comment anchors, suggestion tracking (`writeMode: "SUGGEST"`), rich text formatting, and document elements (tables, layout, images) to AI coding assistants and editorial workflows (Antigravity, Claude, Gemini, Cursor).

---

## 1. Overview & Problem Solved

Standard community Google Docs MCP servers convert documents to Markdown or perform direct overwriting edits, destroying native comment anchors and bypassing reviewer change tracking. Meanwhile, raw Docs API integrations dump massive JSON trees (50k–100k+ tokens for medium/large documents) into the LLM context window on every turn.

Furthermore, traditional plain-text approaches strip all formatting and layout, leaving the AI blind to:
- **Rich Text Styles:** Bold, italic, underline, strikethrough, font sizes, colors, and links.
- **Document Elements:** Table structures, cell coordinates, bullet/numbered lists, and embedded images.

`docs-mcp` bridges this middleground:
- **Local & Private Execution:** Runs entirely on your local machine using Node.js and standard MCP `stdio` transport. Spawned directly by your MCP client.
- **In-Memory Cache & Slicer:** Fetches the document DOM once into an in-memory buffer and serves targeted, low-token slices (100–800 tokens each) with exact coordinates.
- **Index-Preserving Rich Text (Read & Write):** Returns both raw plain text (for byte-accurate matching) and Markdown `annotatedText` (with `**bold**`, `*italic*`, `<u>underline</u>`, `~~strikethrough~~`, `[links]`, and `[Image: ...]`), plus structured `runs` mapping exact index ranges to formatting properties.
- **Table Navigation & Manipulation:** Inspect tables, row/column counts, and cell coordinates with `doc_inspect_tables`. Insert tables, add rows/columns, or delete them with `doc_insert_table` and `doc_modify_table`.
- **Layout & Image Tools:** Format headings and bullet/numbered lists with `doc_format_paragraph`, and insert images with `doc_insert_image`.
- **Native Comment & Anchor Highlighting:** Reads and creates native inline comments and comment anchors using the GA Google Docs API v1.
- **Suggestion Mode by Default:** Revisions default to suggestion mode (`writeControl: { writeMode: "SUGGEST" }`), displaying track changes in the Google Docs web UI.
- **Reverse-Index Multi-Edits:** Multi-edits are automatically validated, overlap-checked, and applied in descending order of `startIndex` (bottom-to-top), preventing coordinate drift.

---

## 2. Rich Text Formatting & Document Elements

`docs-mcp` provides generic, high-fidelity support for Google Docs rich styling and structural elements across both the read and write paths:

### Rich Text Styles
Supports all core typography properties:
- **Bold**, *Italic*, <u>Underline</u>, ~~Strikethrough~~, and arbitrary combinations (e.g. bold strikethrough, italic strikethrough, underlined bold).
- **Font Size:** Exact point size (`magnitude` in PT).
- **Colors:** Hex strings (e.g. `"#0055ff"`, `"#ff0000"`) or `{ red, green, blue }` ratios (0.0 to 1.0) for foreground text color and background highlight color.
- **Links:** Clickable hyperlinks (`linkUrl`).

### Read Path Representation
When calling `doc_read_range` or `doc_read_comment_context`:
- `text`: Pure plain text (used for exact UTF-16 index calculation and `expectedText` safety verification).
- `annotatedText`: Human- and LLM-friendly Markdown showing styles inline (`**bold**`, `*italic*`, `<u>underline</u>`, `~~strikethrough~~`, `[anchor](url)`, and `[Image: Title (WxH)]`).
- `runs`: Structured array of spans, each with exact `startIndex`, `endIndex`, and full `style` object (`bold`, `italic`, `underline`, `strikethrough`, `fontSize`, `foregroundColor`, `backgroundColor`, `linkUrl`).
- `tableContext`: When a range falls inside a table, reports the containing `tableStartIndex`, `rowIndex`, `columnIndex`, and cell bounds.
- `paragraphs`: Structured paragraph entries overlapping the range with their complete style metadata: `namedStyleType`, `alignment`, spacing (`spaceAbove`, `spaceBelow`, `lineSpacing`, `spacingMode`), margins/indentation (`indentStart`, `indentEnd`, `indentFirstLine`), borders with `padding`, and background `shadingColor`.

### Write Path Formatting
- **Apply Styles Directly:** Use `doc_format_text` to apply any combination of text styles across an index range in suggestion mode (`SUGGEST`) or edit mode (`EDIT`).
- **Inline Styling in Edits:** All edit tools (`doc_suggest_edit_range`, `doc_apply_direct_edit`, `doc_suggest_comment_revision`, `doc_batch_suggest_edits`) accept an optional `textStyle` object (`{ bold, italic, underline, strikethrough, fontSize, foregroundColor, backgroundColor, linkUrl }`), which styles inserted or replaced text immediately.
- **Paragraphs, Spacing & Layout:** Use `doc_format_paragraph` to customize:
  - Heading levels (`NORMAL_TEXT`, `TITLE`, `SUBTITLE`, `HEADING_1` through `HEADING_6`) and text alignment (`START`, `CENTER`, `END`, `JUSTIFIED`).
  - Spacing: Above (`spaceAbove` in PT), below (`spaceBelow` in PT), and line spacing (`lineSpacing` as percentage, e.g. 100, 115, 150, 200).
  - Margins & Indentation: Left indent (`indentStart`), right indent (`indentEnd`), and first-line indent (`indentFirstLine`).
  - Borders & Padding: Border padding (`padding` shorthand or individual `borderTop`, `borderBottom`, `borderLeft`, `borderRight`, `borderBetween`).
  - Background Shading: Paragraph background color (`shadingColor` hex).
  - Pagination Controls: `keepWithNext` (keep headings with body text), `keepLinesTogether`, `avoidWidowAndOrphan`, and `pageBreakBefore`.
  - Lists: Create or remove bullet and numbered lists (`BULLET_DISC_CIRCLE_SQUARE`, `BULLET_CHECKBOX`, `NUMBERED_DECIMAL_ALPHA_ROMAN`, etc.).
- **Tables & Images:** Inspect tables via `doc_inspect_tables`, insert new tables with `doc_insert_table`, manage rows/columns with `doc_modify_table`, and insert inline images with `doc_insert_image`.

---

## 3. Architecture: In-Memory Document Cache & Slicer

```
[Google Docs REST API v1]
        ▲
        │ Full fetch (documents.get) ONLY on cache miss or revision mismatch
        ▼
[Local MCP Server In-Memory Cache]
  ├─ Raw Doc DOM & documentId
  ├─ revisionId (for cache validity & optimistic concurrency)
  ├─ UTF-16 Full Text Buffer & Fast Offset Index
  ├─ Styled Runs & Style Spans (bold, italic, underline, strike, colors)
  ├─ Table Model (rows, columns, cell index bounds & cell text)
  ├─ Image & Element Index (dimensions, URIs, titles)
  ├─ Comment & Anchor Index (commentAnchors + comments)
  └─ Heuristic Outline Tree (formal headings + pseudo-headings)
        ▲
        │ Sub-second, low-token slices (100–800 tokens each)
        ▼
[Antigravity / Claude / LLM Client]  (via stdio)
```

### Coordinate & Index Fidelity
- **UTF-16 Code Unit Fidelity:** Google Docs uses 0-indexed UTF-16 code units. Slices never re-base indices to `0`; global document indices are always returned.
- **Cache Invalidation:** Any mutation (`documents.batchUpdate`) automatically invalidates the cached entry.
- **`expectedText` Safety Guard:** Range edit tools accept an optional `expectedText` parameter. If collaborator edits shifted text out of alignment, the server immediately aborts the edit rather than corrupting content.

---

## 4. Google Cloud OAuth 2.0 Setup Guide

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
   - **Internal** (if you have a Google Workspace organization).
   - **External** (if using a personal `@gmail.com` account or multi-domain accounts).
3. Click **Create** and fill in:
   - **App name:** `Docs Editorial MCP`
   - **User support email:** Your email address
   - **Developer contact information:** Your email address
4. Click **Save and Continue**.
5. **Scopes:** Click **Add or Remove Scopes**, and select or manually enter:
   - `https://www.googleapis.com/auth/documents` (View and manage Google Docs documents)
   - `https://www.googleapis.com/auth/drive.file` (View and manage Google Drive files opened/created by this app)
6. Click **Save and Continue**.
7. **Test Users (Crucial for External apps in Testing mode):**
   - Click **Add Users** and enter your Google account email address.
   - Click **Save and Continue**.

### Step 4: Create OAuth 2.0 Client Credentials
1. Go to **APIs & Services > Credentials**.
2. Click **+ Create Credentials** at the top and select **OAuth client ID**.
3. In the **Application type** dropdown, select **Desktop app**.
4. Name it `Docs MCP Desktop Client` and click **Create**.
5. Copy your `Client ID` and `Client Secret` (or click Download JSON).

### Step 5: Semi-Interactive Browser Authorization
`docs-mcp` uses the standard **semi-interactive loopback flow**:
1. When your AI assistant starts the server for the first time, the server detects that no cached token exists.
2. It automatically spins up a local loopback listener on `127.0.0.1` and opens your default browser to the Google OAuth consent screen.
3. You select your Google account and click **Allow**.
4. The browser displays **"Authorization Successful!"** and the server saves your refresh token to `~/.config/docs-mcp/token.json` (mode 0600).
5. **Future runs are completely silent**: The server reads `token.json` and automatically refreshes access tokens in the background when they expire.

*(You can also pre-authorize anytime from your terminal by running `npm run auth`).*

---

## 5. Client Configuration

### Connecting to Google Antigravity

In Antigravity, add `docs-mcp` to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "docs-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/docs-mcp/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "GOCSPX-your-client-secret",
        "DOCS_MCP_REQUIRE_REVISION": "true",
        "DOCS_MCP_CACHE_TTL_MS": "30000",
        "DOCS_MCP_CACHE_MAX_ENTRIES": "20"
      }
    }
  }
}
```

### Connecting to Claude Desktop

Add `docs-mcp` to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "docs-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/docs-mcp/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "GOCSPX-your-client-secret",
        "DOCS_MCP_REQUIRE_REVISION": "true"
      }
    }
  }
}
```

---

## 6. Tool Catalog

### Category A: Discovery & Survey (Low Token Footprint)

| Tool | Purpose | Description |
|---|---|---|
| `doc_get_metadata` | Document status | Returns title, revisionId, character count, tab listing, table count, image count, comments summary, and suggestion count. |
| `doc_get_outline` | Document structure | Returns hierarchical outline of formal headings (`HEADING_1`..`HEADING_6`, `TITLE`) and pseudo-headings (bold/enlarged single-line section dividers < 80 chars) with exact global coordinates and `sectionEndIndex`. |
| `doc_list_comments` | Survey feedback | Surveys comment threads with author, status (`OPEN` / `RESOLVED`), feedback text, current anchor text, and coordinates. |
| `doc_search_text` | Find text | Finds occurrences of terms/phrases across the document buffer without dumping content into context; returns exact `startIndex`/`endIndex` and snippet preview. |
| `doc_list_suggestions` | Tracked changes | Lists pending suggestions (insertions, deletions, text styles) with `suggestionId`, type, author, summary, and preview. |

### Category B: Reading & Context Inspection

| Tool | Purpose | Description |
|---|---|---|
| `doc_read_document` | Full document read | Reads entire document in token-efficient Markdown with outline hierarchy, section markers, pending suggestions summary, and tables overview. Also supports `format: "raw_json"` for 1:1 parity with Google Workspace MCP `read_doc`. |
| `doc_read_comment_context` | Read around comment | Fetches the targeted sentence and surrounding paragraph(s) for a given `commentId`, wrapping the anchor in `<target>...</target>` tags, with anchor style runs and table context. |
| `doc_read_range` | Read bounds with Rich Text | Reads text between `startIndex` and `endIndex` (or entire tab if bounds omitted). Returns raw plain text, rich Markdown `annotatedText` (bold, italic, underline, strikethrough, images), structured `runs`, `paragraphs` with full style/spacing/padding metadata, `tableContext`, and tables/images in range. |
| `doc_inspect_tables` | Inspect tables | Lists all tables in the document (or a specific table) with dimensions, start/end index, and cell matrix (row, column, text, startIndex, endIndex). Supports `includeCellText: false` for low-token structural inspections. |

### Category C: Safe Mutation, Suggestions & Batch Endpoints

| Tool | Purpose | Description |
|---|---|---|
| `doc_suggest_comment_revision` | **Review Automation** | Atomically replaces the anchored text of a comment with suggested wording in suggestion mode (`writeMode: "SUGGEST"`), supports `textStyle`, and resolves the comment thread in a single `batchUpdate`. |
| `doc_suggest_deletion` | Tracked deletion | Submits a native tracked deletion suggestion. Text is removed when accepted (Google Docs renders this with strikethrough in its web UI). |
| `doc_suggest_edit_range` | Propose revision | Submits a suggested revision between `startIndex` and `endIndex` (or pure insertion if `startIndex === endIndex`). Supports optional `textStyle` on inserted text. |
| `doc_suggest_redline_edit` | **Styled Redline Amendment** | Solves the Docs API boundary-swallowing bug for formal style guides: retains original text with custom formatting (e.g. bold strikethrough) and inserts replacement text alongside it (e.g. bold), without deleting original wording. |
| `doc_suggest_replace_all` | Search & replace all | Finds all occurrences of text and proposes tracked replacements across the document in ONE atomic call. Supports both standard replacements and redline mode. |
| `doc_batch_suggest_edits` | Batch revisions | Submits multiple suggested revisions in one atomic `batchUpdate`. Supports `textStyle`, deletions, pure insertions, and `redline: true` per item. Automatically orders edits bottom-to-top and rejects overlaps. |
| `doc_batch_manage_suggestions` | Bulk accept/reject | Atomically accepts or rejects multiple suggestions at once by ID or with `action: "ACCEPT_ALL"` / `"REJECT_ALL"`. |
| `doc_apply_direct_edit` | Direct overwrite | Overwrites `[startIndex, endIndex)` directly (`writeMode: "EDIT"`). Supports optional `textStyle`. |
| `doc_raw_batch_update` | **Docs API Escape Hatch** | Direct passthrough to Docs API `batchUpdate` (1:1 parity with Google Workspace MCP `update_doc`). Executes arbitrary native Docs requests with `writeMode: "SUGGEST"` or `"EDIT"`. |
| `doc_create_document` | Create new document | Creates a new blank Google Document in Google Drive with an optional initial text body. |
| `doc_add_comment` | Create comment | Creates a new inline comment anchored directly over the specified text span `[startIndex, endIndex)`. |
| `doc_reply_comment` | Reply to thread | Adds a reply to a comment thread without editing document text; optionally `RESOLVE`s or `REOPEN`s the thread. |
| `doc_delete_comment` | Delete comment | Permanently deletes a comment thread or reply post. |
| `doc_manage_suggestion` | Accept/reject single | Programmatically accepts or rejects a single pending suggestion by `suggestionId`. |

### Category D: Rich Formatting & Layout

| Tool | Purpose | Description |
|---|---|---|
| `doc_format_text` | Style text | Formats any text range with bold, italic, underline, strikethrough, fontSize, colors, links. Runs in `SUGGEST` or `EDIT` mode. |
| `doc_format_paragraph` | Headings, Spacing & Lists | Updates paragraph style (`NORMAL_TEXT`, `TITLE`, `HEADING_1`..`HEADING_6`), text alignment, spacing (`spaceAbove`, `spaceBelow`, `lineSpacing`), indentation (`indentStart`, `indentEnd`, `indentFirstLine`), border padding, background shading (`shadingColor`), or creates/removes bullet and numbered lists. |
| `doc_insert_table` | Insert table | Inserts a table with rows and columns at an index; supports optional `cells: string[][]` initial 2D text matrix to populate cells immediately. |
| `doc_modify_table` | Modify table rows/cols | Adds or removes rows or columns in an existing table (`INSERT_ROW_ABOVE`, `INSERT_ROW_BELOW`, `DELETE_ROW`, `INSERT_COLUMN_LEFT`, `INSERT_COLUMN_RIGHT`, `DELETE_COLUMN`). |
| `doc_insert_image` | Insert image | Inserts an inline image from a publicly accessible HTTPS URI with optional width and height dimensions in points. |

---

## 7. Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | (unset) | Google OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | (unset) | Google OAuth 2.0 Client Secret |
| `GOOGLE_OAUTH_CREDENTIALS` | `~/.config/docs-mcp/credentials.json` | Path to downloaded OAuth Desktop Client JSON |
| `DOCS_MCP_TOKEN_PATH` | `~/.config/docs-mcp/token.json` | Path to cached OAuth tokens file |
| `DOCS_MCP_CACHE_TTL_MS` | `30000` (30s) | In-memory cache validation TTL before checking revisionId |
| `DOCS_MCP_CACHE_MAX_ENTRIES` | `20` | Max documents held in LRU in-memory cache |
| `DOCS_MCP_REQUIRE_REVISION` | `true` | Enforces optimistic concurrency (`requiredRevisionId`) |
| `DOCS_MCP_SCOPES` | `documents, drive.file` | Space-separated OAuth scopes |

---

## 8. Development & Testing

```bash
# Build TypeScript
npm run build

# Run unit and integration tests
npm test

# Typecheck without emitting
npm run typecheck
```

---

## 9. License

MIT License. See [LICENSE](LICENSE) for details.
