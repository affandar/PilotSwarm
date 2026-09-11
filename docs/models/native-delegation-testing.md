# Native and durable delegation tests

Run from the repository root after installing dependencies:

```sh
npm run test:native-delegation
```

This credential-free suite covers policy hooks, disabled mode, real Copilot
SDK/CLI execution with scripted local inference, runtime lifecycle cleanup,
task observation, inline chat history, and the live evaluators' evidence checks.
It includes:

- Parent model/profile restrictions, background denial, child tool isolation,
  application-hook composition, stop/cancellation, and cleanup failures.
- `swarm-rubber-duck` stays unregistered and absent from prompt guidance while
  `swarm-explore` and `swarm-task` remain available when the feature is On.
- Native task writes visible to a second native task and the calling session,
  with random on-disk data and independent shell verification. Separate session
  working directories are tested separately.
- Durable consumers materialize a parent's or sibling's artifact before their
  native task hashes it. The original producer file is removed, and a false
  shared-path assumption or a checksum claim without execution fails the test.
- OFF on new, warm, and cold sessions, durable spawning while OFF, and a saved
  session changing from sync to OFF. An attempted excluded native call is rejected.
- Named-agent discovery and exact role selection; forbidden prompt overrides;
  explicit native versus durable choice; nested child assignments; quoted and
  negated instructions; mixed parent execution; and malformed tool arguments.
- Event attribution and actual file proof: a model's success claim, wrong agent,
  skipped writes, missing completion, wrong execution order, or work spanning
  multiple durable turns cannot pass the filesystem smoke verifier.

The scripted inference tests exercise actual tools and the Copilot runtime but
do not measure an LLM's routing judgment. That is a separate opt-in evaluation.

For the durable filesystem boundary, run the real-model tests from `packages/sdk`:

```sh
PILOTSWARM_LIVE_MODEL_TESTS=1 node --env-file=/path/to/private.env ../../node_modules/vitest/vitest.mjs run test/local/native-durable-filesystem.test.js
```

These use Terra/medium, the production composed prompts and artifact handlers,
separate producer/consumer workspaces, and real native shell hashing. The fixture
publishes a random binary artifact and removes its source file. It supplies the
consumer with the source report (old path plus artifact reference), without telling
the user-facing test prompt to use `read_artifact(toFile)`. Both parent and sibling
relationships are tested. This layer supplies durable-child context to an SDK
session; it does not exercise Duroxide scheduling or claim OS security isolation.
The local provider cases in the default suite validate the harness independently
of live model judgment; a correct hash with no transfer/native execution fails.

For the full local orchestration path, including an actual `spawn_agent` and child
completion, run `node scripts/smoke-durable-filesystem.mjs` against localhost3017.
In filesystem storage mode, set the portal's `ARTIFACT_DIR` to the worker's artifact
directory (`artifacts` beside its `session-state` directory); the isolated local
launcher does this explicitly. A portal upload in another directory is not a
worker-visible artifact, even if both components run on the same machine.
It uploads the root's artifact, removes the original file, asks the root to spawn
a durable child that runs native checksum work, and checks downloaded bytes,
actual native shell execution, event attribution and completed child lifecycle.
This proves transfer behavior when the producer file is unavailable on the one
local worker; cross-worker scheduling and restart durability are separate tests.

For broader native versus durable routing:

```sh
npm run build --workspace=packages/sdk
# Set GITHUB_TOKEN securely in the environment, or use node --env-file=...
npm run test:native-delegation:live -- --repeats=2 --out=.tmp/delegation-sync.json
npm run test:native-delegation:live -- --native-subagents=off --out=.tmp/delegation-off.json
# Focus on named-agent selection, with both native feature states:
npm run test:native-delegation:live -- --suite=named-selection --repeats=2 --out=.tmp/named-selection-sync.json
npm run test:native-delegation:live -- --suite=named-selection --native-subagents=off --repeats=2 --out=.tmp/named-selection-off.json
# Compare the same runtime/tool schemas with an earlier authored prompt:
npm run test:native-delegation:live -- --ref=0664a35b --out=.tmp/delegation-baseline.json
```

The 33 scenarios cover specialist fit/discovery, the original nested request,
follow-up context, short work, long-lived work, broad scale-out, shared uncommitted
files, native incompatibility, and user mechanism hints. It uses Terra at medium
reasoning by default; `--model`, `--cases=id,id`, and `--suite=named-selection`
select another model/subset. `--suite=routing` selects the original 22 routing
scenarios. The eleven named-selection scenarios cover static and
published roles, overlapping names with different source access, a caller's own
published agent, an explicitly selected shared copy shadowed by that personal
agent, another user's invisible private agent, no suitable specialist, delivery
of the concrete assignment, and an explicit request to work without delegation.
They use the production caller-visible discovery helper over synthetic loaded
definitions; no real agent packages are queried or spawned. Catalog entries
include exact spawnable names, descriptions, tools, and provenance. The same
underlying private definition is visible to its owner and absent for another
caller. Existing loader tests cover whether a published package is enabled;
these scenarios start at the already-loaded definition boundary. A self-contained
integer-analysis assignment is the strict no-specialist negative: every named
role is unrelated to its purpose. A separate source-research boundary accepts
only a generic child or the broadly described `generic-crawler`; it does not
accept arbitrary named agents. Keep this judgment case distinct from the strict
negative.
The evaluator supplies the production discovery tool to each isolated session;
worker tests separately verify its default admission to ordinary and named
sessions. These model evaluations do not exercise worker startup or publication.
The worker ceiling stays enabled in both runs; an isolated real feature cache
sets `copilot.native_tasks` on or off. Before every model call, the evaluator
asserts the resolved flag, actual session admission, and SDK native-profile
catalog. A missing cache or an ON run that silently becomes OFF fails setup.
The deterministic setup tests exercise that safeguard and fixture scope shapes.
Calls are captured before effects execute. Bounded local reads, catalog discovery,
and isolated in-memory fact bookkeeping are allowed. Each case has a 90-second
deadline. Any failing case gives a nonzero exit code.

