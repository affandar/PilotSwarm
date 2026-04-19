---
name: cost-latency-analysis
description: |
  How to compute model latency and estimated $ cost from PilotSwarm
  observability data. Read this before reporting that a model is
  "slow" or "expensive" — most apparent slowness is orchestration
  overhead, not model inference, and most cost numbers are guesses
  unless they reference a real published price card.
---

# Cost & Latency Analysis

You are the **agent-tuner**. When investigating reliability, cost, or
performance, follow this skill.

## Latency: prefer `assistant.usage.duration`

PilotSwarm records two different "durations" per turn. Do not confuse
them:

| Source                                    | What it measures                                                                                       | When to use                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `runTurn` activity span (execution history) | Total wall-clock time the activity ran, including dehydrate, hydrate, snapshot, blob I/O, scheduling. | Operator-facing "how long did this turn take end-to-end". Useful for orchestration-overhead investigations.                    |
| `assistant.usage.duration` (assistant event)  | Time spent **inside the model call itself** as reported by the LLM provider.                          | **Model-latency comparisons.** The only fair number to use when comparing models, providers, or context sizes.                 |

`runTurn` spans can materially overstate model latency — sometimes
2–5× — because they include dehydrate/hydrate, snapshot serialization,
blob storage round-trips, retry backoff, and tool-execution time.

**Rule of thumb:**

- Comparing "is gpt-5.4 slower than gpt-5.4-mini?" → use
  `assistant.usage.duration`.
- Investigating "why does this turn take 30 seconds?" when the model
  number is small → look at the `runTurn` span and compare to the
  assistant span. The delta is the orchestration overhead.

### Where to read it from

- Per-turn: `read_agent_events` filtered to `event_types: ["assistant"]`,
  then read `usage.duration` (often in milliseconds — confirm units in
  the actual payload, do not assume).
- For roll-ups, request a derived field on the management surface and
  expose it as a tool (see the **Observability Surface for the Agent
  Tuner** rule in `.github/copilot-instructions.md`). Do not summarize
  latency by averaging `runTurn` spans — it will mislead.

## Cost: estimate, do not guess

Token counts come from `read_session_metric_summary` /
`read_fleet_stats` and are reliable. **Per-token prices change
constantly** and do not live in PilotSwarm. Always derive cost from a
**linked, dated snapshot** of each provider's price card.

Default approach:

1. Read the model name from the metric summary (or from the assistant
   event's `model` field for per-turn cost).
2. Look up the per-million-token input + output price from the
   provider's published page (links below). Note the date you looked
   it up.
3. Cost = (`tokens_input` × $/M-input + `tokens_output` × $/M-output)
   ÷ 1,000,000.
4. If the model offers prompt caching (Claude, GPT-5.4 family), apply
   the discounted cache-read rate to `tokens_cache_read`. Cache writes
   are often billed at standard input rate.
5. Report the price source and date alongside the dollar figure.

### Stable price-card sources

These are the canonical pages to consult. Do not invent or memoize
numbers — re-fetch on each report.

- **OpenAI (direct API):**
  https://openai.com/api/pricing/
- **Azure OpenAI Service (per-region pricing):**
  https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/
  (Azure OpenAI prices follow OpenAI list prices closely but are
  region-specific and may differ for provisioned-throughput SKUs.)
- **Azure AI Foundry / model catalog (third-party models on Azure):**
  https://azure.microsoft.com/en-us/pricing/details/phi-3/
  https://ai.azure.com/explore/models — open the specific model page
  for its price card. Foundry-hosted models (FW-GLM-5, Kimi-K2.5, etc.)
  use the per-deployment price shown on their model card.
- **Anthropic (direct API):**
  https://www.anthropic.com/pricing#api
- **GitHub Copilot:** Copilot does not bill per token to the end user;
  it bills per seat (Copilot Business / Enterprise) and surfaces a
  **premium-request quota** for premium models (Opus, GPT-5 class).
  Do not report per-token dollar cost for `github-copilot:*` sessions.
  Report **premium requests consumed** when known and link to the
  current quota page:
  https://docs.github.com/en/copilot/managing-copilot/managing-copilot-as-an-individual-subscriber/about-billing-for-github-copilot

### Example

```
session: 22013ffb
model:   azure-openai:gpt-5.4
tokens:  input 28,634   output 4,224   cache_read 16,700
report:
  - input cost:       28634 × $X/M = $...
  - output cost:      4224  × $Y/M = $...
  - cache-read cost:  16700 × $Z/M = $...
  total ≈ $0.0XX  (price source: openai.com/api/pricing, fetched <date>)
```

## What to never do

- Never quote a per-token dollar cost without naming the price source
  and the date you fetched it.
- Never compare model latency using `runTurn` spans alone.
- Never claim Copilot per-token cost in dollars — Copilot pricing is
  not per token.
- Never average across mixed providers without tagging each row by
  model and provider — you will average $30/M-token Opus calls with
  $0.10/M-token nano calls and report a number that is meaningless.
