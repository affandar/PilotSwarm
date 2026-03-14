# Brett — History

## Context
- **Project:** pilotswarm — durable execution runtime for GitHub Copilot SDK agents
- **Stack:** TypeScript (ESM), Node.js 24+, duroxide (Rust), PostgreSQL, Azure Blob Storage, neo-blessed TUI
- **User:** Affan Dar
- **Joined:** 2026-03-14

## Learnings
- Previous doc generation attempts had formatting issues: nested/mismatched code fences, duplicated sections from LLM output. Always validate fence pairing before committing.
- The project uses a workspace monorepo: `packages/sdk/` (core runtime) and `packages/cli/` (TUI). Docs should reference the correct package paths.
- Plugin architecture has three tiers: system (SDK-bundled), management (opt-out), application (user plugins). Each tier has agents, skills, and optional MCP configs.
- Key docs already exist: architecture.md, building-apps.md, configuration.md, getting-started.md, guide.md, writing-agents.md, and more in `docs/`.

### 2026-03-14 — Doc Planning Sprint (Blog + Plugin Guide Outlines)
**Files read for planning:**
- `packages/sdk/src/index.ts` — public API surface (exports PilotSwarmClient, PilotSwarmWorker, defineTool, loadSkills, loadAgentFiles, loadMcpConfig, ModelProviderRegistry, etc.)
- `packages/sdk/src/client.ts` — PilotSwarmClient class: createSession, createSystemSession, resumeSession. Sessions take toolNames (serializable), onUserInputRequest, model.
- `packages/sdk/src/worker.ts` — PilotSwarmWorker class: registerTools, _loadPlugins, start (registers all orchestration versions, auto-registers sweeper/artifact/resourcemgr tools, starts system agents). pluginDirs, skillDirectories, customAgents, mcpServers all merge.
- `packages/sdk/src/types.ts` — Full type catalog. TurnResult has types: completed, wait, input_required, spawn_agent, message_agent, check_agents, etc. OrchestrationInput carries sub-agent state, durable timer config, checkpoint intervals.
- `packages/sdk/src/model-providers.ts` — Multi-provider registry (github, azure, openai, anthropic). `env:VAR` syntax for secrets. provider:model qualified names.
- `packages/sdk/src/agent-loader.ts` — .agent.md format with YAML frontmatter (name, description, tools, system, id, title, parent, splash, initialPrompt). systemAgentUUID for deterministic IDs.
- `packages/sdk/src/skills.ts` — SKILL.md format with frontmatter (name, description) + optional tools.json.
- `packages/sdk/src/mcp-loader.ts` — .mcp.json format: local (command/args) or remote (http/sse url). Env var expansion via `${VAR}`.
- `packages/sdk/examples/chat.js` — Minimal single-process: worker+client, session.on() for events, session.sendAndWait() loop.
- `packages/sdk/examples/worker.js` — Headless worker for K8s: reads PLUGIN_DIRS, auto-discovers model providers, graceful shutdown.
- `packages/sdk/examples/tui.js` — Full TUI example (superseded by packages/cli/).
- `packages/cli/cli/tui.js` — Actual TUI CLI: PilotSwarmClient + PilotSwarmWorker + ManagementClient. blessed-based two-column layout. Supports embedded or remote workers.
- `packages/cli/plugins/` — CLI's own plugin with .mcp.json (context7) and plugin.json.
- `packages/sdk/plugins/system/` — default.agent.md (always loaded, base system message), skills: durable-timers, sub-agents.
- `packages/sdk/plugins/mgmt/` — pilotswarm.agent.md (master orchestrator, system:true), sweeper.agent.md (maintenance loop, parent: pilotswarm), resourcemgr.agent.md (monitoring loop, parent: pilotswarm).
- `docs/building-apps.md` — App building reference: plugin structure, tools, runtime, CMS, deployment topologies, "simplest app" pattern.
- `docs/writing-agents.md` — Detailed agent/skill/tool/MCP authoring guide with prompt assembly flow.
- `docs/configuration.md` — Env vars, DB setup, single-process mode.
- `docs/getting-started.md` — Zero-to-running walkthrough.
- `docs/architecture.md` — Design philosophy, value propositions, logical view.
- `docs/tui-apps.md` — AppAdapter framework for TUI-based apps.

**Patterns observed:**
- The "simplest app" is plugin-only (no code): agents + skills + .mcp.json, launched via `npx pilotswarm-tui --plugin ./plugin`.
- Custom tools require a worker module file passed via `--worker ./tools.js`.
- Production split: headless worker.js on K8s, TUI in client-only `remote` mode.
- Durable timers are the key differentiator for long-running use cases (travel planner, test swarm monitoring loops).
- Sub-agent orchestration (spawn_agent, check_agents, wait_for_agents) is core to swarm patterns.
- Plugin merge order: system → management → application (pluginDirs). Direct config overrides.

**Decisions for doc structure:**
- Blog 1 (Test Swarm / CLI) focuses on plugin-only + TUI workflow. No custom code needed — agents + skills do the work.
- Blog 2 (Travel Planner / SDK) focuses on programmatic SDK use with custom tools, durable timers for periodic checks, Express/Fastify REST API wrapping the client.
- Blog 3 (Plugin Architecture Guide) is the technical reference that both blogs link to for "how plugins actually work."
- All three form a trilogy: Blog 1 = "easy mode", Blog 2 = "full SDK power", Blog 3 = "the reference."
