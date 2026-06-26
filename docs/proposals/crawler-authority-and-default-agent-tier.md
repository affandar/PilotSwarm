# Crawler Authority, Generic Crawler Agent, and Default Agent Tier

## Status

Proposed.

This proposal refines the crawler role after the prefix-scoped crawl controls
landed. It does not change runtime behavior by itself.

## Summary

Make `crawler: true` a trusted corpus-operation role with broad source-fact
authority, while keeping Facts Manager curation and maintenance powers separate.
Add a bundled generic crawler named agent that can guide an operator through
ingest, crawl, recrawl, delete reconciliation, and graph updates. Put that agent
in a new bundled default-agent tier, not in `system/` or `mgmt/`, and expose it
only when an app opts in through `session-policy.json`.

This proposal has three independent implementation slices that can land as
separate PRs: crawler fact authority, the bundled default-agent tier/generic
crawler, and New/New+Model UX cleanup.

## Naming and Compatibility

Current product code and sample agents use the older role name:
`harvester: true`, `isHarvester`, and `resolveHarvesterRole(...)`. This
proposal intentionally renames that role to crawler terminology:
`crawler: true`, `isCrawler`, and `resolveCrawlerRole(...)`.

The implementation must not leave two independent authorization paths. It should
either migrate all authored PilotSwarm agents/templates/docs in the same change
or support `harvester: true` as a backward-compatible alias that maps to the new
internal crawler role. In either case, `crawler: true` becomes the canonical
frontmatter and `isCrawler` the canonical internal tool-gating flag.

Also simplify new-session UX:

- `New` fast-starts a generic session with the default model when generic
  sessions are allowed.
- `New + Model` chooses model/reasoning first, then chooses between generic and
  registered non-system named agents.
- If generic sessions are disabled, `New` falls back to the `New + Model` flow.

## Goals

- Let trusted crawlers manage source corpora without needing Facts Manager
  privileges.
- Keep `intake/*` processing/read/delete, skill promotion, and Facts Manager
  configuration reserved to Facts Manager.
- Keep `isCrawler` an internal authorization decision derived from loaded
  agent definitions, never a user/LLM-controlled tool argument or session option.
- Ship a useful generic crawler named agent that starts by asking the user
  what to crawl instead of crawling blindly.
- Keep the bundled generic crawler invisible unless an app explicitly opts in
  through session policy.
- Preserve the ordinary session safety model for non-crawler sessions.
- Make the TUI/portal new-session path faster for the common generic case.

## Non-Goals

- Do not make every session a crawler.
- Do not give crawlers Facts Manager's skill-curation authority.
- Do not give crawlers operator maintenance controls such as force purge,
  embedder lifecycle, or destructive namespace deletion.
- Do not make the LLM able to set `isCrawler` or any equivalent authorization
  flag.
- Do not change orchestration yield order for this feature unless unavoidable;
  prefer worker/session-manager/tool-surface changes.

## Current State

### Crawler role derivation

In the proposed model, the source of truth is the bound agent definition's
authored frontmatter: `crawler: true`. The worker parses that from `.agent.md`
into loaded agent metadata. At turn time, the runtime finds the session's bound
agent definition by canonical `id` / `name` and derives an internal `isCrawler`
boolean from that loaded metadata.

The `id` / `name` lookup is only binding resolution: it answers "which loaded
agent definition is this session running as?" Authorization still keys off that
definition's `crawler: true` field. Display `title` is never used for this
lookup, because title is user-visible metadata and not an authorization key. If
multiple loaded agents normalize to the same identity, the runtime must fail
closed rather than grant crawler authority ambiguously.

This is the right security shape: the role is a property of worker-loaded
`.agent.md` configuration, not user input. The LLM should never receive an
`isCrawler` parameter and should never be able to smuggle the value through
session config.

Today the existing `harvester`-derived role is passed into
`createGraphTools(...)`, which gates the crawl queue and graph reconciliation
tools. It is not passed into `createFactTools(...)`, so fact CRUD/search
authorization cannot yet distinguish a crawler-capable session from an ordinary
session.

