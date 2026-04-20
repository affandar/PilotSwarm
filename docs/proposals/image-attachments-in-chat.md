# Proposal: Image Attachments in Chat (Portal + TUI, Model-Visible)

**Status:** Draft
**Date:** 2026-04-19
**Depends on:** [binary-artifacts.md](./binary-artifacts.md) — Phase 1 + 2 must ship first.
**Author:** Waldemort team (filed cross-repo per copilot-instructions.md repo-boundary rule)

## Problem

Today every prompt that flows from the portal or TUI into PilotSwarm is **plain text**:

- `PilotSwarmClient.send(prompt: string)` ([`packages/sdk/src/client.ts`](../../packages/sdk/src/client.ts) — `send`).
- `ManagedSession.runTurn(prompt: string)` and the underlying `copilotSession.send({ prompt: effectivePrompt })` ([`packages/sdk/src/managed-session.ts`](../../packages/sdk/src/managed-session.ts) — `runTurn`).
- The session-proxy enqueues the prompt as `JSON.stringify({ prompt })` ([`packages/sdk/src/session-proxy.ts`](../../packages/sdk/src/session-proxy.ts) — `runTurnWithPrompt`).
- The portal `InputBar` and the TUI prompt composer both produce a `string` and call `send`.

Nothing in the pipe carries image bytes, and the model never sees an image even when an operator pastes one into the prompt.

The first concrete demand: an operator wants to paste a phone screenshot of an Azure portal error directly into the chat and ask the agent "what does this error mean and how do I fix it?". On desktop browsers and on iOS Safari/Android Chrome the OS already supports clipboard images; the portal just throws them away.

## Goals

1. Let an operator attach **one or more images** to a chat message in the portal **and** the native TUI, with the model receiving them as multimodal content (not as a "here's a path" hack).
2. Support **clipboard paste** of images in the portal — desktop **and mobile** browsers (iOS Safari, Android Chrome).
3. Support **drag-and-drop** and an **explicit file picker** (paperclip button) in the portal.
4. Support attach-by-path in the native TUI through the existing `Ctrl+A` attach dialog.
5. **Persist** attachments as binary artifacts so they survive session dehydration/hydration and appear in the file inspector.
6. **Gracefully degrade** when the active model is non-vision: keep the image in the transcript and artifacts, but drop it from the model call with an explicit system-side note instead of silently corrupting the request.

## Non-Goals

- **Agents generating images.** Tools that emit images for the user are tracked separately. v1 only handles user → model.
- **Tool results carrying images** (e.g. a `read_image_artifact` tool that returns base64 to the model). Today tool results are text-only and we keep it that way for v1.
- **Inline pixel rendering in the terminal.** TUIs render an `[image: filename · size]` chip; no Sixel / iTerm2 escape-code rendering in v1.
- **Video, audio, PDF-as-image.** Static raster only: PNG, JPEG, GIF, WebP.
- **Long-term streaming uploads** beyond the per-message cap (see Limits).

## Resolved Decisions

| # | Decision | Notes |
|---|----------|-------|
| 1 | Storage model | **Every attached image is also a binary artifact.** No separate "attachment-only" storage. The artifact is the source of truth; the turn record references it by `filename`. |
| 2 | Wire encoding | **base64**, same contract as binary artifacts. Inline `data` field for transient/small images, `artifactId` reference for already-uploaded. |
| 3 | Inline → artifact promotion | All inline images are **promoted to artifacts before the turn is persisted**. Inline `data` is a transport convenience, not a storage tier. |
| 4 | Per-attachment cap | **4 MB decoded.** Lower than the 10 MB binary artifact cap because vision-model image budgets are typically 4–5 MB and we want the SDK boundary to enforce that, not the provider. |
| 5 | Per-message budget | **Max 4 images, total ≤ 8 MB decoded.** |
| 6 | Allowed types | `image/png`, `image/jpeg`, `image/gif` (first frame only on the model side, per most providers), `image/webp` (static only). Reject SVG (script surface) and animated WebP. |
| 7 | EXIF stripping | **On**, server-side, via `sharp`, before the artifact is written. Removes GPS and camera metadata that users typically don't realize is in their screenshots. |
| 8 | Magic-byte sniff | **Reuse the binary-artifact sniff.** Mismatch → reject. |
| 9 | Vision-capability source | **Provider-model allowlist** in v1 (hardcoded). Move to a registry once we add a third provider. |
| 10 | Mobile paste | **Required.** First-class. The product reason this proposal exists is "operator pastes phone screenshot". |

