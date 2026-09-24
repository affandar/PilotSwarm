# Durable webhook ingress and provider bindings

Webhook ingress is a trusted SDK/backend service layered on
[durable signals](durable-signals.md). It authenticates an external event,
atomically records receipts and routing work, then acknowledges it. Session
creation, queueing and consumption happen separately.

The SDK supports generic capability endpoints, GitHub webhooks and Azure DevOps
Web Hooks. This is **not** GitHub OAuth, GitHub App installation, or portal
sign-in. Provisioning a connector does not register a webhook with either
provider. No callback, payload URL or repository URL is fetched.

## Enable the host

Ingress is **off by default**. Configure the trusted portal/worker host, not
browser clients:

```dotenv
PILOTSWARM_WEBHOOKS_ENABLED=true
PILOTSWARM_WEBHOOK_PUBLIC_ORIGIN=https://hooks.example.invalid
# Exact socket peers of your TLS-terminating proxies, if applicable:
PILOTSWARM_WEBHOOK_TRUSTED_PROXY_IPS=127.0.0.1
```

Use an actual deployment origin, without a path, query, or credentials.
`PILOTSWARM_WEBHOOK_ALLOW_LOOPBACK_HTTP=true` is an explicit local-test escape
hatch for an actual loopback socket peer, not a way to trust forwarded IPs.
The server refuses publicly bound, enabled ingress if portal authentication
is disabled. Management still uses normal portal authentication; `/hooks`
uses its own capability or provider credentials.

The shipped host starts the leased outbox pump and stops it before closing
its clients. Management can prepare policy while ingress is disabled.
The server mounts exact-byte, non-decompressing hook routes **before** shared
JSON middleware. Never put capability paths in proxy/access logs: the shipped
OpenTelemetry bootstrap excludes `/hooks` HTTP auto-spans, but operators must
also configure their reverse proxy and any additional logging middleware.

## Generic capability endpoints

```ts
const endpoint = await management.createSignalEndpoint(sessionId, "ci_finished", {
    label: "Deployment completion",
    maxUses: 100,
    wake: false,
});
// Transfer endpoint.url securely to the sender. It contains a bearer capability.
```

`createSignalEndpoint`, `listSignalEndpoints` and `revokeSignalEndpoint` are
typed `PilotSwarmManagementClient` methods in direct and Web API modes.
In direct mode, the trusted host supplies a final
`{ principal: { provider, subject }, isAdmin }` viewer argument on management
operations; omitting identity is refused. Web mode derives identity on the
server. Never deserialize that viewer from a request body. The normal trusted
identity path must have recorded the owner's current admitted CMS role;
incoming webhooks cannot register identities or grant roles.

Creation returns `token` and `url` **once**. Lists and later mutations return
metadata only. The endpoint table holds a SHA-256 digest, not the token or live
URL. A token has the recognizable `pswh_` prefix plus 256 random bits encoded
as 43 base64url characters; the prefix does not reduce its entropy.

On enabled, signal-capable workers (orchestration 1.0.80+), an ordinary agent can
call `create_signal_webhook({signal_name, label?, expires_at?, max_uses?, wake?})`.
The worker binds it to that agent's own authorized session. It does not register
anything with a provider; any external registration remains a separate,
explicitly authorized operation. Read-only tuner sessions cannot mint endpoints.

The model must see the one-time tool result to hand the URL to an authorized
external tool. Consequently its **private SDK context/snapshot can contain the
capability**; do not describe all session storage as secret-free. Public event,
tool-result and final-message projections redact recognizable capabilities,
including later turns and rehydrated sessions. A stream that begins a capability
switches to its sanitized final message rather than exposing split-token deltas.
The operator UI's one-time secret view is separate from durable chat history.

For larger evidence, upload it through an authorized artifact surface and send
a bounded summary plus an opaque reference in the JSON data. This endpoint does
not upload oversized bodies or fetch references, and possession of its token
does not grant artifact-read permissions.

