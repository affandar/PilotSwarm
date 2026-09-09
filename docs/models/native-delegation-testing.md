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
do not measure an LLM's routing judgment. That is a separate opt-in evaluation:

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
# Compare the same runtime/tool schemas with an earlier authored prompt:
npm run test:native-delegation:live -- --ref=0664a35b --out=.tmp/delegation-baseline.json
```

The 22 scenarios cover specialist fit/discovery, the original nested request,
follow-up context, short work, long-lived work, broad scale-out, shared uncommitted
files, native incompatibility, and user mechanism hints. It uses Terra at medium
reasoning by default; `--model` and `--cases=id,id` select another model/subset.
Calls are captured before effects execute. Bounded local reads, catalog discovery,
and isolated in-memory fact bookkeeping are allowed. Each case has a 90-second
deadline. Any failing case gives a nonzero exit code.

OFF-mode expectations accept durable delegation or clarification for native-only
requests; native calls always fail. This is a capability fallback test, not a
guarantee that an explicitly native request can run unchanged while disabled.
The first decision cannot establish the eventual number of children or execution
quality. Nested assignment scoring is a conservative prose heuristic; manually
inspect its failures. Follow-up context is supplied as a summary. The fixed named
catalog represents this localhost deployment, not every deployment's agents.

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
