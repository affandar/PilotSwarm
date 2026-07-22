# Proposal: Image Attachments in Chat (Portal, TUI, MCP/API — Model-Visible)

**Status:** Accepted
**Date:** 2026-07-21

## Problem

Every prompt that flows into a PilotSwarm session is **plain text**:

- The portal composer produces a string and calls `transport.sendMessage(sessionId, text, …)` ([`packages/app/ui/react/src/web-app.js`](../../packages/app/ui/react/src/web-app.js) — `PromptComposer`; [`packages/app/ui/core/src/controller.js`](../../packages/app/ui/core/src/controller.js) — `sendPrompt`).
- `PilotSwarmManagementClient.sendMessage` enqueues `JSON.stringify({ prompt })` onto the durable messages queue ([`packages/sdk/src/management-client.ts`](../../packages/sdk/src/management-client.ts)).
- The orchestration dequeues `msg.prompt` and calls `ManagedSession.runTurn(prompt)` ([`packages/sdk/src/orchestration/queue.ts`](../../packages/sdk/src/orchestration/queue.ts), [`turn.ts`](../../packages/sdk/src/orchestration/turn.ts)).
- `runTurn` calls `copilotSession.send({ prompt })` ([`packages/sdk/src/managed-session.ts`](../../packages/sdk/src/managed-session.ts)).

Nothing in that pipe carries image bytes. An operator who pastes a screenshot of an Azure portal error into the chat gets nothing — the browser throws the clipboard image away, and the model never sees an image even on vision-capable models.

The concrete demand: paste a screenshot (desktop **or phone**) into the chat and ask "what does this error mean and how do I fix it?".

## Goals

1. Attach one or more images to a chat message from the **portal** — clipboard paste (Ctrl/Cmd+V), drag-and-drop, and an explicit picker — on desktop and mobile browsers (photo library / camera on phones).
2. The model receives the images as **true multimodal content**, not a path hack.
3. Every attached image is persisted as a **session binary artifact** — the artifact is the source of truth; messages carry references.
4. The same capability is reachable from the **TUI**, the **MCP server**, and the **Web API / SDK** directly.
5. **Graceful degradation** on non-vision models: image stays in the transcript and artifact store; the model call proceeds text-only with an explicit note.
6. Safe rollout across a mixed-version fleet (old workers + new portal and vice versa).

## Non-Goals

- **Agents producing images for the user** (tracked separately; this is user → model only).
- **Tool results carrying images** (tool results stay text-only in v1).
- **Terminal pixel rendering** (no Sixel/iTerm2 escapes; the TUI renders text chips).
- **Video, audio, PDF-as-image.** Static raster only: PNG, JPEG, GIF, WebP.
- **HEIC transcoding** (v1 rejects HEIC; most mobile browsers hand us JPEG/PNG on paste anyway).

## How images reach the model

This is the load-bearing fact of the design: **the Copilot SDK already does the multimodal work.** PilotSwarm's agent loop is `@github/copilot-sdk`, and `session.send()` accepts blob attachments alongside the prompt:

```ts
await copilotSession.send({
    prompt: "What does this error mean?",
    attachments: [
        { type: "blob", data: "<base64>", mimeType: "image/png", displayName: "screenshot.png" },
    ],
});
```

The Copilot CLI runtime packs blob attachments into the provider-specific multimodal content (Anthropic `{type:"image", source:{type:"base64",…}}`, OpenAI `image_url` data-URL, …). **PilotSwarm does not implement any provider translation.**

Vision support is per-model runtime metadata, not a hardcoded allowlist. The model catalog exposes:

```ts
interface ModelCapabilities {
    supports: { vision: boolean; … };
    limits: {
        vision?: {
            supported_media_types: string[];
            max_prompt_images: number;
            max_prompt_image_size: number;
        };
    };
}
```

For BYOK providers (`azure-openai`, `anthropic` entries in `.model_providers.json`), the per-model `capabilities` override declares vision where the synthesized catalog entry doesn't.

## Architecture: upload first, reference after

Image **bytes** travel exactly once, over the existing artifact upload path. Everything downstream carries a **reference**.

