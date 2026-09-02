# Proposal: Session-bound facts accessor on the tool invocation context

> **Status:** Implemented in 0.5.57 (`packages/sdk/src/tool-facts-accessor.ts`)
> **Date:** 2026-09-01, revised 2026-09-02
> **Goal:** Let a worker-registered tool read and write facts for the calling session
> without reaching into SDK internals, and give tools a key prefix the agent can never
> touch.

---

## Summary

Custom tools registered with `worker.registerTools()` receive `(args, invocation)`.
Today the SDK adds one thing to `invocation`: `durableSessionId`
(`packages/sdk/src/managed-session.ts`, the user-tool wrapper). Nothing else from the
session is reachable.

This proposal adds:

1. `invocation.facts`, with `read`, `store`, and `delete`. Session scope by default;
   root-session and shared scope on request.
2. A **tool-private key prefix**, `tools/`, that only `invocation.facts` can reach. The
   agent-facing fact tools (`store_fact`, `read_facts`, `delete_fact`, `facts_search`,
   `facts_similar`) refuse it for every agent, the Facts Manager included.
3. A worker option, `reservedFactPrefixes`, for hosts that want more prefixes kept
   away from the agent.

The driving case is a tool that proxies an external service with its own session
model. The tool must pin every call to one external session per PilotSwarm session.
That binding has to live somewhere durable that the tool can read on any replica and
the model cannot overwrite or even see.

---

## Problem

A custom tool that needs per-session durable state has three bad options today:

1. **Write a custom session event and read it back with raw SQL** against
   `copilot_sessions.session_events`. This couples the host to the CMS table layout and
   needs a prototype patch on `NodeSdkTransport` to get a write path.
2. **Read `worker.factStore` at runtime.** The field is TypeScript-private. It works in
   JavaScript but is not a contract.
3. **Build a second `PgFactStore`** from the same connection string. This duplicates
   store resolution and reads the wrong database on a deployment with enhanced facts.

The facts store is the right place for this state. It already has session-scoped keys,
upsert on key, and a reserved-prefix mechanism for the agent-facing tools. Two things
are missing: a supported way for a tool to reach it, and a namespace the agent cannot
reach at all.

---

## Proposed change

### 1. `invocation.facts`

```
type ToolFactsScope = "session" | "root" | "shared";

interface ToolFactsAccessor {
    durableSessionId: string;
    rootSessionId: string;
    read(key: string, opts?: { scope?: ToolFactsScope }): Promise<unknown | null>;   // exact key
    store(key: string, value: unknown, opts?: { scope?: ToolFactsScope }): Promise<void>;
    delete(key: string, opts?: { scope?: ToolFactsScope }): Promise<boolean>;      // true when a row was removed
}
```

Scopes:

| scope | scope key | who else can see it | lifetime |
|---|---|---|---|
| `session` (default) | this session's | nobody else | dies with the session |
| `root` | the root session of this tree | every session in the tree, through the accessor | dies with the root session |
| `shared` | the shared (cluster-wide) key | every session, through the accessor | until deleted |

Rules:

- A tool cannot name an arbitrary session. `session` and `root` are the only two
  session bindings; `shared` is the one non-session scope.
- `shared` writes are real shared facts: `shared: true`, not transient, visible to
  every session's accessor. Whether the AGENT can see them is decided by the key, not
  the scope: a shared fact under `tools/` (or a host-reserved prefix) is refused and
  stripped by the agent-facing tools exactly like a session one. A shared fact under
  any other key is ordinary shared knowledge, and the agent-facing tools read it as
  such. So a tool that wants shared state the agent must not see writes
  `tools/<tool-name>/...` with `scope: "shared"`; a tool that wants to publish a fact
  for agents to read writes an unreserved key.
- `read` is an **exact** read. It resolves the key to its scope key with the same
  function the store uses on write and reads through `ReadFactsQuery.scopeKeys`.
  It must not go through `keyPattern`: that is a SQL LIKE pattern, underscore is a
  wildcard there, and `bindings/my_service` would also match `bindings/myXservice`.
