---
name: debug-orchestration
description: Diagnose and fix nondeterminism errors in the duroxide orchestration. Covers the replay model, common violations, and how to audit orchestration code for determinism.
---

# Debug Orchestration Nondeterminism

Duroxide replays the orchestration generator from the beginning on every new event. The generator must produce the **exact same sequence of yielded actions** during replay as during original execution. A mismatch causes:

```
nondeterministic: custom status mismatch: action=CallActivity { ... } vs event=CustomStatusUpdated { ... }
```

## How replay works

1. Duroxide stores every action (yield) result in a history log.
2. On replay, it feeds stored results back into the generator at each `yield`.
3. It compares each yielded action descriptor with the stored history event.
4. If they don't match → **nondeterminism error** → orchestration fails.

`setCustomStatus()` is **also recorded** in history as `CustomStatusUpdated`. It's fire-and-forget (no yield), but its position relative to yields matters.

## Diagnosis steps

1. **Read the error message carefully.** It tells you:
   - What the orchestration **tried to do** (`action=CallActivity { name: "X" }`)
   - What the history **expected** (`event=CustomStatusUpdated { ... }`)

2. **Find the divergence point.** The orchestration took a different code path during replay. Look for:
   - `Date.now()` used in a condition before a yield or `setCustomStatus()`
   - `Math.random()` or `crypto.randomUUID()` in control flow
   - Any I/O (fetch, fs, database) done directly in the generator
   - `setCustomStatus()` that moved relative to a yield

3. **Trace the yield sequence.** Number every `yield` and `setCustomStatus()` call in `orchestration.ts`. During replay, the Nth yield must match the Nth history event.

## Common bugs and fixes

| Bug | Fix |
|-----|-----|
| `Date.now()` in condition before yield | Use `yield ctx.utcNow()` — deterministic, replay-safe |
| `Math.random()` for IDs | Use `yield ctx.newGuid()` |
| Direct I/O in generator | Wrap in an activity (`ctx.scheduleActivity()`) |
| `setTimeout` / `setInterval` | Use `yield ctx.scheduleTimer(ms)` |
| `setCustomStatus()` order changed | Ensure it appears at the same position relative to yields |
| Redeployed with changed yields | Reset database — `./scripts/deploy-aks.sh` does this automatically |

## Deterministic alternatives

| Non-deterministic | Deterministic equivalent |
|-------------------|--------------------------|
| `Date.now()` | `yield ctx.utcNow()` |
| `new Date()` | `yield ctx.utcNow()` (returns ms, wrap with `new Date(ms)` if needed) |
| `Math.random()` | `yield ctx.newGuid()` |
| `crypto.randomUUID()` | `yield ctx.newGuid()` |
| `setTimeout(fn, ms)` | `yield ctx.scheduleTimer(ms)` |
| `fetch()` / any I/O | `yield ctx.scheduleActivity("name", input)` |

## The `setCustomStatus` trap

`setCustomStatus()` doesn't require a yield, but duroxide records it as a `CustomStatusUpdated` event in the history. This means:

```typescript
// Original execution: condition is false → no activity yield → setCustomStatus
if (Date.now() > threshold) {           // ← non-deterministic!
    yield someActivity();               // recorded as CallActivity
}
setStatus("idle");                      // recorded as CustomStatusUpdated

// Replay: condition is NOW true → activity yield → mismatch!
// Replay expects CustomStatusUpdated but gets CallActivity
```

The fix: use `yield ctx.utcNow()` for any time-based branching.

## Runaway / leaky deployments

A very common cause of nondeterminism is **old workers from a previous deployment still running** in the same cluster, connected to the same database. This happens when:

- A previous deployment used a different Kubernetes namespace (e.g. `copilot-sdk` vs `copilot-runtime`) and was never cleaned up.
- A rolling update left old ReplicaSet pods running alongside new ones during the transition.
- Manual `kubectl run` or port-forward sessions left orphaned pods polling the same database.

Old workers run **old orchestration code** but process orchestrations that were started (or replayed) by the **new code**. The yield sequences differ → nondeterminism error.

### Diagnosis

```bash
# Check ALL namespaces for worker pods — not just the expected one
kubectl get pods --all-namespaces -l app.kubernetes.io/component=worker --no-headers
```

If you see pods in an unexpected namespace or from a different ReplicaSet, that's the culprit.

### Fix

```bash
# Delete the old deployment and namespace
kubectl delete deployment copilot-runtime-worker -n <old-namespace>
kubectl delete namespace <old-namespace> --wait=false

# Reset the database to clear any tainted history
NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file=.env.remote scripts/db-reset.js --yes

# Restart current workers
kubectl rollout restart deployment/copilot-runtime-worker -n copilot-runtime
```

## After fixing

1. **Reset the database** — existing orchestrations have stale history:
   ```bash
   NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file=.env.remote scripts/db-reset.js --yes
   ```
2. **Redeploy** — or use the full deploy script:
   ```bash
   ./scripts/deploy-aks.sh
   ```

## Key files
- [src/orchestration.ts](../../../src/orchestration.ts) — the orchestration generator (audit this for determinism)
- [src/session-proxy.ts](../../../src/session-proxy.ts) — activity definitions (safe — activities run outside replay)
- [scripts/deploy-aks.sh](../../../scripts/deploy-aks.sh) — deploy with DB reset
- [scripts/db-reset.js](../../../scripts/db-reset.js) — standalone DB reset
