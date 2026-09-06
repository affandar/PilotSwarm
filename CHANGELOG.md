# Changelog

## Unreleased

- Give MoA one bottom composer bound to the focused session; retain per-panel
  drafts and activity. Add session creation, shared session actions and details,
  and Ctrl+Arrow spatial navigation alongside Tab cycling.

- Shrink the mobile composer after send acknowledgement changes its wrapped
  placeholder. Keep long drafts bounded and internally scrollable.
- Select and open newly created sessions despite stale catalogs or filters.
  Preserve drafts and prevent an older load from taking over the subscription.
- Keep warnings in chronological chat history after recovery. New messages
  appear below them without a reload; retry updates preserve the card's DOM.

- Distinguish saved intermediate `Agent update` disclosures from live `Message
  preview` output. Streaming-disabled sessions and old history never show live
  preview labels or status; final answers retain normal chat formatting.
- Keep plain completed replies beside their timestamp and `Agent:` prefix,
  without an unnecessary line break. Preserve separate headers for code,
  tables and reasoning, and retain existing DOM through preview promotion.
- Present message previews as compact canvas-style disclosure rows instead of
  bordered cards. Expanded content still fits short replies and scrolls within
  a bounded viewport; keyboard toggling and reading position are preserved.

## 0.5.59 — 2026-09-05

Cluster-scoped administration, Azure/OpenAI request compatibility, updated
Copilot SDK/CLI, and stable chat previews and warning cards.

- Add operator-controlled `AUTHZ_ADMIN_SCOPE=cluster`: administrators retain
  health/configuration controls and every user's token accounting, but ordinary
  session/package ownership and shares apply to their direct content access.
  System-session admin access and genuine system-agent authority remain unchanged
  (the system-mediated bypass is explicitly deferred to phase 2).
- Redact private accounting labels and worker inventories, revalidate open
  session streams, clear revoked views, and recheck staged package publications.
  Additive CMS migration 0075 preserves sessions, grants and usage ledgers.
- Pin Copilot SDK 1.0.13 and CLI 1.0.83, using the SDK's bundled platform runtime
  through explicitly isolated stdio clients. Strip the leaked top-level `snippy`
  field only on OpenAI/Azure BYOK chat-completions requests; native GitHub
  Copilot and Anthropic/WIF transports remain unchanged. Apply the same boundary
  to durable sessions, titles and distillation, with provider-switch isolation.
- Add real SDK/CLI protocol tests for all BYOK provider types, streaming and
  non-streaming tool calls, usage, warm turns, cold resume and rotating WIF
  credentials, plus a separate credentialed live-provider validation runner.
- Render attributed question confirmations as one Question card plus the human
  answer, replacing the optimistic exchange without duplicating it under “You”.
- Keep API/retry warning cards stable across catalog/detail refreshes and retry
  count changes, clearing them on recovery or terminal status.
- Mobile session lists stop scrolling when the finger lifts; remove inertial
  fling while preserving axis-locked panning and tap selection.
- Ignore Copilot progress-only notifications when accumulating live text, so
  answers grow smoothly instead of resetting to individual fragments. Empty
  chunks no longer clear retained answers or reasoning or bypass pacing.
- Streaming and saved interim output use collapsed canvas-style preview cards.
  Expanded cards fit short content and scroll within a shaded maximum-height
  box for longer content; reading above the bottom
  pauses follow mode. Hidden markdown is parsed only on demand. The final answer
  becomes normal timestamp/`Agent:` prose at the successful turn boundary,
  preserving its response and reasoning DOM. History reloads follow the same rule.
- Preserve links inside bold/italic text and headings so artifact links render
  as the existing artifact viewer cards instead of raw Markdown.
- Add `gpt-6-astra` to the GitHub Copilot catalogs for local and AKS setups.
  Reasoning: low, medium (default), high, xhigh, max. Context: 272K default or
  872K extended prompt tokens inside a 1M total window. Existing GHCP provider
  instances inherit the model; defaults and credentials are unchanged, and
  Copilot entitlement/model policy still apply.

### Validation

- Full `./scripts/run-tests.sh --all-providers` passed before release preparation:
  1,597 baseline SDK tests, 1,610 HorizonDB-backed SDK tests, and 149 HorizonDB
  storage tests. Existing skips: 14 baseline and one HorizonDB SDK case.
- All 113 browser tests passed. Authorization regression suites include private
  session/package denial, staged publish revocation, exact all-user accounting,
  and stale HTTP/WebSocket response invalidation.
- An initial shared-test embedder timeout was resolved after operator-approved
  cancellation of stale test loops. Data and assertions were preserved; the
  unchanged complete combined run then passed. See the validation report.
- The operator approved reusing that full pass for this release. Build and
  package checks run again; test suites are not rerun for version metadata.

## 0.5.58 — 2026-09-04

Opt-in live chat previews, smooth reasoning-to-answer transitions, enforced
named-agent startup tools, and chromeless shared canvases.

### Added

- **Ephemeral live chat.** Set `PILOTSWARM_LIVE_TURN=1` on workers to stream
  coalesced reasoning and answer snapshots over a generic CMS live plane.
  PostgreSQL migrations 0073/0074 keep this state separate from durable
  history; both orchestration/facts provider configurations are supported.
- **Stable streaming presentation.** Delayed reveal, bounded visible dwell,
  persistent expandable reasoning, and a decoration-only completion fade.
  Fast responses skip transient chrome. Completed answers win over late
  previews; idle cleanup is scoped to its own stream.
- **Generic live-topic API.** Authorized `getLive` reads and WebSocket
  subscriptions with retained bursts, gap recovery, bounded queues,
  monotonic snapshots, and reconnect refresh.

- **Enforced named-agent startup tools.** Schema-v3 agent definitions may set
  `initialRequiredTool` to one of their declared tools. PilotSwarm verifies a
  real execution event on the initial turn, fails immediately when the handler
  is unavailable, issues one bounded same-turn correction when the model
  answers from memory, withholds that unsupported answer and its live stream
  from consumers and the durable transcript, and then fails closed without
  entering the generic retry loop.
  The turn-level contract survives provider-budget pauses and applies to
  direct starts, worker-managed system agents, Agent Manager verification
  sessions, and both inline and durable child-spawn paths. Orchestration
  `1.0.71` is frozen and new sessions use `1.0.72`.
### Fixed

- Cached rendering for unchanged transcript items; token bursts can no longer
  bypass update pacing. Oversized previews pause with an explicit label while
  durable final answers remain complete.
- Canvas share links can hide page chrome; restored canvas views and modal
  layering no longer leave the pane divider painted through dialogs.
- Shared sessions identify the owner clearly. Model-selection and
  orchestration-registry fixtures follow the current supported versions.

### Maintainer workflow

- CLI installation scripts consume all three GitHub release tarballs.
- Added adversarial coverage for streaming identity, final/idle races,
  subscriber replacement, slow consumers, reconnect recovery, and actual
  browser DOM continuity through settlement.
- The group-deletion concurrency test observes its expected rejection
  immediately, avoiding a spurious unhandled-rejection failure without
  weakening the foreign-key assertions.

## 0.5.57 — 2026-09-02

Tools get a private, durable place for state; the portal stops re-rendering
the whole app on every keystroke; a session's workspace layout follows it.

### Added

- **`invocation.facts` for worker-registered tools.** A tool registered with
  `worker.registerTools()` now receives a facts accessor on its invocation
  context, next to `durableSessionId`: `read`, `store`, `delete`, each bound
  to one of three scopes — `session` (default), `root` (the spawn tree's root
  session), or `shared` (cluster-wide). Reads are exact, by scope key, never
  a LIKE pattern. Runtime context only; never in a tool schema, never sent to
  the model. Design: `docs/proposals/tool-context-facts-accessor.md`.
- **The `tools/` fact namespace belongs to tools.** `store_fact`,
  `bulk_store_facts`, `read_facts`, `delete_fact`, `facts_search`,
  `facts_similar` and the crawl queue (`facts_read_uncrawled`) refuse it for
  EVERY agent identity, the Facts Manager included, and strip such rows from
  every result. A host reserves more prefixes with the new worker option
  `reservedFactPrefixes`. Backslash-escaped LIKE patterns (`tools\/%`) are
  unescaped before the check, which also closes that hole for the older
  reserved prefixes.
- **Per-session desktop views.** The portal remembers, per session and per
  device slot, which optional columns are open (canvas, diagnostics, zen) and
  how the right side is sized, and restores that when you return to the
  session. A session with no stored view opens as sessions plus chat.
  Stored in the profile as `sessionViews`, newest record wins across
  devices, capped at 300 sessions. Phones keep their current layout.
- **Agents budget table: select all / clear all** in the header checkbox.

### Fixed

- **The portal re-rendered the whole app on every keystroke, poll and live
  event.** `selectCanvasView` built a fresh array per call, so its
  shallow-equality check failed on every dispatch for the app root and the
  toolbar. It is memoised now (including the agent's canvas flip tick). With
  the chat pane's outbox array made stable, a keystroke re-renders the
  composer alone. Measured on a phone viewport with a 600-turn transcript:
  script per keystroke 1.9 → 0.8 ms, forced layouts 3.3 → 1.35.
- **Composer auto-grow forced two full-page layouts per character.** It only
  zeroes-and-measures when the text may have shrunk or the box resized.
- **A linked session by another user now appears in the session list.** A
  deep link to a session whose owner is outside your owner filter adds that
  owner to the filter, durably, with a notice naming them. A late profile
  read cannot drop the owner again. The transient exception remains only for
  unowned or system sessions.
- **The Warning and Question cards flickered on every poll.** The session
  detail read rewrote the catalog row to "running" while the runtime itself
  still reported "error", so the list and the detail disagreed on every
  cycle. The row is left alone when the runtime reports the error
  (`resolveStaleRunningRowRecovery`). The cards also stamped the session's
  rolling `updatedAt` as their time; they use the event that raised them.
- **Header status text ran under the toolbar buttons** at narrow widths.
- **ArrowDown on the diagnostics seam also moved the session selection.**
  The global shortcut handler now ignores keys a focused control handled.

### Tests

- Unit: facts accessor (exact reads, three scopes, delete), the `tools/`
  reservation across every fact tool for every identity, the LIKE-escape
  bypass, per-call prefix sets, the crawl queue; per-session views; canvas
  view identity; card timestamps; deep-link owner admit.
- E2E: agents budget clear-all (the stub now serves the agent pivot),
  toolbar status ellipsis. The budget toolbar test expects three tabs, as
  shipped since 0.5.53.

## 0.5.56 — 2026-08-31

A resume override becomes field-level, completing 0.5.55.

### Fixed

- **A partial `resumeSession(config)` before a session's first message no
  longer erases its creation config.** 0.5.55 made the creation config
  durable, but kept the old precedence: any in-memory map entry replaced
  the stored config wholesale. A partial resume — the realistic case being
  `{ tools }` to re-attach handlers — therefore clobbered the agent
  binding, system message and tool names with absence. The start config is
  now a field-level merge, durable under explicit: fields the caller
  actually set override; everything else inherits from the catalog row.
  An unset `waitThreshold` inherits the creation-time value rather than
  this process's default; the default applies only when neither side set
  it.

### Tests

- A fourth cross-replica integration test: create the agent session on
  client A, resume on client B with `toolNames` alone, first message via B
  — the override is honored, the binding is inherited from the row, and
  the safety net is asserted idle. Verified red with replace semantics
  restored. A sixth projection unit test pins that the no-fallback
  projection leaves `waitThreshold` unset so the merge can inherit it.

## 0.5.55 — 2026-08-31

The creation config becomes durable — the proper fix behind 0.5.54's
safety net.

### Fixed

- **A session's creation config now survives the process that created it.**
  0.5.54 diagnosed the bug: the config lived only in an in-memory map on the
  API-server process that handled the create, and the orchestration is
  started by whichever process handles the first message — behind a load
  balancer, routinely a different one, so the durable input started empty.
  0.5.54's worker-side backfill restored the agent binding from the catalog
  row; it could not restore a custom system message, tool names, or a child
  contract, and it had to re-fire (and re-announce) every turn because the
  input itself was beyond repair.

  Now the create persists the full serializable config to the session
  catalog row (migration 0072, nullable `creation_config` JSONB on
  `sessions` — additive, no proc change, no backfill), and the orchestration
  start restores it whenever the in-memory map misses. One projection
  function (`projectSerializableSessionConfig`) produces both the persisted
  shape and the start shape, so this seam cannot silently drop fields again
  — it had eaten `reasoningEffort` once before. The stored config is read
  through a dedicated narrow query, deliberately NOT joined into the shared
  `getSession` row: the web `getSession` op hands that row to any viewer
  with read access, and a stored system message is the owner's business.
  The extra query runs only when the map misses — never on the per-turn
  path.

- **The 0.5.54 backfill stays as the safety net** for sessions whose
  durable input predates the fix, and its `session.bound_agent_restored`
  event is now announced once per session per worker process instead of on
  every turn.

### Tests

- 5 unit tests for the projection (field pass-through, tool-name merge,
  round-trip identity between the persisted and start shapes). The
  integration file grows to three cross-replica tests: an agent session
  created on client A and first-messaged on client B keeps its agent
  durably — and asserts the safety net stayed idle, so a silent fall-through
  to the backfill fails the test; a custom systemMessage and toolNames —
  the fields the safety net cannot save — survive the same split; and a
  legacy row (creation_config nulled) heals through the backfill with the
  restored-event recorded exactly once across two turns. Each layer
  verified red with its mechanism disabled: no-persist fails the first two,
  no-restore fails the first, no-backfill fails the third.

## 0.5.54 — 2026-08-31

An API-created agent session now always gets its agent's instructions.

### Fixed

- **A session created through the Web API ran without its agent prompt and
  without its agent's MCP servers.** A top-level session's creation config
  lives in an in-memory map on the API server process that created it, and
  the orchestration is started lazily by whichever process handles the FIRST
  message. With more than one portal replica behind a load balancer, that is
  routinely a different process: the lookup missed and the orchestration was
  started with an empty config — `{"waitThreshold":30}` verbatim in the
  durable input, measured on a live fleet. The session still LOOKED bound
  (the CMS row's agentId drives the title, listings, and the agentIdentity
  fallback), which is why it went unnoticed: the only things keyed off the
  lost `boundAgentName` were the agent prompt layer and per-agent MCP
  grants — precisely the parts with no other fallback. The portal UI never
  hit it (it sends the initial prompt inside the create call, on the create
  process), and sub-agents never hit it (the worker stamps their binding
  itself), so every human-driven path looked healthy while every scripted
  path was silently agentless.

  The fix mirrors the existing catalog-authoritative model adoption: on
  every turn, when the orchestration input carries no `boundAgentName` and
  the session's catalog row names an agent that resolves to a loaded USER
  agent, the worker restores the binding from the row
  (`resolveBoundAgentBackfill` in `session-proxy.ts`) and records a
  `session.bound_agent_restored` CMS event. System agents are never
  backfilled — that would hand them the app default layer they deliberately
  do not get. Because the heal runs per turn, every existing broken session
  recovers on its next message with no migration.

### Tests

- 7 unit tests for the backfill guard set, and one integration test that
  fails the way production fails: client A creates the agent-bound session,
  client B — a separate client instance whose in-memory config map never saw
  the create — sends the first message. Without the fix the reply provably
  lacks the agent's instructions; with it, the binding is restored and the
  heal is observable in the event stream. Both verified red with the fix
  disabled.


## 0.5.53 — 2026-08-31

A third off the base prompt, private skills that load on demand, and a ledger
that can now answer "which agent spent this?"

### Added

- **Tokens by agent.** The usage ledger has carried `agent_id` on every
  settled turn since 0.5.48, so tokens-per-agent and tokens-per-turn were
  always one `GROUP BY` away — this release adds that pivot end to end.
  New CMS function `cms_provider_usage_agents` (migration 0071) returns
  per-agent totals, turns, sessions, the models each agent ran and a per-day
  series, plus a flat day-by-agent series; it reuses the summary's viewer
  scoping, so an admin sees the cluster and everyone else sees their own
  turns. New operation `GET /providers/usage-agents`. The Providers screen
  gains an **Agents** tab: daily tokens stacked by agent, and a table of
  agent / models / turns / sessions / total / tokens-per-turn / cache split /
  share / trend. Untick a row to drop that agent from the chart; click a
  column to sort. Turns from a session bound to no agent are reported as
  `(none)` rather than dropped — those tokens are real. The same capability
  reaches the MCP surface as `get_provider_usage_agents` and the Token
  Manager agent as a tool of the same name, so an agent that manages budgets
  can ask which agent is spending without iterating sessions.

- **A user-scope package's skills can be loaded on demand, by their owner.**
  Progressive skill discovery (0.5.45) indexes each skill as one line in the
  prompt and serves the body through `load_skill` only when a task needs it.
  That catalog was fleet-wide, and every session can call `load_skill`, so a
  user-scope package's skills — private to the person who published them —
  had to be left out of it. Their only route into a prompt was the
  `skills:` frontmatter declaration, which pastes the whole body in on every
  call whether or not it is used. The catalog is now owner aware: the worker
  keeps private skills in a second map keyed by owner
  (`_ownerScopedSkills`), and the session manager hands each session the
  shared list plus its own owner's bucket. Their names are listed in that
  session's prompt in a section of their own, so the model knows what it can
  ask for. A person's own copy wins a name collision with a shared skill.
  Nobody else can see or load them — not another person, not a system
  session, not an ownerless one — and a session whose owner cannot be read
  falls back to the shared list, because a failed identity lookup must never
  hand out somebody's private skills. This is what lets a user-scope package
  drop `skills:` and stop paying for bodies it may not use.

### Changed

- **The base agent prompt is a third smaller, with no rules lost.**
  `default.agent.md` goes 26,981 → 17,810 characters (version 1.19.0), and it
  rides on every model call of every session: measured on a live cluster, the
  system-message cost per call fell from 13,367 to 11,107 tokens on Claude
  Sonnet 5 and 12,303 to 10,424 on gpt-5.6-sol. The Critical Rules section
  had grown to thirty numbered rules with four duplicated numbers and several
  restatements of the same instruction; it is now fifteen, each said once.
  Every rule's meaning is preserved — the compression was audited sentence by
  sentence against the previous text, and the five test files that pin prompt
  phrases pass unchanged. The sub-agent spawn preamble (4,338 → 2,871 chars)
  and the `wait` tool description (765 → 611) got the same treatment.

- **The tokens-per-day chart is always linear.** It used to switch itself to
  a log axis when one day towered over the others. On a stacked bar a log
  axis is a lie: segment boundaries sit at the log of the running total, so
  equal heights mean equal ratios, not equal amounts — a segment worth 0.002%
  of the day could fill a quarter of the bar. The axis is now linear always;
  a spike is allowed to look like a spike.

### Tests

- 8 new tests for the owner-aware skill catalog in `skills-index.test.mjs`:
  the owner can load hers and her prompt lists it; another person, a system
  session and an ownerless session all get the shared list only; a thrown
  owner lookup falls back to shared; the shared list is passed through
  untouched when no user-scope package exists; collision resolution; the
  live map is re-read so a republish reaches open sessions; sort and clip
  match the fleet-wide index; and both catalogs are refilled in place on
  reload, since the session manager holds them by reference. Each verified
  red under three mutations — a catalog that ignores the owner, private
  skills leaking to every session, and the worker putting user-scope skills
  back in the shared catalog.

## 0.5.52 — 2026-08-30

Sessions stop paying for their own wake-ups. Orchestration 1.0.71.

### Fixed

- **A wake-up no longer throws away the provider's prompt cache.** Every
  wake-up (timer end, cron fire, child update) hands the model a short
  `[SYSTEM: …]` note saying why the session woke. That note was rendered
  into the SYSTEM message — the first bytes of every request — so each
  wake-up changed the prefix and the provider re-read the entire context
  behind it. Measured on a busy fleet: 12–19% cache hit on the first call
  after a wake-up, against 93–99% when the prefix is stable. The note now
  rides at the tail of the USER turn as a `<system_context>` block
  (`prompt-system-context.ts`); the system message stays byte-stable.
  Live A/B on the same prompts: gpt-5.6-sol wake-ups went from 0% cached to
  99%, Claude Sonnet from 62–65% to 99%. Transcripts keep their old shape —
  the note is still recorded as `system.message`, and `user.message` is
  persisted without the block. Orchestration ≤1.0.70 keeps the old delivery
  through the hand-off window; 1.0.70 is frozen in its own directory.

### Changed

- **A parent wakes for its children less often.** Four related changes:
  a child's bare `wait` ("I am sleeping, will check again") is now a
  heartbeat and does not wake the parent — the new `wait(material=true)`
  is the child's way to interrupt with something the parent must see, a
  verdict hint still gets through, and the QUESTION-FOR-PARENT coercion is
  untouched; a buffered child digest whose parent's own wait/cron fires
  within 60 seconds waits for that turn and rides into its prompt instead
  of causing a wake-up of its own (a failed or cancelled child still wakes
  the parent at once); the digest buffer window scales with fan-out
  (15s × children, 30s–5min); and a child's completion is never overwritten
  by its later wait inside one buffer window. Live A/B (parent + three
  waiting children + cron): 6 turns → 4, input tokens −29%, child-triggered
  wake-ups 2 → 0, same final answer.

- **`check_agents` reports what changed, not everything.** Children changed
  since the parent's last call get the full block (Output capped at 1,000
  chars, with `read_agent_events` for the rest); unchanged children are one
  roster line each; `full=true` returns everything. On a busy fleet the old
  full dump was 5–13K chars per call with 84% of lines identical to the
  previous call — and every copy stays in the transcript. The
  what-did-the-parent-last-see memo is a CMS event, so it survives worker
  moves; if it cannot be read, the report falls back to full.

