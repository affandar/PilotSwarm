# Client Layering — One Operation Layer, Two Client Modes

> **Status:** Proposal — architecture pitch, not yet implemented
> **Date:** 2026-08-01
> **Scope:** where authorization and business rules live, how the CLI/MCP/portal/worker all reach the same operations, and how to stop Web API routes, management-client methods and CLI gestures from drifting apart.

## Summary

PilotSwarm already has the right *shape* in two places and the wrong one in a
third. `PilotSwarmClient` and `PilotSwarmManagementClient` both dispatch on
`isWebOptions()` and return a web variant, so "direct vs Web API" is a real,
working pattern. `agent-package-service.ts` already takes an explicit
`(actor, isAdmin)` and enforces creator-or-admin *inside* the operation. But the
Web API's actual server path does neither: it runs through `PortalRuntime`, a
portal-specific module holding a hand-written `switch` and the only
authorization check in the system.

The consequence is that **business logic is smeared across three layers and each
surface enters at a different one**, so they cannot agree. This proposal collapses
that into five layers with one rule: every operation is `op(input, caller)`, and
the operation layer is the only place decisions happen.

## The problem, concretely

### What the request path actually is today

```
browser ──► /api/v1  router.js         table-driven, no logic
                └─► runtime.call(name, params, req.auth)      ← chokepoint
                     └─► PortalRuntime._authorizeCall()       ← ALL authz lives here
                          └─► switch (method) { … }           ← hand-written cases
                               └─► NodeSdkTransport (direct mode)
                                    └─► PilotSwarmManagementClient({ store })
                                         └─► PgSessionCatalog
```

Authorization is **not** in the client. It is in `PortalRuntime`. That single
fact explains every symptom below.

### Symptom 1 — "just layer it on the client" is not sufficient

The direct-mode client has no authorization at all; it is safe only because it
is used from a trusted subsystem. So a CLI layered on the direct client is not
"the same thing without HTTP" — it is **god-mode over the database**. That is
exactly what `packages/app/tui/src/agents-cli.js` is today: it constructs
`PgSessionCatalog` itself, requires `DATABASE_URL`, and bypasses the
creator-or-admin gate the portal enforces.

### Symptom 2 — operations exist at one layer and not the others

Because every remote operation must be hand-written into `PortalRuntime`'s
`switch`, layers drift:

| | Web API | MCP | CLI | Mgmt client |
|---|:---:|:---:|:---:|:---:|
| agent-package ops | 10 routes | 8 tools | 7 subcommands (direct-store only) | **0 methods** |
| download tarball | ❌ | ❌ | ❌ | ❌ |

`fetchAgentPackageTarGz()` already exists in `agent-package-service.ts` and is
reachable from **no** surface. That is drift, not a missing feature.

### Symptom 3 — the same operation has different guarantees per entry point

`sendMessage` is the clearest case. Today the work is split three ways:

- `PortalRuntime` runs `_authorizeCall()` **and** stamps `sender` via
  `_buildSender(authContext, …)`, deliberately overwriting any client-supplied
  value;
- `NodeSdkTransport.sendMessage` does the business validation (terminal-state
  and parent-session rules);
- the service layer does neither.

So a direct-mode caller gets **no gate and no sender stamping**. Same operation,
different guarantees, depending on which module you happened to call.

## The architecture

Five layers, each with exactly one job.

```
L5  SURFACES        portal · CLI · MCP · TUI · worker
                    construct a client, choose a mode, nothing else
                              │
L4  WEB API         router (table derived from op registry) + auth middleware
                    credential ──► caller.  Serialize. NO business logic.
                              │
L3  CLIENTS         PilotSwarmClient / PilotSwarmManagementClient
                    direct: call L2 in-process   |   web: HTTP to L4
                    same method surface. DUMB — no rules, no authz.
                              │
L2  SERVICES        op(input, caller) ── THE ONLY PLACE DECISIONS HAPPEN
                    validation · business rules · authorization
                    server-stamped fields · typed errors
                              │
L1  PROVIDERS       PgSessionCatalog · blob · facts · graph · duroxide
                    no policy, no identity
```

### The rule

Every operation is `op(input, caller)` where `caller = { principal, role, capabilities? }`.

**Trust becomes an argument, not the absence of a check.** The Web API passes the
caller derived from the request token; the worker and operator tooling pass an
explicit `SYSTEM` caller. Today "trusted" means *"you happened to call a module
that doesn't check"*, which is precisely how a CLI ends up more privileged than
the portal.

### What each layer must not do

- **L1** must not know about identity or policy.
- **L2** must not know about HTTP, tokens, or which surface called it.
- **L3** must not contain rules — if a client method makes a decision, it belongs in L2.
- **L4** must not contain business logic or a second authorization path.
- **L5** must not reach past L3. No surface constructs `PgSessionCatalog`.

