#!/usr/bin/env node

/**
 * Minimal repro: ctx.race(dequeueEvent, timer) returns empty/corrupted data
 * when the dequeue branch wins.
 *
 * Bug: When a message is enqueued to an event queue while a ctx.race() is
 * waiting on both a dequeueEvent and a timer, and the dequeue branch wins,
 * the race result's `value` field is empty/missing the message data.
 *
 * Expected: timerRace.value should contain the enqueued message data.
 * Actual: timerRace.value is empty or has no prompt field.
 *
 * Usage:
 *   node examples/repro-race-bug.js
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, Runtime, Client } = require("duroxide");

// ─── Orchestration under test ────────────────────────────────────

function* testOrchestration(ctx, input) {
    // Step 1: Set initial status
    ctx.setCustomStatus(JSON.stringify({ phase: "waiting", iteration: 0 }));

    // Step 2: Schedule a long timer (60s) and race it against dequeueEvent
    const timer = ctx.scheduleTimer(60_000);
    const dequeue = ctx.dequeueEvent("messages");
    const raceResult = yield ctx.race(timer, dequeue);

    // Step 3: Report what we got
    const winnerIndex = raceResult.index;
    const winnerValue = raceResult.value;

    let parsedValue = null;
    if (winnerValue) {
        try {
            parsedValue = typeof winnerValue === "string"
                ? JSON.parse(winnerValue) : winnerValue;
        } catch {
            parsedValue = { raw: String(winnerValue) };
        }
    }

    // Try double-parse to check for double-serialization
    let doubleParsed = null;
    if (typeof parsedValue === "string") {
        try {
            doubleParsed = JSON.parse(parsedValue);
        } catch {}
    }

    ctx.setCustomStatus(JSON.stringify({
        phase: "raceCompleted",
        winnerIndex,
        winnerValueType: typeof winnerValue,
        winnerValue,
        parsedValueType: typeof parsedValue,
        parsedValue,
        doubleParsedType: doubleParsed ? typeof doubleParsed : null,
        doubleParsed,
        promptFromSingleParse: parsedValue?.prompt || null,
        promptFromDoubleParse: doubleParsed?.prompt || null,
        iteration: 1,
    }));

    // Return the result for inspection
    return JSON.stringify({
        winnerIndex,
        winnerValueType: typeof winnerValue,
        parsedValueType: typeof parsedValue,
        doubleParsedType: doubleParsed ? typeof doubleParsed : null,
        promptFromSingleParse: parsedValue?.prompt || null,
        promptFromDoubleParse: doubleParsed?.prompt || null,
    });
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
    console.log("=== Repro: ctx.race(dequeueEvent, timer) loses message data ===\n");

    // 1. Create in-memory SQLite provider
    const provider = await SqliteProvider.inMemory();

    // 2. Create runtime + client
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10,
        logLevel: "error",
    });
    const client = new Client(provider);

    // 3. Register orchestration
    runtime.registerOrchestration("test-race", testOrchestration);

    // 4. Start runtime (non-blocking)
    const runtimePromise = runtime.start();
    runtimePromise.catch(() => {});

    // Give runtime a moment to start polling
    await sleep(500);

    // 5. Start orchestration instance
    const instanceId = "test-race-instance";
    await client.startOrchestration(instanceId, "test-race", {});
    console.log(`Started orchestration: ${instanceId}`);

    // 6. Wait for the orchestration to reach "waiting" phase
    await sleep(1000);
    let status = await client.getStatus(instanceId);
    let cs = parseCustomStatus(status);
    console.log(`Initial status: ${JSON.stringify(cs)}`);

    // 7. Enqueue a message with a known payload
    const testMessage = { prompt: "HELLO_FROM_ENQUEUE_12345" };
    console.log(`\nEnqueuing message: ${JSON.stringify(testMessage)}`);
    await client.enqueueEvent(instanceId, "messages", JSON.stringify(testMessage));

    // 8. Wait for orchestration to process the race
    console.log("Waiting for race to resolve...");
    await sleep(3000);

    // 9. Check final status
    status = await client.getStatus(instanceId);
    cs = parseCustomStatus(status);
    console.log(`\nFinal custom status: ${JSON.stringify(cs, null, 2)}`);

    // 10. Also check orchestration output
    console.log(`\nOrchestration status: ${status.status}`);
    if (status.output) {
        console.log(`Orchestration output: ${status.output}`);
    }

    // 11. Validate
    console.log("\n=== Validation ===");
    if (cs?.winnerIndex === 1) {
        console.log("✅ Dequeue branch won the race (index=1)");
    } else if (cs?.winnerIndex === 0) {
        console.log("❌ Timer branch won (index=0) — dequeue should have won");
    } else {
        console.log(`❓ Unexpected winnerIndex: ${cs?.winnerIndex}`);
    }

    if (cs?.promptFromSingleParse === "HELLO_FROM_ENQUEUE_12345") {
        console.log("✅ Message data preserved correctly with single JSON.parse()");
    } else if (cs?.promptFromDoubleParse === "HELLO_FROM_ENQUEUE_12345") {
        console.log("❌ BUG: race result is DOUBLE-SERIALIZED.");
        console.log("   winnerValue type:", cs?.winnerValueType);
        console.log("   After 1x JSON.parse() → type:", cs?.parsedValueType, "  (should be 'object', got 'string')");
        console.log("   After 2x JSON.parse() → type:", cs?.doubleParsedType, "  (this is where the data finally appears)");
        console.log("");
        console.log("   ctx.race() wraps the dequeueEvent value in an extra JSON.stringify().");
        console.log("   Callers that do `JSON.parse(raceResult.value)` get a string, not the original object.");
        console.log("   This means `parsedValue.prompt` is undefined — the data appears lost.");
    } else {
        console.log(`❌ Message data truly lost. Single parse: ${cs?.promptFromSingleParse}, Double parse: ${cs?.promptFromDoubleParse}`);
    }

    // Cleanup
    await runtime.shutdown();
    console.log("\nDone.");
    const passed = cs?.promptFromSingleParse === "HELLO_FROM_ENQUEUE_12345";
    process.exit(passed ? 0 : 1);
}

function parseCustomStatus(status) {
    if (!status?.customStatus) return null;
    try {
        return typeof status.customStatus === "string"
            ? JSON.parse(status.customStatus) : status.customStatus;
    } catch {
        return null;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
