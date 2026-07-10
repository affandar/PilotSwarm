# Changelog

## 0.5.6 — 2026-07-10

### SDK / API / MCP

- **Context-window tier is now part of the Switch Model path, end to end.** The
  durable `set_model` command handler applies `contextTier` to the session
  config like reasoning effort — omitted preserves the current tier, present
  rebinds the model on the next turn (via the existing `requiresModelRebind`).
  `management-client.setSessionModel` (and the web-management client) validate
  the tier against the target model's `supportedContextTiers` and forward it,
  and the MCP `switch_model` tool gains a `context_tier` argument (Web API
  mode). The `POST /management/sessions/:id/model` body accepts `contextTier`.

### Portal / TUI

- **Switch Model offers the context-window step.** Previously the picker chain
  was model → effort → apply; for tier-capable models it is now model → effort
  → context window → apply (tier-less models still apply directly), preselecting
  the smaller window. Works in both the portal and the TUI.
- **Switch Model is reachable in the TUI.** It had no keybinding (only the
  portal button); it is now bound to `Shift+M` (sibling of `Shift+N` =
  new+model) and listed in the keybinding help.

## 0.5.5 — 2026-07-10

### Portal / TUI

- **Answers to a pending question are delivered immediately instead of being
  queued.** A question renders from the live `session.input_required_started`
  event well before the slower `customStatus` detail-sync populates
  `session.pendingQuestion`. An answer typed inside that window failed the
  `pendingQuestion` gate and fell through to the outbox queue — where, being a
  queued message rather than an orchestration answer, it sat unconsumed until
  the next send flushed it. The controller now sets `pendingQuestion` + status
  synchronously from the event (which already carries the question, choices, and
  freeform flag) so the answer takes the direct `sendAnswer` path, and guards
  that freshly-shown question against a stale same-age detail-sync that raced
  the event. Affects both the portal and the TUI.

## 0.5.4 — 2026-07-10

### SDK

- **Context-window tier selector.** Sessions can now choose a Copilot
  context-window tier via a new `contextTier` field (`"default"` |
  `"long_context"`) on the creation APIs, threaded from `model_providers.json`
  (`supportedContextTiers` / `defaultContextTier`) through `createSession`, the
  durable orchestration input, and the worker's `CopilotSession`. Tiers are
  declared per-model and **always default to the smaller ("default") window**;
  models that declare no tiers are unaffected. This closes the gap where the
  same model reported wildly different context limits depending only on the CLI
  version.
- **Upgraded to the 1.0.70 Copilot CLI and 1.0.6 Copilot SDK** (from 1.0.50 /
  1.0.0-beta.4). The newer CLI introduces the context-window tiers above and no
  longer exposes the built-in `report_intent` / `write_bash` tools.
- **Reasoning effort now survives session creation.** The durable orchestration
  input (`serializableConfig`) had been dropping `reasoningEffort`, so a fresh
  session ran at the model's default effort even though the CMS and UI showed
  the requested level (only a later *Switch Model* would take effect). The
  serialized config now carries both `reasoningEffort` and `contextTier`.
- **Model catalog refresh.** Added GPT-5.6 (`sol` / `luna` / `terra`) alongside
  Claude Opus 4.8, and retired Claude 4.6/4.7 and GPT-5.5 from the GitHub
  Copilot provider.
- **More descriptive session titles.** The title-generation prompt now asks for
  a task/topic-naming 4–8 word title (ignoring status chatter and filler)
  instead of a terse 3–5 word fragment, with defensive quote/punctuation
  stripping on the result.
- **Stop persisting `assistant.tool_call_delta` to the CMS.** The assembled
  tool call is already recorded as `tool.execution_start`; persisting the
  streaming deltas flooded the capped history buffer and evicted the milestone
  events the sequence diagram plots (leaving it blank). The delta is now
  ephemeral, like the other streaming deltas.

### Portal / TUI

- **Context-window picker.** The new-session flow gains a dedicated
  context-window step after the reasoning-effort picker, offered only for
  models that declare tiers, preselecting the smaller window. Wired into both
  the portal and the TUI.

## 0.5.3 — 2026-07-09

### SDK

- **User-stopped turns record their prompt's `clientMessageIds`.** When a turn
  is stopped mid-flight, the durable `session.turn_stopped` event now carries
  the interrupted prompt's `clientMessageIds` — on both stop paths (the
  abort-race that cancels an in-flight turn and the self-unwind where the turn
  returns "stopped"). This lets clients correlate the stop back to the exact
  prompt. Purely additive to the event payload — the durable-operation surface
  is unchanged, so no orchestration version bump.

### Portal / TUI

- **Denser session list.** The session list is now single-line rows with a
  right-aligned context-% column (green / amber ≥70 / red ≥85, `⇊` while
  compacting), owner chips that surface only in a genuine multi-user context,
  group rails, coarse relative-time buckets (`<1min · Nmin · NhMMm · NdHHh ·
  Nw`), a compact `⏱` glyph for scheduled sessions, and an id·age·model·ctx
  detail line that expands under the selected row. Untitled sessions pull
  id·age·model onto the main line instead of rendering a bare `(guid)`.
- **User-stopped prompts are marked.** A prompt whose turn you stopped now
  shows an amber ⊘ ("no-parking") marker instead of the green `✓✓` sent check
  — it was delivered, but you interrupted the turn, so it reads as stopped
  rather than fully processed. Works in both the portal and the TUI.
- **Crisp chat edge fades.** The transcript's top/bottom fades track real
  overflow (no fade when nothing is clipped), and the wasted left gutter in the
  chat/sequence panes is reclaimed.
- **TUI fixes.** Esc on an empty prompt exits to navigation instead of being
  swallowed; the live-activity strip and queued-prompt overlay are pinned to
  the chat foot (matching the portal); and queued prompts render again (the
  ChatPane selector had been dropping the outbox).

## 0.5.2 — 2026-07-08

### SDK

- **First-class System user for GitHub Copilot keys.** Ownerless system
  sessions (`owner: null`) previously could not use GitHub Copilot models on
  deployments without a worker-level `GITHUB_TOKEN` — per-user keys resolve
  only through the session owner. A new `SYSTEM_USER_PRINCIPAL`
  (`system`/`system`) lets an admin store a Copilot key on the system user;
  ownerless `isSystem` sessions resolve it through the same per-user path
  (fresh read per turn, warm-client recycling on change), and an owner's key
  always wins for owned sessions. New management APIs
  `setSystemGitHubCopilotKey` / `getSystemGitHubCopilotKeyStatus` (admin,
  key never returned; the acting admin is recorded for audit).

### Portal / TUI

- **Live-activity strip replaces the Working card.** The multi-line bordered
  card is now a single dim status line pinned in the bottom-sticky strip
  (portal) / below the transcript (TUI), so it stays put while chat scrolls
  and drops the instant the turn ends. It shows a high-level phase — including
  first-class fact-store, graph-store, and skill phases (`reading facts…`,
  `writing to the graph…`, `loading skills…`) — never raw event payloads.
  The turn timer is scoped to the current turn (no idle-gap flash on a new
  turn).
