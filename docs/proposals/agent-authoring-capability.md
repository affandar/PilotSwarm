# The Agent Manager package — agents that manage agents

**Status:** v5.1 design, **phase A IMPLEMENTED and committed** (`9b892a5`),
**the §16.4 admin gap now CLOSED** (migration 0042). Phases B–E not started.
Supersedes v1 (capabilities), v2 (separate Agent Editor), v3 (read+write
tuner), v4 (import/cron/FQN); all in this file's history (`git log --follow`).

**Picking this up in a new session? Read §16 first** — it is the handoff:
what is built, what changed during implementation, what is deliberately
unfinished, and where the next keystroke goes. §17 is the adversarial review
of the sign-in role work.

**Name: Agent Manager**, package id `agent-manager` — decided. The old system
agent keeps its `agent-tuner` id until deleted, so the new package never
collides with the old identity. (*Agent Smith* survives as the splash's
signoff, §13.)

**Goal:** convert the agent-tuner from a built-in system agent into a
first-party installable package that **reads, writes, imports, creates and
keeps agents current**: the full diagnostic surface, the total read surface of
a session (events, facts, skills, schema, the session tar), package mutation
and session control, sourcing definitions from URLs or artifacts, cron-driven
freshness, and distilling a session into a brand-new agent. The
generic-crawler converts to an installable package alongside it. Everything
constrained to the session owner's authority, with admins open.

---

## 0. Decisions log

| Draft | Shape |
| --- | --- |
| v1 | General `capabilities:` vocabulary; tuner stays a system agent |
| v2 | No capabilities; separate read+write Agent Editor package |
| v3 | One package: the tuner reads and writes; two packages total |
| v4 | Renamed Agent Manager. Q1/Q2 settled. Import-from-URL/artifact, cron freshness, create-from-session, FQNs with `__shared`, no `__system` |
| v5 | Name locked. **Version diffing** (§8). Full **test plan** (§14) and **adversarial review** (§15) — ten findings, four design-changing |
| **v5.1 (this)** | Review dispositions accepted. Import gains a **deployment origin allowlist** (§8), defaulting to the one PilotSwarm repo — which supersedes the provenance rule and absorbs most of A2. Ready to implement |
| **v5.2** | Phase A shipped (`9b892a5`). The admin gap it left open is closed by migration 0042 — the sign-in role is persisted, read by the worker through a shared predicate, and bounded by a staleness ceiling. §16.4 rewritten; §17 adds the adversarial review (B1–B6) |

Settled along the way, still true: frontmatter `tools:` carries the grant and
installing is the consent moment; per-user package namespaces; the viewer
spine; patches-as-artifacts; the convergence trap; nothing trusts names; no
self-edit guard (the publisher still runs the old version and can pin back;
disabled copies fall out of resolution; humans always hold pin via
portal/CLI).

---

## 1. The architecture in one paragraph

A new top-level **`agent-packages/`** directory holds first-party installable
packages — each a plugin dir (`plugin.json`, `.agent.md`, skills) users can
point a package manager at (`pilotswarm agents push agent-packages/<name>`,
the portal upload, or a raw GitHub URL). Pointing at the folder is an
upload-time act: installed copies have their own lifecycle (§8).

Two packages, neither shipped pre-installed:

| Package | Today | Becomes |
| --- | --- | --- |
| `agent-manager` | the `agent-tuner` system agent in `plugins/mgmt/`, auto-started, read-only | installable; reads, writes, imports, creates — §3, §7, §8 |
| `generic-crawler` | `plugins/default-agents/`, auto-bundled everywhere | installable. Not deployed anywhere that matters — breaking the auto-bundle is accepted |

`examples/agent-packages/` stays as-is. The built-in system set shrinks to
the agents that hold background jobs: `pilotswarm`, `sweeper`, `resourcemgr`,
`facts-manager`.

The manager is not a system agent and has no `parent:` constraint. An admin
installs it `shared` for a whole deployment (waldemort); a user installs it
`user`-scope for themselves. Frontmatter `tools:` names the bundle; the
worker registers the tools as built-ins. Every tool enforces the **session
owner's** authority server-side. Installing the package is the consent
moment.

## 2. The security inversion, and the consent surface (Q1 settled)

**The session owner is the security boundary. The tool grant is only UX.**
Every tool checks the owner's authority server-side (§4), so even a hostile
package declaring the same tool names gains nothing its owner did not already
have through the portal, CLI and MCP. Gating who may declare the tools buys
no security; it only decides which agents *behave* like managers.

**Q1 decision: the consent surface is the agent itself — its splash and its
introduction.** The splash states the power plainly and the first message
says what it can do before it does anything. The current tuner splash is now
a lie — *"Reads every dial — never grabs the stick"* — and gets redrawn for
an agent that grabs the stick when asked.

**Plus one platform-rendered line, per §15 A2.** A splash is *self-attested*:
any package may declare this bundle (deliberately, above) and write itself a
friendly splash. So the install/detail screen also shows the declared tools
with the privileged ones named — owner-wide read, package write, session
control. Unforgeable because the platform renders it from frontmatter that is
already there. No manifest field, no badge; one honest line.

Two corollaries that must hold:

- **Nothing may trust the package or agent NAME.** Alice's `agent-manager`
  and the shared one are different packages (§8). Any check keyed on a name
  is bypassable or wrong; the old `isTunerSession` check dies and nothing
  like it returns.
- **Admin power comes from the admin, not the agent.** The same shared
  package run by Alice runs with Alice's authority; run by an admin it
  reaches the fleet.

## 3. The tool bundle

One bundle, declared in the manager's frontmatter, registered in the worker
as built-ins (declaration **and** handler — a handler-only tool is invisible
to the model; that broke agent-self-regen once).

**Reads — the total surface of a session the viewer can see:**

- **Session record & config** (`read_session_info`, `list_all_sessions`,
  `read_session_tree_stats`), **CMS events** (`read_agent_events`),
  **metrics & tokens** (`read_session_metric_summary`,
  `read_session_tokens_by_model`, `read_fleet_stats`), **orchestration**
  (`read_execution_history`, `read_orchestration_stats`,
  `list_orchestrations_by_status`), **facts & graph** (`read_facts`,
  retrieval/graph usage tools), **skills** resolved for the session's agent,
  **artifacts** (list + read), **packages** (`list_agent_packages`,
  `read_agent_package` + tree, `read_agent_package_file`).
- **Session archives.** The dehydrated tar is the deepest truth about a
  session (`SessionBlobStore`, which workers already hold).
  `list_session_archive` (entries + sizes + snapshot epoch) and
  `read_session_archive_file` (one entry, size-capped, paginated). Reads
  serve the **latest dehydrated snapshot** — a live session's archive is "as
  of last dehydration", age reported, never racing the dehydrator — and
  entries are capped: chk has seen 936k-token sessions, and an uncapped tar
  read is a worker OOM. **Archives require owner or admin, never a share**
  (§15 A3): the tar is raw session state — pre-compaction history the UI no
  longer shows, full tool-call arguments — so it is strictly more than what
  sharing a conversation was meant to hand over.
- **Fleet aggregates are admin-only** (§15 A4). `read_fleet_stats`,
  `read_fleet_retrieval_usage`, `read_fleet_graph_node_usage` and
  `list_orchestrations_by_status` take no session id and return no session
  list, so neither chokepoint below covers them; a user viewer gets the
  owner-scoped equivalent or a refusal.

**Writes — thin wrappers over `agent-package-service.ts` functions or
existing session ops**, called with the resolved viewer (§4) so one authz
implementation serves portal, CLI, MCP and the manager:

| Tool | Wraps |
| --- | --- |
| `propose_agent_patch` | new; ordered `.patch` artifacts (§6) |
| `publish_agent_package` | `publishPackedAgentPackage` |
| `import_agent_package` | new; fetch from URL or session artifacts → validate → pack → publish (§8) |
| `diff_agent_versions` | new; compare two versions — registry↔registry, registry↔URL, registry↔artifact — post-normalization (§8) |
| `set_agent_package_enabled` / `pin_agent_package_version` | existing ops |
| `create_agent_session` / `send_and_wait` / `stop_turn` / `abort_session` / `regenerate_session` / `complete_session` / `delete_session` | existing session ops (§7) |

Still not exposed as tools: `deleteAgentPackage`, `setAgentPackageScope`.
Deletion destroys every version; promotion hands work to the fleet. Human,
via portal and CLI.

