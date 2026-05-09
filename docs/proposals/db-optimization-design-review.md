# PilotSwarm DB Optimization Design Review

## Status

Draft for design review before resuming implementation PRs.

## Purpose

This document describes the DB optimization work currently spread across the large implementation branch and reframes it as a detailed design document plus test plan.

It is intended to address the following review concerns before any further implementation PRs move forward:

- What problem is being solved
- What the proposed architecture is
- How data and control flow change
- What API boundaries are changing
- What storage and migration changes are involved
- How runtime behavior changes
- How compatibility and rollout will be handled
- What failure modes and rollback expectations exist
- How the implementation should be broken into smaller PRs
- How each slice will be tested

## Executive Summary

The current optimization branch contains valid DB optimization work, but it is not reviewable as a single implementation PR because it spans multiple sensitive areas at once:

- SQL and migration behavior
- CMS/catalog behavior
- Management APIs
- Portal runtime request handling
- CLI and browser transport forwarding
- DB guardrail configuration
- Diagnostics and DB metrics reporting

The DB optimization work is aimed at four core improvements:

- Bound expensive DB-backed read paths
- Replace large session-list reads with page-bounded access
- Centralize DB pool and query guardrails
- Add bounded diagnostics for noisy event activity and DB-heavy behavior

### Recommendation

- Do not continue with one large implementation PR
- Review the DB design and test plan first
- Land the work as a sequence of smaller PRs with narrow behavioral claims

## Problem Statement

PilotSwarm already supports durable orchestration, CMS-backed state, management APIs, portal runtime access, and CLI/browser transport layers. However, several DB-facing paths remain too permissive for production use.

### Main Problems

- Session listing can scale poorly because callers can rely on large full-list reads
- Some DB-backed read paths can return unnecessarily large result sets, increasing database work, response payload size, and network transfer cost
- Event and turn-metrics reads can request more rows than are safe by default
- Analytics-style reads can span broader windows than intended
- Safety enforcement relies too heavily on app-layer behavior and not enough on SQL itself
- DB pool and timeout guardrails are not expressed as one shared policy
- Diagnosing noisy event producers is too manual

These are not abstract concerns. The current implementation branch already touches sensitive files across storage, runtime, transport, and management surfaces, which is why the work became difficult to review safely as a single PR.

### Representative Sensitive Files

- `packages/sdk/src/cms.ts`
- `packages/sdk/src/facts-store.ts`
- `packages/sdk/src/management-client.ts`
- `packages/sdk/src/worker.ts`
- `packages/cli/src/node-sdk-transport.js`
- `packages/portal/runtime.js`

## Goals

The DB optimization work has the following goals:

- Bound expensive session, event, and analytics reads
- Replace large session-list reads with page-bounded access
- Enforce safety limits at multiple layers: RPC, SDK, and SQL
- Centralize DB pool and query timeout guardrails
- Expose bounded operational diagnostics for noisy emitters
- Preserve compatibility for existing sessions and stored data
- Make implementation reviewable by splitting the work into smaller PRs

## Non-Goals

This document does not cover:

- Token optimization and model-routing behavior
- Observability UI redesign
- Unrelated worker/orchestration redesign
- Unrelated portal UX redesign

## Scope

The DB optimization work affects the following surfaces.

### Storage and Catalog Layer

- `packages/sdk/src/cms.ts`
- `packages/sdk/src/cms-migrations.ts`
- `packages/sdk/src/pg-migrator.ts`
- `packages/sdk/src/facts-store.ts`

### Management and Runtime Integration

- `packages/sdk/src/management-client.ts`
- `packages/sdk/src/session-proxy.ts`
- `packages/sdk/src/worker.ts`

### Portal and Transport Surfaces

- `packages/portal/runtime.js`
- `packages/portal/src/browser-transport.js`
- `packages/cli/src/node-sdk-transport.js`

### Shared Export and Operational Surfaces

- `packages/sdk/src/index.ts`
- `scripts/db-optimization/`
- `docs/db-optimization-phase2-verification.md`

## Current State

### Session Listing

Session listing can expand with fleet size and produce large response payloads. That increases network transfer, response parsing cost, and overall latency, especially on portal and management surfaces.

### Event and Turn-Metrics Reads

Event and turn-metrics reads are bounded mostly by caller behavior rather than by a clearly enforced contract across all layers. That means safety depends too much on application discipline.

### Analytics Windows

Portal and management-facing analytics reads can accept historical windows that are broader than intended, which increases DB scan cost and payload size.

### Guardrail Configuration

DB timeout and pool settings exist, but are not clearly expressed as one shared reusable policy. This makes behavior harder to reason about and tune consistently across CMS and facts storage surfaces.

