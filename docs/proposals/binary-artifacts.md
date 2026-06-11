# Proposal: Binary Artifacts (Store, Download, Open in Default Viewer)

**Status:** Approved (implementation-ready, revised v1)
**Date:** 2026-04-19
**Author:** Waldemort team (filed cross-repo per copilot-instructions.md repo-boundary rule)

## Problem

Artifacts in PilotSwarm are still text-oriented across the owning code paths:

- `write_artifact` accepts `content: string` and writes UTF-8 bytes ([`packages/sdk/src/artifact-tools.ts`](../../packages/sdk/src/artifact-tools.ts) — `writeTool`).
- `uploadArtifact(sessionId, filename, content, contentType?)` writes the JS string directly into Azure Blob or the filesystem store ([`packages/sdk/src/blob-store.ts`](../../packages/sdk/src/blob-store.ts) and [`packages/sdk/src/session-store.ts`](../../packages/sdk/src/session-store.ts) — `uploadArtifact`).
- `downloadArtifact` returns `Buffer.concat(...).toString("utf-8")` in blob mode and `fs.readFileSync(..., "utf-8")` in filesystem mode ([`packages/sdk/src/blob-store.ts`](../../packages/sdk/src/blob-store.ts) and [`packages/sdk/src/session-store.ts`](../../packages/sdk/src/session-store.ts) — `downloadArtifact`).
- The portal download endpoint pipes that string back to the browser as `text/plain; charset=utf-8` ([`packages/portal/server.js`](../../packages/portal/server.js) — `/api/sessions/:sessionId/artifacts/:filename/download`).
- The local transport saves downloaded artifacts as UTF-8 text and still guesses content types from a small text-only list (`md / json / html / csv / yaml`, default `text/plain`) ([`packages/cli/src/node-sdk-transport.js`](../../packages/cli/src/node-sdk-transport.js) — `guessArtifactContentType`, `saveArtifactDownload`).
- The shared file-browser/preview logic lives in `packages/ui-core/`, not in a portal-only viewer component. That shared path currently lists artifacts as plain filenames and relies on filename-only heuristics for binary preview avoidance, rather than metadata-driven binary handling.

The 1 MB cap and the UTF-8 round-trip both assume text. The current UI already refuses preview for some binary-looking extensions by filename, but it still lacks binary-safe downloads and content-type-driven classification. Pushing an `.xlsx`, `.pdf`, `.zip`, or `.png` through the existing pipe corrupts it on download and leaves preview behavior dependent on incomplete heuristics instead of authoritative metadata.

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
- Browser-host binary uploads from the local file picker in v1. This proposal focuses on agent / SDK writes plus intact download and open flows. Local host-upload parity can follow as adjacent work if needed.
- Image attachments into the chat pane for the model to consume. Tracked in a follow-up proposal; this one is the prerequisite.

## Resolved Decisions

These were open in the previous draft and are now committed:

| # | Decision | Notes |
|---|----------|-------|
| 1 | Wire encoding | **base64 only on JSON-shaped boundaries that actually carry bytes** (for example `write_artifact` tool params). Raw HTTP download stays raw bytes. `Buffer` only inside the SDK process. |
| 2 | Binary cap | **10 MB** decoded. Env override: `PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES`. |
| 3 | Magic-byte sniff | **In v1.** Use `file-type` (npm). On declared-vs-detected mismatch, **reject** the upload (no warn-and-allow). |
| 4 | `read_artifact(encoding: "base64")` exposed as a tool? | **No.** SDK API only. Agents that need raw bytes use `export_artifact` and let the user / host handle the binary. Keeps base64 blobs out of the model context. |
| 5 | `binary_content: Buffer` field on the tool schema | **Removed.** Tools always use `encoding: "base64"` + `content: string`. `Buffer` is reserved for the in-process SDK API. |
| 6 | Text vs binary classifier | Explicit allowlist (see below). |
| 7 | Public naming / compatibility | **Keep existing camelCase names on public JS/TS surfaces** (`contentType`, `sizeBytes`, `isBinary`, `uploadedAt`). The `write_artifact` handler may accept `content_type` as a permissive alias, but docs and typed APIs stay camelCase. |