**Read-tool scope, contained.** Ordinary agents that declare inspect tools
stay limited to self + descendants (`ensureSelfOrDescendant`). Owner-wide
visibility is part of this bundle only.

## 4. Authorization — the viewer spine (Q2 settled)

The finding is unchanged: **the inspection tools have no viewer at all**
(`inspect-tools.ts:133` — 27 tools, no principal; `:145` — the tuner bypasses
the only scoping that exists; `list_all_sessions` hits
`catalog.listSessions()` unfiltered, and its owner filters are arguments the
*model* chooses). Sound while the only holder is a system session; privilege
escalation the moment a user-owned session holds the tools.

The work: thread `{ provider, subject, isAdmin }` from the session **owner**
(never a tool argument); resolve `isAdmin` **at tool time**, per-turn cached
(stamping at creation lets a demoted admin keep fleet reach) and **failing
closed** — an unresolvable role refuses the privileged path, never widens it,
and a session whose owner no longer resolves stops its cron (§15 A6);
**three rules, not two** — `scopeSessions(rows, viewer)` for lists,
`ensureVisible(sessionId, viewer)` for direct reads, and an explicit
**admin-only** list for fleet aggregates that match neither (§15 A4), with a
grep-guard that fails the build on a tool matching none of the three; filter
lists, **error** direct denied reads; package mutations call the same service
functions the API layer calls.

**Q2 decision: match the UI, honoring share levels.** The share model is
exactly `read | write` grants and `private | shared_read | shared_write`
visibility (migration 0029; `grantSessionShare` access is `read|write`), and
it maps 1:1:

| Viewer's relationship to a session | Manager may |
| --- | --- |
| owner | everything below |
| shared **read** (grant or `shared_read`) | the read bundle **except archives** (§15 A3) |
| shared **write** (grant or `shared_write`) | read + session control (message, stop, regen) |
| none | nothing — direct reads **error**, lists omit |

**A session share never grants package rights.** Bob sharing a session
running his agent X does not let Alice's manager edit package X — package
authz stays creator-or-admin, unchanged.

The owner matrix stays: user → own copies / own+shared-per-above sessions, no
system sessions; admin → everything including system sessions; System
principal → writes refused. System **agents** stay out of bounds for writes
at every level, enforced by an explicit id-set refusal rather than the
accident that they are not packages.

**Archive reads are transcript-level access, and the audit rail exists.**
`authz_audit` shipped in migration 0029 with *"break-glass reads"* literally
in its charter; `recordAuthzAudit` writes through the catalog (which worker
tools hold) and `listAuthzAudit` serves it. Admin reads of a foreign archive
and admin fleet-wide package writes record there.

## 5. Per-user package namespaces

Today names are **globally unique** (`agent-package-service.ts:151` says so
verbatim). Identity becomes **(scope, owner, name)**:

- `UNIQUE (owner_provider, owner_subject, name)` user-scope; `UNIQUE (name)
  WHERE scope='shared'`. Existing data is globally unique → migration cannot
  conflict. (0042+, `DROP FUNCTION` before return-shape changes — the 0041
  lesson.)
- **Resolution: own enabled copy shadows shared.** Delivers
  download-modify-independently in one rule, and doubles as recovery —
  disable a broken copy, fall back to shared.
- **Promotion conflict:** scope→shared refuses when shared holds the name.
- **Per-copy enable** for user scope (a row column, rows now per-owner).
- **API:** `/agent-packages/:name` resolves own-then-shared for users; admins
  get `?owner=` (or an FQN, §9).
- **Installer layout** gains an owner discriminator on disk.
- **`agents pull <name>`** in the CLI, from `fetchAgentPackageTarGz`.
- **Source is an upload-time artifact** — the platform stores no link. §8
  shows how freshness works *without* breaking this.

## 6. Patches as artifacts

Nearly free: the portal already renders diff artifacts with gutter markers
(`isDiffArtifact`, `web-app.js:1306`). One unified diff per changed file,
sortable numeric prefix, ordered intent-first. Patch sets pin the base
version; stale-base publish refuses. Empty diffs dropped.

## 7. Instantiation modes, testing, and creating agents from sessions

No `parent:` constraint buys every mode with no special casing:

**Top-level** — a user spawns the manager directly. Inspection is a means,
not a gate: *"add `web_fetch` to my finance agent, drop `sql`"* goes straight
to a patch.

**Sub-agent** — a session spawns the manager as a child and tunes *itself*.
Children inherit the parent's owner, so §4 applies unchanged. The loop:
feedback → patch → publish → converge → **verify in a test session** →
regenerate the parent onto its new definition. The verify step is mandatory
on this path, not optional (§15 A7): here the publisher is the child and the
victim is the parent, so "the publisher can always pin itself back" — the
argument that lets §11 drop the self-edit guard — does not hold.

**Create-from-session — new.** Point the manager at a session and ask for an
agent: it reads the transcript (archive tools), events and artifacts,
distills the workflow into a draft package — `.agent.md` prompt, tools list,
skills — and presents it as a patch-set preview before publishing into the
user's namespace. **Splash and splashMobile are offered, not imposed**: the
manager asks whether the user wants them, then generates both. The test loop
(below) verifies the newborn agent actually runs.

**Test sessions** the manager creates are top-level, owned by the manager
session's owner, tagged (`testOf: package@semver`) for sweeper reaping,
budgeted. **The convergence trap**: publishes land on the next
registry-epoch poll (<30 s observed), so `create_agent_session` **and
`regenerate_session`** refuse loudly until the target's active version has
converged (§15 A5 — a regenerate that beats convergence silently rebuilds
onto the *old* definition, which looks exactly like "the edit did nothing");
the skill polls rather than sleeps.

## 8. Sourcing, and staying current without breaking the link-free rule

**Import is allowlisted at the deployment level.** The fetch reaches only
origins the deployment has named — this is the primary control on §15 A1, and
it replaces the fussier "the URL must come from a user turn" rule, which the
allowlist makes unnecessary: an injected URL that is not on the list simply
cannot be fetched, and one that *is* on the list points at a repo the
deployment already trusts.

**It lives in a JSON config file, not an env var.** `.env*` is for secrets
and connection strings; an allowlist is neither. Four reasons the file wins:
the data is **structured** (origins with path prefixes — a delimited env
string breaks on the first entry containing the delimiter); it is a
**security control**, so it belongs somewhere diffable and reviewable rather
than in a value a `kubectl set env` can change without a PR; it follows the
convention already here (`.model_providers.json`, auto-discovered, mounted
from a ConfigMap in AKS); and that convention already solves the one case
where a secret *could* appear — model-providers writes
`"githubToken": "env:GITHUB_TOKEN"`, so a future private mirror can name a
credential by env var without putting it in the file.

`.agent_packages.json` — named for the domain, not this single key, so later
package policy (size caps, scope rules) has an obvious home:

```json
{
  "import": {
    "mode": "append",
    "allowlist": [
      "https://dev.azure.com/contoso/agents/_git/fleet-agents/",
      "https://agents.contoso.internal/packages/"
    ]
  }
}
```

**The base allowlist is a constant in source, not a config default.** Every
PilotSwarm deployment gets the same three entries — three because GitHub
serves one repository from three hosts:

```
https://github.com/affandar/pilotswarm/
https://raw.githubusercontent.com/affandar/pilotswarm/
https://codeload.github.com/affandar/pilotswarm/
```

Keeping those in code rather than in the shipped config means changing them
shows up in a PR diff, and a deployment cannot silently drop them by
overwriting a file. The config file **adds** to that base (`append`, the
default); `"mode": "replace"` exists for a deployment that wants only its own
sources, and is the one setting that can remove the PilotSwarm repo —
deliberately explicit. No file at all, or an empty allowlist under `replace`,
disables URL import entirely, which is a legitimate posture.

**Matching rules, because this is where allowlists get broken:**

| Rule | Rejects |
| --- | --- |
| `https` only | `http://github.com/affandar/pilotswarm` |
| No userinfo in the authority | `https://github.com@evil.com/...` |
| Host matched **exactly**, case-folded, trailing dot stripped — never by suffix | `evilgithub.com`, `github.com.evil.com`, `github.com.` |
| Path prefix matched on **segment boundaries** | `/affandar/pilotswarm-evil` against `/affandar/pilotswarm/` |
| Path normalized before matching (percent-decoding, `..` resolution) | `/affandar/pilotswarm/../../elsewhere` |
| Default port only, unless the entry names one | `https://github.com:8443/...` |
| **Every redirect hop re-checked** against the full list | allowed → not-allowed redirect |
| The §15 A1 **IP denylist still applies** to each hop's resolved address | an allowlisted host whose DNS answers `169.254.169.254` |