### Operational Diagnostics

Operators can investigate event activity manually, but there is no bounded first-class management/runtime API for identifying the highest-volume event emitters.

## Proposed Design

The DB optimization work is intentionally divided into two phases.

## Phase 1: Foundational DB Improvements

### Intent

Phase 1 tightens lower-level DB and storage behavior so that later bounded-read work has a safer and cleaner base.

### Representative Areas

- `packages/sdk/src/cms.ts`
- `packages/sdk/src/cms-migrations.ts`
- `packages/sdk/src/facts-store.ts`
- `packages/sdk/src/pg-migrator.ts`

### Outcome

Phase 1 is mainly foundational. It is not primarily about new operator-facing APIs. Its role is to make the storage and catalog layer safer and easier to extend with explicit bounds in Phase 2.

## Phase 2: Guardrails, Pagination, and Diagnostics

### 1. RPC Guardrails

The first line of defense should be at the public runtime/RPC boundary.

#### Representative Files

- `packages/portal/runtime.js`
- `packages/portal/src/browser-transport.js`
- `packages/cli/src/node-sdk-transport.js`

#### Key Behavior

- Clamp excessive limits to safe maxima
- Validate cursor structure
- Require valid dates for time-bounded reads
- Enforce max window sizes for analytics-style calls
- Apply safer defaults when optional parameters are omitted

#### Expected Result

- Unsafe or oversized requests are normalized or rejected before they hit storage
- Portal and management reads become more predictable
- Broad accidental scans become less likely

### 2. Session Pagination

The design replaces large session-list reads with keyset pagination.

#### Representative Files

- `packages/sdk/src/cms-migrations.ts`
- `packages/sdk/src/cms.ts`
- `packages/sdk/src/management-client.ts`
- `packages/portal/runtime.js`
- `packages/portal/src/browser-transport.js`
- `packages/cli/src/node-sdk-transport.js`

#### Key Behavior

- Expose `listSessionsPage()`
- Use a cursor based on `(updated_at, session_id)`
- Fetch `limit + 1` rows to compute `hasMore`
- Keep read cost proportional to page size rather than total fleet size

#### Expected Result

- Bounded and stable session browsing
- Smaller payloads
- Better scalability as the fleet grows

### 3. SQL-Level Bounds

The SQL layer should enforce the same safety envelope as the app layer.

#### Representative File

- `packages/sdk/src/cms-migrations.ts`

#### Key Behavior

Clamp limits inside SQL functions used for:

- Session events
- Prior session events
- Session turn metrics

#### Expected Result

- Defense in depth
- Protection against regressions in app-layer callers
- Bounded DB behavior even if a higher layer misbehaves

### 4. DB Guardrail Configuration

Pool and query behavior should be expressed as one shared reusable policy.

#### Representative Files

- `packages/sdk/src/cms.ts`
- `packages/sdk/src/facts-store.ts`
- `packages/sdk/src/index.ts`

#### Key Behavior

- Introduce or rely on `buildPgGuardrailConfig()`
- Read and normalize environment-backed settings such as:
  - `DB_POOL_MAX`
  - `PG_QUERY_TIMEOUT_MS`
  - `PG_CONNECTION_TIMEOUT_MS`
  - `PG_IDLE_TIMEOUT_MS`
  - `PG_STATEMENT_TIMEOUT_MS`

#### Expected Result

- Safer fail-fast DB behavior
- Reduced risk of hanging queries or pool exhaustion
- More predictable and tunable deployment behavior

### 5. Diagnostics and DB Metrics

The design adds a bounded operational surface for understanding heavy DB and event activity.

#### Representative Files

- `packages/sdk/src/cms.ts`
- `packages/sdk/src/management-client.ts`
- `packages/sdk/src/db-metrics.ts`
- `packages/sdk/src/db-metrics-reporter.ts`
- `packages/portal/runtime.js`

#### Key Behavior

- Expose `getTopEventEmitters({ since, limit })`
- Aggregate by `(worker_node_id, event_type)`
- Keep both the time window and row count bounded
- Expose DB metrics snapshots through management/runtime surfaces

#### Expected Result

- Easier production diagnosis
- Less manual SQL inspection
- Clearer evidence that optimization work is helping

## Architecture Overview

This work does not introduce a new storage subsystem. It hardens the existing CMS, management, portal, and transport stack.

### Resulting Flow

- Caller enters through portal runtime, browser transport, or CLI transport
- Public/runtime guardrails normalize or reject unsafe request parameters
- Management client forwards bounded requests into the catalog layer
- Catalog/provider calls bounded SQL functions
- DB diagnostics and metrics are surfaced through bounded management/runtime APIs