The endpoint has one immutable session, signal name and wake policy. Request
JSON is signal **data**, even if it contains keys named `sessionId`, `model`,
`owner`, `tools`, `prompt` or `type`. It cannot select a route or command.
Targets must be ordinary, live sessions: system/service sessions and terminal
executions are not capability or binding destinations.

```http
POST /hooks/s/<capability-token>
Content-Type: application/json
Idempotency-Key: <stable-delivery-identity>

{"status":"succeeded"}
```

Expiry defaults to 30 days and cannot exceed 90 days. `maxUses` is optional
(1–1,000,000). Only a newly accepted delivery uses a capability use; duplicate
keys with the same exact-body digest do not. Different bodies under the same
key are rejected. Omitting the key deliberately creates a new delivery.
Unknown, revoked, expired and exhausted capabilities have the same not-found
refusal. Revocation is permanent; mint a new endpoint to replace one.

An administrator can set `hmacSecretRef` when creating an endpoint. Such
requests additionally require `X-Signature-256: sha256=<hex>`, verified over the
exact raw bytes. This generic header is distinct from GitHub's native header.

## Provider authentication and secret rotation

An administrator provisions a connector with a fixed source scope and
operator-owned **secret references**:

```ts
const github = await management.createWebhookConnector({
    label: "Repository PR events",
    provider: "github",
    source: { repositoryId: "123456" },
    auth: { mode: "github-hmac-sha256", secretRef: "GH_REVIEW" },
});

const ado = await management.createWebhookConnector({
    label: "Project CI",
    provider: "azure-devops",
    source: {
        repositoryId: "<repository-guid>",
        projectId: "<project-guid>",
        buildDefinitionId: "42",
    },
    auth: { mode: "ado-basic", usernameRef: "ADO_USER", passwordRef: "ADO_PASSWORD" },
});
```

The host mounts `POST /hooks/c/:connectorId`. Unlike a generic endpoint, the
connector ID is not a credential.

| Provider | Native authentication | Delivery identity |
|---|---|---|
| GitHub | `X-Hub-Signature-256`, HMAC-SHA256 over exact raw body, constant-time digest comparison | bounded `X-GitHub-Delivery` |
| Azure DevOps | HTTP Basic authentication over HTTPS; constant-time comparisons of both configured credential values | bounded top-level event `id` |

**Azure DevOps Web Hooks do not natively use GitHub HMAC signing.** A GitHub
signature is not accepted instead of Basic authentication on an ADO connector.
Configure the username/password in the provider's Web Hook settings.

The injectable `WebhookSecretResolver` resolves references in the trusted
process. Without a custom resolver, reference `GH_REVIEW` resolves **only**
`PILOTSWARM_WEBHOOK_SECRET_GH_REVIEW`. Reference syntax is
`[A-Z][A-Z0-9_]{0,63}`; arbitrary environment variable names, paths and `env:`
expressions are not supported. Missing/invalid credentials fail explicitly.
The resolver is called for every request; dynamic secret-store resolvers can
rotate values without restarting the SDK. The default resolver rereads the
current process environment, not `.env` files. Updating deployment-injected
environment variables may still require restarting that host.

CMS stores only references. Management reads return
`auth: { mode, configured: true }` or `hmacConfigured`; not a secret or its
reference value. These flags mean a reference was configured, **not** that a
secret resolved or a real provider delivery succeeded. Reference changes require administrator authority and an
`expectedRevision`, and are audited. Do not place webhook credentials in model
catalogs or log raw request headers, bodies or capability URLs.

## Finite normalized events

The backend accepts only the following initial event set. Push events are not
part of this contract.

| Provider event | Normalized `eventType` | Normalized `action` |
|---|---|---|
| GitHub `workflow_run`, action `completed` | `workflow.completed` | `completed` |
| GitHub `check_run`, action `completed` | `check.completed` | `completed` |
| GitHub `pull_request` | `pull_request.lifecycle` | `opened`, `reopened`, `closed`, `synchronize`, `edited`, `ready_for_review`, `converted_to_draft` |
| ADO `build.complete` | `build.completed` | `completed` |
| ADO `git.pullrequest.created` | `pull_request.lifecycle` | `created` |
| ADO `git.pullrequest.updated` | `pull_request.lifecycle` | `updated` |
| ADO `git.pullrequest.merged` | `pull_request.lifecycle` | `merge_attempted` |