### Fact-tool authority today

Ordinary sessions can use:

- `store_fact`
- `read_facts`
- `delete_fact`
- `facts_search` when enhanced facts search is configured
- `facts_similar` when enhanced facts search is configured
- `search_skills` when enhanced facts search is configured

These tools respect the normal session/shared visibility model and namespace
guards. Facts Manager additionally receives reserved namespace and maintenance
authority.

### Graph/crawl authority today

When a graph store is configured:

- Graph read tools are broadly available.
- Graph write tools are broadly available to non-tuner sessions.
- Crawl queue tools are restricted to crawler-role sessions and Facts Manager.
- `graph_remove_evidence` is restricted to crawler-role sessions and Facts
  Manager.

### Agent loading today

The worker loads agents through:

- SDK bundled system plugins.
- SDK bundled management plugins unless `disableManagementAgents` is set.
- App `pluginDirs`.
- Inline `customAgents`.

There is not yet a bundled, optional, user-creatable agent tier. Deployments can
disable all management agents, provide their own plugin directories, or provide
inline `customAgents`, but PilotSwarm does not currently ship an optional
non-system named agent that apps can opt into through session policy.

Session policy already controls top-level creation behavior. It currently does
not enumerate app agents; allowed named agents are derived from loaded non-system
agents. This proposal keeps that rule for app/plugin/inline agents and adds a
small explicit opt-in list only for PilotSwarm-bundled default agents.

### New-session UX today

The shared UI controller currently treats `New` as the same high-level flow as
named-agent creation. If creatable agents exist, `New` opens the agent picker.
`New + Model` opens the model picker, then reasoning effort if applicable, then
the agent picker.

## Proposed Authorization Model

Define three distinct authority groups:

| Role | Meaning |
| --- | --- |
| Ordinary session | User/task session with normal session-tree + shared fact access. |
| Crawler | Trusted source/corpus operator. Broad authority over source/corpus facts, crawl state, and graph incorporation. |
| Facts Manager | System curator and maintenance role. Owns `intake/*`, `skills/*`, `asks/*`, Facts Manager config, tombstone purge, and embedder lifecycle. |

Agent Tuner remains read-only and must not receive mutating tools.

### Crawler fact authority

Crawlers should get corpus-oriented broad fact authority:

- Read/search facts across all shared and non-shared scopes when needed for
  crawling.
- Store/update source facts across shared and non-shared scopes.
- Delete source facts across shared and non-shared scopes.
- Requeue source/corpus prefixes with `facts_set_crawled({ keyPrefix,
  crawled:false })`.
- Mark processed queue rows with `facts_set_crawled({ scopeKeys })`.

Crawlers must not get Facts Manager curation authority. For the Facts
Manager-owned curation namespaces, a crawler has exactly the same permissions
as any ordinary session:

- No special permission to read, process, or promote `intake/*`.
- No special permission to write/delete `skills/*`.
- No special permission to write/delete `asks/*`.
- No special permission to read/write/delete `config/facts-manager/*`.
- No direct skill promotion workflow; crawlers can only request skill creation
  through the same ordinary intake/ask path available to other sessions.
- No `facts_tombstone_stats` / `facts_purge_tombstones` /
  `facts_force_purge`.
- No `manage_embedder`.
- No `graph_delete_namespace`.

This makes crawler authority closer to "corpus God-mode" than system
God-mode.

### Tool API changes

Add an internal `isCrawler?: boolean` option to `createFactTools(...)`, passed
from `SessionManager` using the already-derived `effectiveSerializableConfig`.
This value is not exposed to the LLM.

Do not add `targetSessionId`. Cross-scope fact operations should address rows by
fact key/prefix plus scope selector, or by exact `scopeKey` when the operation
targets a specific non-shared fact. `scopeKey` is the durable receipt already
returned by crawl and search/read surfaces; it is a better authorization target
than asking the LLM to assemble session ids.

Add privileged broad fact access where needed:

- `read_facts.scope = "all"` or equivalent broad mode for crawler/Facts
  Manager.