- **Base agent 1.18.0** teaches both: a plain `wait` does not wake your
  parent, and `check_agents` is a delta.

### Observability

- **`session.prompt_sections` events.** The composer fingerprints each
  dynamic system-message section per turn and records an event when one
  changes, with the size delta. This is how the remaining prefix movers get
  found — it already named the next one: the RECURRING-TASK block appended
  after a session's first turn, worth exactly one cache miss per session.

### Tests

- New: 4 tests driving the real 1.0.71 generator (wake note in the user
  turn, retry-once, system-only retry), 9 child-wake tests (digest hold,
  scaled window, rank-based replace, wait suppression, material, question),
  6 classifier tests, 8 delta-report tests, 7 block round-trip tests, and
  the 1.0.71 freeze pins. Every behavioural pin verified red with its fix
  disabled.


## 0.5.51 — 2026-08-29

Sol Fast joins the model list, and a collapsed session stops hiding its own
child count.

### Added

- **`gpt-5.6-sol-fast` on the `github-copilot` provider.** GitHub Copilot
  offers it as "GPT-5.6 Sol Fast (Internal only)": the same capability tier and
  the same ~921K-token window as Sol, tuned for lower latency, at roughly twice
  Sol's per-token cost. It is declared exactly like Sol — both context tiers,
  and deliberately **no** `contextWindowSizes`. For a first-party Copilot model
  the service supplies the real window; `modelCapabilities` is sent only for
  BYOK providers (see the guard at the `sessionConfig` call site in
  `session-manager.ts`), so declaring our own numbers here would replace
  Copilot's with a guess.

- **`none` and `max` thinking levels on the GPT-5.6 models.** Sol, Sol Fast,
  Luna and Terra all accept `none, low, medium, high, xhigh, max` upstream, but
  the catalog listed only the middle four, so both ends were missing from the
  picker for no reason. Set per model against the live Copilot record rather
  than across the provider: the Claude models offer no `none`, and Grok and
  MAI-Flash offer neither.

### Fixed

- **The `[+N]` badge survives a narrow session pane.** A collapsed parent shows
  the number of hidden sub-agents as `[+4]` after its title. The portal clamps
  the title with `text-overflow: ellipsis` and the badge trailed it, so on a
  narrow pane the badge was the first thing cut — and that count appears
  nowhere else on the row, so a parent with four hidden children rendered
  exactly like a childless leaf. The badge run is now tagged
  `role: "collapseBadge"`, and the portal lifts it out of the clamped span and
  pins it beside the context column, which never shrinks. It stays inline in
  `titleRuns`, so the TUI — which does not clip — renders it exactly where it
  did before.

### Tests

- `collapse-badge-clipping.test.mjs` locks the split contract: the badge is
  tagged, splitting on the tag leaves the title intact, the badge stays
  directly after the title for non-clipping renderers, and an expanded parent
  carries no badge.
- `starter-model-config.test.js` now pins `none…max` and the `medium` default
  on all four GPT-5.6 models, so dropping either end of the range fails.

### Maintainer workflow

- `package-lock.json` tracks the release version again. 0.5.50 bumped the three
  published `package.json` files but not the lock, which had been left at
  0.5.43.


## 0.5.50 — 2026-08-29

A scheduled session's detail box is readable again.

### Fixed

- **The WAITING line is one glance, not a document.** `waitReason` carries two
  different kinds of text: `wait` asks the model "why you're waiting" and gets a
  sentence, while `cron` asks "what to do on each wake-up" and gets an
  INSTRUCTION — the real wake-up prompt, replayed on every fire and routinely
  several paragraphs. Both land in the same column, and both were printed in
  full, so a cron session's box was its entire next-turn plan under a one-word
  label. The display is now clipped to ten words, or 72 characters if ten words
  run longer than that — these instructions carry session UUIDs, and ten of
  those words measured 100 characters. Newlines are flattened first, the cut
  falls on a word boundary, and trailing punctuation is dropped so a line does
  not end "plan,…". The stored value is untouched: for a cron it is
  load-bearing state, not decoration, and the whole text is on hover.

- **A cron's text is labelled for what it is.** The box reads **On wake**
  rather than **Waiting** for a session with an armed schedule. It is not
  waiting *because of* that text — it is waiting for the next tick, and the
  text is what it will then do.


## 0.5.49 — 2026-08-28

A provider type that stores no key. `anthropic-wif` reaches the Anthropic API
with Workload Identity Federation: the worker authenticates as itself and mints
a short-lived token for each request, so there is no credential in the database
to rotate or leak.

### Added

- **`anthropic-wif` provider type** — Anthropic with no stored credential. The
  worker exchanges an identity token its own platform issues for a short-lived
  Anthropic access token, and hands `@github/copilot-sdk` a `bearerTokenProvider`
  callback rather than a key. The callback matters because the token outlives
  neither the session nor the worker: a session resumed days later on another
  node would otherwise come back with a dead credential baked into its config.
  Tokens are cached until shortly before expiry, minted once per worker however
  many sessions are running, and concurrent callers share a single exchange. No
  token is trusted for more than an hour however long it claims to be valid,
  because nothing tells a worker that a credential was revoked. On the wire the
  type is `anthropic`, the way `openai-proxy` is `openai`.

  The identity token comes from whichever the platform provides:
  `ANTHROPIC_IDENTITY_TOKEN`, or `ANTHROPIC_IDENTITY_TOKEN_FILE` (re-read on
  every exchange, so a token that rotates on disk is always current), or a
  Kubernetes-projected token at `AZURE_FEDERATED_TOKEN_FILE` which is redeemed
  at Microsoft Entra ID first. `ANTHROPIC_FEDERATION_RULE_ID`,
  `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_SERVICE_ACCOUNT_ID` name the rule,
  the organization and the service account the minted token acts as; a worker
  missing one of them says which at session creation rather than failing the
  first turn. See `docs/developer/reference/configuration.md`.

- **Adding one from the Admin Console** — the type appears in the Add provider
  list like any other and asks for no key: where the API key field would be it
  says *Use the Workload Identity configured in the worker*. **Update Key** is
  not offered on such a provider, and the server refuses a key update on one —
  there is no stored key to replace, and accepting the change would put a real
  secret in a row nothing reads a secret from.

### Changed

- **A workload-identity provider can only be shared, never personal.** A
  personal provider exists to run on its owner's own credentials; this type has
  none and runs on the worker's, which is the organization's. A personal one
  would spend the cluster's own Anthropic account under a name no administrator
  can cap, hold or even delete — `cms_provider_assert_manage` does not consult
  the admin flag on the personal branch — and anyone signed in may create one.
  Refused at the management layer with an explanation, and dropped by the
  runtime registry as well, so a row written by any other path still does not
  run.

- **A workload-identity provider is pinned to the endpoint its type declares**,
  and a per-instance `baseUrl` on one is ignored. Everywhere else that override
  is harmless, because the row carries its own key: aiming it elsewhere sends
  that key and nobody else's. This credential is the worker's, and
  `POST /me/providers` is open to any signed-in user and takes a `baseUrl`
  straight from the request body — so only the deployment's own config file may
  say where this credential is allowed to go.

- Everything that asked "is there a key for this provider?" now asks whether
  the type authenticates as the worker first. The registry keeps a keyless
  entry of such a type, the deployment seed writes a provider for it, and
  `credentialAvailable` reports true so the models are not greyed out or
  refused as a default. The exemption is attached to the TYPE and nothing
  else: a provider of a key type with no key is still dropped everywhere it
  was before, which is what keeps a personal provider from silently spending
  the cluster's key.


## 0.5.48 — 2026-08-27

Token accounting stops charging cached prompts twice. A turn's total is
input + output, and the cache figures are shown as what the input was made
of. Providers & Budgets gains a Cluster summary tab and a per-cell token
split; the desktop toolbar separates the workspace's own buttons from the
mode buttons; the Sequence/Activity divider, the chat↔canvas seam, long
markdown tables and Update Key on a shared provider are fixed.

### Added

- **Cluster summary** — a second tab on Providers & Budgets. Token totals
  for today, the last 7 and the last 30 UTC days (input, output, cache read,
  cache write, turns, sessions), a 14/30/90-day stacked chart, and a report
  per model — one row per model name, folded across providers, reasoning
  efforts and context tiers, with cache reads and writes as separate
  columns, its share and a sparkline. The provider count is distinct
  provider names in the ledger for the window, deleted ones included:
  accounting is keyed by name and survives a provider's deletion, its
  owner's deletion and a key rotation (tested). A provider
  picker at the top: **All**, **Shared**, **Users**, or any hand-picked set.
  Read from the usage ledger (migration 0068,
  `cms_provider_usage_summary`), so it includes system sessions — the
  Providers tab's meters count people's turns only, and the summary says how
  the total splits. Op `getProviderUsageSummary`
  (`GET /providers/usage-summary`), MCP and agent tool
  `get_provider_usage_summary`. Admins see the cluster; everyone else their
  own turns.

