# PilotSwarm upstream contribution sequence

## Table of contents

- [Purpose and scope](#purpose-and-scope)
- [Disposition boundary](#disposition-boundary)
- [Current queue](#current-queue)
- [Candidate dependency DAG](#candidate-dependency-dag)
- [Upstream contribution principles](#upstream-contribution-principles)
- [DAG drain algorithm](#dag-drain-algorithm)
- [Ratings](#ratings)
- [Important sequencing findings](#important-sequencing-findings)
- [Topologically sorted contribution candidates](#topologically-sorted-contribution-candidates)
  - [Independent starting set](#independent-starting-set)
  - [First dependent layer](#first-dependent-layer)
  - [Framework and boundary integration](#framework-and-boundary-integration)
  - [Capability runtimes](#capability-runtimes)
  - [Durable storage, routing, and observability](#durable-storage-routing-and-observability)
  - [Replay-sensitive and final dependent layer](#replay-sensitive-and-final-dependent-layer)
- [Theme-level readiness summary](#theme-level-readiness-summary)
- [Parallel execution lanes](#parallel-execution-lanes)
- [SQLmort drain commits after upstream merges](#sqlmort-drain-commits-after-upstream-merges)
- [Explicit exclusions](#explicit-exclusions)

## Purpose and scope

This document turns the remaining generic private-fork delta into a topologically sorted set of
review-sized upstream contribution candidates. It is a current-state execution plan, not a replay of the
fork's historical commits. Completed contributions are removed rather than retained as checked
items or execution history, so the document shrinks as the fork converges with upstream.

The contribution branch for every item must be created from the then-current upstream default
branch. The private fork is a behavioral reference only; it is never a source of public commit
history.

The items below are in topological merge order: every ID in `Blocked by` appears earlier.
Branches in different lanes can be prepared and reviewed in parallel. A branch that has
unmerged blockers must be rebased onto the accepted blocker implementations before it merges.

## Disposition boundary

The U-items are **candidate generic contribution units, not a requirement to publish every fork
commit or preserve every fork behavior**. Fork retirement requires every logical delta to reach
one of three outcomes:

1. **Upstream:** contribute a reusable, supportable platform capability through a clean public
   implementation.
2. **Retain outside the platform:** move SQL-owned behavior, composition, policy, or an optional
   integration to `sqlmort` or another explicitly owned extension package.
3. **Delete:** remove a workaround, unsafe shortcut, duplicate, obsolete compatibility layer, or
   behavior for which there is no durable generic product contract.

An item must be removed from this sequence rather than forced upstream when review establishes
that it has no reusable public value, upstream already provides the behavior, safe genericization
would preserve only an accidental fork constraint, or the implementation is fundamentally a
deployment workaround. Removing such an item is progress toward fork retirement, not a gap.

No U-item authorizes publishing its current fork implementation as-is. The following retained
items describe generic replacements for problematic fork implementations because downstream
platform work depends on the resulting public contract:

- [U31](#u31) contributes narrow WAF-safe request behavior, **not** the blanket MCP `/messages`
  allow rule.
- [U45](#u45) requires a verified or structurally constrained authentication design; the current
  decode-only JWT pre-tool gate must be replaced or deleted.
- [U49](#u49) contributes reusable deployment mechanics, not private node pools, registries,
  repositories, resource values, or fleet sizing.
- [U66](#u66) remains because [U68](#u68) consumes its generic approval-condition contract. If
  upstream does not want to own the concrete Azure DevOps observer, split the contract into the
  platform contribution and move only the observer implementation to an external integration
  package.

The public-sample Kusto adapter and SQLmort's unified web-client compatibility wrapper are not
U-items. Neither blocks another generic contribution: keep the adapter externally owned or
delete it, and migrate wrapper consumers to the accepted public SDK surfaces before deleting the
wrapper.

## Current queue

- Assessed private-fork source commit (`ghe/feature/aks-git-repo-worker`):
  `a6c754cfc3b53bb29a798e5345b0c2381a656224`
- Assessed public-upstream head (`origin/main`):
  `4bebb6be067fbc876717e18e6d931702cba5f7e1`
- Source inventory assessed at: **2026-09-14T20:56:35-04:00**
- Remaining candidate contribution units: **70**
- Candidates that can be initiated now because they have no blockers: **22**
- Candidates currently blocked by one or more upstream items: **48**
- Relative-risk distribution: **11 low**, **36 medium**, **23 high**
- Outstanding upstream pull requests: **5 / 5**
  ([affandar/PilotSwarm#83](https://github.com/affandar/PilotSwarm/pull/83),
  [affandar/PilotSwarm#84](https://github.com/affandar/PilotSwarm/pull/84),
  [affandar/PilotSwarm#85](https://github.com/affandar/PilotSwarm/pull/85),
  [affandar/PilotSwarm#86](https://github.com/affandar/PilotSwarm/pull/86),
  [affandar/PilotSwarm#87](https://github.com/affandar/PilotSwarm/pull/87))

These are current-state counts derived from the U-items below. Whenever an item is removed or a
dependency changes, recalculate the counts rather than retaining the previous values as history.

## Candidate dependency DAG

This diagram labels each node with its U-item number so the remaining dependency structure can
be reviewed from top to bottom. Node color represents relative upstream risk or complexity:

- Green: low
- Amber: medium
- Red: high

- [Open the vertical DAG SVG](UPSTREAM-CONTRIBUTION-DAG-VERTICAL.svg) (top to bottom)

![Upstream commit dependency DAG, vertical layout](UPSTREAM-CONTRIBUTION-DAG-VERTICAL.svg)

## Upstream contribution principles

Every proposed upstream commit must satisfy all of these principles before it is submitted.
The readiness labels later in this document describe implementation maturity, not an exemption
from this acceptance bar.

1. **Author cleanly from current upstream.** Create the contribution from the current upstream
   default branch using a clean implementation or path-scoped final-state assembly. Do not
   cherry-pick, merge, rebase, or otherwise publish private-fork commits or history.
2. **Exclude SQL-specific IP completely.** Code, tests, fixtures, examples, documentation,
   comments, commit messages, branch names, and generated artifacts must not contain SQL-owned
   providers, endpoints, audiences, repository mappings, credentials, policy, topology,
   operational incidents, or recognizable internal naming.
3. **Contribute a generic platform capability.** The change must solve a reusable PilotSwarm
   problem through provider-neutral contracts and behavior. Domain integrations may consume the
   capability, but they must not determine its abstractions, defaults, or lifecycle.
4. **Follow upstream idioms.** Use the current upstream repository's package boundaries,
   naming, configuration, error handling, dependency patterns, test framework, formatting,
   documentation style, and release conventions. Do not preserve a fork-specific pattern merely
   because the fork implementation already works.
5. **Keep one coherent behavior per commit.** Each commit must be reviewable, bisectable, and
   independently understandable. Include the tests and directly related documentation with the
   behavior they prove; do not mix opportunistic cleanup or unrelated reliability changes.
6. **Require red/green behavioral proof.** Add or identify a test that fails against the
   pre-change upstream behavior for the intended reason and passes with the change. Record the
   exact red and green commands and outcomes in the pull-request description.
7. **Test the public behavior, not the implementation.** Prefer black-box tests through the
   public API, CLI, transport, package export, rendered manifest, or observable runtime result.
   Tests should remain valid if the internal implementation is refactored without changing the
   capability.
8. **Keep tests deterministic and portable.** Upstream tests must not require private services,
   credentials, repositories, tenants, clusters, registries, or timing luck. Use hermetic
   fakes or public fixtures, control clocks and randomness where relevant, and bound all waits.
9. **Make the commit stand alone after its declared blockers.** Once the linked blockers have
   landed, the commit must build, test, document, and expose a usable behavior. Do not land dead
   contracts, inactive code paths, half-wired deployment resources, or success-shaped fallbacks.
10. **Preserve compatibility deliberately.** Public APIs, persisted data, package exports,
    environment variables, wire formats, and CLI behavior must remain backward compatible or
    carry an explicit migration and deprecation plan.
11. **Treat persistence and replay as separate safety gates.** Database changes require
    fresh-install and upgrade-path tests and a migration number allocated from current upstream
    at merge time. Durable orchestration changes require a new frozen version plus replay and
    continue-as-new coverage from the preceding upstream version.
12. **Apply security and privacy review at every boundary.** Validate authentication rather
    than trusting decoded claims, enforce least privilege and audience isolation, avoid secret
    logging, constrain URLs and loaded code, and fail closed when authorization cannot be
    established.
13. **Provide bounded, observable failure behavior.** Timeouts, retries, cancellation,
    shutdown, resource limits, and error propagation must be explicit. Logs and diagnostics must
    be actionable without exposing credentials or private customer/domain data.
14. **Avoid environment-specific defaults.** Operational tuning, cloud restrictions, registry
    mirrors, node sizes, concurrency, memory, timeouts, and ingress exceptions should be
    configurable and justified by generic behavior. Private fleet values do not become upstream
    defaults.
15. **Check performance and cross-platform impact.** Changes to hot paths, polling, storage,
    networking, builds, or worker startup require a bounded regression check. Linux, Windows,
    local, and clustered behavior should remain consistent where the capability claims support.
16. **Document the public contract and ownership boundary.** Explain what upstream owns, what
    plugin or deployment authors provide, supported failure modes, compatibility guarantees, and
    a neutral example. Do not use internal runbooks as upstream documentation.
17. **Let upstream review become authoritative.** Apply review changes to the contribution
    branch first, mirror the accepted public delta back into the private fork, and then merge the
    resulting upstream commit into the fork. The theme is complete only when its logical
    fork-versus-upstream delta drains to zero.
18. **Make this plan converge to zero.** After an upstream contribution merges, follow the
    merge-commit protocol in `SQLFORK-TRANSITION-PLAN.md` to merge the updated upstream branch
    into the private fork and prove that the contributed logical delta drained. Remove the
    completed item from this document instead of marking it complete or recording when it
    happened. Recalculate the queue statistics and every downstream `Blocked by`, readiness,
    risk, test, limitation, and proposed commit-message entry affected by the accepted upstream
    implementation, then regenerate `UPSTREAM-CONTRIBUTION-DAG-VERTICAL.svg`. This document
    and its DAG artifact must contain
    only remaining work and must disappear when no fork-only platform capability remains.
19. **Verify contribution provenance and licensing.** Include only code and dependencies that
    can be contributed under the upstream repository's license and contribution policy. Replace
    or independently implement anything whose ownership or provenance is uncertain.
20. **Lead with generic platform value.** Start the pull-request description with a concise
    `Why` section describing the reusable capability and the platform problem it solves. Do not
    use a "why this belongs in PilotSwarm" heading or frame the contribution as a justification
    against one downstream deployment. Call out the specific compatibility, security, lifecycle,
    performance, or portability areas reviewers should scrutinize alongside the exact red/green
    proof required above.

### Pull-request description template

Use this structure unless the upstream repository adopts a more specific template:

```text
## Why

<One concise paragraph describing the generic platform value.>

## What changed

- <Review-sized behavior and public contract changes>

## Behavioral proof

**Command:**

<Exact command used for both states>

- **Red — test-only patch on `main`:** <Observed pre-change failure>
- **Green — this branch:** <Observed passing result>

If the red and green proof genuinely require different commands, list each command separately and
explain why. Do not duplicate identical command blocks.

## Risk assessment

**Relative risk: <Low | Medium | High>**

<Concise explanation of the rating, including the affected boundary, compatibility exposure,
failure modes, and the tests or design constraints that reduce the risk.>

## Review focus

- <Compatibility, security, lifecycle, performance, or portability boundaries to scrutinize>
```

Do not mention the private transition plan, U-item number, SQL-owned scenario, or private-fork
implementation in the public description. Add separate compatibility or migration sections only
when they help reviewers evaluate a real public contract change. The risk rating is relative to
the current upstream platform, not to the already-deployed private fork.

## DAG drain algorithm

The DAG is an executable convergence algorithm, not only a suggested serial order. Repeat this
cycle until the graph is empty. Re-enter the cycle whenever a source-bearing private fork commit
lands, even when no upstream pull request has merged. A commit whose changed paths are wholly
limited to `UPSTREAM-CONTRIBUTION-SEQUENCE.md` and
`UPSTREAM-CONTRIBUTION-DAG-VERTICAL.svg` is transition bookkeeping: ignore it for source-inventory
recomputation and do not advance the assessed private-fork source commit:

1. **Refresh the moving source inventory.** Fetch the current upstream default branch and private
   fork feature branch before computing the eligible set or filling an available pull-request
   slot. Inspect commits after the assessed private-fork source commit, excluding bookkeeping-only
   commits as defined above, and classify every new, changed, or removed fork-only delta. A commit
   that mixes planning artifacts with source changes is source-bearing and must be assessed. Add
   or revise a candidate when it is a generic platform capability, route SQL-owned behavior to
   `sqlmort`, and identify obsolete behavior for deletion. Recalculate affected dependencies,
   scope, readiness, risk, coverage, and overlap with prepared or open contribution branches. The
   fork remains a behavioral reference only: never publish its commits or history.
2. **Compute the eligible set.** Select every remaining node whose `Blocked by` set is
   empty because it never had predecessors or all of its predecessors have merged upstream and
   been drained from the fork.
3. **Process independent eligible nodes in parallel.** Create one isolated branch and worktree
   per candidate from the then-current upstream default branch. Never stack unrelated eligible
   candidates on one another. A candidate may include only already-merged predecessors.
4. **Disposition and de-risk each candidate independently.** Confirm that the node still belongs
   upstream rather than in an external package or deletion. Reduce its implementation, test,
   security, compatibility, and operational risk as far as practical. If this work exposes a
   real predecessor, add the missing DAG edge and remove the node from the current eligible set.
5. **Open review-sized pull requests concurrently.** Every branch must satisfy the contribution
   principles and carry its own red/green proof, generic-platform value statement, and focused
   review watchouts. Parallel eligibility does not justify combining independent behaviors into
   one pull request. Keep a hard limit of **five outstanding upstream pull requests** across this
   transition, including draft or otherwise open pull requests. Prepare additional eligible
   branches locally, but do not open them until a slot is available. **High-risk candidates have
   an additional human approval gate.** The same gate applies to **security-sensitive candidates
   at any risk level**, including changes involving authentication, authorization, identities,
   credentials, secret handling, network trust boundaries, or externally loaded code. It also
   applies to **git-based worker design**, including repository checkout, ref handling,
   hydration/dehydration, workspace ownership, repository credentials, and worker lifecycle
   integration. These candidates may be investigated and de-risked in advance, but their upstream
   pull requests must not be created autonomously. Present the proposed scope, design, diff,
   tests, title, description, universal-value argument, security analysis, and review watchouts
   to the transition owner and obtain explicit approval first.
6. **Let upstream review define the accepted implementation.** Apply feedback on the public
   contribution branch and keep the corresponding fork behavior aligned with the reviewed
   public delta. Rebase each still-open independent branch onto current upstream when accepted
   changes or other merged eligible nodes overlap it.
7. **Monitor the open eligible set.** Track required checks, requested changes, unresolved review
   threads, and reviewer inactivity. Human owners may need to request or prompt review, but a
   blocked pull request does not prevent unrelated eligible pull requests from progressing within
   the five-PR ceiling. When a pull request merges or closes, refill the available slot with the
   ready eligible candidate that has the lowest residual risk and least overlap with outstanding
   reviews; use dependency-unblocking value as the next tie-breaker.
8. **Drain each merged node immediately.** After a pull request enters the upstream default
   branch, follow the merge-commit protocol in `SQLFORK-TRANSITION-PLAN.md`. Merge the resulting
   upstream default branch into the private fork, preserve explicitly retained downstream
   behavior, and prove that the upstreamed logical delta is absent from the fork-only tree diff.
9. **Recompute instead of preserving history here.** After a node drains or a source-bearing
   private fork change lands, remove drained nodes and revise, split, add, or delete affected
   candidates. Recalculate queue and risk totals, update every affected `Blocked by` set,
   readiness statement, coverage claim, and prepared or open branch assumption, then regenerate
   the SVG. Advance the assessed private-fork source commit only to the newest source-bearing
   commit included in that inventory. If a fork change invalidates an open contribution's scope
   or proof, reconcile that pull request before it can merge. The resulting graph exposes the next
   eligible set, which begins the next cycle.

Multiple nodes can therefore be in preparation, review, or merge-drain stages simultaneously.
The invariant is per-node independence and correct predecessor ancestry, not serial execution.
Parallel preparation is unbounded by the review ceiling, but the public review queue must never
contain more than five outstanding transition pull requests.

## Ratings

Readiness:

- **Ready**: the generic behavior and direct tests are sufficient to assemble an upstream
  change now, subject to the contribution principles above.
- **Near-ready**: the capability is sound, but the listed cleanup or missing test must be
  completed before submission.
- **Not-ready**: a design, security, packaging, or durable-replay decision is still required.

Coverage:

- **Enough**: existing tests appear capable of proving the observable behavior without private
  infrastructure. The contribution still requires explicit red/green proof against upstream.
- **Partial**: useful tests exist, but an important boundary or integration path is missing.
- **Insufficient**: the proposed public contract lacks direct automated coverage.

Risk is relative to upstream PilotSwarm, not to the already deployed private fork.
Risk, security sensitivity, and git-worker scope also control execution: regardless of readiness
or current eligibility, every high-risk, security-sensitive, or git-based worker candidate
requires the explicit pre-PR approval described in the DAG drain algorithm.

## Important sequencing findings

1. Theme 5 cannot precede the relevant Theme 4 auth-discovery contract in its current form.
2. Upstream now already contains durable orchestration versions through `1.0.78`. The old
   plan warning about reconciling independent `1.0.68/69` implementations is stale. The fork's
   remaining replay boundary is `1.0.79`.
3. Replay-affecting changes must be activated together in the `1.0.79` commit. Supporting
   storage, validation, and client contracts may land earlier only if they do not change the
   active orchestration handler.
4. Migration-bearing commits form a serialized merge lane even when their code can be prepared
   in parallel. Allocate migration numbers from current upstream at merge time.
5. The migration lane should preserve these logical boundaries:
   - M1: final git-state schema, combining fork migrations `0079 + 0080`
   - M2: JobGenerator foundation and opaque provider IDs, combining `0081 + 0082 + 0092`
   - M3: lifecycle state runs and journal, retaining `0083`
   - M4: external operations, retaining `0084`
   - M5: final durable wait schema, combining `0089 + 0090 + 0091`
   - M6: worker timeline index, retaining `0085`
   - M7: worker registration and session routing, combining `0086 + 0087`
   - M8: cleanup and tombstones, retaining `0088`

This consolidation describes new upstream migrations. It does not authorize rewriting the
already deployed private-fork migration ledger.

## Topologically sorted contribution candidates

### Independent starting set

These branches have no capability blockers and can be prepared immediately in parallel.

<a id="u01"></a>
### U01 - classify transient Postgres failures and jitter retries

- Theme / lane: Reliability / 11
- Blocked by: None
- Upstream PR: [affandar/PilotSwarm#84](https://github.com/affandar/PilotSwarm/pull/84) — open
- Value: Adds bounded retry categories, structured-code precedence, jitter, saturation handling, and actionable logs.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: `packages/sdk/test/unit/cms-retry.test.mjs`
- Limitations: Keep the structured-code allowlist and message fallbacks narrow so deterministic
  failures are never retried. The public branch is cleanly authored from current upstream.
- Proposed commit message:

```text
feat(sdk): classify transient Postgres failures and jitter retries

Adds bounded retry categories, structured-code precedence, jitter, saturation handling, and actionable logs.
Assemble the final behavior on current upstream rather than replaying fork history.
Safety comes from existing automated coverage, including packages/sdk/test/unit/cms-retry.test.mjs.
```

<a id="u02"></a>
### U02 - add process and session poison diagnostics

- Theme / lane: Reliability / 11
- Blocked by: None
- Value: Gives operators stable host, PID, runtime-version, and session evidence for poison investigation.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: direct diagnostic tests plus client and management integration tests
- Limitations: Keep the public contribution to the supported diagnostic module and privacy-safe,
  bounded process metadata; the untested trace script is excluded. This bounded operational
  diagnostics scope is not security-sensitive and does not require the pre-PR approval gate.
- Proposed commit message:

```text
feat(sdk): add process and session poison diagnostics

Gives operators stable host, PID, runtime-version, and session evidence for poison investigation.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u03"></a>
### U03 - log unhandled API failures with request context

- Theme / lane: Reliability / 11
- Blocked by: None
- Value: Prevents server-side 5xx causes and stacks from disappearing.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: router tests prove structured server logging and an unchanged
  sanitized client response
- Limitations: Error messages remain server-log data and require normal retention and access
  controls. Request identifiers and logging failures must not affect the response. This
  privacy-safe server logging scope is not security-sensitive and does not require the pre-PR
  approval gate.
- Proposed commit message:

```text
fix(web): log unhandled API failures with request context

Prevents server-side 5xx causes and stacks from disappearing.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Add direct upstream tests that prove the public contract and error paths before merge.
```

<a id="u04"></a>
### U04 - separate blob and database managed identities

- Theme / lane: Reliability / 11
- Blocked by: None
- Value: Lets storage and database authentication use independent identities and failure domains.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: `packages/sdk/test/unit/blob-store-mi-flag.test.mjs`
- Limitations: Keep identity names and concrete Azure resources out of the public change. The
  fork now covers explicit enablement, explicit disablement, inherited database identity, and
  configuration-error precedence; retain that matrix in the independently authored public change.
- Proposed commit message:

```text
fix(worker): separate blob and database managed identities

Lets storage and database authentication use independent identities and failure domains.
Keep identity names and concrete Azure resources out of the public change.
Safety comes from existing automated coverage, including packages/sdk/test/unit/blob-store-mi-flag.test.mjs.
```

<a id="u05"></a>
### U05 - make turn inactivity timeouts configurable

- Theme / lane: Reliability / 11
- Blocked by: None
- Upstream PR: [affandar/PilotSwarm#86](https://github.com/affandar/PilotSwarm/pull/86) — open
- Value: Makes the watchdog reusable across slow tools and different fleet profiles.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: `packages/sdk/test/unit/worker-turn-inactivity-timeout.test.mjs`
- Limitations: The environment is resolved at worker construction, `0` disables the watchdog,
  and invalid values preserve the established default. No private fleet timeout is proposed.
- Proposed commit message:

```text
feat(worker): make turn inactivity timeouts configurable

Makes the watchdog reusable across slow tools and different fleet profiles.
Upstream the knob, not the private fleet's exact timeout or single-slot defaults.
Safety comes from existing automated coverage, including packages/sdk/test/unit/worker-turn-inactivity-timeout.test.mjs.
```

<a id="u06"></a>
### U06 - parse repository MCP configuration as JSONC

- Theme / lane: MCP / 4
- Blocked by: None
- Value: Accepts comments and trailing commas in repository MCP configuration while retaining path and environment validation.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: `packages/sdk/test/unit/mcp-loader-cwd.test.mjs`
- Limitations: Keep examples provider-neutral.
- Proposed commit message:

```text
feat(sdk): parse repository MCP configuration as JSONC

Accepts comments and trailing commas in repository MCP configuration while retaining path and environment validation.
Keep examples provider-neutral.
Safety comes from existing automated coverage, including packages/sdk/test/unit/mcp-loader-cwd.test.mjs.
```

<a id="u07"></a>
### U07 - add validated external plugin source specifications

- Theme / lane: Plugins / 4
- Blocked by: None
- Value: Adds a generic `PluginSpec` parser and installer for local, GitHub, and Azure DevOps plugin sources.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `plugin-spec.test.mjs` and `plugin-source-spec.test.mjs` cover
  validation, per-entry quarantine, relative local repositories, containment, atomic replacement,
  cleanup, and real Git fetches
- Limitations: The upstream change must contain only the provider-neutral local/Git contract and
  injected credential seam. External code loading makes this security-sensitive and requires
  explicit pre-PR approval.
- Proposed commit message:

```text
feat(sdk): add validated external plugin source specifications

Adds a provider-neutral PluginSpec parser and installer for local and Git plugin sources.
Keeps credentials injected, validates refs and paths, confines checkouts, and preserves valid peers and previous installations when one source fails.
Safety comes from hermetic validation, containment, failure-isolation, replacement, and synthetic Git tests.
```

<a id="u08"></a>
### U08 - discover MCP resource audiences from bearer challenges

- Theme / lane: MCP auth / 4
- Blocked by: None
- Value: Adds reusable `WWW-Authenticate`, protected-resource metadata, audience normalization, and discovery primitives.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: hardened unit and compatibility tests cover challenge grammar,
  token68, parameterless schemes, redirects, deadlines, response limits, IPv4/IPv6 SSRF, required
  failure, and optional omission
- Limitations: JWT decoding remains routing-only claim inspection, never authentication.
  Authentication and network-boundary behavior make this security-sensitive and require explicit
  pre-PR approval.
- Proposed commit message:

```text
feat(sdk): discover MCP resource audiences from bearer challenges

Adds reusable WWW-Authenticate, protected-resource metadata, audience normalization, and discovery primitives.
JWT decoding must be documented and enforced as routing-only claim inspection, never token authentication.
Safety comes from existing automated coverage, including packages/sdk/test/local/mcp-auth-discovery.test.mjs.
```

<a id="u09"></a>
### U09 - publish canonical provider contracts

- Theme / lane: Providers / 2a
- Blocked by: None
- Value: Creates one versioned provider ABI so external repositories no longer carry structural copies.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: standalone contract tests, package build/lint, tarball dry-run, and
  publishing-workflow coverage
- Limitations: The root export is the sole public contract; `./contracts` is intentionally
  unsupported. Package-publishing workflow changes are security-sensitive and require explicit
  pre-PR approval.
- Proposed commit message:

```text
feat(job-generator-provider): publish canonical provider contracts

Creates one versioned provider ABI so external repositories no longer carry structural copies.
Make the package publishable, choose root versus ./contracts export, and add contract-focused tests that do not require the host.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u10"></a>
### U10 - publish typed runtime model catalog results

- Theme / lane: SDK boundary / reverse
- Blocked by: None
- Upstream PR: [affandar/PilotSwarm#83](https://github.com/affandar/PilotSwarm/pull/83) — open
- Value: Replaces `any[]` model-catalog responses with a stable public wire type and validation.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: direct normalization, generated API, package export, and consumer
  type tests
- Limitations: Missing model identity now fails explicitly. Keep opaque capability values and
  provider policy outside the SDK contract.
- Proposed commit message:

```text
feat(sdk): publish typed runtime model catalog results

Replaces any[] model-catalog responses with a stable public wire type and validation.
Add direct normalization/type tests upstream. Keep provider names and deployment-specific catalog policy out.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u11"></a>
### U11 - add reusable session tool-event tracking

- Theme / lane: SDK boundary / reverse
- Blocked by: None
- Value: Gives clients one deduplicating live-plus-durable tracker for tool starts and completions.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: direct tests cover bounded catch-up, event normalization, sequence
  deduplication, start/complete correlation, unsubscribe/idempotent finish, and explicit catch-up
  failure propagation
- Limitations: Preserve bounded durable catch-up and propagate failures rather than returning a
  success-shaped partial history.
- Proposed commit message:

```text
feat(sdk): add reusable session tool-event tracking

Gives clients one deduplicating live-plus-durable tracker for tool starts and completions.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Safety comes from direct deduplication, correlation, lifecycle, bounded catch-up, and failure-path tests.
```

<a id="u12"></a>
### U12 - export reusable web authentication bootstrap

- Theme / lane: SDK boundary / reverse
- Blocked by: None
- Value: Exposes the existing no-auth, dev-auth, configured-token, and Entra bootstrap as a supported Node SDK surface.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: Node subpath, provider precedence, token caching, refresh coalescing,
  caller/bootstrap credential ownership, retryable cleanup, and explicit failure tests
- Limitations: Keep the API Node-only, keep credential ownership explicit, and exclude downstream
  audience mappings. Authentication and credential lifecycle make this security-sensitive and
  require explicit pre-PR approval.
- Proposed commit message:

```text
feat(sdk): export reusable web authentication bootstrap

Exposes the existing no-auth, dev-auth, configured-token, and configured identity-provider bootstrap as a supported Node SDK surface.
Expose the bootstrap only from the Node subpath with explicit credential ownership and bounded token caching.
Safety comes from provider-precedence, refresh-coalescing, ownership, cleanup-retry, and failure-path tests.
```

<a id="u13"></a>
### U13 - support external environments and configurable package registries

- Theme / lane: Deployment / 10
- Blocked by: None
- Value: Lets a deployment overlay external values and pass a configured npm registry into image builds.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: `deploy/scripts/test/local-env.test.mjs`, `compose-env.test.mjs`, `deploy-cli.test.mjs`, `dockerfile-lockfile.test.mjs`
- Limitations: Keep the registry configurable; do not make the corporate proxy the public default.
- Proposed commit message:

```text
feat(deploy): support external environments and configurable package registries

Lets a deployment overlay external values and pass a configured npm registry into image builds.
Keep the registry configurable; do not make the corporate proxy the public default.
Safety comes from existing automated coverage, including deploy/scripts/test/local-env.test.mjs, compose-env.test.mjs, deploy-cli.test.mjs, dockerfile-lockfile.test.mjs.
```

<a id="u14"></a>
### U14 - add before and after turn lifecycle hooks

- Theme / lane: Worker / 8
- Blocked by: None
- Value: Creates the generic extension points needed by repository hydration and other worker-owned preparation/cleanup.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: focused tests cover ordering, completion, cancellation, user stop,
  returned errors, thrown errors, and dual-failure precedence
- Limitations: Hooks run once per activity attempt, so durable retries invoke them again. Keep the
  generic lifecycle outside specialized repository hooks.
- Proposed commit message:

```text
feat(worker): add before and after turn lifecycle hooks

Creates the generic extension points needed by repository hydration and other worker-owned preparation/cleanup.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Safety comes from direct ordering, cancellation, returned/thrown failure, and hook-precedence tests.
```

<a id="u15"></a>
### U15 - own session workspaces and repository configuration discovery

- Theme / lane: Worker / 8
- Blocked by: None
- Value: Makes working-directory, `.github` configuration, skills, and agent discovery platform invariants rather than caller options.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: direct tests cover confinement, case-variant IDs, traversal,
  symlink/junction rejection, ownership markers, warm/cold cleanup, caller-owned preservation, and
  opt-in repository configuration discovery
- Limitations: Platform-owned paths are opaque digest directories and repository-authored
  configuration remains denied by default. Refresh the prepared change against current upstream
  without losing its new runtime `excludedTools` binding fingerprint. This is git-worker design
  and requires explicit pre-PR design approval.
- Proposed commit message:

```text
feat(worker): own session workspaces and repository configuration discovery

Makes working-directory, .github configuration, skills, and agent discovery platform invariants rather than caller options.
Keep filesystem ownership, cleanup authority, and repository-configuration trust boundaries explicit.
Safety comes from direct confinement, ownership, cleanup, case-isolation, and discovery tests.
```

<a id="u16"></a>
### U16 - publish runtime provenance and retain package-less workers

- Theme / lane: Worker / 8
- Blocked by: None
- Value: Adds host/build provenance and prevents valid workers from disappearing solely because they have no agent package.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `worker-registry-heartbeat.test.mjs`, `packages/sdk/test/local/worker-registry.test.js`, UI node-map tests
- Limitations: Keep build metadata generic, non-secret, normalized, and bounded. Preserve the
  historical `null` wire shape for absent core provenance fields.
- Proposed commit message:

```text
feat(worker): publish runtime provenance and retain package-less workers

Adds host/build provenance and prevents valid workers from disappearing solely because they have no agent package.
Keep build metadata generic and non-secret.
Safety comes from existing automated coverage, including worker-registry-heartbeat.test.mjs, packages/sdk/test/local/worker-registry.test.js, UI node-map tests.
```

<a id="u17"></a>
### U17 - hydrate older session history on demand

- Theme / lane: Portal / 6
- Blocked by: None
- Value: Makes refreshed or long sessions able to reach their first prompt without loading the full history initially.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: race, duplicate-request, navigation, cancellation, paging, and
  missing-chat fallback tests
- Limitations: Current upstream `0.5.73` added guarded wheel/touch history paging and DOM-anchor
  preservation. Rebuild the prepared change from that head and retain those accepted behaviors
  while adding only the live-seed hydration correctness guards. Also retain native-task, canvas,
  outbox, model, and context reconciliation.
- Proposed commit message:

```text
feat(portal): hydrate older session history on demand

Makes refreshed or long sessions able to reach their first prompt without loading the full history initially.
Reconcile with current upstream session loading and search behavior while preserving all existing state reconciliation.
Safety comes from race, duplicate-request, navigation, cancellation, paging, and fallback tests.
```

<a id="u18"></a>
### U18 - add reusable worker-timeline layout helpers

- Theme / lane: Portal / 6
- Blocked by: None
- Upstream PR: [affandar/PilotSwarm#87](https://github.com/affandar/PilotSwarm/pull/87) — open
- Value: Isolates visible-span zoom and deterministic lane ordering from the large timeline renderer.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: `worker-timeline-zoom.test.mjs`, `worker-timeline-lane-order.test.mjs`
- Limitations: Submit only the pure helpers and tests, not the dependent JobGenerator UI.
- Proposed commit message:

```text
feat(portal): add reusable worker-timeline layout helpers

Isolates visible-span zoom and deterministic lane ordering from the large timeline renderer.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Safety comes from existing automated coverage, including worker-timeline-zoom.test.mjs, worker-timeline-lane-order.test.mjs.
```

<a id="u19"></a>
### U19 - raise command output capacity for large renders

- Theme / lane: Deployment / 11
- Blocked by: None
- Upstream PR: [affandar/PilotSwarm#85](https://github.com/affandar/PilotSwarm/pull/85) — open
- Value: Prevents `ENOBUFS` when deployment tools emit large manifest or build output while
  retaining a finite per-stream memory bound.
- Readiness: Ready
- Relative risk: Low
- Existing coverage: Enough: `deploy/scripts/test/common.test.mjs` reproduces output beyond
  Node's default buffer and rejects unbounded overrides
- Limitations: The named 64 MiB capacity applies independently to stdout and stderr; review peak
  memory when both streams approach the bound.
- Proposed commit message:

```text
fix(deploy): bound captured command output

Prevents ENOBUFS when deployment tools emit large manifest or build output while retaining a finite per-stream memory bound.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Safety comes from automated coverage that reproduces the default-buffer failure and rejects unbounded overrides.
```


### First dependent layer

<a id="u20"></a>
### U20 - make node-postgres pools recover from transient failures

- Theme / lane: Reliability / 11
- Blocked by: [U01](#u01)
- Value: Adds bounded connection/query timeouts, keepalive, pool warming, and recovery from half-open connections.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `packages/sdk/test/unit/pg-pool-resiliency.test.mjs`
- Limitations: Separate generic defaults from environment-specific pool sizing.
- Proposed commit message:

```text
feat(sdk): make node-postgres pools recover from transient failures

Adds bounded connection/query timeouts, keepalive, pool warming, and recovery from half-open connections.
Separate generic defaults from environment-specific pool sizing.
Safety comes from existing automated coverage, including packages/sdk/test/unit/pg-pool-resiliency.test.mjs.
```

<a id="u21"></a>
### U21 - make duroxide pool acquisition resilient

- Theme / lane: Reliability / 11
- Blocked by: [U01](#u01)
- Value: Applies bounded acquire and retry behavior to the durable orchestration provider.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `packages/sdk/test/unit/duroxide-pool-resiliency.test.mjs`
- Limitations: Reconfirm the public duroxide option names against the version current upstream uses when the PR is cut.
- Proposed commit message:

```text
feat(sdk): make duroxide pool acquisition resilient

Applies bounded acquire and retry behavior to the durable orchestration provider.
Reconfirm the public duroxide option names against the version current upstream uses when the PR is cut.
Safety comes from existing automated coverage, including packages/sdk/test/unit/duroxide-pool-resiliency.test.mjs.
```

<a id="u22"></a>
### U22 - add standalone and instance-scoped service manifests

- Theme / lane: Deployment / 10
- Blocked by: [U13](#u13)
- Value: Lets one service type have isolated named instances, service-owned configuration, and independent Bicep/Flux/Kustomize state.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough for the framework: `services-manifest.test.mjs`, `local-env.test.mjs`, `git-cache-deploy.test.mjs`
- Limitations: Extract the generic schema/staging changes from the concrete git-cache service. Avoid making AKS the abstract service contract.
- Proposed commit message:

```text
feat(deploy): add standalone and instance-scoped service manifests

Lets one service type have isolated named instances, service-owned configuration, and independent Bicep/Flux/Kustomize state.
Extract the generic schema/staging changes from the concrete git-cache service. Avoid making managed-cluster the abstract service contract.
Safety comes from existing automated coverage, including services-manifest.test.mjs, local-env.test.mjs, git-cache-deploy.test.mjs.
```

<a id="u23"></a>
### U23 - persist and mint caller tokens by resource audience

- Theme / lane: MCP auth / 4 + reverse
- Blocked by: [U08](#u08), [U12](#u12)
- Value: Establishes the public audience-token map, minting helper, TTL policy hooks, and secure session persistence seam.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: This spans public auth contracts, token persistence, and expiry behavior across session boundaries with only partial upstream coverage.
- Existing coverage: Partial: `mcp-auth-discovery.test.mjs`, `repo-mcp-access.test.mjs`, SQLmort `test_delegated_auth.ts`
- Limitations: Choose one canonical error/type surface and add token-expiry and credential-failure tests upstream. SQL-owned audience mappings stay in SQLmort.
- Proposed commit message:

```text
feat(sdk): persist and mint caller tokens by resource audience

Establishes the public audience-token map, minting helper, TTL policy hooks, and secure session persistence seam.
Choose one canonical error/type surface and add token-expiry and credential-failure tests upstream. downstream-specific audience mappings stay in the downstream app.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u24"></a>
### U24 - compose fleet-default and agent-bound MCP servers

- Theme / lane: MCP / 4
- Blocked by: [U06](#u06)
- Value: Supports deployment defaults, repository definitions, and agent-bound overrides with deterministic precedence.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `default-mcp-loader.test.mjs`, `agent-mcp-servers.test.mjs`, `agent-mcp-allowlist.test.mjs`
- Limitations: Remove the historical ADO wording from the public documentation and fixtures.
- Proposed commit message:

```text
feat(sdk): compose fleet-default and agent-bound MCP servers

Supports deployment defaults, repository definitions, and agent-bound overrides with deterministic precedence.
Remove the historical provider-specific wording from the public documentation and fixtures.
Safety comes from existing automated coverage, including default-mcp-loader.test.mjs, agent-mcp-servers.test.mjs, agent-mcp-allowlist.test.mjs.
```

<a id="u25"></a>
### U25 - bind repository-provided agents in repository workers

- Theme / lane: Worker / 8
- Blocked by: [U15](#u15), [U24](#u24)
- Value: Ensures repository agent packages and their MCP grants are active in repo-bound sessions.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `session-manager-repo-agent-bind.test.mjs`, agent binding lifecycle tests
- Limitations: Keep repository trust and agent-name collision behavior explicit.
- Proposed commit message:

```text
fix(worker): bind repository-provided agents in repository workers

Ensures repository agent packages and their MCP grants are active in repo-bound sessions.
Keep repository trust and agent-name collision behavior explicit.
Safety comes from existing automated coverage, including session-manager-repo-agent-bind.test.mjs, agent binding lifecycle tests.
```

<a id="u26"></a>
### U26 - route repository-less sessions and advertise serviceable repositories

- Theme / lane: Worker / 8
- Blocked by: [U16](#u16)
- Value: Adds a generic pool for repo-less work and derives the portal repository allowlist from live worker registrations.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Partial: `activity-routing.test.mjs`, worker registry tests, `new-session-flow.test.mjs`
- Limitations: Add an end-to-end routing test covering one repo-less and two repo-bound workers.
- Proposed commit message:

```text
feat(worker): route repository-less sessions and advertise serviceable repositories

Adds a generic pool for repo-less work and derives the portal repository allowlist from live worker registrations.
Keep the routing contract explicit for both repo-less and repo-bound sessions.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u27"></a>
### U27 - add Windows worker images with noninteractive Azure CLI

- Theme / lane: Devbox / 9
- Blocked by: [U13](#u13), [U22](#u22)
- Value: Provides a reproducible Windows worker base and an Azure CLI variant needed for popup-free devbox authentication.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: This changes cross-platform worker image packaging and deployment inputs on Windows with only limited build-focused coverage today.
- Existing coverage: Partial: `deploy/scripts/test/windows-worker-build.test.mjs`
- Limitations: Split generic Windows packaging from concrete fleet manifests. Pin and document the toolchain; do not embed private registries or feeds.
- Proposed commit message:

```text
feat(worker): add Windows worker images with noninteractive Azure CLI

Provides a reproducible Windows worker base and an Azure CLI variant needed for popup-free devbox authentication.
Split generic Windows packaging from concrete fleet manifests. Pin and document the toolchain; do not embed private registries or feeds.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u28"></a>
### U28 - authenticate repository MCP processes to configured package feeds

- Theme / lane: MCP / 4
- Blocked by: [U07](#u07), [U24](#u24), [U27](#u27)
- Value: Enables repo-launched .NET MCP servers to restore from authenticated package feeds.
- Readiness: Not-ready
- Relative risk: High
- High-risk reason: Feed authentication crosses secret-bearing process boundaries and is still coupled to provider-specific credential wiring without hermetic black-box tests.
- Existing coverage: Insufficient
- Limitations: The current implementation is coupled to ADO/NuGet and worker-specific Key Vault wiring. Define a generic package-feed credential contract and add hermetic process-environment tests first.
- Proposed commit message:

```text
feat(worker): authenticate repository MCP processes to configured package feeds

Enables repo-launched .NET MCP servers to restore from authenticated package feeds.
The current implementation is coupled to provider-specific package-feed and worker-specific secret-store wiring. Define a generic package-feed credential contract and add hermetic process-environment tests first.
Add direct upstream tests that prove the public contract and error paths before merge.
```

<a id="u29"></a>
### U29 - persist worker ownership across restarts

- Theme / lane: Devbox / 9
- Blocked by: [U16](#u16)
- Value: Gives the devbox launcher a canonical, stable owner identity and preload behavior.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `scripts/test/devbox-owner.test.mjs`
- Limitations: Keep owner identity separate from model and downstream-service credentials.
- Proposed commit message:

```text
feat(devbox): persist worker ownership across restarts

Gives the devbox launcher a canonical, stable owner identity and preload behavior.
Keep owner identity separate from model and downstream-service credentials.
Safety comes from existing automated coverage, including scripts/test/devbox-owner.test.mjs.
```

<a id="u30"></a>
### U30 - host and load external provider modules

- Theme / lane: Providers / 2a
- Blocked by: [U09](#u09)
- Value: Adds trusted module loading, API-version checks, HTTP evaluation, bearer rotation, limits, health, and bounded shutdown.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough: `packages/job-generator-provider/test/provider-host.test.mjs`
- Limitations: Make the package public, keep SQL providers out, and document the trusted-code boundary for loaded modules.
- Proposed commit message:

```text
feat(job-generator-provider): host and load external provider modules

Adds trusted module loading, API-version checks, HTTP evaluation, bearer rotation, limits, health, and bounded shutdown.
Make the package public, keep downstream providers out, and document the trusted-code boundary for loaded modules.
Safety comes from existing automated coverage, including packages/job-generator-provider/test/provider-host.test.mjs.
```

<a id="u31"></a>
### U31 - make session creation and pagination WAF-safe

- Theme / lane: API and ingress / 11
- Blocked by: [U22](#u22)
- Value: Avoids false positives by using stable request shapes and narrowly permits required session routes in the reference ingress.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Partial: API protocol/router/browser-contract tests
- Limitations: Add render tests for both Application Gateway and Front Door rules. Do not include the blanket MCP `/messages` allow rule from `15cc3542`; that rule is an environment workaround, not a safe generic invariant.
- Proposed commit message:

```text
fix(api): make session creation and pagination WAF-safe

Avoids false positives by using stable request shapes and narrowly permits required session routes in the reference ingress.
Keep ingress changes narrow, evidence-backed, and limited to the required session routes.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u32"></a>
### U32 - support governance-restricted Azure subscriptions

- Theme / lane: Deployment / 11
- Blocked by: [U22](#u22)
- Value: Makes optional base-infrastructure resources and identity-only storage behavior explicit for restricted subscriptions.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Partial: deploy rendering tests cover adjacent paths
- Limitations: Add Bicep/render tests for every optional resource path and keep the behavior opt-in.
- Proposed commit message:

```text
feat(deploy): support governance-restricted Azure subscriptions

Makes optional base-infrastructure resources and identity-only storage behavior explicit for restricted subscriptions.
Keep the behavior opt-in and limit it to clearly defined optional resource paths.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u33"></a>
### U33 - expose provider configuration display metadata

- Theme / lane: Providers / 2a
- Blocked by: [U09](#u09)
- Value: Lets generic portals describe provider configuration without recognizing `wiql`, `kql`, `query`, or `filter`.
- Readiness: Not-ready
- Relative risk: Medium
- Existing coverage: Insufficient
- Limitations: This contract does not exist yet. Design a bounded, non-secret display model and test redaction before changing the portal.
- Proposed commit message:

```text
feat(job-generator-provider): expose provider configuration display metadata

Lets generic portals describe provider configuration without recognizing provider-specific field names.
This contract does not exist yet. Design a bounded, non-secret display model and test redaction before changing the portal.
Add direct upstream tests that prove the public contract and error paths before merge.
```


### Framework and boundary integration

<a id="u34"></a>
### U34 - render, publish, and verify standalone service rollouts

- Theme / lane: Deployment / 10
- Blocked by: [U22](#u22)
- Value: Adds explicit render/stage steps, Deployment and DaemonSet rollout support, prerequisites, and exact-image verification.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough: `stage-manifests.test.mjs`, `services-manifest.test.mjs`, `git-cache-deploy.test.mjs`, `git-repo-worker-deploy.test.mjs`
- Limitations: Extract framework mechanics from concrete service definitions and preserve cloud/provider-neutral interfaces where practical.
- Proposed commit message:

```text
feat(deploy): render, publish, and verify standalone service rollouts

Adds explicit render/stage steps, Deployment and DaemonSet rollout support, prerequisites, and exact-image verification.
Extract framework mechanics from concrete service definitions and preserve cloud/provider-neutral interfaces where practical.
Safety comes from existing automated coverage, including stage-manifests.test.mjs, services-manifest.test.mjs, git-cache-deploy.test.mjs, git-repo-worker-deploy.test.mjs.
```

<a id="u35"></a>
### U35 - connect to HTTP MCP servers with delegated caller credentials

- Theme / lane: MCP / 4
- Blocked by: [U06](#u06), [U08](#u08), [U23](#u23)
- Value: Adds remote MCP transport, runtime audience discovery, and fail-closed caller-token selection.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: Remote MCP transport makes credential discovery, redirect handling, HTTPS policy, and caller-token selection security-sensitive across a new network boundary.
- Existing coverage: Enough for current behavior: `mcp-auth-discovery.test.mjs`, `repo-mcp-access.test.mjs`
- Limitations: Authentication-sensitive. Document discovery caching, redirect policy, HTTPS rules, token non-logging, and cancellation.
- Proposed commit message:

```text
feat(sdk): connect to HTTP MCP servers with delegated caller credentials

Adds remote MCP transport, runtime audience discovery, and fail-closed caller-token selection.
Authentication-sensitive. Document discovery caching, redirect policy, HTTPS rules, token non-logging, and cancellation.
Safety comes from existing automated coverage, including mcp-auth-discovery.test.mjs, repo-mcp-access.test.mjs.
```

<a id="u36"></a>
### U36 - inject delegated credentials into stdio MCP and tool environments

- Theme / lane: MCP / 4
- Blocked by: [U23](#u23), [U24](#u24)
- Value: Delivers only session-scoped caller tokens to approved MCP processes and named non-MCP tool variables.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: Session-scoped token injection crosses process environments and must prove strict isolation, rebind cleanup, and zero diagnostic leakage.
- Existing coverage: Enough: `session-manager-auth-fingerprint.test.mjs`, `session-manager-auth-rebind.test.mjs`, `repo-mcp-access.test.mjs`
- Limitations: Add explicit tests that tokens do not cross sessions, are removed on rebind, and never enter diagnostics.
- Proposed commit message:

```text
feat(sdk): inject delegated credentials into stdio MCP and tool environments

Delivers only session-scoped caller tokens to approved MCP processes and named non-MCP tool variables.
Add explicit tests that tokens do not cross sessions, are removed on rebind, and never enter diagnostics.
Safety comes from existing automated coverage, including session-manager-auth-fingerprint.test.mjs, session-manager-auth-rebind.test.mjs, repo-mcp-access.test.mjs.
```

<a id="u37"></a>
### U37 - use signed-in Copilot credentials for GitHub models

- Theme / lane: Devbox / 9
- Blocked by: [U29](#u29)
- Value: Allows a signed-in devbox user to run GitHub Copilot models without injecting an unrelated GitHub token.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `scripts/test/devbox-owner.test.mjs` and session-manager coverage
- Limitations: Keep the signed-in-user path separate from CI/fleet credential requirements.
- Proposed commit message:

```text
feat(devbox): use signed-in Copilot credentials for GitHub models

Allows a signed-in devbox user to run GitHub Copilot models without injecting an unrelated GitHub token.
Keep the signed-in-user path separate from CI/fleet credential requirements.
Safety comes from existing automated coverage, including scripts/test/devbox-owner.test.mjs and session-manager coverage.
```

<a id="u38"></a>
### U38 - refresh delegated caller tokens without interaction

- Theme / lane: Devbox / 9
- Blocked by: [U23](#u23), [U29](#u29), [U35](#u35)
- Value: Refreshes expiring downstream tokens and rebinds sessions without browser popups.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: Silent token refresh mutates live auth state across rebind paths and later feeds replay-sensitive orchestration behavior.
- Existing coverage: Enough for the fork: `devbox-caller-token-provider.test.mjs`, auth fingerprint/rebind tests, orchestration wait-resume test
- Limitations: The provider and rebind logic can land first, but replay-affecting orchestration wiring must wait for U63.
- Proposed commit message:

```text
feat(devbox): refresh delegated caller tokens without interaction

Refreshes expiring downstream tokens and rebinds sessions without browser popups.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Safety comes from existing automated coverage, including devbox-caller-token-provider.test.mjs, auth fingerprint/rebind tests, orchestration wait-resume test.
```

<a id="u39"></a>
### U39 - dispatch source evaluation through remote providers

- Theme / lane: Providers / 2a
- Blocked by: [U30](#u30)
- Value: Gives the controller an opaque provider registry and normalized authenticated HTTP dispatch.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough after cleanup: `packages/job-generator/test/providers.test.mjs`, `controller.test.mjs`
- Limitations: Decouple dispatch inputs from CMS row types, reuse canonical validation, strengthen controller-side response validation, and replace `ado_wiql` fixtures with synthetic IDs.
- Proposed commit message:

```text
feat(job-generator): dispatch source evaluation through remote providers

Gives the controller an opaque provider registry and normalized authenticated HTTP dispatch.
Decouple dispatch inputs from CMS row types, reuse canonical validation, strengthen controller-side response validation, and replace ado_wiql fixtures with synthetic IDs.
Safety comes from existing automated coverage, including packages/job-generator/test/providers.test.mjs, controller.test.mjs.
```

<a id="u40"></a>
### U40 - persist canonical repository state for session resume

- Theme / lane: Git workspace / 1, migration M1
- Blocked by: [U14](#u14)
- Value: Stores base/head references, patch/bundle metadata, and atomic session git-state accessors.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: This changes persisted git-state schema and resume semantics while consolidating migrations with only partial upgrade-path coverage.
- Existing coverage: Partial: git-store, hydration, migration-shape tests
- Limitations: Combine the final `0079 + 0080` schema into one new upstream migration number. Add migration upgrade coverage and avoid exposing private repository metadata.
- Proposed commit message:

```text
feat(git-workspace): persist canonical repository state for session resume

Stores base/head references, patch/bundle metadata, and atomic session git-state accessors.
Combine the final 0079 + 0080 schema into one new upstream migration number. Add migration upgrade coverage and avoid exposing private repository metadata.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u41"></a>
### U41 - add generator registration and lifecycle storage APIs

- Theme / lane: JobGenerator / 2b, migration M2
- Blocked by: [U09](#u09), [U40](#u40)
- Value: Adds provider-neutral generator definitions, acknowledgement, hierarchy, jobs, and opaque source-provider IDs.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: It introduces a broad new persisted JobGenerator model and API surface while serializing multiple migration boundaries into one upstream change.
- Existing coverage: Enough in the fork: `job-generator-migrations.test.mjs`, `job-generators.integration.test.mjs`, API protocol tests
- Limitations: Merge-serialized after M1. Combine `0081 + 0082 + 0092` into one new upstream migration. Remove remaining domain fixture names.
- Proposed commit message:

```text
feat(job-generator): add generator registration and lifecycle storage APIs

Adds provider-neutral generator definitions, acknowledgement, hierarchy, jobs, and opaque source-provider IDs.
Merge-serialized after M1. Combine 0081 + 0082 + 0092 into one new upstream migration. Remove remaining domain fixture names.
Safety comes from existing automated coverage, including job-generator-migrations.test.mjs, job-generators.integration.test.mjs, API protocol tests.
```

<a id="u42"></a>
### U42 - load and validate lifecycle state definitions

- Theme / lane: JobGenerator / 2b
- Blocked by: [U41](#u41)
- Value: Adds reusable Markdown loading, state graph parsing, and transition validation.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `lifecycle-state-loader.test.mjs`, `lifecycle-state-transitions.test.mjs`
- Limitations: Keep examples and state names domain-neutral.
- Proposed commit message:

```text
feat(job-generator): load and validate lifecycle state definitions

Adds reusable Markdown loading, state graph parsing, and transition validation.
Keep examples and state names domain-neutral.
Safety comes from existing automated coverage, including lifecycle-state-loader.test.mjs, lifecycle-state-transitions.test.mjs.
```

<a id="u43"></a>
### U43 - add JobGenerator registration and hierarchy

- Theme / lane: Portal / 6b
- Blocked by: [U41](#u41)
- Value: Adds the management hierarchy and registration workflow without depending on durable execution.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough: `job-generator-runtime.test.mjs`, SDK API protocol tests
- Limitations: Exclude the current hard-coded source-query detail renderer; that is replaced by U55.
- Proposed commit message:

```text
feat(portal): add JobGenerator registration and hierarchy

Adds the management hierarchy and registration workflow without depending on durable execution.
Exclude the current hard-coded source-query detail renderer; that is replaced by U55.
Safety comes from existing automated coverage, including job-generator-runtime.test.mjs, SDK API protocol tests.
```

<a id="u44"></a>
### U44 - select serviceable repositories when creating sessions

- Theme / lane: Portal / 6a
- Blocked by: [U26](#u26)
- Value: Lets users select only repositories currently advertised by live workers.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: `new-session-flow.test.mjs` plus runtime serviceable-repo coverage
- Limitations: Preserve the ability to create repo-less sessions.
- Proposed commit message:

```text
feat(portal): select serviceable repositories when creating sessions

Lets users select only repositories currently advertised by live workers.
Preserve the ability to create repo-less sessions.
Safety comes from existing automated coverage, including new-session-flow.test.mjs plus runtime serviceable-repo coverage.
```

<a id="u45"></a>
### U45 - add a stateless MCP-over-HTTP adapter host

- Theme / lane: MCP adapter / 5a
- Blocked by: [U08](#u08)
- Value: Provides a fresh MCP server/transport per request, bearer propagation, health, challenge metadata, and request correlation.
- Readiness: Not-ready
- Relative risk: High
- High-risk reason: The current host gates tool execution on unverified JWT claims, so the public adapter boundary is security-critical and not yet safe.
- Existing coverage: Partial: `packages/mcp-proxy/test/http-surface.test.ts`, `jwt.test.ts`
- Limitations: The current gate classifies unverified JWT claims before arbitrary local tools run. Add real issuer/audience/signature validation or structurally constrain the host to bearer-forwarding adapters. Make the package public and remove the Kusto default entry point.
- Proposed commit message:

```text
feat(mcp-adapter): add a stateless MCP-over-HTTP adapter host

Provides a fresh MCP server/transport per request, bearer propagation, health, challenge metadata, and request correlation.
The current gate classifies unverified JWT claims before arbitrary local tools run. Add real issuer/audience/signature validation or structurally constrain the host to bearer-forwarding adapters. Make the package public and remove the analytics default entry point.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```


### Capability runtimes

<a id="u46"></a>
### U46 - dehydrate and hydrate repository changes across workers

- Theme / lane: Git workspace / 1
- Blocked by: [U40](#u40)
- Value: Preserves committed and uncommitted work across pod moves using bundles, patches, metadata, and detached shared-store hydration.
- Readiness: Ready
- Relative risk: High
- High-risk reason: Moving live git state across workers via bundles and patches exposes failure-recovery, cancellation, and size-limit edge cases in a critical workflow.
- Existing coverage: Enough: `blob-store-git-workspace.test.mjs`, `git-workspace-cross-pod.test.mjs`
- Limitations: Review git command safety, size limits, cancellation, and failure recovery as public API behavior.
- Proposed commit message:

```text
feat(git-workspace): dehydrate and hydrate repository changes across workers

Preserves committed and uncommitted work across pod moves using bundles, patches, metadata, and detached shared-store hydration.
Review git command safety, size limits, cancellation, and failure recovery as public API behavior.
Safety comes from existing automated coverage, including blob-store-git-workspace.test.mjs, git-workspace-cross-pod.test.mjs.
```

<a id="u47"></a>
### U47 - reconcile pinned repository refs before each turn

- Theme / lane: Repository worker / 1
- Blocked by: [U26](#u26), [U46](#u46)
- Value: Ensures acquisition-time reconciliation and stable non-default refs before the session touches the workspace.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Partial: `git-store.test.mjs`, git-workspace tests, ref-pinning characterization
- Limitations: Add an end-to-end hook-order test covering ref movement between turns.
- Proposed commit message:

```text
feat(repo-worker): reconcile pinned repository refs before each turn

Ensures acquisition-time reconciliation and stable non-default refs before the session touches the workspace.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u48"></a>
### U48 - add node-local git cache and repository worker runtimes

- Theme / lane: Repository worker / 1
- Blocked by: [U14](#u14), [U16](#u16), [U46](#u46), [U47](#u47)
- Value: Adds the generic mirror daemon and repo-worker runtime that consume the hydration contract.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: This adds daemonized cache refresh and repo-worker reconcile behavior across processes without a hermetic integration suite.
- Existing coverage: Partial: SDK unit tests cover git state; no hermetic daemon/reconcile integration suite
- Limitations: Add process-level tests for mirror refresh, clone recovery, cancellation, and readiness transitions. Keep ADO-specific clone behavior behind generic git credential hooks.
- Proposed commit message:

```text
feat(repo-worker): add node-local git cache and repository worker runtimes

Adds the generic mirror daemon and repo-worker runtime that consume the hydration contract.
Add process-level tests for mirror refresh, clone recovery, cancellation, and readiness transitions. Keep provider-specific-specific clone behavior behind generic git credential hooks.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u49"></a>
### U49 - deploy Linux and Windows repository-worker fleets

- Theme / lane: Repository worker / 1 + deployment
- Blocked by: [U27](#u27), [U34](#u34), [U48](#u48)
- Value: Adds OS-split git-cache and repo-worker DaemonSets, hostPath persistence, truthful readiness, and instance-scoped deployment.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: Fleet rollout changes DaemonSets, host persistence, and readiness behavior across two operating systems with live behavior only partially covered.
- Existing coverage: Partial: `git-cache-deploy.test.mjs`, `git-repo-worker-deploy.test.mjs`, `windows-worker-build.test.mjs`
- Limitations: Live DaemonSet behavior remains integration-only. Remove private node-pool names, memory values, repositories, registries, and exact fleet tuning.
- Proposed commit message:

```text
feat(deploy): deploy Linux and Windows repository-worker fleets

Adds OS-split git-cache and repo-worker DaemonSets, hostPath persistence, truthful readiness, and instance-scoped deployment.
Live DaemonSet behavior remains integration-only. Remove private node-pool names, memory values, repositories, registries, and exact fleet tuning.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u50"></a>
### U50 - continuously materialize external provider discoveries

- Theme / lane: JobGenerator / 2b
- Blocked by: [U39](#u39), [U41](#u41)
- Value: Adds leasing, cycles, idempotent reconciliation, acknowledgements, and controller runtime.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: Leased controller loops and idempotent reconciliation can corrupt cycle completion if provider failures are not contained precisely.
- Existing coverage: Enough after neutralization: `controller.test.mjs`, `providers.test.mjs`, `postgres.integration.test.mjs`
- Limitations: Replace remaining WIQL sample payloads and ensure provider failures cannot corrupt cycle completion.
- Proposed commit message:

```text
feat(job-generator): continuously materialize external provider discoveries

Adds leasing, cycles, idempotent reconciliation, acknowledgements, and controller runtime.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Safety comes from existing automated coverage, including controller.test.mjs, providers.test.mjs, postgres.integration.test.mjs.
```

<a id="u51"></a>
### U51 - persist lifecycle state runs and transition journals

- Theme / lane: JobGenerator / 2b, migration M3
- Blocked by: [U41](#u41), [U42](#u42)
- Value: Gives each Job durable state revisions, session handoffs, and an auditable transition journal.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: This adds durable lifecycle schema and session handoff persistence, so migration safety must hold for both fresh installs and upgrades.
- Existing coverage: Enough in the fork: JobGenerator Postgres integration and migration-shape tests
- Limitations: Merge-serialized after M2. Retain one final migration boundary equivalent to `0083`; add fresh-database and upgrade-path tests.
- Proposed commit message:

```text
feat(job-generator): persist lifecycle state runs and transition journals

Gives each Job durable state revisions, session handoffs, and an auditable transition journal.
Merge-serialized after M2. Retain one final migration boundary equivalent to 0083; add fresh-database and upgrade-path tests.
Safety comes from existing automated coverage, including JobGenerator Postgres integration and migration-shape tests.
```

<a id="u52"></a>
### U52 - add durable keyed system-wait contracts

- Theme / lane: Orchestration / 3
- Blocked by: None
- Value: Adds reusable keyed wait commands, management surfaces, and validation without a domain observer.
- Readiness: Ready
- Relative risk: Medium
- Existing coverage: Enough: contract, validation, idempotency, cancellation, canonical
  serialization, prototype-safe durable JSON, and active `signal_key` compatibility tests
- Limitations: The contribution must remain inert: do not modify the active orchestration handler,
  tool registration, replay versions, or existing `signal_key` behavior. Handler activation
  belongs only in U63.
- Proposed commit message:

```text
feat(orchestration): add durable keyed system-wait contracts

Adds reusable keyed wait commands, management surfaces, validation, and durable serialization without a domain observer.
Keeps the contracts inert so the active orchestration handler and replay boundary remain unchanged until U63.
Safety comes from contract, idempotency, cancellation, serialization, hostile-key, and compatibility tests.
```

<a id="u53"></a>
### U53 - add a synthetic delegated REST example

- Theme / lane: MCP adapter / 5a
- Blocked by: [U45](#u45)
- Value: Demonstrates the adapter pattern without domain-specific IP.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough: synthetic cases in `http-surface.test.ts`
- Limitations: Preserve configured base paths instead of silently reducing URLs to `url.origin`; bound and sanitize upstream error bodies.
- Proposed commit message:

```text
feat(mcp-adapter): add a synthetic delegated REST example

Demonstrates the adapter pattern without domain-specific IP.
Preserve configured base paths instead of silently reducing URLs to url.origin; bound and sanitize upstream error bodies.
Safety comes from existing automated coverage, including synthetic cases in http-surface.test.ts.
```

<a id="u54"></a>
### U54 - deploy instance-scoped MCP adapter services

- Theme / lane: MCP adapter deployment / 5 + 10
- Blocked by: [U34](#u34), [U45](#u45)
- Value: Adds generic Bicep, Flux, Kustomize, network policy, and rollout verification for adapter instances.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: This production deployment surface depends on a still-settling adapter API and must get instance isolation, rollout, and network policy behavior right.
- Existing coverage: Enough for rendering: `mcp-proxy-deploy.test.mjs`, services-manifest tests
- Limitations: Wait until the adapter package/API is stable. Exclude SQLmort values, registrations, identities, and acceptance policy.
- Proposed commit message:

```text
feat(deploy): deploy instance-scoped MCP adapter services

Adds generic Bicep, Flux, Kustomize, network policy, and rollout verification for adapter instances.
Wait until the adapter package/API is stable. Exclude the downstream app values, registrations, identities, and acceptance policy.
Safety comes from existing automated coverage, including mcp-proxy-deploy.test.mjs, services-manifest tests.
```

<a id="u55"></a>
### U55 - render provider configuration from display metadata

- Theme / lane: Portal / 6b
- Blocked by: [U33](#u33), [U43](#u43)
- Value: Removes the last WIQL/KQL-aware rendering from the generic portal.
- Readiness: Not-ready
- Relative risk: Medium
- Existing coverage: Insufficient
- Limitations: Implement the U33 metadata/redaction contract first, then add portal tests proving unknown provider fields do not leak secrets.
- Proposed commit message:

```text
feat(portal): render provider configuration from display metadata

Removes the last provider-aware rendering from the generic portal.
Keep the implementation narrowly scoped to the generic upstream surface and its stable public contract.
Add direct upstream tests that prove the public contract and error paths before merge.
```


### Durable storage, routing, and observability

<a id="u56"></a>
### U56 - add durable external-operation gates

- Theme / lane: Orchestration / 3, migration M4
- Blocked by: [U51](#u51), [U52](#u52)
- Value: Persists externally completed operations behind idempotent signal and validation gates.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: It persists external-completion state in durable orchestration, so validation or idempotency mistakes can break resume safety across schema boundaries.
- Existing coverage: Enough: `job-external-operation-producer.test.mjs`, `job-validation-gates.test.mjs`, Postgres integration
- Limitations: Merge-serialized after M3. Retain one migration equivalent to `0084`. Keep observer implementations out of this generic commit.
- Proposed commit message:

```text
feat(orchestration): add durable external-operation gates

Persists externally completed operations behind idempotent signal and validation gates.
Merge-serialized after M3. Retain one migration equivalent to 0084. Keep observer implementations out of this generic commit.
Safety comes from existing automated coverage, including job-external-operation-producer.test.mjs, job-validation-gates.test.mjs, Postgres integration.
```

<a id="u57"></a>
### U57 - persist and schedule durable job waits

- Theme / lane: Orchestration / 3, migration M5
- Blocked by: [U56](#u56)
- Value: Adds response, observed-condition, and timer waits, scheduling, overrides, and the no-external-state-polling guardrail.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: This changes persisted wait scheduling semantics across timer and observed-condition paths, making replay and migration correctness central.
- Existing coverage: Enough: `job-lifecycle-tools.test.mjs`, `job-external-operation-producer.test.mjs`, `provider-state-poll-guardrail.test.mjs`, Postgres integration
- Limitations: Merge-serialized after M4. Combine the final `0089 + 0090 + 0091` schema in one migration. Timer and external-condition semantics must remain distinct.
- Proposed commit message:

```text
feat(orchestration): persist and schedule durable job waits

Adds response, observed-condition, and timer waits, scheduling, overrides, and the no-external-state-polling guardrail.
Merge-serialized after M4. Combine the final 0089 + 0090 + 0091 schema in one migration. Timer and external-condition semantics must remain distinct.
Safety comes from existing automated coverage, including job-lifecycle-tools.test.mjs, job-external-operation-producer.test.mjs, provider-state-poll-guardrail.test.mjs, Postgres integration.
```

<a id="u58"></a>
### U58 - expose durable job execution timelines

- Theme / lane: Observability / 6, migration M6
- Blocked by: [U16](#u16), [U41](#u41), [U51](#u51), [U57](#u57)
- Value: Adds the query/storage surface for worker occupancy, input events, Job runs, and historical fallback.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: The new timeline storage and API projection span workers, jobs, and fallback paths, but only query-level coverage exists today.
- Existing coverage: Enough at query level: `worker-timeline-query.test.mjs`, `input-received-event.test.mjs`, `worker-timeline-legacy-fallback.test.mjs`
- Limitations: Merge-serialized after M5. Retain one migration equivalent to `0085`; add a full API projection test.
- Proposed commit message:

```text
feat(worker): expose durable job execution timelines

Adds the query/storage surface for worker occupancy, input events, Job runs, and historical fallback.
Merge-serialized after M5. Retain one migration equivalent to 0085; add a full API projection test.
Safety comes from existing automated coverage, including worker-timeline-query.test.mjs, input-received-event.test.mjs, worker-timeline-legacy-fallback.test.mjs.
```

<a id="u59"></a>
### U59 - enforce owner-affined worker routing

- Theme / lane: Routing / 8, migration M7
- Blocked by: [U26](#u26), [U41](#u41), [U58](#u58)
- Value: Prevents work from crossing owner boundaries while composing owner and repository affinity.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: Scheduling isolation, owner identity handling, and migration-backed routing rules must stay correct across child and regeneration paths.
- Existing coverage: Enough in the fork: `activity-routing.test.mjs`, controller tests, worker-registry tests
- Limitations: Merge-serialized after M6. Combine worker registration refresh and session routing (`0086 + 0087`). Review hashed identity handling and all child/regeneration paths.
- Proposed commit message:

```text
feat(scheduling): enforce owner-affined worker routing

Prevents work from crossing owner boundaries while composing owner and repository affinity.
Merge-serialized after M6. Combine worker registration refresh and session routing (0086 + 0087). Review hashed identity handling and all child/regeneration paths.
Safety comes from existing automated coverage, including activity-routing.test.mjs, controller tests, worker-registry tests.
```

<a id="u60"></a>
### U60 - fold bootstrap turns into durable start input

- Theme / lane: Orchestration / 3
- Blocked by: None
- Value: Removes the crash window between orchestration creation and first-message enqueue.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: Folding bootstrap turns changes durable start-input semantics at the replay boundary and must preserve backward normalization for old sessions.
- Existing coverage: Enough for the client transformation: `bootstrap-fold-start-input.test.mjs`
- Limitations: Pure planning and backward-normalization helpers are available, but the active
  client and orchestration behavior must remain unchanged before U63. Frozen `1.0.78` and active
  `1.0.79` stay distinct.
- Proposed commit message:

```text
feat(orchestration): fold bootstrap turns into durable start input

Removes the crash window between orchestration creation and first-message enqueue.
Do not activate the new input semantics in the current handler before U63. Add backward normalization tests for old inputs.
Safety comes from existing automated coverage, including bootstrap-fold-start-input.test.mjs.
```

<a id="u61"></a>
### U61 - visualize worker utilization and durable job runs

- Theme / lane: Portal / 6a
- Blocked by: [U18](#u18), [U58](#u58)
- Value: Adds worker lanes, utilization spans, host headings, and job-run overlays.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough but broad: `worker-registry-admin.test.mjs`, lane-order and zoom tests
- Limitations: Split selectors/state from the renderer and CSS so review remains manageable. Preserve non-Job worker visibility.
- Proposed commit message:

```text
feat(portal): visualize worker utilization and durable job runs

Adds worker lanes, utilization spans, host headings, and job-run overlays.
Split selectors/state from the renderer and CSS so review remains manageable. Preserve non-Job worker visibility.
Safety comes from existing automated coverage, including worker-registry-admin.test.mjs, lane-order and zoom tests.
```

<a id="u62"></a>
### U62 - add timeline filtering, queued bands, and live wait spans

- Theme / lane: Portal / 6a/6b
- Blocked by: [U57](#u57), [U61](#u61)
- Value: Adds hide-Job controls, runnable-but-unclaimed bands, ongoing observed-condition spans, and stable zoom behavior.
- Readiness: Ready after blockers
- Relative risk: Medium
- Existing coverage: Enough: `worker-timeline-hide-job.test.mjs`, `worker-timeline-open-wait.test.mjs`, `worker-timeline-zoom.test.mjs`
- Limitations: Keep public wait kinds generic; PR-specific rendering belongs with U66/U68.
- Proposed commit message:

```text
feat(portal): add timeline filtering, queued bands, and live wait spans

Adds hide-Job controls, runnable-but-unclaimed bands, ongoing observed-condition spans, and stable zoom behavior.
Keep public wait kinds generic; PR-specific rendering belongs with U66/U68.
Safety comes from existing automated coverage, including worker-timeline-hide-job.test.mjs, worker-timeline-open-wait.test.mjs, worker-timeline-zoom.test.mjs.
```


### Replay-sensitive and final dependent layer

<a id="u63"></a>
### U63 - register durable session orchestration 1.0.79

- Theme / lane: Orchestration / 3
- Blocked by: [U38](#u38), [U52](#u52), [U57](#u57), [U59](#u59), [U60](#u60)
- Value: Atomically activates caller-token refresh, keyed waits, observed waits, owner routing, and bootstrap-input compatibility while freezing upstream `1.0.78`.
- Readiness: Not-ready
- Relative risk: High
- High-risk reason: This is the replay activation point that bundles every durable behavior change into one version bump, so omissions or duplicates would strand live sessions.
- Existing coverage: Partial: orchestration freeze tests and focused behavior tests exist
- Limitations: Create a clean frozen copy of the then-current upstream handler, add direct `1.0.78 -> 1.0.79` replay/continue-as-new tests, and prove every replay-affecting dependency is included exactly once. Do not split activation across multiple version bumps.
- Proposed commit message:

```text
feat(orchestration): register durable session orchestration 1.0.79

Atomically activates caller-token refresh, keyed waits, observed waits, owner routing, and bootstrap-input compatibility while freezing upstream 1.0.78.
Create a clean frozen copy of the then-current upstream handler, add direct 1.0.78 -> 1.0.79 replay/continue-as-new tests, and prove every replay-affecting dependency is included exactly once. Do not split activation across multiple version bumps.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u64"></a>
### U64 - execute durable lifecycle state transitions

- Theme / lane: JobGenerator / 2b
- Blocked by: [U50](#u50), [U51](#u51), [U56](#u56), [U57](#u57), [U63](#u63)
- Value: Runs state sessions, resumes across workers, validates handoffs, and advances the lifecycle journal durably.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: It coordinates resumable state transitions, worker handoffs, and journal advancement on top of the new durable replay boundary.
- Existing coverage: Enough in the fork: controller, lifecycle loader/transition, JobGenerator Postgres, and durable lifecycle tests
- Limitations: Neutralize remaining domain lifecycle fixtures and add failure/recovery coverage against the upstream `1.0.79` implementation.
- Proposed commit message:

```text
feat(job-generator): execute durable lifecycle state transitions

Runs state sessions, resumes across workers, validates handoffs, and advances the lifecycle journal durably.
Neutralize remaining domain lifecycle fixtures and add failure/recovery coverage against the upstream 1.0.79 implementation.
Safety comes from existing automated coverage, including controller, lifecycle loader/transition, JobGenerator Postgres, and durable lifecycle tests.
```

<a id="u65"></a>
### U65 - add owner-managed logical cleanup

- Theme / lane: Routing and cleanup / 8, migration M8
- Blocked by: [U59](#u59), [U64](#u64)
- Value: Adds safe logical deletion/tombstones and owner-scoped cleanup across Jobs and sessions.
- Readiness: Near-ready
- Relative risk: High
- High-risk reason: Tombstones and owner-scoped cleanup change persisted deletion behavior, and any isolation mistake could remove shared data across boundaries.
- Existing coverage: Enough: `job-cleanup-management.test.mjs`, `client-session-delete.test.mjs`, API protocol tests
- Limitations: Merge-serialized after M7. Retain one migration equivalent to `0088`; verify cleanup never crosses owner boundaries and does not physically delete shared data.
- Proposed commit message:

```text
feat(jobs): add owner-managed logical cleanup

Adds safe logical deletion/tombstones and owner-scoped cleanup across Jobs and sessions.
Merge-serialized after M7. Retain one migration equivalent to 0088; verify cleanup never crosses owner boundaries and does not physically delete shared data.
Safety comes from existing automated coverage, including job-cleanup-management.test.mjs, client-session-delete.test.mjs, API protocol tests.
```

<a id="u66"></a>
### U66 - observe Azure DevOps pull-request gates

- Theme / lane: Public integration / 7
- Blocked by: [U57](#u57), [U64](#u64)
- Value: Adds optional public approval/completion observers, heterogeneous conditions, per-condition results, and external-state polling guardrails.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough: `azure-devops-job-waits.test.mjs`, `azure-devops-approval-conditions.test.mjs`, durable lifecycle tests
- Limitations: Keep this optional Tier 3 integration. Remove private project/policy assumptions, document public authentication, and keep WIQL discovery out.
- Proposed commit message:

```text
feat(jobs): observe Azure DevOps pull-request gates

Adds optional public approval/completion observers, heterogeneous conditions, per-condition results, and external-state polling guardrails.
Keep this optional Tier 3 integration. Remove private project/policy assumptions, document public authentication, and keep provider-specific query discovery out.
Safety comes from existing automated coverage, including azure-devops-job-waits.test.mjs, azure-devops-approval-conditions.test.mjs, durable lifecycle tests.
```

<a id="u67"></a>
### U67 - navigate JobGenerator transitions and lifecycle trees

- Theme / lane: Portal / 6b
- Blocked by: [U43](#u43), [U64](#u64)
- Value: Adds transition-to-session links, bookkeeping, keyboard navigation, and expandable empty states.
- Readiness: Ready after blockers
- Relative risk: Medium
- Existing coverage: Enough: transition bookkeeping/navigation and JobGenerator tree-navigation tests
- Limitations: Keep navigation independent of provider type.
- Proposed commit message:

```text
feat(portal): navigate JobGenerator transitions and lifecycle trees

Adds transition-to-session links, bookkeeping, keyboard navigation, and expandable empty states.
Keep navigation independent of provider type.
Safety comes from existing automated coverage, including transition bookkeeping/navigation and JobGenerator tree-navigation tests.
```

<a id="u68"></a>
### U68 - label durable waits and approval conditions

- Theme / lane: Portal / 6b + 7
- Blocked by: [U57](#u57), [U63](#u63), [U66](#u66), [U67](#u67)
- Value: Gives generic names to wait kinds/state runs and renders public PR gate conditions without hard-coded domain providers.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough: `job-generator-wait-label.test.mjs`, `job-generator-state-run-label.test.mjs`, worker open-wait tests
- Limitations: Keep the generic wait labels in the core commit; isolate Azure DevOps-specific labels behind the optional integration.
- Proposed commit message:

```text
feat(portal): label durable waits and approval conditions

Gives generic names to wait kinds/state runs and renders public PR gate conditions without hard-coded domain providers.
Keep the generic wait labels in the core commit; isolate provider-specific labels behind the optional integration.
Safety comes from existing automated coverage, including job-generator-wait-label.test.mjs, job-generator-state-run-label.test.mjs, worker open-wait tests.
```

<a id="u69"></a>
### U69 - add typed JobGenerator client helpers

- Theme / lane: SDK boundary / reverse
- Blocked by: [U41](#u41), [U64](#u64)
- Value: Exposes generator creation, Job snapshots, lifecycle failure detection, and terminal waits through the published SDK.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Partial: PilotSwarm JobGenerator integration plus SQLmort `test_job_generators.ts`
- Limitations: Move tests upstream, replace domain-shaped sample keys, and decide whether polling helpers belong in core or an examples/client package.
- Proposed commit message:

```text
feat(sdk): add typed JobGenerator client helpers

Exposes generator creation, Job snapshots, lifecycle failure detection, and terminal waits through the published SDK.
Move tests upstream, replace domain-shaped sample keys, and decide whether polling helpers belong in core or an examples/client package.
Accompany the change with focused tests for the remaining contract and integration gaps before merge.
```

<a id="u70"></a>
### U70 - manage workload identity authorization groups

- Theme / lane: Deployment / 10
- Blocked by: None
- Value: Lets independently deployed environments anchor shared resource authorization on a
  stable cloud-native identity group instead of re-granting every workload identity separately.
- Readiness: Near-ready
- Relative risk: Medium
- Existing coverage: Enough for the deploy logic: `group-membership.test.mjs` covers skip, join,
  create, idempotency, ambiguity, synchronized-group refusal, and permission failures;
  all-mode and service-manifest tests cover pipeline ordering
- Limitations: Keep the stage opt-in with `skip` as the compatibility default. Remove
  SQL-owned resource examples and concrete group policy from the public change. Document the
  least-privilege difference between joining a controlled group and tenant-wide group creation,
  and add direct scaffolder coverage for the three configuration modes. This mutates an
  authorization boundary and requires explicit security-sensitive pre-PR approval.
- Proposed commit message:

```text
feat(deploy): manage workload identity authorization groups

Lets independently deployed environments anchor shared resource authorization on a stable cloud-native identity group.
Keep the stage opt-in, fail closed on ambiguous or synchronized groups, and document least-privilege requirements without downstream resource policy.
Safety comes from direct skip, join, create, idempotency, ambiguity, pipeline-order, and permission-failure tests.
```

## Theme-level readiness summary

### Readiness by theme

#### 1. Git workspace and repository-worker fleet

- Overall readiness: Near-ready
- Main limitation: Core git state is well tested; daemon/fleet behavior still needs hermetic process and live rollout coverage.

#### 2a. Provider ABI, host, loader, and dispatch

- Overall readiness: Near-ready
- Main limitation: Package is private, dispatch is coupled to JobGenerator rows, validation is duplicated, and fixtures still contain `ado_wiql`.

#### 2b. JobGenerator lifecycle and materialization

- Overall readiness: Blocked
- Main limitation: Depends on the durable storage lane and atomic orchestration `1.0.79` activation.

#### 3. Durable orchestration primitives

- Overall readiness: Not-ready as a whole
- Main limitation: Supporting pieces are tested, but the replay boundary needs an atomic `1.0.79` design and direct version-transition tests.

#### 4. Delegated identity, MCP configuration, and plugin loading

- Overall readiness: Near-ready
- Main limitation: Auth surfaces require explicit trust documentation, token-isolation tests, and a generic package-feed credential model.

#### 5. MCP adapter and deployment

- Overall readiness: Not-ready as a whole
- Main limitation: The generic host currently uses unverified JWT claims as a pre-tool gate and is mixed with the Kusto binary/package.

#### 6. Portal, Job, and worker observability

- Overall readiness: Mixed
- Main limitation: Independent history/timeline helpers are ready; JobGenerator UI waits on lifecycle APIs and provider display metadata.

#### 7. Optional public Azure DevOps integration

- Overall readiness: Near-ready after Theme 3
- Main limitation: Public observer tests exist; private policy assumptions and WIQL discovery must remain excluded.

#### 8. Worker routing and hardening

- Overall readiness: Near-ready
- Main limitation: Basic hooks, provenance, and routing are covered; owner routing and cleanup carry migration and isolation risk.

#### 9. Devbox worker identity and authentication

- Overall readiness: Near-ready
- Main limitation: Owner and signed-in model paths are covered; silent token refresh depends on Theme 4 and orchestration `1.0.79`.

#### 10. Deployment-framework extensions

- Overall readiness: Near-ready
- Main limitation: Generic mechanics are covered but must be separated from concrete git-cache,
  repo-worker, and MCP service definitions. Workload authorization-group management also needs
  downstream policy removed and least-privilege create-versus-join guidance.

#### 11. Runtime reliability and operability

- Overall readiness: Several commits ready now
- Main limitation: Do not upstream private capacity tuning or blanket WAF allows as generic product behavior.

#### Reverse SDK boundary

- Overall readiness: Mixed
- Main limitation: Model/auth helpers are close; event tracking and JobGenerator helpers need explicit public contracts and direct tests. SQLmort's unified wrapper is a downstream migration aid, not an upstream API.


## Parallel execution lanes

The sequence is intentionally not one serial train. The following work can proceed in parallel:

1. **Reliability lane:** [U01](#u01), [U02](#u02), [U03](#u03), [U04](#u04), [U05](#u05), and [U19](#u19) can start immediately; [U20](#u20) and [U21](#u21) follow [U01](#u01).
2. **Provider lane:** [U09](#u09) -> [U30](#u30) -> [U39](#u39) can proceed independently of the MCP, portal, and
   deployment lanes. [U33](#u33) should be designed in parallel because it blocks final portal cleanup.
3. **MCP lane:** [U06](#u06), [U08](#u08), and [U12](#u12) can proceed together; then [U23](#u23) and [U24](#u24); then [U35](#u35) and [U36](#u36). [U45](#u45) remains
   blocked on its security redesign even after [U08](#u08) lands.
4. **Deployment lane:** [U13](#u13) -> [U22](#u22) -> [U34](#u34). [U70](#u70)
   is independently eligible but requires security-sensitive pre-PR approval. Concrete services
   [U49](#u49) and [U54](#u54) attach only after their owning runtimes exist.
5. **Worker/git lane:** [U14](#u14), [U15](#u15), and [U16](#u16) can proceed together. [U26](#u26), [U40](#u40), [U46](#u46), [U47](#u47), [U48](#u48), and [U49](#u49) then form
   the repository-worker chain.
6. **Job/orchestration lane:** [U09](#u09), [U41](#u41), and [U42](#u42) can start before durable orchestration. [U52](#u52),
   [U56](#u56), [U57](#u57), [U60](#u60), and [U63](#u63) require a single replay design. [U64](#u64) follows activation.
7. **Portal lane:** [U17](#u17) and [U18](#u18) can start immediately; [U43](#u43) and [U44](#u44) follow their APIs; [U61](#u61), [U62](#u62),
   [U67](#u67), and [U68](#u68) follow the respective backend capabilities.
8. **SDK-drain lane:** [U10](#u10), [U11](#u11), and [U12](#u12) can be designed now. [U69](#u69) waits for the JobGenerator platform APIs.

Migration-bearing branches can be developed in parallel, but merge in M1-M8 order or rebase and
renumber immediately before merge. Do not reserve a long private block of migration numbers.

## SQLmort drain commits after upstream merges

These are not upstream commits, but they complete the ownership transfer:

### After [U09](#u09)

- Upstream blocker: [U09](#u09)
- Proposed subject: `refactor(job-generator): consume canonical provider contracts`
- Result: Delete the three copied provider `contracts.ts` files.

### After [U10](#u10), [U11](#u11), [U12](#u12), and [U23](#u23)

- Upstream blocker: [U10](#u10), [U11](#u11), [U12](#u12), and [U23](#u23)
- Proposed subject: `refactor(sdk): consume upstream auth, model, and event helpers`
- Result: Remove the corresponding modules under `Clients/sdk/typescript/src/upstream-candidates/`.

### After [U69](#u69)

- Upstream blocker: [U69](#u69)
- Proposed subject: `refactor(sdk): consume upstream JobGenerator client helpers`
- Result: Delete SQLmort's JobGenerator compatibility client, migrate callers from the unified
  web-client wrapper to the accepted public SDK surfaces, delete that wrapper, and retain only
  domain composition.


SQLmort retains repository-to-audience mappings, service audiences, SQL provider implementations,
credential policy, scenarios, deployment values, acceptance playlists, and runbooks.

## Explicit exclusions

Do not upstream:

- ADO WIQL, IcM, or SQL-owned Kusto JobGenerator provider implementations.
- SQLmort endpoints, audiences, credentials, repository mappings, prompts, fixtures, policy,
  deployment topology, or acceptance suites.
- The private fork transition plan or migration-ledger conversion procedure.
- Concrete ACR names, node-pool names, private repositories, private NuGet feeds, or fleet memory
  and concurrency values.
- Concrete authorization-group names or IDs, downstream resource allow-lists, and SQL-owned
  examples of the permissions granted through a shared workload group.
- The blanket MCP `/messages` WAF allow from `15cc3542`; replace it with a narrow,
  evidence-backed ingress rule if one is still required.
- The private fleet's exact lease, timeout, pool-size, and single-slot tuning as public defaults.
- The current decode-only JWT authorization gate in the MCP adapter host.
- The optional public-sample Kusto adapter as a required platform capability. Keep it in an
  explicitly owned integration package or delete it.
- Duplicated provider-contract copies, duplicated validation, obsolete compatibility wrappers,
  or ad hoc deployment wrappers merely because they exist in the fork. Publish a canonical
  contract or mechanism, update consumers, and delete the redundant fork code.
- Historical fork commits or branch history. Every contribution is a clean final-state change
  authored from current public upstream.
