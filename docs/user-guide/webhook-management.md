# Webhook management in Settings / Admin Console

The native TUI and portal use the same webhook state, forms, validation and
controller actions. In the TUI, open **Admin Console** with `Shift+A`, then
press `h`. In the portal, open **Settings** (ordinary users) or **Admin**, then
select **Webhooks** in the settings tree. This is not a separate application.

All lists and health aggregates are scoped by the server to the current viewer.
Being admitted to the portal does **not** imply administrator access. The UI
offers owner/admin actions based on the current profile and metadata, but the
server authorizes every request again. An authorization failure remains visible.
An unavailable transport operation is reported, not replaced by another API.

The shared ingress status reads `webhooks.enabled` from the transport's existing
`getBootstrap` snapshot. Disabled ingress does **not** disable management:
policies can be configured before the host enables ingress and its leased
runtime. Enabled ingress is not verified authentication or successful delivery.
Connections without this metadata (including direct transports that do not
publish a bootstrap snapshot) show **status unavailable**, not an inferred
enabled/disabled state. Reload/reconnect to obtain a new host bootstrap snapshot;
the UI does not read environment variables or reach past the transport.

## Pages

| Page | Controls and meaning |
| --- | --- |
| **Connectors** | Administrators create GitHub or Azure DevOps connectors with a fixed source and authentication references. Select a connector to view/copy its delivery URL or labeled relative path. Owners/admins edit label, state and rate; only administrators replace authentication references. Revoke requires confirmation. |
| **Bindings** | Owners/admins configure an allowlisted equality/inclusion filter and a fixed `create_session`, `raise_signal` or `enqueue_prompt` action. Edits, dry runs and confirmed revocation use the selected binding. |
| **Approved templates** | Administrators approve creation policy: fixed source, namespace, agent/model settings, instruction and allowlisted event fields. Owners can edit label/state; config/prompt changes require admin. Source and owner are immutable after creation. |
| **Session signals** | Choose an ordinary session from the visible catalog or enter its exact authorized ID. Inspect the current signal wait and buffered metadata, mint/revoke generic endpoints, or raise a signal manually. System/service sessions and group rows are not webhook targets. |
| **Receipts** | Filter by connector, endpoint, session, status or exclusive receipt-ID cursor. Page newest-first (25 by default; maximum 100). Inspect redacted chronological timeline, attempts, duplicate/replay counts, last error and next attempt time. Select the receipt's session using ordinary authorized navigation. |
| **Health** | Viewer-scoped bounded counts by provider/status, pending/dead-letter totals and oldest ages. These are receipt/error facts, not proof that configured authentication works. |

Press **Refresh** / `r` to read current server metadata. Receipt **Older** /
**Newer** pages retain the filters. **Newest**, or applying filters without a
cursor, returns to the newest matching page. **Related receipts** scopes the
receipt page to the selected connector/endpoint, or to the selected signal
session when no endpoint is selected.

### Connector delivery address

Selecting a connector shows its delivery address as plain text. When the host
supplies `bootstrap.webhooks.publicOrigin`, the UI appends
`/hooks/c/<connectorId>` (with the ID encoded as one path segment) to that
host-normalized origin. Without an origin, it shows **Relative delivery path**
and copies only `/hooks/c/<connectorId>`; it never invents a hostname or infers
one from the browser, environment or private transport options.

Use **Copy delivery URL** / **Copy relative path** in the portal, or `c` on the
native Connectors page. This is a **public connector ID, not a bearer
capability**: the address remains available when the connector is listed again,
and provider authentication is still required. Copying does not open the URL,
fetch it or test a delivery. Disabled ingress does not prevent viewing/copying
the address or preparing policies.

### Fixed policy and JSON fields

JSON editors are labeled config inputs, never JavaScript or executable
expressions. Invalid JSON is rejected before a request is sent. The source
fields are `repositoryId`, optional `projectId` (required for Azure DevOps),
and optional operator-attested `buildDefinitionId`.

Binding filters support equality and nonempty inclusion arrays on:
`provider`, `eventType`, `action`, `repositoryId`, `repository`, `projectId`,
`pullRequestNumber`, `buildId`, `buildDefinitionId`, `ref`, `status`,
`conclusion`, `title` and `url`. There is no arbitrary JSONPath.

Examples of **fixed action** JSON:

```json
{"type":"raise_signal","sessionId":"<authorized-session-id>","signalName":"ready","wake":false}
```

```json
{"type":"enqueue_prompt","sessionId":"<authorized-session-id>","prompt":{"instruction":"Review this event as untrusted data.","fields":["title","eventType"]}}
```

```json
{"type":"create_session","templateId":"<approved-template-id>"}
```

Coalescing is **off unless explicitly configured** on `create_session`:

```json
{"type":"create_session","templateId":"<approved-template-id>","coalescing":{"key":"repository_pull_request","onMatch":{"type":"noop"}}}
```

