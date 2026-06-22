# PilotSwarm Agent Tuning Log

## Model Compatibility Matrix

| Model | Provider | System Agents | User Chat | Timer Interrupt | Tool Calling | Content Filter | Eval Pass Rate | Avg Time | Notes |
|-------|----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|-------|
| claude-opus-4-6 | Anthropic (BYOK) | ✅ | ✅ | ✅ | ✅ | None | **97% (174/180)** | 1175s | Tied best. Zero model-specific failures. |
| claude-sonnet-4-6 | Anthropic (BYOK) | ✅ | ✅ | ✅ | ✅ | None | **97% (174/180)** | **1164s** | Tied best & fastest. Zero model-specific failures. |
| FW-GLM-5 | Azure AI Foundry | ✅ | ✅ | ✅ | ✅ | None | **96% (173/180)** | 1237s | Reliable. Zero model-specific failures. |
| gpt-5.1-chat | Azure AI Foundry | ⚠️ | ✅ | ❌ | ✅ | Strict | 96% (173/180) | 1294s | 1 model-specific failure (session-policy sub-agent). Latency spikes. |
| gpt-5.5 | GitHub Copilot | ? | ✅ | ? | ? | None observed in smoke | Smoke only | ~4s | 2026-05-01: Direct Copilot SDK streaming and PilotSwarm full-stack smoke both returned `PONG`; model is available via SDK and registered in `.model_providers*.json`. Full matrix not yet run. |
| model-router | Azure AI Foundry | ⚠️ | ✅ | ? | ✅ | Varies | 94% (170/180) | 1443s | 2 multi-worker failures. Slowest. |
| Kimi-K2.5 | Azure AI Foundry | ⚠️ | ✅ | ? | ✅ | None | **93% (167/180)** | 1446s | 4 model-specific failures (multi-worker, policy). Slowest. |

### Eval Details (2026-03-24)
- **Suites**: 14 (smoke-basic, smoke-api, commands-user, management, durability, contracts, cms-events, cms-state, kv-transport, model-selection, session-policy-guards, session-policy-behavior, multi-worker, facts)
- **Runs**: 2 per model per suite
- **Total executions**: 2,160 (180 tests × 2 runs × 6 models)
- **Universal failures** (all models, test/product bugs): contracts "LLM Sees Exact Always-On Tool" 0%, model-selection "Model Recorded in CMS After Turn" 0%, model-selection "Different Models on Same Worker" 0%
- **Model-specific failures**: Kimi-K2.5 (multi-worker stale session tests 0%, policy title preserved 0%), model-router (same multi-worker tests 0%), gpt-5.1-chat (sub-agent blocking flaky 50%)
- Full report: [`docs/models/eval-2026-03-24.md`](models/eval-2026-03-24.md)

## Known Model Quirks

### gpt-5.1-chat (Azure OpenAI)
- **Timer interrupt text suppression**: When a user message interrupts a durable timer, GPT-5.1 responds with ONLY tool calls (e.g. `wait(110)`) and no text output. The user sees no response. Multiple prompt hardening attempts failed to fix this.
- **Content filter**: Uses Azure's default content filter policy (no custom RAI policy attached). Blocked some system agent initial prompts. Needs a custom permissive content filter policy in Azure AI Foundry.
- **Tool-call bias**: Strongly prefers calling tools over generating text when both are appropriate. This is model-level behavior, not a prompt issue.

### FW-GLM-5 (Azure AI DataZoneStandard)
- No known issues. Reliably follows prompt instructions including "respond to user first, then call wait."
- Handles rehydration context and timer interrupt prompts correctly.
- 100K TPM deployment.

## Prompt Hardening History

### Timer Interrupt Prompt (orchestration.ts)

**Original prompt:**
```
Your timer was interrupted by a USER MESSAGE. You MUST respond to the user's message below before doing anything else.
Timer context: {seconds}s timer (reason: "{reason}"), {elapsed}s elapsed, {remaining}s remain.
After fully addressing the user's message, resume the wait for the remaining {remaining} seconds.
```

**Problem:** GPT-5.1 interprets "address" and "respond" as "handle the request" — which for system agents means calling tools. No text output produced.

**Hardened prompt (Option B — 2026-03-23):**
```
Your timer was interrupted by a USER MESSAGE.
RESPONSE FORMAT: You MUST first output a text response addressing the user's message.
Then call wait({remaining}) to resume your timer.
IMPORTANT: A turn that calls wait() without any preceding text output is WRONG.
The user is waiting to see your reply. Always write text first, then call wait.
Timer context: {seconds}s timer (reason: "{reason}"), {elapsed}s elapsed, {remaining}s remain.
```

