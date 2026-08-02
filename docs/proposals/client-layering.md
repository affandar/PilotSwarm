# Client Layering — Consistency, Not a Security Boundary

> **Status:** Proposal — revised 2026-08-01 after an adversarial review (`gpt-5.6-sol`, xhigh reasoning). The first draft proposed a universal `op(input, caller)` signature with a `SYSTEM` sentinel. That is withdrawn — see "What the review killed".
> **Scope:** stop the same operation behaving differently depending on which surface you enter through, and stop operations existing at one layer and not the others.

## Threat model — answer this first

**PilotSwarm is not a security boundary between a caller and its own database.**
Anyone holding `DATABASE_URL` can instantiate `PgSessionCatalog`, import a
provider, or just run SQL. No amount of TypeScript layering changes that. The
agent-packages proposal already says it plainly: scopes are *"visibility, not
security: this is a trusted system."*

So this proposal is about **consistency**, not authorization. It does not make
direct mode safe. If direct mode must become safe, that is a different proposal
(PostgreSQL roles, RLS, network controls) — see non-goals.

The authorization that *does* exist — `PortalRuntime._authorizeCall()` — stays
exactly where it is. It guards the **public HTTP surface**, which is a real
boundary, and it doubles as an explicit allowlist of externally callable
operations. Worth keeping.

## The problem

Three symptoms, all present in the tree today.

**1. Operations exist at one layer and not the others.**

| | Web API | MCP | CLI | Mgmt client |
|---|:---:|:---:|:---:|:---:|
| agent-package ops | 10 routes | 8 tools | 7 subcommands | **0 methods** |
| download tarball | ❌ | ❌ | ❌ | ❌ |

`fetchAgentPackageTarGz()` exists in `agent-package-service.ts` and is reachable
from no surface at all. Drift, not a missing feature.

**2. The same operation has different guarantees per entry point.**
`sendMessage` splits three ways: `PortalRuntime` authorizes and stamps `sender`
(overwriting anything the client sent); `NodeSdkTransport` does the
terminal-state and parent-session validation; the service does neither. A
direct-mode caller gets **no stamping and no gate**.

**3. The CLI bypasses everything.** `agents-cli.js` constructs `PgSessionCatalog`
itself, needs `DATABASE_URL`, and has no web mode — so it cannot talk to a
deployment the way MCP and the portal do.

These are **consistency** failures. None is fixed by inventing an authorization
framework.

## The fix

Three changes. No new framework.

**A. Every operation has one shared command function.** Validation and
server-stamped fields live in it. `PortalRuntime` calls it; direct mode calls it.
Today `sendMessage`'s rules are split across two modules and skipped entirely by
a third caller — that is the actual bug.

**B. `PilotSwarmManagementClient` gets the missing methods**, delegating to the
existing `agent-package-service.ts` with its existing `(actor, isAdmin)`
signature. This is what the CLI and the tarball download sit on.

**C. The CLI is layered on the client, web mode by default.** `--store` becomes
an explicit break-glass path, not a storage flag.

`PortalRuntime` keeps `_authorizeCall()` and keeps its switch. The switch is an
allowlist, not the disease.

## Lifecycles

**Package publish** — one tail, three heads:

```
CLI / MCP / portal ─► client.publishAgentPackage(…)
        ├─ web  ─► POST → PortalRuntime._authorizeCall → publishCommand(…)
        └─ direct ──────────────────────────────────► publishCommand(…)
              agent-package-service: validate → creator-or-admin → catalog + blob
```

**sendMessage** — the rules stop depending on the door:

```
client.sendMessage(…)
   ├─ web  ─► POST → _authorizeCall → sendMessageCommand(input, sender)
   └─ direct ──────────────────────► sendMessageCommand(input, sender)
            validate terminal state + parent rules   ← was in NodeSdkTransport
            stamp sender                              ← was in PortalRuntime
            raise durable event
```

Everything below the durable-event boundary is untouched. Orchestration, replay
and dehydration do not change.

## Migration

| Step | Work | Done when |
|---|---|---|
| 1 | Mgmt-client methods over `agent-package-service`; expose `fetchAgentPackageTarGz` | Download works from client, CLI, MCP, portal |
| 2 | `sendMessage` validation + stamping into one command function; both callers use it | Direct-mode send stamps a real sender |
| 3 | CLI onto the client, web default; `--store` is break-glass | `pilotswarm agents list` works with no `DATABASE_URL` |

Each step ships alone and reverts alone.

**No split-brain window.** Steps 1–2 leave authorization in one place
(`_authorizeCall`) and business rules in another (the command function). That is
the intended end state, not a migration phase. At no point do two authorization
paths both run.

## Acceptance

1. **No operation exists at only one layer.** If it is in the Web API it has a
   management-client method; if it has a client method it is reachable from CLI
   and MCP.
2. **The same operation enforces the same rules through every door.** A
   direct-mode `sendMessage` stamps a sender and rejects a terminal session,
   exactly as the HTTP path does.

Both are testable. Neither holds today.

## Also needs deciding (missing from the first draft)

- **Sender semantics.** User, service account, operator and
  orchestration-generated messages are different things. One `principal` field
  cannot represent them. Needs a small explicit type before step 2.
- **Error taxonomy.** Typed service errors need a stable mapping to HTTP status,
  CLI exit code and MCP error. Without it, direct and web fail differently and
  database detail can leak through HTTP.
- **Atomicity.** Publish spans catalog + blob and can orphan. `sendMessage`
  validates then raises — a TOCTOU window. Both want idempotency keys before
  retries are added anywhere.

## Non-goals

- **This does not make direct mode safe.** Anyone with `DATABASE_URL` owns the
  database. Fixing that means PG roles and RLS; out of scope.
- **No universal `caller` parameter, no `SYSTEM` sentinel.** Withdrawn, below.
- **No generated protocol table.** `publishAgentPackage(dir)` is not
  transport-neutral — `dir` is client-local and meaningless server-side. Uploads,
  tarballs, streams and subscriptions each need a surface-specific adapter.
- **`PortalRuntime` stays**, switch included.
- **Orchestration is untouched.**

## What the review killed

The first draft proposed `op(input, caller)` everywhere, with direct callers
passing `caller = SYSTEM`. Withdrawn for three reasons:

1. **No threat model.** It applied a security mechanism to a declared-trusted
   system — policy that *looks* enforced but is bypassable by anyone who can
   reach the database.
2. **`SYSTEM` is forgeable and destroys audit.** It is ordinary data. Worse,
   `NodeSdkTransport` assigning it automatically would make every direct client
   an administrator, and `sendMessage` would then stamp `SYSTEM` as the sender,
   losing the real operator identity. Strictly worse than today.
3. **"Delete the Web API and everything still works" was security-hostile.** It
   institutionalises a second control plane bypassing authentication, rate
   limiting, audit and revocation. Break-glass should be narrow and audited, not
   at parity with the public API.

The `isAdmin: boolean` question closes with it: it stays. There is no capability
model for a richer type to serve.
