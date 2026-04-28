# Changelog

## 0.1.23 — 2026-04-27

### SDK / Runtime

- **Orchestration v1.0.48** — froze `1.0.47` and added a new latest orchestration version that introduces interactive FIFO dispatch priority so user prompts and answers are processed ahead of queued timer fires when both are pending.

### Portal / TUI / Shared UI

- **Portal layout overflow hardening** — workspace grid, columns, pane slots, chat focus shell/body/overlay, mobile workspace/chat panes, panel headers/bodies, action lists, session row content, and markdown links now apply consistent `min-width: 0`, `max-width: 100%`, and `overflow` clamps so narrow widths and long unbroken strings no longer push panes past the viewport.
- **Named-agent session titles** — session rows and chat pane headers now lead with the user-assigned title or uniquifier, then the agent type, then the agent/persona metadata (e.g. `M61 Conductor · R2D Train Watcher · Mad-Eye Moody`), keeping the useful title visible first on narrow/mobile views. The TUI maintainer skill and contributor instructions document this ordering.

## 0.1.22 — 2026-04-23

### SDK / Runtime

- **Env-configurable runtime sizing** — worker/runtime sizing is now controlled by environment variables: `DUROXIDE_PG_POOL_MAX`, `PILOTSWARM_CMS_PG_POOL_MAX`, `PILOTSWARM_FACTS_PG_POOL_MAX`, `PILOTSWARM_ORCHESTRATION_CONCURRENCY`, and `PILOTSWARM_WORKER_CONCURRENCY`.
- **Conservative local defaults restored** — when those env vars are unset, PilotSwarm falls back to the pre-sizing defaults (`duroxide-pg` `10`, CMS `3`, facts `3`, orchestration concurrency `2`, worker concurrency `2`) to avoid exhausting smaller PostgreSQL deployments during local and CI parallel runs.
- **Orchestration v1.0.46** — froze `1.0.45` and moved the live sub-agent cap increase into a new latest orchestration version.
- **Live sub-agent cap raised to 50** — current enforcement in the orchestration and `runTurn` bridge now allows up to 50 running sub-agents per parent session.

### Portal / TUI / Shared UI

- **Session/chat divider cap** — the shared layout now caps the session pane at 50% of the full window height, and the resize controller clamps to that limit in both portal and TUI surfaces.
- **Portal table fit-width fix** — small fit-width markdown/chat tables no longer get forced to span the entire pane width.
- **Resize affordance copy cleanup** — the browser row-resize handle now describes resizing the sessions/chat panes instead of only the session list.

### Deploy / Ops

- **AKS secret wiring for worker sizing** — deploy scripts and docs now pass the runtime/pool env vars through `copilot-runtime-secrets` so production scaling can be tuned at deploy time instead of hard-coded in the SDK.
- **Worker startup diagnostics** — the headless worker example logs resolved runtime and pool env settings at startup for easier incident triage.

### Docs

- **Configuration docs refreshed** — canonical docs now describe the env-only runtime/database sizing model, the restored conservative defaults, and the AKS secret wiring needed to scale those values safely in deployment.

### Tests

- **Shared UI regression coverage** — tests now cover the 50%-cap session/chat layout behavior and the portal fit-width table contract.
- **Parallel local validation** — the heavy `multi-worker` + `reliability` suite pair was rerun in parallel against the restored defaults and passed, confirming the default rollback eliminated the earlier PostgreSQL client exhaustion.

## 0.1.21 — 2026-04-22

### SDK / Artifact Storage

- **Binary-safe artifact pipeline** — `uploadArtifact`, `downloadArtifact`, and `listArtifacts` now carry metadata (`contentType`, `isBinary`, `sizeBytes`, `uploadedAt`, `source`) and preserve raw bytes for binary artifacts instead of forcing UTF-8 text conversion.
- **`write_artifact` binary support** — agents can now write binary artifacts by supplying `encoding: "base64"` with `contentType`; the handler also accepts `content_type` as a compatibility alias.
- **Artifact validation and limits** — binary uploads are validated with `file-type` magic-byte sniffing, reject declared-vs-detected MIME mismatches, and enforce a separate binary size cap via `PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES`.

### Portal / TUI / Shared UI

