# Judge Clients

The eval-harness ships three `JudgeClient` implementations: two production-ready
live clients and a deterministic fake for unit tests. Pick based on credentials
and use case.

## At a glance

| Client                  | Credentials needed                | Providers reached                                  |
| ----------------------- | --------------------------------- | -------------------------------------------------- |
| `OpenAIJudgeClient`     | `OPENAI_API_KEY` (or compatible)  | OpenAI public API or any OpenAI-compatible base URL |
| `PilotSwarmJudgeClient` | A configured `ModelProviderRegistry` — any creds the registry knows about: `GITHUB_TOKEN` (Copilot), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_API_KEY`+endpoint, etc. | Every provider PilotSwarm itself supports — same matrix the runtime exposes |
| `FakeJudgeClient`       | none — scripted scenarios         | none (test-only; not for production)                |

All three implement the same `JudgeClient` interface (`judge`, `cacheIdentity`,
optional `estimateCost` / `dispose`), so any code consuming a judge —
`LLMJudgeGrader`, the live test gates, the shared judge cache — works
unchanged whichever you pick.

## When to use each

### Use `OpenAIJudgeClient` when

- You have a direct `OPENAI_API_KEY` (or an OpenAI-compatible gateway) and
  want the lowest-latency one-call-per-judge path.
- You need fine-grained control over OpenAI-specific knobs (`response_format`,
  `temperature`, `Retry-After` honoring, separate `cachedInput` rates).
- You are running CI in an environment where the `@github/copilot-sdk` runtime
  and a Copilot session are unnecessary overhead.

### Use `PilotSwarmJudgeClient` when

- You want the judge to inherit the **same provider matrix** PilotSwarm
  itself uses. Whatever providers `.model_providers.json` configures — GitHub
  Copilot, OpenAI, Anthropic, Azure OpenAI, an OpenAI-compatible gateway,
  whatever's wired — becomes a valid judge target with no new client code.
  Adding a provider to PilotSwarm automatically adds it as a judge route.
- The test environment has `GITHUB_TOKEN` and no separate `OPENAI_API_KEY`.
  This is the default PilotSwarm dev setup; the judge runs free against
  Copilot without exporting another credential. **But this is just one
  configuration** — the same client works equally well with Anthropic,
  Azure, etc.
- You want the judge to talk to the same provider/model that production
  PilotSwarm sessions use, so judge calibration drift cannot diverge from
  worker behavior.
- You're standardizing on PilotSwarm's provider abstraction (cost
  accounting, retry policy, transport) and want the judge under the same
  umbrella.

## Selection in tests

`test/helpers/judge-client-helper.ts` exposes `makeLiveJudgeClient()` which
returns the right client (or `null` if neither set of credentials is
configured, OR if the registry-routed judge has no cost rates available).
Live-judge tests (`safety-live.test.ts`, `llm-judge-live.test.ts`) call this
helper:

```ts
const sel = makeLiveJudgeClient();
// FAIL LOUD if neither credential set is configured or cost rates are
// missing — silently skipping under LIVE_JUDGE=1 would mask a config bug.
expect(sel, "no judge credentials or cost rates available").toBeTruthy();
const client = sel!.client;
```

Selection precedence:

1. `OPENAI_API_KEY` set → `OpenAIJudgeClient` (kind: `"openai"`). Strict
   precedence: even if `GITHUB_TOKEN` is also set, `OpenAIJudgeClient` wins.
   No fallback after construction — if `OPENAI_API_KEY` is set but invalid,
   the test will fail loudly with the OpenAI API error rather than fall back
   to the registry-routed path.
2. `PS_MODEL_PROVIDERS_PATH` (or `MODEL_PROVIDERS_PATH`) resolves to a real
   `.model_providers.json` AND that file references at least one credential
   the current process can resolve → `PilotSwarmJudgeClient`
   (kind: `"pilotswarm"`). Typically that credential is `GITHUB_TOKEN`, but
   any provider entry whose `*_API_KEY` env or equivalent is populated will
   work — the registry decides at construction time.
3. Neither path resolves → `null`.

The test harness still gates execution on `LIVE=1 LIVE_JUDGE=1`. The helper
only decides *which* client to construct, never *whether* judge tests run.

### Cost rates contract for the registry-routed path

`LLMJudgeGrader` budgets fail closed when cost is unknown. The
`PilotSwarmJudgeClient` therefore must carry `costRates` in any budgeted
test. The helper resolves cost rates in this order:

1. **Env override** (highest priority):
   - To opt in, set `LIVE_JUDGE_INPUT_USD_PER_M` AND
     `LIVE_JUDGE_OUTPUT_USD_PER_M`. Both must be non-negative finite numbers.
   - `LIVE_JUDGE_CACHED_INPUT_USD_PER_M` is optional; when set it is also
     validated as a non-negative finite number.
   - **Partial env override fails LOUD.** If any of the three vars is set
     but `INPUT` and `OUTPUT` are not BOTH present, `makeLiveJudgeClient()`
     throws an `Error` with a clear message. This prevents an operator's
     override from being silently ignored and falling back to baked-in
     rates — a bug that would undermine budget enforcement transparency.
   - **Invalid env values fail LOUD.** NaN, negative, infinite values
     throw — they are not silently treated as "unset" or clamped.
2. **Per-model defaults** baked into `test/helpers/judge-client-helper.ts`
   (`KNOWN_MODEL_COST_RATES`). Currently covers only the qualified GitHub
   Copilot variants:
   - `github-copilot:gpt-4.1`
   - `github-copilot:gpt-4.1-mini`
   - `github-copilot:gpt-4o`
   - `github-copilot:gpt-4o-mini`

   Bare names (`gpt-4.1`, `gpt-4o`, …) do **not** match the map keys —
   only the qualified `github-copilot:` form is recognized. Newer models
   (`gpt-5.4`, `gpt-5.5`, `claude-opus-4.7`, …) have no baked-in defaults;
   tests that judge with them must set the `LIVE_JUDGE_INPUT_USD_PER_M`
   / `LIVE_JUDGE_OUTPUT_USD_PER_M` env vars explicitly.

   ⚠ Token-availability caveat: not every model in the baked-in map is
   actually accessible to every `GITHUB_TOKEN`. As of writing,
   `gpt-4o-mini`, `gpt-4.1-mini`, and `gpt-4o` route to "model not
   supported" / 403 on the standard Copilot integration. Probe with
   `curl -H "Authorization: Bearer $GITHUB_TOKEN" -H "Copilot-Integration-Id: vscode-chat"
   https://api.githubcopilot.com/chat/completions -d '{"model":"<m>",…}'`
   before relying on any default.