GitHub's signed setup `ping` is also acknowledged and recorded as `unmatched`
metadata. It never triggers a binding, including one with no filters. A
successful setup ping proves reachability/authentication, not model execution.

ADO's `git.pullrequest.merged` event means **merge attempted**, not necessarily
successful completion. Inspect normalized `status` and `conclusion`. GitHub's
`closed` event sets `conclusion: "merged"` only when its PR `merged` flag is true.

The complete filter/template-variable allowlist is:

`provider`, `eventType`, `action`, `repositoryId`, `repository`, `projectId`,
`pullRequestNumber`, `buildId`, `buildDefinitionId`, `ref`, `status`,
`conclusion`, `title`, `url`.

Provider IDs are normalized to bounded strings; PR numbers are positive
integers. Text and URLs are bounded. Unsafe URL schemes and URL credentials
are omitted. URLs are never fetched. No arbitrary object traversal, JSONPath,
code, regular-expression filters or expression evaluation is available.
Filters use exact normalized-field equality, or inclusion in a bounded array.
NUL and unpaired-surrogate JSON escapes are rejected before PostgreSQL storage;
valid Unicode surrogate pairs are preserved.

### ADO build payload versions

Some documented `build.complete` payloads contain project and definition IDs
but **omit the repository**. Such a payload is refused unless the administrator
explicitly configured a matching `projectId` + `buildDefinitionId` → fixed
`repositoryId` mapping on the connector. That mapping is operator-attested
policy, not a repository identity invented from a callback URL. Re-approve it
when a pipeline's repository changes. Alternatively, use a full resource
payload containing `repository.id`. A supplied repository ID always wins and
must match the configured repository. A configured build-definition constraint
must also match. Templates must use exactly the connector's source scope.

## Trusted bindings and approved templates

Connectors, bindings and templates have owner/admin-scoped list, create, update
and revoke methods. Updates require `expectedRevision`. States are `active`,
`disabled`, `quarantined`, and permanently `revoked`. Source and owner identity
cannot be patched.

Template creation and configuration changes require administrator approval.
An administrator may assign a connector/template to an already-admitted owner.
A binding executes as the connector's owner, **not** as the administrator who
last edited it. Templates and connectors must have the same owner and source.

```ts
const template = await management.createWebhookSessionTemplate({
    label: "PR reviewer",
    source: { repositoryId: "123456" },
    config: {
        agentName: "reviewer",
        namespace: "app",
        visibility: "private",
        // Optional model/reasoningEffort/contextTier are approved server policy.
        // Omitted model uses the owner's normal model selection policy.
    },
    prompt: {
        instruction: "Review the recorded pull request.",
        fields: ["repositoryId", "pullRequestNumber", "title", "url"],
    },
});

await management.createWebhookBinding({
    label: "New PR review",
    connectorId: github.id,
    filters: { eventType: "pull_request.lifecycle", action: ["opened", "reopened"] },
    action: { type: "create_session", templateId: template.id },
});
```

The fixed action is exactly one of:

- `create_session`: an approved template ID, optionally explicit coalescing;
- `raise_signal`: a fixed `sessionId`, `signalName`, and optional `wake`;
- `enqueue_prompt`: a fixed `sessionId` and a persisted prompt template.

Prompt templates contain a server-owned `instruction` and allowlisted `fields`.
Selected values are JSON-escaped inside a separate block explicitly labeled
untrusted data; they are not substituted into instructions. Raw provider bodies
never become prompts or signal data.

Template config does not accept credentials, arbitrary working directories,
system prompts, tool definitions, owner overrides or repository permissions.
Tools, budget/lifecycle constraints and repository access remain those of the
approved agent and deployment policy. The host must reauthorize the current
agent/source/namespace placement on each attempt. Missing host authorization is
an explicit error, never a permissive fallback.

