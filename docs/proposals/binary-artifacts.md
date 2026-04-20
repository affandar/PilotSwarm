# Proposal: Binary Artifacts (Store, Download, Open in Default Viewer)

**Status:** Approved (implementation-ready, v1)
**Date:** 2026-04-19
**Author:** Waldemort team (filed cross-repo per copilot-instructions.md repo-boundary rule)

## Problem

Artifacts in PilotSwarm are text-only end-to-end:

- `write_artifact` accepts `content: string` and writes UTF-8 bytes ([`packages/sdk/src/artifact-tools.ts`](../../packages/sdk/src/artifact-tools.ts) — `writeTool`).
- `uploadArtifact(sessionId, filename, content, contentType?)` writes the JS string directly into Azure Blob ([`packages/sdk/src/blob-store.ts`](../../packages/sdk/src/blob-store.ts) — `uploadArtifact`).
- `downloadArtifact` returns `Buffer.concat(...).toString("utf-8")` ([`packages/sdk/src/blob-store.ts`](../../packages/sdk/src/blob-store.ts) — `downloadArtifact`).
- The portal download endpoint pipes that string back to the browser as `text/plain; charset=utf-8` ([`packages/portal/server.js`](../../packages/portal/server.js) — `/api/sessions/:sessionId/artifacts/:filename/download`).
- The CLI transport guesses content types from a small text-only list (`md / json / html / csv / yaml`, default `text/plain`) ([`packages/cli/src/node-sdk-transport.js`](../../packages/cli/src/node-sdk-transport.js) — `guessArtifactContentType`).
- `MarkdownViewer` is the only file viewer the portal ships and assumes Markdown for every artifact.

The 1 MB cap, the UTF-8 round-trip, and the inline preview all assume text. Pushing an `.xlsx`, `.pdf`, `.zip`, or `.png` through the existing pipe corrupts it on download and would attempt to render the bytes as Markdown in the portal preview.

The first concrete demand is from a downstream agent that produces a release-train workbook (`Mxx_Payload_with_hyperlinks_and_R2D.xlsx`) that an operator wants to download with one click from the portal and open in Excel. There is no clean path for that today.

## Goals

1. Allow agents to upload **binary** artifacts (xlsx, pdf, zip, png, …) without UTF-8 corruption, alongside text artifacts.
2. Let users **download** those binary artifacts intact through the portal's existing download button (and through the CLI artifact picker).
3. Let users **open** a downloaded binary artifact with the OS's default viewer for that file type — Excel for `.xlsx`, Preview for `.pdf`, etc. — explicitly out-of-process from the portal/CLI UI.
4. Make the portal viewer **refuse to preview** binary artifacts (no garbled hex, no broken Markdown render, no decode attempt). Show a "binary file — download to open" affordance instead.
5. Remain backward compatible with the existing text-only artifact callers.
6. Keep the implementation in the existing artifact code path — no new storage tier, no new auth surface, no new RPC stream.

## Non-Goals

- In-portal previewing of binary content (PDF render, image render, spreadsheet preview). Out of scope; users open binaries in the right local app.
- Streaming uploads / downloads larger than the bumped cap (see *Size limits* below).
- Versioning or revision history of artifacts.
- Sandboxed execution of downloaded binaries.
- Image attachments into the chat pane for the model to consume. Tracked in a follow-up proposal; this one is the prerequisite.

## Resolved Decisions

These were open in the previous draft and are now committed:

| # | Decision | Notes |
|---|----------|-------|
| 1 | Wire encoding | **base64** at every cross-process boundary (tool params, JSON-RPC, WebSocket frames). `Buffer` only inside the SDK process. |
| 2 | Binary cap | **10 MB** decoded. Env override: `PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES`. |
| 3 | Magic-byte sniff | **In v1.** Use `file-type` (npm). On declared-vs-detected mismatch, **reject** the upload (no warn-and-allow). |
| 4 | `read_artifact(encoding: "base64")` exposed as a tool? | **No.** SDK API only. Agents that need raw bytes use `export_artifact` and let the user / host handle the binary. Keeps base64 blobs out of the model context. |
| 5 | `binary_content: Buffer` field on the tool schema | **Removed.** Tools always use `encoding: "base64"` + `content: string`. `Buffer` is reserved for the in-process SDK API. |
| 6 | Text vs binary classifier | Explicit allowlist (see below). |

