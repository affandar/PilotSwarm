# Copilot SDK 1.0.13 / CLI 1.0.83 migration

Validation date: 2026-09-05. This upgrade ships in PilotSwarm 0.5.59.
This record describes validation, not deployment instructions.

## Cause and compatibility boundary

The recurring-agent failure `400 Unknown parameter: 'snippy'` is a model HTTP
request regression, not a timer, prompt, orchestration replay or database issue.
A strict local chat-completions endpoint reproduced the following with the real
SDK and runtime, using `gpt-5.6-terra` and a synthetic credential:

| SDK / CLI | Top-level `snippy` on BYOK request |
|---|---|
| 1.0.7 / 1.0.73 (previous repository pins) | Absent |
| 1.0.11 / 1.0.83 (CHK pair) | `{ "enabled": false }` |
| 1.0.13 / bundled 1.0.83 | `{ "enabled": false }` |
| 1.0.13 / explicit CLI 1.0.83 | `{ "enabled": false }` |

Upgrading alone therefore does **not** fix the failure. The strict endpoint
rejects this field before inference. This isolates the regression at the wire
boundary; it does not identify a source line inside the upstream native runtime.

`src/copilot-client.ts` is the shared client factory for durable sessions,
title generation, model listing and distillation. Its compatibility handler:

- Is attached only to OpenAI/Azure-compatible BYOK **completions** clients.
- Deletes only a top-level `snippy` from JSON POSTs to `/chat/completions`,
  preserving other parameters, nested tool properties, URL and credentials.
- Removes the stale content-length after changing the body.
- Does not retry, buffer model responses, or silently switch a model/provider.
- Leaves native GitHub Copilot and Anthropic/WIF clients without a handler.
  Explicit Responses-API clients also retain their native transport.

The SDK request-handler API forwards that client's model traffic through Node
fetch. This is a deliberate, narrowly scoped transport change: validate proxy,
custom-CA and cancellation behavior for a new BYOK deployment before rollout.
The session manager allocates separate native and compatibility client slots,
including when one session changes provider. Never install a process-global
fetch patch or attach this handler to a GitHub Copilot client.

Adversarial review found that vision catalog lookups also consumed client-pool
keys. They now use the same key decoder as teardown, so a transport namespace
cannot be mistaken for a GitHub credential and silently disable image support.
A regression checks the bound BYOK catalog client is reused without creating
another client.

Remove the shim only after the strict regression passes **without it** on an
upstream upgrade. Update the raw-runtime negative test at the same time; a
failure because upstream stopped leaking `snippy` is intentional removal signal.

## Packaging and migration

Both published manifest dependencies are exact pins: `@github/copilot-sdk`
`1.0.13`, `@github/copilot` `1.0.83`. SDK 1.0.13 distributes optional platform
packages containing its own runtime. Keep optional dependencies in Docker/npm
installs. Do not copy macOS node_modules into Linux images.

The factory explicitly selects `RuntimeConnection.forStdio()`, preserving
per-client credentials, environment and COPILOT_HOME instead of allowing an
ambient setting to select the experimental in-process runtime. Existing
`COPILOT_CLI_PATH` overrides still win; inspect them during rollout and verify
the actual runtime with `getStatus()`. An override pointing at a production
installation must not accidentally be inherited by a candidate smoke test.

No frozen orchestration, orchestration registry, database schema, model catalog,
credential, default model or downstream Waldemort files change in this upgrade.
No historical session records need rewriting. Disconnect and cold resume are
tested against both the low-level SDK and SessionManager.

The existing `duroxide` dependency range is unchanged. This upgrade does not
authorize downgrading that engine or its database format during rollback.

The 1.0.83 default runtime catalog also includes `web_search` and five built-in
GitHub MCP read/search tools (`get_copilot_space`, `get_file_contents`,
`list_copilot_spaces`, `search_code`, `search_users`, each prefixed
`github-mcp-server-`). This was verified through runtime metadata **after** a
first turn; a pre-turn metadata snapshot omits them. The exact-tool contract
fixture now accounts for those upstream defaults on both turns. PilotSwarm's
configured MCP grants, tool overrides and permission checks are unchanged.

## Validation matrix

The protocol tests use real SDK 1.0.13 / CLI 1.0.83 processes, with a synthetic
HTTP inference endpoint; they do not substitute fake Copilot clients.

| Provider path | Synthetic protocol | Credentialed inference |
|---|---|---|
| GitHub Copilot | Native-client isolation unit checks | PASS: GPT-6 Astra, GPT-5.6 Terra, Claude Sonnet 5 |
| `openai` | PASS, streaming on/off | PASS: Azure OpenAI GPT-5.4 via the configured OpenAI-compatible route |
| `azure` | PASS, deployment URL/api-version and streaming on/off | Not separately credentialed |
| `openai-proxy` | PASS, reasoning path and streaming on/off | No live proxy endpoint configured |
| `anthropic` | PASS, messages wire format and streaming on/off | WIF uses this native transport; no separate API-key live test |
| `anthropic-wif` | PASS, callback rotation and streaming on/off | PASS: Claude Sonnet 5 from an existing CHK T2 worker |