## Design

### Data model

Add `contentType` and `isBinary` to artifact metadata. Storage in blob is already binary-clean; the SDK, transports, and shared UI need to stop decoding everything as text.

Metadata shape returned by `listArtifacts`:

```ts
type ArtifactMetadata = {
  filename: string;
  sizeBytes: number;         // decoded byte length
  contentType: string;       // canonical MIME, normalized server-side
  isBinary: boolean;         // derived from contentType
  uploadedAt: string;        // ISO-8601
  source: "agent" | "user" | "system";
};
```

`isBinary` is **derived server-side** from `contentType` using an explicit allowlist. Anything matching the allowlist below is text; everything else is binary:

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

`ArtifactStore.listArtifacts()` changes to `ArtifactMetadata[]`. Tool responses keep a legacy `filenames: string[]` field until v2. Shared UI callers that currently assume `string[]` are updated in the same change series to normalize metadata records while preserving filename-based selection state.

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

- **`content: string`** with `encoding: "utf-8"` (default) → write as UTF-8 bytes, `contentType` defaults to `text/markdown`.
- **`content: string`** with `encoding: "base64"` → decode base64, write raw bytes, `contentType` must be supplied.
- **`content: Buffer`** → write as-is, `contentType` must be supplied (no default).
- All paths run **magic-byte sniff** on the resolved bytes; reject with `ARTIFACT_CONTENT_TYPE_MISMATCH` if the declared type's family disagrees with the sniff (e.g. declared `application/pdf` but bytes start with `PK\x03\x04`).
- **Size cap** is enforced on the decoded byte length, against `MAX_TEXT_BYTES = 1 MB` for text-classified content and `MAX_BINARY_BYTES = 10 MB` (env override) for binary-classified content.

Both `SessionBlobStore` (Azure) and `FilesystemArtifactStore` (local mode) implement the same contract. The blob path layout (`artifacts/<sessionId>/<filename>`) is unchanged. Metadata for blob is read from the blob's `Content-Type` header + `Content-Length` + `Last-Modified`. For the filesystem store, the file mtime is the `uploadedAt`, the size from `stat`, and the content type comes from a sidecar `<filename>.meta.json` (created on upload, written atomically). If the sidecar is missing, content type is re-detected from the bytes via magic-byte sniff with `guessArtifactContentType` as the fallback.

### SDK — `write_artifact` tool

Tool schema (handler in [`packages/sdk/src/artifact-tools.ts`](../../packages/sdk/src/artifact-tools.ts)):

```jsonc
{
  "filename":     "M61_payload.xlsx",
  "contentType":  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "encoding":     "base64",                    // "utf-8" (default) | "base64"
  "content":      "<base64 string>"
}
```

- `encoding` defaults to `"utf-8"`. When omitted, all existing callers behave identically.
- `contentType` is **required** when `encoding === "base64"`. We reject with a clear error rather than guess.
- To avoid breaking current callers, `contentType` remains the canonical v1 field. The handler may also accept `content_type` as an alias and normalize it immediately.
- The 1 MB cap stays for the text path; the 10 MB cap applies only when the resolved artifact is binary.