- **Admin Console "Store as System key"** — an admin-only checkbox retargets
  the key editor to the system user, with provenance in the status line.
- **Mobile pane-header fixes** — title-right meta keeps its `·` separators
  when compacted (no more `runninggpt-5.4ctx…`), descenders in the header
  meta are no longer clipped, and the chat transcript fades its top/bottom
  edges instead of shearing partial rows.

### Maintainer Workflow

- **Default plugin MCP config trimmed.** The bundled plugin dir ships zero MCP
  servers by default (context7 removed); deployments add their own via
  `PLUGIN_DIRS`.

## 0.5.1 — 2026-07-08

### SDK

- **Snapshot store-wins reconcile (orchestration 1.0.59).** The turn preamble
  now treats one snapshot-store probe as the only reconcile oracle and retires
  the `expectedVersion` fence: a store that advanced under a foreign turnKey is
  adopted (hydrated), never fenced, and `expectedVersion` no longer rides in
  the 1.0.59 `runTurn` input. New observability events:
  `session.snapshot_lineage_jump` (forward/backward lineage divergence
  witnessed by the orchestration's version mirror), `session.snapshot_regressed`
  (store below the worker's local marker), and a richer
  `session.snapshot_unpublished` carrying the winning store coordinates for
  superseded commits. User-stopped turns skip the snapshot commit entirely.
  The previous latest is frozen as `orchestration_1_0_58/`. Design doc:
  `docs/proposals/snapshot-store-wins.md`.
- **`wait_for_agents` deadlock fix.** An explicit `completed` child update is
  no longer downgraded by a concurrent `waiting` status probe — that probe
  usually observes the auto-resumed remainder of a wait timer the parent's own
  message interrupted. Previously a parent could wait forever on a child that
  had already delivered its final answer; resolution depended on the child
  volunteering a second answer at an idle moment. Deliberate continuation
  waits still arrive as updateType `wait` and keep their semantics.
- **Faster failure surfacing.** `PilotSwarmClient` turn waits throw
  immediately on terminal auth-failure statuses (`authFailure: true`) instead
  of burning the caller's full timeout in silence.

### Portal + TUI

- Live-activity "Working" card follows the session's running state instead of
  disappearing when the first assistant message lands (streamed and
  tool-interleaved replies kept the turn going after text appeared).
- Chat status, session refresh, and pending-outbox UX fixes across the portal
  and native TUI; persistent chat-header session-meta.
- Proposal doc: `docs/proposals/session-transcript-continue-as-new.md`.

### Tests

- Local-suite preflight fails fast with an actionable message when the default
  test model is GitHub Copilot-backed and `GITHUB_TOKEN` is unset, instead of
  every live test timing out opaquely.
- Deterministic harness coverage for store-wins lineage jumps, unpublished
  snapshots, and `wait_for_agents` resolution; ui-core live-activity tests.

## 0.5.0 — 2026-07-06

_Backfilled from the v0.5.0 GitHub Release notes (the entry was missed at
release time)._

### SDK

- **MCP server reaches Web API parity.** New tools — artifacts, capabilities,
  debug, facts-enhanced, graph, groups, observability, system, turn-control —
  plus artifacts/capabilities/graph resources, dispatch/registration unit
  tests, and a live parity harness.
- **Sonnet 5 model config.** `github-copilot:claude-sonnet-5` added to the
  model provider configs (example, ghcp, gitops worker base) and adopted as
  the default GitHub Copilot model.

### npm

- All packages bumped to 0.5.0 (`pilotswarm-sdk`, `pilotswarm-horizon-store`,
  `pilotswarm`) with inter-package specs raised to `^0.5.0`.

### Ops

- Portal Dockerfile, MCP k8s manifest, and `deploy-mcp.sh`; `run.sh`
  stale-path fixes.

## 0.4.1 — 2026-07-04

### SDK

- **CMS migration 0025 — typed session-event reads.** 4-arg overloads of
  `cms_get_session_events` / `cms_get_session_events_before` accept
  `p_event_types TEXT[]` (NULL = unfiltered) plus a composite
  `(session_id, event_type, seq)` index. The 3-arg procs remain for
  mixed-version rollouts; `PgSessionCatalog` falls back to them on
  Postgres 42883 against pre-0025 databases. `eventTypes` threads through
  the management clients, the operations table (`eventTypes` JSON query
  param on both event ops), the HTTP transport, the portal runtime, and
  the node transport.
- **CMS migration 0026 — `sessions.splash_mobile`.** Narrow-viewport splash
  variant: agent frontmatter `splashMobile`, a capability-probed 9-arg
  `cms_create_session` overload, a jsonb update rule for the spawn paths,
  and the fixed-column read procs recreated in lockstep
  (`cms_get_session`, `cms_list_sessions`, `cms_list_group_sessions`).
- **Worker fail-fast CMS boot.** CMS initialization failure at boot no
  longer degrades silently into a catalog-less worker (which never
  registered sweeper/resource-manager tools and made system agents run
  tool-less). Boot retries five times with backoff, then fails the pod.
- Agent frontmatter `splashMobile` (inline and block scalar), threaded
  through spawn paths, session views, and `createSessionForAgent`.
- Mgmt system agents (pilotswarm, sweeper, resourcemgr, facts-manager,
  agent-tuner) ship house-style mobile splashes.

### Portal / UI

- **Chat history pull is transcript-dense.** The pull-to-load-older path
  passes the renderable message types server-side, so noise-dominated
  sessions load pages of chat instead of raw event noise; a short filtered
  page marks the transcript complete. Old servers ignore the param and
  degrade to raw paging.
- **Touch scrolling keeps native momentum.** Programmatic scroll restores
  are suppressed while a gesture or its glide is in flight, so flicks
  accelerate naturally.
- **Explicit touch pulls always load.** A pull-down at the top of the pane
  forces the history load, bypassing the arm handshake and the
  DOM-vs-render-metrics offset gate that could silently swallow pulls on
  narrow viewports (including splash-only sessions).
- **Per-session memory.** Chat scroll offsets are saved and restored per
  session, and re-entering a session catches up the in-memory expanded
  history with a delta fetch instead of replacing it — pulled-in older
  history survives session switches. New chat still snaps to latest.
- Splash-to-chat transitions land on the latest messages.
- Splash art wider than the pane no longer produces horizontal scrollbars
  on narrow screens: it wraps, or the renderer swaps in the `splashMobile`
  variant when one exists (agents, plugin.json `splashMobileFile`, and the
  default PilotSwarm brand all ship compact colorful mobile art).
- Focus-mode overlay is fully opaque on themes with translucent surfaces,
  and session-list rows no longer flex-compress and overlap when the list
  overflows.

### Tests

- New suites: typed event-filter integration, chat-pull gating, splashMobile
  end-to-end, per-session memory. `validateSessionAfterTurn` polls for the
  post-turn CMS state instead of single-sampling (flaky under overlay load),
  and the pg-migrator routine check counts DISTINCT names (one row per
  overload since 0025).

## 0.4.0 — 2026-07-03

### Packaging — the big consolidation (9 directories → 3 packages)

- **New `pilotswarm` npm package** — the application package. One install
  ships every user-facing surface with the same bin names as before:
  `pilotswarm` (TUI; `pilotswarm-cli` alias), `pilotswarm-web` (portal server
  + Web API), `pilotswarm-mcp` (MCP server). Internal layers are subpath
  exports: `pilotswarm/ui-core`, `pilotswarm/ui-react`, `pilotswarm/host`,
  `pilotswarm/web`.
- **`pilotswarm-sdk` is self-contained** — the isomorphic Web API wire client
  (operations table, `ApiClient`, `HttpApiTransport`) now ships inside it as
  the browser-safe subpath `pilotswarm-sdk/api` (typed). A CI guard bundles
  the subpath with esbuild `platform=browser` and fails on any external or
  `node:` import.
- **Retired npm names**: `pilotswarm-cli`, `pilotswarm-web`,
  `pilotswarm-api-client`, `pilotswarm-mcp-server`. The publish workflow now
  releases exactly `pilotswarm-sdk` → `pilotswarm-horizon-store` →
  `pilotswarm`. The MCP prepack bundling hack and workspace-UI sync hacks are
  gone.
- Dockerfiles (worker/portal/starter), k8s + GitOps manifests, and deploy
  scripts rewired for the 3-package workspace; starter image verified
  end-to-end (portal + embedded-worker LLM turn) on the new layout.

### Web API / MCP

- MCP server defaults to Web API mode everywhere user-facing; live test
  suites now run the real bin over `--api-url` against an in-process portal
  (no DB credentials in the MCP process). `list_models`/`switch_model` work
  in web mode; `send_command` returns a clear direct-mode-only error.
- Unknown-model validation errors now surface as `400` with the message
  preserved (previously a generic `500`).

### Portal / TUI

- Session list: the pin column renders only when a session is actually
  pinned — no more phantom indent on every user row.
- TUI renders colorless text (agent message bodies, markdown prose) in the
  theme's foreground instead of the terminal profile's default — light
  themes are readable in dark-profile terminals.
- Themes: removed Workbench Light, Solarized Dark, Paper Trail, Nord,
  Noctis Viola, Night Shift; added three sharp light themes (Daylight,
  Paper Ink, Light High Contrast) with AA contrast on every color slot.
  Persisted ids of removed themes fall back to the default.

### Docs

- Documentation overhauled into five sections (quickstart / user guide /
  architecture / API / developer), ~45 code-verified staleness fixes, new
  `docs/architecture/layering.md`, `docs/api/building-a-custom-ux.md`, and
  `docs/api/clients.md`. Builder-agent templates teach the Web API topology.

## 0.3.3 — 2026-07-01

### SDK / Runtime

- Added mid-flight turn Stop. `PilotSwarmManagementClient.stopSessionTurn(sessionId)`
  aborts the session's in-flight LLM turn without completing, cancelling, or
  deleting the session; the session returns to `idle` and accepts the next
  prompt normally. Outcomes: `stopped`, `stop_forced`, `no_active_turn`,
  `timeout`. Applies to system sessions too.
- New durable-session orchestration `v1.0.56` (`v1.0.55` frozen): `processPrompt`
  races the `runTurn` activity against a turn-scoped stop queue
  (`stopTurn.<turnIndex>`), so a stale stop event can never kill a later turn.
  When the stop wins, duroxide's dropped-future cancellation is the guaranteed
  backstop interrupt and a same-affinity `abortTurn` activity delivers the
  sub-second fast path (requires a stable `workerNodeId` and a free worker
  slot; the worker now warns at startup when `workerNodeId` is unset).
- `ManagedSession` gained active-turn tracking and a stop marker: a user stop
  classifies the unwind as the new `stopped` turn result (never `completed` or
  a retryable `error`), wins over a racing `wait()`/`ask_user` control-tool
  abort, and `forceSettleTurn()` force-unwinds turns whose SDK never fires
  `session.idle` (`stop_forced`, with warm-session invalidation).
- Stopped turns keep recurring sessions alive: cron / wall-clock schedules
  re-arm and interrupted waits resume exactly like a completed turn; the
  parent `CHILD_UPDATE` notification and latest-response write are skipped.
- CMS migration `0024`: `sessions.active_turn_index` is published by the
  pre-turn writeback and cleared on turn end and on any state transition away
  from `running`; `cms_get_session` returns it for stop-queue targeting.
- New durable events: `session.turn_stopped` (with an `interrupt` delivery
  annotation) plus a visible `Turn stopped by user.` system message;
  `session.turn_completed` carries `resultType: "stopped"` on the fast path.
- Worked around a duroxide-node select limitation (filed
  microsoft/duroxide-node#9): a raced activity failure resolves as its raw
  error string instead of throwing, so raced `runTurn` failures are detected
  and re-thrown into the existing retry machinery.

### Portal / TUI

- Stop button in the portal prompt bar: a red `■` appears next to Send while
  the active session is running a turn (pulses while stopping); Send is now an
  icon button (`❯`, `+` when queueing, `⇪` for batch sends).
- Six new UI themes: night-shift, paper-trail, solarized-ops, terminal-green,
  workbench-light, and high-contrast-mono.
- Refined portal session chrome: the chat header shows the session title and
  short id; model, reasoning effort, and context usage now live on the session
  list rows and the Stats tab.

### Tests / Docs

- New stop-turn suites: deterministic unit coverage (stop classification,
  lock-bypass contract, wrong-turn guard, hang escalation, management API) and
  a live integration suite (mid-flight stop with a blocking tool, idempotent
  no-op, stale-stop immunity).
- Orchestration test harnesses updated for the new turn race envelope; UI
  contract tests updated to the refreshed portal chrome.
- Stop-turn design doc moved to `docs/proposals-impl/`; portal user guide
  documents the Stop control.

## 0.3.2 — 2026-07-01

### SDK / Runtime

- Added model-facing current-runtime-model visibility to `list_available_models`.
  The tool now reports the session's configured provider, model, qualified model
  id, and reasoning effort for the current turn before listing the available
  model catalog.
- Hardened mid-session model switching. Model changes continue to flow through
  the durable `set_model` command path, write through to CMS, and rebind warm
  SDK sessions at the next turn boundary.
- Added sticky session title support through `update_session_summary(title=...)`,
  so agents and clients can intentionally rename sessions without later automatic
  summarization overwriting the title.
- Tightened Sweeper cleanup semantics: sessions are cleanup-eligible only when
  their own orchestration is terminal (`Completed`, `Failed`, `Terminated`, or
  `NotFound`). Idle, zombie, orphaned, or otherwise live child sessions are no
  longer swept.
- Added runtime protection for malformed assistant text that looks like a tool
  call. Literal `<invoke ...>` / `<parameter>` markup is now treated as a tool
  protocol error instead of being silently accepted as normal assistant content.

### Portal / TUI

- Updated the shared session UI and portal runtime around model-aware session
  state, sticky titles, and session metadata so the browser and terminal surfaces
  stay aligned with the SDK runtime behavior.
- Extended portal/browser transport contracts for session model and title state.

### Observability / Agent Tuning

- Expanded agent-tuner inspection guidance and management surfaces for
  investigating model switches, title updates, turn metrics, and model-specific
  token attribution.

### Tests / Docs

- Added focused coverage for summary/title updates, inline control-tool model
  metadata, terminal-only Sweeper cleanup, model-selection behavior, portal
  browser contracts, and restart/session metric paths.
- Updated system reference, portal user guide, model-switch proposal notes,
  agent-tuning log, TUI maintenance guidance, and contributor instructions.

## 0.3.1 — 2026-06-28

### SDK / Runtime

- Hardened the Sweeper Agent's `cleanup_session` tool so every requested target
  is independently re-verified before deletion. The tool now refuses system
  sessions, live root sessions, and any target that is not terminal, idle, or
  orphaned, preventing stale child clusters from being collapsed into unsafe
  parent/root cleanup.
- Added `cleanup_session({ sessionIds: [...] })` batch mode. The batch form saves
  Sweeper LLM tool-call turns by accepting many scan-returned session IDs at
  once, while still gating and cleaning each target independently and reporting
  refused IDs.
- Updated `scan_completed_sessions` guidance and Sweeper prompt/skill text to
  make `parentSessionId` context-only: stale children must be cleaned by their
  own `sessionId`, never by inferring the parent/root is stale.

### Tests / Docs

- Added `test/local/sweeper-cleanup-guard.test.js` with deterministic coverage
  for live-root refusal, terminal cleanup, child cleanup, batch mixed outcomes,
  and batch de-duplication.
- Updated the default-agent design doc to describe Sweeper cleanup guardrails and
  batch cleanup semantics.

## 0.3.0 — 2026-06-26

### Crawler Role + Bundled Default-Agent Tier

- Renamed the privileged crawl-queue role from "harvester" to **crawler**. Agents
  declare it with `crawler: true` frontmatter; legacy `harvester: true` is still
  accepted as an alias. The runtime derives the role authoritatively from the
  bound agent every turn (`resolveCrawlerRole` / `isCrawler`), with
  `resolveHarvesterRole` / `isHarvester` retained as deprecated aliases.
- Added an opt-in **bundled default-agent tier**: optional SDK-bundled named
  agents (shipped under `plugins/default-agents/`, e.g. `generic-crawler`) stay
  hidden unless an app opts in through `session-policy.json` with
  `creation.bundledAgents`. Added the `bundledAgents` field to
  `SessionPolicy.creation`; the worker and the CLI transport expand opted-in
  bundled agents into the creatable-agent picker and fail closed on an unknown or
  un-opted `defaultAgent`.
- Added prefix-scoped crawl controls for deliberate recrawl of a key prefix.

### Generic Crawler

- Formalized a 10-stage **consultative lifecycle** (scope the source & mining
  strategy → elicit the questions → understand the domain & propose → design the
  fact/graph schema → tune the schema to intent → pick per-stage models → present
  the plan → pilot → run the full crawl → keep the corpus fresh). (agent v1.2.0)
- The crawler now **advertises each knowledge base it builds**: it writes a
  `proposed_skill` intake under `intake/knowledge-base/<corpus>` that documents
  the graph-query recipe with concrete examples (`facts_search` →
  `graph_search_nodes` via `EVIDENCED_BY` → `graph_neighbourhood` → `read_facts`),
  and the Facts Manager promotes it into `skills/knowledge-base/<corpus>`.

### Facts Manager

- Recognizes knowledge-base advertisement intakes as a corpus's authoritative
  self-description and promotes them immediately (independent of the
  corroboration threshold), preserving the provided name/description/tools and the
  query examples verbatim. (agent v1.8.0)

### SDK / Runtime

- Live session orchestration advances to `1.0.54`, with `1.0.53` frozen for warm
  resume compatibility.
- `openNewSessionFlow` respects `creation.allowGeneric`: when generic sessions are
  disabled it falls back to the model picker / agent picker, threading session
  options through the model and reasoning-effort pickers.
- Fixed Horizon migration version assertions.

### Tests

- Added session-policy guard and behavior suites, a CLI session-creation-metadata
  test, a ui-core new-session-flow test, and a deterministic generic-crawler
  lifecycle prompt guard (now also pinning the knowledge-base advertisement
  section).

### Docs / Proposals

- Added the crawler-authority + default-agent-tier proposal and a proposal for a
  sticky, fixed-format crawler session-summary table.

## 0.2.2 — 2026-06-23

### HorizonDB Enhanced Facts + Graph

- Added the HorizonDB-backed enhanced facts and graph provider package under
  `packages/horizon-store`, including lexical/semantic/hybrid fact search,
  durable in-DB embedding support, Apache AGE graph storage, graph namespace
  registry support, crawl receipts, and graph evidence reconciliation.
- Added the Horizon Harvester worked example with harvester and reader agents,
  graph export tooling, cleanup scripts, and end-to-end wiring for stock
  PostgreSQL runtime storage plus HorizonDB facts/graph providers.
- Added canonical docs and proposal material for enhanced facts, graph search,
  retrieval usage metrics, soft-delete reconciliation, provider cleanup, and
  harvester deployment.

### SDK / Runtime

- Added cycle-aware child watcher notifications for cron and `cron_at` turns.
  Quiet child cycles are treated as heartbeats, while `report_cycle` lets
  material or blocked watcher cycles wake the parent without suspending the
  child turn. The live orchestration advances to `1.0.53`, with `1.0.52` frozen
  for warm resume compatibility.

### Builder Agents

- Added the `pilotswarm-hybrid-datastore` builder skill to explain the hybrid
  store topology: stock PostgreSQL remains the runtime `DATABASE_URL`, while
  HorizonDB is added through `HORIZON_DATABASE_URL` / `HORIZON_GRAPH_DATABASE_URL`
  for enhanced facts/search/graph.
- Updated the SDK builder, knowledge harvester, and Azure deployer templates so
  app builders can scaffold harvester agents and deploy hybrid store configs
  without changing the default stock-PostgreSQL Docker image.

### Packages / Release

- Added `pilotswarm-horizon-store` to the public npm release workflow alongside
  `pilotswarm-sdk`, `pilotswarm-cli`, and `pilotswarm-web`.
- The starter Docker image continues to default to stock PostgreSQL; hybrid
  HorizonDB mode is selected by environment/provider configuration.

### HorizonDB Test Stability

- Narrowed the HorizonDB facts migrator's global DDL advisory lock so only
  database-global migration statements take it, and use transaction-scoped
  acquisition for those sections. Ordinary per-schema facts migrations now keep
  their per-schema lock but no longer serialize every fresh test schema behind a
  suite-wide session-level global lock.
- Added bounded HorizonDB migration lock acquisition with holder diagnostics so
  stale advisory locks fail clearly instead of cascading into unrelated SDK test
  timeouts.
- Preserved HorizonDB test throughput by restoring concurrent provider-level
  test execution and raising the provider client pool default to 16.
- Extended `scripts/cleanup-test-schemas.js` to clean HorizonDB-side
  `ps_test_facts_*` schemas, cancelling test embedder loops before dropping
  those schemas.

### AKS Deployments

- `.env.remote` is a standalone deployment config, not layered with local
  `.env` or `.env.horizondb`. Any value required by the corp AKS worker or
  portal must be present there and propagated into `copilot-runtime-secrets`.
  For no-reset rollouts against the long-lived corp database, keep
  `PILOTSWARM_DUROXIDE_SCHEMA=duroxide` pinned until an explicit
  orchestration-schema migration/reset window; otherwise new workers default to
  `ps_duroxide` and will refuse to start while the legacy `duroxide` schema is
  still present.

## 0.2.0 — 2026-06-19

### Deploy — Azure VPN Gateway P2S Ingress (Entra ID auth)

Adds an optional Azure VPN Gateway Point-to-Site ingress to the node-based
deployment orchestrator. Coexists with the existing AFD edge mode as a
"trusted-bypass" path: off-network employees with valid Entra ID credentials
can reach the portal without being caught by AFD WAF service-tag allow-lists.

**Bicep / infra (Phase 1)**
- New `deploy/services/base-infra/bicep/vpn-gateway.bicep` — VPN Gateway with
  Microsoft Entra ID P2S auth, supporting both the current
  (`c632b3df-…`) and legacy (`41b23e61-…`) Azure VPN Client audience GUIDs.
- `frontDoorId` threading in `global-infra` so the AppGw WAF can distinguish
  AFD vs. VPN traffic at the custom-rules level.
- New `deploy/services/base-infra/bicep/dns-resolver.bicep` — Azure Private DNS
  Resolver inbound endpoint (`10.20.19.4`) on a dedicated subnet
  (`10.20.19.0/28`). The VNet carries the resolver IP via `dhcpOptions.dnsServers`
  so P2S clients inherit it automatically at connect time — zero-touch DNS for
  end users. Cost delta: **+$170/mo**; total VPN+resolver footprint **+$450/mo**.
- `private-dns-portal.bicep` now threads `PORTAL_RESOURCE_NAME` so the private
  DNS A record label matches the AppGw HTTPS listener / AKV cert subject
  (fixes a `NET::ERR_CERT_COMMON_NAME_INVALID` regression on AFD+VPN stamps).

**Orchestrator wiring (Phase 2)**
- `deploy.mjs` env threading for `VPN_GATEWAY_ENABLED`, `VPN_CLIENT_ADDRESS_POOL`,
  `PORTAL_HOSTNAME`, `PORTAL_RESOURCE_NAME`, and `VPN_GATEWAY_ID`.
- AppGw WAF custom-rules file wiring and `tenantId` resolution via env threading
  (no implicit `az account` dependency in the hot path).
- `resolveAppgwWafCustomRulesFile()` now runs on the deploy path; `deploy-bicep.mjs`
  parses and structurally validates `APPGW_WAF_CUSTOM_RULES_FILE` (fail-closed,
  named error) before invoking `az`.
- VPN combo-error hints in `overlay-contracts.mjs` point to the canonical
  `docs/deploying-to-aks.md`.

**Scaffolder UX (Phase 3)**
- `new-env.mjs` VPN UX prompts: `VPN_GATEWAY_ENABLED`, address-pool CIDR,
  `VPN_GATEWAY_AUDIENCE_GUID` (default or legacy), and CA policy guidance.
- Pool-overlap validation on both interactive and non-interactive paths.
- Latent `foundryEnabled` truthy-string bug fixed.

**Docs (Phase 4)**
- `docs/deploying-to-aks.md`: AFD+VPN row in topology matrix; new
  "Optional: VPN Gateway P2S" section covering architecture, preconditions,
  env vars, CA policy, client-profile distribution, the auto-seeded WAF guards
  (rules 90/91/92), and the `APPGW_WAF_CUSTOM_RULES_FILE` operator hook.
- `.github/skills/pilotswarm-new-env-deploy/SKILL.md` and
  `.github/skills/pilotswarm-aks-deploy/SKILL.md` updated with topology tables,
  VPN combo-error matrix, and 45+ min / ~$140/mo cost notes.

**Portal app registration — dual redirect URIs**
- `Setup-PortalAuth.ps1` accepts `-RedirectUri` as `[string[]]`.
- `Resolve-RedirectUriFromEnv` returns both the AFD endpoint AND
  `PORTAL_HOSTNAME` on AFD+VPN stamps, registered idempotently.
- `.github/skills/pilotswarm-portal-app-reg/SKILL.md` documents the dual-URI
  behavior.

**VPN client-profile helper**
- New `deploy/scripts/auth/Get-VpnClientProfile.ps1` — wraps
  `az network vnet-gateway vpn-client generate --authentication-method EAPTLS`,
  downloads the gateway-issued zip, and extracts `azurevpnconfig.xml` under
  `deploy/envs/local/<stamp>/vpn-client/` (gitignored).
- New `.github/skills/pilotswarm-vpn-client-profile/SKILL.md` with usage
  guidance, sensitivity notes, and end-user import instructions.
- `pilotswarm-npm-deployer` agent updated to offer the helper automatically
  after a successful VPN-enabled deploy.
- "Distributing the VPN client profile" sections in docs and the deploy skill
  now point at the helper (corrects stale `vpn-client generate-url` reference
  to `vpn-client generate --authentication-method EAPTLS`).

**VPN access management — proposal doc**
- `docs/proposals/vpn-access-management.md`: forward-looking proposal to fold
  VPN access management into the deployer-owned model (per-stamp custom audience
  app, `Setup-VpnAuth.ps1`, `Set-VpnAccess.ps1`, optional `-MirrorToVpn` flag).
  Proposal only — no code changes.

### Tests

**248 / 248** deploy-scripts tests pass (was 238 before Phase 2/3 guards; +2 new
regression guards for VPN combo-error pointer and AppGw WAF rules wiring). The
live SDK integration suite requires a PostgreSQL + Copilot token environment and
was last run prior to merging PR #53 at 238 / 238 pass. No SDK source changed
in this release.

## 0.1.35 — 2026-05-29

### SDK — Hotfix: declare `@opentelemetry/api` as a dependency

- `packages/sdk/src/session-proxy.ts` hard-imports
  `@opentelemetry/api` (added in v0.1.33 alongside the SigNoz
  observability work) but the package was not declared in
  `packages/sdk/package.json` dependencies. Any consumer that
  installed `pilotswarm-sdk@0.1.33` or `0.1.34` standalone
  (i.e. not inside this monorepo) would crash on first import
  with `ERR_MODULE_NOT_FOUND: Cannot find package
  '@opentelemetry/api'`. Adds `^1.9.0` as a direct dep so
  fresh installs are self-contained.
- No behavior change. No API change. SDK consumers that already
  worked around this by adding `@opentelemetry/api` to their own
  `package.json` can keep that pin or drop it — either resolves
  to the same version.

## 0.1.34 — 2026-05-29

### Portal — Deny-by-default authz

- **Breaking-ish: `PORTAL_AUTHZ_DEFAULT_ROLE` now defaults to `none`
  (deny).** Pre-v0.1.34, a signed-in principal that carried no `roles`
  claim AND matched no email allowlist was silently admitted as `user`.
  That left every `entra`-provider portal stamp without an explicit
  allowlist open to the entire tenant unless
  `appRoleAssignmentRequired=true` was flipped on the Enterprise
  Application. The engine is now secure-by-default: such principals
  are denied at the portal layer with the reason
  `"No email allowlists configured and PORTAL_AUTHZ_DEFAULT_ROLE is not
  set (deny by default)"`.
- **To restore the legacy open posture** (any tenant user gets `user`),
  set `PORTAL_AUTHZ_DEFAULT_ROLE=user` explicitly in the stamp's `.env`.
  Recommended only for sandbox stamps.
- **For production stamps**, the recommended lockdown is now
  `Setup-PortalAuth.ps1 -CreateAppRoles` plus role assignments in Entra
  (`Set-PortalAuthAssignments.ps1` or "Enterprise applications > Users
  and groups"). The role assignment list **is** the allowlist — no env
  var needed. The deny-by-default engine rejects any signed-in
  principal whose token has no admin/user role claim.
- `PORTAL_AUTHZ_ADMIN_GROUPS` / `PORTAL_AUTHZ_USER_GROUPS` remain the
  **legacy** mechanism for stamps not using app roles. The engine's
  role-authoritative branch (see `packages/portal/auth/authz/engine.js`)
  bypasses these allowlists entirely when the JWT carries any `roles[]`
  claim, so populating them alongside `-CreateAppRoles` is redundant —
  pick one mechanism per stamp.
- `-AssignmentRequired` is now an advanced opt-in — in tenants with
  restricted user-consent policies it triggers an AADSTS90094
  admin-consent prompt on the first sign-in of every assigned
  principal. See
  [`docs/portal-entra-app-roles.md`](docs/portal-entra-app-roles.md)
  Step 2b for the caveat and workaround.
- Updated skills, deployer agent, and operator docs to reflect the new
  default posture. `Setup-PortalAuth.ps1` already defaulted
  `-AssignmentRequired` to `$false`; doc copy is now consistent.

## 0.1.33 — 2026-05-26

### SDK / Runtime

- Updated `pilotswarm-sdk` to consume the published `duroxide` `0.1.27`
  package, keeping PilotSwarm aligned with the latest released Duroxide native
  package set and PostgreSQL provider compatibility work.
- Added bounded management reads for session listing, paged session-event
  history, and top event-emitter diagnostics. The public management client now
  exposes `listSessionsPage()`, `getSessionEventsBefore()`, and
  `getTopEventEmitters()` for UI and operator paths that should not rely on
  unbounded reads.
- Added hydration and dehydration lifecycle tracing around session proxy
  activities so lossy handoff and blob-state behavior can be correlated with
  worker/runtime traces.

### Observability

- Added the Node OpenTelemetry bootstrap used by the worker entry point,
  including OTLP trace and metric exporters, Node auto-instrumentation,
  resource detection, a startup span, debug logging, and graceful SDK shutdown.
- Documented the current SigNoZ architecture, implemented spans, required
  metric dimensions, and remaining deployment/dashboard work in the new
  SigNoZ observability guide. The stuck-activities queue metric remains
  deferred to Duroxide so PilotSwarm does not ship a duplicate runtime signal.

### Portal / TUI / Shared UI

- Wired the node SDK transport, portal runtime RPC bridge, browser transport,
  and shared UI controller to use the bounded session/event read surfaces for
  refresh and polling flows.
- Tightened portal RPC validation for bounded-read parameters, including page
  cursors, event sequence bounds, and time-windowed event-emitter diagnostics.

### Docs / Configuration

- Added the SigNoZ observability guide to the documentation index and refreshed
  the sample model-provider catalog used by new local configurations.

### Packages / Docker

- Bumped published workspace packages to `0.1.33` and advanced internal
  workspace dependency ranges together (`pilotswarm-cli` → `pilotswarm-sdk`,
  `pilotswarm-web` → `pilotswarm-cli`).
- Refreshed the Docker quickstart's pinned starter-image references to
  `0.1.33`. The starter Docker image is intended to be rebuilt and republished
  alongside this release as `v0.1.33`, `0.1.33`, and `latest`.

### Tests

- Added coverage for bounded CMS session pages, top event-emitter diagnostics,
  portal/browser bounded-read contracts, and shared UI session refresh behavior.
- Updated hydration lifecycle tests, Context7 MCP streamable HTTP session-id
  coverage, and shared UI session-group tests for the current no-chrome
  markdown group-details and summary rendering contract.

## 0.1.32 — 2026-05-22

### Packages / Docker

- Bumped published workspace packages to `0.1.32` and refreshed the Docker
  quickstart's pinned starter-image references to `0.1.32`. The starter
  Docker image is rebuilt and republished alongside this release.

### Portal

- **App-role claims are now authoritative when present.** The portal
  authorization engine now decides admission from the JWT `roles` claim when
  it is non-empty, using case-insensitive equality against the canonical
  values `admin` and `user`. Admin-before-user precedence is preserved.
  The email-allowlist path (`PORTAL_AUTHZ_ADMIN_GROUPS` /
  `PORTAL_AUTHZ_USER_GROUPS`) is unchanged for principals whose token
  carries no `roles` claim. Tokens that carry only non-matching role
  values are denied — they do not fall through to the allowlist.
- **Role values are fixed.** The roles-mode design assumes exactly two
  canonical roles per app registration with `value: "admin"` and
  `value: "user"`. There is no override env var. If you need additional
  gate-keeping, define a new app role and check the JWT `roles` claim
  for it explicitly in code — do not alias it onto the built-in
  admin/user buckets. `Setup-PortalAuth.ps1 -CreateAppRoles` creates
  exactly these two roles.
- **Operator runbook**: see [`docs/portal-entra-app-roles.md`](docs/portal-entra-app-roles.md)
  for the recommended end-state setup (define roles → enable
  `appRoleAssignmentRequired=true` → assign → align Conditional Access).
- **Portal app registration no longer declares any API permissions.** The
  SPA requests only OIDC standard scopes (`openid`, `profile`) at sign-in,
  which require no user or admin consent. Dead-weight `User.Read` and
  `GroupMember.Read.All` (the portal never called Graph at runtime) have
  been removed. This makes `appRoleAssignmentRequired=true` work cleanly
  without any tenant-admin consent step. Future downstream API access
  (e.g. ADO via OBO) belongs on per-purpose worker apps with their own
  consent posture — see
  [`docs/proposals/portal-auth-provider-and-authz.md`](docs/proposals/portal-auth-provider-and-authz.md).
- **Migration note**: deployments running with both an email allowlist **and**
  Entra-issued tokens that carry app-role claims will see role-driven
  decisions take precedence over the allowlist on upgrade. Tokens without
  a `roles` claim are unaffected; tokens whose `roles` claim contains
  values other than `admin` / `user` will now be denied. To preserve the
  legacy behavior, remove the app-role assignments (or definitions) so the
  `roles` claim is absent again, or migrate the allowlist entries into
  `admin` / `user` role assignments. See
  [`docs/portal-entra-app-roles.md`](docs/portal-entra-app-roles.md).

## 0.1.31 — 2026-05-20

### Docker

- Fixed the starter Docker image runtime by moving it to the same Debian trixie
  base used by the portal/worker images so the current duroxide native module
  can load against glibc 2.41. The starter now uses trixie's default embedded
  PostgreSQL 17; existing `pilotswarm-data` volumes initialized by PostgreSQL 15
  must be recreated or migrated before reuse.

### CI / Release

- Switched npm publishing to GitHub Actions Trusted Publisher/OIDC so future
  releases publish without an `NPM_TOKEN` repository secret.

### Packages / Docker

- Bumped published workspace packages to `0.1.31` and refreshed the Docker
  quickstart's pinned starter-image references to `0.1.31`.

## 0.1.30 — 2026-05-20

### SDK / Runtime

- **Base infrastructure state** — added durable CMS support and management APIs
  for session summary state, profile settings, session groups, pinned sessions,
  collapsed-session ids, owner-aware grouping, and management views. The CMS
  migration set now includes reviewable diffs through `0020_diff.md`, and the
  client/runtime surfaces round-trip the new state through public management
  APIs instead of portal-local caches.
- **Wall-clock scheduling** — added `cron_at` support for IANA-timezone wall
  clock schedules alongside interval cron, including stored-procedure state,
  orchestration dispatch, worker/tool wiring, and tests for scheduled wake-ups.
- **Cross-session coordination** — added durable `send_session_message` /
  `reply_session_message` flows, session-message events, transcript rendering,
  and child-notification policy handling so parent/child and peer sessions can
  exchange request/reply cards without relying on ad-hoc transcript text.
- **Prompt and agent layering** — added prompt-layer loading/version metadata,
  agent-versioning guidance, builder-template version expectations, and prompt
  hardening for durable timers, child contracts, facts, and summary table
  parity.
- **Copilot SDK refresh** — bumped the runtime to `@github/copilot` `^1.0.50`
  and `@github/copilot-sdk` `^1.0.0-beta.4`; the tool-name collision regression
  continues to pass with the updated built-in tool surface.

### Portal / TUI / Shared UI

- **Session groups, restore, and pinning polish** — the shared UI now restores
  active nested/grouped sessions across refreshes, auto-expands ancestors of the
  restored active session, prunes non-pinnable pins, ignores stale pins in row
  ordering, and keeps portal/native behavior aligned for top-level-only pins and
  move-to-group workflows.
- **Mobile portal fixes** — the top toolbar stays to two rows with live status on
  the right side of row two, focus-mode session lists are horizontally pannable
  for long titles, and summary/group views remain read-only without prompt
  chrome.
- **Summary/table rendering** — session summaries and group details render
  markdown tables as web-native tables, including summary text that arrives with
  escaped newline sequences, while preserving wrapped chat/table behavior in
  narrow panes.
- **Portal runtime preferences** — profile settings now round-trip through the
  portal runtime and transport so theme, filters, pins, collapsed rows, active
  session, pane splits, and chat/summary mode persist across browser/mobile
  clients.

### Docs / Templates

- Updated canonical docs for session creation policy, system reference,
  keybindings, portal/TUI user guides, SDK agent building, facts, and agent
  contracts.
- Added proposal and bug-report docs for agent-layer versioning, wall-clock
  cron, child-contract notification policy, blank assistant replay handling,
  no-op child updates, and wait-boundary leakage.
- Updated builder-agent templates and skills so generated agent prompts include
  explicit versioning expectations and current PilotSwarm coordination behavior.

### Packages / Docker

- Published `pilotswarm-sdk`, `pilotswarm-cli`, and `pilotswarm-web` to npm at
  `0.1.30`, with workspace dependency ranges and lockfile entries updated
  together.
- Published the starter Docker image as `affandar/pilotswarm-starter:v0.1.30`,
  `affandar/pilotswarm-starter:0.1.30`, and `affandar/pilotswarm-starter:latest`;
  the Docker quickstart now points its pinned pull command at `0.1.30`.

### Tests

- Added and updated local coverage for base infrastructure state, cron-at
  scheduling, cross-session messaging, child notifications, prompt layers,
  system session restart, inline control tools, portal browser contracts,
  confirmation modals, session refresh behavior, history-pane UI, grouped
  sessions, and Copilot SDK tool-name collisions.
- Full-suite testing was run outside this release-agent turn by the user; this
  release pass ran build, npm package dry-runs, npm registry verification, and
  Docker image tag verification.

## 0.1.29 — 2026-05-12

### SDK / Runtime

- Bumped `duroxide` dependency from `^0.1.25` to `^0.1.26`. Duroxide 0.1.26
  picks up `duroxide-pg` 0.1.33 / `duroxide-pg-opt` 0.1.29, which switch
  `reqwest` to `default-features = false` + `native-tls`. Without this, the
  AAD token-acquisition HTTPS call inside the orchestration store failed with
  a TLS handshake error in containers using musl/OpenSSL, making the
  `useManagedIdentity: true` path below unusable in practice.
- **Passwordless duroxide orchestration store** — when configured with
  `useManagedIdentity: true`, the worker, client, and management client now all
  route the duroxide Postgres store through `PostgresProvider.connectWithSchemaAndEntra`
  (added in duroxide-node 0.1.25) instead of `connectWithSchema`.CMS, facts,
  **and** the orchestration store now authenticate via Microsoft Entra ID — no
  password URL gap. The legacy password-in-URL path (`useManagedIdentity` unset
  or `false`) is unchanged, so the existing `deploy-aks.sh` flow continues to
  work without changes. URL parsing and AAD user resolution are shared with the
  CMS/facts pg-pool factory via the new `parsePostgresUrl` /
  `resolveAadPostgresUser` helpers. This closes the last gap blocking
  pure-Entra cutover on AKS — the password store argument,
  `passwordAuth: 'Enabled'` Bicep flag, and `postgres-admin-password` Key
  Vault secret can now be dropped by downstream deployers.

### Docs

- Updated `README.md`, `deploy/scripts/README.md`, `deploy/envs/template.env`,
  the worker + portal overlay `.env` files, the `postgres.bicep` auth comment,
  and the `compose-env.mjs` rationale to reflect that the duroxide store now
  honours the MI switch (no more "no token-callback hook upstream" caveat).

### Tests

- Added unit coverage for the new `duroxide-provider-factory` (legacy vs MI
  routing, URL parsing defaults, missing-user error path) and refactored
  `pg-pool-factory` to share parsing with it (existing tests unchanged).

## 0.1.28 — 2026-05-09

### SDK / Runtime

- **Duroxide 0.1.25** — bumps the SDK dependency to the release that adds
  `PostgresProvider.connectWithEntra` and `PostgresProvider.connectWithSchemaAndEntra`
  for passwordless Azure AD / Entra ID authentication, along with the duroxide
  core 0.1.29 / duroxide-pg 0.1.32 / duroxide-pg-opt 0.1.28 provider stack.

## 0.1.27 — 2026-05-06

### Deploy / Ops

- **AKS GitOps deployment kit** — adds environment templates, Flux/Kustomize
  bases and overlays, Azure Bicep service definitions, and an OSS Node.js
  deploy orchestrator under `deploy/scripts/` for provisioning infrastructure,
  publishing manifests, seeding secrets, and rolling out worker/portal services.
- **Deployment-ready runtime wiring** — adds shared PostgreSQL pool creation,
  blob/session-store connection option handling, and worker/client plumbing used
  by managed AKS deployments.

### TUI / Shared UI

- **Markdown table sentinel handling** — chat line grouping now keeps markdown
  table sentinel blocks out of visible transcript text while preserving the
  rendered table structure, preventing stray marker lines from leaking into TUI
  and portal chat output.

### Tests

- Added deploy-script, Bicep/rendering helper, PostgreSQL pool factory, and blob
  store coverage for the new AKS deployment path.
- Added a focused regression test for markdown table sentinel blocks in chat
  line rendering.

## 0.1.26 — 2026-05-03

### TUI / Shared UI

- **Cleaner markdown table rendering** — native TUI markdown tables now size
  columns from rendered display text instead of raw markdown links, render link
  cells as readable labels, and keep only the header divider rather than drawing
  a full divider between every body row.

### Docker / Docs

- **Starter SSH first-run guidance aligned** — the Docker quickstart now uses
  `StrictHostKeyChecking=accept-new` consistently for the optional SSH TUI path,
  matching the first-run flow for recreated starter containers and fresh
  `known_hosts` state.

## 0.1.25 — 2026-05-03

### SDK / Runtime

- **Duroxide 0.1.24** — bumps the SDK dependency to the release that publishes
  `duroxide-linux-arm64-gnu`, allowing PilotSwarm to load its durable runtime
  natively in Linux ARM64 Node.js containers.

### Docker

- **Multi-arch starter image restored** — the starter image publish workflow now
  builds `linux/amd64,linux/arm64` by default on release, so Apple Silicon users
  can run the starter appliance without forcing Docker Desktop amd64 emulation.

### Docs

- **Docker quickstart refreshed** — removes the temporary `--platform
  linux/amd64` workaround and points versioned pulls at `0.1.25`.

## 0.1.24 — 2026-05-03

### SDK / Runtime

- **Orchestration v1.0.52 — directory refactor** — the durable session orchestration moves from a single 2148-line file to an eight-module layout under `packages/sdk/src/orchestration/`: `index.ts` (entrypoint), `runtime.ts` (createRuntime + runLoop), `state.ts` (DurableSessionRuntime + DurableSessionState + constants), `lifecycle.ts` (status, persistence, commands, dehydrate, child digest, continueAsNew), `queue.ts` (KV FIFO + drain + decide), `turn.ts` (processPrompt + handleTurnResult + processTimer), `agents.ts` (sub-agent tracking + tool actions + shutdown cascade), `utils.ts` (pure helpers). Helpers take a single `runtime` object and mutate `runtime.state.*` directly. Adapter interfaces and the closure-and-getters bridges are gone. Yield order unchanged. Frozen prior versions (`1.0.47` … `1.0.51`) remain as sibling files registered in the orchestration registry.
- **Comprehensive orchestration design doc** — new [`docs/orchestration-design.md`](docs/orchestration-design.md) is the canonical reference for module layout, runtime/state model, drain/decide pseudocode, TurnResult dispatch, sub-agents, shutdown cascade, continueAsNew, hydration, replay invariants, and determinism rules. The shorter [`docs/orchestration-loop.md`](docs/orchestration-loop.md) is a stub that links into it; `architecture.md` §7.1 / §9.1 were rewritten to match the folder layout.
- **CMS retry hardening** — new `cms-retry.ts` provides `cmsRetryCritical` (1s/5s/15s/90s, throws on exhaustion) and `cmsRetryBestEffort` (1 retry @ 3s, swallows on exhaustion). Both retry only on transient PG signals — connection-family SQLSTATEs, serialization/deadlock, query-canceled — and trust the structured error code as the verdict when present so non-transient errors propagate immediately. 26 catalog call sites across 8 activities (`updateCmsState`, `cancelSession`, `getDescendantSessionIds`, `spawnChildSession`, `hydrateSession`, `checkpointSession`, `recordSessionEvent`, `runTurn`) are now wrapped, with the four critical state-mutating sites in `cmsRetryCritical` and the rest preserving their existing fire-and-forget contract under `cmsRetryBestEffort`.
- **Context7 MCP default** — the bundled CLI plugin now points at the official `https://mcp.context7.com/mcp` endpoint, AKS workers load `/app/packages/cli/plugins` by default, and the worker Docker entrypoint auto-detects the bundled plugin directory when `PLUGIN_DIRS` is unset.

### Portal / TUI / Shared UI

- **Reasoning-effort picker visible in the native TUI** — the shared terminal React app now renders the reasoning-effort picker overlay after model selection, matching the portal path and keeping `model:effort` session creation usable from `./run.sh remote`.

### Repository

- **Open-source readiness pass** — added `SECURITY.md` and `CONTRIBUTING.md`; removed the deployment-specific AKS topology doc, internal squad/Ralph automation workflows and proposals, and the committed perf-report history; rewrote committed docs to use relative paths.

### SDK / Runtime

- **Orchestration v1.0.50** — freezes `1.0.49` and makes the latest orchestration idempotent around repeated dehydrate paths, skips stale child-update digests for untracked sub-agents, and preserves the v1.0.49 sub-agent lifecycle where non-system children settle into the normal idle/dehydrate flow instead of auto-terminating after the first final response.
- **Spawn-tree fact visibility** — session-scoped facts are now visible across the whole spawn tree, including ancestors, descendants, siblings, and cousins under the same root. Fact tool descriptions, docs, and worker lookup logic now describe that broader tree visibility instead of only parent/child lineage.
- **Per-session runtime locking** — session creation/resume, run turns, hydration/dehydration, checkpoints, resets, and warm-session invalidation now share a worker-local per-session mutex so duplicate activity attempts cannot exercise the same Copilot `session.db` concurrently. Contended run turns back off at 5s, 10s, then 20s until the 2-minute acquisition timeout reports `can't acquire session lock for session <id>`.
- **Default agent prompt tuning** — the built-in default agent prompt now emphasizes facts as durable planning/state memory for long-running work.

### Portal / TUI / Shared UI

- **Session pinning and multi-select actions** — sessions can be pinned, persisted in local TUI config, selected in bulk, and cancelled/completed/deleted as a group while system sessions remain protected. Keybinding docs, TUI skill notes, and contributor instructions were updated with the new `P`, `V`, `Space`, and `Esc` session-pane behavior.
- **GitHub Light theme and theme-token cleanup** — the shared theme registry now includes GitHub Light, user chat tinting uses semantic theme tokens, and contrast tests cover the new light palette.
- **Portal table responsiveness** — compact fit-width markdown/chat tables get explicit minimum-width handling and mobile flex-column rendering so dense key/value tables fit narrower panes without horizontal spill.
- **Chat notice cleanup** — sub-agent completion notices now collapse to a single expandable system notice instead of pasting the full child response into the main transcript, and answered pending questions no longer reappear after stale session refreshes.

### Tests

- Added coverage for spawn-tree fact visibility, session-lock contention/timeout behavior, child-update batching, light-theme contrast/registry behavior, session pinning and multi-select state, collapsed sub-agent notices, and stale answered-question refresh suppression.

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