This is a contract-hardening change, not a platform rewrite.

## Data Flow

### Session Page Reads

- Caller requests `listSessionsPage`
- Runtime clamps `limit` and validates cursor shape
- Transport delegates to management client
- Management client delegates to catalog provider
- Catalog provider calls `cms_list_sessions_page(...)`
- SQL returns `limit + 1` rows
- SDK trims to `limit`, computes `hasMore`, and returns a bounded page payload

### Session Event and Turn-Metrics Reads

- Caller requests history or metrics
- Runtime normalizes request parameters
- SDK forwards bounded values to SQL
- SQL clamps `p_limit` again
- Results return in bounded form

### Top Event Emitter Diagnostics

- Caller requests `getTopEventEmitters({ since, limit })`
- Runtime requires a valid `since`, enforces a max window, and clamps `limit`
- Management client delegates to catalog provider
- Catalog provider calls `cms_get_top_event_emitters(...)`
- Results return as a bounded diagnostic list

## Control Flow

The control-flow change is mainly about moving enforcement earlier and duplicating it at SQL level on purpose.

### Intended Model

- RPC layer protects public entry points
- SDK layer keeps internal usage consistent
- SQL layer guarantees bounded behavior even if a higher layer regresses

This duplication is deliberate defense in depth, not accidental overlap.

## API Boundary Changes

### New or Emphasized Contracts

- `listSessionsPage(params)`
- `getTopEventEmitters({ since, limit? })`

### Behavior Changes to Existing Reads

- Session, event, and metrics reads become explicitly bounded
- Analytics-style endpoints enforce bounded windows
- Large session browsing shifts from full-list assumptions to page-based access

### Consumer Expectations

Portal, CLI, and management-facing consumers should use bounded and paged access patterns rather than relying on broad historical or full-list reads.

## Storage / Schema / Migration Changes

This work is function-level and contract-level rather than a large table-schema redesign.

### Representative Changes

- Add `cms_list_sessions_page(...)`
- Add `cms_get_top_event_emitters(...)`
- Tighten existing session-events and turn-metrics SQL functions with bound checks
- Rely on the existing migration path to roll these changes out safely

The main compatibility risk is behavioral contract change, not destructive data reshaping.

## Runtime Behavior Changes

Runtime behavior becomes more explicit in four ways:

- Oversized requests are rejected or normalized earlier
- Session browsing becomes paged
- DB-heavy reads are bounded at SQL level
- Operator-facing diagnostics become first-class and bounded

### Expected Effect

- Lower payload size
- More predictable latency
- Safer DB usage under load

## Interaction With Existing Surfaces

### Client

The client should continue to work, but consumers relying on broad history or full-list session reads may need to adopt bounded access patterns.

### Worker

Workers are not being redesigned here, but worker-adjacent runtime and management flows may observe safer read behavior and improved diagnostics. Any worker logic depending on broad management reads should tolerate tighter bounds.

### Portal

Portal runtime becomes the primary place where public request parameters are normalized and bounded.

### CLI

CLI transport forwards the same bounded contracts and therefore inherits the same safer behavior.

### TUI

The TUI is not the focus of this design, but any affected browsing or management reads should continue to work as long as they tolerate paged and bounded APIs. TUI-specific coverage should be added if a given PR slice materially affects TUI-facing behavior.

## Compatibility and Rollout

### Existing Sessions

Existing sessions remain valid. This work changes how sessions are read and surfaced, not their identity or lifecycle.

### Stored Data

Stored data should remain compatible because the changes are mainly:

- New SQL functions
- Tighter bounds in existing SQL functions
- Safer runtime and management access behavior

### Deployments

Deployments need migrations applied before portal/runtime behavior relies on the new functions.

#### Recommended Rollout Order

- Land storage/function changes first
- Land management/runtime consumers of those functions
- Deploy with guardrails enabled
- Validate with smoke tests and response-size checks

### Package Consumers

Consumers using SDK exports should remain compatible if they accept bounded behavior and adopt page-based access where needed.

## Failure Modes and Rollback

### DB Failures During Bounded Reads

#### Expected Behavior

- Requests still fail in the usual way
- Request size is bounded, which makes failure impact easier to reason about

#### Rollback

- Revert the affected PR slice or runtime path if needed

### Missing Migration or Function Mismatch

#### Expected Behavior

- Runtime or management calls fail because the expected SQL function is missing

#### Mitigation

- Apply migrations before enabling dependent runtime paths
- Use rollout scripts and validation to catch this early

#### Rollback

