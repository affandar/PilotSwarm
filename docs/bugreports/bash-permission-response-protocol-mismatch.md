# Bug: built-in `bash` permission callback can receive the wrong protocol response shape

**Status:** Fix in progress  
**Filed:** 2026-04-24  
**Component:** `@pilotswarm/sdk` session permission handling through `@github/copilot-sdk` / bundled Copilot CLI  
**Affected versions:** observed in a downstream AKS worker running `pilotswarm-sdk 0.1.22`, `@github/copilot-sdk 0.2.2`, and `@github/copilot 1.0.36`  
**Severity:** High for agents that rely on built-in shell tools; custom PilotSwarm `defineTool()` tools continue to work

## Symptom

A downstream agent was instructed to publish a markdown report by using the built-in `bash` tool to run the documented workload-identity + ADO git flow. The turn failed before any Azure DevOps git authentication could be exercised, with:

```text
Error: unexpected user permission response
```

The same ADO git flow succeeds when executed directly inside the live worker pod:

```text
git ls-remote --heads ... refs/heads/<branch-name>  -> succeeds
git push --dry-run origin HEAD:<branch-name>        -> Everything up-to-date
```

That rules out missing binaries, missing workload identity, and missing ADO repo permission as the primary cause.

The live worker package versions were confirmed from `/app/node_modules/*/package.json`:

```text
@github/copilot-sdk 0.2.2
@github/copilot 1.0.36
pilotswarm-sdk 0.1.22
```

## Why this points at permission protocol handling

The public Copilot SDK `0.2.x` contract said `onPermissionRequest` is required for shell commands and other gated tools. The documented approval result was:

```ts
return { kind: "approved" };
```

PilotSwarm `0.1.22` followed that contract in `packages/sdk/src/session-manager.ts`:

```ts
onPermissionRequest: (config as any).onPermissionRequest ?? (async () => ({ kind: "approved" as const })),
```

The same SDK-level approval shape is used by the session resume/destroy fallback path in `SessionManager` and by the one-shot title summarizer path in `SessionProxy`.

The SDK bridge then calls the handler and sends the result back through `session.permissions.handlePendingPermissionRequest`.

However, the bundled Copilot CLI has a separate internal interactive permission prompt protocol. The internal mapper that throws this exact error accepts these user-response shapes:

```text
approve-once
approve-for-session
approve-for-location
reject
user-not-available
```

and maps them to SDK-level final permission results such as `{ kind: "approved" }`.

So the error strongly suggests that an SDK-level final result (`{ kind: "approved" }`) is being routed into the CLI's interactive prompt-response mapper, where it expects a pre-result UI answer such as `{ kind: "approve-once" }`.

## Current understanding

There are two similar but distinct permission protocols in play:

| Layer | Purpose | Approval shape |
|---|---|---|
| Public `@github/copilot-sdk` `onPermissionRequest` | User code returns the final decision for a pending permission request | `{ kind: "approved" }` |
| Copilot CLI interactive prompt UI | UI answers a concrete prompt and chooses a scope | `{ kind: "approve-once" }`, `{ kind: "approve-for-session", ... }` |

PilotSwarm appears to be doing the public SDK thing correctly. The failure appears when the built-in `bash` permission flow crosses into the CLI's UI-prompt vocabulary.

## Why this matters

PilotSwarm agents are told that `bash` is a framework tool available to normal sessions, and downstream worker images include the expected binaries (`bash`, `git`, `az`, etc.). When the built-in shell permission bridge fails, agents cannot use documented shell-based workflows even though:

1. the model sees `bash` as an available tool,
2. the worker container can run the command,
3. `onPermissionRequest` is configured to approve the tool call, and
4. the target external system credentials are valid.

This pushes downstream apps toward narrow custom tools for every shell-backed workflow, even when a general built-in shell tool should be sufficient.

## Reproduction sketch

Minimal downstream-style reproduction:

1. Create or resume a PilotSwarm session with inherited framework tools including `bash`.
2. Use a PilotSwarm build paired with `@github/copilot-sdk` `0.2.2` and `@github/copilot` `1.0.36`, where the default permission handler returns `{ kind: "approved" }`.
3. Ask the agent to call built-in `bash` for a non-read-only command, for example a git command requiring permission.
4. Observe whether the turn fails with `unexpected user permission response` before the command runs.

A local repro script is available at `scripts/repro-bash-permission.mjs`. It creates an isolated PilotSwarm worker/client pair, forwards a function-valued `onPermissionRequest` handler into the colocated worker with `worker.setSessionConfig()`, logs the permission request shape, returns PilotSwarm's default permission result, and asks the agent to run the built-in `bash` tool.

A good focused regression test would use a trivial shell command rather than ADO:

```text
Ask the agent to run: bash(command="echo permission-probe")
```

and assert that the command executes successfully under an approving `onPermissionRequest` handler.

## Proposed investigation