## Design

### Data model

Add `content_type` and `is_binary` to artifact metadata. Storage in blob is already binary-clean — only the SDK / portal / CLI text decoders need work.

Metadata shape returned by `listArtifacts`:

```ts
type ArtifactMetadata = {
  filename: string;
  size_bytes: number;        // decoded byte length
  content_type: string;      // canonical MIME, normalized server-side
  is_binary: boolean;        // derived from content_type
  uploaded_at: string;       // ISO-8601
  source: "agent" | "user" | "system";
};
```

`is_binary` is **derived server-side** from `content_type` using an explicit allowlist. Anything matching the allowlist below is text; everything else is binary:

```
text/*
application/json
application/x-yaml      (alias: application/yaml — normalized to text/yaml on write)
application/xml
application/javascript
application/x-ndjson
image/svg+xml
```

Everything else (including `application/octet-stream`, `application/vnd.openxmlformats-*`, `application/pdf`, `application/zip`, `image/png`, `image/jpeg`, …) is binary.

`listArtifacts` shape change is **additive**. Existing callers that consumed `string[]` will keep working: the wire response becomes `{ files: ArtifactMetadata[], filenames: string[] }`. The `filenames` field is the legacy shape, kept until v2.

### SDK — `uploadArtifact` / `downloadArtifact`

The `ArtifactStore` interface gains a Buffer-clean overload and a metadata return:

```ts
// session-store.ts
export interface ArtifactStore {
  uploadArtifact(
    sessionId: string,
    filename: string,
    content: string | Buffer,           // string => UTF-8 text artifact
    contentType?: string,
    opts?: { encoding?: "utf-8" | "base64"; source?: "agent" | "user" | "system" }
  ): Promise<ArtifactMetadata>;

  downloadArtifact(
    sessionId: string,
    filename: string
  ): Promise<{ contentType: string; isBinary: boolean; sizeBytes: number; body: Buffer }>;

  listArtifacts(sessionId: string): Promise<ArtifactMetadata[]>;
  artifactExists(sessionId: string, filename: string): Promise<boolean>;

  // New helper for legacy text callers — throws if the artifact is binary.
  downloadArtifactText(sessionId: string, filename: string): Promise<string>;
}
```

Behaviour rules:

- **`content: string`** with `encoding: "utf-8"` (default) → write as UTF-8 bytes, `content_type` defaults to `text/markdown`.
- **`content: string`** with `encoding: "base64"` → decode base64, write raw bytes, `content_type` must be supplied.
- **`content: Buffer`** → write as-is, `content_type` must be supplied (no default).
- All paths run **magic-byte sniff** on the resolved bytes; reject with `ARTIFACT_CONTENT_TYPE_MISMATCH` if the declared type's family disagrees with the sniff (e.g. declared `application/pdf` but bytes start with `PK\x03\x04`).
- **Size cap** is enforced on the decoded byte length, against `MAX_TEXT_BYTES = 1 MB` for text-classified content and `MAX_BINARY_BYTES = 10 MB` (env override) for binary-classified content.

Both `SessionBlobStore` (Azure) and `FilesystemArtifactStore` (local mode) implement the same contract. The blob path layout (`artifacts/<sessionId>/<filename>`) is unchanged. Metadata for blob is read from the blob's `Content-Type` header + `Content-Length` + `Last-Modified`. For the filesystem store, the file mtime is the `uploaded_at`, the size from `stat`, and the content type comes from a sidecar `<filename>.meta.json` (created on upload, written atomically). If the sidecar is missing, content type is re-detected from the bytes via magic-byte sniff with `guessArtifactContentType` as the fallback.

### SDK — `write_artifact` tool

Tool schema (handler in [`packages/sdk/src/artifact-tools.ts`](../../packages/sdk/src/artifact-tools.ts)):

```jsonc
{
  "filename":     "M61_payload.xlsx",
  "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "encoding":     "base64",                    // "utf-8" (default) | "base64"
  "content":      "<base64 string>"
}
```

- `encoding` defaults to `"utf-8"`. When omitted, all existing callers behave identically.
- `content_type` is **required** when `encoding === "base64"`. We reject with a clear error rather than guess.
- The 1 MB cap stays for the text path; the 10 MB cap applies only when the resolved artifact is binary.