- `store` upserts on the scope key of the chosen scope. `delete` removes the exact
  key in that scope, so a tool can drop a dead binding and bind again.
- When the worker has no fact store, `invocation.facts` is `undefined`. Tools must
  check.
- Runtime context only. Not part of the tool schema, never sent to the model, exactly
  like `durableSessionId` today. A tool must not echo what it reads into its result
  text either: the result IS sent to the model.

**Where it is built.** `ManagedSession` has no fact store. The store lives on
`SessionManager`, which already builds the agent-facing fact tools in `createSession`
with `createFactTools({ factStore: this.factStore, ... })`. The session config is the
serialisable config, so a pair of functions cannot ride on it.

```
SessionManager.createSession(sessionId, ...):
1. builds the agent-facing fact tools (today)
2. builds the accessor for sessionId from this.factStore (new)
3. hands it to ManagedSession through a constructor argument (new)

ManagedSession user-tool wrapper:
    const augmented = { ...invocation, durableSessionId, facts: this.factsAccessor };
```

### 2. The tool-private prefix `tools/`

Keys under `tools/` belong to tools. The agent never reads, writes, deletes, or
searches them.

```
Agent-facing tools (store_fact, read_facts, delete_fact, facts_search, facts_similar):
    key or pattern under tools/  →  refused, for EVERY agent identity
    read results                 →  tools/* rows stripped, as intake/* is today

invocation.facts:
    tools/* allowed (and the only place it is)
```

Two differences from the existing reserved prefixes:

- **No agent exemption.** `skills/`, `asks/`, `intake/`, and `config/facts-manager/`
  are reserved *for the Facts Manager*; that agent bypasses the check. `tools/` has no
  such exemption. Tool state is control-plane state, not knowledge, and no agent should
  read it into its context or rewrite it.
- **Its own refusal text.** The current message says "reserved for the Facts Manager",
  which is wrong here. Use: `Error: the 'tools/' key namespace belongs to tools and is
  not readable or writable by agents.`

Convention: a tool namespaces its own state as `tools/<tool-name>/<key>`. The SDK does
not enforce the second segment; it is a convention so two tools do not collide.

The Facts Manager's own configuration stays where it is (`config/facts-manager/`).
Any tool that wants to keep state the agent must not see, including tools that back
system agents like the Facts Manager, uses `tools/` through the accessor.

### 3. Host-reserved key prefixes

`packages/sdk/src/facts-tools.ts` hardcodes `RESERVED_WRITE_PREFIXES`,
`RESERVED_READ_PREFIXES`, and `RESERVED_DELETE_PREFIXES` as module constants. Make
them per worker:

```
new PilotSwarmWorker({
    ...,
    reservedFactPrefixes: ["bindings/"],
})
```

Each listed prefix is appended to all three lists, threaded from the worker through
`SessionManager` into `createFactTools` as an option. Host prefixes get the same
treatment as `tools/`: no agent exemption, and the tool-namespace refusal text.
`invocation.facts` is not subject to the check.

The search tools (`facts_search`, `facts_similar`) already block reserved namespaces
and strip reserved keys from results using the read list, so they cover host prefixes
and `tools/` once the list is per worker.

### 4. Transient facts

Session-scoped facts are stored with `transient = true`
(`packages/sdk/src/facts-store.ts`, `storeFact`). Nothing in the SDK prunes them
today. The contract for facts written through `invocation.facts`:

- Session and root scope facts live as long as that session. Deleting the session
  deletes them. Shared scope facts are not transient and live until deleted.
- `regenerate_session` creates a new session id, so the new session starts with no
  tool state. A tool that must carry state across a regenerate stores it under the
  root session id, which the accessor exposes as `rootSessionId` (see below).
- If transient pruning is ever added, `tools/*` rows are exempt.

### 5. Root and shared scope

`durableSessionId` is the calling session, so a sub-agent gets its own state by
default. That is the right default. Two wider scopes cover the other cases:

