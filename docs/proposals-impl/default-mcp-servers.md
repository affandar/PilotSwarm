# Fleet-Default MCP Servers — Design Sketch

How a repo-pinned worker grants every session a set of **default MCP servers
that are NOT checked into the target repo** — the canonical case being the
Azure DevOps MCP — so a session can (e.g.) look up a work item even when the
repo's `.vscode/mcp.json` never declares an ADO server.

This is the third source of MCP servers, layered on top of the existing two,
and it reuses the delegated-auth machinery from
[`delegated-mcp-upstream-auth.md`](./delegated-mcp-upstream-auth.md) unchanged
for the connect-time token injection.

## Problem

Today a worker's sessions get MCP servers from exactly two places:

1. **Plugin catalog** — `.mcp.json` in a plugin dir; servers tagged
   `"default": true` are granted to agents that opt in with
   `inheritDefaultMcpServers: true` (`packages/sdk/src/mcp-loader.ts`
   → `loadMcpConfig`).
2. **Repo-declared** — `<enlistment>/.vscode/mcp.json`, loaded by
   `loadRepoMcpConfig` and passed as the worker's direct `mcpServers` so every
   session on the (repo-pinned) worker gets them. Curated by `REPO_MCP_ALLOW`.

Both are **opt-in by the repo**. There is no way to say "every session on this
fleet should be able to talk to ADO," short of asking each target repo to
check an `ado` server into its `.vscode/mcp.json` — which the operator does not
control and which pollutes those repos' developer configs. Concretely: a session
asks its agent to "look up work item 12345" and it cannot, because that repo's
`.vscode/mcp.json` never declared an ADO MCP server.

## Goal / non-goals

**Goal.** A deploy-time, fleet-level set of **remote** MCP servers injected into
every session on a worker, independent of the target repo's files, authenticated
**as the caller** via the existing discovery flow.

**Non-goals.** No new auth model (reuse delegated caller-token injection); no
stdio defaults (a fleet default runs on a Linux worker pod, so remote only); no
server→audience table in source (this code is public — audience is still
discovered at runtime).

## The ADO MCP connection string

The full remote Azure DevOps MCP is served per-organization at:

```
https://mcp.dev.azure.com/<org>
```

So a fleet targeting organization `<org>` would carry:

```json
{
  "servers": {
    "ado": {
      "type": "http",
      "url": "https://mcp.dev.azure.com/<org>",
      "tools": ["*"]
    }
  }
}
```

- **No `Authorization` header in config.** The worker's pre-flight discovery
  (`resolveMcpServerAuth` → `discoverServerAudience`) probes the server, reads
  the RFC 6750 `WWW-Authenticate` challenge, follows the RFC 9728 PRM document,
  and learns the required audience (the Azure DevOps first-party resource). It
  then injects the caller's ADO-audience bearer. This is the *same* audience any
  other Azure DevOps-backed server already requires, so the caller-token map
  (`ps-caller-<sessionId>`) today already satisfies it — **no new token
  plumbing**.
- **Optional toolset narrowing** — the ADO MCP exposes a large surface; it can
  be trimmed with an `X-MCP-Toolsets` request header
  (e.g. `core,work-items,repositories,search`) to cut tool count / context.

> URL-free-source rule: the concrete URL + org live ONLY on the deploy side (a
> per-fleet deploy value, substituted like the other deploy tokens), never in
> the public base manifest.

## Design

### 1. New config source: `DEFAULT_MCP_JSON`

A new deploy token carrying an inline JSONC `{ "servers": { … } }` map (same
schema as `.vscode/mcp.json`), surfaced to the worker as an env var:

- Set per-fleet on the deploy side and substituted into the worker base manifest
  by the deploy tooling (a new `__DEFAULT_MCP_JSON__` token, plumbed exactly like
  `__PLUGIN_SPEC__`).
- Optionally a cluster-wide default in the `worker-env` ConfigMap that a per-fleet
  value overrides. (Fleets that share one org can use a single cluster default;
  per-fleet keeps org/toolset flexibility.)

### 2. New loader: `loadDefaultMcpConfig`

Add to `packages/sdk/src/mcp-loader.ts`, sharing internals with
`loadRepoMcpConfig`:

- Parse the value as JSONC (`parseMcpJsonc`), accept the `{ servers }` wrapper
  or a flat map.
- `remoteOnly` is forced true (a fleet default is never a local stdio server).
- Normalize like repo servers: missing/empty `tools` → `["*"]`; skip entries
  still carrying unresolved `${input:…}`/`${command:…}`.
- **Mark each default server `optional: true`** (see §4).

### 3. Merge + precedence (worker assembly)

In `packages/sdk/examples/git-repo-worker.js`, where `mcpServers` is currently
just `repoMcpServers`:

```js
const defaultMcpServers = loadDefaultMcpConfig(process.env.DEFAULT_MCP_JSON, { trace });
// repo-declared wins on a name clash (a repo may pin `ado` with a narrower
// toolset); log the override.
const mcpServers = { ...defaultMcpServers, ...repoMcpServers };
```