## Design

### End-to-end flow

```
┌──────────────────────────────┐
│ User pastes / drops / picks  │
│ image in portal InputBar     │
└──────────────┬───────────────┘
               │ (1) FileReader → ArrayBuffer → base64
               ▼
┌──────────────────────────────┐
│ Portal browser-transport.js  │
│ POSTs prompt + attachments   │
│ as base64 over WS/JSON-RPC   │
└──────────────┬───────────────┘
               │ (2) sendStructuredPrompt(sessionId, {text, attachments})
               ▼
┌──────────────────────────────┐
│ PortalRuntime → SDK client   │
│ client.sendStructured(...)   │
└──────────────┬───────────────┘
               │ (3) duroxide command:
               │     "send_user_message"
               │     payload includes attachments
               ▼
┌──────────────────────────────┐
│ session-proxy.ts             │
│ • promotes inline data → art │
│ • writes artifact rows       │
│ • persists structured turn   │
│ • dispatches to runTurn      │
└──────────────┬───────────────┘
               │ (4) ManagedSession.runTurn(promptInput)
               ▼
┌──────────────────────────────┐
│ Provider translator builds   │
│ multimodal content[] array   │
│ { type: image_url|image, ...}│
└──────────────┬───────────────┘
               │ (5) copilotSession.send({ prompt: contentParts })
               ▼
              LLM
```

### Data model — `PromptInput`

The string-only prompt becomes a discriminated union. Every layer accepts both shapes; only the lowest layer (`ManagedSession`) cares about the structured form.

```ts
// packages/sdk/src/types.ts
export type PromptInput =
  | string
  | StructuredPromptInput;

export type StructuredPromptInput = {
  text: string;
  attachments?: PromptAttachment[];
};

export type PromptAttachment =
  | InlineImageAttachment
  | ArtifactRefAttachment;

export type InlineImageAttachment = {
  kind: "image";
  filename: string;             // for display + artifact mirror
  contentType: string;          // image/png | image/jpeg | image/gif | image/webp
  data: string;                 // base64; promoted to artifact before persistence
};

export type ArtifactRefAttachment = {
  kind: "image";
  filename: string;
  contentType: string;
  artifactId: string;           // matches an existing artifact in this session
};
```

`PilotSwarmClient.send`, `PilotSwarmSession.send`, and `ManagedSession.runTurn` all accept `PromptInput`. The `string` overload remains and is the dominant call site — no churn for any non-attachment caller.

### SDK — what changes

| File | Change |
|---|---|
| [`packages/sdk/src/types.ts`](../../packages/sdk/src/types.ts) | Add `PromptInput`, `PromptAttachment`, `StructuredPromptInput`, `InlineImageAttachment`, `ArtifactRefAttachment`. |
| [`packages/sdk/src/client.ts`](../../packages/sdk/src/client.ts) | `send(prompt: PromptInput)`. Internal serializer pushes the structured payload through the existing duroxide command channel. |
| [`packages/sdk/src/session-proxy.ts`](../../packages/sdk/src/session-proxy.ts) | New activity `promoteInlineAttachments(sessionId, attachments)` that uploads inline base64 → artifacts (using the binary-artifacts API) and rewrites them to `ArtifactRefAttachment`. Runs **inside an activity** so it's deterministic on replay (the artifact filenames are deterministic — see "Filenames" below). |
| [`packages/sdk/src/managed-session.ts`](../../packages/sdk/src/managed-session.ts) | `runTurn(prompt: PromptInput)`. Builds the provider-shaped multimodal payload. Capability check + graceful drop. |
| [`packages/sdk/src/cms.ts`](../../packages/sdk/src/cms.ts) | Persist the structured user message (text + attachment refs). New CMS column `attachments_json TEXT NULL` on the turns table — see Schema migration. |
| New: [`packages/sdk/src/multimodal.ts`](../../packages/sdk/src/multimodal.ts) | Provider translators (`buildOpenAIContent`, `buildAnthropicContent`, `buildGeminiContent`) + `providerSupportsVision(model)`. |
| [`packages/sdk/src/management-client.ts`](../../packages/sdk/src/management-client.ts) | `sendMessage(sessionId, prompt: PromptInput)`. |

