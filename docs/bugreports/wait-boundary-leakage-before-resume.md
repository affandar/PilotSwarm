# Bug: wait boundary leaks post-wait content before resume

**Status:** Partially fixed for tool side effects; assistant text leakage remains an accepted limitation
**Filed:** 2026-04-20
**Component:** `@pilotswarm/sdk` wait-tool behavior through `ManagedSession.runTurn()`
**Severity:** Medium — strict PRE/WAIT/POST phase separation is not reliable across tested models

## Symptom

When the user asks for content that should appear after a durable `wait()`, some models emit that post-wait content in the same turn as the wait call and then emit it again after the timer resumes.

Examples observed during real-wait experiments:

- `Wait 6 seconds, then reply with ZZPOSTZZ.`
- `Reply with ZZPREZZ. Then wait 6 seconds. Then reply with ZZPOSTZZ.`
- `Wait 6 seconds. After the wait, reply with ZZPOSTZZ and ZZJOKEZZ.`

In the failing cases, the post-wait tokens appeared both before and after the resume boundary.

After the 2026-05-18 runtime hardening, side-effecting tools invoked after a terminal control boundary (`wait`, `ask_user`, `wait_for_agents`, `list_sessions`, `check_agents`) are refused in the same turn. This prevents durable writes such as `store_fact` from happening both before and after the actual timer resume. The remaining accepted limitation is assistant text emitted too early; text is still governed by the at-least-once contract below.

## Findings

### Strict boundary scoring

Strict scoring required all of the following:

1. required pre-wait content appears before the resume boundary
2. forbidden post-wait content does not appear before the resume boundary
3. required post-wait content appears after the resume boundary

Exploratory real-wait results:

| Model | Baseline prompt | Hardened `c2-hard-rule` prompt |
|---|---:|---:|
| `gpt-5.4` | `0/4` | `4/4` |
| `claude-sonnet-4.6` | `0/4` | `0/4` |
| `claude-opus-4.6` | `1/4` | `2/4` |
| `gpt-5.4-mini` | blocked by session-store/dehydrate instability | blocked |

### User prompt hardening

Keeping the baseline system prompt fixed and varying only user phrasing:

- `gpt-5.4`: only minor gains from user wording, not reliable overall
- `claude-sonnet-4.6`: no meaningful gains
- `claude-opus-4.6`: strong gains from explicit two-message phrasing

## Current decision

For assistant text, PilotSwarm still accepts an **at-least-once delivery** contract for waits:

1. required pre-wait content must appear before the wait boundary
2. the durable timer must actually be scheduled and the turn must resume
3. required post-wait content must appear after the resume at least once
4. duplicated or early-leaked assistant text is tolerated

For tool side effects, the runtime now enforces a stricter contract: once a terminal control boundary is pending, later user/system side-effect tools in that same LLM turn are not executed. They must run after the durable resume instead.

The shipped wait-content regression reflects the relaxed assistant-text contract; inline control-tool tests cover the stricter side-effect block.

## Future work

If strict PRE/WAIT/POST separation becomes product-critical, continue from here:

1. investigate a runtime fix that suppresses or reclassifies post-wait text emitted in the wait turn
2. debug the `gpt-5.4-mini` session-store/dehydrate instability separately so it can be scored reliably
3. revisit model-specific or tool-specific prompting only if a runtime fix remains infeasible