The SDK's ordinary session policy and model/provider-owner resolution still run.
Named creation uses `createSessionForAgent`, not a raw catalog insertion.
Its direct-only reserved `sessionId` + `idempotencyKey` persist atomically with
the initial config and metadata. Retrying cannot overwrite a title/config,
transfer ownership or resurrect a deleted reserved session. These reserved
creation fields are refused in public Web API client creation.

Automated routes require actual ownership or a current write grant/shared-write
target. An administrator's manual break-glass access does not authorize an
automated cross-owner route. Under `AUTHZ_ADMIN_SCOPE=cluster`, administrators
can approve their own connector/template policy but do not inherit other
owners' webhook resources. Revoked owner membership or template approval is
checked again at routing time.

### Optional coalescing

There is **no default coalescing**. Different delivery identities ordinarily
create different sessions. Opt in explicitly:

```ts
action: {
    type: "create_session",
    templateId: template.id,
    coalescing: {
        key: "repository_pull_request",
        onMatch: { type: "raise_signal", signalName: "pr_updated", wake: false },
        // Alternatively: { type: "enqueue_prompt", prompt: ... } or { type: "noop" }.
    },
}
```

The key includes provider, project when applicable, repository and PR number,
within the binding. Matching an existing live session uses the declared
`onMatch`; it never silently starts an extra model turn. `noop` finishes at
`routed`, without a queue entry. Missing PR identity is an explicit dead-letter
error, not an inferred key. GitHub run/check payloads expose a PR number only
when exactly one linked PR is present. Build payloads without a PR number
cannot use this coalescing policy.

## Durable acceptance, retries and observability

An accepted request returns only `202 { "accepted": true }`, after receipt,
bounded routing data and outbox work commit atomically. It does not wait for
session creation, model execution or consumption.

Provider deduplication is durable by connector/delivery identity, with one
receipt per matched binding. Exact raw-body hashes detect identity reuse with
different content. A retry cannot pick up newly-created bindings retroactively.
Session IDs and signal IDs are reserved durably, before effects.

Receipt timelines distinguish:

`received → authenticated → normalized → matched → routed → queued → consumed`

Other dispositions include `duplicate`, `unmatched`, `rejected`, `rate_limited`,
`disabled`, `expired`, `target_terminal`, `routing_failed`, `dead_lettered`, and
`dropped`. Duplicates increment a counter and append a timeline entry without
overwriting the original outcome. `queued` means the durable queue accepted the
work. A correlated signal disposition marks it consumed/dropped. An approved
prompt reaches `consumed` only when orchestration 1.0.80+ dispatches its exact
`webhook:<receipt-id>` message into a turn, not merely when ingress queues it.
This does **not** prove the model completed successfully: budget deferral,
worker recovery and ordinary model errors remain separate session outcomes.
Signal and prompt routes both refuse running decoders older than 1.0.80.

Use:

- `listWebhookReceipts(query)` and `getWebhookReceipt(receiptId)`;
- `getWebhookMetrics()` for bounded provider/outcome aggregates;
- `testWebhookBinding(bindingId, { event })` for a sanitized, side-effect-free
  normalized-event match/authorization check;
- `replayWebhookReceipt(receiptId, { confirmed: true })` for explicit replay of
  a retained failed receipt.

The dry-run result explicitly reports `authorizationScope: "persisted_policy"`.
It checks current CMS ownership/source/target/template policy, not the host's
runtime placement callback. A positive dry-run is not a promise of queueing;
actual routing must still pass the host's current agent/namespace authorization
and model/provider admission.

Receipt queries are owner/admin-scoped, return metadata only, and support
`connectorId`, `endpointId`, `sessionId`, `status`, `before`, and `limit` (1–100).
The opaque `before` cursor is a receipt ID from the preceding page. Timelines
retain the last 32 transitions. Authentication/body-validation failures and
ingress quota refusals are persisted as bounded counters rather than allocating
an attacker-controlled stream of raw-body receipts. Unattributed failures are
visible only in administrator aggregates.