- scope-key-based update/delete selectors if the current store APIs cannot
  already update/delete an exact private fact row by receipt.
- broad `facts_search` / `facts_similar` access for crawlers across all shared
  and non-shared facts.

These modes must be accepted only for Facts Manager and crawlers. Ordinary
sessions receive a clear tool-level error. For the curation namespaces
(`intake/*`, `skills/*`, `asks/*`, `config/facts-manager/*`), crawler broad
mode must fall back to ordinary-session permissions rather than Facts Manager
permissions. That means broad crawler reads/searches must still exclude
ordinary-session-hidden prefixes such as `intake/*`, and crawler writes/deletes
must not gain Facts Manager's curation authority.

Exact `scopeKey` selectors must also enforce authorization server-side. A
`scopeKey` is an addressable receipt, not a bearer capability: ordinary sessions
can update/delete only facts they could otherwise access, while crawlers receive
the explicit broad cross-scope authority described here.

### Namespace policy

Suggested namespace rules:

| Namespace | Ordinary session | Crawler | Facts Manager |
| --- | --- | --- | --- |
| `corpus/*` | normal readable/writable if allowed by scope | broad read/write/delete | broad read/write/delete |
| other app source prefixes | normal readable/writable if allowed by scope | broad read/write/delete | broad read/write/delete |
| `intake/*` | write intake observations; no read/delete | same as ordinary session | full read/write/delete + processing |
| `skills/*` | read/search curated skills | same as ordinary session | full read/write/delete |
| `asks/*` | read/search open asks where allowed | same as ordinary session | full read/write/delete |
| `config/facts-manager/*` | none | same as ordinary session | full read/write/delete |

The exact `intake/*` ordinary-session behavior should preserve the current Facts
Manager wake-up path. Crawlers can ask for skills to be created through that
ordinary path, but they do not become a second curator or skill promoter.

The broad crawler authority applies to both `PgFactStore` and enhanced
HorizonDB facts. Search/similar tools remain enhanced-only, but the authorization
model is store-agnostic.

## Generic Crawler Named Agent

Add a bundled, user-creatable named agent, for example:

`packages/sdk/plugins/default-agents/agents/generic-crawler.agent.md`

This is a third bundled plugin tier: it is not the always-loaded `system/` tier
and not the management/system-agent `mgmt/` tier. Agents in this tier are normal
user-creatable named agents, but they are not added to the loaded agent set until
selected by app session policy.

Frontmatter sketch:

```yaml
---
schemaVersion: 1
version: 1.0.0
name: generic-crawler
title: Generic Crawler
description: Ingests, recrawls, reconciles, and graph-crawls user-specified source facts.
crawler: true
id: generic-crawler
initialPrompt: >
  Ask the user what source, namespace, and crawl action they want to run.
---
```

Prompt guidance:

- Start by asking the user what to do; do not crawl blindly.
- Ask for source namespace/key prefix, graph namespace, and operation.
- Explain that it can ingest source facts, requeue prefixes, drain the crawl
  queue, reconcile deleted facts, and build/update graph nodes/edges.
- Never curate `intake/*` into `skills/*`; if the user wants a skill created,
  use the ordinary intake/ask path and let Facts Manager promote it.
- Never claim special authority over `skills/*`, `asks/*`, or Facts Manager
  config.
- For destructive deletes, ask for explicit confirmation and state exactly which
  prefix/session/shared scope will be affected.
- Keep batch sizes bounded and mark crawl rows only after incorporation or
  delete reconciliation.

Simple examples to include in the prompt:

1. Ingest and crawl a docs corpus.
   - Store source documents as `corpus/docs/<id>` shared facts.
   - Register `graph_upsert_namespace("corpus/docs")`.
   - Drain `facts_read_uncrawled({ keyPrefix: "corpus/docs/" })`.
   - Extract services, teams, owners, or topics into graph nodes/edges.
   - Mark processed rows with `facts_set_crawled({ scopeKeys: [{ scopeKey,
     etag }] })`.

2. Recrawl after extraction logic changed.
   - Call `facts_set_crawled({ keyPrefix: "corpus/docs/", crawled:false })`.
   - Drain the queue again.
   - Reassert nodes and edges idempotently.

