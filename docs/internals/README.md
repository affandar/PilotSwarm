# Internals

Implementation-detail docs. The high-level architecture is in
[../architecture.md](../architecture.md); the orchestration design is in
[../orchestration-design.md](../orchestration-design.md). These files are the
worker- and storage-side specifics.

| File | Topic |
|---|---|
| [session-manager.md](./session-manager.md) | `SessionManager` singleton + `ManagedSession` per-session class. Turn execution, event subscription, dehydrate/hydrate, registration |
| [cms-schema.md](./cms-schema.md) | `copilot_sessions` PostgreSQL schema and the client-side CMS reader |