1. Instrument `SessionManager`'s `onPermissionRequest` wrapper to log:
   - `request.kind`
   - `request.fullCommandText` for shell requests
   - the returned result kind
2. Reproduce with a trivial built-in `bash` call.
3. Confirm whether PilotSwarm returns the SDK `0.2.x` `{ kind: "approved" }` shape and the bundled Copilot CLI still throws `unexpected user permission response`.
4. Inspect whether `@github/copilot-sdk` is using the direct `session.permissions.handlePendingPermissionRequest` path or accidentally going through the CLI UI prompt path for built-in shell tools.

## Audit notes

- `SessionManager.getOrCreate()` now passes the SDK session config with `onPermissionRequest: (config as any).onPermissionRequest ?? approvePermissionForSession`.
- `SessionManager.dehydrateSession()` uses `approvePermissionForSession` when it needs to resume a session during destroy retry cleanup.
- `SessionProxy`'s one-shot summarizer uses `approvePermissionForSession` when creating its temporary SDK session.
- `PilotSwarmClient.createSession()` only stores serializable session fields locally; function-valued handlers such as `onPermissionRequest` must be forwarded to the worker with `worker.setSessionConfig()` in colocated/local test setups. Remote worker setups need worker-owned defaults or a serializable permission policy rather than trying to send functions through orchestration input.
- `@github/copilot-sdk` documents `{ kind: "approved" }` as the approval result and sends it through `session.permissions.handlePendingPermissionRequest`.
- The bundled `@github/copilot` CLI contains a separate interactive mapper that throws `unexpected user permission response` unless it receives UI prompt responses such as `approve-once`, `approve-for-session`, `approve-for-location`, `reject`, or `user-not-available`.

## Version history finding

The response shape did change in the Copilot package line:

| Package version | `session.permissions.handlePendingPermissionRequest.result` accepted kinds |
|---|---|
| `@github/copilot` `1.0.32` | `approved`, `denied-by-rules`, `denied-no-approval-rule-and-could-not-request-from-user`, `denied-interactively-by-user`, `denied-by-content-exclusion-policy`, `denied-by-permission-request-hook` |
| `@github/copilot` `1.0.33` | same as `1.0.32` |
| `@github/copilot` `1.0.34` | same as `1.0.32` |
| `@github/copilot` `1.0.35` | adds `approved-for-session` and `approved-for-location`, while still accepting `approved` |
| `@github/copilot` `1.0.36` | `approve-once`, `approve-for-session`, `approve-for-location`, `reject`, `user-not-available` |

`@github/copilot-sdk` also changed in `0.3.0`: its exported `approveAll` helper now returns `{ kind: "approve-once" }`. In `0.2.2`, `approveAll` returned `{ kind: "approved" }`.

That means the problematic pairing is specifically `@github/copilot-sdk` `0.2.2` with `@github/copilot` `1.0.36`. The SDK still returns/sends the old final-decision vocabulary, while the CLI JSON-RPC schema now expects the interactive prompt-response vocabulary.

PilotSwarm `0.1.22` declares `@github/copilot` as `^1.0.32` and `@github/copilot-sdk` as `^0.2.2`, while `@github/copilot-sdk` `0.2.2` itself depends on `@github/copilot` `^1.0.21`. A fresh downstream install can therefore resolve `@github/copilot` to `1.0.36` while keeping `@github/copilot-sdk` at `0.2.2`, producing the observed mismatch.

## Resolution

PilotSwarm is being updated to `@github/copilot-sdk` `0.3.0` and `@github/copilot` `1.0.36` together. The default permission handler now returns the SDK `0.3.0` response vocabulary.

For session-approvable requests, PilotSwarm returns `{ kind: "approve-for-session", approval: ... }`. Shell requests map to command approvals using the SDK-provided `commands[].identifier` values. Request kinds that do not have a session-approval shape fall back to `{ kind: "approve-once" }`.

## Potential fixes

### Preferred: keep SDK and CLI package versions aligned

Ensure `@github/copilot-sdk` and `@github/copilot` are updated together so the SDK's permission handler result type matches the CLI JSON-RPC schema.

The contributor instructions now call this out explicitly for future Copilot SDK dependency updates.

### Defensive downstream mitigation

For specific production workflows such as publishing markdown reports to ADO, add a narrow worker-side `defineTool()` (for example `publish_ado_markdown_report`) that performs the operation without relying on the built-in shell permission bridge.

This is safer than overriding the global built-in `bash` tool, but it should not be the long-term answer for general shell support.

## Verification

After a fix:

1. A PilotSwarm session with the default approving permission handler can execute a trivial built-in `bash` command.
2. Non-read-only shell commands that require permission no longer fail with `unexpected user permission response`.
3. Existing custom `defineTool()` tools remain unaffected.
4. A downstream ADO markdown publish flow can run through built-in `bash` if the workflow chooses to use the shell path.
