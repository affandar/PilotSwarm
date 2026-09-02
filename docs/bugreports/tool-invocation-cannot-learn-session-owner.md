# Gap: a worker-registered tool cannot learn who owns the calling session

**Status:** Open
**Filed:** 2026-09-02
**Component:** `pilotswarm-sdk` tool invocation context (`ManagedSession` user-tool wrapper, `SessionManager`)
**Affected versions:** 0.5.57 and earlier
**Severity:** Medium. Every tool that must attribute an action to the signed-in person has to bypass the SDK to do it.

## Symptom

A tool registered with `worker.registerTools()` receives `(args, invocation)`.
Since 0.5.57 the invocation carries `durableSessionId`, `facts`, and the
Copilot SDK fields. It carries nothing about the person the session runs for.

Tools that need that person exist in any deployment where an agent acts on
someone's behalf against an external system:

- stamping an owner on a billable cloud resource for cost attribution;
- writing an audit row that says who asked;
- deciding whether the caller may see or change a per-user record;
- gating an admin-only operation.

The only way to get the owner today is to open a raw connection to the session
catalog and join `sessions → session_owners → users` by hand, then walk
`parent_session_id` up to the root to check `session_shares`. That:

1. couples the host to the CMS table layout, which the SDK owns and migrates;
2. bypasses the SDK's own authorization chokepoint (`decideSessionControl`
   already resolves a caller's provider, subject, and admin role for the
   agent-manager tools, but that resolution is not reachable from a tool);
3. is easy to get wrong. `invocation.sessionId` is the Copilot SDK's internal
   id, not the durable session, and a lookup keyed on it silently finds no
   owner. Sub-agents inherit their owner row at spawn, write shares are
   recorded on the root session only, and system sessions have no owner at
   all. Each of those is a rule the host has to rediscover.

Taking the owner from tool arguments instead is not an option: arguments come
from the model, and a model-supplied "who am I" is a spoofing primitive.

## Proposal

Resolve the session's principal once, server-side, and hand it to the tool on
the invocation, next to `facts`:

```ts
interface ToolSessionContext {
    durableSessionId: string;
    rootSessionId: string;
    isSystem: boolean;
    /** The session's owner as recorded by the catalog, or null for an ownerless session. */
    owner: {
        provider: string;
        subject: string;
        email: string | null;
        displayName: string | null;
        /** Last-observed portal role: "admin" | "user" | "anonymous" | null. */
        role: string | null;
    } | null;
    /** True when any user other than the owner holds a write share on the root session. */
    writeShared: boolean;
}

// on the invocation
invocation.session: ToolSessionContext
```

Rules, matching what the SDK already does elsewhere:

- Built by `SessionManager` at tool-call time from the catalog, the same place
  the facts accessor is built. Cached per turn; a share grant or role change
  takes effect on the next turn.
- Runtime context only. Not in the tool schema, never sent to the model. A
  tool must not echo it into result text.
- `owner` follows the same inheritance the spawn path uses
  (`cms_inherit_session_owner`), so a sub-agent sees its lineage's owner.
- `role` is the catalog's last-observed value, with the same caveats
  `getUserRole` documents. If freshness matters the SDK could also expose
  `roleSeenAt`.
- `CanvasKvPrincipal` already models a resolved `{ kind: "user", provider,
  subject, isAdmin }` for the canvas door. The same shape would serve here;
  one resolver, two consumers.

## Acceptance

- A tool called from a top-level session owned by user U sees `owner.subject
  === U.subject` and `isSystem === false`.
- A tool called from a sub-agent spawned under that session sees the same
  owner.
- A tool called from a system session sees `owner === null` and
  `isSystem === true`.
- After `grantSessionShare(root, V, "write")`, a tool called in that tree sees
  `writeShared === true`; a read share leaves it `false`.
- `invocation.session` never appears in the tool schema sent to the model.
- Unit tests for each of the above plus the durable-vs-SDK session id
  distinction.
