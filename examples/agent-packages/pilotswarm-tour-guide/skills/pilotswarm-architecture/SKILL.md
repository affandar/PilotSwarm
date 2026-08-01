---
name: pilotswarm-architecture
description: The shape of PilotSwarm — the pieces, how a turn flows through them, and the rules that constrain each layer.
---

# PilotSwarm Architecture

A durable execution runtime for GitHub Copilot SDK agents, powered by
**duroxide** (a Rust durable-orchestration engine). What durability buys:
crash recovery, durable timers, session dehydration, multi-node scale-out.

## Two runtime components

- **Client** — creates sessions, sends prompts, subscribes to events.
  Lightweight, needs no GitHub token, handles only serializable data.
- **Worker** — runs LLM turns, executes tool handlers, owns the Copilot
  runtime. Needs a GitHub token. Tools are registered here.

Both connect to the same PostgreSQL. Duroxide coordinates between them, which
is why the client can hold no handler functions: everything crossing that
boundary must survive a database round-trip.

## The path of one turn

```
Client → duroxide orchestration → SessionProxy activity
       → SessionManager → ManagedSession → CopilotSession (Copilot SDK)
```

## The rule that shapes everything: replay

The orchestration is a generator replayed from the beginning on every new
event, so it must yield the identical sequence each time. `Date.now()`,
`Math.random()`, `crypto.randomUUID()`, `setTimeout`, and any I/O are
therefore banned inside it — the deterministic substitutes are
`ctx.utcNow()`, `ctx.newGuid()`, `ctx.scheduleTimer()`, and activities.
Changing the yield sequence creates a new orchestration version, which is why
versions are frozen rather than edited.

## Storage

Session state lives in the CMS (`copilot_sessions` schema); facts live in
their own schema. All data access goes through stored procedures with
versioned migrations applied under advisory locks, so concurrent workers can
start safely against the same database.

## Composition

A session can spawn sub-agents, each its own session with its own
conversation and tools, running concurrently under a parent. Capability
arrives as agent packages: a manifest plus agents, skills, worker tools, and
MCP servers.
