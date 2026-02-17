/**
 * Phase 1 integration tests for durable-copilot-sdk.
 *
 * These are real end-to-end tests that call the Copilot API.
 * They verify the full flow: client → duroxide orchestration → activity → SDK → LLM.
 *
 * Run: node --env-file=.env test/e2e.test.js
 */

import { DurableCopilotClient, defineTool } from "../dist/index.js";

const TIMEOUT = 60_000;

// ─── Helpers ─────────────────────────────────────────────────────

async function withClient(fn) {
    const store = process.env.DATABASE_URL || "sqlite::memory:";
    console.log(`  [store: ${store.startsWith("postgres") ? "postgres" : store}]`);
    const client = new DurableCopilotClient({
        store,
        githubToken: process.env.GITHUB_TOKEN,
    });
    await client.start();
    try {
        await fn(client);
    } finally {
        await client.stop();
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ─── Test 1: Simple Q&A ─────────────────────────────────────────

async function testSimpleQA() {
    console.log("\n═══ Test 1: Simple Q&A ═══");

    await withClient(async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: "Answer in one word only. No punctuation.",
            },
        });

        console.log("  Sending: What is the capital of France?");
        const response = await session.sendAndWait(
            "What is the capital of France?",
            TIMEOUT
        );

        console.log(`  Response: "${response}"`);
        assert(
            response?.toLowerCase().includes("paris"),
            `Expected 'Paris' but got: ${response}`
        );
        console.log("  ✅ PASS");
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

    await withClient(async (client) => {
        const session = await client.createSession({
            tools: [getWeather],
            systemMessage: {
                mode: "replace",
                content:
                    "You have a get_weather tool. Use it when asked about weather. Be brief.",
            },
        });

        console.log("  Sending: What's the weather in NYC?");
        const response = await session.sendAndWait(
            "What's the weather in NYC?",
            TIMEOUT
        );

        console.log(`  Response: "${response}"`);
        assert(toolCalled, "Tool was not called");
        assert(
            response?.includes("72") || response?.toLowerCase().includes("sunny"),
            `Expected weather info but got: ${response}`
        );
        console.log("  ✅ PASS");
    });
}

// ─── Test 3: Durable Timer (Short Wait) ─────────────────────────

async function testShortWait() {
    console.log("\n═══ Test 3: Short Wait (in-process) ═══");

    await withClient(async (client) => {
        // Set threshold to 10s — waits under 10s are in-process
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content:
                    "You have a wait tool. When asked to wait, use it with the exact seconds. After waiting, say 'Wait complete' and answer any pending question. Be brief.",
            },
        });

        console.log("  Sending: Wait 2 seconds then tell me 5+5");
        const start = Date.now();
        const response = await session.sendAndWait(
            "Wait 2 seconds then tell me 5+5",
            TIMEOUT
        );
        const elapsed = (Date.now() - start) / 1000;

        console.log(`  Response: "${response}" (took ${elapsed.toFixed(1)}s)`);
        assert(
            response?.includes("10"),
            `Expected '10' but got: ${response}`
        );
        assert(elapsed >= 1.5, `Expected >= 2s wait but took ${elapsed}s`);
        console.log("  ✅ PASS");
    });
}

// ─── Test 4: Durable Timer (Long Wait → Abort + Timer) ──────────

async function testDurableTimer() {
    console.log("\n═══ Test 4: Durable Timer (abort + resume) ═══");

    await withClient(async (client) => {
        // Override: make the client with waitThreshold=0 so ALL waits
        // become durable timers (even 1 second waits)
        const dclient = new DurableCopilotClient({
            store: "sqlite::memory:",
            githubToken: process.env.GITHUB_TOKEN,
            waitThreshold: 0, // every wait is durable
        });
        await dclient.start();

        try {
            const session = await dclient.createSession({
                systemMessage: {
                    mode: "replace",
                    content:
                        "You have a wait tool. When asked to wait, use it with the exact seconds. After the wait completes, answer any pending question. Be brief and direct.",
                },
            });

            // Ask to wait 1 second (will become a durable timer since threshold=0)
            console.log(
                "  Sending: Wait 1 second then tell me the capital of Germany"
            );
            const response = await session.sendAndWait(
                "Wait 1 second then tell me the capital of Germany",
                TIMEOUT
            );

            console.log(`  Response: "${response}"`);
            assert(
                response?.toLowerCase().includes("berlin"),
                `Expected 'Berlin' but got: ${response}`
            );
            console.log(
                "  ✅ PASS — LLM called wait → abort → durable timer → resume → answered Berlin"
            );
        } finally {
            await dclient.stop();
        }
    });
}

// ─── Test 5: send() + wait() ─────────────────────────────────────

async function testSendAndWait() {
    console.log("\n═══ Test 5: send() + wait() (fire-and-forget) ═══");

    await withClient(async (client) => {
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
        assert(
            response?.toLowerCase().includes("tokyo"),
            `Expected 'Tokyo' but got: ${response}`
        );
        console.log("  ✅ PASS");
    });
}

// ─── Test 6: Multi-turn Conversation ─────────────────────────────

async function testMultiTurn() {
    console.log("\n═══ Test 6: Multi-turn Conversation ═══");

    await withClient(async (client) => {
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

        assert(
            r2?.toLowerCase().includes("alice"),
            `Expected 'Alice' but got: ${r2}`
        );
        console.log("  ✅ PASS — LLM remembered 'Alice' across turns");
    });
}

// ─── Test 7: User Input (blocking callback) ──────────────────────

async function testUserInput() {
    console.log("\n═══ Test 7: User Input (blocking callback) ═══");

    let questionAsked = null;

    await withClient(async (client) => {
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
        const response = await session.sendAndWait(
            "What is the population?",
            TIMEOUT
        );

        console.log(`  Response: "${response}"`);
        assert(questionAsked !== null, "ask_user was never called");
        assert(
            response?.toLowerCase().includes("tokyo") ||
                response?.includes("million"),
            `Expected info about Tokyo but got: ${response}`
        );
        console.log("  ✅ PASS — ask_user fired, handler returned 'Tokyo', LLM continued");
    });
}

// ─── Runner ──────────────────────────────────────────────────────

const tests = [
    ["Simple Q&A", testSimpleQA],
    ["Tool Calling", testToolCalling],
    ["Short Wait", testShortWait],
    ["Durable Timer", testDurableTimer],
    ["send() + wait()", testSendAndWait],
    ["Multi-turn", testMultiTurn],
    ["User Input", testUserInput],
];

console.log("🚀 durable-copilot-sdk Phase 1 E2E Tests\n");

let passed = 0;
let failed = 0;

for (const [name, fn] of tests) {
    try {
        await fn();
        passed++;
    } catch (err) {
        console.log(`  ❌ FAIL: ${err.message}`);
        failed++;
    }
}

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${tests.length}`);
console.log(`${"═".repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