- **Binary artifact downloads** — the portal download route now returns raw bytes with the stored content type, and the shared browser/runtime transport exposes artifact metadata without forcing binary payloads through text-only preview RPCs.
- **Metadata-aware files inspector** — the shared files browser now stores artifact metadata records, short-circuits binary previews, renders a download-only binary placeholder in the portal, and keeps native download/open flows intact.
- **Files actions and linked items** — the files inspector now supports deleting the selected artifact, and the linked-item picker can open visible `http(s)` URLs alongside artifact downloads.
- **Pane-title cleanup** — shared pane title data stays plain so the portal can paint a compact header strip while the native TUI keeps unhighlighted pane borders; narrow panes now drop low-priority title metadata first.

### System Agents / Management

- **Longer default cron cadences** — `sweeper` now defaults to 30 minutes, `resourcemgr` to 10 minutes, `pilotswarm` supervision to 10 minutes, and `facts-manager` curation to 180 seconds by default.
- **Owner-filter guardrails for system sessions** — autonomous system-session discovery now avoids applying owner filters unless explicitly requested, reducing false "missing system agent" conclusions.

### Docs / Builders / Samples

- **Canonical artifact docs refreshed** — the SDK guide, system reference, builder-template docs, and package READMEs now describe binary artifact handling and the download-only browser contract for non-text files.
- **DevOps sample docs refreshed** — the sample now documents that the same artifact handoff flows can carry binary outputs through `write_artifact` using `contentType` plus base64 encoding.

### Tests

- **Artifact regression coverage** — added focused local tests for binary artifact stores, tool handlers, portal download/meta routes, shared file-browser state, and browser/runtime contract checks.

## 0.1.20 — 2026-04-18

### SDK / Inspection Toolset

- **Agent inspection toolset** — new tools for cross-session inspection by descendant agents and the agent-tuner: `read_agent_events` (lineage-gated descendant transcripts), `read_session_metric_summary`, `read_session_tree_stats`, `read_fleet_stats`, `read_session_skill_usage`, `read_fleet_skill_usage`, `read_session_facts_stats`, `read_fleet_facts_stats`, `read_orchestration_stats`, `read_execution_history`. Tools are registered only on tuner sessions or on descendants with a verified lineage to the requested target.
- **`agent-tuner` system agent** — new auto-spawned permanent child under PilotSwarm with a read-only diagnostic toolset for incident investigation, prompt drift analysis, and reliability/cost/performance forensics. Ships with the new `orchestration-session-lifecycle` skill.
- **Tuner-only `read_facts` lineage bypass** — the agent-tuner can read facts across the fleet without lineage gating; all other callers remain lineage-restricted.

### SDK / Stats Observability

- **Per-session and fleet stats expose** skill usage (static + learned), cache observability (input / output / cache_read / cache_write / hit_ratio), and facts stats (per-session, tree, and shared).
- **Surfaced via `PilotSwarmManagementClient`** as typed read methods, and via the inspect-tools toolset as `read_*` tools so the agent-tuner can reason about the same signals operators see in the stats pane.
- **CMS migrations 0005–0007 and Facts migrations 0003–0004** — stored-procedure–backed reads/writes for the new metric-summary, skill-usage, and facts-stats surfaces. Companion `*_diff.md` files cover the SQL deltas.

### TUI / Portal

- **Stats pane cards** — Tokens, Persistence, Tree, Tokens-By-Model, Skills, Fleet Skills, and Facts cards now render as aligned key/value tables instead of mixed multi-column hand-padded text.
- **Fleet-skills sort** — S (static skill) rows before L (learned skill) rows; named-agent rows before unscoped (`./`); alphabetical within each tier.
- **Fix: scroll resets on stats refresh** — the inspector pane no longer jumps back to the top during a stats refresh. Browser auto-clamp during the transient loading state was overwriting the saved scroll offset; `onScroll` now ignores events that fire while the pane has no scrollable content.
- **System messages routed to activity, not chat** — the per-turn system prompt sent to the LLM is no longer rendered in the chat pane (it was noisy and identical turn-to-turn). It remains recorded in CMS as `system.message` events; the agent-tuner reads them via `read_agent_events` filtered to `event_types: ["system.message"]`.

### Other

- **Bump duroxide** to ^0.1.21.
- **CI workflows** — added `tests.yml` and `copilot-setup-steps.yml`.

## 0.1.19 — 2026-04-16

### SDK / Storage

- **Stored-procedure-backed CMS and Facts access** — the PostgreSQL CMS and Facts providers now route reads and writes through schema-owned stored procedures instead of inline SQL.
- **Shared migration runner** — extracted a reusable advisory-lock migration runner for CMS and Facts, added versioned Facts migrations, and added review diff docs for stored-procedure changes.

