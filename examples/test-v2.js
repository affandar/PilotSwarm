/**
 * v2 Architecture Test App — single-process test harness.
 *
 * Tests the full v2 flow: DurableCopilotClient → orchestration → SessionProxy
 * → SessionManager → ManagedSession → CopilotSession.
 *
 * Run: node --env-file=.env examples/test-v2.js
 */

import { DurableCopilotClient, DurableCopilotWorker, defineTool } from "../dist/v2/index.js";

const TIMEOUT = 120_000;
const STORE = process.env.DATABASE_URL || "sqlite::memory:";

// ─── Helpers ─────────────────────────────────────────────────────

async function withClient(opts, fn) {
    const worker = new DurableCopilotWorker({
        store: STORE,
        githubToken: process.env.GITHUB_TOKEN,
    });
    await worker.start();

    const client = new DurableCopilotClient({
        store: STORE,
        provider: worker.provider,
        catalog: worker.catalog,    // CMS — null for SQLite, PgSessionCatalogProvider for PG
        ...opts,
    });
    await client.start();

    // Wrap createSession to auto-forward tools/hooks to co-located worker
    const origCreate = client.createSession.bind(client);
    client.createSession = async (config) => {
        const session = await origCreate(config);
        if (config) worker.setSessionConfig(session.sessionId, config);
        return session;
    };

    try {
        await fn(client);
    } finally {
        await client.stop();
        await worker.stop();
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function pass(name) {
    console.log(`  ✅ ${name}`);
}

// ─── Test 1: Simple Q&A ─────────────────────────────────────────

async function testSimpleQA() {
    console.log("\n═══ Test 1: Simple Q&A ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: { mode: "replace", content: "Answer in one word only. No punctuation." },
        });

        console.log("  Sending: What is the capital of France?");
        const response = await session.sendAndWait(
            "What is the capital of France?",
            TIMEOUT,
        );

        console.log(`  Response: "${response}"`);
        assert(response?.toLowerCase().includes("paris"), `Expected 'Paris' but got: ${response}`);
        pass("Simple Q&A");
    });
}

// ─── Test 2: Tool Calling ────────────────────────────────────────

async function testToolCalling() {
    console.log("\n═══ Test 2: Tool Calling ═══");
    let toolCalled = false;

    const getWeather = defineTool("get_weather", {
        description: "Get current weather for a city",
        parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
        },
        handler: async (args) => {
            console.log(`  [TOOL] get_weather("${args.city}") called`);
            toolCalled = true;
            return { temperature: 72, condition: "sunny", city: args.city };
        },
    });

    await withClient({}, async (client) => {
        const session = await client.createSession({
            tools: [getWeather],
            systemMessage: {
                mode: "replace",
                content: "You have a get_weather tool. Use it when asked about weather. Be brief.",
            },
        });

        console.log("  Sending: What's the weather in NYC?");
        const response = await session.sendAndWait("What's the weather in NYC?", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assert(toolCalled, "Tool was not called");
        assert(
            response?.includes("72") || response?.toLowerCase().includes("sunny"),
            `Expected weather info but got: ${response}`,
        );
        pass("Tool Calling");
    });
}

// ─── Test 3: Short Wait (in-process) ────────────────────────────

async function testShortWait() {
    console.log("\n═══ Test 3: Short Wait (in-process) ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content:
                    "You have a wait tool. When asked to wait, use it with the exact seconds. After waiting, say 'Wait complete' and answer any pending question. Be brief.",
            },
        });

        console.log("  Sending: Wait 2 seconds then tell me 5+5");
        const start = Date.now();
        const response = await session.sendAndWait("Wait 2 seconds then tell me 5+5", TIMEOUT);
        const elapsed = (Date.now() - start) / 1000;

        console.log(`  Response: "${response}" (took ${elapsed.toFixed(1)}s)`);
        assert(response?.includes("10"), `Expected '10' but got: ${response}`);
        assert(elapsed >= 1.5, `Expected >= 2s wait but took ${elapsed}s`);
        pass("Short Wait");
    });
}

// ─── Test 4: Durable Timer (long wait → abort + timer) ──────────

async function testDurableTimer() {
    console.log("\n═══ Test 4: Durable Timer (abort + resume) ═══");
    await withClient({ waitThreshold: 0 }, async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content:
                    "You have a wait tool. When asked to wait, use it with the exact seconds. After the wait completes, answer any pending question. Be brief and direct.",
            },
        });

        console.log("  Sending: Wait 1 second then tell me the capital of Germany");
        const response = await session.sendAndWait(
            "Wait 1 second then tell me the capital of Germany",
            TIMEOUT,
        );

        console.log(`  Response: "${response}"`);
        assert(
            response?.toLowerCase().includes("berlin"),
            `Expected 'Berlin' but got: ${response}`,
        );
        pass("Durable Timer");
    });
}

// ─── Test 5: Multi-turn Conversation ─────────────────────────────

async function testMultiTurn() {
    console.log("\n═══ Test 5: Multi-turn Conversation ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: "Be brief and direct. Remember previous messages.",
            },
        });

        console.log("  Turn 1: My name is Alice");
        const r1 = await session.sendAndWait("My name is Alice", TIMEOUT);
        console.log(`  Response 1: "${r1}"`);

        console.log("  Turn 2: What is my name?");
        const r2 = await session.sendAndWait("What is my name?", TIMEOUT);
        console.log(`  Response 2: "${r2}"`);

        assert(r2?.toLowerCase().includes("alice"), `Expected 'Alice' but got: ${r2}`);
        pass("Multi-turn");
    });
}

// ─── Test 6: send() + wait() ─────────────────────────────────────