The last two matter most. An allowlist alone is not enough: DNS is not under
our control, so an allowlisted name that resolves into private space must
still be refused — allowlist **and** resolved-IP check, both hops of a
redirect included.

A refusal names the offending URL and says how the list is extended; it never
echoes a response body. **A denied import is a security signal** — it is what
a prompt-injection attempt looks like from the outside — so it is logged with
the session id, and a burst is worth alerting on.

Beyond URLs, `import_agent_package` also accepts **session artifacts** the
user uploaded, which need no allowlist: the bytes are already inside the
deployment and arrived through an authenticated upload. Fetch → validate → canonically pack → publish through the
same pipeline as CLI push. `dryRun` stops after packing and reports the
sha256 against the active version — "is there anything new?" without a
write.

**Semver policy.** Versions have content hashes; publish already refuses
same-semver content changes. Policy: the source's declared semver wins when
it is greater than active; when the source content changed but its semver
did not, the manager patch-bumps and says so in the version notes. Names and
semver remain conventions tying back to the origin — nothing more.

**Diffing.** `diff_agent_versions({ left, right })` where each side is a
registry version (FQN, §9), a URL, or a session artifact. Three uses: *what
changed between 1.2.0 and 1.3.0*, *how does my copy differ from shared*, and
— the one that makes cron trustworthy — *what would importing this URL
actually change*. Output is the §6 artifact set: one ordered unified diff per
changed file, so the portal renders it with no new client work.

**It must compare POST-normalization, or every diff is noise.** Upload
canonicalizes: files move into `agents/`, `skills/`, `.mcp.json`, ordering is
fixed, undeclared files are dropped. A raw source tree diffed against a
packed artifact would show that reshuffling on every run and bury the one
line that actually changed. So a URL/artifact side is packed through the same
canonicalizer first, then trees are compared. Two consequences worth having:
**identity is a hash compare, not a diff** — packages are content-addressed,
so "is this the same?" is free and the diff only answers "how does it
differ"; and a diff that comes back empty after normalization is a *true*
no-op, which is exactly the signal the cron loop needs.

**Cron freshness — a session behavior, not a platform feature.** Correction
to how this actually works: cron is a **tool the agent calls on itself**
(`cron` / `cron_at` in `managed-session.ts`, seconds + reason, 15s floor),
not an API setting an operator toggles. So the loop is: the user asks the
manager to keep agent X current with a URL; the manager sets its own cron and
records the URL **in its own session instructions**; each firing does
`diff_agent_versions` (registry↔URL) → publish only on a real diff →
optionally regenerate affected sessions. The platform stays exactly as
link-free as §5 demands — provenance-as-behavior, not provenance-as-schema.
Idempotent by construction: unchanged source → identical hash → empty diff →
no publish, so an hourly cron is safe to leave running.

## 9. Fully-qualified agent names

The namespace concept the rest of this has been circling, made explicit:

```
<username>:<package>[:<semver>]     alice@example.com:kit-navigator:1.2.0
__shared:<package>[:<semver>]       __shared:agent-manager
<package>                           bare: own enabled copy, then shared
```

- **Progressive qualification.** Bare names keep today's ergonomics and the
  §5 precedence. The full triple pins an exact artifact. Semver omitted =
  active version.
- **`__shared` is a reserved token**, and the whole `__` prefix is reserved
  so future sentinels stay mintable. No user may claim such a name.
- **A genuinely new ability:** agent *binding* accepts FQNs, so
  `__shared:agent-manager` reaches the shared copy even when your own copy
  shadows it — the one thing §5's precedence otherwise takes away.
- **Strings are references, identities are truth — and they resolve ONCE.**
  The registry stores `(provider, subject)`. An FQN resolves to that pair at
  **authoring** time, and the pair is what gets stored and used; the string
  stays display-only. Resolving on every use would let a later-registered
  colliding identity re-point a long-running cron (§15 A8) — the same email
  can exist under entra, github and dev. An FQN that no longer matches its
  stored pair is reported, never silently re-pointed.

**Why there is no `__system` — considered and rejected:**

1. **There is nothing for the token to act on.** System agents have no
   package lifecycle — no semver, no versions, no tarball, no
   enable/disable, no owner rows. A registry namespace whose members answer
   to none of the registry's verbs is a name pointing at nothing.
2. **It reopens the door this proposal nails shut.** The moment
   `__system:sweeper` is addressable in package syntax, "publish to
   `__system:`" becomes a conceivable request, and system agents' immunity
   to package ops stops being structural and becomes a permission check —
   strictly weaker.
3. **The display need is real but cheap.** Listings can label system
   sessions `system:` as text without reserving registry semantics for it.
4. **The plausible future doesn't need it either.** An "unshadowable shared
   package" (compliance agent users must not override) is a *policy flag on
   shared* (`shadowable: false`), not a new owner — the owner is still the
   deployment.

Reserving the `__` prefix keeps every future option open at zero cost;
minting `__system` today buys nothing and sharpens a risk.

## 10. Converting the two agents

The system tuner has no background job; converting it loses nothing
automatic, and `debug_session` gathers its evidence directly (`mcp/tools/
debug.ts` references the tuner only in prose). The crawler is not deployed
anywhere that matters — breaking its auto-bundle is accepted.

Move/removal sites: `plugins/mgmt/agents/agent-tuner.agent.md` → deleted,
reborn as `agent-packages/agent-manager/` (drops `system: true` and
`parent:`; new splash per §2); `plugins/default-agents/agents/
generic-crawler.agent.md` → `agent-packages/generic-crawler/`;
`SYSTEM_AGENT_IDS` in `session-proxy.ts:42` and `inspect-tools.ts:31` drop
`agent-tuner`; the `isTunerSession` filter (`session-manager.ts:1078`) and
the `if (isTuner) return null` bypass die with the viewer spine;
`pilotswarm.agent.md` stops believing in four permanent children;
`agent-tuner.test.js` is rewritten against the package; MCP prose reworded.

**Deployed fleets:** on rollout the root stops respawning the tuner and the
sweeper retires the orphaned system row. Fleets that want the manager
install the package (shared, by an admin).

## 11. Blast radius

- **Broken publish of the manager's own package — no guard needed.** The
  publishing session still runs the old version, so `pin_agent_package_
  version` still works; disable-own-copy falls back to shared; humans hold
  pin via portal/CLI. Verify-then-rollback is the skill's reflex.
- **Stopping the wrong session** — owner-scoped; under an admin, "bounded"
  is the fleet. The §4 matrix tests are the fence.
- **Import is the sharpest edge in the proposal — see §15 A1.** It would be
  the worker's *first* outbound-fetch primitive, model-driven, in an agent
  that reads untrusted transcripts. The **deployment allowlist (§8) is the
  primary control**: an injected URL that is not on the list cannot be
  fetched at all, which closes the exfiltration channel rather than
  policing it. Layered underneath, and shipped in the same commit: `https`
  only, resolved-IP denylist (loopback / link-local / RFC1918 /
  cloud-metadata) on **every** hop, capped redirect chain, capped size and
  timeout, and response bodies **never** echoed into errors or the
  transcript. Fetched packages then take the same validation as any upload,
  land in the caller's namespace, and never auto-promote to shared.
- **2 MB upload cap**; clear error, not truncation.
- **Runaway test sessions** — the §7 budget.
- **Tool-name shadowing** — a package tool named `publish_agent_package`
  must not shadow the built-in; built-ins win, loader warns.

## 12. Phasing

| Phase | Work | Notes |
| --- | --- | --- |
| **A** | Viewer spine: owner+role threading, role-at-tool-time, chokepoints, share-level mapping (Q2), grep-guard, matrix tests | Security prerequisite; independently valuable |
| **B** | Namespaces: migration, service, resolution precedence, installer layout, promote-conflict, **FQN parsing + reserved `__` prefix + FQN agent binding**, `agents pull` | Independent of A |
| **C** | Writes: package mutation over existing service fns, `propose_agent_patch`, **`diff_agent_versions`**, **`import_agent_package` — with the §8 allowlist and §15 A1 network guards in the same commit, never a follow-up** — session control with tagging/budget/convergence-refusal on *both* create and regenerate, archive tools (owner/admin only) + audit | Needs A |
| **D** | `agent-packages/` with both packages: manager prompt + skill (repair loop, **create-from-session**, **cron freshness recipe**, splash offer), new splash, docs | Needs C; B for multi-user installs; naming (§13) gates the id |
| **E** | Convert both agents out of the built-in sets (§10) + fleet upgrade note | After D — no diagnostics gap |