### Maintainer Workflow

- **Schema migration maintainer guidance** — contributor instructions now document the stored-procedure migration rules and the repo includes a `schema-migration` skill for future CMS/Facts schema work.

### Tests

- **GitHub Copilot GPT-5.4 test default** — the checked-in test provider fixture now defaults generic test runs to `github-copilot:gpt-5.4`.
- **Contract and wait-affinity hardening** — release test surfaces were updated for the current tool alias set and the orchestration-owned wait resume path.

## 0.1.18 — 2026-04-14

### Portal / Management

- **Sequence stats show orchestration version** — the shared portal/TUI sequence stats panel now renders the duroxide orchestration version when it is available.
- **Management stats are partial-success tolerant** — `PilotSwarmManagementClient.getOrchestrationStats()` now fetches runtime stats and instance info in parallel, includes `orchestrationVersion`, and still returns partial data if either underlying duroxide management call fails.
- **Session views expose orchestration version** — `PilotSwarmManagementClient.getSession()` now carries `orchestrationVersion` on the broader session view and preserves available duroxide data even if one management call fails.

### Tests

- **Management and sequence stats coverage** — updated local tests cover orchestration-version display in sequence stats and the broader management session view.

## 0.1.15 — 2026-04-10

### Portal Auth & Authorization

- **Provider-based auth architecture** — refactored portal auth into a modular provider system (`packages/portal/auth/`). Auth providers, token normalization, and authorization policy are cleanly separated. New files: `auth/index.js`, `auth/config.js`, `auth/providers/`, `auth/normalize/`, `auth/authz/engine.js`.
- **Authorization engine** — group-based allow/deny with email allowlists (Phase 1). Configuration via `PORTAL_AUTHZ_*` env vars and `plugin.json.portal.auth`.
- **Client-side auth providers** — browser-side auth modules (`src/auth/providers/entra.js`, `src/auth/providers/none.js`) and `usePortalAuth()` hook for React integration.
- **Canonical env vars** — all portal auth config uses `PORTAL_AUTH_*` / `PORTAL_AUTHZ_*` prefixes. Legacy `ENTRA_*` aliases are removed.

### SDK / Orchestration

- **Orchestration v1.0.40** — frozen v1.0.39, current v1.0.40. Continued hardening of the durable event loop, session-proxy, session-manager, and blob-store.
- **Code cleanup** — removed ~19K lines of dead code: pruned frozen orchestration versions 1.0.36–1.0.38, removed unused test fixtures, deleted stale proposals and bug reports, and cleaned up legacy theme/controller code across ui-core and ui-react.

### Shared UI

- **Theme refresh** — added Catppuccin Latte, GitHub Light High Contrast, and Solarized Light themes. Removed stale Hacker X and Noctis variants.
- **Selector and controller cleanup** — streamlined ui-core selectors, controller, and reducer for the shared layout.

### Deploy / Ops

- **Deploy script updates** — `deploy-aks.sh` and `deploy-portal.sh` updated for the refactored portal auth architecture.
- **Builder template updates** — portal-builder and azure-deployer agent templates updated for auth/authz architecture.

### npm

- **First npm publish of `pilotswarm-web` (0.1.0)** — the browser portal ships as a standalone npm package.
- **`pilotswarm-ui-core` and `pilotswarm-ui-react` are now bundled** into `pilotswarm-cli` and `pilotswarm-web` via `bundledDependencies` instead of being published separately. Both are marked `"private": true`.
- **Publish pipeline simplified** — workflow publishes 3 packages: sdk → cli → web.

### Tests

- **Portal authz contract tests** — new `portal-authz.test.js` covering authz engine and config.
- **System agent cron contract tests** — new `system-agent-cron-contracts.test.js`.
- **History pane UI tests** — updated `history-pane-ui.test.js`.

## 0.1.14 — 2026-04-06

### Web Portal

