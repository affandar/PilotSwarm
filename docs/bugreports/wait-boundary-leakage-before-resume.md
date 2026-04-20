# Bug: wait boundary leaks post-wait content before resume

**Status:** Accepted limitation for now
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

For now, PilotSwarm accepts an **at-least-once delivery** contract for waits:

1. required pre-wait content must appear before the wait boundary
2. the durable timer must actually be scheduled and the turn must resume
3. required post-wait content must appear after the resume at least once
4. duplicated or early-leaked post-wait content is tolerated

The shipped regression test reflects that relaxed contract.

## Future work

If strict PRE/WAIT/POST separation becomes product-critical, continue from here:

1. investigate a runtime fix that suppresses or reclassifies post-wait text emitted in the wait turn
2. debug the `gpt-5.4-mini` session-store/dehydrate instability separately so it can be scored reliably
3. revisit model-specific or tool-specific prompting only if a runtime fix remains infeasible