`read_artifact` is **unchanged** for v1. It only reads UTF-8 text; on a binary artifact it returns `{ error: "ARTIFACT_IS_BINARY", content_type, size_bytes }` so the agent can react cleanly. We do **not** add a base64 read mode to the tool surface (resolved decision #4).

`list_artifacts` returns full metadata records, not just filenames. Backward compat: the response `success` field is preserved and `files` becomes the array of records; we add `filenames` (legacy) until v2.

`export_artifact` is unchanged — the `artifact://` URI is opaque and works for binary too.

### Portal — server

[`packages/portal/server.js`](../../packages/portal/server.js):

```js
app.get("/api/sessions/:sessionId/artifacts/:filename/download", requireAuth, async (req, res) => {
  const { sessionId, filename } = req.params;
  const { contentType, body } = await runtime.downloadArtifact(sessionId, filename);
  res.setHeader("content-type", contentType || "application/octet-stream");
  res.setHeader("content-disposition", `attachment; filename="${path.basename(filename)}"`);
  res.send(body);  // Buffer, not string
});
```

New endpoint for cheap metadata lookups (powers the "is this binary?" check before download):

```
GET /api/sessions/:sessionId/artifacts/:filename/meta
→ { size_bytes, content_type, is_binary, uploaded_at }
```

[`packages/portal/runtime.js`](../../packages/portal/runtime.js) gains a matching `getArtifactMetadata(sessionId, filename)` switch case routed to the transport. The browser-side WebSocket RPC for `downloadArtifact` returns `{ content_type, is_binary, size_bytes, body_base64 }` — base64 over the wire (resolved decision #1). The browser converts to a `Blob` via `Uint8Array.from(atob(body_base64), c => c.charCodeAt(0))` for binary, or `atob` + UTF-8 decode for text.

### Portal — UI

`MarkdownViewer` becomes `ArtifactViewer`:

1. Calls `/meta` first (or reads `is_binary` from the already-loaded artifact list).
2. If `is_binary`, renders the placeholder card:

   ```
   ┌─────────────────────────────────────────┐
   │ [icon by content_type]  M61_payload.xlsx │
   │ application/vnd.openxmlformats-...       │
   │ 86 KB                                    │
   │                                          │
   │ [ Download ]                             │
   └─────────────────────────────────────────┘
   ```

   No decode attempt. No `<iframe>`. No syntax highlighting. The single `Download` button triggers the existing `/download` URL — the OS handles the registered application from there. (The browser cannot legally launch local apps directly, so a separate "Open externally" button is misleading; we ship a single Download button.)

3. If text, the existing Markdown / preview code path runs unchanged.

### CLI / TUI

The native TUI's artifact picker already has `[D]ownload`. Two changes:

1. **Add `[O]pen externally`** alongside `[D]ownload`. After downloading to the configured export directory, shell out via `spawnDetached` (already in `node-sdk-transport.js`):
   - macOS: `open <path>`
   - Linux: `xdg-open <path>`
   - Windows: `start "" <path>`
2. **Extend `guessArtifactContentType`** with the binary types:

   ```js
   ".xlsx":  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
   ".docx":  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
   ".pptx":  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
   ".pdf":   "application/pdf",
   ".zip":   "application/zip",
   ".tar":   "application/x-tar",
   ".tgz":   "application/gzip",
   ".gz":    "application/gzip",
   ".png":   "image/png",
   ".jpg":   "image/jpeg",
   ".jpeg":  "image/jpeg",
   ".gif":   "image/gif",
   ".webp":  "image/webp",
   ".bin":   "application/octet-stream",
   ```

   The unknown-extension fallback stays `text/plain` but the consumer must respect `is_binary` (which comes from the SDK now, not the CLI guess).

### Storage layout

Unchanged: `artifacts/<sessionId>/<filename>` in the blob container, or `<artifactDir>/<sessionId>/<filename>` on the filesystem store. The filesystem store gains a sibling `<filename>.meta.json` written atomically (`.meta.json.tmp` → `rename`) so the metadata survives process restarts. Sidecars are excluded from `listArtifacts` results (they aren't real artifacts).

### Size limits

- **Text artifacts**: 1 MB decoded (unchanged).
- **Binary artifacts**: 10 MB decoded. Configurable via `PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES`. Wire payload is up to ~13.5 MB base64 — fits comfortably under the WebSocket default 100 MB frame and Express's default 100 KB JSON body limit (we bump portal `bodyParser.json({ limit: "25mb" })` to accommodate the upload path; download is `res.send(Buffer)` so no body cap applies).
- Cap is enforced **server-side on the decoded bytes**, not on the base64 string length. Errors are explicit (`ARTIFACT_TOO_LARGE` with `max_bytes` and `actual_bytes`) — never silent truncation.

### Atomicity

`uploadArtifact` performs a single `BlockBlobClient.upload(body, length, ...)` call which is atomic at the Azure level: the blob either appears with the full content + the new headers, or it does not appear at all. Failed uploads do not leave partial blobs visible to readers because Azure commits the block list as one operation.

For the filesystem store, write to `<filename>.tmp` then `fs.rename` to the final name (POSIX atomic on the same filesystem).

No partial-write semantics exposed to callers; either the artifact appears with full bytes + correct metadata, or the call throws.

## Backward Compatibility

- `write_artifact({content: "<string>"})` callers behave identically — no `encoding` defaults to `"utf-8"`, content type defaults to `text/markdown`, `is_binary: false`, 1 MB cap.
- Legacy `downloadArtifact` consumers that expect `string` continue to work: the SDK exports `downloadArtifactText` for the text-only path. The new buffer-returning `downloadArtifact` is the recommended surface.
- The portal download URL format is unchanged. For an existing markdown artifact the on-the-wire response bytes are identical (same content, but `Content-Type` now `text/markdown` instead of `text/plain`).
- `list_artifacts` tool response keeps the legacy `filenames: string[]` field alongside the new `files: ArtifactMetadata[]`.

## Security Considerations

1. **Filename sanitation.** Existing `replace(/[/\\]/g, "_")` in `artifactBlobPath` and `safePath` is unchanged.
2. **Magic-byte sniff.** Mandatory in v1 (resolved decision #3). Runs on the decoded buffer before commit. Mismatch between declared `content_type` family and detected family throws `ARTIFACT_CONTENT_TYPE_MISMATCH` and the upload is rejected. Family granularity (e.g. detected `application/zip` matches declared `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` because xlsx is a zip) is handled by a small allowlist of synonyms.
3. **No automatic execution.** `Open externally` only runs after an explicit user keypress / click. The portal never auto-launches.
4. **Content-Disposition: attachment** for every download — never `inline` — so browsers never auto-render even when the type would normally render in-browser.
5. **MIME-confusion in the viewer.** `ArtifactViewer` consults `is_binary` *before* any decode attempt. Binary artifacts never reach the Markdown renderer.
6. **Cap enforcement.** Server-side on decoded bytes; both `write_artifact` and the `uploadArtifact` SDK call reject oversize with explicit errors.
7. **Allowlist of openers.** The `Open externally` shell-out uses a fixed `open` / `xdg-open` / `start` based on `process.platform`. The artifact filename is sanitized before being passed; we never invoke a shell with `shell: true`.
8. **No SVG render.** SVG is in the text allowlist (so listing knows it's text and lets `read_artifact` return it) but the portal's `ArtifactViewer` does **not** render SVG inline — it falls back to the binary placeholder card. SVG is a script-execution surface and we don't need to render it in v1.

## Migration Plan

Phase 1 — **SDK + storage** (one PR):

- `ArtifactStore` interface change: Buffer overload, metadata return shape, `downloadArtifactText` helper.
- `SessionBlobStore.uploadArtifact` / `downloadArtifact` / `listArtifacts` updated.
- `FilesystemArtifactStore` ditto + sidecar metadata file.
- `write_artifact` tool gains `encoding` parameter; `read_artifact` returns `ARTIFACT_IS_BINARY` for binary; `list_artifacts` returns metadata.
- `file-type` dependency added; magic-byte sniff in upload path.
- `MAX_BINARY_BYTES` constant + env override.
- Unit tests (see Testing Plan below).

Phase 2 — **Portal server + RPC** (small follow-up PR):

- Switch `/download` endpoint to `Buffer.send` + `Content-Type` from artifact metadata.
- New `/meta` endpoint.
- `runtime.js` gains `getArtifactMetadata`; `downloadArtifact` returns `{content_type, is_binary, size_bytes, body_base64}` over RPC; HTTP `/download` continues to stream raw bytes.
- Bump `bodyParser.json` limit to 25 MB to accommodate base64 uploads.
- Integration test through `runtime.call("downloadArtifact", ...)` for both text and binary fixtures.

Phase 3 — **Portal UI** (separate PR):

- `MarkdownViewer` → `ArtifactViewer` with binary-aware rendering; placeholder card for binary; existing markdown path for text.
- Browser-side `Blob` reconstruction from base64 RPC payload + `URL.createObjectURL` for the Download anchor.
- Visual test (manual) with `.xlsx`, `.pdf`, `.png`.

Phase 4 — **CLI / TUI** (separate PR):

- `[O]pen externally` action in the artifact picker.
- `guessArtifactContentType` table extension.
- `spawnDetached` reuse for the OS-native opener.
- TUI test for the picker action (assertion on the spawn call, mocked).

Phase 5 — **Docs + samples**:

- New "Binary artifacts" section in [`docs/sdk/`](../../docs/sdk/) covering the write/read shape, the cap, and the encoding contract.
- Update [`templates/builder-agents/`](../../templates/builder-agents/) read-me and any agent skill that mentions artifacts.
- Add a working sample to [`examples/devops-command-center/`](../../examples/devops-command-center/) that writes a binary artifact (small `.zip` of a generated payload) and serves it through the portal download.

Each phase is independently shippable. End-to-end binary download works after Phase 2; the no-preview UX lands with Phase 3.

## Public API Surface Diff

| Symbol | Before | After |
|---|---|---|
| `ArtifactStore.uploadArtifact` | `(id, name, content: string, ct?) => string` | `(id, name, content: string \| Buffer, ct?, opts?) => ArtifactMetadata` |
| `ArtifactStore.downloadArtifact` | `(id, name) => string` | `(id, name) => { contentType, isBinary, sizeBytes, body: Buffer }` |
| `ArtifactStore.downloadArtifactText` | — | `(id, name) => string` (throws on binary) |
| `ArtifactStore.listArtifacts` | `(id) => string[]` | `(id) => ArtifactMetadata[]` |
| `write_artifact` tool params | `{filename, content, contentType?}` | `{filename, content, content_type?, encoding?}` |
| `read_artifact` tool result | `{success, content, sizeBytes}` | same on text; `{error: "ARTIFACT_IS_BINARY", content_type, size_bytes}` on binary |
| `list_artifacts` tool result | `{success, files: string[], count}` | `{success, files: ArtifactMetadata[], filenames: string[], count}` |
| Portal `/download` response body | UTF-8 string in `text/plain` | raw bytes in `Content-Type` from metadata |
| Portal `/meta` endpoint | — | `{size_bytes, content_type, is_binary, uploaded_at}` |

## Testing Plan

Tests live in the repo's existing structure: SDK tests in `packages/sdk/test/local/`, portal tests in `packages/portal/test/` (or as part of an SDK suite that exercises the runtime), CLI tests in `packages/cli/test/`. New suites are added to [`scripts/run-tests.sh`](../../scripts/run-tests.sh) and the `test:local` script in [`packages/sdk/package.json`](../../packages/sdk/package.json) per the test-integrity rules in `.github/copilot-instructions.md` (no retries, no hacks, no custom system prompts to compensate for product behavior, raise failures loudly).

### Phase 1 — SDK + storage

New file `packages/sdk/test/local/artifacts-binary.test.js`. Backed by both stores (parameterized `describe` block running each test against `SessionBlobStore` with Azurite and `FilesystemArtifactStore`).

| ID | What it asserts |
|---|---|
| BA-1 | `uploadArtifact(content: Buffer, contentType: "application/pdf")` round-trips: the bytes downloaded match the bytes uploaded exactly (`Buffer.compare === 0`). |
| BA-2 | `uploadArtifact(content: "<base64>", {encoding: "base64"}, "image/png")` decodes correctly: the resulting blob bytes equal the raw bytes the base64 was generated from. |
| BA-3 | `downloadArtifact` for a text artifact returns `{isBinary: false, contentType: "text/markdown", body: <Buffer>}` and `body.toString("utf-8")` equals the original string. |
| BA-4 | `downloadArtifactText` on a binary artifact throws with `code === "ARTIFACT_IS_BINARY"` (or message matches that token). |
| BA-5 | `listArtifacts` returns `ArtifactMetadata[]` including a mix of text and binary entries with correct `is_binary` derived from `content_type`. |
| BA-6 | Magic-byte mismatch is rejected: declare `application/pdf` but pass PNG bytes → throws `ARTIFACT_CONTENT_TYPE_MISMATCH`. The blob is **not** created (verified by `artifactExists === false` afterwards). |
| BA-7 | Magic-byte synonym allowance: declare `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and pass real `.xlsx` bytes (zip family) → succeeds. |
| BA-8 | Text size cap: 1 MB + 1 byte text artifact rejected with `ARTIFACT_TOO_LARGE`, `max_bytes === 1_048_576`. |
| BA-9 | Binary size cap: 10 MB + 1 byte binary artifact rejected with `ARTIFACT_TOO_LARGE`, `max_bytes === 10_485_760`. |
| BA-10 | Binary cap respects `PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES` env override (set to 2 MB in the test, upload 3 MB → reject; upload 1 MB → succeed). |
| BA-11 | Backward compat: existing call shape `uploadArtifact(id, name, "hello")` still works, classified as text, content type `text/markdown`, `is_binary: false`. |
| BA-12 | Filesystem sidecar atomicity: kill the process *between* writing `.tmp` and `rename` (simulated by overriding `fs.rename` to throw), then re-list — the artifact is **not** visible (no half-state). |
| BA-13 | Filesystem sidecar reload: write an artifact, delete the in-memory store object, instantiate a new `FilesystemArtifactStore` against the same dir, list and download — metadata is recovered from the sidecar and bytes round-trip. |
| BA-14 | Sidecar fallback: delete the sidecar but keep the bytes; list still returns the artifact with `content_type` re-detected via magic-byte sniff. |

Tool-layer tests in `packages/sdk/test/local/artifacts-binary-tools.test.js`:

| ID | What it asserts |
|---|---|
| BAT-1 | `write_artifact` tool with `encoding: "base64"` and `content_type: "application/pdf"` writes a downloadable PDF; `list_artifacts` reports `is_binary: true`. |
| BAT-2 | `write_artifact` with `encoding: "base64"` but no `content_type` returns `{ error: "...content_type required..." }`. |
| BAT-3 | `read_artifact` on a binary file returns `{ error: "ARTIFACT_IS_BINARY", content_type, size_bytes }` (no garbled UTF-8 string in the result). |
| BAT-4 | `read_artifact` on a text file is unchanged (success + content). |
| BAT-5 | `list_artifacts` tool result has both `files: ArtifactMetadata[]` and `filenames: string[]` populated correctly. |
| BAT-6 | `export_artifact` works for binary artifacts (returns `artifact://...` URI; underlying bytes still downloadable). |

### Phase 2 — Portal server + RPC

New file `packages/sdk/test/local/portal-artifacts-binary.test.js` (uses the existing `PortalRuntime` test scaffolding):

| ID | What it asserts |
|---|---|
| PA-1 | `runtime.call("downloadArtifact", {sessionId, filename})` for a binary artifact returns `{ content_type, is_binary: true, size_bytes, body_base64 }`. Decoded base64 matches original bytes. |
| PA-2 | `runtime.call("getArtifactMetadata", ...)` returns the same shape as `/api/.../meta` response for a binary file. |
| PA-3 | HTTP `GET /api/sessions/:id/artifacts/:f/download` for a `.pdf` returns `Content-Type: application/pdf`, `Content-Disposition: attachment`, and the response body bytes equal the source bytes (use `supertest` with `.responseType("arraybuffer")`). |
| PA-4 | HTTP `/download` for a `.md` returns `Content-Type: text/markdown` and the bytes equal the original markdown. |
| PA-5 | HTTP `/meta` returns `200 { size_bytes, content_type, is_binary, uploaded_at }` for an existing artifact and `404` for a missing one. |
| PA-6 | Body parser limit accepts a 13 MB JSON RPC payload (10 MB binary + base64 overhead) and rejects 30 MB cleanly with HTTP 413. |

### Phase 3 — Portal UI

Manual visual verification (no React test runner in the portal yet):

| ID | What |
|---|---|
| PU-1 | Upload a `.xlsx` via `write_artifact` from a sample agent; open the session in the portal; confirm the file viewer shows the binary placeholder card with filename, content type, and size. No Markdown render attempted. |
| PU-2 | Click `Download` on the binary card; the browser saves the file with the correct extension and the file opens cleanly in Excel. |
| PU-3 | Existing `.md` artifact still renders with the Markdown preview (regression). |
| PU-4 | `.pdf` artifact card shows correct icon (or generic file icon) and downloads cleanly; opens in Preview / Acrobat. |

A short Playwright spec is added under `packages/portal/test/e2e/artifact-binary.spec.ts`:

| ID | What it asserts |
|---|---|
| PE-1 | Page loads a session with a binary artifact in the list; clicking the file row renders an element with `[data-testid="artifact-binary-placeholder"]`. |
| PE-2 | The download anchor's `download` attribute equals the filename and the `href` resolves to the `/download` URL. |
| PE-3 | A text artifact in the same session does **not** render the binary placeholder; the markdown preview container is present. |

### Phase 4 — CLI / TUI

Tests in `packages/cli/test/local/artifact-picker-binary.test.js` (vitest, mocking `child_process.spawn`):

| ID | What it asserts |
|---|---|
| CL-1 | `[O]pen externally` on a `.pdf` artifact downloads the bytes to the configured export dir and invokes `spawn("open", [<path>], {detached: true, stdio: "ignore"})` on macOS, `xdg-open` on Linux, `start` on Windows (parameterized via mocked `process.platform`). |
| CL-2 | `[D]ownload` (existing) still works for text artifacts and writes UTF-8 content. |
| CL-3 | `[D]ownload` for a binary artifact writes the raw bytes (not UTF-8 decoded). Compare against fixture buffer. |
| CL-4 | `guessArtifactContentType` returns the right type for every entry in the new table; unknown extensions return `text/plain`. |

### Cross-cutting

| ID | What it asserts |
|---|---|
| X-1 | **Replay safety.** A session with a binary `write_artifact` call is dehydrated (forced via `worker.dehydrate`) and rehydrated on a different worker process; the artifact is still listable, downloadable, and its bytes match. Lives in `packages/sdk/test/local/multi-worker.test.js` as a new case. |
| X-2 | **Tool replay.** Re-running the orchestration after a worker crash mid-`write_artifact` does not produce two copies of the artifact (idempotency: blob upload uses the same path; second upload overwrites). Asserted in `packages/sdk/test/local/reliability-crash.test.js`. |
| X-3 | **System agent unaffected.** PilotSwarm/Sweeper/ResourceMgr behavior unchanged when binary artifacts exist (regression sanity check via `system-agents.test.js` adding a binary fixture to the seeded session). |

### Test fixtures

Add a small `packages/sdk/test/fixtures/artifacts/` directory containing:

- `tiny.pdf` (~2 KB)
- `tiny.png` (~500 B, valid 1×1 PNG)
- `tiny.xlsx` (~6 KB, generated by the same `xlsx` tooling the sample uses)
- `tiny.zip` (a 100-byte zip containing one empty file)

These are checked in (small enough). Larger-cap tests synthesize buffers in-process (`Buffer.alloc(11 * 1024 * 1024)` etc.).

### Pre-deploy gate

All new suites are added to [`scripts/run-tests.sh`](../../scripts/run-tests.sh)'s `SUITES` array and the `test:local` npm script. The deploy script's pre-deploy gate runs them automatically, so a regression in the binary path blocks AKS rollout.

## Open Questions

(All previous open questions are resolved above. Listing remaining genuinely-open items here for tracking.)

1. **Per-content-type icons in the placeholder card.** Cosmetic; v1 ships a single generic file icon, typed icons (`.xlsx`, `.pdf`, `.png`, …) added later if usage warrants.
2. **Sidecar format for the filesystem store.** JSON is fine and matches the rest of the SDK. Worth migrating to a SQLite metadata table later if listing many sessions becomes slow.
3. **Replacing `file-type`.** It's a heavy dependency for a single magic-byte sniff. Consider a 50-line inline detector for the ~10 MIME types we actually care about, after we see real perf impact.