- Revert runtime-side dependency or redeploy the prior app version

### Overly Aggressive Guardrails

#### Expected Behavior

- Callers may see smaller pages, lower caps, or narrower time windows than expected

#### Mitigation

- Document limits clearly
- Validate affected portal, CLI, and TUI flows

#### Rollback

- Relax the specific cap in a narrow follow-up PR or revert that slice

### DB Timeout or Pool Misconfiguration

#### Expected Behavior

- Queries may fail faster than intended

#### Mitigation

- Keep defaults conservative and environment-driven
- Validate configuration in local and staging environments

#### Rollback

- Revert environment overrides or revert the guardrail slice

### Worker Restarts During Management Reads

#### Expected Behavior

- Management and catalog reads should remain safe and bounded
- Restart behavior should not create an unbounded recovery read path

#### Mitigation

- Keep reads bounded regardless of runtime state
- Verify behavior with existing local integration coverage where affected

#### Rollback

- Revert the affected runtime-management integration slice if restart behavior regresses

## Detailed Test Plan

The DB optimization work should be validated in layers.

## Unit Tests

### Purpose

Validate isolated guardrail and config behavior.

### Primary Tests

- `packages/sdk/test/local/pg-guardrail-config.unit.test.js`
- `packages/portal/test/runtime-guards.test.js`

### What They Verify

- Limit clamping
- Cursor validation
- Required date enforcement
- Max window enforcement
- Environment parsing and safe defaults

## Migration and SQL-Level Tests

### Purpose

Validate storage-layer bounded behavior directly.

### Primary Tests

- `packages/sdk/test/local/pg-migrator.test.js`
- `packages/sdk/test/local/cms-read-bounds.integration.test.js`
- `packages/sdk/test/local/cms-turn-metrics.integration.test.js`

### What They Verify

- Migrations apply cleanly
- Bounded SQL functions exist
- Excessive limits are clamped inside SQL
- Storage behavior remains correct under invalid or excessive inputs

## Catalog and Management Integration Tests

### Purpose

Validate the SDK and management boundary for the new bounded contracts.

### Primary Tests

- `packages/sdk/test/local/cms-list-sessions-page.test.js`
- `packages/sdk/test/local/cms-top-event-emitters.test.js`
- `packages/sdk/test/local/cms-turn-metrics.test.js`

### What They Verify

- Session pages are ordered and bounded correctly
- Cursor semantics and `hasMore` work
- Top-emitter aggregation is correct and bounded
- Bounded metrics contracts remain typed and stable

## Portal / CLI / Browser Transport Tests

### Purpose

Validate public and operator-facing contract enforcement.

### Primary Tests

- `packages/sdk/test/local/portal-phase2-rpc.test.js`
- `packages/portal/test/runtime-guards.test.js`

### What They Verify

- Portal runtime enforces bounded request contracts
- Browser and CLI transports forward the correct shapes
- Top-emitter and session-page requests behave correctly end-to-end

## Diagnostics and DB Metrics Tests

### Purpose

Validate operator-facing DB visibility behavior.

### Primary Tests

- `packages/sdk/test/local/db-metrics-reporter.test.js`
- `packages/sdk/test/local/cms-top-event-emitters.test.js`

### What They Verify

- Metrics snapshots are aggregated and surfaced correctly
- Top-emitter diagnostics are bounded and usable

## Local Integration and Manual Validation

### Primary Tooling

- `scripts/db-optimization/rpc-smoke.js`
- `scripts/db-optimization/response-size-check.js`
- `scripts/db-optimization/explain-pack.sql`
- `docs/db-optimization-phase2-verification.md`

### Manual Checks

- Smoke runtime endpoints
- Compare unbounded vs paged response sizes
- Inspect query plans for healthy index usage
- Confirm migration state before rollout

## Performance / Optimization Validation

This work should not be considered complete merely because functional tests pass. We also want evidence that it improves or protects:

- Response size
- Query boundedness
- Latency predictability
- Operator diagnosis time

### Primary Evidence Sources

- `response-size-check.js`
- `rpc-smoke.js`
- `EXPLAIN ANALYZE` from `explain-pack.sql`

## Pass / Fail Criteria

### Pass

- Targeted automated tests pass for the current slice
- Migrations apply successfully
- Smoke endpoints succeed
- Bounded reads remain bounded in practice
- Portal and CLI flows continue to work for affected paths

### Fail

- A slice requires unrelated file churn
- Migrations and runtime cannot be deployed independently
- Portal or CLI behavior depends on undocumented contract changes
- Payload size or latency regresses materially without explanation

## PR Breakdown