OFF-mode expectations accept durable delegation or clarification for native-only
requests; native calls always fail. This is a capability fallback test, not a
guarantee that an explicitly native request can run unchanged while disabled.
The first decision cannot establish the eventual number of children or execution
quality. Nested assignment scoring is a conservative prose heuristic; manually
inspect its failures. Follow-up context is supplied as a summary. Catalogs are
synthetic role-selection fixtures, not a copy of production agents. The model
chooses the route and named role; handoff tests separately validate execution
after selection. The grader accepts `agent_name` plus a concrete `task`, rejects
named `system_message`/`tool_names` overrides and the removed `required_tool`
selector, and rejects fabricated or caller-inaccessible agent names. A passing
repeat is evidence for the tested prompts, not a guarantee of every model choice.

### Validation: 2026-09-10

Live evaluation used `gpt-5.6-terra`, medium reasoning, with real native feature
policy and SDK profile assertions before every decision:

| Coverage | Results |
| --- | --- |
| Ten strict named-selection, generic-fallback, and direct-work scenarios; two repeats in each mode | 40/40 |
| One documented source-research judgment boundary; two repeats in each mode | 4/4 |
| Original 22 routing scenarios; one repeat in each mode | 44/44 |
| Deterministic scorer, setup safeguards, and fixture-scope checks | 89/89 |

The earlier strict named suite scored **39/40**: one OFF-mode trial chose
`generic-crawler` for a one-off font-license comparison. Independent review
found this plausible under the catalog's broad source-crawling description,
although a generic researcher was preferred. That original result remains in
`.tmp/named-selection-final-off.json`; it was not erased or called a passing
strict trial. The case became the explicitly bounded judgment scenario, and a
separate fully specified integer-analysis job now tests strict generic fallback.
No production prompt changes followed that review.

Final named evidence is in `.tmp/named-selection-validated-sync.json` and
`.tmp/named-selection-validated-off.json`. These are explicit evidence assemblies,
not fresh full inference runs: unchanged scenarios retain their original
decisions; the changed boundary and new strict case use fresh two-repeat runs.
Assembly verifies whole-scenario equality, authored prompt hashes, runtime and
catalog hashes, native admission, and SDK profiles, then regrades every record.
Each row identifies its original report and SHA256. Broader routing is recorded
in `.tmp/delegation-routing-final-{sync,off}.json`.

Final authored/grading source SHA256s:

| Source | SHA256 |
| --- | --- |
| Base prompt body | `b2c92cca84b9855f2f8c01fa25525cbe3ddbaa8e24dd14d7abea51345089b29c` |
| Native guidance | `86136b1a2e604a7480d4eb90ad79798d93d94009a3ddf148177285c0fc32a30e` |
| Catalog fixture helper | `70da12f79ae4f2f311f2cdb77a9719e3f87cec4078c5576517b1191f74659ce9` |
| Scenario fixtures | `d25af36f619feccbf825703175318969a5e64a306e4bcd870e4bba2fb793c275` |
| Decision scorer | `cc6b3d3ed466f526b950c2fad6d127d02192bd6448d466c0506680b19db58725` |

An earlier evaluator defect set only the worker ceiling, leaving its missing
feature cache to disable native tasks in both modes. Those preliminary runs are
excluded above. The setup safeguard now rejects that condition before inference.
Another initial fixture promised future CSV artifacts; it was clarified with
complete inline inputs so that asking for missing files would not be misgraded
as a role-selection failure.

For actual durable orchestration plus native filesystem execution, start the
localhost deployment with `PILOTSWARM_NATIVE_SUBAGENTS=sync`, then run:

```sh
npm run test:native-filesystem:live -- --url=http://127.0.0.1:3017
```

This creates one visible parent and one durable child. The child creates a random
file, delegates two sequential native tasks that read/write it, then independently
verifies the resulting file and cwd in its own shell. The parent closes the child.
The runner checks tool and lifecycle events, distinct native identities, a single
durable child turn, and on-disk proof. It provisions only an empty scratch directory
and probe program; the parent session performs no filesystem work. The script
leaves completed sessions and `.tmp/native-filesystem-*/result.json` for inspection.
On failure it cancels only its own test tree. It requires a single localhost worker
with this checkout; it does not claim that separate durable sessions share files,
that files survive restarts, or that concurrent writes to the same file are safe.