Both maps flow through the **same** per-session `resolveMcpServerAuth`
resolution, so the default ADO server gets the caller's ADO token with zero new
auth code. `REPO_MCP_ALLOW` continues to gate only repo servers; defaults are
always present (that is the point).

### 4. Best-effort (optional) semantics for defaults

Repo-declared servers **fast-fail** the session when the caller has no token for
their audience (the repo explicitly asked for them). A fleet default is injected
*without the caller asking*, so fast-failing would break every session that never
intended to use ADO. Therefore:

- Add a platform-only `optional?: boolean` tag (stripped before the config
  reaches the Copilot CLI, like `default`).
- Extend `resolveMcpServerAuth`: for a server with `optional: true`, when the
  provider returns no token for the discovered audience, **skip** it (drop from
  the map) instead of fast-failing. This is exactly the phase-2 "skip instead of
  fast-fail" behavior already flagged as a TODO in `mcp-auth-discovery.ts`,
  scoped narrowly to optional defaults first.

Net: a session with an ADO caller token gets the ADO MCP; a session without one
silently runs without it; repo-declared servers keep today's strict behavior.

### Server sources after this change

| Source | File / token | Scope | Auth | On missing caller token |
|---|---|---|---|---|
| Plugin catalog | plugin `.mcp.json` `default:true` | agent opt-in | n/a (mostly stdio/local) | n/a |
| Repo-declared | `<enlistment>/.vscode/mcp.json` | every session (curated by `REPO_MCP_ALLOW`) | delegated caller token | **fast-fail** |
| **Fleet-default (new)** | `DEFAULT_MCP_JSON` (.env/ConfigMap) | every session, repo-independent | delegated caller token | **skip (optional)** |

## Exit criteria

1. **Injected without the repo:** a session on a fleet configured with the ADO
   default, running against a repo whose `.vscode/mcp.json` declares **no** ADO
   server, has the `ado` MCP available.
2. **It actually works:** a prompt such as *"look up Azure DevOps work item
   `<id>` and report its creation date"* drives the `ado` server's work-item tool
   to **complete successfully** (`TOOL_COMPLETED`, `success=true`) and the reply
   contains that work item's **immutable** creation date. (An immutable field is
   used deliberately — a title/state can be edited and would make the check
   flaky.)
3. **Delegated-auth invariants preserved:** the ADO server is reached with the
   **caller's** ADO-audience token, never the worker MI. A session with no
   ADO-audience caller token **drops** the default (optional) and still runs;
   it does not fast-fail.
4. **No repo regression:** repo-declared servers and `REPO_MCP_ALLOW` behavior
   are unchanged; a repo that declares its own `ado` overrides the default
   deterministically (logged).
5. **URL-free source:** the concrete ADO URL/org appear only in the deploy-side
   value; the public base manifest carries only the `__DEFAULT_MCP_JSON__` token.

## Acceptance test

An end-to-end test that exercises the feature against a real fleet:

- Targets a repo whose enlistment declares **no** `ado` server in
  `.vscode/mcp.json`, and attaches **no** MCP server of its own — so any `ado`
  server that shows up must be the fleet default (not the repo, not the caller).
- Runs as a caller with Azure DevOps access (the default server is reached as the
  caller), and otherwise supplies nothing about the server — no audience, no URL:
  a caller does not need to know anything about a default server.
- Submits a work-item lookup prompt and asserts an `ado` work-item tool
  **completes successfully**, and (stronger) that the reply contains the work
  item's **immutable creation date** — a mutable field like the title/state would
  make the check flaky.
- **Exit codes:** `0` PASS / `1` FAIL (feature absent: no default server, the tool
  never runs) / `2` SKIP (infra unreachable or no credential). Wire as an
  **expected-fail** until the feature is deployed; it flips green once it is.

Plus unit tests (SDK): `loadDefaultMcpConfig` parse/normalize; merge precedence
(repo overrides default); `resolveMcpServerAuth` optional-skip vs. repo
fast-fail.

## Rollout

1. Land SDK changes (`loadDefaultMcpConfig`, `optional` tag, merge in
   `git-repo-worker.js`, `resolveMcpServerAuth` optional-skip) + unit tests.
2. Build a new uniquely-tagged worker image (worker JS is baked in).
3. Add `__DEFAULT_MCP_JSON__` to the worker base manifest + deploy tooling; set
   the ADO default per-fleet on the deploy side (or the cluster `worker-env`
   ConfigMap).
4. Roll fleet-by-fleet (DaemonSet `maxUnavailable:1` + truthful readiness);
   run the default-MCP acceptance client against each fleet to confirm green.

## Open questions

- **Cluster-wide default vs. per-fleet value.** Fleets that share one org can use
  a single ConfigMap default; a per-fleet value is only needed if a fleet wants a
  different org or toolset. Start cluster-wide, allow a per-fleet override.
- **Toolset trimming.** Ship `X-MCP-Toolsets` (e.g. `core,work-items,search`) on
  the default ADO entry to cap tool count, or leave `["*"]` and revisit if
  context bloat shows up.
- **Generalize `optional` to phase-2.** This introduces optional-skip narrowly;
  consider whether repo-declared servers should also move from fast-fail to skip
  (the broader phase-2 TODO in `mcp-auth-discovery.ts`).
