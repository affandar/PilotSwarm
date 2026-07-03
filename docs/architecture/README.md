# Architecture

Read in this order — each doc assumes the ones above it:

1. **[Layering — One Way In](./layering.md)** — the map. Every user-facing
   surface (TUI, portal, MCP, SDK apps) rides the Web API; only the portal
   server, workers, and tests touch the datastore directly. Start here; it
   orients everything else.
2. **[Architecture deep dive](./system.md)** — the durable runtime: worker,
   client, CMS catalog, duroxide orchestration store, and how a turn actually
   executes.
3. **[Orchestration design](./orchestration/design.md)** — the durable session
   orchestration in full: drain/decide, TurnResult dispatch, sub-agents,
   hydration, replay invariants. ([Short orientation](./orchestration/loop.md)
   first if you're new.)
4. **[System reference](./system-reference.md)** — file map, session
   lifecycle, CMS schema, invariants. The lookup doc.

Focused designs:

- [Facts store](./facts.md) — the memory subsystem's design spec
- [Session creation policy](./session-creation-policy.md) — who may create what
- [TUI architecture](./tui.md) — the shared terminal/browser UI stack
- [Component interactions](./component-interactions.md) — message-flow diagrams
- [Internals](./internals/README.md) — CMS schema and SessionManager, for
  contributors working in those files
