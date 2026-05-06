# Facts Table — Test Specification

## Overview

This document specifies the test coverage for the PilotSwarm facts table feature. Tests live in `packages/sdk/test/local/facts.test.js` and validate the full lifecycle of durable structured memory across session-scoped and shared facts, session cleanup, sweeper cleanup, and store constraints.

## Existing Test Coverage

### Suite: Level 3/4 — Facts (`facts.test.js`)

All tests use `vitest` (`describe`/`it`) and follow PilotSwarm test conventions: `withClient()` or `createTestEnv()` for setup/teardown, assertion helpers from `test/helpers/assertions.js`, and isolated database schemas per test.

---

### Test 1: Facts tools store, read, and delete with shared/session semantics

**What it verifies:**
- `store_fact` stores session-scoped facts by default (one per session, keyed by `session:<sessionId>:<key>`).
- `store_fact` with `shared=true` stores shared facts (keyed by `shared:<key>`).
- `read_facts` with `scope=accessible` returns the caller's own session facts + shared facts.
- `read_facts` with `scope=accessible` does **not** return another session's private facts.
- `read_facts` with `scope=session` returns only the caller's own session-scoped facts.
- `delete_fact` deletes the current session's private fact without affecting other sessions or shared facts.

**Setup:**
- Creates a `PgFactStore` directly (no worker/client needed for this low-level test).
- Creates three `createFactTools()` tool instances.
- Stores two session-scoped facts (one for `session-a`, one for `session-b`) with the same key `build/status`.
- Stores one shared fact `baseline/tps`.

**Assertions:**
1. `accessible` scope from `session-a` returns exactly 2 facts (its own `build/status` + shared `baseline/tps`).
2. `session-b`'s private fact is not visible to `session-a`.
3. `session` scope from `session-b` returns exactly 1 fact (its own `build/status`).
4. After deleting `session-a`'s `build/status`, only 2 facts remain in the table.
5. `session-b`'s private fact and the shared fact remain intact.

---

### Test 2: deleteSession removes session facts but keeps shared facts

**What it verifies:**
- `client.deleteSession()` triggers `deleteSessionFactsForSession()` which removes all session-scoped facts for that session.
- Shared facts stored by the same session are not affected by session deletion.

**Setup:**
- Starts a full worker + client pair.
- Creates a session via `client.createSession()`.
- Stores 2 session-scoped facts and 1 shared fact, all attributed to the session.
- Calls `client.deleteSession(sessionId)`.

**Assertions:**
1. After deletion, only 1 fact remains (the shared fact).
2. Session-scoped facts `scratch/step` and `result/summary` are gone.
3. The shared fact `shared/baseline` persists.

---

### Test 3: Sweeper cleanup removes session facts for descendants too

**What it verifies:**
- The `cleanup_session` sweeper tool calls `deleteSessionFactsForSession()` for the root session and all its descendants.
- Uses the CMS `getDescendantSessionIds()` recursive query to find all children.

**Setup:**
- Uses mocked `catalog`, `duroxideClient`, and `factStore` objects (no real database needed).
- Mock `getDescendantSessionIds()` returns `["child-a", "child-b"]`.
- Tracks calls to `deleteSessionFactsForSession()`.

**Assertions:**
1. `deleteSessionFactsForSession` is called for `root-session`, `child-a`, and `child-b`.
2. `softDeleteSession` is called 3 times (root + 2 children).
3. `deleteInstance` is called 3 times.
4. `cleanup_session` returns `{ ok: true }`.

---

### Test 4: Non-postgres stores are rejected for facts

**What it verifies:**
- `createFactStoreForUrl()` throws an error when given a non-PostgreSQL URL.
- The error message contains `"require a PostgreSQL store"`.

**Setup:**
- Calls `createFactStoreForUrl("sqlite:///tmp/pilotswarm-facts-local-test.db")`.

**Assertions:**
1. The call throws.
2. Error message includes `"require a PostgreSQL store"`.

---

## Recommended Additional Test Coverage

The following tests should be added to strengthen coverage of the facts feature:

### Test 5: Parent reads child's session-scoped facts via session_id