Resource lists return at most 100 entries, prioritizing non-revoked resources
(live endpoints before expired/revoked history). Revoked history cannot hide
an owner's still-actionable resources. An administrator's cross-owner resource
list is also a bounded 100-entry view, not an unbounded fleet export.

Tuner tools `read_webhook_receipts`, `read_webhook_receipt`, and
`read_webhook_metrics` expose the same redacted management reads with current
viewer scope. Short `webhook.accept` and `webhook.route` spans are linked by
persisted trace IDs, not a span held open while the session waits.
`pilotswarm.webhook.ingress` / `.routing` counters and matching `.duration`
histograms use bounded origin-kind/provider/action/outcome labels; receipt IDs
are trace attributes, never metric labels. Bodies, credentials and capability
URLs are not observability attributes.

The outbox uses contract-versioned claims, 60-second leases, eight attempts,
and exponential backoff capped at five minutes. Crashed claims count toward
the bound. At most three explicitly confirmed replays can reset attempts.
Replay never silently retargets a receipt after a binding change; unavailable
routing data or unauthorized/currently leased work refuses explicitly.

Every attempt checks current persisted owner membership, connector/binding
state and revisions, source scope, template approval/revision, target ownership,
and write access. The trusted host also checks template placement. Changes
invalidate pending work; a connector-only credential/state revision can be
explicitly reauthorized through confirmed replay. Revocation is checked at
the next claim and again immediately before each target operation. A queue
operation already in flight is not recalled, and queued signals are not erased
by revoking their sender endpoint. A stale lease cannot acknowledge newer work.

This is **at-least-once routing**, not exactly-once arbitrary effects. A crash
after queue acceptance but before its receipt acknowledgement can resend the
same signal/message identity. The signal runtime's documented deduplication
window still applies; durable create-session identity does not expire.