3. **Fail loud** otherwise: if the chosen model has no defaults and no env
   override, `makeLiveJudgeClient()` returns `null` AND writes a stderr
   explainer pointing at the env vars. The test then fails the
   `expect(sel).toBeTruthy()` assertion with a clear message.

This avoids the silent-infraError trap — a budgeted live test with the
registry-routed judge but no cost rates would otherwise return
`infraError` for every grade and the test would still claim "judge
unavailable" semantics.

## Behavior contract — both clients

Both clients honor the same hard rules:

- **Fail closed on parse errors.** If the model returns text that is not
  valid JSON conforming to `JudgeResultSchema`, the client throws a typed
  `JudgeOutputFormatError`. It will *never* return a synthetic pass.
  `LLMJudgeGrader` catches this distinct from generic client failures
  and records it as a non-infra failing `Score` (`pass: false,
  infraError: false`) — quality signal about the judge model itself,
  not an infrastructure outage. Generic `Error`s from the client (network
  failure, auth, transport) still surface as `infraError: true`.
- **Retry only transient errors.** Network errors, 5xx, rate-limits, and
  upstream session errors are retried with exponential backoff.
  `JudgeOutputFormatError` is sticky — bad JSON or schema mismatch is
  not retried.
- **Stop the underlying client/socket in `finally`.** Even on timeout or
  abort, no underlying `CopilotClient` or fetch handle is leaked.
- **Caller AbortSignal is honored.** Aborting cancels the in-flight call
  and prevents further retries.
- **Stable `cacheIdentity()`.** The same model + temperature + response
  format produces the same identity hash, so judge-cache reuse is safe.
  Different models *must* yield different identities to avoid cache
  poisoning.

## Configuration tips

For `PilotSwarmJudgeClient`, the model reference accepts either the bare
name (`gpt-4.1`) or the qualified form (`github-copilot:gpt-4.1`). The
qualified form is preferred when the registry has the same bare name in
multiple providers — it removes ambiguity. Note that **cost-rate lookup
matches only on the qualified form**; bare-name resolutions still need
explicit `LIVE_JUDGE_INPUT/OUTPUT_USD_PER_M` env vars.

Default judge model selection:

| env var | scope | default if unset |
|---------|-------|------------------|
| `LIVE_JUDGE_MODEL` | helper-resolved single-judge tests | `gpt-4o-mini` (currently inaccessible to most tokens — set explicitly) |
| `LIVE_JUDGE_MODEL_A` | cross-judge agreement test, model A | `gpt-4o-mini` (OpenAI path) / `github-copilot:gpt-4.1` (PilotSwarm path) |
| `LIVE_JUDGE_MODEL_B` | cross-judge agreement test, model B | `gpt-4o` (OpenAI path) / `github-copilot:claude-sonnet-4.6` (PilotSwarm path) |

Recommended overrides as of the latest Copilot model catalog
(`api.githubcopilot.com/models`): `github-copilot:gpt-5.4` for primary
judge, `github-copilot:claude-opus-4.7` for cross-judge. Both confirmed
callable on the standard token. `gpt-5.5` is callable via the
`/responses` endpoint only — works through PilotSwarm's auto-routing
but won't appear via direct `/chat/completions` curl.
