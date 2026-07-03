# Docs Overhaul

## Goal

Reorganize `docs/` into five audience-first sections:

1. **Quick Start** — Docker starter first, running in minutes
2. **User Guide** — using the TUI and portal (exists, already good)
3. **Architecture** — how the system works, from the layering picture down
4. **API Reference** — the Web API and every client surface over it
5. **Developer Guide** — building ON PilotSwarm, and contributing TO it

The last reorg (March, `documentation-audit.md`) fixed persona routing for
SDK/CLI app builders, but the tree has since grown sideways: the Web API era
(June–July) produced current docs that the hub never picked up, while several
pre-Web-API docs still describe a world where clients open SQL connections.

## What the audit found

**The hub is blind to the newest, most important docs.** `docs/README.md` has
no link to `api/reference.md`, `layering.md`, or `sdk/facts-and-graph.md` —
there is no "build your own UX over the Web API" path at all, even though that
is now the primary integration surface.

**Three docs actively mislead** (written before the Web API, never updated):

- `layer-diagram.md` (Mar 6) — app layering with direct client-to-store wiring
- `component-interactions.md` (Mar 9) — message flows that bypass the seam
- `tui-apps.md` — describes an AppAdapter framework that does not exist

**Legacy trio still linked from the root README**: `building-apps.md`,
`writing-agents.md`, `guide.md` — all marked legacy in March, all still
receiving traffic from inbound links.

**Point-in-time debris mixed with living docs**: `tui-cleanup-status.md`,
`agent-tuning-log.md`, `models/eval-2026-03-24.md`, `documentation-audit.md`,
`orchestration-hardening-plan.md`, and an **empty file**
(`contributors/nano-bonanza-review-guide.md`, 0 lines).

## Target tree

```text
docs/
  README.md                       ← rewritten hub: 5 sections, one screen
  quickstart/
    docker.md                     ← getting-started-docker-appliance.md (THE quick start)
    local.md                      ← getting-started.md (from-source / manual Postgres)
  user-guide/                     ← unchanged shape (README, tui.md, portal.md)
    keybindings.md                ← moved from docs/
  architecture/
    README.md                     ← new 1-pager: start at layering, then descend
    layering.md                   ← moved; the "one way in" map (entry point)
    system.md                     ← architecture.md (the deep dive)
    system-reference.md           ← file map, CMS schema, invariants
    orchestration/
      design.md                   ← orchestration-design.md
      loop.md                     ← orchestration-loop.md
    internals/                    ← cms-schema.md, session-manager.md (as-is)
    facts.md                      ← facts-table.md (design spec)
    session-creation-policy.md
    tui.md                        ← tui-architecture.md
    component-interactions.md     ← REWRITE for the Web API era (or fold into layering)
  api/
    reference.md                  ← as-is (generated from the ops table)
    building-a-custom-ux.md       ← NEW: bootstrap → subscribe → replay loop,
                                     browser Entra auth for third-party SPAs,
                                     pointer to HttpApiTransport
    clients.md                    ← NEW short index: ApiClient / SDK web clients /
                                     WebFactStore / MCP — which to use when
                                     (links to package READMEs, which stay canonical)
  developer/
    README.md                     ← landing: "building on" vs "contributing to"
    building/
      sdk-apps.md                 ← sdk/building-apps.md
      sdk-agents.md               ← sdk/building-agents.md
      facts-and-graph.md          ← sdk/facts-and-graph.md
      cli-apps.md                 ← cli/building-cli-apps.md
      cli-agents.md               ← cli/building-agents.md
      plugins.md                  ← plugin-architecture-guide.md
      builder-agents.md
      examples.md                 (+ blog-*.md filed under examples/)
    deploy/
      aks.md                      ← deploying-to-aks.md
      aks-topology.md
      entra-app-roles.md          ← portal-entra-app-roles.md
      harvester.md                ← harvester-deployment.md
      observability.md            ← signoz-observability.md
    reference/
      configuration.md
      agent-contracts.md          ← contracts/agent-contracts.md
    contributing/
      working-on-pilotswarm.md    ← landing (as-is)
      tui-implementor-guide.md
      local-test-spec.md, local-integration-test-plan.md
      facts-table-tests.md
  proposals/  proposals-impl/  bugreports/  inbox/    ← unchanged (design records)
  _archive/                       ← retired point-in-time docs (see below)
```

## Disposition of every current doc