3. Reconcile deleted source facts.
   - Read tombstone rows from `facts_read_uncrawled`.
   - For rows with `deletedAt`, call `graph_remove_evidence(scopeKey,
     namespace)`.
   - Mark tombstones crawled after reconciliation.

4. Replay or migrate cross-session source facts.
   - Use exact `scopeKey` receipts for cross-session source migration or replay;
     do not ask the LLM to assemble target session ids.

## Bundled Default-Agent Tier

Add a new bundled user-agent tier under `packages/sdk/plugins/default-agents/`.
The worker scans this directory into an internal `availableBundledAgents` list,
but does not merge those agents into `_rawLoadedAgents` by default. Apps opt in
through `session-policy.json`.

Example app policy:

```json
{
  "version": 1,
  "creation": {
    "mode": "allowlist",
    "allowGeneric": true,
    "bundledAgents": ["generic-crawler"]
  }
}
```

Semantics:

- `creation.bundledAgents` is an explicit allowlist of PilotSwarm-bundled
  default agents to make available in this app.
- If `creation.bundledAgents` is omitted or empty, no optional bundled default
  agents are visible.
- App plugin agents remain app-owned and are still loaded from `pluginDirs`.
- Inline `customAgents` remain app-owned and are still loaded from worker
  options.
- `session-policy.json` still does not enumerate app/plugin/inline agents.
- `defaultAgent` keeps its existing meaning: the default named agent for
  single-step creation when the app wants one. Do not reuse that name for the
  bundled-agent opt-in list.
- `creation.bundledAgents` uses unqualified canonical bundled-agent names.
  Qualified names may be supported later only if resolver parsing explicitly
  handles namespace prefixes before identity normalization.
- If `defaultAgent` names a bundled default agent, that agent must also appear in
  `creation.bundledAgents`; otherwise startup fails closed.
- Management/system agents remain controlled by `disableManagementAgents` and
  existing system-agent policy, not by `creation.bundledAgents`.

This lets a deployment that has no crawler need do nothing:

```json
{
  "version": 1,
  "creation": {
    "mode": "allowlist",
    "allowGeneric": true
  }
}
```

No `generic-crawler` appears in the session picker unless the app opts in.

Suggested load order:

1. Load `system/` as today.
2. Load `mgmt/` unless `disableManagementAgents`, as today.
3. Read `default-agents/` into a separate optional bundled-agent registry.
4. Load app `pluginDirs` as today, including `session-policy.json`.
5. Merge only the `default-agents/` entries named by
   `session-policy.json.creation.bundledAgents` into `_rawLoadedAgents`, and
   only when an app/plugin agent with the same canonical name has not already
   been loaded. App agents override bundled defaults.
6. Merge inline `customAgents` as today.

Unknown bundled-agent names should be a startup error so typoed policy does not
silently hide an expected agent.

### Alternative: copyable template only

The lighter alternative is to ship the generic crawler only as a copyable builder
template. That would avoid new SDK loading policy, but each app would need to
copy and manually update the agent. The bundled default-agent tier is justified
only if PilotSwarm wants to centrally ship, version, and improve default
user-creatable agents while still requiring each app to opt in through
`session-policy.json`.

## New-Session UX

Update the shared controller so:

- `New` creates a generic session immediately when generic sessions are allowed.
- `New` uses the default model through the existing transport/model default
  path; no model picker appears.
- If generic sessions are not allowed, `New` falls back to the model/agent wizard.
- `New + Model` opens model picker, then reasoning effort if needed, then the
  session-agent picker.
- The final session-agent picker includes the generic session option when allowed
  and all registered non-system named agents.

This is a shared UI behavior and must be implemented in `packages/ui-core` so
the native TUI and portal stay in sync.

The bundled default-agent tier does not need special UI handling. Once an app
opts in to `generic-crawler`, the generic crawler behaves like any other
app-provided named agent in the picker and session creation policy. The fast
generic path should continue to let the existing create-time model credential
checks surface errors, including missing GitHub Copilot credentials.

