# Proposal: Switch PilotSwarm's web portal UX to boring-ui

## Context

Replace PilotSwarm's web portal UX with [boring-ui](https://github.com/hachej/boring-ui) (Chat + Workbench framework, `@hachej/boring-*` packages). PilotSwarm's runtime stays authoritative — we do **not** adopt the Pi agent runtime; boring-ui's front adapts to PilotSwarm via a server-side adapter. The Ink TUI stays on `ui-core` unchanged. Entra/MSAL auth keeps working.

## Key research findings that shape the design

1. **Right seam = `PiChatSessionService`, not `AgentHarness`.** boring-ui's `AgentHarness` leaks raw Pi types (its own comments say don't generalize it). One level up, `PiChatSessionService` (`packages/agent/src/server/http/routes/piChat.ts` in boring-ui) is Pi-free: zod-validated events (`agent-start/end`, `message-start/delta/part-end/end`, `tool-call`, `tool-result`, `queue-updated`, `usage`, `error`) over REST + NDJSON streaming with monotonic `seq` cursors and replay recovery. PilotSwarm's durable, seq-numbered session events (`getSessionEvents(sessionId, afterSeq)`) map onto this mechanically.
2. **The front is pluggable.** `WorkspaceAgentFront` accepts `requestHeaders` (bearer auth works — fetch-based NDJSON, not EventSource), a custom `useSessions` hook, `plugins`/`extraPanels`/`extraCommands` via `definePlugin`, `ToolRendererOverrides`, `provisionWorkspace={false}`, `navEnabled`, `hotReloadEnabled={false}`.
3. **Skip `boring-core` entirely** (better-auth + Drizzle + Postgres). boring-ui's `apps/workspace-playground` proves the front composes without it. PilotSwarm keeps its Express server, MSAL flow, and authz.
4. **Biggest gap: sessions are flat.** `SessionSummary` = `{id, title, createdAt, updatedAt, turnCount}`. No parent/child trees, no owner filtering, no groups, no rename, no fleet views. All of that must be built as custom panels over existing PilotSwarm RPC.
5. **Theming is a clean contract.** `@hachej/boring-ui-kit/tokens.css` exposes `--boring-*` variables explicitly meant for host override → generate per-theme overrides from `ui-core/src/themes/*`.
6. **Reuse is at the data layer, not the render layer.** The live portal renders via `ui-react/web-app.js` (terminal-grid renderer); the TSX component tree is thin scaffold. Keep `BrowserPortalTransport` + ui-core data modules (`session-tree.js`, `context-usage.js`, `commands.js`); rewrite rendering on boring-ui-kit.
7. **Risk: v0.1.x, single maintainer, recent chat-UI rewrite.** Mitigate with exact pins, org fork validated early, contract tests against its zod schemas, and isolating all boring-ui imports behind `src/v2/` + one adapter package.

## Target architecture

```
Browser
  /v2 (new): WorkspaceAgentFront
      ├─ chat: default PiChatPanel  ←NDJSON/REST→  /api/v1/agent/pi-chat/* (Express)
      ├─ custom useSessions hook    ←/api/rpc→     PortalRuntime (unchanged)
      ├─ PilotSwarm panels (definePlugin): sessions tree, activity, logs,
      │    node map, sequence diagram, fleet stats, artifacts
      │    └─ data via shared context wrapping BrowserPortalTransport
      └─ MSAL gate (existing use-portal-auth) → requestHeaders bearer
  /legacy: existing PilotSwarmWebApp (until cutover)

Server (packages/portal, Express 5 — core unchanged)
  + NEW packages/portal-boring-adapter: PiChatSessionService over PortalRuntime
      subscribe(cursor) → durable events → PiChatEvent mapping
      readState → BoringChatMessage[] snapshot from event history
      prompt/interrupt/stop → sendMessage/cancelPendingMessage/cancelSession
```

## Phases

### Phase 0 — Spike / go-no-go gate (~1.5–2 wks)
- Pin `@hachej/boring-workspace`, `@hachej/boring-agent`, `@hachej/boring-ui-kit` at one exact version; scratch app modeled on boring-ui's `apps/workspace-playground`.
- Throwaway `PiChatSessionService` over `PortalRuntime` (`packages/portal/runtime.js`): event mapping (`assistant.turn_start→agent-start/message-start`, `streaming_progress→message-delta`, `reasoning→message-delta(kind:reasoning)`, `tool.execution_start/complete→tool-call/tool-result`, `turn_end→message-end/agent-end`, `usage→usage`, `session.*→notice`), ~9 Express routes incl. NDJSON streaming + cursor replay.
- MSAL bearer via `requestHeaders` + custom `fetch`; verify mid-stream 401 → reconnect-with-cursor.
- Inventory/stub every endpoint the front probes with `provisionWorkspace={false}`.
- One `definePlugin` panel (LogViewer over WS log tail) to validate panel API + Tailwind-v4 isolation.
- Fork `hachej/boring-ui` into the org; verify it builds (vendoring escape hatch proven).
- **Exit criteria:** live streaming chat with tool calls against a real PilotSwarm session; create/switch/delete sessions; bearer auth everywhere; lossless reconnect; endpoint inventory; fork builds.