- **The Providers table says what each used figure is made of.** A limit is
  on the total — input + output — and every period cell showed only that
  total. Each cell now carries the parts (migration 0069; for everyone and
  for the viewer, over the meter's own window, scope and turns): input and
  output, which add up to the figure beside them, and how much of that
  input was read from and written to the cache. Shown under the figure on
  the selected row, and on hover on every cell. The daily series under a
  selected provider carries the same parts.

### Changed

- **The desktop toolbar is two clusters.** Left, the workspace's own
  buttons as one run: new session, filter, canvas, diagnostics. Right, the
  modes: Workspace, Budget, Admin console (Settings for a plain
  user) │ theme, sign-out. Budget and the Admin Console are one mode at a
  time (the controller closes one when the other opens), the Workspace
  button is the way back, and the whole left cluster exists only in
  Workspace mode — nothing on it applies to Budget or Admin. The phone
  toolbar is unchanged: its own view cycle, no admin console.

- **Budget and Admin headers lost their ✕ and their duplicates.** The
  Budget head keeps Refresh only (its gear and ✕ repeated the Mode
  cluster); the Admin Console header is the title alone (the signed-in
  person is already in the portal header). Esc still leaves Budget.

- **The default workspace is sessions + chat.** A first visit on a wide
  desktop no longer opens the canvas column by itself; a stored choice is
  honoured, and an agent drawing still brings its canvas up.

- **The system prompt notice is back to the activity feed only.** 0.5.47
  gave it a collapsed row in the chat pane, but the Copilot SDK echoes the
  prompt on every turn and the worker keeps a 120-character snippet of it,
  so the row repeated per prompt and opened to a snippet, not the prompt.

### Fixed

- **Budgets charged cached prompts twice.** A turn's total was
  input + output + cache read + cache write, but as the Copilot SDK reports
  usage the cache figures are parts *of* the input — in every recorded turn,
  on every vendor, `cache_read + cache_write ≤ input`, and equal to it when
  a turn wrote to the cache. So a cached prompt was counted once inside
  input and again as cache read: chk's last 30 days read 3.62B tokens for
  1.97B consumed, and every limit was biting at roughly half its stated
  size. Migration 0070 makes the total input + output, rewrites
  `tokens_total` on the ledger, and rebuilds the meters for their live
  windows from the corrected ledger. Every "used" figure drops by the
  cached amount; limits tuned against the old figures are looser from here.
  The cache figures are still recorded and shown — as what the input was
  made of, not as extra.

- **The Sequence/Activity divider drags again.** Its handle called a
  `clamp()` helper that v0.5.39 deleted, so every drag, arrow key and
  double-click on that seam threw `clamp is not defined` before dispatching
  — six releases with no test on the seam. One now drags it and fails on
  any uncaught page error.

- **Dragging the chat↔canvas seam moved the canvas↔diagnostics seam.** The
  right block was capped at 60% of the window, which a 640px canvas beside
  a 320px diagnostics column already reaches on a 1600px screen; past the
  cap the canvas kept its fixed pixels and the flex diagnostics column gave
  them up. The block now grows until chat is at its floor, the drag stops
  there instead of inflating the stored width, and the hairline seams sit
  above the canvas layer so both halves of their grab band are theirs.

- **A markdown table with long unbreakable tokens painted across its
  neighbour.** Fit-width tables give rigid columns a budget capped at 32
  characters of the longest cell and wrap them at spaces only; a
  60-character CamelCase test name got a 32ch column, could not break, and
  overflowed. A rigid column is now never budgeted below its longest token,
  so the table widens and the wrapper scrolls; `overflow-wrap: anywhere`
  is the fixed layout's last resort. The layout algorithm moved to
  `ui-core` (`table-layout.js`) where it is unit-tested.

- **Update Key on a shared provider did nothing.** Two gaps behind one
  button: the shared rows were rendered without the click handler (the
  click threw `onUpdate is not a function`), and the browser's
  `HttpApiTransport` had no `updateSharedProviderCredential` method, so
  even an opened sheet reported "not available on this transport". The e2e
  suite now rotates a shared key through the admin op, and the surface
  parity test requires every provider capability to be a transport method.

## 0.5.47 — 2026-08-27

Provider keys can be rotated in place — personal by their owner, shared by
an admin — and the rotation stomps nothing but the key. The agent picker is
a flat searchable list, the session detail box folds to one line, touch
scrolling on the session list commits to one axis, an agent's own opening
instructions stop appearing under the reader's name, and nine themes get
readable selected rows back.

### Added

- **Update a provider key in place.** Admin Console → Model Providers offers
  **Update Key** on every provider row you may rotate: your own personal
  providers (native TUI: `Shift+U`), and — for an admin — shared providers.
  Ops `updateMyProviderCredential` (`PUT /me/providers/:name/credential`,
  authed) and `updateSharedProviderCredential`
  (`PUT /management/providers/:name/credential`, fleet:admin);
  `manage_provider({ action: "update_credential", mine })` on the MCP and
  agent surfaces. Only the key changes: name, type, base URL, defaults,
  allowance, holds, system-session routing and usage history all stay.
  Migrations 0065 (personal), 0066 (keep a pinned `apiVersion` on rotation)
  and 0067 (shared rotation; both paths now merge the stored credential
  metadata rather than replacing it, and never carry the retired secret
  forward). A shared name reads as absent to the personal op; a personal
  name reads as absent to the shared op, even for an admin. A provider
  seeded from the deployment's model-providers file holds a pointer to an
  environment variable, not a key; rotating it is refused and the refusal
  names the variable to rotate instead.

- **A flat, searchable agent picker.** One row per agent instead of a tree of
  package headings; the package rides along as trailing text. A search box
  filters as you type (lexical, AND across terms, name-prefix first) and
  three sorts: **Most used** (per person, kept in profile settings), **Name**,
  **Package**. Other people's private packages no longer appear here — that
  is the package manager's job.

- **The session detail box folds.** It starts as one line — title, context %,
  when it last moved, and whether it is stopped — and opens to the full field
  grid on a click. The choice is a profile setting. A paused or waiting
  session keeps its reason and the way through to unstop it visible while
  folded.

- **The system prompt earns a collapsed row** in the transcript, the same
  affordance as a sub-agent response, rather than living only in the
  activity feed.

- **Download** button on an agent package's detail pane.

### Changed

- **Touch scrolling on the session list commits to one axis.** A drag scrolls
  up/down or left/right, never both, and a 45° drag no longer sits in a dead
  zone that moved nothing. Both axes are driven by the portal with its own
  momentum; a fine-pointer touchscreen keeps native scrolling so drag-to-
  reorder can have the finger.

- **Orchestration 1.0.70.** 1.0.69 is frozen. The provider-budget stash now
  stamps an agent's bootstrap kickoff as machine-authored instead of writing
  it bare, and a bootstrap prompt never merges into a person's message —
  both had let the reader's own name appear on words they never wrote, or
  hidden words they did. A message the merge pops and cannot use goes back
  to the head of the queue, not the tail: `[kickoff, "do X", "cancel X"]`
  used to run the kickoff and leave `["cancel X", "do X"]`.

- **An agent's opening instruction is attributed to the agent**, not to
  "You". Every bootstrap send in the SDK now stamps a sender (system for the
  definition's own kickoff, agent for a manager-supplied opening line); the
  portal folds a kickoff into one openable row.

- **"Admin console" is "Settings" for a plain user.** Same panel, but a
  non-admin sees only their own providers, default and packages, and the
  admin name promised more than it held.

- The share dialog no longer claims a person's grant "wins over" general
  access. A grant can only raise access above the general level.

### Fixed

- **Selected rows were unreadable in 9 of 20 themes.** The row label — and
  then its version number and scope badge — took a fill colour as text, an
  exact 1.00 contrast in cobalt2, doom, ms-dos, winamp, win95, duroxide,
  rust and spongebob. Guarded by tests that measure real WCAG ratios across
  every theme.

- **Arrowing through the session list fetched once per keypress.** The canvas
  snapshot effect keyed straight off the selection and re-armed the cost the
  navigation debounce had removed: 36 requests for 30 moves, now 6.

- The WAITING block in the detail box blinked in and out on every poll,
  under a status that was deliberately holding still.

- A failed provider change printed its error twice and left a banner behind
  after Cancel.

- Six pane settings (`canvasOpen`, `canvasZen`, `diagnosticsOpen` and three
  pane splits) never triggered a profile save; the change survived only if
  something else happened to change too.

- The agent picker's "Most used" counts were erased by the next portal save.

- Provider rows no longer crush the name under the controls beside it, or
  push Delete off the edge, in a narrow pane.

- Escape, Enter and the arrow keys work while the focus is in a modal's
  search box. The picker's own hint said "Esc close", and Escape did
  nothing; typing still types.

- A short session list that cannot scroll hands the touch straight to the
  page again; the axis lock had claimed the drag and the page stood still.

- The folded detail box keeps its title and marks on one line at any width;
  the marks ellipsize instead of wrapping under the title.

- The e2e suite is green for the first time in a while (89 passed, no
  skips); twelve tests were stale against a renderer, a theme and a default
  layout that no longer exist. One of them was concealing the fetch-per-
  keypress regression above.

### Tests

- The live HorizonDB embedder test for an oversized row (batch fails →
  oversized row marked terminal → good row retried alone) now waits six
  minutes instead of three. The service's embedder loops tick about once a
  minute whatever `intervalSeconds` asks for, so the three steps land at
  roughly 60s, 120s and 210s; the outcome asserted is unchanged, measured
  three times during this release.

### Notes

- `content-visibility` on transcript lines was tried for a re-layout win
  (8ms → 2ms per splitter frame) and **reverted**: it makes `scrollHeight`
  an estimate, and the pane's scroll-to-bottom landed 251px short. A test
  now guards that opening a session lands at the bottom.

- `AUTHZ_ENFORCE_OWNERSHIP` still defaults to `false` and the deploy
  template ships `false`. In that mode every ownership denial is computed,
  audited as `would_deny`, and allowed through — including writes — while
  the UI describes a boundary it is not enforcing. Deployed environments
  set it `true`; a new one is open until someone does.

## 0.5.46 — 2026-08-25

Shared agent packages gain editors, every signed-in user is findable in
share dialogs, the Agent Manager learns MCP, deployment-restricted MCP
servers move from a Waldemort image patch into the platform, canvas apps
gain a shared KV store that several people write at once, and skills become
discoverable on demand instead of inlined into every session.

### Added

- **Package editors.** The owner of a SHARED agent package (or an admin)
  can grant named users write access: publish new versions, republish into
  it, pin, enable/disable. Editors cannot change scope, delete, or manage
  the editor list. Demoting the package to user scope revokes every grant
  in the same transaction; a personal copy of the same name never inherits
  one. New table `agent_package_editors` (migration 0063, keyed on
  `users.user_id` like session shares), procs `cms_grant/revoke/list_agent_package_editor(s)`,
  `can_edit` on package reads, ops `grantAgentPackageEditor` /
  `revokeAgentPackageEditor` / `listAgentPackageEditors`, MCP tools
  `grant_agent_package_editor` / `revoke_agent_package_editor` /
  `list_agent_package_editors`, `pilotswarm agents editors add|remove`, and
  an Editors section in the Admin Console package detail. Grants and
  revocations are written to the authz audit log.

- **`allowedAgents` on MCP catalog entries.** A deployment `.mcp.json`
  entry can name the only agents allowed to reference it — `name` for a
  deployment agent, `namespace:name` for a plugin or package agent (shared
  copy only). Other references are dropped at load, restricted servers
  never join the default set or the every-session base map, the field is
  stripped before configs reach the Copilot CLI, and a package can neither
  restrict a server nor redefine a restricted one. Replaces Waldemort's
  version-pinned `worker.js` patch.

- **MCP validation at publish.** New package validator rules:
  `mcp_requires_schema_v2`, `mcp_default_forbidden`,
  `mcp_allowed_agents_forbidden`, `reserved_mcp_server_name`, and the
  `unknown_mcp_server` warning. The Agent Manager (1.1.0) now knows how to
  author `.mcp.json`, `plugin.json` `mcpConfig`, and the schema-2
  `mcpServers:` frontmatter.

- **The canvas KV store (interactive canvas apps, phases 1–3).** A canvas
  app now holds durable, per-key shared state that several people write at
  once: `canvas_kv` table (migration 0064) with compare-and-swap `rev`,
  tombstones, per-canvas budgets (1000 keys, 2 MB, 16 KB values) and a
  NOTIFY per write on the existing canvas plane. Three doors, one SDK
  chokepoint (`canvas-kv.ts`): the signed-in browser
  (`readCanvasKv`/`writeCanvasKv`, access classes `canvas:read`/`canvas:write`
  gated on session read), the link view (`GET /api/canvas-share/kv`, read
  only), and the agent (`canvas_kv` tool). Pages talk to the host with
  `canvas-kv` / `canvas-kv-result` / `canvas-kv-ready` / `canvas-kv-change`
  and paste the `CanvasKV()` helper from the `canvas-apps` skill. The owner
  sets who may write per canvas (`setCanvasKvAccess`: owner | readers |
  link, in the share dialog); the app declares `"kv": { "write": "viewers",
  "shared": [...] }` in its manifest; both switches are needed. Reserved
  prefixes (`cfg/`, `evt/`, `ui/<writer>`), author-bound overwrites, and the
  `req/*` status cap (collaborators suggest, the owner queues) are enforced
  server-side. Read/write links and the app catalog are not in this release.

- **The canvas app catalog (interactive canvas apps, phase 6).**
  `publish_canvas_app` copies a canvas to a pinned `app-<name>.html`
  artifact and writes its card as the shared fact `apps/<name>`;
  `find_canvas_app` ranks the catalog (hybrid search on an enhanced store, a
  term-overlap listing on a base store); `draw_canvas({fromArtifact:
  card.source})` puts a found app on screen. The manifest gained an
  `interface` block — `keys` (KV keys, writer, example value), `requests`
  (`req/*` ops, args, result), `events` — and publish refuses an app
  without one: the card is what an agent that never read the HTML drives the
  app from. The base prompt tells agents to look before building; facts
  migration 0012 buckets the `apps` namespace in stats.

- **Progressive skill discovery.** The base prompt now carries a one-line
  index of every registered skill and a `load_skill` tool returns a body on
  demand, so a session pays only for the skills it uses. The canvas guidance
  moved out of every session's context (≈15K chars → ≈1.5K) into
  `html-visuals` and a rewritten `canvas-apps` skill; the four canvas tool
  descriptions shrank to match. The stale "sub-agents have no canvas" line
  is gone (they have had canvases since 0.5.37).

### Fixed

- **A canvas button press printed its raw JSON in the transcript.** The
  chat classified the message before removing the `[FROM: …]` attribution
  prefix and the appended `[SYSTEM: …]` notice, so a press from anyone but
  the session owner failed the canvas-action test and rendered as an
  ordinary message showing `[canvas-action] {…}`. Cleaning comes first now.
  The portal no longer drops these lines either: a press is something the
  viewer did, so it renders as one collapsed row — an uppercase `CANVAS`
  tag, the action name, a one-line summary, the time — that opens to show
  the exact payload the page sent.

- **The runtime's own `[SYSTEM: …]` notice printed as prose to everyone but
  the owner.** The forged-marker neutralizer inserts a zero-width space
  after `[` so a collaborator cannot inject system guidance, and it runs
  when the queued message is consumed — after the runtime has appended its
  own timer or cron notice to that same text. The transcript's notice
  matcher only knew the clean spelling, so genuine notices leaked into the
  conversation. It now matches both spellings; the notice is hidden from
  chat and kept in the activity feed, as it always was for owners. The
  ordering itself is still wrong upstream and is worth fixing separately.

- **A canvas app's first `ready` handshake was dropped on every cold open.**
  A document runs its scripts in the staging iframe and is promoted on
  load; the host bridge accepted messages from the live frame only, so a
  page that called `CanvasKV()` at script time waited forever. The bridge
  now answers KV reads (`ready`, `list`, `get`) from the staging frame of
  the same canvas and replies to the window that asked; writes and actions
  stay live-frame only. The skill's helper also re-posts `ready` until
  answered, lists the app prefix across pages, fetches a change that
  arrived without its value, and resyncs when the live feed is quiet.

- **Canvas actions from write-shared collaborators.** The doorbell was
  creator-only; per the canvas-apps design anyone who can write the session
  may ring it (they can already send a message). Read-only viewers and link
  bearers are still refused. The stale "sub-agents have no canvas" and
  "creator only" lines are gone from the prompts and the `html-visuals`
  skill.

- **No live path under the dev auth provider.** The browser sent its
  bearer token as a WebSocket subprotocol value, and a dev token
  (`dev:<persona>`) contains a colon, which RFC 6455 forbids — the
  `WebSocket` constructor threw and no events, canvas ticks or KV changes
  ever streamed. The client now percent-encodes the token and the server
  decodes it (a JWT is unchanged). Also: the share-link socket dropped a
  `subscribeCanvas` sent on `open` about half the time (the handler was
  attached after the token was resolved); early messages are now buffered
  and replayed, and bearers are no longer told the session id.

- **Signed-in users missing from share and editor pickers.** Users are
  registered at login (since 0042), but the member directory hid every row
  whose Entra token carried no `name` claim. `cms_list_users` now shows a
  user with a display name OR an email, and the Entra normalizer falls back
  to `preferred_username` for the display name.

## 0.5.44 — 2026-08-24

### Portal

- **System spend, readable.** The Providers & Budgets pane's System spend
  block was one run-together text column (`gpt-5.6-terra77.9M · 100 turns`).
  It is now three stat tiles — tokens, turns, tokens per turn — and a
  per-model table with a share bar, so "77.9M of 94.7M on one model" reads
  without arithmetic. Share column hides at phone width.

## 0.5.44 — 2026-08-24

### Portal

- The Admin Console's Model Providers pages (My Providers, Shared Providers)
  get their missing styles: provider rows with aligned badges and actions,
  labeled Add provider buttons, proper label/control grids for the session
  default selectors, a readable System Agent Overrides table, and an apply
  row that no longer strands its hint. The section previously rendered as an
  unstyled stack.

## 0.5.43 — 2026-08-23

Runtime model providers become first-class managed resources, budgets enforce
real token policy at turn boundaries, canvas apps gain a durable artifact
lifecycle, and orchestration retry exhaustion stops hiding failed sessions.

### Added

- **Shared and personal runtime providers.** The checked-in model catalog now
  describes provider types and model capabilities; CMS owns named provider
  instances, credentials, user/cluster/system defaults, per-agent system
  overrides, and exact `provider:model` routing. Admin Console, SDK, Web API,
  MCP, portal, and native TUI expose the same management surface.

- **Provider budgets and accounting.** Day/week/month and per-model token
  limits, shared-provider allowances, administrative holds, exactly-once usage
  accounting, paused-session diagnostics, and automatic wake-up when capacity
  returns. The budget table keeps fixed meter windows; selected-provider charts
  offer 14-, 30-, and 90-day user/system history ranges.

- **Provider management agents and tools.** The Token Manager can inspect and
  manage provider policy within its caller's authority. MCP gains provider,
  default, budget, hold, usage, and paused-session operations. Ambiguous model
  references return structured candidates instead of silently picking one.

- **Reusable canvas apps.** Canvas documents can embed a normalized manifest
  and response contract, save themselves server-side as artifacts, be browsed
  cheaply by manifest, and redraw from verified artifact bytes. Transient
  whole-state and merge-patch updates remain low-latency and non-durable.

- **Full agent-package downloads.** Direct and Web management clients, the
  portal route, HTTP transport, CLI, and MCP package inspection can retrieve
  the verified package tarball, with copy selectors and provenance preserved.

### Changed

- **Orchestration `1.0.69`.** Returned errors count against the same retry
  budget as thrown errors. Returned authentication failures stop immediately
  with key-repair guidance, and retry exhaustion persists the final CMS error
  rather than leaving an idle-looking session with a lost prompt.

- **Management layering is contract-tested.** Agent-package and worker
  operations now land on `PilotSwarmManagementClient` first, with matching Web
  methods and an explicit ownership manifest for intentional non-management
  operations. CLI, portal, TUI, and MCP no longer reach through the client to
  raw catalogs.

- **Provider type/runtime semantics are explicit.** Type templates and
  viewer-usable runtime instances carry distinct `catalogKind` values; model
  discovery, creation, switching, spawning, regeneration, and Agent Manager
  verification share owner-scoped resolution.

### Fixed

- Provider deletion dependencies, invalid fractional limits, stale or missing
  provider references, legacy credential adoption, system-session accounting,
  per-user privacy, and ledger lifetime boundaries now fail closed with typed,
  actionable errors.

- Session hard deletion no longer threatens accounting history, and provider
  deletion removes current rules/meters while retaining historical usage under
  the provider name.

- Concurrent full test matrices no longer delete each other's live PostgreSQL
  schemas or session-state directories during stale-state cleanup.

- Agent Manager enforces staged package identity/version, reserved agent names,
  explicit provider choice, and actor/source provenance when publishing.

### Docs And Verification

- Updated canonical API, local setup, plugin, builder-agent, DevOps sample,
  canvas, TUI/portal, and MCP guidance for runtime providers and shipped canvas
  behavior.

- The release gate covers baseline PostgreSQL and HorizonDB provider matrices,
  Horizon-store live integration, package/API parity, responsive budget charts,
  and npm/starter-image packaging.

## 0.5.42 — 2026-08-15

The phone keyboard stops burying the conversation, share links become
individually copyable per entry point, model switches become visible, and turn
metrics finally record which agent produced them.

### Added

- **Keyboard takeover on phones.** While the on-screen keyboard is up and the
  composer summoned it, the portal header, toolbar and session list fold away
  so the conversation keeps the visible viewport, and the transcript snaps to
  the newest message. It is driven by the keyboard state itself — a
  visual-viewport shrink plus composer focus — so it reverts the moment the
  keyboard goes, including the iOS swipe-dismiss that never blurs the input.
  There is no mode that can get stuck.

- **One copyable box per entry point.** Deployments configured with several
  `PORTAL_LINK_ORIGINS` now render a labelled, independently copyable field per
  origin plus a single "Copy all", instead of one textarea holding every URL.
  A sender who knows the recipient's network copies one link; a sender who does
  not copies both.

- **The canvas share dialog is tabbed.** "Session access" and "Anyone with
  link" become tabs, matching the Manage-session dialog. Both panels occupy one
  grid cell so the dialog is sized to the taller tab and switching never
  resizes it — and the destructive Reset link no longer sits directly under the
  innocuous deep link.

### Fixed

- **Model switches are visible again.** `session.model_changed` has always
  carried the old and new model, but the sequence pane dropped the event
  entirely (its renderer had no case, and the default returns null) and the
  activity feed printed a bare grey `[session.model_changed]` with no body,
  because the event carries structured data and no message text. Both now
  render `model <old> → <new>`, with the reasoning effort when it changed.

- **Turn metrics record their agent.** `session_turn_metrics.agent_id` was
  hardcoded `null` on every row ever written. Per-agent attribution reported
  nothing, fleet rollups papered over it by coalescing back through `sessions`,
  and the hourly-bucket query's `p_agent_id` filter silently matched no rows.
  Rows now carry the session's resolved agent identity. Existing rows stay
  null — this fixes attribution going forward, not retroactively.

### Docs

- **`docs/proposals/token-ledger.md`** — usage accounting, token pools rooted
  at provider credentials, and windowed token budgets enforced at the turn
  boundary, plus the Token Manager system agent and the admin Usage console.

## 0.5.41 — 2026-08-14

A mobile follow-up to the 0.5.40 portal work. The composer's expand mode is
removed outright, the composer now shrinks back after its text is cleared on
iOS, and the canvas share button reaches the phone header.

### Fixed

- **The composer expand mode is gone.** The ⤢ toggle grew the input to half
  the viewport, hid the conversation behind it, and on mobile could not be
  reverted reliably. The composer now only auto-grows with its content.

- **The composer shrinks after send on iOS.** Height measurement resets the
  textarea to zero height before reading `scrollHeight`; `height: auto` left
  iOS Safari reporting the high-water mark, so the input stayed tall after the
  text was sent or deleted.

- **The canvas share button reaches the mobile header.** The phone-width
  canvas header (the revision strip) now carries the same share-link button as
  the desktop toolbar, so view-only canvas links can be minted from a phone.

- **The cron-contracts test pin follows the base agent.** 0.5.40 bumped
  `default.agent.md` to 1.16.0 without moving the version pin in
  `system-agent-cron-contracts.test.js`, leaving the full suite red on a
  stale assertion. The pin now matches.

## 0.5.40 — 2026-08-14

PilotSwarm gains two high-volume data paths: bulk fact ingestion with
record-level retry artifacts, and a low-latency live canvas plane that keeps
rapid dashboard updates out of durable transcript history. Canvas workspaces
also gain ancestor-authorized multi-writer targeting and constrained share
links, while the portal editor, pane sizing, and full-screen controls receive a
focused usability pass.

### Added

- **`bulk_store_facts` for large corpus imports.** Sessions can ingest up to
  50,000 records from inline JSON or an artifact in bounded chunks. Writes are
  intentionally non-atomic, failures retain per-record attribution in a
  retryable artifact, and `intake/` remains reserved for the single-record
  curation path. PostgreSQL and HorizonDB providers now report the database's
  actual stored count.

- **A transient live canvas data plane.** Migration 0047 adds a last-value
  live row per session and canvas slot with atomic sequence numbers and RFC
  7386 merge patches. PostgreSQL notifications wake a stateless portal relay;
  WebSocket clients apply contiguous patches, coalesce gap recovery, and fall
  back cleanly when the plane is unavailable. Durable draws and compatibility
  ticks remain available during rollout.

- **Multi-writer canvas targeting and share links.** Canvas tools may target an
  ancestor session under fail-closed authorization and per-target rate limits.
  The portal can generate view-only links from configured public origins,
  validates allowed origins, and preserves session access checks across the
  HTTP and WebSocket paths.

### Changed

- **The portal composer behaves like a native editor.** Cursor movement,
  selection, undo, auto-growth, expanded editing, mobile keyboard behavior,
  and per-session drafts now follow browser-native semantics. Chat and
  inspector content measure their actual pane width instead of inheriting the
  terminal layout's estimated columns.

- **Canvas guidance favors patches for rapid updates.** Built-in agents and
  the HTML visuals skill teach bulk facts, patch economy, and shared-dashboard
  workflows; their authored versions advance with the new behavior.

### Fixed

- **Canvas controls remain readable at narrow and full-screen widths.** Long
  slot names shrink with ellipsis, and full-screen mode moves normal toolbar
  actions into the left rail so canvas metadata and controls no longer collide.
- **Frontend WAF policy stays aligned with the deployed baseline.** The global
  Front Door template includes the current DRS exclusions and opt-in managed
  rule-group overrides.

### Verification

- Production builds and all three npm package dry-runs were completed for the
  release. The full test suite was explicitly skipped at release time by
  operator request.

## 0.5.39 — 2026-08-13

Agent packages become safe to shadow. One package name can exist as a shared
release and a per-user copy at the same time, and every surface — worker
sessions, the admin console, the CLI, and the MCP tools — now resolves, edits,
and rolls back the exact copy you mean instead of guessing. Two rounds of
adversarial review hardened the new paths against cross-tenant leaks and blob
loss. The release also fixes a mobile navigation bug and bounds the diagnostics
split, and ships green across the baseline and HorizonDB all-providers matrix.

### Added

- **A copy selector across the whole package lifecycle.** `{scope, owner}`
  flows through the protocol, transports, admin console, CLI, and MCP tools, so
  pin/rollback, enable/disable, delete, and file/tree reads target the intended
  copy rather than falling back to "own copy, then shared". The owner override
  is admin-only, so a non-admin can never probe another user's private package.

- **`republishAgentPackageVersion`.** Publishes an existing version's exact
  bytes into the same-named package in the other scope — the update path a
  promote cannot express, since promote only moves a row to an unused name. The
  console gains "Publish to shared" and "Copy to my user scope".

### Changed

- **Workers bind each session to its resolved package copy.** Prompts, tool
  handlers, MCP grants, and skills all follow the one copy a session's owner
  resolves to, replacing name-keyed maps that could serve one copy's prompt
  alongside another copy's tools. A single shared resolver now carries the
  privacy and shadowing rules into the spawn/create control bridge as well as
  the tuner activity.

### Fixed

- **The mobile sessions button no longer opens diagnostics.** On a phone the
  Main (sessions) button focuses the chat, which normalizes to the inspector
  because a phone has no chat focus slot; the follow-focus effect then read that
  as "open diagnostics". Focus now carries its raw intent, so only a genuine
  inspector or activity focus switches the pane.

- **Fail-closed package privacy.** A private user copy is never served as a
  fallback to another owner's session; a package agent reads only its own
  copy's MCP grants and composes only its own package's private skills; and the
  publish warning no longer enumerates other users' private packages.

- **Publish targets the right scope, and deletes are blob-safe.** Publishing to
  shared while owning a same-named user copy no longer silently no-ops, and
  staging-cleared and no-op results are announced explicitly. Content-addressed
  blobs shared by same-bytes copies survive deleting one copy: migration 0046
  returns only genuinely orphaned blobs, so a delete can no longer strand a
  sibling copy fleet-wide.

- **Diagnostics split bounds.** The desktop diagnostics column split adjuster is
  clamped to valid bounds when dragged or nudged by keyboard.

## 0.5.38 — 2026-08-11

Canvas grows from one root-only surface into a small session workspace: every
session can own five named canvases, switch among them without redrawing, and
keep each slot's revisions and live data independent. The portal adds an
identity-aware proxy auth provider and a denser, more flexible canvas and
diagnostics layout, while OpenAI-compatible BYOK sessions preserve the model
capabilities declared by operators. The release closes with a green baseline
and HorizonDB all-providers matrix.

### Added

- **Five named canvases per session.** `draw_canvas`, `update_canvas`, and
  `read_canvas` accept slots 1–5; draws may assign a friendly name; each slot
  keeps independent document and data revisions. Slot 1 remains
  `canvas.html` for compatibility, while slots 2–5 use `canvas2.html` through
  `canvas5.html`. Canvas tools are available to sub-agents as well as roots,
  and migration 0045 adds the per-slot catalog cache used by cold portal loads.

- **`show_canvas`.** Agents can bring an already-drawn slot back to the user's
  screen without replacing bytes, creating a revision, or marking content
  unseen. The durable `session.canvas_presented` event follows the same
  freshness and user-dismissal guards as a draw.

- **Identity-aware proxy authentication.** `PORTAL_AUTH_PROVIDER=proxy`
  supports signed assertions from Cloudflare Access, Google IAP, AWS ALB,
  Pomerium, oauth2-proxy, Authelia, Authentik, and similar front doors. JWT
  mode validates JWKS, issuer, and audience; unsigned forwarded-header mode
  fails startup unless the operator explicitly confirms the origin is isolated.

### Changed

- **Canvas and diagnostics workspace.** Desktop canvas and diagnostics are
  independent columns with canvas slot controls, cold-load markers, a centered
  toolbar, and per-session zen/full-screen behavior. Mobile combines Inspector
  and Activity behind one diagnostics tab while preserving a content-region
  canvas and an explicit whole-screen maximize state. The default theme for a
  new workspace is now Workspace Dark.

- **OpenAI-compatible BYOK contracts.** Provider-declared vision and context
  capabilities now reach the Copilot runtime, reasoning effort is carried on
  the proxy base URL instead of changing model identity, and unsupported
  capability blocks are omitted. Replay also strips null response-only fields
  before sending historical messages back through strict OpenAI-compatible
  endpoints.

### Fixed

- **Portal pane geometry and controls.** The diagnostics seam can collapse
  fully and remains aligned while dragging; activity loading uses the shared
  working indicator; canvas controls, right-rail actions, narrow headers, and
  theme foregrounds remain usable across desktop and mobile layouts.

- **Theme tests follow the shipped default.** New-workspace and stale-theme
  fallback assertions now track Workspace Dark instead of the retired Noctis
  Obscuro default.

## 0.5.37 — 2026-08-08

The session canvas ships — a standing, session-owned visual surface that the
agent draws, updates in place, makes interactive, and reuses as saved apps —
and the session summary retires in its favor. A large mobile/portal fix batch
rides along, closed out by a four-reviewer adversarial pass and a green
all-providers test matrix.

### Added

- **Session Canvas.** Root sessions get `draw_canvas` / `update_canvas` /
  `read_canvas`: one live HTML document per session, backed by the reserved
  pinned `canvas.html` artifact with monotonic revisions on durable
  `session.canvas_updated` events (bytes-then-event, serialized, single
  persistence path). The portal renders it beside the chat through a
  double-buffered sandboxed frame (no white flash, state preserved across
  toggles); phones get a full-screen overlay with a three-state toggle
  (empty / loaded / unseen). Documented in `docs/architecture/canvas.md`.

- **Interactive canvases.** A draw may declare a `responseContract`
  (actions × typed fields, with an optional `data` key documenting the tick
  shape). Page controls post back via `parent.postMessage`; the browser
  enforces provenance (live frame only), contract validation
  (default-closed), a rate limit, and **creator-only posting, fail-closed
  server-side** — shared writers and admins are refused. Conforming actions
  arrive as `[canvas-action]` user messages, hidden from the chat pane.

- **Live data ticks.** `update_canvas` sends ≤32 KB JSON payloads to the
  page's `applyData()` without replacing the document — dashboards redraw
  their shell once and tick content forever. The latest tick replays into
  freshly loaded pages; ticks badge the canvas unseen without stealing the
  screen.

- **Canvas apps (reuse, phase 1).** `draw_canvas({fromArtifact})` renders a
  stored HTML artifact server-side — the bytes never transit the model. Apps
  self-describe with an embedded `CANVAS-APP-MANIFEST` comment whose contract
  passes the same normalizer as the tool argument (explicit argument wins;
  broken embedded contracts fail stored-app draws closed). The draw result is
  an interface card — manifest summary plus the effective contract, never the
  HTML — and `read_canvas`/`read_artifact` gain `manifestOnly`.
  `write_artifact`'s `fromArtifact.sessionId` now defaults to the calling
  session, making save-as a one-filename call.

### Removed

- **Session summaries.** `update_session_summary`, the summary chat view, the
  summary columns in group tables, and every instruction that maintained them
  are gone — the canvas is the standing at-a-glance surface. Data-layer
  columns linger for compatibility and are not read by anything shipped here.
  Downstream deployments with agents that called `update_session_summary` or
  filtered `list_sessions` by `summary_updated_since` must drop those usages.

### Fixed

- **Mobile portal, from live iPhone use:** the sequence grid no longer builds
  for a viewport that doesn't exist (a legacy publisher derived columns from
  `innerWidth/7` — the visual viewport under pinch — and raced the font
  probe; it is gone, and the inspector self-measures as a backstop);
  inspector panes keep horizontal panning with scrollbar chrome hidden and
  sideways offsets reset on pane switch; stats cards stop wrapping every row
  when one value is long; the sequence stats box wraps inside its border at
  any width; canvas audio unlocks on `touchend` (iOS grants no activation on
  `touchstart`, and `preventDefault` there suppresses the synthetic click);
  frames may autoplay (`allow="autoplay *"` — opaque origins never match the
  default allowlist).

- **Canvas pages keep their state.** Container resizes reflow instead of
  reloading (the settle-reload now rescues only degenerate-box loads), so a
  window drag no longer resets a running game; hidden kept-alive frames are
  actually `inert` (React 19 renders `inert:""` as absent — a keyboard trap).

- **Transcript truth.** Canvas revision lines no longer retro-vanish from the
  TUI transcript (platform-minted events are exempt from the redelivery
  window); double-clicked canvas actions stay two bubbles; canvas action
  payloads that JSON cannot serialize are refused instead of thrown.

- **Draw integrity.** Canvas revision reads fail loud instead of minting
  rev 1 over a live canvas after a transient database error; the armed
  contract returned by `read_canvas` is re-validated; manifest extraction
  cannot be shadowed by prose that merely mentions the convention.

- **Keyset session paging skips no rows** (open since v0.5.31): migration
  0044 compares and orders `cms_list_sessions_page` in millisecond space, so
  the JS `Date` cursor addresses same-millisecond boundary rows exactly.

- **Group rename.** Clicking the group button with a group selected opens a
  rename dialog instead of create-new; chat history auto-loads no longer
  teleport the reader to the top of the loaded window.


## 0.5.36 — 2026-08-07

The portal workspace now reads and behaves as one coherent instrument: panes
share a single outer frame with hairline dividers, resizers stay attached to
the pointer even over rendered artifacts, and the remaining theme-specific
contrast and clipping failures are fixed. This release also records the design
for a future session-owned visual canvas.

### Changed

- **The portal workspace is one joined surface.** Sessions, chat, inspector,
  and activity panes now sit inside one outlined shell with hairline resizer
  seams instead of separate rounded cards and wide gutters. Focus uses one
  theme accent consistently, while each theme remains responsible for a
  readable border colour.

- **Session Canvas proposal.** The design specifies a standing, session-owned
  visual surface backed by artifact publication, including write-before-emit
  ordering, size limits, browser presentation, and a quiet chat transcript.
  This is a proposal only; no canvas runtime ships in this release.

### Fixed

- **Pane resizing no longer sticks over rendered artifacts.** Resize handles
  capture the active pointer and temporarily make iframes inert, so releasing
  over a cross-origin HTML artifact reliably ends the drag. The
  inspector/activity split also measures its real rendered row height instead
  of assuming a fixed pixel size, keeping the seam under the pointer.

- **Artifact-reader controls remain reachable in narrow panes.** The toolbar
  wraps when necessary, preserving the Close action instead of allowing the
  right-hand controls to overflow out of view.

- **Theme contrast and identity details are readable again.** The Win95 admin
  console uses its panel surface and stronger hint text, MS-DOS selected text
  uses the matching highlight foreground, Duroxide borders have enough
  contrast to divide joined panes, and the signed-in name and email no longer
  clip under the Duroxide display face.

## 0.5.35 — 2026-08-06

Artifacts stop being files you download and become things you look at. An agent
that builds something visual can now put it on your screen mid-turn, and the
portal renders it as a real page rather than as source. Plus a theme wearing
the Duroxide brand, and the discovery that seven of the eight built-in skills
had never been wired to anything.

### Added

- **HTML artifacts render as pages.** A `.html` artifact opens in the reader as
  the live document — charts, tables, layout, its own scripts — instead of as
  syntax-highlighted source. It runs in an iframe with `allow-scripts` and
  deliberately **no** `allow-same-origin`: blob URLs inherit the creating
  origin, so withholding that flag is what forces an opaque origin, and it is
  the only reason a page can execute its own tooltips without being able to
  reach the signed-in user's token, storage, or the parent DOM. The frame
  streams the artifact's own bytes rather than the preview text, which also
  sidesteps the 200,000-character preview truncation — a 333 KB dashboard was
  previously shown at 60% of itself, silently.

- **`show_artifact`** — an agent can display one of its own artifacts in your
  portal, live, while you watch. It rides the ordinary durable event stream
  (`session.artifact_presented`), so one mechanism covers the live push, the
  transcript record and replay. Three guards keep it from being obnoxious:
  active session only, events fresher than two minutes (a reconnect burst must
  not replay yesterday's dashboard), and the live path only — merely *opening*
  a session never auto-opens whatever it last presented.

- **Artifacts in the transcript are cards**, not underlined filenames trailing
  "(press a to download)" — a keystroke that does not exist in a browser,
  describing the wrong verb for something you want to read. Each card names the
  thing, says what kind it is, and opens the reader. HTML gets its own mark and
  an accent-tinted thumbnail, because it is the one kind that opens as a live
  page rather than as text.

- **The artifact reader takes over the right column**, replacing the inspector
  and activity panes for as long as it is open, with `‹ ›` (and arrow keys) to
  walk the conversation's artifacts and `✕` to hand the column back. If the
  column was already collapsed when the reader opened, `✕` collapses it again —
  opening a reader must not become a way to un-hide panes you dismissed.

- **Artifact deep links open the chat *and* the artifact**, side by side:
  `?session=…&artifact=…&view=full`. The transcript is the context that makes
  an artifact mean anything, so landing on the file alone loses half of what
  was shared.

- **Zoom for the rendered artifact, and nothing else.** Browser zoom scales the
  whole workspace — session list and transcript included — when the thing you
  wanted larger is one dense chart. The reader's own `− 100% +` shrinks the
  frame's layout box and scales it back, so the document *reflows* at the
  zoomed size rather than being magnified as a flat picture. Composes with
  fit-width: fit picks the base scale, zoom moves from there.

- **Fit-width for the rendered artifact**, scaling a fixed-width page down into
  a narrow pane. Only ever scales DOWN — when the pane is already wider than
  the layout there is nothing to fit, and blowing a responsive document up
  just makes it coarse. While fitting, the frame's width is pinned, so a pane
  resize changes only the scale and costs the reader no scroll position.

- **Folders can be renamed.** A folder has no model, no sharing and no
  visibility, which is why the manage surface excludes groups — but it does
  have a title, and renaming is the one manage action it supports. The Manage
  control routes groups straight to the rename modal rather than dead-ending
  on them.

- **`html-visuals` skill** — the sandbox contract, a chart-form selection
  table, dashboard structure and a self-check list, for agents that build
  visuals. Opt-in: declaring a skill inlines it into every prompt for the life
  of the session, so it is not on the base agent.

- **Duroxide theme.** Iron oxide pressed into black felt, with the project's
  own mark traced from the banner artwork rather than redrawn — one path, four
  subpaths, wound so the default nonzero fill rule punches the hexagon ring and
  the gear bore. Every colour is measured off the artwork. The catch, and the
  theme's organising rule: the exact brand oxide is 2.87:1 on its own ground
  and therefore cannot be text, so it is spent on chrome while a brightened
  sibling carries the interactive role. The banner's felt is reproduced as two
  generated noise layers rather than a bitmap — a fine grain for the paper
  tooth under a coarse weave and a slow mottle for the raking light — and the
  mark is pressed into the chat panel as a large watermark, screen-blended so
  it lifts the sheet rather than washing over the text. Dense content gets its
  own opaque ground so the grain cannot eat it: tables carry full-strength
  rules and an oxide header with an accent rule beneath, and code blocks and
  artifact cards get the same treatment.

  The chrome is set in a slab — Rockwell, falling back through Bitter to
  Georgia. Like every other face in the portal it is a system font: nothing is
  fetched, because a deployment may be air-gapped and a remote font request
  would hang or silently fall back.

### Changed

- **The type scale is one step larger.** `--ps-font-size-chat/base/dense` each
  gain 1px, in `:root`, so every theme inherits it and the whole UI — sized in
  rem against those three — moves together. The touch scale and the phone
  step-down move with it; leaving them would have quietly collapsed the touch
  boost and made a phone read two notches smaller instead of one.

- **Base agent 1.9.0** prefers a rendered visual to a wall of numbers: asked to
  *see* something, an agent builds a self-contained page and calls
  `show_artifact`. Carries the four sandbox rules that decide whether the page
  renders at all, because breaking one produces a blank frame and no error.

### Fixed

- **An artifact could execute script at the portal's origin.** The image
  preview's click-through opened the blob URL at top level, and the image
  predicate admits `.svg` — a scriptable document. Rendering an SVG in `<img>`
  is safe; navigating to it is not. It now opens the artifact deep link.

- **A rendered page laid out for the wrong width.** Agent-authored HTML
  routinely computes geometry once at load, so widening the pane reflowed the
  CSS grid but left the chart drawn for the old size. The frame now reloads
  once the width settles. Getting there needed the reload to be double-buffered
  — a blank frame paints its background, which was the white flash — and needed
  the comparison to be against the width the current document was rendered at:
  a reload changes the document's height, which toggles the scrollbar, which
  changes the width, which scheduled another reload.

- **The workspace no longer scrolls as one.** `body { overflow: hidden }` does
  not reach the viewport: overflow propagates from the ROOT, and `html` was
  `visible`, so the body clipped its own content while the document scrolled
  underneath. Zoom the browser until the panes hit their minimum widths and
  the whole workspace slid sideways.

- **A sideways swipe no longer navigates back.** A horizontal scroll that
  reaches the end of what it was scrolling is handed to the browser as
  back/forward, which in a single-page workspace discards the session you were
  reading. It bit hardest over a rendered artifact: pages usually fit their
  width, so there was no horizontal scroll to absorb the gesture and *every*
  swipe became navigation. `overscroll-behavior: none` on the root refuses it;
  `contain` on the preview keeps it from reaching the root at all.

- **The rendered artifact no longer flashes white when it reloads.** The
  replacement frame was hidden with `visibility: hidden`, which is laid out but
  may not be PAINTED — so it arrived at promotion undrawn and the frame's white
  background showed for a beat. `opacity: 0` keeps it in the paint tree, and
  promotion waits two animation frames, because `load` means finished loading,
  not finished painting.

- **The artifact reader no longer reassigns your inspector tab.** Opening an
  artifact while watching Sequence switched the tab underneath to Files, so
  `✕` handed back a file list you never opened.

### Removed

- **The `sub-agents` and `durable-timers` system skills**, which nothing has
  ever declared — not in this repo, not in the live fleet, not in the layered
  deployments. A skill only reaches a prompt when an agent names it in
  `skills:` frontmatter; there is no discovery path. Both had drifted from the
  code they described (a 20-agent cap that is 50, single-level nesting that is
  two), and `sub-agents` was additionally wrapped in a fence that stopped its
  own frontmatter parsing, so it listed with an empty description everywhere.
  Their content already lives in the base prompt every session receives.

  The documentation said otherwise — *"omitted skills remain available for
  normal SDK skill discovery"* — which is false and is why seven of the eight
  built-in skills could sit unused while looking load-bearing. Corrected, along
  with the claim that skills merge additively: the registry is keyed by name,
  so a later tier replaces an earlier skill of the same name.

## 0.5.34 — 2026-08-05

The agent picker learns what a package is *made of*, and the session list
learns to say when it is waiting on someone else. Plus a long tail of fixes
from live use, several of which were bugs in mechanisms that already existed to
prevent exactly the problem they caused.

### Added

- **The agent picker is grouped by where an agent comes from.** Three sections
  — Built-in (the deployment's own static agents), Installed · Shared, and
  Installed · Yours — with Generic Session hoisted above all of them, since it
  is not an agent but the absence of one. Everything opens collapsed, so a
  deployment with four packages costs four rows rather than sixteen, and a
  category with nothing in it is omitted rather than shown reading "0".
  `←`/`→` open and close a section on both hosts; the dialog previously named
  those keys in its own hint while nothing listened for them.

- **A package can describe its own composition.** Two additive frontmatter
  fields: `startedBy` names the agents that start this one, which nests it
  under its creator in the picker; `supportsDirectStart` says whether a person
  may start it cold. The defaults are the compatibility contract — no
  `startedBy` means entry point and startable, so every package written before
  these existed renders exactly as it did. `plugin.json` gains `title` for a
  friendly section header, falling back to the DNS-label name. Nothing to
  migrate; opting in costs a version bump, since `name@version` is immutable.

- **A session waiting on its children says so.** A parent that delegates goes
  idle the moment its own turn ends while the children it spawned keep working,
  which the list rendered as dormant. It now reads `waiting on N`. The signal
  cannot be "has children" — sub-agents deliberately stay alive and idle after
  finishing — so only running and input_required descendants count, transitively,
  so a whole delegation chain lights up rather than just its lowest link.

- **Folders can be reordered**, within the structural bands (system → pinned →
  folders → loose sessions) that placement never crosses.

- **A Mobile toggle**, in the theme picker's footer. Steps type and hit targets
  together — 44px targets — because bigger buttons around unchanged 11px labels
  reads as broken rather than as a mobile mode. Persisted to the profile.

- **The session list scrolls past its last row**, so the end of a long list is
  not jammed against the detail box below it.

- **The session-detail box shows `Updated: <time> (<status>)`**, using the same
  timestamp fallback the list sorts by, so the two cannot disagree about when a
  session last moved.

- **Themes**: Commodore 64, Rust and SpongeBob join the set; the picker groups
  themes into sections; `dark-high-contrast` and `workspace-dark-rich` are
  retired along with the rich chat renderer they existed for.

### Fixed

- **A SKILL.md `description` written as a block scalar stored the literal
  `"|"`.** Closes the known issue from 0.5.33. `skills.ts` has its *own*
  frontmatter parser, separate from `agent-loader`'s, and it had no
  block-scalar handling at all — so the indented lines under `description: |`
  were dropped on the floor and the pipe was stored as the value. The
  agent-manager package's skill listed its description as `"|"` in every
  listing, picker and manifest on the live deployment. The real defect is that
  two independent parsers read the same file format and drifted: `agent-loader`
  got this fix in 0.5.32 and `skills.ts` never did.

- **The session-detail box flipped between `idle` and `waiting` on a parked
  turn.** It printed `session.status` raw, opting out of both mechanisms that
  exist to stop this: the 5s debounce (two writers disagree mid-turn — the 4s
  catalog poll carries CMS row state, the post-event sync carries live
  orchestration status) and the cron-aware fold that makes idle and waiting one
  state for a scheduled session. A session firing every 60s flapped on every
  poll. It now shares the list row's derivation.

- **The selected session never came back into view after a reload.** The active
  session id is restored from the profile *before* the listing arrives, so the
  reveal ran once against an empty list and its dependency array deliberately
  excluded the listing — nothing re-ran when the rows landed. Fixed as a
  one-shot reveal per arming, which keeps the exclusion that stops the list
  yanking back while you are deliberately scrolled away.

- **…and fixing that introduced a worse bug, now also fixed.** Waking the
  effect on every list refresh made it move DOM focus ~4×/sec while a session
  streams. The Manage and Copy-link dialogs are local component state rather
  than `ui.modal`, so focus was pulled out of their text inputs mid-keystroke —
  and because the shortcut handler decides "am I editable?" from the event
  target, the rest of what was typed ran as global commands (`d` complete, `D`
  delete). Focus is now taken once per arming, never from a typing target.

- **A folder could never be dragged into a new position.** A folder row carries
  a `groupId` of its own — its id — and the drop-intent resolver fed that
  through the filing branches, so over another folder the gesture read as "file
  this folder into that one" and anywhere else as "take it out of the folder it
  is in". Both fire before reordering is considered.

- **Drag auto-scroll pushed an element that does not scroll.** The scroller was
  resolved from an attribute only present while the pane holds focus, and the
  pane and the list inside it both declare overflow — so it could land on the
  one whose `scrollHeight` equals its `clientHeight`, where `scrollTop +=` is
  silently a no-op.

- **New sessions were filed into whichever folder you happened to be reading.**
  Group inheritance now applies only when the selected row *is* the folder.

- **The Manage-session dialog was cut off on phones**, with its content
  unreachable. It is a separate overlay from `.ps-modal` and never inherited
  that fix; and because it sets `height` rather than `max-height`, a viewport
  clamp alone would not have moved it. The Add-package dialog had the identical
  latent bug.

- **A malformed session parent chain took the UI down** with a `RangeError`:
  the descendant-count recursion had no cycle guard.

### Known Issues

- **Deleting a system session returns 500 rather than a clean 4xx.** Carried
  from 0.5.33. `deleteSession` refuses by design, but the throw surfaces as an
  opaque internal error, and the `protectSystem` session-policy field is
  declared in types and read nowhere.
- **`listSessionsPage` can silently skip a session row** when two sessions
  share the cursor's millisecond at a page boundary. Carried from 0.5.32.

## 0.5.33 — 2026-08-03

A portal fix release. Four bugs, all reported from real use on a live
deployment, all in how the UI *presents* state rather than in the state itself.

### Fixed

- **"New build — reload" latched on forever.** The banner parsed a content hash
  out of the tab's own bundle filename with one regex, and out of `index.html`
  with a different one. They disagree when the hash contains a hyphen AND the
  tail after the LAST hyphen is six or more characters: the self-regex matches
  from the FIRST hyphen, the served-regex backtracks to the LAST. A deployment
  serving `index-B-TEKrRB.js` compared `B-TEKr` against `TEKrRB`, so the tab
  could never find itself among the served bundles and the banner never
  cleared — and reloading could not fix it, because the next load hit the same
  mismatch. Whether a given build tripped it came down to whether its hash
  happened to contain a hyphen, which is why it looked arbitrary. Whole
  filenames are compared now, so there is no hash grammar left to disagree
  about.

- **The session title was unreadable on the DOOM theme.** A pane title renders
  as terminal colour runs carrying an INLINE `style` attribute, which beats a
  plain CSS declaration — so the theme's forced title colour lost and the title
  stayed terminal-cyan on a tan header. `win95` had already hit this and
  carried `!important`; `doom`, `winamp` and `ms-dos` had not.

- **Multi-selecting sessions clipped their icons.** The selection bar was
  emitted as a prefix text run, costing a character cell — but the portal
  already draws selection three ways on the row itself, including a 3px inset
  left rail that IS the bar. Since the row truncates to a fixed width, that
  duplicate cell made selected rows truncate one character earlier than their
  neighbours, clipping the pin, folder or system glyph on any row whose icon
  landed on the boundary. The run is now tagged `role: "selection"` and the
  portal drops it, the same contract `role: "status"` and `role: "depth"`
  already use. The TUI ignores the tag and keeps its bar.

- **Admins could not manage system sessions, and nothing said why.** Two
  separate faults. The client gate was stricter than the server: it excluded
  system sessions for *everybody*, while `evaluateSessionAccess` grants an
  admin every access class and refuses a non-admin with "System sessions are
  managed by administrators." An entitled admin therefore got a dead button
  and no route to the capability. And the button did not look disabled —
  there was no `:disabled` rule for toolbar or mini buttons — while its
  tooltip described the ENABLED behaviour, so pressing it read as a broken
  dialog rather than an unavailable action. Client and server now agree, the
  server remains the enforcement point, and a disabled control dims itself and
  names its actual reason.

### Known Issues

- **A SKILL.md `description` written as a YAML block scalar is stored as the
  literal `"|"`.** Same class as the agent-description bug fixed in 0.5.32, but
  in `skills.ts`'s own frontmatter parser, which has no block-scalar handling
  at all.
- **Deleting a system session returns 500 rather than a clean 4xx.**
  `deleteSession` refuses by design (`if (session.isSystem) throw`), but the
  throw surfaces as an opaque internal error. The `protectSystem` session-policy
  field is declared in types and read nowhere; the hardcoded check is the only
  enforcement.
- **`listSessionsPage` can silently skip a session row** when two sessions share
  the cursor's millisecond at a page boundary. Carried from 0.5.32.

## 0.5.32 — 2026-08-03

### Fixed

- **The Agent Manager could not read any package.** `entriesToMap` looked up
  `path`/`content` through `as any` casts while the tar reader emits
  `name`/`body`, so every entry was skipped and the map came back empty for
  *every* package. File reads reported "not in package" with an empty
  `available` list, and — worse — `diff_agent_versions` returned
  `identical: true` for two versions with different sha256, because a diff of
  two empty maps finds nothing. A silent wrong answer, not an error. The casts
  are gone and both producer shapes are a declared union, so the compiler
  checks them.
- **`CHANGELOG.md` was silently dropped from manifest-mode packages.** Only
  declared paths were staged, so a package that did not list its changelog in
  `include` shipped without it — while `publish_agent_package` *requires* a
  changelog entry. The check passed and the artifact lost the file. It is now
  staged whenever present, and manifest strictness is otherwise unchanged.
- **A pinned session did not survive a restart, and never reached your other
  devices.** Any listing that did not happen to contain the pinned row dropped
  the pin, and because `pinnedIds` feeds the profile-save effect the emptied
  list was written back to the server as the user's preference — a one-way
  ratchet that also propagated the loss to every device. Pins now follow the
  same rule collapse state already used: a row absent from a listing has not
  been unpinned. A row that is present and genuinely no longer pinnable (moved
  into a group, became a child, is a system row) still drops.
- **An admin could list another user's package but not open it.** The database
  has gated on `p_is_admin` all along; only the reference resolver refused, so
  fleet-wide reach stopped at the first read. An owner may now be named by
  subject, email, or display name — resolved by lookup, never by trusting the
  string, and an unmatched name is an error rather than a silent fallback to
  the caller's own copy.
- **An admin repairing someone else's package forked it into their own
  namespace.** Publishing always set the caller as owner, so the real owner
  kept running the broken version with nothing reporting a problem. An edit
  seeded from another owner's package now publishes back to *that* owner.

### Added

- **`create_agent_session`** — the Agent Manager can create TOP-LEVEL sessions.
  §7 of the design specified this test loop but the tool was never built, so
  verifying a published agent meant running it as a sub-agent, with a preamble
  and parent transcript a real user session does not have. Session ids are
  derived from (manager session, agent, key) so a retried turn reuses rather
  than stranding a second root; `test_of` tags a run for sweeper reaping.
- **`message_agent_session`** — drive a session as its user. A verification run
  you cannot talk to only proves the agent boots.
- **`manage_agent_session`** — complete, cancel or delete a session. The
  sub-agent lifecycle tools only ever reached the caller's own children.
- All three are **owner-or-admin**, and lifecycle operations refuse **system
  sessions for every principal, admins included** — checked before the admin
  test, so being an admin is not a way to reach one. The decision is a pure,
  exported, unit-tested function shared with the bridge.

### Changed

- **Manager tools are gated in both halves.** The declarations were already
  restricted to manager agents, but the per-turn handlers were registered for
  every session — a registered handler is a capability even when the model
  cannot see the schema. Both now gate on one shared list.
- **The Agent Manager warns about its own blast radius.** Its splash states, on
  desktop and mobile, that it reaches every session the account can see and can
  cancel and delete them. A new prompt section requires an explicit yes before
  any destructive action, named to the specific target, asked before the call
  and not in the same turn; unattended runs report what they would have done
  rather than doing it. Reads stay unrestricted.

### Known Issues

- **`listSessionsPage` can silently skip a session row.** `updated_at` is
  stored at microsecond precision but the keyset cursor round-trips through a
  JS `Date`, which holds milliseconds, so a row sharing the cursor's
  millisecond matches neither branch of the comparison and drops out of every
  later page. Needs two sessions updated within the same millisecond at a page
  boundary, so it surfaces rarely. Pre-existing; the fix carries the cursor at
  full precision across the SDK, the Web API and the portal.

## 0.5.31 — 2026-08-02

### Security

- **A session could spawn an agent out of another user's private package.**
  Workers install every enabled agent package — user-scope ones included —
  because the install manifest is deliberately unfiltered. The Web API refused
  a foreign user-scope agent at session creation, but `spawn_agent` never went
  through that check: it reached agent resolution directly and matched purely
  on name. Any session could therefore spawn an agent from a package it did not
  own, prompt and all. Agent resolution is now owner-aware, resolved from the
  calling session rather than from the model's argument, and fails closed when
  the caller cannot be identified. The fix threads the caller through the
  orchestration proxy, so the yield sequence is unchanged and no orchestration
  version bump was required.

- **Admin reach in agent tools was inert.** The viewer spine gave inspect tools
  a principal, but `isAdmin` was hard-coded false because a worker holds a
  session owner and never sees a request — cron firings, sub-agent turns, crash
  recovery and replay all run turns with no HTTP request behind them. The
  portal now records the role it authenticated with, and the worker reads that
  observation through a shared predicate. Roles expire rather than persist: an
  observation nothing has re-confirmed within 12 hours stops conferring admin,
  which is the fail-closed direction.

### Added

- **Per-user agent package namespaces.** Package identity is now
  `(scope, owner, name)` instead of a globally unique name, so the first person
  to publish "triager" no longer owns that word for the whole deployment. Your
  own enabled copy shadows the shared one — which is also the recovery path:
  disable a broken personal copy and the shared one takes over with no other
  action. `__shared:<name>` reaches the deployment copy past your own, and the
  `__` prefix is reserved at the database so the sentinel cannot be minted by a
  user.

- **The Agent Manager: an installable agent that reads, edits and ships
  agents.** It diagnoses a misbehaving session, stages an edit seeded from the
  bytes actually running, renders the change as reviewable `.patch` artifacts,
  and publishes a new version once a human approves. It can also author a
  package from scratch. Importing from a URL reaches only origins the
  deployment has allowlisted, so a URL injected into a transcript it is reading
  cannot be fetched at all.

- **Packages carry a `CHANGELOG.md`, and the portal and TUI show it.** It lives
  inside the artifact, so it is versioned, diffable and travels with the
  package. Agent-authored versions sign their entry and name the approver,
  which is how a reader tells an agent edit from a human `agents push`.

### Changed

- `agent-tuner` and `generic-crawler` moved out of the built-in agent sets into
  `agent-packages/` as installable packages. The permanent system children are
  now `sweeper`, `resourcemgr` and `facts-manager`. The bundled crawler stays
  available to `session-policy.json` opt-in, unchanged.

- Retro themes (WinAMP, DOOM, Quake) across desktop, TUI and mobile, each with
  its own brand mark; a single SVG icon family across the three toolbars; and a
  mobile pass covering rail icons, list density and node details.

### Fixed

- **An agent `description` written as a YAML block scalar was thrown away.**
  The loader honoured `|` and `>` only for `splash`, `splashMobile` and
  `initialPrompt`, so `description: |` stored the literal `"|"` and dropped the
  indented text — silently, since the value was still a valid string. The
  Agent Manager was the one package in the repo written that way, so the
  headline feature listed itself as `|` in every picker, agent listing and
  `list_registered_agents` response. Block scalars are now recognised for
  `description` too, and collapse to a single line.
- The new-session dialog blinked off screen before the agent step.
- The filter button looked permanently on, and the tab strip looked pressed.
- The Stats glyph was a cell-signal meter rather than a chart.
- The owner chip appeared even when there was only one owner, and the owner
  tally ignored the active filter.

### Known Issues

- **`listSessionsPage` can silently skip a session row.** `updated_at` is
  stored at microsecond precision but the keyset cursor round-trips through a
  JS `Date`, which holds milliseconds — so a row sharing the cursor's
  millisecond matches neither `updated_at < cursor` nor `updated_at = cursor`
  and drops out of every later page. It needs two sessions updated within the
  same millisecond at a page boundary, so it surfaces rarely. Pre-existing
  (not new in 0.5.31) and tracked for 0.5.32; the fix carries the cursor at
  full precision and touches the SDK, the Web API and the portal together.

### Maintainer Workflow

- Migrations 0042 (sign-in role) and 0043 (package namespaces). 0043 is
  **forward-only**: it drops the five-argument package stored procedures in
  favour of eight-argument ones, so rolling a worker image back after applying
  it breaks package management until the image is rolled forward again.
- Deploy scripts name the Azure subscription explicitly instead of trusting
  ambient `~/.azure` state, and stop recording subscription ids in the repo.

## 0.5.30 — 2026-08-02

### Added

- **Drag to reorder the session list, and it stays that way.** Sessions,
  folders, and the sessions inside a folder can each be dragged into the order
  you want; the placement is a user preference, so it follows you to the TUI
  and the phone (which honour it read-only). New sessions arrive at the END of
  their list rather than jumping to the top — a row you place stays placed,
  which also means activity no longer reorders the list. Dragging near the
  list edge auto-scrolls, and an insertion line shows where the row will land,
  including a line under the last row when dropping at the end. Folders became
  draggable for the first time; the system root and sub-agents deliberately
  cannot move, because a sub-agent's position reflects the shape of the run.
- **Owner avatars.** A monogram disc, coloured per person from a stable hash,
  rendered by one component in both the session list and the agent-package
  tree, so the same person cannot look like two different people in two panes.
  The viewer's own rows take a ring rather than a different colour. The TUI
  keeps its text chip.
- **`client.ops` — the canonical Web API surface**, generated from the
  protocol table. One method per operation, so the client cannot drift from
  what the deployment actually exposes; a contract test fails if it does.
- **`createManagementClient(options)`**, an overloaded factory returning
  honestly-typed clients per mode, and `SharedManagementSurface` for code that
  may hold either.
- **`pilotswarm agents` now covers every package operation**: `enable`,
  `disable`, `tree` and `cat` join push/list/show/pin/promote/demote/rm.
- **`editorial-desk` example package** — four editor agents, a skill, seven
  worker tools and a hand-rolled MCP server, offline and credential-free.

### Changed

- **The `agents` CLI talks to the Web API by default.** It previously required
  `DATABASE_URL` and actively refused `--api-url`, so the surface an operator
  reaches for first was also the one that bypassed authentication and
  authorization. `--store` remains as break-glass and announces itself.
- **Expansion state and the last selected session are restored on reload**,
  across devices, with the system root as the fallback when a stored selection
  no longer exists.
- Owner initials are uppercase and derived from a person's name.

### Fixed

- **Agent-package owners showed the wrong initials** — the email alias rendered
  as "DA" where the same person's sessions correctly showed "AD" for "Affan
  Dar". Packages stored only an opaque directory principal; the human identity
  was always in the `users` table, which the session view has joined all
  along. Migration **0041** adds that join to the package procs, so both
  resolve the same person the same way for every existing row — no new
  columns, no backfill.
- **Three artifact operations were unreachable over the Web API.**
  `readArtifactBase64`, `copyArtifact` and `setArtifactPinned` were dispatched
  server-side and access-classified but absent from the operations table, so
  every client call threw "Unknown API operation". The MCP artifact
  read-base64, copy and pin actions had been dead in web mode since they
  shipped.
- **Collapse state ratcheted shut.** Each page load force-collapsed rows the
  listing had not delivered yet and saved that back, so one reload looked fine
  and the next collapsed everything. Defaults now apply only against a real
  previous listing.
- **A restored selection was destroyed by the reload meant to restore it** —
  the folder listing lands first, so the stored session looked "not visible"
  and was replaced by the default, which was then persisted over it.
- The profile poll adopted unsaved local state as already-persisted, so
  changes could take effect on screen and never be written.
- The web management client was 30 methods behind the direct client,
  including `grantSessionShare`, `setSessionVisibility` and `getSessionAccess`
  — the authorization primitives, previously reachable only from the client
  with no authentication.
- `packages/app/web/runtime.js` carried raw control bytes in string literals,
  which made `file` classify the whole module as binary and caused grep and
  ripgrep to silently return nothing for the portal's dispatch core.

### Maintainer Workflow

- Docker image builds accept an `NPM_REGISTRY` build arg (worker and portal),
  for networks blocked from the public npm registry. Note the mirror holds new
  versions for ~7 days, so a same-week dependency can still fail a cold build;
  `az acr build` is the escape hatch.
- Getting Started documents installing the CLI standalone, including the
  tarball fallback when npm is blocked; the agent-package guide gains a
  lifecycle section for managing a published package.

## 0.5.29 — 2026-07-28

### Changed

- **Copilot runtime upgraded: `@github/copilot` 1.0.70 → 1.0.73,
  `@github/copilot-sdk` 1.0.6 → 1.0.7.** The new SDK introduces tool search:
  past a threshold (default 30 tools), external tools are deferred out of the
  prompt behind a `tool_search_tool` the model must think to call. PilotSwarm
  sessions declare 40+ tools, so every tool is now pinned `defer: "never"` at
  the single point where declarations reach the CLI — a deferred workflow tool
  (spawn_agent, store_fact, complete_agent) would be a silent no-op until the
  model suspected it existed. An explicit `defer` on a tool definition is
  respected, so individual long-tail tools can opt back in later without
  touching the chokepoint.
- The CLI's built-in toolset gained `write_agent` between 1.0.70 and 1.0.73;
  the always-on toolset contract acknowledges it.

### Portal performance

- **Dragging a splitter no longer spends its frames building Intl date
  formatters.** `toLocaleTimeString` constructs a fresh `Intl.DateTimeFormat`
  on every call, and every session row and event line re-derives its timestamp
  on every render — profiled at 91.8% of a resize drag's self time on a fleet
  of 88 sessions. Four cached formatters replace the per-call path (311.8ms →
  4.2ms for the profiled workload), and same-day rows no longer format an
  hh:mm string only to throw it away.

### Fixed

- **Deleting an already-terminal session no longer orphans its subtree.** The
  descendant cascade lived only in the delete handler of a session's running
  orchestration, so deleting a finished session — the reaper's normal case —
  was a single-row soft delete that left every descendant unreachable (the
  descendant walk skips deleted rows at every level). Both client entry points
  now cascade explicitly, enumerating descendants before the target is
  deleted.

## 0.5.28 — 2026-07-28

### Portal performance

- **Resizing a pane no longer re-derives the transcript.** A rich message block
  carries raw markdown and the browser wraps it, so its content cannot depend on
  the pane width — yet every width step rebuilt the whole loaded transcript,
  because the selector is shared with the TUI where a column count genuinely
  does determine wrapping. Blocks are now cached on the message and returned by
  identity: 4.2ms → 0.2ms per width step at 6000 messages.
- **A resize no longer re-parses markdown for the whole transcript.** With block
  identity stable, the renderer memoizes each message, so a width change
  reconciles the container and skips the bodies. A 20-step splitter drag at 6x
  CPU throttle went from ~1250ms to ~985ms.
- **Scrolling no longer wraps the entire transcript to count its lines.**
  selectChatLines ran from every scroll action, usually only to answer "how many
  lines are there" for the scroll math: 1.6ms at 300 messages and 5.1ms at 1500,
  per scroll. Now 0.00ms when only the scroll position moved.
- **Thinking and system cards are no longer rebuilt on every poll.** These are
  genuinely width-dependent, so they still re-wrap on a resize, but a poll at an
  unchanged width now reuses them: 1.17ms → 0.30ms at 1500 messages with 10%
  cards, 5.26ms → 0.14ms at 50%.
- **Moving through the session list no longer costs a network round trip per
  keypress**, and rows are no longer rebuilt wholesale on every move (0.59ms vs
  5.16ms of work per move at 200 sessions; 61 API calls → 3 over 30 moves).

### Fixed

- **Older transcript history is reachable again on long sessions.** Scrolling to
  the top gated on a comparison between a DOM-derived offset and the TERMINAL
  wrapped-line count, which the rich renderer does not use. A session of long
  messages inflates that count far past the rich DOM's scroll extent, so the
  gate could never open — while a session of short messages worked. Both callers
  already fire only when the scroller is at the top, so the gate is gone.
- **The portal can load history past the automatic cap.** Beyond
  AUTO_HISTORY_EVENT_SOFT_CAP the transcript told the user to press `e`, a key
  bound only in the TUI, leaving older history unreachable in a browser. There
  is now a control.
- **The root system session shows the deployment's branding name.** The portal
  built a synthetic state that omitted branding, so the row fell back to
  "PilotSwarm" while other callers produced the branded name — and once rows
  were memoized on a shared key the two alternated.
- **Re-opening a session no longer re-fetches everything paged back through.**
  The loaded-history window is sticky by design but was re-requested on every
  switch-in; re-entry is now bounded to five pages.

### Added

- **Selected-session details at the foot of the Sessions panel** — title, id,
  model, context window, cron, agent, status, children, access — with a fixed
  height so scrolling the list cannot shift it, leaving rows one line each.

## 0.5.27 — 2026-07-28

### Portal performance

- **Resizing a pane no longer re-lays-out the whole transcript.** The chat
  transcript is not virtualised, so every loaded block re-wrapped on every
  frame of a splitter drag — a cost linear in DOM size (~1.55ms per 1000
  nodes), which on a long session turned resizing into a slideshow. Blocks now
  opt out of offscreen layout: measured 49.6ms → 2.9ms per re-layout at 30k
  nodes, 86.9ms → 8.2ms at 60k, 6.2ms → 0.6ms at a normal window.
- **Re-opening a session no longer re-fetches everything you had paged back
  through.** The loaded-history window is sticky by design, but it was also
  re-requested on every switch-in, so one trip through a busy session's history
  made it permanently expensive to open (10k events re-fetched, re-derived and
  re-laid-out each time). Paging back still expands freely; re-entry is bounded
  to five pages.
- **Moving through the session list is no longer a network round trip per
  keypress.** Selecting a session force-refetched its history, synced detail,
  re-attached the event stream and re-probed access — so scrolling a list fired
  two API calls per row, and on a remote deployment the highlight ran behind
  the cursor. The highlight is local state and now moves immediately; fetching
  waits for the selection to settle. A click still loads at once. Measured over
  30 moves: 61 API calls → 3.
- **The session list no longer rebuilds every row on every keypress.** Rows are
  memoized against the inputs they derive from, so moving the selection touches
  the two rows that changed: 5.16ms → 0.59ms of work per move at 200 sessions.

### Added

- **Selected-session details live at the foot of the Sessions panel.** Session
  rows are one clean line each; id, model, context window, cron, agent, status,
  children and access moved into a box with a fixed height, so scrolling the
  list cannot shift it. Mobile and the TUI are unchanged.
- **CSV and TSV artifacts render as a table.** Parsing is delegated to Papa
  Parse, so quoted commas, embedded newlines and escaped quotes survive; rows
  wider than the header keep their extra cells rather than silently losing
  them. Ctrl/Cmd+A selects the table rather than the page, dragging selects
  whole cells, and copying emits real TSV that pastes into a spreadsheet.

### Fixed

- **Windows 95 panel titles are readable on the title bar.** Titles are runs
  with inline palette colours, which beat class rules — the same defect as the
  selection bar, and it needs the same remedy.

## 0.5.26 — 2026-07-27

### Fixed

- **Pane header controls no longer wrap out of the header.** The header
  declares a fixed height, so a wrapped row escapes the box and lands on top of
  the pane content below — a narrow session pane dropped its refresh button
  onto the session list. Headers are now nowrap with a shrinkable title, which
  is the right trade: the buttons are the only route to those actions, whereas
  the title is duplicated on the selected session row and already ellipsizes.
  Narrow panes also tighten icon padding so five buttons and a title fit one
  row.

Released immediately after 0.5.25, which is otherwise identical: npm packages
are immutable once published, so a fix that lands after a tag needs its own
version rather than a re-cut.

## 0.5.25 — 2026-07-27

### Portal performance

- **Scroll and pane resize no longer dispatch on every input event.** Both
  `pointermove` and `scroll` fire far more often than the browser paints, and
  each dispatch notified every subscriber and re-rendered the transcript — so
  most of that work was discarded before it was ever displayed, and the larger
  the session the worse it got. Both paths now apply at most one dispatch per
  animation frame; the end state is identical, since the last value in a frame
  is the one actually seen.
- **Transcript lines are memoized.** Render cost is proportional to transcript
  length, so it must not repeat for state that does not change the lines —
  scroll offset and pane split both notify every subscriber.

### Desktop layout

- **The terminal chat view now matches the rich view on desktop**: the toolbar
  is centred in the portal header (reclaiming its own strip), panes rise to
  just under the header, and the duplicate chat pane title bar is gone — the
  session title, id, model and context are already on the selected session row.
  Mobile and the TUI are unchanged.
- **Pane headers are a fixed height**, so panes with action buttons no longer
  render a taller header than panes without and start their bodies at
  different heights. Long titles ellipsize rather than clipping against a
  fixed row.
- **Default type scale drops one step** (chat 13.5px), and the header toolbar
  no longer pushes the identity block onto a second row.

### Themes

- **Windows 95 contrast fixes**: code blocks and inline pills get their own
  inset white well — `.ps-md-code-pre` carries no background of its own, so
  under Win95 it was showing the desktop teal behind dark CGA syntax tokens.
  The attach and stop buttons get the raised bevel every other control has,
  and title-bar metadata takes title-bar white.
- Selection reverse-video now overrides inline run colours, which previously
  left the selected row's id, model and context unreadable.

### Testing and tooling

- **Playwright layout and theme gate.** Cascade and layout outcomes are
  invisible to reducer/selector tests and to jsdom, which has no layout
  engine. 14 hermetic tests — dist served against a stubbed API, no database,
  worker or LLM — assert that all pane headers share a height, no control
  overflows its header, the page never scrolls sideways, and, across five
  themes, that themed controls receive their theme and body text clears 4.5:1
  against its real computed surface.
- **`run-tests.sh` requires `max_connections >= 1500`.** Below that the
  parallel suite exhausts the pool and reports "sorry, too many clients
  already" in whichever tests happen to be running — which reads as product
  flakiness and passes on isolated re-runs. Measured peak on a full run is 364
  against pools that arithmetically imply 80.
- **`portal-stop.sh` sweeps the port unconditionally.** It previously did so
  only when the PID file was absent, so an instance started another way stayed
  bound; `portal-start.sh` then probed that survivor and reported "ready" for a
  server it had not started, silently serving a stale build. Start now requires
  the port to be held by the process it launched.
- **A server-render smoke test** runs every inspector tab, chat view and the
  full-screen preview, catching render-time crashes that unit tests cannot see.

## 0.5.24 — 2026-07-27

### Session regeneration — correctness

The regen pipeline shipped in 0.5.22 had defects that only surfaced on real
transcripts. All were found by adversarial review and are covered by
regression tests that were each verified to fail without their fix.

- **Oversized archives no longer abort regeneration.** A 1.8 MB transcript hit
  the 1 MiB text-artifact ceiling and threw `ARTIFACT_TOO_LARGE` at the
  `requested` stage — before the distiller, and before the deterministic
  fallback that needs no archive at all. Archives are now written as chunks
  under the cap, split only on line boundaries.
- **Transcript selection keeps user turns and the newest messages.** Two
  separate bugs: a comparator that subtracted `+Infinity` scores produced
  `NaN`, which sort treats as "equal", silently dropping the END of a
  user-dense conversation; and a head/tail split applied before reservation
  let zero-score filler outrank user messages. Selection now reserves in
  priority tiers — anchors, then users, then salience — before any positional
  split.
- **The distiller reads the archive's record shape.** It read `eventType`
  while the archive writes `type`, so every archived message was classified
  `system`, erasing the user/assistant structure selection exists to preserve.
- **An empty transcript produces a real artifact** instead of an id naming an
  artifact that was never uploaded.
- **The deterministic package carries the session's opening** — the first ten
  messages, bounded — not just the first user message. A mission is rarely
  stated in one turn.
- **Regeneration failures are surfaced inline** in the transcript with their
  stage and error, instead of appearing to do nothing.
- **Operators choose the distiller model, reasoning effort and context tier.**
- **Compaction starts with no observed completion are reported as `unknown`,
  not failed** — the previous derivation turned a metric artifact into a false
  alarm.

### Portal

- **Artifacts open in place.** References in the transcript are clickable and
  reveal the artifact with its preview loaded, rather than only offering a
  download. Previews are type-aware: images (including SVG, via an
  authenticated object URL so untrusted markup cannot execute), syntax-
  highlighted source, real diff rendering, and markdown with frontmatter
  stripped.
- **Artifact multiselect with bulk delete**, and a preview that detaches into
  its own resizable pane on desktop.
- **A full-viewport artifact viewer on mobile**, with a close button, previous
  and next controls, and a wrap toggle for code. Navigation follows the
  conversation order when opened from a chat link and the list order when
  opened from the list.
- **One type scale.** Sixty hardcoded pixel sizes ignored the base variable, so
  the chat sat at 14.5px while the rest of the UI was pinned at 9–12px. All are
  now relative to a single root.
- **Light themes get a canvas distinct from their surfaces.** Page, panes and
  modals were all `#ffffff`, so nothing had a visible edge; elevation is now
  derived from the palette and works in both polarities.
- **Pane headers are a fixed height.** They were sized by their contents, so a
  pane with action buttons rendered a taller header than one without and
  side-by-side panes started their bodies at different heights.

### Themes

- **Windows 95** and **MS-DOS 2.0**, both with authentic palettes — CGA's
  light-grey default attribute, the brown that dark yellow rendered as, the
  `#c0c0c0` button face and navy title bars. Themes can now carry chrome as
  well as colour: Win95 adds 3D bevels and buttons that press in, MS-DOS strips
  every gradient and rounded corner and uses reverse video. Both are available
  in the TUI (palette) and the portal (palette plus chrome).

### Testing

- **A render smoke test.** The UI suite exercised reducers and selectors only,
  so a crash in a component's render body could reach production untouched —
  which is how a temporal-dead-zone error blanked the Artifacts tab past a full
  green suite. Server rendering now runs every inspector tab, chat view and the
  full-screen preview.
- **Transcript selection is tested by an LLM judge with mutation controls** —
  deliberately broken selections the same judge must reject, so a judge that
  passed everything could not be mistaken for a passing algorithm.
- **`run-tests.sh` parses env files as data**, not as shell. A connection string
  containing `&` was read as a command separator, so the variable never reached
  the environment and the HorizonDB phase ran without a graph store.

## 0.5.23 — 2026-07-25

### Rich portal UI — a desktop-style chat view

- **New `rich` chat view (toolbar `Aa`), alongside the existing terminal
  transcript.** Assistant replies render as proportional-type markdown —
  headings, lists, quotes, tables, fenced code — and user turns as
  right-aligned bubbles, instead of hard-wrapped terminal lines. The terminal
  view is unchanged and remains the default; the TUI is untouched.
- **Fenced code is syntax highlighted** (js/ts, python, shell, sql, json,
  rust, go, yaml, css) by a dependency-free tokenizer whose token colors
  resolve through the active theme, so highlighting follows theme switches.
  Applies to both chat views and artifact previews.
- **```mermaid blocks render as diagrams.** mermaid is imported dynamically,
  so it splits into its own chunk fetched only when a transcript contains
  one; a diagram that fails to parse keeps its source and states why.
- **The rest of the portal chrome follows the rich view**: session rows
  become desktop list items (status dot, indentation guides, owner/child
  chips, a stable metadata line), the header and workspace toolbar merge into
  a single top bar, panels lose their per-pane accent borders, resizers slim
  to 7px, and the chat becomes a free-flowing surface with no title bar or
  frame. Speaker labels and timestamps give way to hover-revealed metadata,
  and consecutive turns from one speaker merge into continuous prose.
- **Fix (both views): owner initials chips no longer appear in single-owner
  deployments.** `shouldDecorateSessionOwners` treated any narrowed owner
  filter as a multi-user context, but the default signed-in filter already
  sets `all: false` and `includeShared: true`, so every row got a chip. This
  fixes the TUI as well.

No orchestration change — new sessions still use `1.0.68`.

## 0.5.22 — 2026-07-25

### Release pipeline — installable GitHub Release tarballs

- **Every release now attaches its npm-pack tarballs as GitHub Release assets.**
  The publish workflow packs `pilotswarm-sdk`, `pilotswarm-horizon-store`, and
  `pilotswarm` (byte-identical to the registry artifacts, same `prepack` hooks)
  and uploads them to the triggering release, so the packages can be installed
  straight from `…/releases/download/v<X>/<pkg>-<X>.tgz` on networks where the
  public npm registry isn't reachable (or that must wait out a mirror's
  quarantine window). Purely additive: the npm publish jobs are unchanged and
  public-registry consumers are unaffected. No functional changes to the
  packages; new sessions still use orchestration `1.0.68`.

## 0.5.21 — 2026-07-24

### Session regeneration — epoch rebirth (new sessions use orchestration `1.0.68`)

- **Regenerate a session in place.** A long-running session's transcript can be
  archived, distilled into a compact resume package, and its underlying Copilot
  session rebuilt fresh — same session id; facts, artifacts, sub-agents,
  sharing, schedule, and chat history are untouched. Reachable as the
  `regenerate_context` (self) and `regenerate_agent` (parent → child) in-session
  tools, the `regenerate_session` MCP tool, and the management API. The
  transcript flips to a new **epoch**; storage is epoch-scoped (epoch 0 is the
  legacy layout, zero migration). Two-event contract: `session.epoch_committed`
  (the flip) then `session.regenerated` (proven after the grounding turn).
- **The distiller is a first-class service session.** LLM distillation (the
  default) spawns a real, orchestration-modeled **service session** — a new
  tree-scoped session class (`service_kind`/`service_of`, migration 0037) — under
  the tree root, titled `Regen Distiller — <id> eN→eN+1`. It reads the WHOLE
  archived transcript map-reduce style via a purpose-built, self-gating
  `read_transcript_page` tool, emits the resume package, and self-completes so
  the sweeper reclaims it in the normal flow. It is read-only in the UI (⚗ icon,
  no prompt) and carries only that one tool. Per-regen `distill_mode`
  (`llm` default / fast `deterministic`), optional distilling `instructions`,
  and a model policy of per-call override → cluster default → fallback →
  deterministic (which never blocks the regen). Distiller input/output are dumped
  as attempt-scoped artifacts. Deployment kill switch:
  `PILOTSWARM_REGEN_DETERMINISTIC_ONLY`.
- **Footprint sensor.** `context_health` (available to every session) reports the
  current epoch, turns-this-epoch, context utilization, compaction depth,
  transcript/event sizes, and an ok/elevated/degraded assessment — so an agent
  can decide when to regenerate. Surfaced on `get_session_detail` and in the
  portal Stats panel (Epoch / Regens / Last Regen).
- **UX.** The session **Terminate** control is now **Lifecycle** (new
  circular-arrows glyph) with a Regenerate option; refused regens surface inline
  in the transcript (yellow notice) and an epoch divider marks each flip
  (magenta); a live `↻ regen:<stage>` chip shows while the pipeline runs. Shared
  ui-core, so the TUI inherits the readouts (Shift+R triggers regenerate).
- **Operator force** bypasses the soft rate limits (6h cooldown / min-age); hard
  gates (system/service session, regen in flight, shutting down, unproven flip)
  always hold.

### Models

- **Claude Opus 5.0** added to the GitHub Copilot catalog (full reasoning ladder,
  both context tiers: default 200K / long-context 936K).

### Hardening

- Adversarial pass on the regen machinery: distiller sessions are cancelled on
  every teardown path (no idle-orphan leak), untrusted distiller inputs are
  nonce-fenced against prompt-injection breakout, the spawn re-seeds on a
  crash-before-send retry, and collect tolerates a distiller that narrates after
  emitting the package.

## 0.5.20 — 2026-07-22

### SDK / Orchestration (new sessions use `1.0.66`)

- **Parents wake when children go quiet.** A spawned child that finished its
  task by simply answering (idle, no `complete_session`) was invisible: the
  `wait_for_agents` fallback poll had no mapping for `idle`, so a waiting
  parent polled a finished child forever, and the child's completion notify
  could be suppressed by its wake contract. Now: waits resolve when every
  waited child is *settled* (terminal, idle, or blocked on input) with a
  followup describing quiet/blocked children; spawns carry an `expectsReport`
  ledger and a first report delivers the child digest immediately once all
  agents settle; a child's first completion always notifies its parent
  regardless of contract.
- **`wait_for_agents` publishes `waiting` (with a reason) instead of
  `running`**, so the portal shows "waiting for N agent(s)" rather than an
  indefinite "Working…" spinner while parked on an agent wait.
- Frozen `1.0.65` handler hardcodes its own version (freeze convention;
  guards in-flight upgrade + replay behavior), with a lineage test pinning
  the rule for future freezes.

### Portal

- **Redelivered messages collapse to one bubble** marked with an amber `✓✓↻`
  and stamped with the latest delivery time. `clientMessageIds` are
  authoritative for equivalence: a duroxide activity retry re-records the
  same queue message and collapses regardless of retry latency, while a
  deliberate identical re-send stays two bubbles.
- **Day-aware chat timestamps** — same-day messages show time only; older
  messages carry their date (and year when it differs).
- **Deleted sessions are evicted on terminal 404** instead of being polled
  forever: panes unbind, the active-session latch clears, and the console
  404 stream stops. Local deletes evict proactively.

### Tests

- Temp-dir cleanup in the kill/fault-injection suites retries removal while
  a killed worker finishes flushing files (ENOTEMPTY race).

## 0.5.19 — 2026-07-22

### SDK

- **Vision gate now runs on the session's own Copilot client.** The image-attachment
  vision check (`getModelVisionInfo`) used to consult the worker-default-token
  CopilotClient; deployments whose sessions run on per-user/system GitHub Copilot
  keys (where the default `GITHUB_TOKEN` may be an unset sentinel) reported "no
  vision" even though the turn's own token could see images. The gate now resolves
  the model catalog on the same client/token that serves the session's turns, with
  per-token catalog caches so one identity's entitlements never bleed onto
  another's sessions.

### Maintainer Workflow

- **Deploys never reset data.** The DB reset step was removed from
  `scripts/deploy-aks.sh` (it previously wiped the database by default). Resets now
  live only in the new `scripts/reset-db-aks.sh`, which must be invoked explicitly
  with `--i-understand-this-deletes-all-data`. Deploy/reset skills, deployer
  agents, and the builder-agent templates document the rule: NO RESETS unless the
  user explicitly asks for a wipe.

## 0.5.18 — 2026-07-21

### Model-visible image attachments across every surface

Operators can now show images to the model: paste (Ctrl/Cmd+V), drag-drop,
or pick images in the portal composer — desktop and mobile — attach from the
TUI with Ctrl+V (OS clipboard) or Ctrl+A (file path), or send attachment refs
through the Web API, SDK, and MCP server. Images persist as session binary
artifacts (upload-first, reference-after); vision-capable models receive them
as true multimodal blob attachments with per-model capability gating. New
sessions use orchestration `1.0.65`.

### SDK

- `sendMessage`/`send` accept `attachments: [{filename}]` refs, validated at
  the API edge against the session's artifact store (png/jpeg/gif/webp, 4 MB
  per image, 4 images / 8 MB per message) and carried on the durable queue as
  resolved refs — bytes never enter orchestration history.
- Orchestration `1.0.65` threads attachment refs through drain, merge, and
  continue-as-new (`1.0.64` frozen); the runTurn activity fetches bytes from
  the artifact store, gates on the live model catalog's vision capability
  (`SessionManager.getModelVisionInfo`), and forwards blob attachments to the
  Copilot session. Drops are explicit: prompt omission notes plus
  `runtime.attachment_dropped` events.
- Attachment refs ride the `user.message` event for transcript rendering.

### Portal

- Composer image intake: clipboard paste, drag-drop (with drop highlight),
  and a paperclip picker (`accept=image/*` offers camera/photo library on
  phones); staged images render as thumbnail chips with size and remove.
- Transcript user messages render authenticated thumbnail strips; the Files
  pane previews raster image artifacts inline.
- Stale-status guard now trusts the server's monotonic `statusVersion`,
  fixing sessions wedged on "Working.." after turn completion.
- Artifact/attachment validation errors return actionable 4xx codes
  (`ARTIFACT_CONTENT_TYPE_MISMATCH`, `ARTIFACT_TOO_LARGE`,
  `INVALID_ATTACHMENT`) instead of generic 500s.
- Ingress body limit raised to 8 MB for image uploads (deploy manifest).

### TUI

- Ctrl+V pastes an image from the OS clipboard (pngpaste/osascript on macOS,
  wl-paste/xclip on Linux, PowerShell on Windows) and stages it on the next
  message; Ctrl+A path uploads auto-stage raster images the same way.

### MCP

- `send_message` and `send_and_wait` accept `attachments` (web mode);
  `get_capabilities` reports `prompt.imageAttachments`.

### Worker

- Turn timeout is deployment-configurable.

### Docs

- `docs/proposals/image-attachments-in-chat.md` rewritten to match the
  shipped architecture; new draft proposal
  `docs/proposals/durable-signals-and-webhooks.md` (`wait_for_signal`).

## 0.5.17 — 2026-07-20

### Reliable finite delegation and cleaner shared UI rendering

This release fixes finite child-result wake-ups, keeps child contracts intact
through durable session creation, and improves Markdown/chat layout in the
shared portal and terminal UI. New sessions use orchestration `1.0.64`.

### SDK

- **Finite delegated work wakes on substantive results.** The framework base
  prompt, sub-agent skill, and `spawn_agent` schema now require
  `wakeOn: "material_change"` when a parent needs a finite child's result. An
  ordinary final reply leaves the child alive and idle; after validating its
  outputs, the parent closes it explicitly with `complete_agent`.
- **Child contracts survive durable creation.** `childContract` now propagates
  through child creation, client session configuration, and the durable
  orchestration input, keeping child-side and parent-side wake policy aligned.
- `wakeOn: "completion"` is documented as an actual terminal lifecycle policy
  for explicit completion, cancellation, failure, or blocked verdicts rather
  than a synonym for a child's final assistant reply.

### Portal / TUI

- Chat cards can use the full pane width instead of retaining an unnecessary
  narrow maximum width in the portal.
- Markdown tables accept GFM short-form delimiter rows such as `|-|-|`, with
  regression coverage for compact and aligned table forms.

### Docs / Templates

- Agent contracts, SDK guidance, builder documentation, and CLI/SDK builder
  skills now teach the finite-result versus terminal-lifecycle distinction.
- The framework base agent advances from `1.7.0` to `1.8.0`; the tuning log
  records the model-independent contract correction and validation evidence.

### Tests

- Added regressions for the exact Waldemort finite-child completion payload at
  classifier and parent batching boundaries, including proof that
  `material_change` wakes the parent without a suppression event.
- Added durable-input coverage proving `childContract` reaches the child
  orchestration, plus static prompt/tool contract assertions.

## 0.5.16 — 2026-07-18

### Durable message deduplication and retry isolation

This release hardens durable message delivery, parent/child coordination, and
model configuration while preserving replay compatibility through frozen
orchestration versions `1.0.61` and `1.0.62`; new sessions use `1.0.63`.

### SDK

- **Client message ids are deduplicated durably.** Orchestrations retain a
  bounded 20-id LRU so repeated delivery of the same `clientMessageId` cannot
  enqueue duplicate user turns, including across replay and worker handoff.
- **Attempted outbox envelopes are immutable.** Retrying an earlier failed
  prompt cannot merge its acknowledgement ids into a newer queued prompt;
  retries and fresh sends resolve independently.
- **Model configuration metadata is complete.** Reasoning effort and context
  tier flow through session metadata, management views, child creation, and
  starter model-provider configuration.
- **Reactive parent/child prompts are more explicit.** Parent sessions receive
  hardened guidance for child completion, waiting, and follow-up work without
  leaking stale turn content.

### Portal / TUI

- Queued-message reconciliation now isolates each attempted outbox envelope,
  so acknowledgements clear only the matching local prompt after retries.
- Session selectors expose the expanded model metadata consistently across the
  shared terminal and portal UI core.

### Docs / Templates

- Agent contracts, builder guidance, CLI/SDK builder skills, and the maintained
  TUI skill document the new message-id, model-metadata, and parent/child
  behavior.
- Added an anonymized duplicate-client-message retry bug report capturing the
  failure mode and regression contract.

### Tests

- Added regressions for duplicate ids, immutable retry envelopes, session
  refresh reconciliation, starter model configuration, system cron/restart
  behavior, context tiers, snapshot lineage, and wait-content isolation.
- Full-load helpers now wait on status-change events instead of timing sleeps;
  the unsupported mixed PRE/WAIT/POST single-turn scenario is represented as a
  supported two-turn sequence without reducing concurrency or weakening
  assertions.

## 0.5.15 — 2026-07-16

### Session groups become private per-user organization; reliable deep links

Session groups stop being a shared property of a session and become each
user's **private organization** of the sessions they can see — sharing a
session never reveals the owner's grouping, and recipients organize shared
sessions into their own groups. Design:
`docs/proposals/private-session-groups-and-deep-links.md`.

> **Note for API consumers — wire-contract change.** Session DTOs
> (`listSessions`, `getSession`, paged management listings, `getSessionAccess`)
> now emit **`viewerGroupId`** — the caller's own placement of the session's
> tree root — and the former `groupId` field is **gone**. Clients that read
> `groupId` from session views must switch. Requires **migration 0034**
> (`user_session_group_placements`), which backfills legacy root assignments
> as owner placements; `sessions.group_id` is no longer read or written.

### SDK

- **Migration 0034 — `user_session_group_placements`.** Group membership is a
  `(viewer, tree-root) → group` placement owned by the viewer, with a composite
  FK into `session_group_owners` that makes cross-user placement structurally
  impossible. Legacy grouped roots backfill as their owner's placements;
  ownerless legacy groups adopt an owner only when all live member roots agree,
  otherwise they are quarantined to the unscoped audit listing.
- **New operation `placeSessionsInGroup`**
  (`POST /management/session-groups/place`): place session trees into one of
  the caller's groups (`groupId` null = ungroup). Requires only **read** access
  to each session and changes no shared session data. Returns one row per
  resolved tree root: `{ rootSessionId, placed, reason }` with `reason`
  `not_found` (unknown and unreadable are deliberately identical) or `system`.
  A missing or foreign target group fails with a single `403`
  ("Session group not found or not owned by you.").
- **Deprecations:** `moveSessionsToGroup` and `assignSessionsToGroup` are now
  deprecated aliases of `placeSessionsInGroup` (same behavior and result
  shape); `cancelSessionGroup` and `completeSessionGroup` are deprecated.
- **`listSessionGroups` is viewer-scoped for every caller — admins included:**
  only the caller's own groups are returned, with counts computed from the
  caller's own readable placements. `deleteSessionGroup` clears the owner's
  placements and never touches sessions, so non-empty groups delete cleanly.
- `createSession`'s `groupId` is an initial placement into one of the caller's
  groups (`403` otherwise); groups are owned by their authenticated creator and
  ownership is never inferred from member sessions.

### Portal / TUI

- **"Shared with me"** bucket in the session owner filter — sessions other
  users have shared with you.
- The move-to-group picker offers all of *your* groups for any readable
  non-system selection; mixed-owner selections are allowed, and per-root
  placement skips (`system`, `not found`) are summarized in the status bar.
- **Share / Copy-link split:** a dedicated **Copy link** toolbar button, and
  the former "Modify" modal is now **Share & settings** (rename, copy link,
  visibility, per-person grants). Copying a link to a private session with no
  grants warns "Only people with access can open this link." — a link is a
  locator, not a grant.
- **Reliable `?session=` deep links.** A deep link latches selection until it
  resolves — no more silent fallback to another session. Unknown and
  inaccessible ids show the same explicit "not found or has not been shared
  with you" error (no existence oracle); network failures show a retryable
  error; a linked session outside your current filters is shown anyway with a
  notice; the link survives redirect-based sign-in.

### MCP

- `manage_session_group` gains the **`place`** action (per-root results;
  `assign`/`move` are deprecated aliases, `cancel`/`complete` deprecated;
  `delete` clears only your grouping).
- `list_sessions` projects the caller's placement as `viewer_group_id`
  (`list_session_groups`' `include_sessions` membership derives from it);
  `get_capabilities` reports `viewerScopedGroups: true`.

### Tests

- New coverage for the 0034 placement migration and backfill, placement
  authorization (read-suffices, foreign-group 403, system/not-found rows),
  viewer-scoped group catalogs, the "Shared with me" filter, deep-link intent
  latching and error states, and a group-leak regression over session events.

### Fixes

- **`pilotswarm-horizon-store`: AGE graph bootstrap works on upgraded Azure
  HorizonDB (AGE 1.7.x).** Newer AGE builds resolve the `graphid_ops` index
  opclass through the caller's `search_path` inside `create_graph()`, so the
  `0003_age_bootstrap` migration now pins
  `SET LOCAL search_path = ag_catalog, "$user", public` for its transaction.
  Without this, graph-store initialization fails with
  `operator class "graphid_ops" does not exist for access method "btree"`.

## 0.5.14 — 2026-07-15

### Security model — per-user ownership, visibility, and sharing

A multi-user access model for deployments where more than one person shares a
fleet. Design: `docs/proposals/user-admin-security-model.md`. Dark-launch by
default (`AUTHZ_ENFORCE_OWNERSHIP=false`) — classification and audit run, but
nothing is blocked until an operator flips enforcement on.

- **Ownership is now an enforcement boundary, not just a label.** Sessions have
  a tree-root `visibility` (`private` | `shared_read` | `shared_write`) plus
  targeted per-user `session_shares` (read/write). Access resolves at the
  session-tree root, so sharing a session shares its sub-agent tree. Users see
  and act only on sessions they own or that are shared with them; admins retain
  fleet-wide visibility, with break-glass reads of private sessions recorded in
  a new `authz_audit` trail. Migration 0029 adds `sessions.visibility` /
  `sessions.root_session_id`, `session_shares`, `authz_audit`, and
  viewer-scoped list procedures.
- **Every Web API operation carries an access class** (`session:read/write/
  manage/destroy/share`, `fleet:read/admin`, …) enforced at the single runtime
  dispatch chokepoint (`packages/app/web/runtime.js`), with WebSocket subscribe
  gating and artifact-route gating. Unreadable session ids return `404` (no
  existence oracle). `session:share` and `fleet:admin` stay hard-enforced even
  during dark-launch.
- **Messages carry a server-stamped sender identity.** `user.message` events
  and the durable queue payload record who sent each message
  (`provider`/`subject`/`display`/`relation`/`origin`), stamped from the
  validated auth context — never client-supplied. In multi-writer sessions the
  agent sees a `[FROM: name (relation)]` attribution line and a one-shot
  `[SHARED SESSION]` preamble establishing owner priority (the owner's
  standing directives outrank a collaborator's). Single-writer sessions are
  byte-identical to before; forged `[FROM:]`/`[SHARED SESSION]` markers in
  user text are neutralized.
- **`dev` auth provider for local multi-user testing.** Five predefined
  personas authenticate as `Bearer dev:<persona>` with no IdP. Fail-closed:
  never inferred, requires `PORTAL_AUTH_DEV_ALLOW=true`, and refuses to start
  when any `PORTAL_AUTH_ENTRA_*` env is set. Portal sign-in becomes a persona
  picker; `sessionStorage` makes each browser tab a different user.
- **Portal + MCP surfaces.** Portal gains a visibility chip, a read-only
  composer for view-only sessions, and an owner/admin share dialog. MCP
  `get_capabilities` reports `role`/`ownership_enforced`/`default_visibility`;
  new `set_session_visibility` / `grant_session_share` /
  `revoke_session_share` / `list_session_shares` tools (server-enforced).

### SDK / Portal / TUI

- **Processed outbox prompts no longer remain stuck as queued.** Explicit
  `user.message`, system-prompt, and `session.turn_started` CMS writes now join
  the existing post-turn event-write barrier. A fast turn can no longer finish
  before its durable `user.message` acknowledgement, including the
  `clientMessageIds` the shared portal/TUI uses to remove the local queued item.
- **Durable orchestration `1.0.61`.** The published `1.0.60` schedule is frozen
  for replay safety; sender-aware shared-session prompt state and queue inputs
  run only under the new version.
- **Migration execution modes are fail-closed.** Migration definitions must
  choose exactly one non-empty transactional `sql` body or non-transactional
  idempotent `steps` list before any database connection is acquired.

## 0.5.13 — 2026-07-14

### SDK

- **Agent `skills` frontmatter now reaches the Copilot SDK.** Agent files may
  declare list or inline skill names to preload from configured plugin skill
  directories; the declarations remain visible in worker agent metadata.
- **Child result contracts now publish and normalize output references.**
  `complete_agent.result` and `cancel_agent.partial_result` expose concrete
  `factsWritten` / `artifactsWritten` schemas. Exact compatibility aliases,
  including `outputs`, `evidenceFactKeys`, and `artifactPointers`, are accepted;
  missing declarations report `missing_*_reference` instead of claiming the
  underlying fact or artifact does not exist.
- **Child sessions inherit context tier with model and reasoning effort.** Both
  inline and durable activity spawn paths now pass the complete model
  configuration into child SDK creation.
- **Reused session handles cannot return an earlier fire-and-forget response
  from `sendAndWait`.** Direct and Web SDK sessions refresh durable status,
  iteration, and response cursors immediately before enqueueing a waited turn.
- **Non-retryable GitHub credential failures are visible and recoverable.** A
  `401 Bad credentials` turn now persists CMS `error`, writes a durable error
  latest-response for chat and waiting clients, and keeps custom status in the
  error state instead of falling back to idle. After the user repairs the key in
  Admin, their next prompt clears the block and retries the live orchestration.
- **Pending-question answers no longer wait for the 30-minute affinity hold.**
  After the input grace period expired, an answer could win the durable message
  race but remain buffered behind the still-active idle timer. The orchestration
  now cancels the input hold and dispatches the answer immediately. Durable
  orchestration `1.0.59` is frozen for replay; new executions use `1.0.60`.

### App / MCP / Docs

- **The published `pilotswarm` package now has a complete remote-client
  quickstart.** Its package README documents shared Entra login, remote TUI
  attachment, local stdio MCP setup for Claude Code/Desktop, GitHub Copilot
  CLI, VS Code, and Cursor, non-interactive credentials, and the guarded HTTP
  transport. The MCP README keeps the full tool, resource, authentication, and
  security reference.
- **MCP live coverage now protects cached-handle response ordering.** The web
  smoke creates a session with an initial fire-and-forget prompt, waits for it
  to settle, then verifies `send_and_wait` returns only the second response.

## 0.5.12 — 2026-07-12

### SDK — Artifact API v2: a real data plane for agents

- **Consolidated agent artifact surface: 3 tools, strictly more capability.**
  `write_artifact` now takes exactly one byte source — inline `content`,
  `fromFile` (worker-local path, streamed server-side, path-jailed, never
  transits the model), or `fromArtifact` (server-side copy from another
  session with an optional `expectedSha256` precondition). `read_artifact`
  gains `toFile` (stream to worker disk — the binary read path), `metaOnly`
  (provenance stat), bounded inline reads (`maxBytes`/`offset`, `truncated`
  flag) and `encoding: "base64"` for small binaries. `list_artifacts` returns
  full metadata. **BREAKING: `export_artifact` is retired** — every
  write/read/stat result carries the `artifact://` link directly.
- **SHA-256 provenance everywhere.** Every upload (inline, file, copy)
  computes and persists a digest; every result returns `sha256`,
  `contentType`, `source` (`agent`/`file`/`copy`/`user`), `sourceDetail`, and
  `pinned`. Verify-without-transfer is now one `metaOnly` call.
- **Artifact pinning.** `write_artifact({pin: true})` /
  `setArtifactPinned()`; pinned artifacts survive bulk session cleanup so
  deliverables outlive a failed or deleted parent.
- **Both stores upgraded** (`SessionBlobStore`, `FilesystemArtifactStore`):
  `uploadArtifactFromFile` (streamed + hashed), `copyArtifact`,
  `statArtifact`, `setArtifactPinned`; pinned-aware `deleteArtifacts`.
- **Blob store env-flag split-brain fixed.** `createSessionBlobStore` now
  honors `PILOTSWARM_BLOB_USE_MANAGED_IDENTITY` (blob-specific; an explicit
  value wins) with the legacy shared name as fallback, and **throws instead
  of silently falling back to the filesystem store** when
  `AZURE_STORAGE_ACCOUNT_URL` is set with no credential path. The silent
  fallback previously left a portal serving "artifact not found" for every
  blob-backed worker write.
- **Base prompts teach filesystem isolation.** The framework default agent,
  sub-agent spawn prompt, and top-level session prompt now state that pods
  never share a filesystem and that binaries hand off via
  `write_artifact({fromFile})` → `read_artifact({toFile})`. The framework
  default agent also ships `list_artifacts` (it had silently dropped off the
  tool allowlist) and drops `export_artifact`.

### Portal / MCP / TUI

- MCP: new `copy_artifact` (with `expected_sha256`) and `pin_artifact`
  tools; `get_artifact` gains `include: "base64"` + `max_bytes` and returns a
  loud not-found instead of `meta: null` with a fabricated download URL.
- Portal transport: `statArtifact`-backed metadata, `copyArtifact`,
  `setArtifactPinned`, `readArtifactBase64`; TUI file uploads stream via the
  store's file path and return `sha256`.

### Docs / Templates / Sample

- Canonical docs, builder templates, and the DevOps sample updated to the
  new artifact flow (no more write→export two-step); Web API reference
  documents the new RPCs; design rationale in
  `docs/proposals/artifact-api-v2.md`.

### Tests

- `artifact-api-v2.test.mjs` (17 cases: source exclusivity, jail, SHA
  preconditions, truncation/ranging, pinning, local-overwrite-on-toFile,
  prompt contract) and `blob-store-mi-flag.test.mjs` (7 cases, red on the
  old code). Full `run-tests.sh --all-providers` matrix green on both
  storage providers (postgres 1058 tests / HorizonDB overlay 1071 tests);
  live smoke on AKS verified byte-exact binary handoff top-level↔top-level
  and parent↔child.

## 0.5.11 — 2026-07-12

### SDK

- **Zombie turns now self-settle.** When the Copilot CLI subprocess died
  mid-turn (e.g. V8 heap OOM), `session.idle` never arrived and
  `ManagedSession.runTurn` awaited forever — the durable `runTurn` activity
  stayed in-flight permanently and the session wedged while its message queue
  backed up. Two worker-side guards now settle the turn (no orchestration
  change; an explicit `0` disables either):
  - **Inactivity watchdog** (`turnInactivityTimeoutMs`, default 5 minutes): a
    live turn emits a steady event stream, so total silence means the
    subprocess is dead or wedged. Settles as a retryable transport-loss error
    whose message matches the connection-closed classifier, riding the
    existing recovery path — release affinity, retry on a fresh subprocess,
    bounded lossy-handoff fallback.
  - **Wall-clock turn cap** (`turnTimeoutMs`, default 10 minutes): the
    pre-existing timeout race was dead code — nothing ever set it. It is now
    on by default as the blunt backstop.
  - Guard timers are cleared when the turn settles and their rejections are
    pre-handled; both guards also cover the text-tool-call correction loop's
    idle waits.
- **A stale cron timer fire after `cron(action="cancel")` no longer kills the
  session.** Cancel clears the schedule, but the already-armed durable timer
  for the next tick cannot be retracted. When it fired, `processTimer`'s
  `cron` branch dereferenced the missing schedule and threw a `TypeError`
  that surfaced as a non-retryable `OrchestrationFailed` — permanently
  failing the session and orphaning its sub-agents. The stale fire is now
  ignored (traced, no `session.cron_fired`), matching the guard the `cron_at`
  branch already had.

### Tests

- `turn-inactivity-watchdog.test.js` — the incident shape (subprocess acks
  `send()` then goes silent forever) must settle as a transport-loss error
  the orchestration's connection-closed classifier accepts; steady event flow
  past the threshold must never trip the watchdog; defaults-on behavior;
  `0`-disables contract; no armed timers after a clean turn.
- `orchestration-stale-cron-timer.test.mjs` — a stale cron fire after cancel
  is a no-op (no throw, no `session.cron_fired`); an active cron fire still
  records `session.cron_fired` first.

## 0.5.10 — 2026-07-12

### SDK

- **`splashMobile` is now carried end-to-end through session creation.** The
  creatable-agent normalizer (`normalizeCreatableAgent`) forwarded `splash` but
  dropped `splashMobile`, so agent sessions persisted only the desktop banner and
  the mobile portal had no narrow-viewport variant to swap in — it fell back to
  the wide desktop art on phones. The field now flows through the normalizer (the
  single source feeding both the worker path and the portal's baked-plugin-dir
  catalog), system-agent session creation, and the inspect-tools session readout.
- **Migration 0028 — the paged session list carries the owner.**
  `cms_list_sessions_page` returned `SETOF sessions` (the raw table, which has no
  owner columns), so the portal's always-paginated session list delivered
  `owner: null` for every row and the UI rendered `?` owner initials — even though
  ownership was always persisted correctly. It's recreated (DROP + CREATE, the
  return shape changes) with the same `session_owners`/`users` LEFT JOIN that
  `cms_list_sessions` already performs; column order mirrors that function so
  `rowToSessionRow` handles both paths identically. No render-side change.

### Agents

- **Management-agent desktop splashes redesigned** (`pilotswarm`, `sweeper`,
  `agent-tuner`, `resourcemgr`, `facts-manager`) into solid ANSI-Shadow block
  logos with per-row color bands, a boxed role, a color-coded capability strip,
  and a flavor line. `splashMobile` variants unchanged.

### Tests

- Migration-shape unit test (`test:unit`) locking the paged-list `RETURNS TABLE`
  column set to the canonical `cms_list_sessions` shape — the invariant that
  would have caught the `?` owner bug — plus a DB-backed test (`test:local:cms`)
  asserting the keyset-paged list returns the persisted owner and agrees with the
  full list.

## 0.5.9 — 2026-07-10

### SDK

- **A sub-agent spawned by a system session now inherits the SYSTEM *user* as
  its owner instead of being marked `is_system`.** 0.5.7/0.5.8 fixed the Copilot
  "key not configured" failure by propagating `isSystem` to the child, but that
  made every spawned child undeletable and unmanageable ("Cannot delete system
  session") and pinned it into the system tree. Both spawn paths
  (`controlBridge.spawnAgent` and the `spawnChildSession` activity) now resolve
  the lineage's *effective owner* through a single shared
  `resolveEffectiveSpawnOwner` walk: the nearest owned ancestor's user wins, and
  a system ancestor maps to the first-class SYSTEM user principal. The child is a
  normal, deletable session that resolves the admin-stored System key through the
  ordinary per-owner credential path — with no `is_system` flag. Definition-driven
  system agents still get their protected `is_system` rows.

### Portal

- **One "System" bucket in the session owner filter.** System-agent children are
  now owned by the SYSTEM user (above), which previously minted a second,
  duplicate "System" owner entry beside the static one. The single System filter
  now covers both `is_system` agents and System-owned children; the duplicate
  bucket is gone.
- **The default view reliably shows your own sessions.** The portal's
  "no persisted filter" fallback was a mount-time snapshot of the owner filter
  (`{all:true}` before the principal resolved), which could drift a signed-in
  user's saved filter to All — or briefly hide their own sessions. The fallback
  is now derived from the resolved principal (Me + System), recomputed each
  profile-settings poll.
- **The owner-filter list stays live while open.** Its entries were snapshotted
  at open time; the periodic catalog refresh mutated owners underneath it, so a
  newly-arrived owner never appeared without reopening. The open modal now
  rebuilds its entries in place (preserving the highlighted row) on each refresh.
- **Light row dividers in the full-screen portal session list** — hairlines
  between top-level rows in the desktop portal only (not the mobile portal, and
  not the TUI).

## 0.5.8 — 2026-07-10

### SDK

- **Sub-agents of a system session are marked system in the spawn path the LLM
  actually uses.** 0.5.7 restored the parent→child `isSystem` propagation in
  `handleSubAgentAction`, but the `spawn_agent` tool routes through
  `controlBridge.spawnAgent` (session-proxy) — a separate, near-duplicate spawn
  path that never set the child's `isSystem` at all (it computed `agentIsSystem`
  from the agent definition and used it only for the title). So sub-agents of a
  working system session were still created non-system and kept failing GitHub
  Copilot turns with "key not configured". The real path now reads the parent's
  authoritative CMS row (not any in-memory flag, which a worker restart drops)
  and sets the child's `is_system` **before** its bootstrap turn is sent, so the
  child's first turn resolves the System key from its own row. The
  orchestration input also adopts `cmsRow.isSystem` in
  `_ensureOrchestrationAndSend`, so a resumed system session's flag survives
  worker restarts. Guarded by a restored end-to-end integration test that
  exercises the real path (it failed against the 0.5.7 build).

## 0.5.7 — 2026-07-10

### SDK

- **A child spawned by a system session is again a system session.** System
  sessions are ownerless, so a spawned child inherits no owner — its only route
  to a GitHub Copilot credential is the ownerless SYSTEM identity, i.e. the
  admin-stored System key (`_resolveSessionGitHubToken` falls back to
  `SYSTEM_USER_PRINCIPAL` only when the row is `isSystem` **and** has no owner).
  The modular orchestration set a child's `isSystem` only from the spawned
  agent definition's own `system` flag and dropped the parent→child propagation
  the pre-modular orchestration had, so children of a working system session
  came out ownerless **and** non-system and then failed every GitHub Copilot
  turn with "GitHub Copilot key not configured" — even though the parent ran
  fine on the System key. `handleSubAgentAction` now propagates the parent's
  `isSystem` to the child.

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