The `New` behavior intentionally changes the current TUI contract that opens an
agent picker whenever named creatable agents exist. If this UX change lands, the
actual keybinding behavior, status hints, help text, `docs/keybindings.md`, and
`.github/copilot-instructions.md` must all be updated in the same PR.

Surfaces to update together:

- `packages/ui-core/src/controller.js`
- `packages/ui-core/src/selectors.js`
- `packages/ui-react/src/components.js` only if modal wording/details need a
  rendering update
- `packages/cli/src/app.js` if keybinding help changes
- portal help components that mention New/New+Model
- `docs/keybindings.md`
- `.github/copilot-instructions.md` TUI keybinding guidance
- `.github/skills/pilotswarm-tui/SKILL.md`

## Implementation Plan

1. Add the internal crawler flag to fact tool creation.
   - Extend `createFactTools` options with `isCrawler?: boolean`.
   - Pass `effectiveSerializableConfig.isCrawler === true` from
     `SessionManager`.
   - Keep tuner filtering after tool creation.

2. Refactor fact namespace authorization.
   - Separate `isFactsManager`, `isCrawler`, and `isTuner`.
   - Introduce helpers such as `canOperateFactsBroadly`,
     `usesOrdinaryCurationNamespaceRules`, and
     `canManageFactsSystemNamespaces`.
   - Preserve current ordinary-session rules.
   - Keep `intake/*`, `skills/*`, `asks/*`, and `config/facts-manager/*`
     on ordinary-session rules for crawlers; Facts Manager remains the only
     role that can process intakes, promote skills, and mutate Facts Manager
     config.

3. Add privileged broad fact selectors.
   - Do not add `targetSessionId`.
   - Add a controlled `read_facts` broad/all mode for crawler/Facts Manager.
   - Add exact `scopeKey` update/delete selectors if current APIs cannot already
     address cross-scope private facts by receipt.
   - Add broad search access for crawlers while preserving ordinary-session
     behavior for Facts Manager-owned curation namespaces.

4. Add generic crawler agent.
   - Add the `.agent.md` file with `schemaVersion: 1`, `version: 1.0.0`, and
     `crawler: true`.
   - Confirm it is user-creatable, not system auto-started.
   - Ensure prompt text does not instruct it to curate `intake/*` or promote
     skills.

5. Add the bundled default-agent tier.
   - Add `packages/sdk/plugins/default-agents/`.
   - Load it into a separate optional bundled-agent registry.
   - Extend `SessionPolicy.creation` with `bundledAgents?: string[]`.
   - Merge only selected bundled default agents into the user-creatable agent
     list.
   - Reject unknown bundled-agent names at startup.
   - Fail closed when `defaultAgent` references a bundled default agent that was
     not opted in through `creation.bundledAgents`.
   - Document precedence with app `pluginDirs`, inline `customAgents`,
     `defaultAgent`, and `disableManagementAgents`.

6. Update New/New+Model flow.
   - Add fast generic creation path for `New`.
   - Retain generic-disabled fallback.
   - Keep model/reasoning selection before final agent/generic picker for
     `New + Model`.

7. Update docs, builder templates, instructions, agents, and skills listed
   below.

## Test Plan

### Fact tool authorization

- Ordinary session cannot use `read_facts` broad/all mode.
- Ordinary session cannot update/delete an inaccessible fact by a syntactically
  valid `scopeKey` belonging to another scope.
- Crawler can read/search facts across shared and non-shared scopes.
- Crawler can update/delete a source fact across scopes using exact `scopeKey`
  or broad source selectors.
- Crawler has the same `intake/*`, `skills/*`, `asks/*`, and
  `config/facts-manager/*` permissions as an ordinary session.
- Crawler broad/all read/search excludes ordinary-session-hidden curation rows
  such as `intake/*` and Facts Manager config.
- Crawler cannot process intakes, promote skills, or mutate Facts Manager
  config with Facts Manager authority.
- Facts Manager retains existing curation and maintenance authority.
- Agent Tuner remains read-only for mutating fact/graph tools.

### Crawler role derivation