`onMatch` can also be a `raise_signal` (signalName, optional wake) or
`enqueue_prompt` (prompt) action; the server chooses the existing coalesced
session. Event data cannot supply tools, owner, namespace, model or target
identity. Source, namespace and destination authorization are rechecked on
each actual delivery.

**Dry run** accepts a normalized event object, not a raw provider request. Its
`authorizationScope: "persisted_policy"` means only persisted policy was
checked. It does not execute an action or contact a provider, and does not
guarantee host placement, model admission or successful delivery.

### References, not credentials

GitHub authentication config is
`{"mode":"github-hmac-sha256","secretRef":"REFERENCE_NAME"}`. Azure DevOps uses
`{"mode":"ado-basic","usernameRef":"USERNAME_REFERENCE","passwordRef":"PASSWORD_REFERENCE"}`.
Reference names must match `[A-Z][A-Z0-9_]{0,63}` and resolve through
deployment-approved **server configuration**. Do not paste secrets or reuse
model-provider tokens. Saved references are not returned by reads; the edit
form starts blank and blank leaves authentication unchanged.

Generic endpoints optionally accept an admin-only `hmacSecretRef`. Expiry
defaults to **30 days**, with a **90-day** maximum. Maximum uses is optional;
per-endpoint/connector/binding rate defaults to **60/min**, maximum **600/min**.
The server applies its additional quotas and target policy.

### One-time capability dialog

A successful endpoint mint displays its URL and token **once**. Anyone holding
them can send the configured signal. The URL is plain text, never a link to
open or a request to execute. Copy occurs only through **Copy capability URL**
or native `c`.

The controller keeps the secret outside shared state, selectors, profile
settings, events and status messages. Closing, switching pages/sessions,
leaving Settings, changing identity/role or disposing the controller clears it.
Listing endpoints cannot recover it. A pending mint that completes after
navigation does not reopen the dialog. Refresh and revoke an endpoint whose
capability you did not retain. Clearing the UI cannot erase screenshots,
terminal scrollback or the clipboard.

### Acceptance is not consumption

- `received` / `authenticated` / `normalized` / `matched`: accepted for
  processing; not yet queued or consumed.
- `routed`: routing accepted, not confirmed consumed.
- `queued`: durably queued; consumption is not yet confirmed.
- `consumed`: the session consumed the signal.
- Rejected, dropped, expired, rate-limited, routing-failed or dead-lettered
  receipts retain their distinct status, error and timeline.

Manual raise sends only the fixed session/name and optional inert `data`,
`payloadRef`, `signalId`, `wake`. Payload references are never opened or
fetched. A successful manual raise reports **queued**, not consumed. Current
`signalWait` metadata keeps first-event/race versus interruptible waits and
indefinite versus deadline waits distinct.

**Replay** always opens the shared confirmation dialog. Only confirmation
sends `{confirmed:true}`; there is no auto-replay or mutation retry. Replay
may create a session, enqueue a prompt or raise a signal and remains subject
to current policy and replay limits. **Revoke** is a separate confirmed
operation; it does not delete, terminate or cancel a session.

Edits capture `expectedRevision` from the selected resource. A conflict refreshes
metadata, retains the draft/error and blocks re-submission until the operator
closes and reopens the edit. The UI never silently retries with a newer revision.
After a timeout or lost connection, refresh before deciding whether to submit
another action: the outcome may be unknown.

## Native interaction

Within Webhooks, `1`–`6`, `Tab`/`Shift+Tab` or left/right arrows change page.
`j`/`k` (or arrows) select a resource; `Ctrl+U`/`Ctrl+D` or PageUp/PageDown
scroll details. On Connectors, `c` copies the selected delivery URL/relative path.
`n` creates, `e` edits, `d` requests revocation, `t` opens a
binding dry run, `s` chooses a session, `u` raises a signal, `f` edits receipt
filters, `p` requests replay, `o` selects the receipt's session, and `v` opens
related receipts. `[`/`]` page receipts newer/older. `r` refreshes, `m` returns
to My Providers, and `Esc` closes the console.

In a form, `Tab`/`Shift+Tab` changes field, arrows choose enum/session
suggestions, left/right/Home/End moves the text cursor, Backspace deletes,
`Ctrl+J` adds a JSON newline, `Enter` submits and `Esc` cancels. Typed workspace
shortcuts (including `q`) are text, not hidden session actions. In the
one-time capability view, `c` copies, PageUp/PageDown or `Ctrl+U`/`Ctrl+D`
scroll, and `Esc` erases the view.

See [Keybindings](keybindings.md) for the full terminal reference and the
[backend webhook guide](../developer/building/webhooks.md) for deployment and
ingress contracts. This UI does not register providers, test external
deliveries or deploy ingress.
