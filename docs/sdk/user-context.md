# User Context for Tool Handlers

> Worker-side public API for accessing the active end-user's identity
> and access token from inside a tool handler.

## TL;DR

```ts
import {
  getUserContextForSession,
  interactionRequired,
  serviceUnavailable,
} from "pilotswarm-sdk";

worker.registerTools([
  defineTool({
    name: "ado_list_projects",
    description: "List ADO projects visible to the user.",
    parameters: { /* ... */ },
    async handler({ sessionId }) {
      const ctx = getUserContextForSession(sessionId);
      if (!ctx?.accessToken) {
        // No human principal bound to this session (system / orchestration /
        // local-TUI host) OR OBO is not configured on this stamp.
        return { error: "user_required" };
      }
      try {
        const oboToken = await exchangeOboToken(ctx.accessToken, "499b84ac-1321-427f-aa17-267ca6975798/.default");
        // ... call ADO _apis/projects with oboToken ...
      } catch (err) {
        if (isInteractionRequiredError(err)) {
          return interactionRequired({
            reasonCode: "reauth_required",
            message: "Re-authenticate to continue.",
            claims: err.claims, // never reaches the LLM; sanitized at envelope persist
          });
        }
        return serviceUnavailable({
          reasonCode: "akv_unwrap_failure",
          retryAfter: 30,
        });
      }
    },
  }),
]);
```

## `getUserContextForSession(sessionId)`

Worker-affined **synchronous** lookup against the in-memory
`UserContextStore`. Returns:

```ts
type UserContext = {
  principal: {
    provider: string;       // e.g. "entra"
    subject: string;        // stable per-user identifier (Entra oid)
    email: string | null;
    displayName: string | null;
  };
  accessToken: string | null;
  accessTokenExpiresAt: number | null; // epoch ms
} | null;
```

### Sub-agent chain resolution

When called from a sub-agent session, the lookup walks up the parent
chain until it finds a session with a portal-bound user context. This
makes `getUserContextForSession()` Just Work in tool handlers that are
invoked from nested orchestrations spawned via `spawn_agent`.

**Re-rooting**: if the engineer later navigates directly to a
sub-agent in the portal and prompts it, PilotSwarm re-roots that
session as its own portal-bound entry from that RPC onward. ADO tools
invoked from that point use the engineer's directly-supplied identity,
while in-flight tool calls already running on the prior resolution
path complete with the prior context.

### Absence semantics — `accessToken` is `null` (never `undefined`)

Three independent absence cases all collapse to `accessToken: null`:

1. **No downstream scope configured** — the stamp has not set
   `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE`; the portal never acquires a
   downstream token.
2. **System / orchestration session** — no human principal is bound to
   the session. The entire `UserContext` is `null` in this case (the
   function returns `null`).
3. **AKV unwrap failure** — the ciphertext envelope reached the worker
   but the AKV `unwrapKey` operation failed (transient AKV throttling,
   role revocation, etc.). The principal envelope is still surfaced
   (so tools that only need the user's identity continue to work), and
   `accessToken: null` signals "you cannot perform OBO right now". A
   synthetic `system.tool_outcome` event is emitted to the session so
   the operator can see the failure in the activity log.

### Performance

O(1) on `sessionId` against an in-memory `Map`. Safe to call
unconditionally at the top of every tool handler — there is no
per-call AKV round-trip; the plaintext access token is held in the
per-RPC envelope crypto cache for the duration of the tool call frame.

## Structured tool outcomes

Both helpers produce a typed result envelope that the SDK
distinguishes from generic tool-execution failures and from successful
returns. The portal renders affordances keyed off the discriminator,
not off the message text.

### `interactionRequired({ reasonCode, message?, claims? })`

Signals the user must re-authenticate. Pinned reason codes:

| `reasonCode` | When to use |
|---|---|
| `reauth_required` | Generic re-auth (token expired, refresh failed) |
| `mfa_refresh` | IdP requires fresh MFA proof |
| `conditional_access` | Conditional Access policy challenged the token |
| `consent_required` | User needs to consent to a new scope |

The `claims` field (the WWW-Authenticate `claims=` challenge from the
IdP) is forwarded to the portal MSAL flow for the re-auth call but is
**never** forwarded to the LLM — the SDK sanitizes the
`data.outcome_payload` persisted to the activity log to drop it.

### `serviceUnavailable({ reasonCode, retryAfter?, message? })`

Signals a transient, non-user-actionable failure. Tools choose between
`interaction_required`, `service_unavailable`, and generic failure
based on what the user can do about it:

- User re-auths → `interactionRequired`
- User waits / retries → `serviceUnavailable`
- Bug in tool, wrong arguments, etc. → throw a normal `Error`

Pinned reason codes include `akv_unwrap_failure`, `idp_unreachable`,
`downstream_throttled`. Consumers may define additional reason codes;
the portal treats unknown reason codes as a generic
"service unavailable, please retry".

## Security guidance

- **Never log the access token.** The SDK redacts `accessToken`,
  `accessTokenCipher`, and `claims` from any persisted event payload,
  but the access token is still in plaintext on your stack frame
  while the tool handler runs. Do not pass it to logging, telemetry,
  or error-reporting paths.
- **Never include token material in `interactionRequired` or
  `serviceUnavailable` payloads.** The persisted shape is sanitized to
  a fixed allow-list; including unexpected fields will drop them but
  the safer pattern is to not pass them at all.
- **Use the token only on the per-call frame.** Do not stash it in a
  global, do not hand it to a background worker. The next call's
  envelope may carry a refreshed token.
- **Don't gate on `null` vs `undefined`.** `accessToken` is `null` in
  every absence case. Branch on outcome type, not on token shape.

## Related

- Configuration env reference: [`docs/configuration.md`](../configuration.md)
- Operator runbook (KEK provisioning, rotation, revocation):
  [`docs/operations/obo-kek-runbook.md`](../operations/obo-kek-runbook.md)
- Reference smoke plugin: [`examples/obo-smoke/`](../../examples/obo-smoke/)
- Manual release-gate smoke checklist:
  [`examples/obo-smoke/SMOKE_CHECKLIST.md`](../../examples/obo-smoke/SMOKE_CHECKLIST.md)
