# Ripley — History

## Core Context
- **Project:** pilotswarm — durable execution runtime for GitHub Copilot SDK agents
- **Stack:** TypeScript (ESM), Node.js 24+, duroxide (Rust), PostgreSQL, Azure Blob, neo-blessed TUI
- **User:** Affan Dar
- **Key repos:** pilotswarm, microsoft/duroxide, microsoft/duroxide-node
- **Joined:** 2026-03-10

## Learnings
- 2026-03-10: Added `docs/proposals/tui-design-spec.md` to define a maintainable target architecture for the TUI; it matters because the current monolith mixes canonical state, live stream updates, and direct rendering in ways that make session switching and dedup fragile.
