# Changelog

## 0.1.14 — 2026-04-06

### Web Portal

- **Browser-native web portal** — replaced the xterm.js PTY-based terminal emulator with a full React SPA. Each browser tab now connects over RPC + WebSocket instead of spawning a separate TUI process.
- **React workspace UI** — new `PilotSwarmWebApp` component with responsive desktop (3-column resizable grid) and mobile (tabbed navigation) layouts. Includes all inspector tabs (sequence, logs, nodes, history, files), modals, prompt composer, and keyboard shortcuts.
- **Entra ID authentication** — optional MSAL-based auth gate with PKCE flow and mobile redirect support. Enable by setting `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`; omit both to run without auth.
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
