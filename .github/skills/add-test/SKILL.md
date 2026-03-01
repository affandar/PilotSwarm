---
name: add-test
description: Add a new integration test to the durable-copilot-runtime test suite. Tests verify end-to-end flows through DurableCopilotClient, duroxide orchestration, and the Copilot SDK.
---

# Add a New Test

Integration tests live in `test/sdk.test.js` and require a running database and GitHub token.

## Steps

1. **Create the test function** following this pattern:

```javascript
async function testMyFeature() {
    console.log("\n═══ Test N: My Feature ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: "Your system prompt here. Be brief.",
            },
        });

        console.log("  Sending: prompt text");
        const response = await session.sendAndWait("prompt text", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assert(condition, "failure message");
        pass("My Feature");
    });
}
```

2. **Register in the test runner** — add to the `tests` array at the bottom of the file:
```javascript
const tests = [
    // ... existing tests ...
    ["My Feature", testMyFeature],
];
```

3. **Run the test**:
```bash
npm test -- --test=my          # filter by name (case-insensitive)
npm test                       # all tests
```

## Patterns

- **`withClient(opts, fn)`** — spins up a co-located worker + client pair, auto-forwards `setSessionConfig`. Use for most tests.
- **Manual worker/client** — for testing specific worker features (e.g., `registerTools`), create them manually outside `withClient`.
- **Tool tests** — set a `let toolCalled = false` flag, assert it's `true` after the prompt.
- **Event tests** — use `session.on()` or `session.getMessages()`, add a `setTimeout` delay for polling.
- **Timer tests** — use `waitThreshold: 0` in client opts to force durable timers even for short waits.

## Conventions

- Test names are numbered sequentially: "Test N: Descriptive Name".
- System messages use `mode: "replace"` to keep prompts deterministic.
- Use `TIMEOUT` constant (120s) for `sendAndWait`.
- `assert(condition, message)` — throws on failure.
- `pass(name)` — logs a checkmark.

## Key files
- [test/sdk.test.js](../../../test/sdk.test.js) — the test suite