```
┌──────────────────────────────────────────────┐
│ Composer (portal paste/drop/pick, TUI path,  │
│ MCP upload_artifact, SDK caller)             │
└──────────────────┬───────────────────────────┘
                   │ (1) PUT /api/v1/sessions/:id/artifacts/:filename
                   │     (base64 body; bytes land in Azure Blob / fs store)
                   ▼
┌──────────────────────────────────────────────┐
│ sendMessage(sessionId, prompt,               │
│   { attachments: [{ filename }] })           │
└──────────────────┬───────────────────────────┘
                   │ (2) server resolves + validates refs against the
                   │     artifact store; enqueues
                   │     { prompt, attachments: [{filename, contentType,
                   │       sizeBytes}] } on the durable messages queue
                   ▼
┌──────────────────────────────────────────────┐
│ Orchestration (1.0.65) dequeue + merge       │
│ threads attachments → runTurn opts           │
└──────────────────┬───────────────────────────┘
                   │ (3) runTurn(prompt, { attachments })
                   ▼
┌──────────────────────────────────────────────┐
│ ManagedSession.runTurn                       │
│ • fetch bytes from artifact store            │
│ • re-sniff content type                      │
│ • vision gate (model catalog)                │
│ • copilotSession.send({ prompt,              │
│     attachments: [{type:"blob", …}] })       │
└──────────────────┬───────────────────────────┘
                   ▼
                  LLM
```

Why upload-first instead of inline base64 through the message pipe:

- The Web API's JSON envelope is capped at 2 MB (`express.json`); a phone screenshot exceeds it after base64.
- The durable queue payload is recorded in Postgres orchestration history and replayed; megabytes of base64 per message would bloat history and replay traffic permanently.
- Replay determinism comes free: the recorded queue event carries only the refs; `runTurn` is an activity, so byte-fetching happens inside it and is never re-executed on replay.
- The image shows up in the Files pane, survives dehydration/hydration, and the agent can re-read it later via `read_artifact` — all existing machinery.

## Wire contract

```ts
// What clients send (filename only — everything else is server-resolved)
type SendAttachmentInput = { filename: string };

// What the server enqueues after validating against the artifact store
type PromptAttachmentRef = {
    filename: string;
    contentType: string;   // from artifact metadata, not client-declared
    sizeBytes: number;
};
```

- `sendMessage` (Web API op, SDK clients, MCP tool) gains an optional `attachments: SendAttachmentInput[]`.
- The server (management client) validates each ref: artifact exists in this session, content type is an allowed raster image, size and count within caps. Invalid → the whole send is rejected with a specific error; nothing is enqueued.
- The durable queue payload gains `attachments: PromptAttachmentRef[]`, included **only when present** — the established rule that keeps the JSON byte-stable for existing callers and frozen orchestration replays.
- The `user.message` session event carries the same refs in its schemaless JSON `data` — **no CMS migration**. Transcript readers that don't know the field ignore it.
- The multi-message merge path (batched queue drain) concatenates attachment lists in message order, subject to the per-turn caps.

## SDK changes

| File | Change |
|---|---|
| `packages/sdk/src/types.ts` | `PromptAttachmentRef`, `SendAttachmentInput`, attachment error codes. |
| `packages/sdk/src/management-client.ts` | `sendMessage(sessionId, prompt, { attachments })` — validate refs against the artifact store, enqueue with refs. |
| `packages/sdk/src/client.ts` / `session-manager.ts` | `PilotSwarmSession.send(prompt, { attachments })` — same payload through the start-aware path. |
| `packages/sdk/src/orchestration/` (as **1.0.65**) | `queue.ts`: carry `msg.attachments` through dequeue and merge. `turn.ts`: pass to `runTurn` opts. Record refs on the `user.message` event. |
| `packages/sdk/src/orchestration_1_0_64/` | Frozen snapshot of the current live dir (mechanical, per the freeze convention; registry + `DURABLE_SESSION_LATEST_VERSION` bump). |
| `packages/sdk/src/managed-session.ts` | `runTurn(prompt, …, { attachments })` — fetch bytes, re-sniff, vision-gate, build blob attachments, send. |
| `packages/sdk/src/worker.ts` / capabilities | `getCapabilities()` → `prompt: { imageAttachments: true }`. |

### Vision gating (in `runTurn`)

At send time, resolve the active model's catalog entry **on the same Copilot
client (same GitHub token) that will serve the turn**. Client binding is per
session (per-user / system Copilot keys can override the worker default), and
capability entitlements are per token — so the gate asks
`getModelVisionInfo(modelRef, { sessionId })`, which prefers the session's
recorded client binding and otherwise resolves the per-user/system key exactly
as `getOrCreate` does. Deployments whose sessions all run on per-user keys may
have no usable worker-default token at all (e.g. an unset sentinel); the gate
must never depend on it. Catalog responses are cached per token, 5-minute TTL.