- **Browser-native web portal** — replaced the xterm.js PTY-based terminal emulator with a full React SPA. Each browser tab now connects over RPC + WebSocket instead of spawning a separate TUI process.
- **React workspace UI** — new `PilotSwarmWebApp` component with responsive desktop (3-column resizable grid) and mobile (tabbed navigation) layouts. Includes all inspector tabs (sequence, logs, nodes, history, files), modals, prompt composer, and keyboard shortcuts.
- **Entra ID authentication** — optional MSAL-based auth gate with PKCE flow and mobile redirect support. Enable by setting `PORTAL_AUTH_PROVIDER=entra`, `PORTAL_AUTH_ENTRA_TENANT_ID`, and `PORTAL_AUTH_ENTRA_CLIENT_ID`; omit them to run without auth.
- **Browser transport** — `BrowserPortalTransport` class handles RPC dispatch over `/api/rpc` and live session/log subscriptions over WebSocket (`/portal-ws`).
- **Portal server rewrite** — Express server now serves the Vite-built SPA, dispatches RPC calls to `PortalRuntime`, and bridges WebSocket subscriptions for session events and logs.
- **Artifact downloads** — portal supports file artifact downloads through a dedicated endpoint.

### SDK / Runtime

- **Duroxide 0.1.19** — bumped from 0.1.18; includes duroxide-pg 0.1.29 with advisory lock for concurrent migration safety. Eliminates the startup race where multiple workers crash on `duplicate key value violates unique constraint "_duroxide_migrations_pkey"` during fresh DB initialization.

### Shared UI

- **File browser selection** — added `selectFileBrowserItem()` click handler for artifact preview in the files inspector.
- **Programmatic tab switch** — added `selectInspectorTab()` to the controller for navigating inspector panes with data prefetch.
- **Responsive stats** — compact orchestration stats rendering for narrow viewports with abbreviated prefixes.
- **Wide column mode** — `buildSequenceViewForSession()` and `buildNodeMapLines()` accept `allowWideColumns` to avoid truncating node labels on tablet/mobile.
- **History inspector** — now displayed with wrapping enabled, bottom-anchored scroll, and smaller footer strip.
- **Keybinding updates** — replaced `T themes` hint with `[/] side pane` for show/hide side panels on desktop.

### Deploy / Ops

- **Portal k8s manifests** — new `portal-deployment.yaml` and `portal-ingress.yaml` with AKS app-routing nginx, Let's Encrypt TLS via cert-manager, and Entra auth env injection from `copilot-runtime-secrets`.
- **Portal Dockerfile** — Vite build runs in-image; serves `dist/` as static SPA root. No PTY native dependencies.
- **Portal deploy script** — new `scripts/deploy-portal.sh` for building, pushing, and rolling out the portal image.
- **AKS region move** — portal ingress updated from `westus2` to `westus3` domain; LB IP `4.249.58.118`.
- **AKS deployer docs** — updated agent and skill to cover portal deployment, ACR secret refresh procedure, duroxide migration advisory, and portal TLS model.
- **Corp-specific deployer files gitignored** — corp AKS deployer agent and skills are local-only and excluded from checked-in code.

### Fixes

- **Shift+T keybind** — theme picker no longer activates when focus is on the prompt input.

## 0.1.13 — 2026-04-04

### Terminal UI

- **Single TUI cutover** — removed the old blessed implementation and the temporary split between terminal UI stacks. PilotSwarm now ships one terminal UI built from [`packages/cli/`](packages/cli), [`packages/ui-core/`](packages/ui-core), and [`packages/ui-react/`](packages/ui-react).
- **Shared UI architecture** — session tree, chat, activity, sequence, node map, files inspector, prompt editor, and modal flows now live in shared layers instead of a monolithic host file. This includes artifact upload/open/filter flows, rename dialogs, multiline prompt editing, mouse copy, sticky inspector headers, and terminal rendering cleanup.
- **TUI performance pass** — session-list rendering now slices visible rows before building view models, and the React host subscribes to narrower state slices so typing latency and large session-list scrolling stay snappy.
- **Word-level text wrapping** — message cards, question cards, and all rich-text rendering now wrap at word boundaries instead of breaking mid-word.
- **DevOps sample migration** — the layered DevOps sample now runs on the shipped terminal UI rather than the removed blessed-only path.

### SDK / Orchestration

