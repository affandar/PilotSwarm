# Changelog

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

### TUI (`cli/tui.js`)

- **Moved from `examples/tui.js` to `cli/tui.js`** — TUI is now part of the package, not an example.
- **Parameterized hardcoded values** — system message, K8s namespace, K8s pod label, and worker
  module path all read from env vars set by the CLI.
- **Emoji rendering fix** — monkey-patch neo-blessed's `unicode.charWidth()` to correctly report
  emoji codepoints (U+1F100–U+1FAFF, U+2300–U+27BF, etc.) as 2 cells wide. Emoji now render
  correctly instead of being stripped. Added `forceUnicode: true` to screen options.
- **Session switch repaint fix** — switching sessions now triggers the same full
  `screen.realloc()` + `relayoutAll()` cycle as pressing 'r', plus a deferred
  repaint on next tick. Fixes stale content bleeding through on first switch.
- **Log mode switch repaint fix** — pressing 'm' to change log view mode now also
  triggers the full 'r'-equivalent repaint.
- **Clean exit** — suppress `process.stdout.write` and `process.stderr.write` before
  `screen.destroy()` to prevent neo-blessed's terminfo `SetUlc` compilation dump.
  Terminal reset written via `fs.writeSync(1, ...)` to bypass suppression.
- **Suppress `SetUlc` on load** — stderr silenced during `require("neo-blessed")` and
  `blessed.screen()` creation to prevent terminfo junk on startup.

### `run.sh`

- Updated to use `node bin/tui.js local|remote` instead of setting env vars and calling
  `examples/tui.js` directly.

### `package.json`

- Added `bin` field for `pilotswarm-tui` → `bin/tui.js`.
- TUI rendering deps (`neo-blessed`, `marked`, `marked-terminal`) moved from
  `devDependencies` to `dependencies`.
- `files` includes `bin/`, `cli/tui.js`, and `plugin/`.
- NPM scripts updated to use new CLI.

### Docs

- **`building-apps.md`** — deployment topology diagrams updated to reference
  `npx pilotswarm-tui` / `node bin/tui.js`. CLI reference shows env var
  equivalents for all flags. Intro updated to remove stale `tui-apps.md` cross-ref.
- **`README.md`** — TUI example row updated to reference `cli/tui.js`.
- **`examples.md`** — TUI section header updated to `cli/tui.js`.