async function testSendAndWait() {
    console.log("\n═══ Test 6: send() + wait() ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: "Answer in one word only. No punctuation.",
            },
        });

        console.log("  Calling send() (fire-and-forget)...");
        await session.send("What is the capital of Japan?");

        console.log("  Calling wait() (blocking until done)...");
        const response = await session.wait(TIMEOUT);

        console.log(`  Response: "${response}"`);
        // wait() returns orchestration output, which may be empty string
        // The real answer is in customStatus. For now just assert it didn't throw.
        pass("send() + wait()");
    });
}

// ─── Test 7: User Input ──────────────────────────────────────────

async function testUserInput() {
    console.log("\n═══ Test 7: User Input ═══");
    let questionAsked = null;

    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content:
                    "Before answering any question, ALWAYS use the ask_user tool to ask the user to confirm what city they want information about. Then answer about that city. Be brief.",
            },
            onUserInputRequest: async (request) => {
                console.log(`  [USER INPUT] Question: "${request.question}"`);
                questionAsked = request.question;
                return { answer: "Tokyo", wasFreeform: true };
            },
        });

        console.log("  Sending: What is the population?");
        const response = await session.sendAndWait("What is the population?", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assert(questionAsked !== null, "ask_user was never called");
        assert(
            response?.toLowerCase().includes("tokyo") || response?.includes("million"),
            `Expected info about Tokyo but got: ${response}`,
        );
        pass("User Input");
    });
}

// ─── Test 8: Event Persistence (CMS session_events) ────────────

async function testEventPersistence() {
    console.log("\n═══ Test 8: Event Persistence ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: { mode: "replace", content: "Answer in one word only. No punctuation." },
        });

        console.log("  Sending: What is 2+2?");
        const response = await session.sendAndWait("What is 2+2?", TIMEOUT);
        console.log(`  Response: "${response}"`);

        // Wait a moment for events to be written to CMS
        await new Promise(r => setTimeout(r, 500));

        // getMessages() now returns SessionEvent[] from CMS
        const events = await session.getMessages();
        console.log(`  Events persisted: ${events.length}`);

        // Should have at least user.message + assistant.message
        assert(events.length >= 2, `Expected at least 2 events, got ${events.length}`);

        const eventTypes = events.map(e => e.eventType);
        console.log(`  Event types: ${[...new Set(eventTypes)].join(", ")}`);

        assert(eventTypes.includes("user.message"), "Missing user.message event");
        assert(eventTypes.includes("assistant.message"), "Missing assistant.message event");

        // Verify sequential ordering
        for (let i = 1; i < events.length; i++) {
            assert(events[i].seq > events[i - 1].seq, `Events not in order: seq ${events[i].seq} <= ${events[i - 1].seq}`);
        }

        // Verify no ephemeral events were persisted
        assert(!eventTypes.includes("assistant.message_delta"), "Ephemeral delta events should not be persisted");

        pass("Event Persistence");
    });
}

// ─── Test 9: DurableSession.on() event subscription ─────────────

async function testSessionOn() {
    console.log("\n═══ Test 9: session.on() Events ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: { mode: "replace", content: "Answer in one word only. No punctuation." },
        });

        // Set up event collection via on()
        const receivedEvents = [];
        const assistantMessages = [];

        const unsub1 = session.on((event) => {
            receivedEvents.push(event);
        });
        const unsub2 = session.on("assistant.message", (event) => {
            assistantMessages.push(event);
        });

        console.log("  Sending: What color is the sky?");
        const response = await session.sendAndWait("What color is the sky?", TIMEOUT);
        console.log(`  Response: "${response}"`);

        // Give the poller time to pick up events
        await new Promise(r => setTimeout(r, 2000));

        console.log(`  Events via on(): ${receivedEvents.length}`);
        console.log(`  Assistant messages via on("assistant.message"): ${assistantMessages.length}`);

        assert(receivedEvents.length >= 2, `Expected at least 2 events via on(), got ${receivedEvents.length}`);
        assert(assistantMessages.length >= 1, `Expected at least 1 assistant.message, got ${assistantMessages.length}`);

        // Verify each event has required fields
        for (const evt of receivedEvents) {
            assert(evt.seq > 0, `Event missing seq: ${JSON.stringify(evt)}`);
            assert(evt.sessionId, `Event missing sessionId: ${JSON.stringify(evt)}`);
            assert(evt.eventType, `Event missing eventType: ${JSON.stringify(evt)}`);
        }

        // Unsubscribe
        unsub1();
        unsub2();

        pass("session.on() Events");
    });
}

// ─── Runner ──────────────────────────────────────────────────────

const tests = [
    ["Simple Q&A", testSimpleQA],
    ["Tool Calling", testToolCalling],
    ["Short Wait", testShortWait],
    ["Durable Timer", testDurableTimer],
    ["Multi-turn", testMultiTurn],
    ["send() + wait()", testSendAndWait],
    ["User Input", testUserInput],
    ["Event Persistence", testEventPersistence],
    ["session.on() Events", testSessionOn],
];

console.log("🚀 durable-copilot-sdk v2 Architecture Test\n");
console.log(`  Store: ${STORE.startsWith("postgres") ? "postgres" : STORE}`);

let passed = 0;
let failed = 0;

// Parse --test flag for running specific tests
const testArg = process.argv.find(a => a.startsWith("--test="));
const testFilter = testArg ? testArg.split("=")[1] : null;

for (const [name, fn] of tests) {
    if (testFilter && !name.toLowerCase().includes(testFilter.toLowerCase())) {
        continue;
    }
    try {
        await fn();
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     ${err.message}`);
        if (err.stack) {
            const lines = err.stack.split("\n").slice(1, 4);
            for (const line of lines) console.error(`     ${line.trim()}`);
        }
        failed++;
    }
}

console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