## 13. Naming

`agent-tuner` undersells an agent that creates, imports, schedules and
repairs. Candidates:

| Name | For | Against |
| --- | --- | --- |
| **Agent Manager** | says exactly what it does; rhymes with "package manager", which is the mental model | dry; "manager" is an overloaded word in the codebase (session-manager) |
| **Agent Forge** | creation + reworking + versions in one metaphor; great splash material | slightly hides the diagnostic half |
| **Agent Smith** | memorable, self-aware (an agent that makes agents) | the joke wears; villain connotation |
| **Agent Wrangler** | herds, fixes, rounds up strays | casual for an admin-grade tool |
| **Agent Mechanic** | diagnose-and-repair emphasis | undersells creation and scheduling |

**Decided: Agent Manager.** Clarity wins for a tool an admin installs
fleet-wide, and "package manager" is the right mental model to borrow.

*Agent Smith* was the runner-up and does not deserve to die: it becomes the
splash's signoff line — an agent that makes agents, quietly self-aware,
without putting a Matrix villain on the install screen. The splash also has
to be rewritten anyway (§2): the current one promises *"Reads every dial —
never grabs the stick"*, which stops being true the moment this ships.

## 14. Test plan

Four layers. The rule of thumb from this codebase's own history: **a test that
was never seen to fail against the pre-fix code proves nothing**, so every
security test below names the behaviour it must catch, and the authz suite is
written against a deliberately-broken build first.

### 14.1 Unit — pure, no database

