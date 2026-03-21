# Changelog

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