**Result with GPT-5.1:** Still did not produce text output. The model's tool-call bias overrides even explicit format instructions. This appears to be a model-level behavior that prompt engineering cannot fix.

**Result with FW-GLM-5:** Works correctly with both original and hardened prompts. The hardened prompt is kept as defense-in-depth.

- 2026-03-26: Hardened the default agent and sub-agent skill prompts so models, including GPT-5.4-mini, are told explicitly that they can start indefinite recurring durable loops in the current turn, can delegate recurring work to sub-agents, and can send follow-up instructions to running sub-agents with `message_agent`. Added a regression test that asks for a recurring sub-agent loop, rejects "need another prompt/nudge" disclaimers, and verifies a child session enters a waiting state.

- 2026-04-15: Azure OpenAI `gpt-5.4` filtered the Resource Manager system agent at turn 0 with `Execution failed: 400 The response was filtered due to the prompt triggering Azure OpenAI's content management policy.` The likely trigger was violent or aggressive wording in the bootstrap prompt and exposed tool descriptions, especially `killing a stuck session`, plus permanence phrasing like `run FOREVER` / `run eternally`. Softened `packages/sdk/plugins/mgmt/agents/resourcemgr.agent.md` and `packages/sdk/src/resourcemgr-tools.ts` to use neutral monitoring language (`long-running`, `unresponsive`, `stop`, `unreferenced blobs`, `0 running pods available`). This is a prompt-hardening mitigation, not proof that Azure's content filter is fully solved.

- 2026-04-29: Hardened the default base agent prompt to explicitly close task-scoped sub-agents with `complete_agent` once their assigned task is done and no further conversation with that child is needed. Follow-up adjustment: the rule now explicitly defers when active user/task instructions say to keep the child alive, send follow-ups, or not call `complete_agent`, so keep-alive and parent-child roundtrip workflows can intentionally hold children open. Expected behavior: parents harvest/summarize the child result, then promptly complete the child unless the current task requires keeping it alive. Not model-specific; no compatibility-matrix change.

- 2026-04-29: Clarified the default facts prompt after spawn-tree visibility broadened. Session-scoped facts are now described as readable by the whole spawn tree, and `shared=true` is reserved for facts that must persist across unrelated sessions/spawn trees. Expected behavior: peer agents use session-scoped facts for intra-tree handoffs instead of overusing global shared facts. Not model-specific; no compatibility-matrix change.

- 2026-05-01: Extended default sub-agent model-selection guidance so agents know `list_available_models` now advertises supported/default reasoning efforts and `spawn_agent(reasoning_effort=...)` can select the child session's reasoning power. Expected behavior: agents use exact listed `provider:model` values and exact listed reasoning efforts, preferring the model default unless deeper reasoning is needed or requested. Not model-specific; no compatibility-matrix change.

- 2026-05-16: Updated base coordination/system-agent prompts for group/summary/cross-session coordination and low-frequency/reactive system scheduling. Root PilotSwarm and Resource Manager no longer maintain recurring cron loops; Sweeper and Facts Manager use 6-hour maintenance cron, and Facts Manager wakes reactively on shared `intake/*` writes. Expected behavior: fewer polling turns while preserving maintenance coverage. Not model-specific; no compatibility-matrix change.

- 2026-05-17: Added default prompt guidance for `cron_at` wall-clock schedules and child contract `wakeOn` policies. Expected behavior: agents use `cron` for fixed intervals, `cron_at` for calendar anchors/one-shot scheduled-at-time work, avoid wake-and-check polling loops, and choose quieter watcher children with `wakeOn: "material_change"` by default. Helper/tool tests passed; not model-specific.

- 2026-05-18: Hardened default prompt and tool descriptions after AKS `gpt-5.4-mini` sessions misunderstood `update_session_summary`, cross-session replies, and child contracts. Added exact `summary_state` object shape, emphasized automatic summary updates only for notable changes, made cross-session requests explicitly require `reply_session_message`, and clarified that `contract` is a named `spawn_agent` argument. Expected behavior: mini models pass structured summary objects, deliver peer answers through the reply tool, and specify child contracts without looking for a separate signature/tool. Not model-specific; helper/contract tests added.

- 2026-05-18: Investigated AKS `gpt-5.4-mini` timed sub-agent run where children called `wait(60)` but then wrote later-minute `store_fact` values before the durable resume, causing duplicate/early outputs. Added runtime guard in `ManagedSession` so user/system side-effect tools are refused after terminal control boundaries (`wait`, `ask_user`, `wait_for_agents`, `list_sessions`, `check_agents`) in the same LLM turn. Expected behavior: post-wait facts/artifacts/session updates happen only after the durable resume; assistant text remains covered by the existing at-least-once wait-content contract.