### Provider translation

`multimodal.ts` owns the provider-specific shape. The active provider is already known at `runTurn` time (model selector resolves it):

```ts
// OpenAI / GHCP
{ role: "user", content: [
    { type: "text", text: "..." },
    { type: "image_url", image_url: { url: "data:image/png;base64,...", detail: "auto" }}
]}

// Anthropic
{ role: "user", content: [
    { type: "text", text: "..." },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "..." }}
]}

// Gemini
{ role: "user", parts: [
    { text: "..." },
    { inlineData: { mimeType: "image/png", data: "..." }}
]}
```

The Copilot session API today only takes `{ prompt: string }`. We extend its surface to accept `{ prompt: string | ContentPart[] }` (passthrough to the underlying provider call). If the SDK upstream blocks that, the translator falls back to a `data:` URL embedded in a single message field — uglier but unblocks shipping.

### Filenames (replay-safe)

Inline attachments need deterministic artifact names so an orchestration replay produces the exact same artifact paths. We **do not** use `Date.now()` or `Math.random()` for the suffix.

```
attach-{turnIndex}-{messageNumber}-{n}.{ext}
```

Where:

- `turnIndex` is the durable turn counter the orchestration already maintains.
- `messageNumber` is the per-turn user-message index (almost always `1`).
- `n` is the position within the message.
- `ext` is derived from `contentType`.

Example: `attach-0034-1-2.png`. Replay produces the same name and overwrites the same artifact path idempotently — no duplicates.

### CMS schema migration

New migration in [`packages/sdk/src/migrations/`](../../packages/sdk/src/migrations/):

```
NNNN_add_turn_attachments.sql
NNNN_diff.md
```

```sql
ALTER TABLE copilot_sessions.turns
  ADD COLUMN IF NOT EXISTS attachments_json JSONB NULL;

COMMENT ON COLUMN copilot_sessions.turns.attachments_json IS
  'Structured user-message attachments (image refs to artifacts). NULL for legacy text-only turns.';

CREATE OR REPLACE FUNCTION copilot_sessions.append_turn(
  ...existing params...,
  p_attachments_json JSONB DEFAULT NULL
) RETURNS BIGINT AS $$
  ...existing body, additionally inserting p_attachments_json...
$$ LANGUAGE plpgsql;
```

Per the [`schema-migration` skill](../../.github/skills/schema-migration/SKILL.md): never edit a previous migration; the diff file describes the stored-proc delta; the field is nullable so older rows stay valid.

The selector that builds the transcript (`session-proxy.ts` → `getTurns`) reads `attachments_json` and surfaces it on the turn record. Existing transcript readers ignore unknown fields.

### Capability detection — `providerSupportsVision`

```ts
const VISION_MODELS = new Set([
  // OpenAI / GHCP
  "gpt-4o", "gpt-4o-mini", "gpt-4-turbo",
  // Anthropic
  "claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-opus",
  // Gemini
  "gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash",
]);

export function providerSupportsVision(modelId: string): boolean {
  // Match by stem so version suffixes don't break detection.
  const stem = modelId.split(/[-:@]/).slice(0, 3).join("-");
  return VISION_MODELS.has(stem) || /-vision/i.test(modelId);
}
```

When `providerSupportsVision === false` and the prompt has attachments:

1. The image is **kept in the transcript and artifacts** (operator can still see what they sent).
2. The model call is sent with text only.
3. A system note is appended *to the prompt text* sent to the model:
   `[image attachment '{filename}' omitted — current model '{modelId}' does not support vision]`
4. A new **event** of kind `attachment_dropped` is emitted (see "New event" below) so the TUI/portal can render a small inline notice.

### New event: `attachment_dropped`

Per the [`add-event` skill](../../.github/skills/add-event/SKILL.md):

- Fired from `ManagedSession.runTurn` via the `onEvent` callback when the capability check trims an attachment.
- Persisted in CMS via `session-proxy.ts` event capture.
- Surfaced through `PilotSwarmSession.on("event", ...)` with no special filtering.
- Payload: `{ filename, contentType, modelId, reason: "no_vision_support" | "size_exceeded" | "type_rejected" }`.

### Portal — InputBar

Three input paths, all producing the same `InlineImageAttachment[]`:

#### 1. Clipboard paste (desktop **and mobile**)

```ts
// Listener on the prompt textarea
inputEl.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items || [];
  const attachments: InlineImageAttachment[] = [];
  for (const item of items) {
    if (!item.type.startsWith("image/")) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    e.preventDefault();
    attachments.push(await blobToInlineAttachment(blob));
  }
  if (attachments.length) addAttachments(attachments);
});
```

Mobile specifics:

- **iOS Safari** delivers pasted images via `clipboardData.items` of type `image/png` (screenshots) or `image/jpeg` (camera roll). This works in iOS 13.4+. The portal must call `e.preventDefault()` on paste with image content so iOS does not also insert a placeholder character into the textarea.
- **Android Chrome** delivers via the same `clipboardData.items` API. No special handling.
- **iOS Safari long-press → Paste**: same path; the menu calls the underlying paste event.
- **iOS Share Sheet → "Copy"** then paste in the portal: produces an `image/jpeg` blob in the clipboard. Works.
- We also wire an `<input type="file" accept="image/*" capture="environment">` fallback (see picker below) for users who can't get the paste menu to surface — this is the most common mobile failure mode.

#### 2. Drag and drop (desktop)

```ts
promptArea.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files || []);
  const attachments = await Promise.all(
    files.filter(f => f.type.startsWith("image/")).map(blobToInlineAttachment)
  );
  if (attachments.length) addAttachments(attachments);
});
```

`dragover` listener calls `preventDefault()` to enable drop and toggles a CSS class `is-drop-target` on the input shell.

#### 3. Explicit picker — paperclip button

```html
<button type="button" class="ps-attach-button" aria-label="Attach image">📎</button>
<input type="file" accept="image/png,image/jpeg,image/gif,image/webp"
       multiple capture="environment" hidden />
```

The `capture="environment"` attribute is what makes mobile browsers offer the camera or photo library; `accept` filters to images only.

#### Attachment chips (composer UI)

Below the textarea, a horizontal row of chips:

```
┌────────────┐ ┌────────────┐
│ [thumb 64] │ │ [thumb 64] │  build.png · 312 KB
│      ✕     │ │      ✕     │
└────────────┘ └────────────┘
```

- Thumbnail uses `URL.createObjectURL(blob)` (no base64 in the DOM).
- `✕` removes from the pending-attachments array.
- Sending clears the chips after the structured prompt is enqueued.

### Native TUI — attach by path

The TUI's existing `Ctrl+A` opens an attach-file dialog. Two changes:

1. **Filter**: accept `image/*` extensions when the user is composing a prompt (the existing dialog already handles arbitrary files; we surface only the image-relevant ones in the suggestion list).
2. **Wire to structured prompt**: read the file via `fs.readFile`, base64-encode, push to the pending-attachment list. Render in the prompt as a textual chip:

   ```
   [📎 build.png · 312 KB · attached]
   ```

3. On send, the CLI builds `StructuredPromptInput` and calls `client.send`.

No clipboard paste in the terminal — terminals can't reliably surface clipboard images. The attach dialog is the supported path. (The shared `ui-core` controller knows about attachments; only the portal host wires up the paste/drop listeners.)