Raw provider bodies are never retained. Only the bounded normalized projection
(or generic endpoint's bounded JSON data) is held in a separate internal payload
table, with no public payload-read operation. Unmatched provider deliveries
retain redacted metadata only and cannot later be replayed into a newly-created
binding. Receipt/routing history is retained until administrative storage
retention removes it; no automatic deletion policy is implied.

## Limits and trusted host integration

| Boundary | Limit |
|---|---|
| Provider raw body | 256 KiB, UTF-8 JSON only, no decompression |
| Generic raw body / inline signal | 32 KiB |
| JSON depth | 16 |
| JSON nodes | 8,192 provider / 4,096 generic |
| Array length | 256 |
| Single input string | 32 KiB provider / 16 KiB generic |
| Filter fields / values per field | 12 / 16 |
| Non-revoked bindings per connector / fan-out | 16 |
| Resources of a kind per owner / live endpoints per session | 100 / 100 |
| Global / source quota | 600 / 120 requests per minute |
| Endpoint, connector and binding quota | default 60, configurable 1–600/minute |
| Pending routes | at most 10,000 global / 1,000 per origin |

Quotas are atomic persisted **UTC fixed-minute buckets**, not in-process maps
or sliding windows. A boundary can admit two minute allowances in a short
interval. Origin quotas include authentication failures. If any matching
binding lacks quota, acceptance is rejected before consuming the delivery's
deduplication identity; the provider can retry later. Source buckets use a
digest of the actual socket peer, never arbitrary `X-Forwarded-For`.

```ts
const ingress = management.createWebhookRuntime({
    client, // Fully configured DIRECT SDK client, with current session policy.
    authorizeTemplate: async (template, owner) =>
        currentPlacementPolicyAllows(template, owner), // Host-owned, fail closed.
    onError: code => reportBoundedWebhookFailure(code),
});
ingress.start();
// During shutdown, before closing providers:
await ingress.stop();
```

The host supplies raw bytes, headers, `peerAddress` and a trusted `secure`
boolean to `acceptSignalEndpoint` or `acceptConnector`. `secure` must come
from socket TLS or an **explicit trusted TLS-termination configuration**.
Blindly honoring `X-Forwarded-Proto` is unsafe. Public ingress requires HTTPS.
`allowLoopbackHttp: true` permits only a verified loopback socket for local
development. A configured `webhookPublicOrigin` must be an HTTPS origin; without
one, capability creation returns a relative URL.

## Operator surfaces and local verification

The shared TUI/portal [Webhooks console](../../user-guide/webhook-management.md)
manages endpoints, connectors, bindings, templates, receipts and metrics.
It also supports manual signal raising, dry runs and explicitly confirmed
replay. Updates carry the displayed revision; a conflict requires reloading,
not silently overwriting another operator's policy.

The [Web API reference](../../api/reference.md#webhook-management) and
[MCP tools](../../../packages/app/mcp/README.md#webhook-management) use these
same management methods. Web API mode never accepts a wire-supplied viewer.
Neither surface calls GitHub, Azure DevOps or Azure to register providers.

Credential-free tests use local signed/Basic-auth fixtures. For the PostgreSQL
suite, point `PS_TEST_DATABASE_URL` at a dedicated disposable **local** test
database, then run from `packages/sdk`:

```sh
npx vitest run test/local/webhooks-validation.test.js test/local/webhooks-store.test.js \
  test/local/durable-signals.test.js test/local/durable-signals-runtime.test.js \
  test/local/inline-control-tools.test.js
```

The storage suite creates and removes only its isolated schemas. It includes
raw HTTP -> real PostgreSQL receipt/outbox -> native Duroxide -> consumed
signal/prompt cases, with fixture turn activities instead of a model.
HTTP management and MCP tests separately cover authentication boundaries,
wire shapes and all management operations. These do not establish real
GitHub/ADO delivery or credentialed model behavior.

For operator-run provider testing, use a private test repository/project and
an authenticated HTTPS host. Check signed GitHub setup ping, build/PR delivery,
duplicate suppression, tampered authentication refusal, an approved template
creating exactly one session, and explicit coalescing/revocation/dead-letter
replay. Correlate provider delivery ID, receipt and session outcome; a provider
HTTP success or `queued` receipt alone is not end-to-end success. Portal sign-in
remains the deployment's existing auth provider, not GitHub OAuth.

The host must bound the raw body while reading it, before allocating an
unbounded buffer, and must not install a JSON body parser ahead of signature
verification. Public `/hooks/*` routes use their own authentication, outside
portal sign-in. There is no automatically-running pump: `start()` owns one
cancellable loop, `runOnce()` is available for an external scheduler, and
`stop()` awaits its work. `management.stop()` also stops runtimes it created.
An external scheduler must also await any `runOnce()` call it started before
closing providers.

Migration 0081 atomically correlates trusted webhook-sourced
`session.signal_consumed` / `session.signal_dropped` CMS events through a trigger.
It works for older signal-aware workers too; a crash after event persistence
cannot lose a separate receipt callback. A host-specific recorder can also call
the idempotent internal CMS
`webhooks.recordSignalDisposition({ receiptId, sessionId, signalId, disposition })`.
The procedure verifies all three identities and refuses foreign or contradictory
updates.
Consumption may arrive before a queue acknowledgement, or after a lost
acknowledgement has dead-lettered routing. A correlated disposition remains
authoritative and clears remaining outbox work without creating another effect.

## Validation boundary

`test/local/webhooks-validation.test.js` covers native authentication, bounds,
normalization, prompt framing, resolver rotation and direct/web signatures.
`test/local/webhooks-store.test.js` exercises real isolated PostgreSQL migrations,
authorization, atomic deduplication/quotas, receipts, leases, replay, coalescing
and the public SDK creation path with a synthetic durable-queue boundary.
These tests do **not** claim real GitHub/ADO delivery or real model execution.
A deployment's approved HTTPS/provider delivery test is a separate gate.

Official provider references:

- [GitHub: validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Azure DevOps: Web Hooks authentication](https://learn.microsoft.com/en-us/azure/devops/service-hooks/services/webhooks?view=azure-devops)
- [Azure DevOps: event IDs and payload versions](https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops)
