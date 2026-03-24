# PilotSwarm Agent Tuning Log

## Model Compatibility Matrix

| Model | System Agents | User Chat | Timer Interrupt Response | Tool Calling | Content Filter | Notes |
|-------|:---:|:---:|:---:|:---:|:---:|-------|
| FW-GLM-5 | ✅ | ✅ | ✅ | ✅ | None | Current default. Reliable across all agent types. |
| gpt-5.1-chat | ⚠️ | ✅ | ❌ | ✅ | Strict (Azure default) | Tool-call bias: skips text response on timer interrupts. Content filter blocks some system agent prompts. |
| Kimi-K2.5 | ? | ? | ? | ✅ | None | Untested as default. Available on Azure AI. |
| model-router | ? | ? | ? | ? | Varies | Azure auto-router. Untested. Picks model per request. |
| claude-opus-4.6 | ? | ? | ? | ? | N/A | Via GitHub Copilot. Not tested on AKS (no direct Azure endpoint). |
| gpt-4.1 | ? | ? | ? | ? | N/A | Via GitHub Copilot. Not tested on AKS directly. |

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

### Other Options Considered (not implemented)
- **Option A (dual-action):** "You MUST do BOTH: 1. Reply with text. 2. Call wait." — Not tried, likely same result with GPT-5.1.
- **Option C (role-based):** "You are in a conversation — respond naturally." — Not tried.

## Open Questions

- Would a custom RAI content filter policy on GPT-5.1 fix the initial prompt blocking?
- Is the tool-call bias a GPT-5.1 specific issue or also present in GPT-4.1?
- Would `model-router` select GPT-5.1 for system agents and hit the same issues?
- How does Kimi-K2.5 handle timer interrupt prompts?
