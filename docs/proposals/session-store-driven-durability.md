# Proposal: Session-Store-Driven Durability

> **Status:** Proposal
> **Date:** 2026-04-04
> **Goal:** Remove the `blobEnabled` durability toggle and make session durability depend solely on the `SessionStateStore` explicitly configured on workers.

---

## Summary

PilotSwarm should stop treating session durability as a client-controlled orchestration setting.

Instead:

- the client continues to assemble orchestration input
- workers must be configured with an explicit `SessionStateStore`
- orchestration durability behavior should rely on that store path, not on a `blobEnabled` flag
- `NullSessionStore` should exist only as a test harness for simple non-durability tests

This change removes a major footgun: user-created sessions should not become non-durable because a client launcher forgot to pass a special flag.

---

## Problem

Today, durability is modeled in a way that is too easy to misconfigure:

- the client can influence whether a session starts in durable mode
- orchestration logic branches on `blobEnabled`
- the actual worker-side storage capability is a separate concern

This creates mismatches:

- a worker may be fully configured for durable state, but a client can still start a non-durable session
- different launchers can accidentally create different durability behavior for otherwise identical sessions
- the name `blobEnabled` is too specific for what the feature actually means

The real concern is not “is blob storage enabled?” but:

- does this worker fleet have an explicit session-state persistence strategy?

That strategy might be:

- blob-backed storage for AKS
- filesystem-backed storage for durability tests
- a null/no-op store for simple tests that do not exercise recovery

---

## Proposed Model

### 1. Remove `blobEnabled` as a public concept

`PilotSwarmClient` should not expose or accept a durability toggle.

The client still assembles orchestration input, but it should no longer own a “durable vs non-durable” decision.

### 2. Remove `blobEnabled` from orchestration state

The orchestration should not branch on a blob-specific flag.

Instead, it should continue to perform its normal hydrate/dehydrate/checkpoint flow, and those activities should rely on the configured `SessionStateStore`.

This keeps orchestration logic simpler and makes the storage layer the only source of truth.

### 3. Require explicit worker session-store configuration

Workers should not silently choose a persistence strategy.

A worker must be started with one of:

- a blob-backed store for AKS / remote durability
- a filesystem-backed store for local durability / hydration tests
- a `NullSessionStore` for simple tests only

There should be no implicit fallback store in production code.

### 4. Add `NullSessionStore` for tests

`NullSessionStore` should implement the session-store interface while intentionally persisting nothing.

Expected behavior:

- `dehydrate`, `hydrate`, `checkpoint`, and `delete` are no-ops
- optional trace logging may record the operation for debugging
- this store is used only in tests that do not validate durability, hydration, or rehydration behavior

This lets the orchestration and activity paths stay uniform without requiring every test to provision real persistence.

### 5. Treat session durability as a worker/runtime concern

Durability should be inferred from the explicit store configured on workers, not from:

- the client
- agent markdown files
- per-session prompt instructions

Agent `.agent.md` files should not carry durability settings.

---

## Deployment And Test Conventions

### AKS / Remote

- use blob-backed session storage
- session recovery across workers is expected to work

### Durability / Hydration / Recovery Tests

- use explicit filesystem-backed session storage
- tests may validate hydrate, dehydrate, checkpoint, crash recovery, and worker handoff behavior

### Simpler Local Tests

- use `NullSessionStore`
- these tests should not assert cross-worker recovery or durable rehydration behavior

---

## Behavioral Notes

### Single-worker + `NullSessionStore`

On a single worker, local session files may make resume appear to work after a dehydrate/destroy cycle.

That is acceptable as an implementation detail for simple tests, but it must not be treated as a durability guarantee.

`NullSessionStore` remains a non-durable test harness, not a supported production persistence mode.

### Missing-state failures

When durable session state is not actually recoverable, the failure should be expressed generically in terms of missing session state, not in blob-specific terms.

Store-specific transport details should stay below the orchestration layer.

---

## Why This Is Better

- removes a launcher/client footgun
- makes the storage layer the only durability authority
- supports blob, filesystem, and null stores cleanly
- keeps orchestration behavior uniform instead of split by a blob-specific flag
- makes tests more explicit about whether they do or do not require recovery semantics

---

## Implementation Plan

1. Remove the public/client durability toggle from `PilotSwarmClient`.
2. Remove `blobEnabled` from orchestration input and orchestration branching.
3. Add `NullSessionStore` implementing the session-store interface.
4. Remove any implicit filesystem store fallback from worker construction.
5. Require tests to choose an explicit store strategy:
   - blob-backed where appropriate
   - filesystem-backed for durability/recovery tests
   - `NullSessionStore` for simpler tests
6. Update error handling so missing-state failures are generic and store-agnostic.
7. Update docs and examples so durability is presented as worker configuration, not client behavior.

---

## Non-Goals

- putting durability settings in agent markdown
- making `NullSessionStore` a production deployment mode
- moving orchestration-input assembly from the client into the worker

---

## Open Questions

- whether `checkpoint()` should remain a no-op on `NullSessionStore` or emit stronger trace diagnostics for tests
- whether local filesystem-backed stores in non-test local development should be configured explicitly by helper scripts or by callers