**What to verify:**
- A parent session can read a child's non-shared facts by passing `session_id=<child>` to `read_facts`.
- Lineage is verified via `getDescendantSessionIds()` — if the target is a descendant, access is granted.
- The parent sees the child's session-scoped facts alongside shared facts.

**Setup:**
- Creates a `PgFactStore` and `createFactTools` with a mock `getDescendantSessionIds` that returns `["child-session"]`.
- Parent stores a session-scoped fact. Child stores a session-scoped fact.
- Parent calls `read_facts({ session_id: "child-session" })`.

**Assertions:**
1. The parent sees the child's session-scoped fact.
2. No error is thrown.

---

### Test 6: Parent reads all descendants' facts via scope=descendants

**What to verify:**
- `read_facts({ scope: "descendants" })` returns the parent's own facts, shared facts, and all descendants' session-scoped facts.
- Works for grandchildren (depth 2+).

**Setup:**
- Creates facts for parent, child, and grandchild sessions.
- Mock `getDescendantSessionIds("parent")` returns `["child", "grandchild"]`.
- Parent calls `read_facts({ scope: "descendants" })`.

**Assertions:**
1. All three sessions' facts are returned plus any shared facts.
2. Facts from an unrelated session are not returned.

---

### Test 7: Non-descendant session cannot read another session's private facts

**What to verify:**
- When `session_id=<other>` is passed but `<other>` is not a descendant of the caller, the caller still cannot see the other session's private facts.
- Lineage check fails silently — no error, just no access.

**Setup:**
- Two unrelated sessions store session-scoped facts.
- Session A calls `read_facts({ session_id: "session-b" })` with a mock `getDescendantSessionIds` that returns `[]`.

**Assertions:**
1. Session A does not see session B's private facts.
2. Only shared facts (if any) are returned.

---

### Test 8: scope=descendants with no sub-agents

**What to verify:**
- When a session has no descendants, `scope=descendants` behaves identically to `scope=accessible` (own facts + shared).

**Setup:**
- Mock `getDescendantSessionIds` returns `[]`.
- Session stores a session-scoped fact and a shared fact.
- Session calls `read_facts({ scope: "descendants" })`.

**Assertions:**
1. Returns own session fact + shared fact.
2. Count is identical to `scope=accessible`.

---

### Test 9: Upsert behavior — store_fact overwrites existing value

**What to verify:**
- Calling `store_fact` with the same key and same session updates the value in-place.
- `updated_at` is refreshed.
- The `scope_key` uniqueness constraint handles upserts correctly.

### Test 10: Key pattern matching with wildcards

**What to verify:**
- `read_facts` with `key_pattern="build/%"` returns only facts whose key starts with `build/`.
- `read_facts` with `key_pattern="*"` returns all visible facts.
- Glob-style `*` is converted to SQL `%`.

### Test 11: Tag-based filtering

**What to verify:**
- `read_facts` with `tags=["build"]` returns only facts tagged with `build`.
- Multiple tags require all to match (array containment).

### Test 12: Limit enforcement

**What to verify:**
- `read_facts` respects the `limit` parameter.
- The default limit is 50 rows when no limit is specified.

### Test 13: Agent ID provenance filter

**What to verify:**
- `read_facts` with `agent_id="builder"` returns only facts stored by the `builder` agent.
- Combined with scope filters, provenance narrows but doesn't widen visibility.

### Test 14: Concurrent session isolation

**What to verify:**
- Two sessions running concurrently cannot see each other's session-scoped facts.
- Both can see the same shared facts.
- Deleting one session's facts does not affect the other.

### Test 15: Facts tools available in LLM session (e2e)

**What to verify:**
- A full LLM-driven session can successfully call `store_fact`, `read_facts`, and `delete_fact`.
- The tools appear in the session's tool list.
- The LLM receives correct tool results.

This test would use `withClient()` with a real LLM turn similar to the smoke tests.

### Test 16: Schema isolation between test runs

**What to verify:**
- `createTestEnv()` generates unique `factsSchema` names.
- Two concurrent test environments cannot read each other's facts.
- Cleanup drops the schema completely.