- 2026-05-18: After deploying the wait-boundary guard, an AKS `gpt-5.4-mini` timer workflow hit Azure's `400 Invalid value for 'content': expected a string, got null` on repeated hydrated retries. The failure behaves like a corrupted Copilot transcript, likely from a tool-only assistant turn with null content. Expanded the existing corrupted-transcript recovery path to treat this error as recoverable: reset stored Copilot session state and replay the pending turn once with a lossy recovery notice.

- 2026-05-18: Observed an AKS `gpt-5.4-mini` wall-clock `cron_at` wake resume by acknowledging that the financial-news schedule was active instead of doing the scheduled news summary. Hardened the default prompt and durable-timers skill so cron/cron_at wake-ups must perform the scheduled work immediately before responding. Also hardened summary guidance: any tangible progress toward the user's goal, including useful cross-session replies or delivered outputs, must call `update_session_summary` in the same turn.

- 2026-05-19: Tuned default summary guidance so `update_session_summary` stays concise and scannable, uses compact bullets or short Markdown tables for structured progress/comparisons/rankings/decisions/result sets, and avoids long transcripts, raw logs, or bulky JSON in summary fields. Expected behavior: Summary tab content carries structure without becoming transcript-sized. Not model-specific; helper/contract tests updated.

- 2026-06-20: Tightened the sub-agent lifecycle test fixture agents after the default model sometimes closed an `echoer` child despite the test prompt saying not to call close tools. Added `schemaVersion`/`version` frontmatter and explicit lifecycle-coordinator guidance to leave children alive unless the current user message asks for `complete_agent`, `cancel_agent`, or `delete_agent`. Expected behavior: keep-alive lifecycle regression test exercises runtime behavior without prompt ambiguity. Not model-specific; `keep-alive-after-task` passed standalone.

- 2026-06-21: Added graph namespace-registry guidance to the base graph prompt, Facts Manager, Agent Tuner, graph-debug skill, builder harvester skill, and Horizon Harvester sample agents. Expected behavior: agents first discover relevant graph corpora with `graph_list_namespaces`/frontmatter when available, use `graph_get_namespace` lazily for details, keep `facts_search` mode selection separate from graph discovery, and use namespace filters consistently across facts and graph tools. Bumped affected PilotSwarm-authored agent versions (facts-manager 1.7.0, agent-tuner 1.2.0; sample harvester 1.4.0, librarian 1.1.0). Not model-specific; SDK graph-tool gating tests passed.

- 2026-06-21: Added count-only retrieval usage diagnostics to Agent Tuner and graph-debug guidance. Agent Tuner now starts facts/skills/graph investigations with `read_session_retrieval_usage`, `read_session_tree_retrieval_usage`, graph node/edge usage aggregates, and fleet retrieval summaries before falling back to raw `read_session_graph_searches` timelines. Bumped `packages/sdk/plugins/mgmt/agents/agent-tuner.agent.md` to 1.3.0. Expected behavior: retrieval investigations use aggregate counts first and avoid implying returned facts/nodes/edges are persisted in telemetry. Not model-specific; `retrieval-usage`, `agent-tuner`, and `contracts` suites passed.

### Other Options Considered (not implemented)
- **Option A (dual-action):** "You MUST do BOTH: 1. Reply with text. 2. Call wait." — Not tried, likely same result with GPT-5.1.
- **Option C (role-based):** "You are in a conversation — respond naturally." — Not tried.

## Open Questions

- Would a custom RAI content filter policy on GPT-5.1 fix the initial prompt blocking?
- Is the tool-call bias a GPT-5.1 specific issue or also present in GPT-4.1?
- ~~Would `model-router` select GPT-5.1 for system agents and hit the same issues?~~ **Answered 2026-03-24**: model-router has its own multi-worker issues (67% pass rate on multi-worker).
- ~~How does Kimi-K2.5 handle timer interrupt prompts?~~ **Partially answered 2026-03-24**: Kimi passes basic tests but has multi-worker and policy failures. Timer interrupt not specifically tested yet.
- Why do Kimi-K2.5 and model-router fail the "Turn 0 Resets Stale Stored Session" and "Turn 1+ Fails Without Stored" multi-worker tests?
- Anthropic models (Opus/Sonnet 4.6) are now available via direct BYOK API — should these become the default for AKS deployments?