### Transcript rendering

#### Portal

The user message bubble renders the text plus a thumbnail strip:

```
You · 4:42 pm
Take a look at this screenshot.
┌──────────┐ ┌──────────┐
│ 96 × 96  │ │ 96 × 96  │
└──────────┘ └──────────┘
```

Click → opens the artifact viewer (binary placeholder card + Download button — image preview is **out of scope for v1** of the binary-artifact viewer; the click-through respects whatever the binary viewer ships).

#### TUI

```
You · 4:42 pm
  Take a look at this screenshot.
  [📎 attach-0012-1-1.png · image/png · 312 KB]
  [📎 attach-0012-1-2.png · image/png · 287 KB]
```

Press `o` on a focused chip → opens via `open` / `xdg-open` / `start` (same plumbing as binary-artifact `Open externally`).

### Limits

- **Per attachment**: 4 MB decoded. Reject earlier than provider limits to give a clear error in the UI.
- **Per message**: max 4 attachments, total decoded ≤ 8 MB.
- **Allowed MIME**: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Reject everything else (including `image/svg+xml`, `image/heic` — HEIC needs server-side transcoding which we defer).
- **Max width / height**: no hard cap, but EXIF strip + JPEG/PNG re-encode pass via `sharp` will pass through dimensions unchanged. Operators with 4096×4096 PNGs may hit the byte cap before any pixel cap.

### Worker capability flag

The portal and TUI feature-gate the attach UI on a worker capability returned at session bootstrap:

```ts
// management-client.ts → getCapabilities()
{ artifacts: { binary: true }, prompt: { imageAttachments: true } }
```

Older workers return `{ prompt: { imageAttachments: false } }`; the portal hides the paperclip button and disables the paste handler in that case. This keeps the rollout safe across mixed worker versions during AKS rollout.

### Security

1. **Type sniffing required.** Reuse the magic-byte sniff from binary artifacts. Trust bytes, not the declared `contentType`.
2. **EXIF strip.** Server-side via `sharp` before the artifact is written. Round-trips PNG/JPEG/WebP without metadata. Animated GIF: pass through unchanged (re-encoding animated frames is expensive; first-frame extraction happens only on the model-call path, not on storage).
3. **No SVG, no animated WebP.** SVG is a script surface; animated WebP is a known fuzzing target in older renderers.
4. **DOM hygiene.** Portal renders thumbnails via `URL.createObjectURL(blob)` (revoked when the chip is removed) — never inject `data:` URLs into `src` attributes.
5. **CSP.** No new `connect-src` or `img-src` directives needed; thumbnails are blob URLs and full-size renders go through the authenticated artifact download URL.
6. **Rate limit.** Per session: max 20 image-bearing messages per minute. Per worker: enforced in `ManagedSession` before `copilotSession.send`.
7. **Auth.** Attachments inherit session auth; no separate ACL surface. The artifact-download endpoint already requires auth.

### Backward compatibility