- **Orchestration v1.0.33** — the flat durable event loop matured with inline control tools, explicit turn boundaries, context usage reporting, improved prompt layering, child-session status handling, and frozen replay versions `1.0.31` and `1.0.32`.
- **Session recovery hardening** — `runTurn` now treats Copilot-side `Session not found` as a recovery path: invalidate warm state, resume or hydrate once, inject a recovery notice, and fail unrecoverably instead of retrying forever when state is truly gone.
- **Autonomy and cron hardening** — default/system prompts now explicitly tell autonomous agents to use durable waits/cron for ambiguous long-running work, ask the user when intent is unclear, and avoid wasting tokens in in-turn polling loops.
- **Session/tooling fixes** — generic sessions now inherit default tool layers correctly, manual title locking prevents later auto-retitling, and cascading cancel/done plus terminal child status handling are more consistent.
- **Monitoring compatibility fix** — resource-manager monitoring now uses Duroxide management APIs for system metrics and queue depths instead of querying Duroxide internal tables directly.
- **Orchestration stats API** — new `getOrchestrationStats(sessionId)` on `PilotSwarmManagementClient` exposes duroxide history size, queue depth, and KV usage per session. Wired through the CLI transport and visible in the TUI sequence pane.

### Tests / Ops

- **Recovery and control contracts** — added regression coverage for inline control tools, session recovery/failures, terminal child states, resource-manager monitoring, and orchestration prompt/tool contracts.
- **Test hygiene** — [`scripts/run-tests.sh`](scripts/run-tests.sh) now cleans stale local test schemas and temp session layouts before and after runs to reduce environmental contamination.
- **Reset/deploy cleanup** — stale legacy queue-table assumptions were removed from reset helpers and resource monitoring paths.
- **Deploy script hardening** — `deploy-aks.sh` now waits for all worker pods to fully terminate before dropping schemas during destructive resets, preventing `cached plan must not change result type` errors. ACR pull-secret refresh is now part of the deploy workflow.

### Recommended Reading

- **TUI architecture** — [`docs/tui-architecture.md`](docs/tui-architecture.md)
- **TUI implementor guide** — [`docs/tui-implementor-guide.md`](docs/tui-implementor-guide.md)
- **Main orchestration loop** — [`docs/orchestration-loop.md`](docs/orchestration-loop.md)
- **Inline control / explicit turn boundaries proposal** — [`docs/proposals/inline-sub-agent-tools-and-explicit-turn-boundaries.md`](docs/proposals/inline-sub-agent-tools-and-explicit-turn-boundaries.md)
- **TUI design spec** — [`docs/proposals/tui-design-spec.md`](docs/proposals/tui-design-spec.md)
- **Session-store-driven durability proposal** — [`docs/proposals/session-store-driven-durability.md`](docs/proposals/session-store-driven-durability.md)
- **Session-loss bug report and recovery context** — [`docs/bugreports/runTurn-session-not-found-infinite-retry.md`](docs/bugreports/runTurn-session-not-found-infinite-retry.md)

## 0.1.12 — 2026-03-28

### SDK

- **Durable cron scheduling** — new `cron` tool for recurring agent wakeups. Agents call `cron(seconds=N, reason="...")` to start durable recurring schedules that survive process restarts, `cron(action="cancel")` to stop. CMS events: `session.cron_started`, `session.cron_fired`, `session.cron_cancelled`.
- **Context visibility** — token usage tracking via `contextUsage` field (currentTokens, tokenLimit). Compaction events surfaced in CMS. TUI status bar shows context usage percentage.
- **Orchestration v1.0.31** — cron loop integration, context usage tracking, `ensureWarmResumeCheckpoint` for crash-safe continueAsNew, improved spawn_agent follow-up queueing.
- **Orchestration versioning cleanup** — pruned 19 legacy frozen versions (v1.0.0–v1.0.25), retained v1.0.26–v1.0.30 for in-flight replay compatibility.
- **KV response transport** — response payloads stored via durable key-value instead of inline customStatus, reducing orchestration history bloat.

### CLI / TUI

- **CMS-backed sequence diagram** — sequence view now driven by CMS events with worker-node tracking, replacing log-line parsing.
- **Node Map view** — new visualization showing which worker pod runs each session. Lazy-loads CMS timelines for all sessions.
- **Context usage display** — status bar shows token count and percentage for the active session.
- **Preview→final in-place replacement** — assistant message transitions no longer cause scroll jumps or focus resets.
- **Null guards** — `safeSlice`, `safeTail`, `normalizePodName` protect against null worker/session IDs in all render paths.

### Tests

- 7 new test suites: `cron-tool`, `context-usage` (3 suites), `cms-seq-nodemap`, `tui-null-guards`, `orchestration-warm-resume`, `system-agent-cron-contracts`, `temp-session-cleanup`.
- Test stability fixes for parallel execution and model provider config.

### Docs & Templates

