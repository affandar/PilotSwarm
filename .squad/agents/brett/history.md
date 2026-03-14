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