- `{ scope: "root" }` binds the call to the root session of the tree: one external
  session per tree, and state that survives a regenerate of a child.
- `{ scope: "shared" }` writes a cluster-wide fact: state one tool keeps across every
  session (a rate-limit window, a service catalog it discovered, a cursor into an
  external feed). Under `tools/` it is invisible to agents; under any other key it is
  ordinary shared knowledge.

Nothing else is reachable: no arbitrary session id, no other user's private facts.

---

## Usage pattern

A tool that proxies an external service with its own sessions:

```
proxy tool handler(args, ctx):
1. binding = process cache
              ?? await ctx.facts.read("tools/<service>/binding")
2. no binding → result = external open_session(external_id = ctx.durableSessionId)
               await ctx.facts.store("tools/<service>/binding",
                                     { externalSessionId, serviceSessionId, registeredAt })
               binding = await ctx.facts.read("tools/<service>/binding")   // re-read
3. cache binding
4. reject if binding.externalSessionId != ctx.durableSessionId
5. stamp the service session ID from the binding onto args, call the service
```

**Why the re-read in step 2.** Two replicas can take the first call at the same time.
Both open an external session, both upsert, last writer wins. Without the re-read each
replica caches its own binding and the two never agree. With it, both adopt whatever
the store holds after the write. If the service is idempotent on `external_id` the
two writes are equal anyway. `storeFact` has no insert-if-absent or etag compare
today; the re-read is the tool available.

The model never chooses the service session: the ID is not in the tool schema, and the
key lives under `tools/`, which the agent cannot read.

---

## Out of scope

- Facts for an arbitrary other session from a tool.
- Exposing the artifact store or the session catalog on the invocation. Same shape,
  separate proposal if needed.
- Conditional writes (etag compare-and-set) on `storeFact`. Worth doing; not needed
  for the binding case once the re-read is in place.

---

## Acceptance

- A worker-registered tool receives `invocation.facts` with `read`, `store`,
  `delete`, `durableSessionId`, `rootSessionId`.
- `store(key, v, { scope: "shared" })` from session A is returned by
  `read(key, { scope: "shared" })` from session B; the same under `tools/` is
  refused and stripped by the agent-facing tools in both sessions.
- `store(key, v, { scope: "root" })` from a child is returned by a root-scope read
  from a sibling.
- `store` followed by `read` in a different worker process returns the same value.
- `read("a_b")` does not return a fact stored as `aXb`.
- `delete` followed by `read` returns `null`.
- The model cannot see `facts` in the tool schema or in any tool result.
- `store_fact`, `read_facts`, `delete_fact`, `facts_search`, `facts_similar` refuse
  `tools/*` for every agent identity, the Facts Manager included, with the tool
  namespace refusal text. `read_facts` never returns a `tools/*` row.
- With `reservedFactPrefixes: ["x/"]`, the same holds for `x/*`.
- `invocation.facts.store("tools/x", ...)` succeeds from a tool.
- Unit tests for the accessor (exact read, delete, root scope, shared scope), for the
  `tools/` reservation on both session and shared rows, and for the host prefix
  option.

---

## Found during the adversarial review of the implementation

- The crawl queue (`facts_read_uncrawled`, a graph tool for crawlers and the
  Facts Manager) reads every scope and returned `tools/*` values. It now
  refuses a tool-only `keyPrefix` and strips tool-only rows.
- PostgreSQL LIKE treats backslash as the escape character and the delete
  procs run LIKE without an `ESCAPE` clause, so `tools\/%` matched every key
  under `tools/` while its raw literal head matched no prefix check. Patterns
  are unescaped before any prefix check. This also closed the same hole for
  `intake/`, `skills/` and `asks/` pattern deletes.
- The reserved prefix set is captured per `createFactTools` call, never
  module-level.
- Not changed: the MCP and portal `read_facts` / `facts_admin` paths still
  return `tools/*` rows to a human operator. The promise is that the MODEL
  cannot see them.