- CMS-derived sequence diagram & node map spec (`docs/proposals/`).
- Cron tool implementation spec (`docs/proposals-impl/cron-tool.md`).
- System reference updated with cron and context usage.
- Builder template skills updated with cron/context-usage guidance.
- New AKS deploy and reset skills.

## 0.1.10 — 2026-03-24

### SDK

- **Knowledge pipeline** — new durable facts system with namespace-controlled knowledge sharing across agent sessions. Facts Manager system agent curates intake evidence into shared skills and asks. Orchestration v1.0.24.
- **Facts Manager agent** — new system agent (`facts-manager.agent.md`) that reads intake observations from task agents, curates them into shared `skills/` and `asks/` namespaces, and maintains the knowledge index.
- **Namespace access control** — fact tools enforce per-agent write restrictions: task agents write to `intake/`, Facts Manager writes to `skills/`, `asks/`, `config/`. Prevents cross-contamination.
- **Knowledge index injection** — orchestration injects curated skills and active asks into agent prompts before each turn (skipped for facts-manager to avoid circular injection).
- **Anthropic BYOK fix** — corrected `baseUrl` for Anthropic provider (no `/v1` suffix — SDK handles path internally). Direct Anthropic API now works for all Claude models.
- **Model example updates** — spawn_agent tool description now uses valid model examples instead of removed `azure-openai:gpt-4.1-mini`.

### Docs

- **Model evaluation report** — comprehensive 6-model eval across 14 test suites (2,160 test executions). Results in `docs/models/eval-2026-03-24.md`.
- **Agent tuning log** — updated model compatibility matrix with eval pass rates, resolved open questions about Kimi-K2.5 and model-router behavior.

### Infrastructure

- **Orchestration v1.0.24** — added agent identity injection and knowledge pipeline context loading to the main turn loop.
- **Frozen orchestration v1.0.23** — previous version preserved in `orchestration_1_0_23.ts` for in-flight replay compatibility.

## 0.1.9 — 2026-03-23

### Web Portal (New)

- **React-based web UI** — new `packages/portal/` with session management, chat, inspector panes (activity, logs, sequence diagram, node map), markdown viewer, agent/model pickers, and a WebSocket bridge. Start with `./scripts/portal-start.sh`.

### SDK

- **BYOK model providers** — removed hard dependency on GitHub Copilot token. Workers can now run entirely on Azure AI Foundry (or any OpenAI-compatible endpoint) without a `GITHUB_TOKEN`. Deploy script no longer auto-discovers `gh auth token`.
- **Model provider filtering** — `model-providers.ts` now filters out providers with missing API keys at startup instead of failing at call time.
- **English-only prompt hardening** — default agent prompt now instructs models to respond exclusively in English, preventing non-English output from multilingual models (e.g. GLM).
- **Orchestration determinism fix** — orchestration v1.0.23 patched for tighter replay safety on session-proxy activity dispatch.

### CLI / TUI

- **Prompt editor keybindings** — Ctrl+J inserts newline, Ctrl+W deletes word backward, cursor up/down navigates multiline input. Fixed Alt+Backspace/Left/Right being swallowed by the escape handler.
- **Context-sensitive status bar** — keybinding hints update dynamically based on focused pane (sessions, chat, prompt, log views, markdown viewer).
- **File attach (Ctrl+A)** — modal dialog to attach a local file: uploads to artifact store, registers for `a` picker and `v` viewer, shows 3-line preview in chat, inserts `📎 filename` token in prompt.
- **Artifact picker improvements** — `a` key now gathers artifacts from the active session and all descendants, adds "Download All" option for multi-file sessions, toggle open/close with `a`.
- **Log view alignment fix** — pressing `m` or `v` to cycle views now triggers `scheduleLightRefresh` to fix layout alignment without needing a manual `r` refresh.

### Infrastructure

- **Deploy script cleanup** — `deploy-aks.sh` no longer injects `GITHUB_TOKEN` from `gh auth token` into K8s secrets. Token is only included if explicitly set in the environment.
- **Reset script** — `reset-local.sh` updated for remote-mode support and improved cleanup.
- **Portal scripts** — new `portal-start.sh` and `portal-stop.sh` for managing the web portal process.

### Docs

- **Agent tuning log** — new `docs/agent-tuning-log.md` with model compatibility matrix and prompt hardening notes.
- **Configuration docs** — updated for BYOK provider setup and model provider filtering.

