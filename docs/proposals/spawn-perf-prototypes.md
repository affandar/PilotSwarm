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

The bottleneck is LLM inference, not the runtime. See below.

---

# LLM Inference Optimization Experiments

**Date:** 2026-03-21  
**Branch with full patches + perf reports:** `perf/llm-inference-experiments`

## Overview

Three experiments to reduce LLM inference time, which dominates spawn latency (5–9s per parent turn).

## Results (vs claude-opus-4.6 baseline)

| Exp | What | Single child visible | Same-turn fanout | Fanout child1 |
|-----|------|---------------------|------------------|---------------|
| Baseline | claude-opus-4.6, full prompt, all tools | 6,839 ms | 14,732 ms | 8,879 ms |
| **1** | Trim system prompt (987→414 words, −58%) | 6,041 ms (−12%) | 13,531 ms (−8%) | 7,236 ms (−19%) |
| **2** | Reduce tools (12→1 system tools) | 7,246 ms (+6%) | 13,197 ms (−10%) | 7,233 ms (−19%) |
| **3** | **claude-sonnet-4.6** | **5,613 ms (−18%)** | **9,213 ms (−37%)** | **5,503 ms (−38%)** |

## Key finding

**Model selection is the single biggest lever.** Switching from opus to sonnet reduces all latencies by 25–38%. Prompt trimming and tool reduction provide 5–12% marginal benefit.

## Where to find the code

```bash
git checkout perf/llm-inference-experiments
# Patches:       perf/patches/exp{1,2,3}-*.patch
# Perf reports:  perf/reports/spawn/history/
```

## Notes

- `gpt-4.1` and `gpt-4.1-mini` (via azure-openai) failed to produce spawn_agent tool calls (timed out). Possible endpoint or compatibility issue.
- Experiment 2 added `excludeSystemTools` config to `ManagedSessionConfig` — potentially useful as a general feature.
- No combined experiment (all 3 together) was run; improvements may stack partially.
