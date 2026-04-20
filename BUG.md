# Known Bugs

## Bug 1: `bootstrapPrompt` lost on `continueAsNew`

**File:** `packages/sdk/src/orchestration.ts`
**Line:** 228

**Code:**
```typescript
...(pendingPrompt ? { bootstrapPrompt } : {}),
```

**Problem:** `bootstrapPrompt` is only preserved in the `continueAsNew` input when `pendingPrompt` is truthy. The two flags are independent — if `bootstrapPrompt` is `true` but there is no pending prompt, the flag is silently dropped across the `continueAsNew` boundary and bootstrap behavior stops.

**Fix:**
```typescript
...(bootstrapPrompt ? { bootstrapPrompt } : {}),
```

---

## Bug 2: Inconsistent result truncation — `check_agents` cuts at 1000, everything else at 2000

**File:** `packages/sdk/src/orchestration.ts`
**Lines:** 1247 (bug), 1345, 1354, 279, 293 (correct)

**Code:**
```typescript
// check_agents — line 1247:
if (parsed.result) agent.result = parsed.result.slice(0, 1000);

// wait_for_agents — lines 1345, 1354:
if (content) agent.result = content.slice(0, 2000);
if (parsed.result) agent.result = parsed.result.slice(0, 2000);

// applyChildUpdate — lines 279, 293:
agent.result = update.content.slice(0, 2000);
agent.result = parsed.result.slice(0, 2000);
```

**Problem:** Agent results are truncated to 1000 bytes via the `check_agents` path and to 2000 bytes via all other paths. Silent data loss when `check_agents` is used.

**Fix:** Change line 1247 to `slice(0, 2000)`.

---

## Bug 3: `applyChildUpdate` overwrites fresh content with potentially stale SDK result

**File:** `packages/sdk/src/orchestration.ts`
**Lines:** 278–294

**Code:**
```typescript
if (update.content) {
    agent.result = update.content.slice(0, 2000);  // line 279 — fresh, from child message
}

if (update.updateType === "completed") {
    agent.status = "completed";
}

try {
    const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
    const parsed = JSON.parse(rawStatus);
    if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "idle") {
        agent.status = parsed.status === "failed" ? "failed" : "completed";
    }
    if (parsed.result && parsed.result !== "done") {
        agent.result = parsed.result.slice(0, 2000);  // line 293 — unconditionally overwrites
    }
} catch {}
```

**Problem:** The child's message content (line 279) is the freshest available data. The `getSessionStatus` SDK call (line 287) may return a slightly older persisted result. When both are present, the unconditional overwrite on line 293 discards the fresher content from the child update.
