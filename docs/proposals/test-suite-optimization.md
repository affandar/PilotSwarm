# Test suite runtime optimization

Status: proposal (2026-07-05)
Origin: post-lifecycle-protocol test audit. All numbers measured on the
2026-07-05 runs (Apple Silicon dev box, local PG, live model providers).

## Measured baseline

| Run | Wall | Aggregate test-time | Notes |
|---|---|---|---|
| `npm run test:local` (full, 139 files) | ~360 s | ~2 835 s | vitest default parallelism (~8× effective) |
| Full + literal kill matrix (142 files) | ~407 s | ~3 210 s | kill matrix adds ~47 s wall (parallelized) |
| `run-tests.sh --all-providers` | ~20 min+ | 2 × 4 417 s | 2 provider phases × full suite at `PS_TEST_MAX_WORKERS=8` |
| `concurrent-sessions-repro` alone | 901 s | — | 6 forked workers × 3 rounds soak |
| Kill matrix alone (sequential) | ~450 s | — | 6 scenarios × (~30 s duroxide session-lock reclaim + LLM turns) |

**The green path is not the problem — flake-driven reruns are.** The
2026-07-05 all-providers run produced 8 failures; 6 re-passed in isolation
(pure `PS_TEST_MAX_WORKERS=8` saturation — one was *Simple Q&A*), and the
other 2 are recurring LLM-behavior flakes (below). Every flaked heavy file
costs 3–15 minutes of re-triage, routinely exceeding the suite's own
runtime.

## Cost structure

1. **Real LLM turns** dominate the ~30 worker-spawning files (10–20 s per
   turn, hundreds of turns per full pass).
2. **Fixed waits**: duroxide's ~30 s session-lock reclaim (×6 kill
   scenarios ≈ 180 s — irreducible until microsoft/duroxide#38 item 2
   exposes `sessionLockTimeoutMs`); `wait_for_agents` 30 s fallback polls;
   scripted `wait(15)`/`wait(60)` prompts; a worker boot + schema create
   (~10 s) paid per `withClient` call — several files pay it per *test*.
3. **Redundancy**: `--all-providers` reruns all ~140 files per provider
   when ~85 % cannot behave differently per model (store, CMS, protocol,
   UI-contract files). The kill matrix — whose LLM content is "what is
   2+2" — runs twice, ~8 min each, for zero provider-specific coverage.

## Changes, ranked by savings-per-risk

### 1. Provider-sensitive slice for `--all-providers`

Base provider runs the full suite once. Each additional provider phase
runs ONLY the model-sensitive files (~10): `smoke-*`, tool calling,
`wait-affinity`, `model-selection`, agent-behavior suites. Everything
whose store/CMS/orchestration behavior is model-independent runs once.

Effect: ~20 min → ~12 min AND removes the primary saturation source.
Zero coverage loss — the sliced files' provider interaction is exactly
the LLM boundary, which the slice covers.

### 2. Two-pool parallelism

`PS_TEST_MAX_WORKERS=8` across the board is what generated the timeout
storm. Split the run: **light pool** (unit/contract/text-assertion files)
at 8 workers; **heavy pool** (worker-spawning files: multi-worker,
kill matrix, sub-agents, reliability-*, session-policy, chaos) capped at
2–3. Two sequential vitest invocations in the npm script.

### 3. Demote soak-class files out of the PR gate

`concurrent-sessions-repro` (15 min) and `chaos` are soak/repro tests,
not regression gates. Move to a nightly/pre-deploy tier. Instant −16 min
from every iteration loop.

### 4. De-fragilize scripted-LLM assertions

Two tests flaked repeatedly on model behavior, not code:

- `wait-affinity` "long wait preserves affinity": asserts the model
  replies exactly `done` after a wait resume → flip to asserting
  `session.wait_completed` + a subsequent turn occurred (state, not
  phrasing).
- `parent-child-roundtrip`: one autonomous prompt requiring the model to
  execute a 5-step tool sequence IN ORDER (its own prompt warns the model
  may skip the `wait(15)`) — measured 55 s/92 s passes vs 247 s timeout
  on identical code. Drive the sequencing deterministically (one prompt
  per step) or assert on child-session state instead of the parent's
  relayed prose.

### 5. Kill-matrix trims

Boot the recovery worker once across scenarios; run scenario pairs
concurrently (distinct sessions). ~8 min → ~4 min. The remaining floor is
6 × ~30 s duroxide session-lock reclaim — removable only by the upstream
`sessionLockTimeoutMs` knob (microsoft/duroxide#38).

### 6. Fix the stale-dist hazard in `test:local`

Forked-worker suites (kill matrix, concurrent repro, lifecycle stats)
execute `dist/` while vitest runs `src/` — bare `npm run test:local` does
not rebuild, so post-edit runs can test stale workers (observed). Add the
same `npm run build &&` prefix `run-tests.sh` already has, or a cheap
freshness check.

### 7. (Selective, last) Worker reuse within big files

`session-policy-behavior` (21 tests) and friends boot workers per test.
Per-file fixtures save minutes but weaken isolation — only convert files
where tests provably don't depend on fresh workers.

## Target script structure

| Script | Contents | Budget |
|---|---|---|
| `test:local:fast` | PR gate: light pool @8 + heavy pool @2–3, minus soaks | ~5 min |
| `test:local` | Pre-deploy: everything incl. soaks, two-pool, dist rebuild | ~8–9 min |
| `test:providers` | Base full + per-provider sensitive slice | ~12 min |
| nightly | soaks (`concurrent-sessions-repro`, `chaos`), kill matrix ×N repetition | unbounded |

## Non-goals

- No reduction in the kill matrix's scenario coverage (it earns the
  protocol's lossless claim).
- No mocking of LLM turns in behavior suites — model realism is the point
  of the heavy pool; the fix for its cost is scheduling, not fakes.