## 0.1.8 — 2026-03-21

### SDK

- **Facts table descendants scope** — new `scope="descendants"` on `read_facts` for reading all sub-agent session-scoped facts at once. Parent agents can also pass `session_id=<child>` to read a specific descendant's private facts (lineage verified via CMS). orchId format (`session-<uuid>`) is auto-normalized.
- **Facts row limit uncapped** — removed the 200-row hard cap on `read_facts`. Default remains 50; callers can raise `limit` as needed.
- **Default agent prompt** — updated with descendants facts guidance and sub-agent fact retrieval rules.

### CLI

- **TUI inline spinner** — animated braille spinner (`⠋ Thinking…`) appears in the chat window when the agent is processing. Automatically removed when the response arrives.

### Tests

- **Facts descendants tests** — new tests for `scope="descendants"`, lineage-aware `session_id`, orchId normalization, multi-level hierarchy access, and `key_pattern` combos.

### Docs

- **Facts table design spec** — new `docs/facts-table.md` covering schema, tool API, scoping, and lifecycle.
- **Facts table test spec** — new `docs/facts-table-tests.md` covering existing and recommended test coverage.

## 0.1.7 — 2026-03-20

### SDK

- **Wait-affinity for durable timers** — new `wait-affinity.ts` module and orchestration support for preserving worker affinity across `wait` calls. Long waits can optionally keep the session pinned to the same worker instead of rotating. Orchestration bumped to 1.0.23 with frozen versions 1.0.21 and 1.0.22.
- **Managed session improvements** — enhanced `runTurn` logic in `managed-session.ts` with better tool merge handling and agent tool resolution.
- **Default agent prompt** — updated system prompt with improved tool usage directives.
- **Durable timers skill** — updated guidance for wait-affinity behavior.

### CLI

- **TUI history recovery** — improved `loadCmsHistory` with better recovery from corrupted or incomplete CMS state.
- **Remote-mode agent loading** — TUI now uses `loadAgentFiles` import from SDK for consistent agent file parsing.

### DevOps Sample

- **New `builder` agent** — added `builder.agent.md` to the DevOps Command Center sample.
- **Expanded tools** — additional mock tools added to `tools.js`.
- **SDK app improvements** — enhanced `sdk-app.js` and updated test suite with new test cases.
- **README** — updated with new agent and tool documentation.

### Builder Templates

- **Azure deployer skills split** — new `pilotswarm-aks-identity/SKILL.md` and `pilotswarm-azure-lessons/SKILL.md` extracted from the monolithic Azure deployer skill for better modularity.
- **CLI builder** — launcher script guidance updated; `run.sh` replaces `run-local.js` pattern.
- **SDK builder** — launcher script guidance added; `run.sh` included in preferred structure.

### Tests

- **Wait-affinity tests** — new `wait-affinity.test.js` suite verifying affinity rotation and preservation.
- **Tool merge contracts** — new contract tests for agent tool merge behavior.
- **No-tools override** — new sub-agent test for agents with no explicit tools.

### Docs

- **Wait-affinity proposal** — new design doc at `docs/proposals/wait-preserve-worker-affinity.md`.
- **Agent contracts** — updated with tool merge contract documentation.

## 0.1.6 — 2026-03-19

### SDK

- **Reject `default` as session agent** — `createSession` with `agentId: "default"` now throws immediately. The `default` agent is a prompt overlay, not a selectable session agent.

### CLI

- **Filesystem artifact fallback in TUI** — artifact downloads now use `FilesystemArtifactStore` when Azure Blob is not configured, so `artifact://` links work in local mode.
- **Remote-mode session policy** — TUI loads `session-policy.json` and agent definitions from the plugin directory even when there are no embedded workers, ensuring policy enforcement in remote mode.

### Builder Templates

- **`default.agent.md` semantics** — CLI and SDK builder skills now document that `default` is reserved as a prompt overlay and must not be used as a session agent name.
- **Launcher script standardized** — CLI and SDK builders now generate `scripts/run.sh` supporting both local and remote modes (`.env` / `.env.remote`).
- **Session policy in remote mode** — builder skills note that policy is enforced in both local and remote modes.
- **Azure deployer** — new constraint: never reuse or modify existing Azure resources without explicit user approval. Added "Lessons Learned" section covering RBAC with corporate conditional access, PostgreSQL region restrictions, and Azure Key Vault with Secrets Store CSI.

