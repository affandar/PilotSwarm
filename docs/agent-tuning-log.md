# PilotSwarm Agent Tuning Log

## Model Compatibility Matrix

| Model | Provider | System Agents | User Chat | Timer Interrupt | Tool Calling | Content Filter | Eval Pass Rate | Avg Time | Notes |
|-------|----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|-------|
| claude-opus-4-6 | Anthropic (BYOK) | ✅ | ✅ | ✅ | ✅ | None | **97% (174/180)** | 1175s | Tied best. Zero model-specific failures. |
| claude-sonnet-4-6 | Anthropic (BYOK) | ✅ | ✅ | ✅ | ✅ | None | **97% (174/180)** | **1164s** | Tied best & fastest. Zero model-specific failures. |
| FW-GLM-5 | Azure AI Foundry | ✅ | ✅ | ✅ | ✅ | None | **96% (173/180)** | 1237s | Reliable. Zero model-specific failures. |
| gpt-5.1-chat | Azure AI Foundry | ⚠️ | ✅ | ❌ | ✅ | Strict | 96% (173/180) | 1294s | 1 model-specific failure (session-policy sub-agent). Latency spikes. |
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