| Doc | Disposition |
|---|---|
| getting-started-docker-appliance.md | → `quickstart/docker.md`, becomes the first thing the hub links |
| getting-started.md | → `quickstart/local.md` |
| user-guide/* | keep as-is (current: May–Jul) |
| keybindings.md | → `user-guide/` |
| layering.md, architecture.md, system-reference.md, orchestration-*.md, internals/*, facts-table.md, session-creation-policy.md, tui-architecture.md | → `architecture/` per tree above |
| api/reference.md | keep; add the two new companion docs |
| sdk/*, cli/*, plugin-architecture-guide.md, builder-agents.md, examples.md, blog-*.md | → `developer/building/` |
| deploying-to-aks.md, aks-topology.md, portal-entra-app-roles.md, harvester-deployment.md, signoz-observability.md | → `developer/deploy/` |
| configuration.md, contracts/agent-contracts.md | → `developer/reference/` |
| contributors/* (except empty file), tui-implementor-guide.md, facts-table-tests.md | → `developer/contributing/` |
| **component-interactions.md** | **rewrite** for the Web API world, or fold its sequence diagrams into `architecture/layering.md` and retire |
| **layer-diagram.md** | **archive** — superseded by layering.md + the plugin guide's app diagram |
| **guide.md, building-apps.md, writing-agents.md, tui-apps.md** | **archive** — merge any still-unique paragraphs into their successors first (writing-agents.md has the most salvageable detail) |
| **tui-cleanup-status.md, documentation-audit.md, agent-tuning-log.md, models/eval-2026-03-24.md, orchestration-hardening-plan.md, design-default-agent.md** | **archive** (point-in-time records; design-default-agent → `proposals-impl/`) |
| **contributors/nano-bonanza-review-guide.md** | **delete** (empty file) |

Net: 55 active docs → ~38 active (organized) + ~11 archived + 1 deleted +
3 new (`architecture/README`, `api/building-a-custom-ux`, `api/clients`).

## The new hub (docs/README.md)

One screen, five doors, in reading order:

```markdown
1. Quick Start      — running in 5 minutes with Docker
2. User Guide       — driving sessions from the TUI or portal
3. Architecture     — the layering map, then the deep dives
4. API Reference    — the Web API and every client over it
5. Developer Guide  — build on PilotSwarm / contribute to PilotSwarm
```

Root `README.md` gets the same five links; `CONTRIBUTING.md` points at
`developer/contributing/` and gets its stale package inventory fixed (lists
the dead `sessionfs-pg`, omits `api-client`/`horizon-store`).

## Content work (beyond moves)

Moves are cheap; these four are the real writing tasks:

1. **`api/building-a-custom-ux.md`** (new, ~150 lines) — the previously
   identified gap: bootstrap → WS subscribe → render → replay `afterSeq` on
   reconnect; browser Entra sign-in for a custom SPA (discover `/auth/config`,
   MSAL SPA flow, `getAccessToken` into `ApiClient`); when to grab
   `HttpApiTransport` instead of raw calls.
2. **`api/clients.md`** (new, ~60 lines) — the decision table: raw HTTP /
   `ApiClient` / SDK web clients / `WebFactStore`+`WebGraphStore` / MCP
   server, with the app-shaped-vs-UI-shaped guidance from the layering doc.
3. **`component-interactions.md` rewrite** — current diagrams show clients on
   SQL; every flow must route through the seam or the doc retires into
   layering.md.
4. **Legacy merge pass** — lift the still-unique content out of
   `writing-agents.md` / `guide.md` / `building-apps.md` into their
   successors before archiving.

## Migration mechanics

- `git mv` everything (history preserved); then a link-fix pass driven by
  `grep -rn "docs/<oldpath>"` across the repo (docs, package READMEs, root
  README, CONTRIBUTING, skills/agents that cite doc paths).
- No stub redirects: this is a repo, not a website — inbound links are all
  greppable and fixed in the same commit.
- Phases, each landing green:
  1. **Structure**: mkdir tree, `git mv`, fix links, rewrite hub + root README
     + CONTRIBUTING. (No prose changes — pure reorganization, easy review.)
  2. **New docs**: the two `api/` companions + `architecture/README.md`.
  3. **Content fixes**: component-interactions rewrite, legacy merge pass,
     archive sweep.
- Doc-path references in skills/agents (`pilotswarm-aks-deploy` etc.) checked
  in phase 1's grep.

## Non-goals

- No changes to `proposals/`, `proposals-impl/`, `bugreports/` — they are the
  design record, already fenced off from the onboarding path.
- No content rewrites of the healthy docs (architecture.md, user guides,
  reference.md) beyond link fixes.
- Package READMEs stay canonical for package-level detail; the docs tree
  links to them rather than duplicating.
