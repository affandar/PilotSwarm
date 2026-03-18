---
name: add-test
description: Add a new integration test to PilotSwarm test suite. Tests verify end-to-end flows through PilotSwarmClient, duroxide orchestration, and the Copilot SDK.
---

# Add a New Test

Integration tests live in `packages/sdk/test/local/` as individual `.test.js` files (or in subdirectories like `sub-agents/`). They require a running PostgreSQL database and a GitHub token (in `.env`). Tests use **vitest** with `describe`/`it`.

## Steps

1. **Create a new test file** in `packages/sdk/test/local/` following this pattern:

```javascript
import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertNotNull } from "../helpers/assertions.js";

const TIMEOUT = 120_000;

async function testMyFeature(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession();

        console.log("  Sending: prompt text");
        const response = await session.sendAndWait("prompt text", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assertNotNull(response, "Should get a response");
    });
}

describe.concurrent("My Feature", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("My Test Case", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("my-feature");
        try { await testMyFeature(env); } finally { await env.cleanup(); }
    });
});
```

2. **Add to the vitest config** — the file will be auto-discovered if it matches `test/local/**/*.test.js`. Ensure the vitest config includes the path.

3. **Run the test**:
```bash
cd packages/sdk
npx vitest run test/local/my-feature.test.js              # run just this file
npx vitest run test/local/my-feature.test.js -t "My Test"  # filter by test name
./scripts/run-tests.sh --suite=my-feature                  # via the runner script
```

## Patterns

- **`withClient(env, fn)`** — spins up a co-located worker + client pair, auto-forwards `setSessionConfig`. Use for most tests.
- **Manual worker/client** — for testing specific worker features (e.g., `registerTools`), create them manually outside `withClient`.
- **Tool tests** — set a `let toolCalled = false` flag, assert it's `true` after the prompt.
- **Event tests** — use `session.on()` or `session.getMessages()`, add a `setTimeout` delay for polling.
- **Timer tests** — use `waitThreshold: 0` in client opts to force durable timers even for short waits.
- **CMS validation** — use `createCatalog(env)` and `validateSessionAfterTurn(env, sessionId)` from `test/helpers/cms-helpers.js`.

## Conventions

- **No custom system prompts** — use `client.createSession()` without overriding `systemMessage`. The default agent prompt should be sufficient. If it isn't, fix the product, not the test.
- **No retries** — never add `retry` to test configs. Fix the root cause.
- Use `describe.concurrent()` for file-level parallelism within the vitest runner.
- Use `TIMEOUT` constant (120s default) for `sendAndWait`.
- Use assertion helpers from `test/helpers/assertions.js`.
- Use `describe`/`it` from `vitest`.
- Log key values with `console.log("  ...")` for debuggability.
- Each test creates its own `env` via `createTestEnv()` for schema isolation.
- If a change adds or modifies a TUI keybinding, update the startup keybinding hint/splash and the help dialog/modal at the same time, and add or update validation coverage for the affected user flow when practical.

## Key files
- `packages/sdk/test/local/` — all test files
- `packages/sdk/test/helpers/` — shared helpers (assertions, fixtures, local-env, local-workers, cms-helpers)
- `packages/sdk/vitest.config.js` — vitest configuration
- `scripts/run-tests.sh` — shell runner for all suites
