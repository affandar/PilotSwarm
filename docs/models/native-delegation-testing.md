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