`read_artifact` is **unchanged** for v1. It only reads UTF-8 text; on a binary artifact it returns `{ error: "ARTIFACT_IS_BINARY", contentType, sizeBytes }` so the agent can react cleanly. We do **not** add a base64 read mode to the tool surface (resolved decision #4).

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

Optional endpoint for cheap metadata lookups (used as a fallback when list metadata is not already in state):

```
GET /api/sessions/:sessionId/artifacts/:filename/meta
→ { sizeBytes, contentType, isBinary, uploadedAt }
```

[`packages/portal/runtime.js`](../../packages/portal/runtime.js) gains a matching `getArtifactMetadata(sessionId, filename)` switch case routed to the transport. `listArtifacts` over RPC returns metadata records. The existing browser-side `downloadArtifact` RPC remains a **text preview** surface backed by `downloadArtifactText`; binary requests fail with `ARTIFACT_IS_BINARY`. The browser's actual save/download flow continues to use the HTTP `/download` route and does **not** add a second base64 byte tunnel in v1.

### Shared UI / Portal UI

The controlling file-browser and preview logic lives in `packages/ui-core/`, consumed by both the native TUI and the portal web host. V1 updates that shared path instead of bolting on a second portal-only viewer beside it.

1. `listArtifacts` entries become metadata records in shared state; selection still keys on `filename`.
2. `ensureFilePreview()` consults `isBinary` from the loaded metadata (or `getArtifactMetadata` fallback) **before** any download attempt.
3. If `isBinary`, shared preview state becomes a note / placeholder payload instead of text content:

   ```
   ┌─────────────────────────────────────────┐
  │ [generic file icon]  M61_payload.xlsx    │
  │ application/vnd.openxmlformats-...       │
   │ 86 KB                                    │
   │                                          │
  │ Download to open in the default app      │
   └─────────────────────────────────────────┘
   ```

4. Browser host renders a single `Download` affordance backed by the existing `/download` URL. The browser cannot legally launch local apps directly, so it must not advertise `Open externally`.
5. Native TUI keeps its existing open-in-default-app flow after local download.
6. Text artifacts continue through the existing markdown / text preview code path.

### CLI / TUI

The native TUI already has download and open flows in the shared controller. V1 changes are narrower than the earlier draft implied:

1. **Keep existing open-in-default-app behavior working** by making `saveArtifactDownload()` write raw bytes for binary artifacts instead of UTF-8 strings.
2. **Extend `guessArtifactContentType`** with the binary types for the local helpers that still infer MIME from extensions:

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

  The unknown-extension fallback stays `text/plain`, but preview and download behavior must respect `isBinary` from SDK metadata instead of relying on the guessed extension.
3. **Align host-specific affordances.** The browser host stays download-only; the native TUI keeps download + open. Any keybinding hints or picker copy that mentions open/download must reflect that split.

### Storage layout

Unchanged: `artifacts/<sessionId>/<filename>` in the blob container, or `<artifactDir>/<sessionId>/<filename>` on the filesystem store. The filesystem store gains a sibling `<filename>.meta.json` written atomically (`.meta.json.tmp` → `rename`) so the metadata survives process restarts. Sidecars are excluded from `listArtifacts` results (they aren't real artifacts).

### Size limits

- **Text artifacts**: 1 MB decoded (unchanged).
- **Binary artifacts**: 10 MB decoded. Configurable via `PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES`.
- Cap is enforced **server-side on the decoded bytes**, not on the base64 string length. Errors are explicit (`ARTIFACT_TOO_LARGE` with `max_bytes` and `actual_bytes`) — never silent truncation.

For v1, the browser's binary download path stays HTTP `res.send(Buffer)`, so no portal JSON-body limit bump is required. If a later phase adds browser-side binary upload over RPC, that phase must revisit request limits explicitly.

### Atomicity

`uploadArtifact` performs a single `BlockBlobClient.upload(body, length, ...)` call which is atomic at the Azure level: the blob either appears with the full content + the new headers, or it does not appear at all. Failed uploads do not leave partial blobs visible to readers because Azure commits the block list as one operation.

For the filesystem store, write to `<filename>.tmp` then `fs.rename` to the final name (POSIX atomic on the same filesystem).

No partial-write semantics exposed to callers; either the artifact appears with full bytes + correct metadata, or the call throws.

## Backward Compatibility

- `write_artifact({content: "<string>"})` callers behave identically — no `encoding` defaults to `"utf-8"`, content type defaults to `text/markdown`, `isBinary: false`, 1 MB cap.
- `write_artifact` keeps `contentType` as the canonical public field. The handler may accept `content_type` as an alias, but the docs and typed surfaces do not rename existing parameters.
- Legacy `downloadArtifact` consumers that expect `string` continue to work via `downloadArtifactText`. The new buffer-returning `downloadArtifact` is the recommended low-level surface.
- Portal/browser preview RPC stays text-only and fails clearly on binary (`ARTIFACT_IS_BINARY`). Binary bytes are downloaded through the existing HTTP `/download` route.
- The portal download URL format is unchanged. For an existing markdown artifact the on-the-wire response bytes are identical (same content, but `Content-Type` now `text/markdown` instead of `text/plain`).
- `list_artifacts` tool response keeps the legacy `filenames: string[]` field alongside the new `files: ArtifactMetadata[]`.
- Shared UI continues to key selection and download bookkeeping by filename even though list entries become metadata objects.

## Security Considerations

1. **Filename sanitation.** Existing `replace(/[/\\]/g, "_")` in `artifactBlobPath` and `safePath` is unchanged.
2. **Magic-byte sniff.** Mandatory in v1 (resolved decision #3). Runs on the decoded buffer before commit. Mismatch between declared `contentType` family and detected family throws `ARTIFACT_CONTENT_TYPE_MISMATCH` and the upload is rejected. Family granularity (e.g. detected `application/zip` matches declared `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` because xlsx is a zip) is handled by a small allowlist of synonyms.
3. **No automatic execution.** Native `Open externally` only runs after an explicit user keypress. The browser host exposes download only and never attempts to auto-launch a local app.
4. **Content-Disposition: attachment** for every download — never `inline` — so browsers never auto-render even when the type would normally render in-browser.
5. **MIME-confusion in the viewer.** The shared preview path consults `isBinary` *before* any decode attempt. Binary artifacts never reach the Markdown renderer.
6. **Cap enforcement.** Server-side on decoded bytes; both `write_artifact` and the `uploadArtifact` SDK call reject oversize with explicit errors.
7. **Allowlist of openers.** The native `Open externally` shell-out uses a fixed `open` / `xdg-open` / `start` based on `process.platform`. The artifact filename is sanitized before being passed; we never invoke a shell with `shell: true`.
8. **No SVG render.** SVG is in the text allowlist (so listing knows it's text and lets `read_artifact` return it) but the shared UI should still refuse to render it inline in v1 and fall back to the binary-style placeholder note. SVG is a script-execution surface and we do not need to render it.

## Migration Plan

Phase 1 — **SDK + storage** (one PR):

- `ArtifactStore` interface change: Buffer-clean upload/download, metadata return shape, `downloadArtifactText` helper.
- `SessionBlobStore.uploadArtifact` / `downloadArtifact` / `listArtifacts` updated.
- `FilesystemArtifactStore` ditto + sidecar metadata file.
- `write_artifact` tool gains `encoding`; `read_artifact` returns `ARTIFACT_IS_BINARY` for binary; `list_artifacts` returns metadata and keeps legacy `filenames`.
- Public tool naming stays camelCase; handler accepts `content_type` only as an alias.
- `file-type` dependency added; magic-byte sniff in upload path.
- `MAX_BINARY_BYTES` constant + env override.

Phase 2 — **Transports + portal server** (small follow-up PR):

- Switch `/download` endpoint to `res.send(Buffer)` + `Content-Type` from artifact metadata.
- Add `getArtifactMetadata(sessionId, filename)` and optional `/meta` endpoint.
- Update `NodeSdkTransport`, `PortalRuntime`, and the browser transport so `listArtifacts` returns metadata records.
- Keep browser preview download text-only by routing preview calls through `downloadArtifactText`; do **not** add a base64 binary-download RPC in v1.
- Make local save/download helpers write raw bytes for binary artifacts.

Phase 3 — **Shared UI + host affordances** (separate PR):

- Update `packages/ui-core/` controller / reducer / selectors / state to store `ArtifactMetadata` entries while preserving filename-based selection and download bookkeeping.
- Change preview gating from extension-only heuristics to `isBinary` metadata, with a metadata fallback probe when needed.
- Browser host renders download-only binary placeholder UX.
- Native TUI preserves download + open semantics.
- Remove or replace any stale portal-only placeholder viewer wiring so the repo has a single controlling artifact-view path.

Phase 4 — **Docs + samples**:

- New "Binary artifacts" section in [`docs/sdk/`](../../docs/sdk/) covering the write/read shape, compatibility naming, size limits, and encoding contract.
- Update [`templates/builder-agents/`](../../templates/builder-agents/) read-me and any agent skill that mentions artifacts.
- Add a working sample to [`examples/devops-command-center/`](../../examples/devops-command-center/) that writes a binary artifact (small `.zip` of a generated payload) and serves it through the portal download.

Each phase is independently shippable. Binary-safe SDK storage and raw-byte host download work after Phase 2; the metadata-driven no-preview UX lands with Phase 3.

## Public API Surface Diff

| Symbol | Before | After |
|---|---|---|
| `ArtifactStore.uploadArtifact` | `(id, name, content: string, ct?) => string` | `(id, name, content: string \| Buffer, ct?, opts?) => ArtifactMetadata` |
| `ArtifactStore.downloadArtifact` | `(id, name) => string` | `(id, name) => { contentType, isBinary, sizeBytes, body: Buffer }` |
| `ArtifactStore.downloadArtifactText` | — | `(id, name) => string` (throws on binary) |
| `ArtifactStore.listArtifacts` | `(id) => string[]` | `(id) => ArtifactMetadata[]` |
| `write_artifact` tool params | `{filename, content, contentType?}` | `{filename, content, contentType?, encoding?}` (`content_type` accepted as alias only) |
| `read_artifact` tool result | `{success, content, sizeBytes}` | same on text; `{error: "ARTIFACT_IS_BINARY", contentType, sizeBytes}` on binary |
| `list_artifacts` tool result | `{success, files: string[], count}` | `{success, files: ArtifactMetadata[], filenames: string[], count}` |
| Portal RPC `listArtifacts` | `string[]` | `ArtifactMetadata[]` |
| Portal RPC `downloadArtifact` | text content string | text content string for text; `ARTIFACT_IS_BINARY` on binary |
| Portal `getArtifactMetadata` | — | `{ filename, sizeBytes, contentType, isBinary, uploadedAt, source }` |
| Portal `/download` response body | UTF-8 string in `text/plain` | raw bytes in `Content-Type` from metadata |
| Portal `/meta` endpoint | — | `{ sizeBytes, contentType, isBinary, uploadedAt }` |

## Testing Plan

This repo's runnable local integration tests live under `packages/sdk/test/local/`, and [`scripts/run-tests.sh`](../../scripts/run-tests.sh) executes that tree via vitest. There is no separate checked-in `packages/portal/test/` harness today, so the proposal should place new automated portal/browser and transport tests under `packages/sdk/test/local/` unless we intentionally add a new harness and wire it into the script.

All new suites follow the existing test-integrity rules from `.github/copilot-instructions.md`: no retries, no hacks, no custom system prompts to compensate for product behavior, and failures raised loudly.

### Phase 1 — SDK + storage

New file `packages/sdk/test/local/artifacts-binary.test.js`. Backed by both stores (parameterized `describe` block running each test against `SessionBlobStore` with Azurite and `FilesystemArtifactStore`).

| ID | What it asserts |
|---|---|
| BA-1 | `uploadArtifact(content: Buffer, contentType: "application/pdf")` round-trips: the bytes downloaded match the bytes uploaded exactly (`Buffer.compare === 0`). |
| BA-2 | `uploadArtifact(content: "<base64>", contentType: "image/png", {encoding: "base64"})` decodes correctly: the resulting blob bytes equal the raw bytes the base64 was generated from. |
| BA-3 | `downloadArtifact` for a text artifact returns `{isBinary: false, contentType: "text/markdown", body: <Buffer>}` and `body.toString("utf-8")` equals the original string. |
| BA-4 | `downloadArtifactText` on a binary artifact throws with `code === "ARTIFACT_IS_BINARY"` (or message matches that token). |
| BA-5 | `listArtifacts` returns `ArtifactMetadata[]` including a mix of text and binary entries with correct `isBinary` derived from `contentType`. |
| BA-6 | Magic-byte mismatch is rejected: declare `application/pdf` but pass PNG bytes → throws `ARTIFACT_CONTENT_TYPE_MISMATCH`. The blob is **not** created (verified by `artifactExists === false` afterwards). |
| BA-7 | Magic-byte synonym allowance: declare `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and pass real `.xlsx` bytes (zip family) → succeeds. |
| BA-8 | Text size cap: 1 MB + 1 byte text artifact rejected with `ARTIFACT_TOO_LARGE`, `max_bytes === 1_048_576`. |
| BA-9 | Binary size cap: 10 MB + 1 byte binary artifact rejected with `ARTIFACT_TOO_LARGE`, `max_bytes === 10_485_760`. |
| BA-10 | Binary cap respects `PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES` env override (set to 2 MB in the test, upload 3 MB → reject; upload 1 MB → succeed). |
| BA-11 | Backward compat: existing call shape `uploadArtifact(id, name, "hello")` still works, classified as text, content type `text/markdown`, `isBinary: false`. |
| BA-12 | Filesystem sidecar atomicity: kill the process *between* writing `.tmp` and `rename` (simulated by overriding `fs.rename` to throw), then re-list — the artifact is **not** visible (no half-state). |
| BA-13 | Filesystem sidecar reload: write an artifact, delete the in-memory store object, instantiate a new `FilesystemArtifactStore` against the same dir, list and download — metadata is recovered from the sidecar and bytes round-trip. |
| BA-14 | Sidecar fallback: delete the sidecar but keep the bytes; list still returns the artifact with `contentType` re-detected via magic-byte sniff. |

Tool-layer tests in `packages/sdk/test/local/artifacts-binary-tools.test.js`:

| ID | What it asserts |
|---|---|
| BAT-1 | `write_artifact` with `encoding: "base64"` and `contentType: "application/pdf"` writes a downloadable PDF; `list_artifacts` reports `isBinary: true`. |
| BAT-2 | `write_artifact` accepts `content_type` as an alias but normalizes it to the canonical `contentType` metadata on output. |
| BAT-3 | `write_artifact` with `encoding: "base64"` but no `contentType` returns `{ error: "...contentType required..." }`. |
| BAT-4 | `read_artifact` on a binary file returns `{ error: "ARTIFACT_IS_BINARY", contentType, sizeBytes }` (no garbled UTF-8 string in the result). |
| BAT-5 | `read_artifact` on a text file is unchanged (success + content). |
| BAT-6 | `list_artifacts` tool result has both `files: ArtifactMetadata[]` and `filenames: string[]` populated correctly. |
| BAT-7 | `export_artifact` works for binary artifacts (returns `artifact://...` URI; underlying bytes still downloadable). |

### Phase 2 — Transports + portal server

New file `packages/sdk/test/local/portal-artifacts-binary.test.js` (uses the existing `PortalRuntime` test scaffolding):

| ID | What it asserts |
|---|---|
| PA-1 | `runtime.call("listArtifacts", {sessionId})` returns `ArtifactMetadata[]` with correct `contentType`, `isBinary`, `sizeBytes`, and `uploadedAt` for text and binary fixtures. |
| PA-2 | `runtime.call("getArtifactMetadata", ...)` returns the same metadata shape as `/api/.../meta` for a binary file. |
| PA-3 | HTTP `GET /api/sessions/:id/artifacts/:f/download` for a `.pdf` returns `Content-Type: application/pdf`, `Content-Disposition: attachment`, and the response body bytes equal the source bytes (use `supertest` with `.responseType("arraybuffer")`). |
| PA-4 | HTTP `/download` for a `.md` returns `Content-Type: text/markdown` and the bytes equal the original markdown. |
| PA-5 | `runtime.call("downloadArtifact", {sessionId, filename})` stays text-only for preview: markdown succeeds, binary returns `ARTIFACT_IS_BINARY`. |
| PA-6 | HTTP `/meta` returns `200 { sizeBytes, contentType, isBinary, uploadedAt }` for an existing artifact and `404` for a missing one. |

### Phase 3 — Shared UI + host presentation

New file `packages/sdk/test/local/artifact-browser-ui.test.js` (shared ui-core controller / reducer / selector coverage):

| ID | What it asserts |
|---|---|
| UI-1 | `files/sessionLoaded` accepts `ArtifactMetadata[]` entries and still preserves `selectedFilename` semantics. |
| UI-2 | `ensureFilePreview()` does **not** call `transport.downloadArtifact()` for a binary artifact when `isBinary: true` is already present in list metadata. |
| UI-3 | Binary preview state becomes a note / placeholder payload, not a markdown/text payload. |
| UI-4 | Text artifacts still flow through the markdown / text preview pipeline unchanged. |
| UI-5 | Browser-host presentation exposes download-only affordances for binary artifacts; it does not advertise `Open externally`. |
| UI-6 | Native-host presentation keeps the existing open affordance for downloaded artifacts. |

Add focused source / browser contract assertions to `packages/sdk/test/local/portal-browser-contracts.test.js`:

| ID | What it asserts |
|---|---|
| PBC-1 | Browser transport still downloads artifacts through HTTP `/download` rather than a binary base64 RPC tunnel. |
| PBC-2 | Browser artifact preview wiring is metadata-aware (`listArtifacts` / `getArtifactMetadata`) and short-circuits binary preview. |
| PBC-3 | Browser artifact affordances remain download-only for binary artifacts. |

Manual visual verification:

| ID | What |
|---|---|
| PU-1 | Upload a `.xlsx` via `write_artifact` from a sample agent; open the session in the portal; confirm the file viewer shows the binary placeholder card / note with filename, content type, and size. No Markdown render attempted. |
| PU-2 | Click `Download` on the binary card; the browser saves the file with the correct extension and the file opens cleanly in Excel. |
| PU-3 | Existing `.md` artifact still renders with the Markdown preview (regression). |
| PU-4 | `.pdf` artifact card shows correct icon (or generic file icon) and downloads cleanly; opens in Preview / Acrobat. |

### Phase 4 — Native host download / open hardening

New file `packages/sdk/test/local/artifact-picker-binary.test.js` (vitest, importing the CLI transport and mocking `child_process.spawn`):

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

New `packages/sdk/test/local/*.test.js` suites are picked up automatically by [`scripts/run-tests.sh`](../../scripts/run-tests.sh) because it executes vitest over the local test tree. If we add a brand-new non-SDK test harness later, wire it into the script explicitly. The deploy script's pre-deploy gate then runs the binary-artifact coverage automatically, so a regression in this path blocks rollout.

## Open Questions

(All previous open questions are resolved above. Listing remaining genuinely-open items here for tracking.)

1. **Per-content-type icons in the placeholder card.** Cosmetic; v1 ships a single generic file icon, typed icons (`.xlsx`, `.pdf`, `.png`, …) added later if usage warrants.
2. **Sidecar format for the filesystem store.** JSON is fine and matches the rest of the SDK. Worth migrating to a SQLite metadata table later if listing many sessions becomes slow.
3. **Replacing `file-type`.** It's a heavy dependency for a single magic-byte sniff. Consider a 50-line inline detector for the ~10 MIME types we actually care about, after we see real perf impact.