- A session bound to an agent with `crawler: true` receives crawler-only fact
  authority.
- A session bound to an agent without `crawler: true` does not receive that
  authority.
- Supplying `isCrawler: true` through public/session input does not escalate.
- Agent identity collisions continue to fail closed.
- Child sessions do not inherit crawler authority unless their own bound agent
  declares `crawler: true`.

### Generic crawler agent

- The bundled generic crawler does not appear in creatable agents by default.
- It has `crawler: true` in loaded metadata.
- It is not a system auto-start session.
- Its initial prompt asks for user intent instead of starting a crawl.
- It appears when `session-policy.json.creation.bundledAgents` includes
  `generic-crawler`.
- It remains omitted when `creation.bundledAgents` is omitted or empty.

### Bundled default-agent tier

- With no `creation.bundledAgents`, optional bundled default agents do not load.
- `creation.bundledAgents:["generic-crawler"]` loads only that bundled
  user-creatable agent.
- App plugin agents still load independently of `creation.bundledAgents`.
- Inline `customAgents` still load independently of `creation.bundledAgents`.
- `creation.defaultAgent` still points at an already-loaded named agent and does
  not itself opt in bundled agents.
- `creation.defaultAgent: "generic-crawler"` fails closed unless
  `creation.bundledAgents` also includes `generic-crawler`.
- App/plugin agents override bundled default agents with the same canonical
  name.
- Unknown bundled-agent names are startup errors.

### UI flow

- `New` creates a generic session immediately when `allowGeneric` is true.
- `New` falls back to the wizard when `allowGeneric` is false.
- `New + Model` selects model, then reasoning effort when applicable, then shows
  generic/named-agent picker.
- The picker includes generic only when allowed.
- The picker includes only non-system creatable named agents.
- Active group default inheritance still works for fast generic creation and the
  model/agent wizard.
- Portal and native TUI use the same controller behavior.

### Regression suites

- Existing facts CRUD tests.
- Existing graph-tools gating tests.
- Existing enhanced-tool gating tests.
- Existing sub-agent named-agent tests.
- UI controller tests for new-session flow.
- Local Horizon crawl tests if the generic crawler prompt or crawl guidance is
  exercised in integration.

## Documentation Updates

Update these user-facing docs when implementation lands:

- `docs/facts-table.md`
  - Explain crawler source/corpus fact authority.
  - Explain broad shared/non-shared fact operations and `scopeKey` receipts.
  - Clarify that `intake/*` processing and skill promotion remain Facts
    Manager-owned, while crawlers keep ordinary-session behavior there.

- `docs/crawler-deployment.md`
  - Rename or replace the existing `docs/harvester-deployment.md` surface so the
    canonical deployment doc uses crawler terminology, while preserving a
    compatibility redirect or note for old harvester links if needed.
  - Document the generic crawler.
  - Document how to opt in through `session-policy.json.creation.bundledAgents`.
  - Document crawler authority boundaries.
  - Describe the crawler data architecture end to end: source capture facts,
    shared and non-shared fact scopes, `scopeKey` receipts, crawl queue state
    (`last_crawled_at`, `etag`, `deletedAt`), graph evidence anchors, and the
    separation between crawler ingestion/reconciliation and Facts Manager
    intake/skill promotion.
  - Cross-reference `packages/horizon-store/docs/harvester-and-eval.md` while
    that provider doc still carries the historical harvester name.

- `docs/examples.md`
  - Update Horizon Crawler example references if generic crawler becomes the
    recommended starter.

- `docs/keybindings.md`
  - Update `New` and `New + Model` behavior.

- `docs/session-creation-policy.md`
  - Document `creation.bundledAgents` for PilotSwarm-bundled optional named
    agents.
  - Clarify that app agents still come from `pluginDirs` / `customAgents`, not
    policy enumeration.
  - Clarify that `defaultAgent` selects an already-loaded default creation
    target and does not opt in bundled agents.

- `docs/plugin-architecture-guide.md`
  - Add the `default-agents/` bundled tier to the loading model.
  - Explain that it is user-creatable but session-policy opt-in, not management
    or system.

