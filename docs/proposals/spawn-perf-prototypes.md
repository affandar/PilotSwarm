# Spawn Performance Prototypes

**Date:** 2026-03-21  
**Branch with full patches + perf reports:** `perf/spawn-prototypes`

## Overview

We investigated three runtime-level optimizations to reduce sub-agent spawn latency. The prototypes targeted two overhead sources: ephemeral client lifecycle per spawn, and sequential activity execution for same-turn multi-spawn.

**Key finding:** LLM inference time (5–7s) dominates spawn latency. The combined activity-level overhead is only ~50–150ms — these optimizations provide marginal improvement.

## Prototypes

| Proto | What | Single child visible | Same-turn fanout |
|-------|------|---------------------|------------------|
| Baseline | — | 6,943 ms | 13,137 ms |
| **A** | Direct spawn (bypass ephemeral PilotSwarmClient) | **6,076 ms (−12.5%)** | 13,589 ms |
| **B** | Parallel batch via ctx.allTyped() | 7,021 ms | 13,261 ms |
| **C** | Combined A+B | **6,068 ms (−12.6%)** | 13,609 ms |

## Where to find the code

```bash
git checkout perf/spawn-prototypes
# Full writeup:  docs/proposals/spawn-perf-prototypes.md
# Patches:       perf/patches/prototype-{a,b,c}.patch
# Perf reports:  perf/reports/spawn/history/
```

## Next focus

The bottleneck is LLM inference, not the runtime. Next steps should target inference latency reduction — see perf memory for active hypotheses.
