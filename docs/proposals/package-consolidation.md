# Package Consolidation

## Decision

Collapse nine `packages/` directories into **three packages**: the app, the
SDK, and the one optional provider with a real install boundary.

| Package | Role | Bins | Published |
|---|---|---|---|
| **`pilotswarm`** (new) | The application: TUI + portal server + portal web UI + MCP server + shared UI layer | `pilotswarm`, `pilotswarm-web`, `pilotswarm-mcp` | ✅ |
| **`pilotswarm-sdk`** | Runtime (worker, orchestration, stores) **plus the wire contract** as a browser-safe subpath `pilotswarm-sdk/api` | — | ✅ |
| **`pilotswarm-horizon-store`** | Optional enhanced-facts/graph provider (heavy deps, dynamically imported) | — | ✅ |

`cli`, `portal`, `mcp-server`, `ui-core`, and `ui-react` merge into
`pilotswarm`. `api-client` folds into the SDK. The dead `sessionfs-pg/`
directory is deleted.

## Why the app merge is right (evidence, not taste)

The five app packages are one application pretending to be five libraries:

1. **They already ship as a unit.** `deploy/Dockerfile.portal` COPYs
   `cli/ + portal/ + ui-core/ + ui-react/` sources into one image today. The
   package boundaries buy nothing at deploy time; they only add build steps and
   version-sync churn.
2. **The layering is inverted.** `pilotswarm-web` (a server) depends on
   `pilotswarm-cli` (nominally a terminal app) via the `pilotswarm-cli/portal`
   subpath for `NodeSdkTransport` and plugin/config resolution. That shared
   node-host layer belongs in a common `src/host/` of one app package.
3. **The registry doesn't know about half of them.** `pilotswarm-mcp-server`
   was never published; `ui-core`/`ui-react` are private. Only `cli` and `web`
   have external installers — and they're versioned in lockstep anyway.
4. **No dependency conflicts.** The CLI already runs Ink 6 + React 19 alongside
   `ui-react`; the portal's Express/ws/jose and MCP's hono trees are small.
5. **The framework-free `ui-core` seam is speculative.** Both renderers are
   React (Ink and DOM). Keep the split as internal folders, not packages.
6. **The bare npm name `pilotswarm` is free.** One install gives users all
   three bins, whose names don't change — nothing user-facing moves.

## Why `api-client` folds into the SDK

The separate wire-contract package was designed so browsers/edge runtimes could
talk to a deployment without installing the SDK. Scrutinized, that boundary
defends a consumer that doesn't exist, at the cost of bugs that did:

- **Every consumer is in-repo, and all but one already depend on the SDK**
  (cli, mcp-server, portal server, the SDK itself). The one exception is the
  portal's browser bundle (`portal/src/browser-transport.js`), which Vite
  bundles from source — a bundler tree-shakes a subpath import just as happily
  as a separate package.
- **It was never published.** External browser consumers: zero. And the
  unpublished-workspace-dep arrangement has already caused real defects — the
  MCP server silently built against a stale registry `0.1.35` copy, then needed
  a `prepack` bundling hack to be installable at all. Folding into the
  (published) SDK deletes that entire failure class.
- **Protocol versioning doesn't need npm.** The wire contract is versioned in
  the URL (`/api/v1`); an independent package version added nothing.

**Design:** move the source (operations table, `ApiClient`,
`HttpApiTransport`) to `packages/sdk/src/api/` and expose it as a dedicated
`exports` subpath — `pilotswarm-sdk/api` — whose module graph stays exactly what
`api-client` is today: zero dependencies, zero Node builtins (verified: it has
neither).

**The one real risk** of losing the package boundary is browser-safety drift —
someone imports a Node-flavored SDK helper into the api subgraph and browsers
break at bundle time. Replace the structural guarantee with a CI guard: a test
that bundles `pilotswarm-sdk/api` with `esbuild --platform=browser` and fails on
any `node:*` (or external) resolution. Weaker than a package boundary, adequate
for an in-repo invariant.

If a genuine external browser/edge consumer ever materializes, the code is
still one isolated zero-dep folder — extracting it back into a package is
mechanical. Don't pay for it before then.

## Why `horizon-store` stays (the one hard boundary)

It carries heavy optional deps (Apache AGE graph, embedding SDKs). The SDK
loads it via dynamic `import()` + `peerDependency`, so base installs never
download it. This is the only remaining boundary where "separate package"
changes what a consumer downloads — everywhere else it only changed what we
maintain.

## Target layout

```text
packages/
  app/            → publishes "pilotswarm"        (bins: pilotswarm, pilotswarm-web, pilotswarm-mcp)
    src/tui/        (former cli/src)
    src/web/        (former portal/, minus dead portal/src/components TSX)
    src/mcp/        (former mcp-server/src)
    src/host/       (former pilotswarm-cli/portal subpath: NodeSdkTransport, plugin/config resolution)
    src/ui/core/    (former ui-core/src)
    src/ui/react/   (former ui-react/src)
    plugins/        (former cli/plugins — worker image copies these)
  sdk/            → pilotswarm-sdk
    src/api/        (former api-client/src; exported as "pilotswarm-sdk/api", browser-safe)
  horizon-store/  → pilotswarm-horizon-store
```

## Migration plan

Phased so each step lands green on its own:

1. **Delete `packages/sessionfs-pg/`** (no `package.json`, no source — a stale
   `dist/` + `node_modules/`). Zero risk, do first.
2. **Fold `api-client` into the SDK**: move to `src/api/`, add the
   `"./api"` exports subpath, add the esbuild browser-safety CI guard, delete
   the MCP `prepack` bundling hack, and update in-repo imports
   (`pilotswarm-api-client` → `pilotswarm-sdk/api`). Update the docs that
   currently point at the unpublished package (`docs/api/reference.md`,
   `docs/sdk/facts-and-graph.md`, package READMEs).
3. **Create `packages/app`** named `pilotswarm@0.4.0`; `git mv` the five app
   packages per the layout above. Cross-package imports become relative; the
   `pilotswarm-cli/portal` public subpath becomes internal `src/host/`. Bin
   names unchanged.
4. **Rewire the build**: root chain drops from 7 steps to 3
   (sdk → horizon-store → app). Update `deploy/Dockerfile.portal` /
   `Dockerfile.worker` COPY paths and workspace test scripts.
5. **Registry hygiene**: `npm deprecate pilotswarm-cli` / `pilotswarm-web` with
   a pointer to `pilotswarm`; ship one final passthrough release of each so
   existing installs keep working. Fix CONTRIBUTING.md's stale inventory.

The existing suites — webapi E2E, portal router, cli, ui, mcp, contracts — are
the acceptance gate at each phase.

## Risks

- **Browser-safety of `pilotswarm-sdk/api`** — covered by the esbuild CI guard
  above; the subgraph is already clean (zero deps, zero Node builtins).
- **Import-path churn** across cli/portal/ui sources — mechanical, verified by
  build + tests.
- **Docker layer caching** — COPY paths change once; image contents are the
  same files.
- **External `pilotswarm-cli`/`pilotswarm-web` installers** — deprecation
  notices + passthrough releases keep `npx pilotswarm-cli` working during
  transition.

## Net effect

| | Before | After |
|---|---:|---:|
| Directories under `packages/` | 9 | 3 |
| Packages to version | 8 | 3 |
| Published names (actual registry) | 4 | 3 |
| Private/unpublished packages | 4 | 0 |
| Root build steps | 7 | 3 |
| `web → cli` layering inversion | yes | gone |
| api-client bundling hack + drift bugs | yes | gone |