## 0.1.5 — 2026-03-18

### SDK

- **Filesystem artifact store** — `write_artifact`, `read_artifact`, `export_artifact`, and `list_artifacts` now work without Azure Blob Storage. In local mode a `FilesystemArtifactStore` stores artifacts under `~/.copilot/artifacts/<sessionId>/`. New `ArtifactStore` interface lets both backends be used interchangeably.
- **Exclude Copilot SDK's built-in `task` tool** — added `excludedTools: ["task"]` to `createSession` config so the LLM uses PilotSwarm's durable `spawn_agent` instead of the SDK's in-process sub-agent mechanism.
- **Default agent prompt** — added critical rule #6 reinforcing `spawn_agent` over any built-in `task` tool.

### CLI

- **`loadCmsHistory` concurrency fix** — refactored to deduplicate concurrent loads via a promise cache and added a `force` reload option.

### Scripts & Tooling

- **`reset-local.sh`** — new step deletes local artifact directories (`~/.copilot/artifacts/<sessionId>/`) for CMS sessions being cleaned up.
- **Release skill** — full test suite (`./scripts/run-tests.sh`) is now mandatory before any official release, no partial runs.

### DevOps Sample

- **`scripts/cleanup-local-db.js`** — new cleanup script that queries CMS session IDs, removes artifact dirs, session state dirs, and session store archives before dropping schemas.
- **README** — added "Resetting Local State" section and updated directory structure.

### Builder Templates

- **CLI builder** — cleanup scripts must now also purge local artifact files and session state.
- **SDK builder** — output shape includes `scripts/cleanup-local-db.js`; new "Local Cleanup Guidance" section; workflow step added.

### Docs

- **`writing-agents.md`** — artifact tool availability updated from "Blob storage configured" to "Always (local filesystem or blob)".

## 2026-03-01

### CLI (`bin/tui.js`)

- **New CLI entry point** — `npx pilotswarm-tui` with full arg parsing via `node:util.parseArgs`.
  Two modes: `local` (embedded workers) and `remote` (client-only, kubectl log streaming).
- **Env file loading** — `.env` / `.env.remote` parsed automatically; CLI flags take precedence.
- **All flags have env var equivalents** — `--store`→`DATABASE_URL`, `--plugin`→`PLUGIN_DIRS`,
  `--worker`→`WORKER_MODULE`, `--workers`→`WORKERS`, `--model`→`COPILOT_MODEL`,
  `--system`→`SYSTEM_MESSAGE`, `--namespace`→`K8S_NAMESPACE`, `--label`→`K8S_POD_LABEL`,
  `--log-level`→`LOG_LEVEL`. Zero-flag operation possible with everything in `.env`.

### TUI

- **Moved from the old standalone example into the shipped TUI package** — the terminal UI became a maintained product surface instead of a one-off example.
- **Parameterized hardcoded values** — system message, K8s namespace, K8s pod label, and worker
  module path all read from env vars set by the CLI.
- **Emoji rendering fix** — terminal width handling was corrected so wide emoji render predictably instead of corrupting layout.
- **Session switch repaint fix** — switching sessions now triggers the same full
  `screen.realloc()` + `relayoutAll()` cycle as pressing 'r', plus a deferred
  repaint on next tick. Fixes stale content bleeding through on first switch.
- **Log mode switch repaint fix** — pressing 'm' to change log view mode now also
  triggers the full 'r'-equivalent repaint.
- **Clean exit** — shutdown now suppresses terminal junk and restores the screen cleanly on exit.
- **Startup terminal cleanup** — noisy terminal capability output on startup is suppressed.

### `run.sh`

- Updated to use `node bin/tui.js local|remote` instead of setting env vars and calling
  the old example launcher directly.

### `package.json`

- Added `bin` field for `pilotswarm-tui` → `bin/tui.js`.
- TUI runtime dependencies moved from `devDependencies` to `dependencies`.
- `files` includes the terminal UI binary and shipped assets.
- NPM scripts updated to use new CLI.

### Docs

- **`building-apps.md`** — deployment topology diagrams updated to reference
  `npx pilotswarm-tui` / `node bin/tui.js`. CLI reference shows env var
  equivalents for all flags. Intro updated to remove stale `tui-apps.md` cross-ref.
- **`README.md`** — TUI docs updated to point at the shipped terminal UI entrypoint.
- **`examples.md`** — example docs updated to point at the shipped terminal UI entrypoint.