| Area | Cases |
| --- | --- |
| FQN parsing | all forms (`pkg`, `user:pkg`, `user:pkg:semver`, `__shared:pkg`); malformed; `__` reserved → refused at publish **and** at user registration; colons in names |
| Semver policy | source > active → adopt; source == active + content differs → patch-bump with note; source < active → refuse with the comparison shown |
| Diff normalization | raw source tree vs its own packed artifact diffs **empty** (the canonicalizer's reshuffling must not surface); one changed line surfaces as one hunk; binary entries flagged not inlined; over-cap entries truncated with a marker |
| Patch sets | ordering preserved; empty diffs dropped; stale-base publish refused |
| **Import allowlist** (§8) — the bypass classes | scheme (`http://`); userinfo (`https://github.com@evil.com/`); host suffix (`evilgithub.com`) and prefix (`github.com.evil.com`) confusion; trailing dot (`github.com.`); case (`GitHub.COM`); path segment boundary (`/affandar/pilotswarm-evil` must NOT match `/affandar/pilotswarm/`); percent-encoded and `..` traversal; non-default port; **redirect from an allowed origin to a disallowed one**; an allowlisted host whose DNS resolves to `127.0.0.1` / `169.254.169.254` (allowlist AND IP check); IPv6 and decimal-IP literal forms; `append` vs `replace` mode; `replace` is the only way to drop a base entry; missing file → base only; malformed JSON → refuse to start rather than silently allow nothing (or everything) |
| URL policy (§15 A1) | `https` only; loopback / link-local / RFC1918 / `169.254.169.254` and cloud-metadata refused **before** any socket opens; each redirect hop re-checked; response bodies never present in error strings |

### 14.2 Integration — real Postgres, real catalog

| Area | Cases |
| --- | --- |
| **Authz matrix** (the one that matters) | every cell of §4, for packages **and** sessions: owner / shared-read / shared-write / none / admin / System principal. Includes: a read grant cannot mutate; a write grant controls sessions but **never** packages; a user cannot reach a system session |
| Role resolution | admin → fleet reach; demoted admin loses it **on the next turn**; role lookup failure **fails closed** (§15 A6); deprovisioned owner's cron stops |
| Chokepoint coverage | grep-guard: no inspect tool reaches `catalog.*` without `scopeSessions` / `ensureVisible`. Fleet-aggregate tools are admin-only (§15 A4) |
| Namespaces | Alice and Bob publish `abc@1.2.3` user-scope concurrently — no conflict; Alice's copy shadows shared for Alice only; promote→shared refuses when taken; disable own copy → resolution falls back to shared; per-copy enable |
| Archives | caps and pagination enforced; snapshot age reported; a live session's read does not race the dehydrator; **admin read of a foreign archive writes an `authz_audit` row** |
| Import | `dryRun` publishes nothing; unchanged source → identical hash → no publish (cron idempotence); a fetched package passes the same validation as an upload; credential-less private URL → clear error, no partial write |
| Name-trust | a user-scope package named `agent-manager` (or `agent-tuner`) gets no special treatment anywhere — behavioural, not just grep |

### 14.3 Contract — the shapes that silently rot

- Every new tool has **both** a declaration and a handler (the
  agent-self-regen lesson: handler-only tools are invisible to the model).
- Manager tools route through the same `agent-package-service.ts` functions
  the API layer calls — asserted, not assumed, so authz cannot fork.
- Ops added to the protocol table are reachable from the web client
  (the existing `web-client-op-coverage` guard extends to cover them).

### 14.4 End-to-end — on a real deployment, by hand

The full arc, run once per phase-D candidate build:

1. Admin installs `agent-manager` shared; a second user installs their own
   copy user-scope. Both spawn it; **each sees only their own sessions.**
2. Diagnose a genuinely misbehaving session → patch → publish → wait for
   convergence → test-session verifies → roll back with pin.
3. Import from a public GitHub URL; `diff_agent_versions` registry↔URL shows
   the change; cron set on the manager session; edit the source; confirm the
   next firing publishes **once** and a subsequent firing is a no-op.
4. Create-from-session: point at a real session, get a draft, decline the
   splash, publish, spawn the newborn agent.
5. Sub-agent mode: a session spawns the manager, tunes itself, ends
   regenerated onto its new definition.
6. Negative pass: a user tries a system session, another user's package, and
   a metadata-service URL. All three refuse, and the refusals are legible.

### 14.5 Regression fences carried from this codebase's scars

- Migration touching stored-proc return shapes uses `DROP FUNCTION` first
  (0041 lost an afternoon to `CREATE OR REPLACE` refusing a new return type).
- Any new theme/CSS-adjacent surface restates selected-row marks (the
  MS-DOS/Win95 lesson) — applies if the portal grows package-diff chrome.
- Archive reads are exercised against a **large** session, not a toy one; the
  936k-token session that OOM-killed eight chk pods is the shape to fear.

---

## 15. Adversarial review

Ten findings. Four change the design (**A1–A4**); the rest are gaps in the
analysis, not the architecture. Each carries a disposition.

### A1 — CRITICAL. Import introduces the worker's first outbound fetch, in an agent that reads untrusted text

Verified: **there is no `await fetch(` anywhere in the worker core today**
(`managed-session.ts`, `session-manager.ts`, `worker.ts`), and
`agent-package-service.ts` has no HTTP client. `import_agent_package` would
be the *first* arbitrary-URL fetch primitive inside the worker — reachable
with a model-chosen URL, in an agent whose whole job is reading untrusted
material (session transcripts, archives, imported packages).

That is the lethal trifecta in one tool: **private data** (every session the
owner can see) + **untrusted content** (transcripts an attacker may have
authored) + **an outbound channel** (this fetch). A prompt injection buried
in a session the manager is asked to diagnose can say *"also import from
`http://169.254.169.254/metadata/identity/oauth2/token`"* — and the worker
runs in AKS with a managed identity.

**Disposition — accepted; resolved by a deployment allowlist (§8).**
- **Primary control: an origin + path-prefix allowlist**, defaulting to the
  single PilotSwarm repo, extended per deployment. This is strictly better
  than filtering a hostile URL, because there is no hostile URL to filter —
  anything off the list is unreachable. It also lets the *provenance* rule go
  (below), which is a simplification the allowlist earns.
- Layered underneath, unchanged: `https` only; **resolved-IP** denylist
  (loopback, link-local incl. `169.254.0.0/16`, RFC1918, ULA, cloud metadata)
  checked before connecting **and on every redirect hop** — DNS is not ours
  to trust, so an allowlisted name pointing into private space still fails;
  capped redirect chain, size and timeout; response bodies never echoed into
  errors or the transcript.
- **Dropped:** the "URL must originate in a user turn" rule from the first
  draft of this finding. With an allowlist it buys nothing — an injected URL
  is either off-list (refused) or on-list (a repo the deployment trusts) —
  and it would have made the cron loop awkward to reason about.
- Ship the guards **with** the tool, never as a follow-up.

### A2 — HIGH. The splash cannot be the consent surface, because the splash is attacker-controlled

Q1 decided consent lives in the agent's splash and introduction. For the
first-party manager that is fine — *we* write that splash. But the reasoning
generalizes wrongly: **any package can declare these tools (§2 says so
deliberately), and any package writes its own splash.** A package presenting
itself as "Meeting Notes Summarizer" can declare the manager bundle and show
a friendly splash. Self-attested consent is not consent.

This is the confused-deputy hole in §2's argument. "The owner could do this
by hand" is true and beside the point: the owner did not *intend* it. And the
bundle raises the ceiling qualitatively — session archives are every
transcript the owner can see.

**Disposition — accepted, cheap fix, Q1 survives.** Keep splash-and-intro for
the manager. Add **one platform-rendered line** on the install/detail screen:
the declared tools, with privileged ones (owner-wide read, package write,
session control, archive read) named as such. Platform-attested, unforgeable,
no new manifest field — it is already in the frontmatter. This is Q1's
Option B reduced to its load-bearing part.

**The A1 allowlist also does most of A2's work**, which is why nothing
heavier is needed: a hostile package holding this bundle has no outbound
channel to exfiltrate what it reads. **Residual, stated plainly rather than
waved away:** such a package could still tamper — publish a backdoored
version of an agent its owner uses — and that is not exfiltration but it is
real. It is also the same risk any package carries once installed, which is
why the disclosure line above is the right size of fix.

### A3 — HIGH. `shared_read` over-grants: the archive holds more than the shared UI shows

Q2 mapped share levels 1:1 and put archives in the read bundle. But the
dehydrated tar is **not** the conversation Bob shared — it is raw session
state: pre-compaction history the UI no longer displays, full tool-call
arguments (which may carry secrets a user pasted), internal scratch. Bob
shared a *view*; Alice's manager would read the *substrate*.

**Disposition — accepted, narrows Q2.** Archive tools require **owner or
admin** (admin audited). `shared_read` and `shared_write` get the whole read
bundle *except* archives. If archive-on-share is ever wanted, the share
dialog must say what it grants — a UI change, not a default.

### A4 — MEDIUM-HIGH. Fleet-aggregate tools sit outside both chokepoints

`scopeSessions` covers lists; `ensureVisible` covers direct reads. Neither
covers tools that take no session id and return no session list:
`read_fleet_stats`, `read_fleet_retrieval_usage`, `read_fleet_graph_node_usage`,
`list_orchestrations_by_status`. Those leak across the boundary — fleet token
counts disclose other users' activity, and orchestration ids map back to
sessions.

**Disposition — accepted.** A third rule: **fleet-wide aggregates are
admin-only**; a user viewer gets the owner-scoped equivalent or a refusal.
The grep-guard is extended so a tool matching neither chokepoint *nor* the
admin-only list fails the build.

### A5 — MEDIUM. `regenerate_session` needs the convergence guard too

§7 guards `create_agent_session` against acting before the registry epoch
converges, but the self-tuning loop ends by **regenerating** — and a
regenerate that lands on a worker which has not yet converged rebuilds the
session onto the *old* definition, silently, which looks exactly like "the
edit did nothing". Same trap, different door.

**Disposition — accepted.** Both tools take the same guard.

### A6 — MEDIUM. Role resolution has no stated failure mode

§4 resolves `isAdmin` at tool time. Unstated: what happens when the lookup
*fails* (DB blip, user row deleted, provider outage). If it defaults to
`false` the tool degrades to user scope — annoying but safe. If it throws and
a caller swallows it, or if any path treats "unknown" as "unrestricted", the
failure is fleet-wide read. Related: a cron on a **deprovisioned** owner's
session keeps firing.

**Disposition — accepted.** Fail closed and say so in code: unknown role →
refuse the privileged path, never widen it. A session whose owner no longer
resolves stops its cron and reports why.

### A7 — MEDIUM. The brick analysis covered self-publish, not parent-publish

§11 argues no self-edit guard is needed because "the publishing session still
runs the old version and can pin back". True for top-level mode. In
**sub-agent** mode the publisher is the *child* and the victim is the
*parent*: the manager publishes a broken version of the parent's package and
regenerates the parent, which now fails to load. The user's entry point was
the parent; the child may be reaped with it.

Recovery exists (spawn a fresh manager, pin back) but it is a worse story
than §11 tells, and it is avoidable.

**Disposition — accepted, no new guard needed.** Ordering, enforced in the
skill and by A5's convergence check: **verify the new version loads in a test
session before regenerating anything onto it.** The manager already has the
test-session machinery; this makes its use mandatory on the parent path.

### A8 — MEDIUM. FQN username resolution is security-relevant, not just cosmetic

§9 notes usernames can change or collide "and resolution surfaces ambiguity".
Adversarially: the same email can exist under two providers (entra, github,
dev). An FQN written into a **cron's instructions** resolves at each firing —
so a later-registered colliding identity can change what a long-running loop
targets, or break it. Resolution that ever falls back to "the only match"
changes behaviour when a second match appears.

**Disposition — accepted.** FQNs resolve **once, at authoring time**, to
`(provider, subject)`; that pair is what gets stored and used. The string
stays display-only, and an FQN that no longer resolves to the stored pair is
reported rather than silently re-pointed.

### A9 — LOW (but would have made the feature useless). The diff must be post-normalization

Already folded into §8 during this pass: a raw source tree diffed against a
canonically-packed artifact shows the packer's reshuffling on every run. Left
here so the reasoning is not lost.

### A10 — LOW. "Never trust names" and the system-agent id set look contradictory

§2 says nothing may trust a package or agent name; §4 refuses writes to
system agents via an **id set** — which is name-trust. Not a contradiction,
but only because of a distinction worth stating: **trusting a name to DENY is
safe; trusting a name to GRANT is not.** A forged name can only put you
*inside* a denylist, never outside it. Any future check must be read against
that rule.

### What survived the review

The owner-as-boundary model (A2 dents the *consent* story, not the authz
one); the two chokepoints for the scope they actually cover (A4 adds a third
rule rather than replacing them); per-user namespaces with own-shadows-shared
and its disable-to-recover property; dropping the self-edit guard for
top-level mode; and rejecting `__system` — nothing in the review argued for
re-adding it, and A10's deny-vs-grant rule is a further reason not to make
system agents addressable in package syntax at all.

---

# 16. Progress report / session handoff

*Written 2026-08-03 to move this work to a fresh session. Everything below is
verified against the code, not remembered.*

## 16.1 Where things stand

| Phase | Status | Commit |
| --- | --- | --- |
| **A — viewer spine** | **DONE** | `9b892a5` |
| **A′ — sign-in role (§16.4 admin gap)** | **DONE** | migration 0042 |
| **V — `spawn_agent` package isolation** | **DONE** — a live vulnerability found during B (§18 C1) | uncommitted |
| **B — per-user namespaces** | **DONE** | migration 0043 |
| **C — the write bundle** | **DONE** (archives deferred, §18) | uncommitted |
| **D — the two packages** | **DONE** | `agent-packages/` |
| **E — convert out of the built-ins** | **DONE** | uncommitted |

Branch `main`, 34 commits ahead of `origin/main`, **nothing pushed**. The tree
is clean. A parallel session did UI work on the same branch earlier; that is
finished and merged into the same history.

Suites green at `9b892a5`: SDK unit **151**, portal **48**, ui-core **273**,
MCP **5**.

## 16.2 What phase A actually built

**The problem it fixed.** `createInspectTools` took no principal at all — 27
tools built from `{catalog, agentIdentity, duroxideClient, factStore}`. The
tuner bypassed the only scoping that existed (`if (isTuner) return null`), and
`list_all_sessions` called `catalog.listSessions()` unfiltered; its
`owner_query` / `owner_kind` parameters are arguments the *model* chooses, and
the tool description tells it to leave them unset. Sound while the only holder
was an ownerless system session. A privilege-escalation path the moment a
user-owned session holds the bundle — which is exactly what the Agent Manager
package is.

**The shape now.** Every session-touching tool resolves a viewer from its
session's OWNER and routes through one of three rules:

| Rule | Applies to | File / line |
| --- | --- | --- |
| `scopeSessions(rows)` | lists — keep only readable rows | `inspect-tools.ts:237` |
| `ensureVisible(id)` | direct reads — refuse, as NOT FOUND | `inspect-tools.ts:265` |
| `requireAdmin(tool)` | fleet aggregates | `inspect-tools.ts:299` |

**The third rule is a finding, not just plumbing.** `read_fleet_stats`,
`read_fleet_skill_usage`, `read_fleet_retrieval_usage`,
`read_fleet_graph_node_usage` and `read_user_stats` take no session id and
return no session list, so *neither* chokepoint in the design would have
reached them. They were disclosing cross-user activity. This is §15 A4,
confirmed in code.

**The predicate is shared, not copied.** `evaluateSessionAccess` moved out of
`packages/app/web/authz.js` into `packages/sdk/api/src/session-authz.js`. The
worker and the portal's HTTP routes now evaluate the *same function*; the
portal re-exports it and its 48 tests pass unchanged. `evaluateArchiveAccess`
(§15 A3, owner-or-admin only, never a share) is already written there and is
**unused until phase C** builds the archive tools.

**Key symbols, for orientation:**

| Symbol | Where |
| --- | --- |
| `InspectViewer`, `NO_VIEWER` | `inspect-tools.ts:139`, `:161` |
| `diagnosticBundle` | `inspect-tools.ts:215` |
| `viewerFor()` | `inspect-tools.ts:219` |
| `ensureSelfOrDescendant` (bypass removed) | `inspect-tools.ts:325` |
| `resolveViewer:` wiring | `session-manager.ts:1191` |
| `_resolveInspectViewer` | `session-manager.ts:1940` |
| `INSPECT_VIEWER_TTL_MS` (30 s) | `session-manager.ts:19` |
| `evaluateSessionAccess` / `evaluateArchiveAccess` | `api/src/session-authz.js:71` / `:140` |
| Tests | `sdk/test/unit/inspect-viewer-spine.test.mjs` |

**`diagnosticBundle` is a rename with intent.** It is still
`agentIdentity === "agent-tuner"` today, because that is the only holder that
exists — but the question is now asked about the CAPABILITY rather than the
NAME. Phase D turns it into a check on what the agent *declared*. With
per-user namespaces two packages can both be called `agent-tuner`, so a name
must never again be the thing that grants.

## 16.3 Two things the design got wrong, corrected in code

**1. Users CAN read system sessions.** §4's matrix said "no system sessions"
for user viewers. But `SESSIONS_SYSTEM_VISIBILITY` defaults to `"read"` and
the portal already lists system sessions to every user — PilotSwarm, Sweeper
and Resource Manager appear in an ordinary user's session list today. Q2 was
"match the UI", so the worker reads the same policy through a shared
`systemSessionsReadable()` helper. A user who can see the root in their list
must not be told by an agent that it does not exist. **Control** of system
sessions stays admin-only.

**2. Fleet aggregates needed a third rule** (§16.2 above). The design assumed
two chokepoints sufficed.

## 16.4 The admin gap — CLOSED (migration 0042)

*Was: "the most important thing to know before continuing — `isAdmin` is
always `false`." It is now resolved; this section records how, and what it
cost.*

`_resolveInspectViewer` used to return `isAdmin: false` unconditionally, so
the admin row of §4's matrix was not real. The portal derived the role from
the request JWT and never persisted it; the `users` table had no role column.

**Why the JWT could not simply be forwarded.** The obvious objection — "the
token already carries `roles[]`, pass it through" — fails on three counts,
and the third is the one that kills it:

1. **Most turns have no request behind them.** `cron` / `cron_at` let a
   session wake *itself* on a timer, and §8's freshness loop is built on
   exactly that. A 3am cron firing has no user, no request, no token. Same
   for sub-agent turns (driven by the parent), crash recovery, and
   orchestration replay. Verified: nothing auth-shaped crosses into
   `session-proxy.ts` or `orchestration.ts` today.
2. **Forwarding means persisting a bearer credential.** Duroxide history is
   durable and replayed; a JWT threaded through activity input is a live
   credential at rest in Postgres, re-read on every recovery. It also breaks
   determinism — tokens carry an `exp`, so a later replay sees different
   validity.
3. **It is option 3 in disguise.** "Stamp the role at session creation" was
   rejected because a frozen privilege claim lets a demoted admin keep reach
   for the session's life. A forwarded JWT freezes the role at *request*
   time rather than *tool* time, which is the same defect with extra steps.

**What shipped: option 1, with a correction.** The design listed three
options and recommended persisting the role. Implementation found that
`authorizePrincipal` (`auth/authz/engine.js`) actually has **two branches**
with different answers, which the design had collapsed into one:

| Branch | Source | Offline-answerable? |
| --- | --- | --- |
| Email allowlist — `PORTAL_AUTHZ_ADMIN_GROUPS` / `USER_GROUPS` | env config | **Yes** — it is `email ∈ set` |
| JWT `roles[]` — Entra app-role assignments | only revealed inside a token | **No** — assignment lives in Entra |

A hybrid was considered: evaluate the allowlist branch in the worker
(*exact*, no staleness) and persist only for the Entra branch. **Rejected —
it is option 2 wearing option 1's clothes.** The worker would need the
portal's policy loading, its normalization, and its admin-before-user
precedence, and the two copies would drift on the first policy change. One
write path is worth a bounded staleness window. The single stored role covers
both branches.

**The shape.**

- **Migration 0042** adds `users.role` and `users.role_seen_at`, plus
  `cms_set_user_role` and `cms_get_user_role`. Three properties are
  load-bearing and each has a test that was **seen red** against a
  deliberately broken proc:
  - The role is **overwritten, never `COALESCE`d** — 0030's merge rule for
    display fields would preserve a higher privilege forever. Injecting a
    first-write-wins `UPDATE` turned the demotion test red with
    `expected 'admin' to be 'user'`.
  - The role is **not** a `cms_register_user` parameter, because that
    function is called by sightings carrying no role at all (share grants,
    session creates) which would otherwise wipe it.
  - `role_seen_at` marks **confirmation, not change**, so the staleness
    ceiling below means something.
- **The portal writes it** at both authenticated entry points, throttled per
  principal (5 min; a *changed* role always writes at once).
- **The worker reads it** through `evaluateRoleObservation`, a pure predicate
  living beside `evaluateSessionAccess` in `api/src/session-authz.js` — the
  same "share the predicate, never copy it" move phase A made.

**What is NOT exposed.** `recordUserRole` / `getUserRole` are on the direct
management client only and throw `webModeUnsupported` in web mode. A remote
caller able to write its own role would hold a privilege-escalation
primitive; other users' roles are not a client concern either. Same posture
as `recordAuthzAudit`.

**The residual window, stated plainly.** A stored role is an *observation*,
so a demotion lands only when the user next authenticates. If they never
return to the portal, the worker believes `admin` for up to
`ROLE_OBSERVATION_MAX_AGE_MS` (12 h) before expiring it closed. This is
worse than the portal, which reads the live token — but only by the ceiling,
because the portal is itself stale for the token's lifetime (~1 h for Entra)
after a demotion. The ceiling is what converts "unbounded until they sign in
again" into a bound.

## 16.5 Verification method — please keep this

The 14 tests in `inspect-viewer-spine.test.mjs` were validated by
**reinstating each pre-fix behaviour surgically** and confirming which
assertions go red: **9 of 14 failed**, each catching a specific hole; the 5
that stayed green are the ones that should (admin reach, own-session reads,
the frozen sentinel, the source guard). A security test never seen red proves
nothing — this codebase has taught that lesson more than once.

There is also a **grep-guard** in that file: it parses `inspect-tools.ts`,
finds every `defineTool` whose body mentions `session_id`, and fails if it
routes through none of the three rules. Adding a session-scoped tool without
a gate breaks the build. It caught four tools during implementation that I had
missed — the ones inside the conditional `duroxideClient` / `factStore`
blocks.

## 16.6 Next steps, in dependency order

**Phase B — per-user namespaces** (independent of A; start here if you want
parallelism):
- Migration 0042+: `UNIQUE (owner_provider, owner_subject, name)` for user
  scope, `UNIQUE (name) WHERE scope='shared'`. **`DROP FUNCTION` before any
  stored proc whose return shape changes** — 0041 lost an afternoon to
  `CREATE OR REPLACE` refusing a new return type.
- The blocking fact: names are **globally unique today**, stated verbatim at
  `agent-package-service.ts:151`.
- Resolution precedence: own *enabled* copy shadows shared.
- FQN parsing + reserved `__` prefix + `__shared:` binding (§9).
- `agents pull` in the CLI, from the existing `fetchAgentPackageTarGz`.

**Phase C — the write bundle** (needs A; §16.4 is now decided and shipped):
- Package mutation tools over the *existing* `agent-package-service.ts`
  functions, called with the resolved viewer.
- `propose_agent_patch` → ordered `.patch` artifacts (the portal already
  renders them; `isDiffArtifact` at `web-app.js:1306`).
- `diff_agent_versions` — post-normalization, or the canonicalizer's
  reshuffling buries every real change (§8).
- `import_agent_package` — **the §8 allowlist and §15 A1 network guards ship
  in the same commit, never a follow-up.** This is the worker's first
  outbound fetch: there is no `await fetch(` in `managed-session.ts`,
  `session-manager.ts` or `worker.ts` today. Verify that is still true before
  building it.
- Archive tools using the already-written `evaluateArchiveAccess`, plus the
  `authz_audit` write for admin reads of a foreign archive.
- Convergence refusal on **both** `create_agent_session` and
  `regenerate_session` (§15 A5).

**Phases D, E** — as written in §12.

## 16.7 Environment notes that will save an hour

- **Deploys:** `az acr build` (not local docker — the corp npm mirror
  quarantines fresh versions for 7 days and the build 404s). Do **not** pass
  `NPM_REGISTRY` to `az acr build`; it runs in Azure with unrestricted npm.
  Then `./scripts/deploy-portal.sh --skip-build`, then `kubectl set image` for
  the digest-pinned MCP.
- **Tests:** portal/ui-core/MCP suites are `node --test`, not vitest. A bare
  vitest glob also picks up `.claude/worktrees/` copies and fails confusingly.
- **`AUTHZ_ENFORCE_OWNERSHIP=true` in prod** — the portal predicate this work
  now shares is live and enforcing, not dark-launched.
- **Commit with explicit paths, never `git add -A`.** A parallel session works
  in this same checkout; `-A` swept its in-flight edits into two of my commits
  earlier today.

---

# 17. Adversarial review — the sign-in role (§16.4)

*Run against the implementation, not the design. Six findings; three changed
the code, one was pre-existing and fixed in passing, two are accepted
residuals. Each disposition says what was actually verified rather than what
was assumed.*

### B1 — HIGH. The WebSocket entry point authenticated but never recorded the role

The role write was hooked into `requireAuth` (`server.js`), which felt like
*the* chokepoint. It is not: there are exactly **two** authenticated entry
points, and `createConnectionHandler` (`api/ws.js`) calls `authenticateToken`
directly.

The failure mode is nasty precisely because it fails *closed*: a client that
connects once and lives on the socket would never re-confirm its role, so
after the 12 h ceiling the worker would silently drop that user's agent
sessions to non-admin while the portal — reading the live token — still
showed them as an admin. "Admin randomly stopped working overnight" is a
miserable bug to chase.

**Disposition — accepted, fixed.** `runtime.noteSignInRole(auth)` on both
paths. The general lesson is worth keeping: *"I hooked the chokepoint" is a
claim to verify, not a design property.* Grepping `authenticateToken(` and
`authenticateRequest(` across the repo took one search and found the second
door immediately.

### B2 — HIGH. `anonymous` is a name trusted to GRANT, which §15 A10 forbids

`anonymous` is the role an auth-disabled deployment issues, and the portal
treats it as full access. Mirroring that in the worker is right — a
deployment that turned auth off should not find its agents quietly more
restricted than its own UI. But the implementation stored `anonymous` as a
*string on a user row* and granted fleet-wide admin to anyone holding it.

Nothing today can write it for a named user: `authorizePrincipal` only
returns `anonymous` from the no-principal branch, which pairs it with
`createNoAuthUnknownPrincipal()` = `none:unknown`. So the invariant held —
**as a property of three other files staying the way they are**, which is
exactly the shape §15 A10 warns about: *trusting a name to DENY is safe;
trusting a name to GRANT is not.*

**Disposition — accepted, fixed.** `evaluateRoleObservation` admits
`anonymous` only for the `none:unknown` principal. The binding is now a
property of the predicate itself, with a test naming A10.

### B3 — MEDIUM. `role` is a PostgreSQL keyword and a `RETURNS TABLE` out-column, in the same function

`cms_get_user_role` returns a column named `role` while selecting `u.role`
from a table with a `role` column. In PL/pgSQL an out-parameter shadows
column references, and this is the classic result. It cannot be caught by
`tsc`, by review-at-a-glance, or by a fake catalog.

**Disposition — accepted, and CONFIRMED REAL rather than theoretical.**
Unqualifying the select in a throwaway schema produced
`column reference "role" is ambiguous` and turned 8 of 11 integration tests
red. The qualification is load-bearing, and the first test in
`user-role-signin.test.js` exists solely to keep it that way.

### B4 — MEDIUM. The viewer cache was unbounded (pre-existing, phase A)

`SessionManager._inspectViewerCache` is a **static** `Map` keyed by session
id whose comment claimed entries were "self-expiring via
INSPECT_VIEWER_TTL_MS". They are not: the TTL is only consulted on *read*, so
a session touched once and never again leaves its entry forever. A
long-lived worker sees an unbounded number of session ids.

Not introduced here, but this change makes each entry both costlier to
rebuild (two queries instead of one) and privilege-bearing, so it stopped
being someone else's problem.

**Disposition — accepted, fixed.** Entries are swept on insert past a
threshold, falling back to a full clear if the working set is genuinely that
large. The cost of a clear is one re-resolution per session, never a wrong
answer.

### B5 — MEDIUM. The demotion window is real, and the ceiling is the only thing bounding it

A stored role is an observation. After a demotion in the identity provider,
the worker keeps believing `admin` until the user next authenticates — and if
they never return, until `ROLE_OBSERVATION_MAX_AGE_MS` (12 h) expires it.

Worth keeping in proportion: the *portal* is also stale after a demotion, for
as long as the user's token lives (~1 h for Entra), because the `roles[]`
claim is baked into the token. The difference is the ceiling, not the
existence of a window.

**Disposition — accepted as a residual, with the bound made explicit.** The
alternative — querying Microsoft Graph from the worker per turn — trades a
bounded staleness window for a hard runtime dependency on an external service
in the path of every tool call, which is a worse failure mode. A test asserts
the ceiling is finite and under a week, specifically so nobody "fixes" a
flaky test by raising it to `Infinity` and silently restoring the unbounded
hole.

### B6 — LOW. Every authenticated principal now gets a `users` row

`cms_set_user_role` upserts through `cms_register_user`, so a user who signs
in but never creates a session now materializes a row where previously they
would not. That changes what `listKnownUsers` returns, which feeds the share
picker.

**Disposition — accepted, and mildly desirable.** Being able to share with a
colleague who has signed in but not yet created anything is better than the
current behaviour. Flagged only because it is a visible side effect that was
not the point of the change.

### What was checked and found sound

- **Identity spaces line up.** The principal written by `noteSignInRole` and
  the owner read by `_resolveInspectViewer` both come from
  `normalizeSessionOwner` / `cms_set_session_owner`, so they are the same
  `(provider, subject)` pair — verified, not assumed.
- **The System principal is not consulted.** It already reaches everything
  via `isSystemPrincipal`; the role lookup is skipped for it rather than
  trusted.
- **Role-less sightings do not clobber the role.** Share grants and session
  creates both call `cms_register_user` with no role; tested directly.
- **The role does not leak.** Not on `UserProfile`, not in `listKnownUsers`,
  not through any Web API route — asserted, not assumed.
- **Rolling-deploy safety.** A new worker against a not-yet-migrated database
  throws on `cms_get_user_role`, which is caught and yields non-admin. Fails
  closed by construction.

### Test validation (§16.5 method, applied)

Every security assertion was confirmed to go red against a deliberately
weakened build:

| Breakage | Went red |
| --- | --- |
| Unqualified `role` in the read proc | 8 of 11 integration tests, `column reference "role" is ambiguous` |
| `COALESCE(v_role, users.role)` on write | demotion (clear-to-null) + normalization |
| First-write-wins `UPDATE ... WHERE role IS NULL` | demotion (`expected 'admin' to be 'user'`), promotion, `role_seen_at` bump |
| Staleness check removed | stale expiry, the cron scenario, clock skew |
| Any truthy role counts | plain user, unrecognized role |
| `seenAt` coerced rather than type-checked | missing timestamp, non-Date timestamp |

No breakage passed silently. Suites after the change: SDK unit **164**,
migration-0042 integration **11**, portal **48**.


---

# 18. Adversarial review — phases B through E

*Run against the implementation as each phase landed. Nine findings; six
changed the code. Two of them were defects in a FIX rather than in the
original design, which is the argument for reviewing at every checkpoint
rather than once at the end.*

## C1 — CRITICAL. `spawn_agent` bypassed package privacy entirely

**Found while mapping phase B; pre-existing, and live in every deployment.**

Workers install every enabled package — user-scope ones included — because
`cms_get_agent_packages_install_manifest` is deliberately unfiltered
("workers are trusted infrastructure"). Their agents land in one flat
`userAgents` list with no tenancy attached.

The Web API *does* filter them: `_authorizePackageAgentCreate` refuses a
foreign user-scope agent at session creation. But **`spawn_agent` does not go
through the Web API.** It reaches the `resolveAgentConfig` activity directly,
which took `{ agentName }` and nothing else and matched purely on the
normalized name. So Bob's session could say "spawn alice-triager" and get
Alice's private agent.

That trust assumption — workers are trusted infrastructure — was true when it
was written and stopped being true when the multi-tenant Web API landed on
top of it. Nothing failed; the boundary just quietly moved.

**Disposition — accepted, fixed, breakage-validated.**

- The caller's session id is threaded through the **proxy**
  (`createSessionManagerProxy` → `ctx.instanceId`), *not* through the
  orchestration generator. The yield sequence is byte-identical, so this is
  **not an orchestration version change** — worth stating because the obvious
  implementation (add a parameter to the generator's call) would have been.
- The check lives in the **activity**, not at spawn time. It has to: the
  return value carries the agent's full prompt, and merely returning it writes
  that prompt into the caller's orchestration history. By spawn time the
  private material has already crossed the boundary.
- Fails closed on an unresolvable caller.
- 14 tests in `agent-package-spawn-isolation.test.js`; **6 confirmed red**
  against the pre-fix activity. The 2 that stayed green are the ones that
  should (the owner still gets their own agent; public agents stay public).

## C2 — HIGH. Migration 0043 orphaned rows it could not see

First cut of the namespace resolver walked "my copy, then shared", which is
right for a user. But it left two classes of row selectable by nothing:
**NULL-owner packages** (minted before owner stamping, or by an admin in a
no-auth deployment) and **another user's private package**, which an admin
must still be able to disable during an incident.

Both would have become invisible **and undeletable** — a migration that
quietly strands existing data.

**Disposition — accepted, fixed.** An admin fallback in `cms_agent_package_authz`
*and* in `cms_get_agent_package`. Ambiguity is refused rather than guessed: if
several copies share a name, the admin must name one. The read path got the
same fallback for a specific reason — a package an admin can destroy but
cannot inspect is the worse outcome.

## C3 — HIGH. The isolation fix's own disk layout destroyed provenance

**A defect in C1's fix, found by reviewing the fix.**

The installer keyed cache directories on `name@semver.sha256`, which contains
nothing about the owner. Two users publishing the same name at the same
version with **byte-identical content** therefore resolved to the same
directory — and the worker's dir→owner map is a `Map`, so one owner silently
overwrote the other. The loser was then denied their own agent.

Identical content is the realistic case, not a contrived one: it is exactly
what happens when two people install the same package from the same source.

**Disposition — accepted, fixed.** Cache keys gained an owner discriminator
(`name@semver.sha.u<pkgid>`). Shared packages keep the historical bare key so
existing fleet caches stay warm. GC re-keyed onto the package name, since
pruning on the full key would delete every superseded version.

## C4 — MEDIUM. Two-pass resolution, or a disabled copy becomes unreachable

Mutations must reach a **disabled** copy (otherwise disabling one is
irreversible), but reads should reflect what resolution *actually yields*
(shadowing is enable-sensitive — a disabled personal copy is supposed to fall
through to shared). Hard-coding either answer breaks the other.

**Disposition — accepted.** `cms_get_agent_package` resolves twice: live rule
first (enabled only), then the disabled row. A package whose only copy is
disabled stays inspectable; a disabled copy that has a shared sibling
correctly falls through.

## C5 — MEDIUM. Removing the tuner from `SYSTEM_AGENT_IDS` silently stripped the bundle

Phase E retired `agent-tuner` from the system set. But the deep tool bundle
was gated behind `if (!isSystemAgent) return [...]` — so the moment the
manager stopped being a system agent it lost **every tool it exists to
hold**, with no error. `createInspectTools` returned 6 tools instead of 31.

This is the coupling the design predicted in the abstract ("nothing may trust
the agent NAME") showing up concretely in a *different* set.

**Disposition — accepted, fixed.** The bundle gate is now evaluated alongside
system membership, not nested inside it. Verified by identity:
`agent-tuner` 31 · `agent-manager` 31 · `sweeper` 9 · ordinary 6.

## C6 — MEDIUM. I added a restriction the design never asked for

The first cut of `cms_publish_agent_package` refused non-admin publishes to
the `shared` scope. That was **my invention**, not the proposal's, and it
broke two existing tests.

**Disposition — reverted.** Recorded because it is the failure mode of
adversarial review itself: hardening feels productive, and unrequested
hardening is still scope creep. The proposal's actual rule — promotion is
exclusive, refused when shared holds the name — is implemented and tested.

## C7 — MEDIUM. `a:b` already meant something

§9 wants `owner:package`. But `namespace:agent` has been valid since long
before FQNs, and re-reading existing bindings as owner references would
silently repoint them.

**Disposition — accepted.** The parser reports two-segment names as
`kind: "ambiguous"`, carrying **both** readings, and never guesses.
Resolution applies a documented order — namespace first, preserving today's
meaning — and only falls through to the owner reading when the old one
resolves to nothing. Three-segment names end in a semver, a shape namespaces
never had, so they are unambiguous by construction.

## C8 — LOW-MEDIUM. The reserved prefix was forgeable from one side

`__shared` must be unforgeable, or a user could capture every reference
meaning "the deployment's copy". A TypeScript-only check would have been one
forgotten caller away from useless: CLI push, portal upload and the manager's
own import are three separate paths.

**Disposition — accepted.** Enforced in **SQL**, inside
`cms_publish_agent_package`, which every publish path funnels through.
Verified live: `__shared`, `__sneaky`, `__SHARED` refused;
`_ok` and `normal` allowed.

## C9 — LOW. Numeric host literals evaded the URL guard

The import allowlist's own test suite caught this one: `0177.0.0.1` is
`127.0.0.1` in dotted-octal, and the first cut only rejected literals with
fewer than four parts.

**Disposition — accepted, fixed.** Dotted-octal and dotted-hex forms are
refused alongside decimal (`2130706433`) and hex (`0x7f000001`).

## What is deliberately NOT done

- **Archive tools** (`list_session_archive`, `read_session_archive_file`).
  `evaluateArchiveAccess` is written and tested; the tools need
  `SessionBlobStore` threaded into the tool layer, which is plumbing rather
  than design. Until they exist, §15 A3's narrowing costs nothing.
- **Convergence guards** on `create_agent_session` / `regenerate_session`
  (§15 A5). The *skill* mandates polling `read_agent_package` until the
  active version matches, and says why sleeping is not a substitute — but it
  is guidance, not an enforced refusal.
- **Web API / CLI selector surface.** The catalog and tools take selectors;
  `/agent-packages/:name` and `pilotswarm agents` still resolve bare names
  only, so an operator cannot yet address `__shared:x` from the CLI.
- **`agents pull`.**

## Test additions

| Suite | Tests | Seen red |
| --- | --- | --- |
| `agent-package-spawn-isolation.test.js` | 14 | 6 |
| `agent-package-install-layout.test.js` | 3 | 1 |
| `agent-fqn.test.mjs` | 13 | — (pure parser) |
| `import-allowlist.test.mjs` | 25 | found a real gap (C9) |
| `import-fetch.test.mjs` | 15 | — |
| `package-diff.test.mjs` | 15 | — |
| `user-role-signin.test.js` | 11 | 8 |
| `role-observation.test.mjs` | 13 | 6 |
