# Lambert — History

## Core Context
- **Project:** pilotswarm — durable execution runtime for GitHub Copilot SDK agents
- **Stack:** TypeScript (ESM), Node.js 24+, duroxide (Rust), PostgreSQL, Azure Blob, neo-blessed TUI
- **User:** Affan Dar
- **Key repos:** pilotswarm, microsoft/duroxide, microsoft/duroxide-node
- **TUI:** cli/tui.js (2,000+ lines, neo-blessed), bin/tui.js (CLI entry point)
- **Joined:** 2026-03-10

## Learnings

### Chat Buffer Rendering Pipeline (2026-03-09)
The chat pane has 4 data sources that write to `sessionChatBuffers`:
1. **`loadCmsHistory()`** — rebuilds full buffer from CMS events on session switch (~line 2212)
2. **Live observer** — appends lines via `showCopilotMessage()` / `appendChatRaw()` in real-time
3. **`ensureSystemSplashBuffer()`** — prepends splash banner for system agents (~line 919)
4. **Live status recovery** — injects latest turn from duroxide custom status when CMS lags

The 100ms frame loop (~line 330) syncs `sessionChatBuffers` → `chatBox` when `_chatDirty` is true.

**Race conditions fixed:**
- **Buffer replacement nuke:** `loadCmsHistory` did a full `sessionChatBuffers.set()`, destroying observer-appended lines. Fixed with a watermark pattern: `sessionCmsWatermark` tracks buffer length after CMS load; lines beyond the watermark are observer-appended and carried forward on reload.
- **Stale cache on unseen changes:** 30s TTL cache skipped reload even when session had new content. Fixed by checking `orchHasChanges` — if the session has unseen changes, force reload regardless of TTL.
- **Splash double-injection:** `ensureSystemSplashBuffer` did fragile content comparison to detect existing splash. Fixed with `sessionSplashApplied` Set for idempotency — once splash is applied, it's never re-checked or doubled.

**Key line references (post-fix):**
- `sessionCmsWatermark` / `sessionSplashApplied` declarations: ~line 2836
- `ensureSystemSplashBuffer`: ~line 919
- `loadCmsHistory` early return: ~line 2224
- `loadCmsHistory` splash guard + watermark logic: ~line 2432

### Observer Snapshot Loss On Wait Turns (2026-03-10)
The deeper issue was not `continueAsNew` handling in the TUI observer. The real failure mode is that wait-producing turns publish assistant text twice in orchestration status:
1. `status=running` with `intermediateContent`
2. `status=waiting` with embedded completed `turnResult`

Because `waitForStatusChange()` is snapshot-based, the observer may see only the first state and miss the later `turnResult` state. If Chat only renders `turnResult`, the reply is visible in Activity but not Chat until CMS replay on session switch.

**Actual fix kept in code:**
1. Fix repaint bugs in `appendChatRaw()` / `appendActivity()` so explicit `orchId` writes mark the active pane dirty.
2. Promote meaningful `intermediateContent` into Chat immediately.
3. Deduplicate the later matching completed `turnResult` using normalized per-session text (`sessionPromotedIntermediate`).

**Important correction:** the earlier catch-block `continueAsNew` status processing and reduced observer timeout were investigated and then reverted. They were not the final fix.

### Wait-Turn Chat Promotion Dedup (2026-03-10)
Wait-producing turns can surface assistant text twice in custom status: once as `status=running` with `intermediateContent`, then again as `status=waiting` with a completed `turnResult`. In the TUI observer, promote meaningful `intermediateContent` into Chat immediately so the reply is visible even if the later waiting status is missed, but store a normalized per-session marker and suppress the matching completed `turnResult` so Chat does not duplicate the same reply.

### Session List Formatting Duplication (2026-03-10)
The TUI rebuilds orchestration list item labels in two separate paths: the full `refreshOrchestrations()` rebuild and the incremental `updateSessionListIcons()` pass. Both recompute the same marker, change-dot, status icon, system-session styling, collapse badge, heading, and timestamp formatting. This is a stable extraction seam: a pure `formatSessionListItem(state)` helper would reduce drift risk when session labels or icons change.