The DB work should be landed as small, reviewable slices.

## PR 1: Storage Function Foundations

### Primary Claim

The CMS storage layer now supports bounded session paging and bounded top-emitter diagnostics, and existing event and metrics functions enforce SQL-side limits

### In Scope

- `packages/sdk/src/cms-migrations.ts`
- `packages/sdk/src/pg-migrator.ts`
- SQL changes for:
  - `cms_list_sessions_page(...)`
  - `cms_get_top_event_emitters(...)`
  - Bounded session-events and turn-metrics functions

### Out of Scope

- Portal runtime changes
- CLI/browser transport changes
- Management-client forwarding
- DB metrics reporting

### Required Tests

- `packages/sdk/test/local/pg-migrator.test.js`
- `packages/sdk/test/local/cms-read-bounds.integration.test.js`
- `packages/sdk/test/local/cms-turn-metrics.integration.test.js`

## PR 2: Catalog and Management API Surface

### Primary Claim

The catalog/provider and management client now expose bounded session paging and top-emitter diagnostics cleanly

### In Scope

- `packages/sdk/src/cms.ts`
- `packages/sdk/src/management-client.ts`
- `packages/sdk/src/index.ts` only for required exports/types

### Out of Scope

- Portal runtime switch/case logic
- Browser transport changes
- CLI transport changes
- DB metrics reporter changes

### Required Tests

- `packages/sdk/test/local/cms-list-sessions-page.test.js`
- `packages/sdk/test/local/cms-top-event-emitters.test.js`
- `packages/sdk/test/local/cms-turn-metrics.test.js`

## PR 3: Portal Runtime and Transport Guardrails

### Primary Claim

Portal runtime, browser transport, and CLI transport now normalize or reject unsafe DB-facing requests before they reach storage

### In Scope

- `packages/portal/runtime.js`
- `packages/portal/src/browser-transport.js`
- `packages/cli/src/node-sdk-transport.js`

### Out of Scope

- New SQL functions
- DB metrics reporter implementation
- Unrelated runtime behavior changes

### Required Tests

- `packages/portal/test/runtime-guards.test.js`
- `packages/sdk/test/local/portal-phase2-rpc.test.js`

## PR 4: DB Guardrail Configuration

### Primary Claim

DB-backed catalog and facts surfaces now share one env-driven guardrail configuration path

### In Scope

- `packages/sdk/src/cms.ts`
- `packages/sdk/src/facts-store.ts`
- `packages/sdk/src/index.ts`

### Out of Scope

- Portal runtime changes
- Diagnostics endpoints
- Token optimization files

### Required Tests

- `packages/sdk/test/local/pg-guardrail-config.unit.test.js`

## PR 5: Diagnostics and DB Metrics Reporting

### Primary Claim

PilotSwarm now exposes bounded DB diagnostics and metrics reporting in a reviewable, testable way

### In Scope

- `packages/sdk/src/db-metrics.ts`
- `packages/sdk/src/db-metrics-reporter.ts`
- Narrow management/runtime glue if needed

### Out of Scope

- Session pagination behavior
- Unrelated worker/runtime refactors
- Broad monitoring UI changes

### Required Tests

- `packages/sdk/test/local/db-metrics-reporter.test.js`
- `packages/sdk/test/local/cms-top-event-emitters.test.js` if exposure changes

## PR 6: Rollout Docs and Verification Tooling

### Primary Claim

The DB optimization work now has a reproducible rollout and verification procedure

### In Scope

- `docs/db-optimization-phase2-verification.md`
- `scripts/db-optimization/rpc-smoke.js`
- `scripts/db-optimization/response-size-check.js`
- `scripts/db-optimization/explain-pack.sql`

### Out of Scope

- New storage behavior
- Runtime logic changes
- DB metrics implementation changes

## Merge Order

### Recommended Merge Order

- PR 1: Storage Function Foundations
- PR 2: Catalog and Management API Surface
- PR 3: Portal Runtime and Transport Guardrails
- PR 4: DB Guardrail Configuration
- PR 5: Diagnostics and DB Metrics Reporting
- PR 6: Rollout Docs and Verification Tooling

## Open Questions

- Do any consumers still need transitional support for full-list session reads?
- Should some guardrail limits be more broadly environment-tunable?
- Does production-scale top-emitter analysis need additional indexing?
- Which TUI flows need explicit validation in the first DB-focused slices?

## Recommendation

The recommended next steps are:

1. review this design and test plan first
2. align on the PR boundaries
3. start implementation from PR 1 only
4. keep each PR narrow even if later work already exists in the branch

This will make the DB optimization work substantially more reviewable and safer to merge.
