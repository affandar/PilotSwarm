# Perf Agent Memory

This file is maintained by the canonical spawn perf runner and the repo-local `pilotswarm-perf` agent in [.github/agents/pilotswarm-perf.agent.md](/Users/affandar/workshop/drox/pilotswarm/.github/agents/pilotswarm-perf.agent.md).

The runner rewrites this file after every canonical spawn perf run so the latest numbers, findings, and next steps stay in-repo.

## Current Scope

- Canonical perf surface: SDK sub-agent spawn performance.
- Canonical runner: `npm run perf:spawn`
- Canonical generated outputs:
  - `perf/reports/spawn/latest.json`
  - `perf/reports/spawn/latest.md`
  - `perf/reports/spawn/history/index.json`

## Latest Confirmed Run

- Status: Passed
- Command: `npm run perf:spawn`
- Timestamp: 2026-03-21T17:27:49.153Z
- Git commit: 884a139
- Git branch: main
- Suite duration: 61720 ms
- Note: The most recent run (2026-03-22T01:45:17Z) failed because it was testing gpt-5.1 model which cannot emit spawn_agent tool calls. The baseline below is from the last successful run.

## Baseline Numbers (claude-opus-4.6, default model)

| Metric | Value |
|---|---|
| Single spawn turn | ~10,000 ms |
| Single first child visible | ~6,800 ms |
| Sequential total (3 children) | ~21,300 ms |
| Sequential turn 1 | ~9,700 ms |
| Sequential turn 2/3 avg | ~5,700 ms |
| Same-turn fanout (3 children) | ~13,400 ms |
| Fanout child1 visible | ~6,900 ms |
| Fanout visible span | ~100 ms |

## Recent Run History

- 2026-03-22T01:45:17Z | 4b4a8a1 | FAILED — gpt-5.1 model experiment (timeout, no tool calls)
- 2026-03-22T01:22:24Z | experiment | claude-sonnet-4.6: single 7600ms, seq 15034ms, fanout 9213ms
- 2026-03-22T01:01:02Z | experiment | excludeSystemTools: single 10657ms, seq 20657ms, fanout 13197ms
- 2026-03-22T00:58:22Z | experiment | trimmed prompt: single 9437ms, seq 22117ms, fanout 13531ms
- 2026-03-22T00:55:28Z | baseline | single 10522ms, seq 21328ms, fanout 14732ms
- 2026-03-21T17:27:49Z | 884a139 | single 9447ms, seq 21226ms, fanout 13404ms

## Confirmed Findings

### Runtime Prototype Investigation (branch: perf/spawn-prototypes)

Three prototypes targeting activity-level overhead:
- **Prototype A** (direct spawn, bypass ephemeral PilotSwarmClient): −12.5% single child visibility. Modest.
- **Prototype B** (parallel batch via ctx.allTyped()): Children appear simultaneously but total unchanged. Activities are already ~50ms.
- **Prototype C** (A+B combined): −12.6% single child visibility. No fanout improvement.
- **Conclusion**: Activity overhead is ~50-150ms total. Not the bottleneck.

### LLM Inference Experiments (branch: perf/llm-inference-experiments)

Three experiments targeting LLM inference time:
- **Exp 1** (trim system prompt 987→414 words): −12% single child visible, −8% fanout. Modest — prompt size not dominant.
- **Exp 2** (reduce tools 12→1 via excludeSystemTools): Marginal. Tool schemas ~370 tokens total.
- **Exp 3** (claude-sonnet-4.6 vs opus): **−18% single visible, −37% fanout, −29% sequential.** Largest win.
- **Conclusion**: Model selection is the single biggest lever (25-38% improvement).

### GPT Model Failures

- gpt-4.1, gpt-5.1 (github-copilot), gpt-4.1-mini (azure-openai): ALL timed out.
- Never emitted spawn_agent tool calls. Systematic Copilot SDK + OpenAI function calling compatibility issue.
- Only Claude models work for tool calling in PilotSwarm.

### Multi-Tool-Call Fanout Architecture

When LLM calls spawn_agent 3× in one turn:
1. **LLM inference** (~7s, 54%): generates all 3 tool calls
2. **SDK tool dispatch** (~3ms): all 3 handlers fire sequentially, accumulate in pendingActions. abort() does NOT cancel remaining handlers.
3. **Spawn activities** (~150ms, 1%): orchestration processes each spawn sequentially from pendingToolActions queue
4. **LLM confirmation response** (~5.5s, 42%): queueFollowupAndMaybeContinue triggers a full LLM round-trip just to say "all agents spawned"
5. **Total**: ~13s

### First-Spawn Cold-Start Penalty

Sequential turn 1 is ~3,500ms slower than turns 2/3 average. Includes orchestration generator initialization — duroxide-level concern.

## Active Hypotheses

- Model (TTFT) is the dominant spawn latency factor, not prompt size or tool count.
- The confirmation LLM turn after spawns (~5.5s, 42% of fanout time) could be eliminated or made synthetic.
- Orchestration replay overhead (~2-3s on first spawn) is a duroxide-level concern worth profiling.

## Next Steps

1. **Skip confirmation LLM turn**: The spawn confirmation message triggers a full LLM round-trip (~5.5s) for the model to say "all agents spawned". Could return a synthetic response instead. This is the single largest remaining optimization (~42% of fanout time).
2. **Default coordinators to sonnet-tier models**: For sessions that only dispatch (spawn + wait), use a fast model automatically.
3. **Investigate GPT model failures**: May need API version or deployment fixes for Azure OpenAI, or Copilot SDK patches for OpenAI function calling.
4. **Profile orchestration replay**: Separate duroxide generator replay time from LLM inference in the first-spawn penalty.
5. **Consider Prototype A for merge**: Clean −12% improvement on single child visibility.
6. **Combined experiment** (Exp 1+2+3 together): Quantify whether improvements stack.

## Open Questions

- Does model selection impact correctness for complex spawn patterns (nested agents, agent_name resolution)?
- Can the runtime auto-select a fast model for coordinator-only sessions?
- How much of the first-spawn penalty is orchestration replay vs LLM cold-start?
- Why do GPT models fail to produce tool calls through the Copilot SDK?