- `docs/writing-agents.md`
  - Explain `crawler: true` as an authored agent capability and warn that it
    grants broad source/corpus authority.

- Package READMEs where they describe plugins, named agents, or the TUI.

## Builder Template Updates

Update builder-facing templates when implementation lands:

- `templates/builder-agents/skills/pilotswarm-knowledge-crawler/SKILL.md`
  - Teach the generic crawler option.
  - Teach opt-in via `session-policy.json.creation.bundledAgents`.
  - Clarify crawler authority does not include Facts Manager curation.

- `templates/builder-agents/skills/pilotswarm-hybrid-datastore/SKILL.md`
  - Mention `creation.bundledAgents` and the generic crawler when configuring
    graph/facts deployments.

- `templates/builder-agents/agents/*.agent.md`
  - If any builder agent creates crawler agents, ensure generated files include
    `schemaVersion: 1`, `version`, and correct guidance about reserved
    namespaces.

- `templates/builder-agents/README.md`
  - Add a short note about the bundled generic crawler and session-policy
    opt-in.

- `docs/builder-agents.md`
  - Keep the builder-facing overview consistent with the templates.

Use the agent-versioning rules for any authored `.agent.md` or builder template
agent prompt changes.

## Copilot Instructions, Agents, and Skills Updates

Update these repo-local instruction surfaces when implementation lands:

- `.github/copilot-instructions.md`
  - Add crawler authority boundaries.
  - Add the `default-agents/` tier and `creation.bundledAgents` convention.
  - Update TUI keybinding guidance for `New` and `New + Model`.

- `.github/skills/pilotswarm-tui/SKILL.md`
  - Update New/New+Model workflow expectations and status/help surfaces.

- `.github/skills/agent-versioning/SKILL.md`
  - No behavior change expected, but reference it when adding the generic
    crawler agent or builder-template agents.

- `.github/skills/add-tool/SKILL.md`
  - If it documents tool registration assumptions, note that crawler fact
    authority is internal role-gated and not an LLM-selectable tool flag.

- `.github/skills/add-test/SKILL.md`
  - If useful, add crawler authz tests as examples for future tool-surface
    changes.

- `packages/sdk/plugins/mgmt/agents/facts-manager.agent.md`
  - Clarify that Facts Manager, not generic crawler, owns intake curation,
    skill promotion, tombstone purge, and embedder lifecycle.
  - Bump `version` per agent-versioning rules.

- New generic crawler `.agent.md`
  - Include `schemaVersion: 1` and `version: 1.0.0`.
  - Keep examples and reserved namespace warnings in the prompt.
  - Keep the `initialPrompt`; it is intentionally used to start by asking the
    user what source, namespace, and action they want.

- Any app/sample crawler agents under `examples/**/plugin/agents/`
  - Update guidance if the generic crawler changes the recommended pattern.
  - Bump versions for authored PilotSwarm sample agents.

## Compatibility and Rollout

- This feature should not require an orchestration version bump if implemented in
  SessionManager/tool creation, UI controller, and worker plugin loading.
- Existing `crawler: true` agents gain broader source/corpus fact authority;
  document this as a security-relevant behavior change.
- Existing deployments without `creation.bundledAgents` continue without the
  generic crawler visible.
- Deployments opt in to the generic crawler through `session-policy.json`.
- Existing `harvester: true` frontmatter must either keep working as an alias or
  be migrated in all maintained PilotSwarm-authored agents, samples, builder
  templates, docs, and tests in the same change.
- A database migration may be required if broad `scopeKey` update/delete or
  broad fact-read signatures need stored-procedure changes. Follow the
  schema-migration process and add the required diff file.

Related proposal: [Facts Soft Delete and Graph Reconciliation](./facts-soft-delete.md)
defines the tombstone/reconciliation model that `graph_remove_evidence` relies
on when crawlers process deleted source facts.

## Open Decisions

- Whether `delete_fact scope="all"` should remain Facts Manager-only or be
  allowed for crawlers with ordinary-session behavior preserved for curation
  namespaces.