Then gate on the entry:

- `supports.vision === true` → attach blobs; clamp against `limits.vision` (`max_prompt_images`, `max_prompt_image_size`, `supported_media_types`) — over-limit attachments are dropped with a note rather than failing the turn.
- `supports.vision === false` (or capability unknown) → send text-only, appending to the prompt:

  `[image attachment 'screenshot.png' omitted — model 'gpt-5.4-nano' does not support image input]`

- Every drop emits a captured diagnostic event `runtime.attachment_dropped` `{ filename, contentType, modelId, reason }` (same pattern as `runtime.tool_call_as_text`), so both UIs can render an inline notice and the tuner can see it.
- The image remains in the transcript and the artifact store regardless — switching to a vision model and re-asking works without re-uploading.

## Limits & validation

| Limit | Value | Enforced |
|---|---|---|
| Per attachment (decoded) | 4 MB | composer (pre-upload) + server (sendMessage validation) |
| Per message | 4 images, ≤ 8 MB total | composer + server; merge path re-checks per turn |
| Allowed types | `image/png`, `image/jpeg`, `image/gif`, `image/webp` (static) | server, via the existing `file-type` magic-byte sniff — declared type must match bytes |
| Rejected | SVG (script surface), animated WebP, HEIC, everything else | server |
| Provider clamp | model's `limits.vision.*` | `runTurn`, drop-with-note |

Upload envelope: the artifact PUT route gets a **route-specific body limit of 8 MB** (a larger `express.json` parser mounted just for that path), leaving the global 2 MB cap untouched for every other op. A streaming raw-body upload route (mirroring the existing streaming download route) is deliberately deferred — images fit comfortably in 8 MB of base64.

## Portal UI

All three input paths feed the controller's existing (currently dormant) prompt-attachment state — `ui.promptAttachments`, `setPromptAttachments`, `uploadPromptAttachmentFiles` in `packages/app/ui/core/src/controller.js` — which finally gets its UI callers.

1. **Clipboard paste** — `onPaste` on the `ps-prompt-input` textarea reads `event.clipboardData.items`, takes `image/*` items via `getAsFile()`, and calls `event.preventDefault()` for image content so no placeholder text lands in the textarea. This is the identical API on desktop Chrome/Safari/Firefox, iOS Safari 13.4+, and Android Chrome — **mobile paste is the same handler**.
2. **Drag-and-drop** — `drop`/`dragover` on the prompt shell; activates the already-present-but-unwired `.is-drag-over` CSS ([`packages/app/web/src/index.css`](../../packages/app/web/src/index.css)).
3. **Picker** — a paperclip `IconButton` + hidden `<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple>` (the FilesPane hidden-input pattern, moved into the composer). On phones, `accept="image/*"` makes the browser offer photo library and camera.

**Pending chips**: a horizontal strip above the send row — 64 px thumbnail (`URL.createObjectURL`, revoked on removal), filename, size, `✕`. Send uploads each pending image as a session artifact (deterministic name `attach-<clientMessageId>-<n>.<ext>`), then dispatches the message with `attachments` refs and clears the chips. Upload failure keeps the chip in an error state; the message is not sent half-attached.

**Transcript rendering**: a new `image` block type in `StructuredChatBlocks` ([`packages/app/ui/react/src/web-app.js`](../../packages/app/ui/react/src/web-app.js)) renders a thumbnail strip on user messages that carry attachment refs. Thumbnails **must not** point `<img src>` at the download URL — it requires a Bearer token — so the block fetches bytes through the authenticated transport and renders an object URL (the same pattern `browser-transport.js` uses for downloads), with an in-memory LRU so scrolling doesn't refetch. Click-through opens the artifact preview.

**Files pane**: the "preview intentionally disabled" binary card starts rendering `image/*` artifacts inline (authenticated fetch → object URL). Cheap, and it doubles as the click-through target.

**Capability gating**: paste/drop/picker are active only when the worker reports `prompt.imageAttachments` (and, if known, the selected model reports vision — otherwise the chip row shows a "model can't see images" hint rather than blocking the send).

## TUI