Each synthetic BYOK path covers an actual external tool call, usage events, a
warm follow-up, disconnect and cold resume without replaying the tool. Tests
also cover invalid JSON, unmodified unrelated requests, cancellation, upstream
errors, and OpenAI-to-Anthropic client isolation in SessionManager.

Each live model test exposes only a harmless validation-token tool, calls it
exactly once, then checks recall on a warm turn and after a new client process
resumes the session. It records first delta, total turn time and reported tokens.
No test prompts contain production session content.

### CHK WIF test safety and observed timings

The test used one existing, low-utilization T2 worker. Its Anthropic-specific
identity override selects `waldemort-identity`, not the pod's general-purpose
CSI identity. No Azure identity, federation, RBAC or deployment changes were
made. The candidate SDK tarball was freshly installed under a unique `/tmp`
directory, with an isolated COPILOT_HOME, and the production CLI path override
was removed **only from the test process environment**.

The test verified SDK 1.0.13 / CLI 1.0.83, protocol 3. Timings for this single
sample (not a load-test benchmark):

| Turn | First delta | Completion | Reported input / output tokens |
|---|---:|---:|---:|
| Tool round-trip | 2,537 ms | 2,755 ms | 7,737 / 56 |
| Warm follow-up | 825 ms | 993 ms | 3,979 / 27 |
| Cold resume | 1,094 ms | 1,358 ms | 4,062 / 27 |

The worker remained Ready with zero restarts and the same production image.
Test files were removed after collecting results. No production sessions,
schedules, databases or installed application packages were modified. This is
an isolated SDK/provider smoke test, not a Waldemort rollout or production
orchestration recovery test.

### Commands

From the repository root:

```sh
npm run build
./scripts/run-tests.sh tool-name-collisions
./scripts/run-tests.sh --all-providers
PS_MODEL_PROVIDERS_PATH="$PWD/packages/sdk/test/fixtures/model-providers.test.json" npm run test:unit --workspace=pilotswarm-sdk
npm run test:e2e --workspace=pilotswarm
npm pack --dry-run --workspace=pilotswarm-sdk --workspace=pilotswarm-horizon-store --workspace=pilotswarm
node --env-file=.env packages/sdk/test/live-copilot-providers.mjs \
  --config .model_providers.json \
  --models github-copilot:gpt-6-astra,github-copilot:gpt-5.6-terra,github-copilot:claude-sonnet-5,azure-openai:gpt-5.4 \
  --require-types github,openai --output /tmp/pilotswarm-live-results.json
```

The all-providers script runs both storage configurations (PgFactStore and
HorizonDB); that is distinct from the model-provider matrix above. The live
runner fails if a requested model or required provider type is unavailable.
Never print credentials or copy protected `.env`/catalog files into test logs.

## Rollout gate

Completed checks: build; 12 protocol/integration checks; 11 focused transport
unit checks; 712 SDK unit checks; 629 UI unit checks; tool-collision regression;
live models listed above; all three npm package inventories including READMEs;
fresh Linux x64 SDK tarball installation and native runtime start; 111 browser
tests; 149 HorizonDB provider-level integration tests; 45 targeted contract
and collision tests after updating the verified upstream tool defaults; a clean,
unfiltered baseline `./scripts/run-tests.sh` pass on the frozen candidate:
1,586 SDK integration tests passed, 14 skipped (190 files passed, 2 skipped).

The HorizonDB-backed full SDK suite subsequently passed on the frozen
candidate: 1,599 tests passed, 1 skipped (191 files passed, 1 skipped), plus
149 provider-level integration tests. Together with the clean baseline run
above, both storage configurations have now passed full validation.

Preliminary runs exposed stale UI/tool-catalog assertions and a client-key
regression; those were corrected before the successful validation above.
The last all-providers wrapper still records a failed baseline from a worker
that loaded the pre-fix source. Its subsequent HorizonDB phase passed; the
baseline was validated by the separate clean, unfiltered rerun. Therefore the
wrapper's combined result remains FAIL and must not be relabelled as PASS.

Local evidence (2026-09-05):

- Clean baseline: `/tmp/pilotswarm-copilot-migration.NWx8eA/base-frozen.log`,
  SDK JSON `/var/folders/t5/g455x6ns77d7cydlz_1qst240000gn/T/pilotswarm-run-tests-sdk.GM67Ne`.
- HorizonDB provider and SDK phase:
  `/tmp/pilotswarm-copilot-migration.NWx8eA/all-providers-verified.log`,
  SDK JSON `/var/folders/t5/g455x6ns77d7cydlz_1qst240000gn/T/pilotswarm-run-tests-all-providers.lp60FO/horizondb.sdk.json`.

Publishing or deploying requires a separate user instruction. Keep CHK
streaming configuration unchanged. No release, tag or deployment was performed.

Upstream references: [SDK 1.0.13](https://github.com/github/copilot-sdk/releases/tag/v1.0.13),
[CLI 1.0.83](https://github.com/github/copilot-cli/releases/tag/v1.0.83).