## Request lifecycles

### A — publish / update an agent package

Today the portal authorizes twice (runtime, then service) and the CLI authorizes
zero times. Afterwards there is one tail and three heads:

```
CLI  ─┐
MCP  ─┼─► client.publishAgentPackage(dir)
portal┘        │
               ├─ web mode ─► POST /agent-packages ─► L4 derives caller ─┐
               └─ direct ────────────────────────── caller = SYSTEM ─────┤
                                                                          ▼
                                    agentPackageService.publish(input, caller)
                                      validate → authz(creator-or-admin)
                                      → catalog + blob → typed result
```

The service already has this signature. The change is that the outer layers stop
bypassing it.

### B — sendMessage

```
client.sendMessage(sessionId, prompt)
   ├─ web ────► POST → L4: caller from token ─┐
   └─ direct ─────────── caller = SYSTEM ─────┤
                                               ▼
        sessionService.sendMessage(input, caller)
          authz: may caller write this session?
          stamp sender FROM caller           ← cannot be skipped or forged
          validate terminal state
          raise durable event
                → duroxide → worker → orchestration → Copilot SDK
                → events → CMS → WebSocket / poll → any surface
```

**Everything below "raise durable event" is unchanged.** Orchestration, replay,
dehydration and the versioning rules are untouched; this proposal only concerns
the request path *into* the durable core.

### C — reads (listSessions, listAgentPackages)

Viewer scoping (`_listViewer`, `placementPrincipal`) becomes a service concern
parameterized by `caller`, rather than a runtime helper the CLI cannot reach.
This is what makes a viewer-scoped CLI listing possible at all.

## What happens to today's modules

| Module | Final role |
|---|---|
| `PortalRuntime` | Shrinks to credential → caller, bootstrap assembly, WebSocket fan-out. **Loses the business `switch` and `_authorizeCall`.** |
| `NodeSdkTransport` | Becomes the direct-mode composition root: wires providers + services, keeps genuinely host-local state (plugin dirs, worker registry, session policy). Loses business rules like the `sendMessage` terminal-state check. |
| `agent-package-service.ts` | Unchanged — it is the template the rest converges on. |
| `Web*Client` | Unchanged in spirit; the method list becomes derived rather than hand-maintained. |
| `agents-cli.js` | Rewritten onto the client, web mode by default, `--store` an explicit operator escape hatch. |

## Migration

Incremental, in dependency order. No big-bang rewrite; each step is shippable.

| Step | Work | Buys |
|---|---|---|
| 1 | Management-client methods delegating to `agent-package-service` with `(actor, isAdmin)` | Closes 10-routes/0-methods; gives the CLI something to sit on; exposes `fetchAgentPackageTarGz` (the missing download) |
| 2 | `PortalRuntime` package cases become one-liners into the same service | Two authorization paths collapse into one |
| 3 | CLI onto the client, web mode default | CLI stops needing `DATABASE_URL` and inherits real authz |
| 4 | Derive the protocol table from the op registry | Drift becomes impossible rather than merely noticed |
| 5 | Repeat per domain (sessions, facts, graph) as they are touched | Convergence without a freeze |

Steps 1–3 carry the value; step 4 is what stops it regressing.

## Acceptance — two falsifiable tests

1. **Delete the Web API server** → every surface still works in direct mode, with identical rules.
2. **Add one operation in one service file** → it appears in CLI, MCP and portal without editing a `switch`, a route table, or a client method by hand.

Neither holds today. Both hold when this lands.

## Explicit non-goals

- **Do not move authorization into `PilotSwarmManagementClient` itself.** Wrong
  seam: the worker uses it on hot paths and should not pay for or reason about
  authorization. Authz belongs in L2, with L3 passing `caller` through.
- **Do not delete `PortalRuntime`.** It legitimately owns transport-adjacent
  concerns. It should stop owning business dispatch.
- **Do not make the CLI web-only.** Operators need direct mode when the portal is
  down. Keep `--store`, make it loud, and pass an explicit `SYSTEM` caller.
- **Do not touch orchestration.** Nothing below the durable-event boundary changes.

## Open decision

`isAdmin: boolean` versus a capability-bearing `caller`.

The boolean is honest while authorization is literally "creator or admin", and
that is all the current model expresses. It cannot express team ownership or
per-package roles, and adding them later means threading a second parameter
through every signature already written.

**Recommendation:** adopt `caller = { principal, role, capabilities? }` in step 1,
with `isAdmin` derived from it. Step 1 already touches ~11 signatures, so it is
the cheap moment; the shape then survives a richer model without a second sweep.