Terminals cannot deliver clipboard image bytes through stdin, so the TUI path is **attach-by-path**, reusing the shared controller state (which makes the send path identical to the portal's):

1. A composer keybinding opens an "Attach image" path input (the TUI's existing overlay/dialog machinery). The path is read from local disk by the node transport, uploaded via `uploadArtifactContent` ([`packages/app/tui/src/node-sdk-transport.js`](../../packages/app/tui/src/node-sdk-transport.js)), and pushed onto `ui.promptAttachments`.
2. Pending attachments render as text chips in the composer: `[image: build.png · 312 KB] ✕`.
3. Transcript user messages with refs render `[image: attach-….png · image/png · 312 KB]` chips; `o` on a focused chip opens the downloaded artifact externally (existing open-externally plumbing).
4. **Best-effort clipboard**: when a helper binary exists, a "paste image from clipboard" action shells out to `pngpaste` (macOS), `wl-paste`/`xclip -t image/png` (Linux), or PowerShell `Get-Clipboard` (Windows), writes a temp file, and joins the same path. Absent helper → the action is hidden. Never a hard dependency.

## MCP server & direct API

The operator surface composes two existing-plus-one-extended primitives — upload the bytes, then reference them:

```jsonc
// 1. Upload the image as a session artifact (existing tool, base64, 2 MB envelope —
//    callers with larger images use the Web API PUT route which allows 8 MB)
upload_artifact {
  "session_id": "…", "filename": "screenshot.png",
  "content": "<base64>", "content_type": "image/png", "content_encoding": "base64"
}

// 2. Send the message referencing it (extended tool)
send_message {
  "session_id": "…",
  "message": "What does this Azure error mean?",
  "attachments": [{ "filename": "screenshot.png" }]
}
```

- `send_message` and `send_and_wait` gain the optional `attachments` parameter, passed through as `options.attachments` on the `sendMessage` op. Validation (existence, type, caps) happens server-side exactly as for the portal; the MCP tool surfaces the specific rejection error.
- `create_session`'s initial prompt gets the same parameter in a follow-up (v1.1) — it needs the session id to exist before the artifact upload, so the v1 flow is create → upload → send.
- **Web API**: the `sendMessage` op (`POST /api/v1/sessions/:sessionId/messages`) body becomes `{ prompt, options: { …, attachments?: [{ filename }] } }` in [`packages/sdk/api/src/protocol.js`](../../packages/sdk/api/src/protocol.js).
- **SDK**: `PilotSwarmSession.send(prompt, { attachments })`, `PilotSwarmManagementClient.sendMessage(sessionId, prompt, { attachments })`, and the web-mode `WebManagementClient` mirror. String-only callers are untouched.

## Security

1. **Trust bytes, not declarations.** The existing magic-byte sniff validates content type at artifact upload; `sendMessage` validation and `runTurn` both re-check against artifact metadata.
2. **No SVG** (script surface), **no animated WebP**, no HEIC.
3. **DOM hygiene**: thumbnails are object URLs from authenticated fetches, revoked on removal — never `data:` URLs injected into `src`, no new CSP directives.
4. **Auth**: attachments inherit session auth end-to-end (`session:write` to upload and send; the download/preview path is the already-authenticated artifact API). No new ACL surface.
5. **EXIF**: v1 does **not** strip metadata. Screenshots — the motivating case — carry no GPS EXIF; phone camera photos do. Server-side EXIF stripping via `sharp` is a fast-follow (it adds a native dep to the worker image and is isolated to the artifact-upload path). Until then, this is a documented caveat.
6. **Abuse caps**: the per-message limits above; uploads and sends ride the existing per-session auth and rate paths.

## Rollout & compatibility

- **String prompts are untouched** at every layer; `attachments` is optional everywhere and absent-by-default in every serialized payload.
- **Orchestration versioning**: the live dir ships as **1.0.65** after freezing today's 1.0.64 snapshot (`orchestration_1_0_64/`, registry entry, version bump — the same mechanical freeze as every prior release). In-flight sessions continue-as-new onto 1.0.65 at their next handoff.
- **Mixed fleet**: an old worker that dequeues a payload with `attachments` ignores the unknown field and runs text-only — degraded, never broken. The portal/TUI hide the attach UI unless `getCapabilities()` reports `prompt.imageAttachments`, so this window only exists for raw API/MCP callers.
- **Old clients** reading `user.message` events with an `attachments` field ignore it (additive JSON).
- Sessions dehydrated before this feature hydrate cleanly; nothing new is in their history.

## Phasing

**Phase 0 — live probe (half a day).** Script: per provider/model, open a Copilot session, send a tiny PNG blob attachment, ask "what's in this image?", and dump each catalog entry's `supports.vision` / `limits.vision`. Pins down real per-model limits and validates the blob path end-to-end before any product code.

**Phase 1 — backend threading.** Freeze 1.0.64 → live dir becomes 1.0.65 with attachment threading; `sendMessage` validation + payload; `runTurn` blob send + vision gate + `runtime.attachment_dropped`; capability flag; artifact PUT body-limit raise. Tests below.

**Phase 2 — portal composer.** Paste/drop/picker + chips wired to the dormant controller plumbing; upload-then-send; capability gating; client-side caps.

**Phase 3 — rendering.** Transcript image blocks (authenticated thumbnails) in portal; Files-pane inline image preview.

**Phase 4 — TUI + MCP.** Attach-by-path overlay + chips; `send_message`/`send_and_wait` attachments param.

**Phase 5 — polish.** EXIF strip via `sharp`; HEIC decision from mobile QA; `create_session` attachments; mobile device QA matrix (iOS Safari paste/long-press/picker/camera, Android Chrome all paths, iPad ⌘V).

## Testing

New suites live in the existing structure and are registered in the standard local test scripts.

`packages/sdk/test/local/prompt-attachments.test.js`:

| ID | Asserts |
|---|---|
| PA-1 | String-prompt sends are byte-identical on the queue (regression). |
| PA-2 | `send(prompt, {attachments})` with a valid PNG artifact ref → queue payload carries resolved `{filename, contentType, sizeBytes}`; `user.message` event carries the refs. |
| PA-3 | Ref to a nonexistent artifact → send rejected, nothing enqueued. |
| PA-4 | Ref to a non-image artifact (e.g. `text/plain`) → rejected with type error. |
| PA-5 | Caps: 5 refs rejected; refs totalling > 8 MB rejected; single ref > 4 MB rejected. |
| PA-6 | `runTurn` passes blob attachments to the Copilot session for a vision model (fake session asserts `attachments[0].type === "blob"`, base64 round-trips to the artifact bytes). |
| PA-7 | Non-vision model → text-only send, prompt carries the omission note, `runtime.attachment_dropped` captured with `reason: "no_vision_support"`. |
| PA-8 | Merge path: two queued messages with attachments merge into one turn carrying both, in order. |
| PA-9 | Replay: crash after enqueue, replay the orchestration — no duplicate artifact fetch side effects, turn completes with the same refs. |
| PA-10 | `getCapabilities()` reports `prompt.imageAttachments: true`. |

`packages/app/ui/core/test/` (composer/controller):

| ID | Asserts |
|---|---|
| UC-1 | Adding attachments populates `ui.promptAttachments`; send dispatches upload-then-send in order; chips cleared on success. |
| UC-2 | Upload failure keeps the pending message unsent and surfaces the error. |
| UC-3 | Capability flag false → attach affordances report disabled. |

`packages/app/web/test/` (API):

| ID | Asserts |
|---|---|
| WA-1 | `sendMessage` op accepts `options.attachments` and forwards them; rejects malformed shapes. |
| WA-2 | Artifact PUT accepts an ~6 MB base64 image body (route-specific limit) while other ops still 413 at 2 MB. |

Portal e2e (existing harness): paste event with a synthetic clipboard image produces a chip; send renders a thumbnail strip in the transcript; non-image files are ignored.

Fixtures: `packages/sdk/test/fixtures/images/` — `tiny.png`, `tiny.jpg`, `tiny.webp`, `tiny.svg` (rejection), `tiny-animated.webp` (rejection); oversized images synthesized in-process.

## Open questions

1. **Downscale instead of drop?** When an image exceeds a model's `max_prompt_image_size`, v1 drops it with a note. Client-side canvas downscaling before upload would preserve intent — revisit after Phase 0 reveals the real limits.
2. **Sub-agent forwarding.** A parent's attachments do **not** flow into spawned children in v1; the parent can reference the artifact by name in the child's task prompt.
3. **Vision token accounting.** Surface `image_input_tokens` on turn metrics once the Copilot usage payload exposes it distinctly; until then image cost shows up in aggregate input tokens.
4. **HEIC.** Rejected in v1; revisit if mobile QA shows meaningful paste/pick failures on iOS photo-library JPEG conversion.