### Phase 1 — Foundation (~2–3 wks)
- `packages/portal-boring-adapter/`: production `PiChatSessionService` + Express router; contract tests against boring-ui's zod schemas (`PiChatSnapshotSchema`, `PiChatStreamFrameSchema`); `readState` snapshot builder (semantic reference: `packages/ui-core/src/history.js`).
- Second Vite entry `packages/portal/src/v2/main.tsx`; `server.js` serves `/v2` behind `PORTAL_UX_V2=1`; legacy untouched at `/`.
- Auth: reuse `src/auth/use-portal-auth.js` + `src/auth/providers/entra.js`; `PilotSwarmProvider` context exposing `BrowserPortalTransport` (`src/browser-transport.js`, reused nearly verbatim) to panels.
- Theming: build-time generator `ui-core/src/themes/* → --boring-*` overrides; ship 3–4 themes first.
- CI: build both entries, adapter contract tests, pin check.

### Phase 2 — Chat parity (~2–3 wks)
- Slash commands → `extraCommands` (from `ui-core/src/commands.js`); model picker → `listModels` RPC.
- Tool-call rendering via `ToolRendererOverrides` (replaces ToolCallAccordion).
- Interrupt semantics: `stop→cancelSession`, `interrupt/clearQueue→cancelPendingMessage`; `pending_messages.*→queue-updated`.
- Attachments → `uploadArtifact` RPC; `file` parts → artifact download endpoints.
- Context-usage indicator (reuse `ui-core/src/context-usage.js`).
- `input_required` flow → notice part + answer affordance (model on boring-ui's `ask-user` plugin).

### Phase 3 — Inspector → panels; sessions browser (~3–4 wks, biggest item)
All as `definePlugin` plugins in `packages/portal/src/v2/plugins/`, data via existing `/api/rpc` + WS — no new server work:

| Existing | Disposition |
|---|---|
| Sidebar/session list | **Rewrite**: custom left-nav panel + custom `useSessions` — trees (reuse `ui-core/src/session-tree.js`), owner filter, groups, pinning, rename via existing RPC |
| ActivityPane | Rewrite as panel (raw events via `subscribeSession`) |
| LogViewer | Port (done in spike) |
| NodeMap, SequenceDiagram | Port — data logic reused, render on boring-ui-kit/SVG |
| MarkdownViewer/artifacts | Panel + surface resolver; existing download REST |
| Fleet/orchestration stats | New "Fleet" panel over `getFleetStats`/`getOrchestrationStats` |
| Modals/Help | boring-ui-kit Dialog/AlertDialog; help → command palette |
| StatusBar | `topBarRight` (worker count, connection state) |
| Splash/AgentPicker | Dropped; agent choice in session-create dialog |
| `index.css`, `web-app.js` grid renderer | Dropped at cutover |

### Phase 4 — Rollout & cutover (~1–2 wks + 2 wks bake)
- Parity checklist sign-off on `/v2`.
- Flip: `/` → v2, `/legacy` → old portal (one server flag; instant rollback). Same server/auth/runtime — no data migration.
- Bake ≥2 wks dogfooding; then remove legacy entry and portal's ui-react usage. **ui-core stays** (TUI engine + reused modules).
- Lock vendoring posture: pinned npm + standby fork, or switch to fork if upstream churn bites twice.

## Risks

| Risk | Sev | Mitigation |
|---|---|---|
| 0.x churn / single maintainer | High | Exact pins; org fork validated in Phase 0; zod contract tests; all boring-ui imports isolated in `src/v2/` + adapter package |
| Flat-session gap | High | Custom `useSessions` + nav panel; never rely on built-in SessionBrowser |
| Hidden front→backend endpoints | Med | Phase 0 inventory + inert stub router |
| Token refresh on long NDJSON streams | Med | Fresh token per (re)connect; cursor replay makes reconnects lossless |
| Event-mapping fidelity (compaction, dehydration, sub-agents) | Med | Conservative `notice` mapping; full fidelity in Activity panel (raw events) |
| Theming/CSS collisions | Low | `--boring-*` generator; separate entries, legacy CSS never loads on `/v2` |

## Effort

~10–14 weeks, 1 senior engineer. Phase 0 is a hard go/no-go gate.

| Phase | Estimate |
|---|---|
| 0 — Spike/gate | 1.5–2 wks |
| 1 — Foundation | 2–3 wks |
| 2 — Chat parity | 2–3 wks |
| 3 — Panels + sessions browser | 3–4 wks |
| 4 — Rollout/cutover | 1–2 wks (+2 wks bake) |

## Critical files
- `packages/portal/runtime.js` — RPC surface the adapter wraps
- `packages/portal/server.js` — mount pi-chat routes, `/v2` entry, rollout flag
- `packages/portal/src/browser-transport.js` — reused data layer for panels
- `packages/ui-core/src/history.js` — event-vocabulary reference for snapshot mapper
- `packages/portal/src/auth/use-portal-auth.js` — MSAL flow reused for bearer injection
- `packages/ui-core/src/session-tree.js` — reused in sessions-tree panel

## Verification
- Phase 0 exit criteria demoed live against a running PilotSwarm node (`/v2` scratch app: stream a session with tool calls, kill/reconnect, auth on).
- Adapter contract tests (zod schema validation) + existing `npm run test:all` stays green.
- Phase-2/3 parity checklist exercised manually on `/v2` vs `/legacy` side by side.
- TUI regression: run the Ink TUI after each phase to confirm ui-core untouched.