- All existing `client.send(promptString)` callers behave identically — string overload unchanged.
- Workers without the new activity reject `attachments` at the duroxide command boundary with a clear error; portal/TUI gate UI on the capability flag (above).
- Older clients reading turns from CMS that include `attachments_json` ignore the field (additive column, additive output shape).
- Sessions dehydrated before this feature land hydrate cleanly (the new activity isn't in their history; nothing to replay).

### Operational notes

- **`sharp` is a native dep.** Adds a build step on the worker image. The Dockerfile already installs platform binaries (`linux/amd64` per the AKS build rule); `sharp` ships prebuilt binaries for that triple, no extra work expected.
- **Worker memory budget.** EXIF strip is bounded — `sharp` streams the image. 4 MB attachment ≈ 25 MB peak working set (decoded raster). At max 4 attachments per message and our typical 8-worker pod allocation, the worst case is ~800 MB transient — fits comfortably.
- **Token cost surfacing.** `read_session_metric_summary` already tracks tokens. Add `image_input_tokens` to the per-turn metric so the agent-tuner can see which sessions are burning the most vision budget. Per the observability rule in `.github/copilot-instructions.md`, expose this through `PilotSwarmManagementClient.getSessionMetricSummary` and via the `read_session_metric_summary` tuner inspect-tool.

## Phasing

Phase A — **SDK structured prompt** (one PR):

- `PromptInput` types, client/session/management-client `send` overloads.
- Duroxide command payload extended with `attachments`.
- `promoteInlineAttachments` activity (deterministic filenames, idempotent overwrite).
- CMS migration `NNNN_add_turn_attachments`.
- New event `attachment_dropped`.
- Capability flag in worker bootstrap.

Phase B — **Provider translator** (separate PR, no UI yet):

- `multimodal.ts` with OpenAI / Anthropic / Gemini translators.
- `providerSupportsVision` + capability-aware drop with system note.
- `image_input_tokens` metric.
- Tests with a known-vision model and a known-text-only model.

Phase C — **Portal InputBar** (separate PR):

- Paste / drag / picker handlers.
- Attachment chips below textarea.
- Thumbnail strip in user message bubbles.
- Capability-flag gating.
- Mobile QA on iOS Safari + Android Chrome.

Phase D — **TUI attach** (separate PR):

- Extend `Ctrl+A` dialog to push to structured prompt.
- Attachment chip rendering in the prompt and transcript.
- `o` keybinding on chip → external open.
- Update [`docs/keybindings.md`](../../docs/keybindings.md) and [`packages/cli/src/app.js`](../../packages/cli/src/app.js); per the TUI keybinding rule, also update status hints, prompt placeholders, and help dialog.

Phase E — **Docs + sample**:

- New "Image attachments" section in [`docs/sdk/`](../../docs/sdk/).
- Add a turn to the DevOps sample that pastes a screenshot and asks the agent to interpret it.
- Update [`templates/builder-agents/`](../../templates/builder-agents/) docs if they mention prompt shape.
- Update [`.github/skills/pilotswarm-tui/SKILL.md`](../../.github/skills/pilotswarm-tui/SKILL.md) with the new attach UX.

Phase A unlocks any direct-SDK caller; Phase C unlocks the operator workflow that motivates this proposal.

## Public API surface diff

| Symbol | Before | After |
|---|---|---|
| `PilotSwarmClient.send` | `(prompt: string)` | `(prompt: PromptInput)` |
| `PilotSwarmSession.send` | `(prompt: string, opts?)` | `(prompt: PromptInput, opts?)` |
| `PilotSwarmManagementClient.sendMessage` | `(sessionId, prompt: string)` | `(sessionId, prompt: PromptInput)` |
| `ManagedSession.runTurn` | `(prompt: string, opts?)` | `(prompt: PromptInput, opts?)` |
| New SDK exports | — | `PromptInput`, `PromptAttachment`, `InlineImageAttachment`, `ArtifactRefAttachment`, `providerSupportsVision` |
| Worker capabilities | `{ artifacts: { binary } }` | `{ artifacts: { binary }, prompt: { imageAttachments } }` |
| Turn record | `{ ..., text }` | `{ ..., text, attachments?: ArtifactRefAttachment[] }` |
| New event kind | — | `attachment_dropped` |
| New CMS column | — | `copilot_sessions.turns.attachments_json JSONB` |
| New metric | — | `image_input_tokens` on session metric summaries |

## Testing Plan

Tests live in the repo's existing structure (`packages/sdk/test/local/`, `packages/portal/test/`, `packages/cli/test/`). All new suites added to [`scripts/run-tests.sh`](../../scripts/run-tests.sh) and the `test:local` script per `.github/copilot-instructions.md`. **No retries, no hacks, no custom system prompts to compensate for product behavior, raise failures loudly.**

### Phase A — SDK structured prompt

New file `packages/sdk/test/local/prompt-attachments.test.js`:

| ID | What it asserts |
|---|---|
| PA-1 | `client.send("hello")` (string overload) still works end-to-end (regression). |
| PA-2 | `client.send({ text, attachments: [<inline png>] })` succeeds; the resulting transcript turn has `attachments` referencing an artifact, not inline base64. |
| PA-3 | The promoted artifact filename matches `attach-{turnIndex}-1-1.png`. |
| PA-4 | Idempotency on replay: re-running the orchestration after a crash mid-`promoteInlineAttachments` does **not** create a second artifact (overwrite same path). Lives in `reliability-crash.test.js` as a new case. |
| PA-5 | `attachment_dropped` event fires when a non-vision model is selected and an attachment is supplied; payload includes `filename`, `modelId`, `reason: "no_vision_support"`. |
| PA-6 | Per-attachment cap: 5 MB inline image rejected with `ATTACHMENT_TOO_LARGE`, no artifact created. |
| PA-7 | Per-message cap: 5 attachments → reject with `TOO_MANY_ATTACHMENTS`. 4 attachments totalling 9 MB → reject with `TOTAL_ATTACHMENTS_TOO_LARGE`. |
| PA-8 | Type allowlist: SVG attachment rejected with `ATTACHMENT_TYPE_REJECTED`. Animated WebP rejected. PNG/JPEG/static WebP/GIF accepted. |
| PA-9 | Magic-byte mismatch: declared `image/png` but JPEG bytes → `ARTIFACT_CONTENT_TYPE_MISMATCH` (reused from binary artifacts). |
| PA-10 | EXIF strip: upload a JPEG with embedded GPS EXIF; download the resulting artifact; confirm GPS metadata is gone. |
| PA-11 | `ArtifactRefAttachment` path: pre-upload an image via `write_artifact`, send a prompt referencing it by `artifactId` — model receives the image, no duplicate artifact created. |
| PA-12 | CMS migration applied idempotently across two `initialize()` calls (no error, column present once). |
| PA-13 | Replay safety: dehydrate a session that has an attachment turn, hydrate on a different worker, list turns + artifacts, verify both are intact. Lives in `multi-worker.test.js` as a new case. |
| PA-14 | Capability flag: `getCapabilities()` returns `prompt.imageAttachments: true` when the new code is loaded. |

### Phase B — Provider translator

New file `packages/sdk/test/local/multimodal-translator.test.js`:

| ID | What it asserts |
|---|---|
| MT-1 | OpenAI translator builds `content: [{type:"text"}, {type:"image_url", image_url:{url:"data:image/png;base64,..."}}]`. |
| MT-2 | Anthropic translator builds `content: [{type:"text"}, {type:"image", source:{type:"base64", media_type, data}}]`. |
| MT-3 | Gemini translator builds `parts: [{text}, {inlineData:{mimeType, data}}]`. |
| MT-4 | `providerSupportsVision("gpt-4o") === true`. |
| MT-5 | `providerSupportsVision("gpt-3.5-turbo") === false`. |
| MT-6 | `providerSupportsVision("claude-3-5-sonnet-20241022") === true` (version suffix tolerated). |
| MT-7 | Model swap mid-session: send with vision model (image included), switch to text-only model, send again — second turn drops the image and fires `attachment_dropped`. |
| MT-8 | `image_input_tokens` reflected on the session metric summary after a multimodal turn. Asserted via `getSessionMetricSummary`. |
| MT-9 | The tuner inspect-tool `read_session_metric_summary` exposes `image_input_tokens` (registered behind the `isTuner` guard). |

### Phase C — Portal InputBar

Playwright spec under `packages/portal/test/e2e/image-attachments.spec.ts`:

| ID | What it asserts |
|---|---|
| PE-1 | Paperclip click → file picker → choosing a PNG renders an attachment chip with the right filename and size. |
| PE-2 | Drag-and-drop a PNG onto the prompt area renders a chip; non-image files are ignored silently. |
| PE-3 | Programmatic clipboard paste (using `page.evaluate` to dispatch a `paste` event with a synthetic `DataTransferItem`) produces a chip and prevents default text insertion. |
| PE-4 | Sending the prompt clears the chips and the user message in the transcript shows a thumbnail strip. |
| PE-5 | Removing a chip via `✕` removes it from the pending-attachments array; sending without chips sends text-only. |
| PE-6 | Capability flag `prompt.imageAttachments: false` hides the paperclip and disables the paste handler. |

Mobile-specific manual QA (no Playwright on real devices in CI):

| ID | What |
|---|---|
| PM-1 | iPhone Safari (iOS 17+): take a screenshot, paste into prompt, verify chip appears and send works. |
| PM-2 | iPhone Safari: long-press the prompt → Paste an image from the clipboard. |
| PM-3 | iPhone Safari: tap the paperclip → camera capture → image attached. |
| PM-4 | Android Chrome (Pixel + Samsung): paste from clipboard, drag-and-drop, picker — all three paths. |
| PM-5 | iPad Safari with magic keyboard: ⌘V pastes correctly. |
| PM-6 | Mobile Safari on a slow 4G link: 3.5 MB JPEG upload completes within reasonable time, no timeout. |

### Phase D — TUI

Tests in `packages/cli/test/local/attach-image.test.js`:

| ID | What it asserts |
|---|---|
| TU-1 | `Ctrl+A` opens the attach dialog; selecting a PNG appends a chip to the prompt state. |
| TU-2 | Sending the structured prompt routes through `client.send({text, attachments})`, base64 reads from disk on the CLI side. |
| TU-3 | Transcript rendering shows `[📎 filename · contentType · size]` chip on the user message. |
| TU-4 | Pressing `o` on a focused chip invokes `spawnDetached("open", [<path>])` on macOS, `xdg-open` on Linux, `start` on Windows (mocked). |
| TU-5 | Status hint, prompt placeholder, and help dialog all reference the new keybindings (per the TUI keybinding rule). |

### Cross-cutting

| ID | What it asserts |
|---|---|
| X-1 | Attachment turn round-trips through dehydrate → hydrate on a different worker (artifact bytes intact, turn record intact, model can re-consume on rerun). Lives in `multi-worker.test.js`. |
| X-2 | Sub-agent inheritance: a sub-agent spawned from a parent that has attachments in its history does **not** automatically receive those images in the prompt (parent images stay with the parent). Asserted in `sub-agents/`. |
| X-3 | Sweeper does not delete attachment artifacts when sweeping a finished session before the configured TTL. Asserted in `system-agents.test.js`. |
| X-4 | Pre-deploy gate: all new suites registered in `scripts/run-tests.sh` and `packages/sdk/package.json`'s `test:local`; they run automatically before AKS rollout. |

### Test fixtures

`packages/sdk/test/fixtures/images/`:

- `tiny.png` — 64×64 PNG (~500 B)
- `tiny.jpg` — 64×64 JPEG (~1 KB)
- `tiny-with-gps.jpg` — JPEG with an embedded GPS EXIF block (~2 KB) for the EXIF-strip test.
- `tiny.webp` — 64×64 static WebP (~400 B)
- `tiny-animated.webp` — animated WebP for the rejection test (~800 B)
- `tiny.svg` — for the rejection test
- `four-mb.png` — synthesized in-process via `sharp` to stay close to the cap; not checked in.

## Open Questions

1. **HEIC support.** iPhone photo library default is HEIC, not JPEG. Most iOS browsers transcode to JPEG on paste/upload, but not all. v1 rejects HEIC; we revisit if mobile QA shows operators routinely failing the upload because of this.
2. **Image preview in the binary-artifact viewer.** Currently the binary viewer (from the binary-artifacts proposal) shows a download placeholder. We could add inline rendering for `image/*` in a follow-up. Out of scope for this proposal.
3. **Sub-agent prompt forwarding.** When a parent agent calls `spawn_agent`, should the parent's last user attachment be forwarded into the child task? Default in v1: **no** (per X-2 above). The parent can explicitly include `artifactId` in the child's task prompt if they want.
4. **Prompt-level token estimation.** Vision token costs vary per provider/model. For now we surface actual `image_input_tokens` post-hoc; pre-send estimation is deferred to v2.
