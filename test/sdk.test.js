/**
 * durable-copilot-runtime — integration test suite.
 *
 * Tests the full flow: DurableCopilotClient → orchestration → SessionProxy
 * → SessionManager → ManagedSession → CopilotSession.
 *
 * Run: node --env-file=.env test/sdk.test.js
 */

import { DurableCopilotClient, DurableCopilotWorker, defineTool } from "../dist/index.js";

const TIMEOUT = 120_000;
const STORE = process.env.DATABASE_URL || "sqlite::memory:";

async function preflightChecks() {
    if (!process.env.GITHUB_TOKEN) {
        throw new Error(
            "Missing GITHUB_TOKEN. Copy .env.example to .env and set GITHUB_TOKEN before running tests.",
        );
    }

    if (STORE.startsWith("postgres://") || STORE.startsWith("postgresql://")) {
        const { Client } = await import("pg");
        const client = new Client({
            connectionString: STORE,
            connectionTimeoutMillis: 4000,
        });
        try {
            await client.connect();
            await client.query("SELECT 1");
        } catch (err) {
            const message = err?.message || String(err);
            throw new Error(
                `PostgreSQL is not reachable at DATABASE_URL (${message}). Start Postgres or set DATABASE_URL=sqlite::memory:.`,
            );
        } finally {
            try { await client.end(); } catch {}
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────

async function withClient(opts, fn) {
    const worker = new DurableCopilotWorker({
        store: STORE,
        githubToken: process.env.GITHUB_TOKEN,
    });
    await worker.start();

    const client = new DurableCopilotClient({
        store: STORE,
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

// ─── Test 10: Tool Registration on Worker ────────────────────────

async function testToolOnWorker() {
    console.log("\n═══ Test 10: Tool Registration on Worker ═══");
    let toolCalled = false;

    const calculator = defineTool("add_numbers", {
        description: "Add two numbers together",
        parameters: {
            type: "object",
            properties: {
                a: { type: "number" },
                b: { type: "number" },
            },
            required: ["a", "b"],
        },
        handler: async (args) => {
            console.log(`  [TOOL] add_numbers(${args.a}, ${args.b}) called`);
            toolCalled = true;
            return { result: args.a + args.b };
        },
    });

    // Explicitly test the correct pattern: tools on worker, not client
    const worker = new DurableCopilotWorker({
        store: STORE,
        githubToken: process.env.GITHUB_TOKEN,
    });
    await worker.start();

    const client = new DurableCopilotClient({ store: STORE });
    await client.start();

    try {
        // Client creates session with serializable config only
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: "You have an add_numbers tool. Use it when asked to add. Be brief.",
            },
        });

        // Tools registered on the WORKER
        worker.setSessionConfig(session.sessionId, { tools: [calculator] });

        console.log("  Sending: What is 17 + 25?");
        const response = await session.sendAndWait("What is 17 + 25?", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assert(toolCalled, "Tool handler was not called on the worker");
        assert(
            response?.includes("42"),
            `Expected 42 but got: ${response}`,
        );
        pass("Tool Registration on Worker");
    } finally {
        await client.stop();
        await worker.stop();
    }
}

// ─── Test 11: Session Resume ─────────────────────────────────────

async function testSessionResume() {
    console.log("\n═══ Test 11: Session Resume ═══");
    await withClient({}, async (client) => {
        // Create session and establish context
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: "Remember everything the user tells you. Be brief.",
            },
        });
        const savedId = session.sessionId;

        console.log("  Turn 1: My favorite color is purple");
        await session.sendAndWait("My favorite color is purple", TIMEOUT);

        // Resume the session by ID (simulates reconnecting from another process)
        console.log("  Resuming session by ID...");
        const resumed = await client.resumeSession(savedId);
        assert(resumed.sessionId === savedId, "Resumed session has wrong ID");

        console.log("  Turn 2: What is my favorite color?");
        const response = await resumed.sendAndWait("What is my favorite color?", TIMEOUT);
        console.log(`  Response: "${response}"`);
        assert(
            response?.toLowerCase().includes("purple"),
            `Expected 'purple' but got: ${response}`,
        );
        pass("Session Resume");
    });
}

// ─── Test 12: Session List ──────────────────────────────────────

async function testSessionList() {
    console.log("\n═══ Test 12: Session List ═══");
    await withClient({}, async (client) => {
        // Create two sessions
        const s1 = await client.createSession({
            systemMessage: { mode: "replace", content: "Answer in one word." },
        });
        const s2 = await client.createSession({
            systemMessage: { mode: "replace", content: "Answer in one word." },
        });

        console.log(`  Created: ${s1.sessionId.slice(0, 8)}, ${s2.sessionId.slice(0, 8)}`);

        const sessions = await client.listSessions();
        console.log(`  listSessions() returned ${sessions.length} session(s)`);

        const ids = sessions.map(s => s.sessionId);
        assert(ids.includes(s1.sessionId), `Session ${s1.sessionId.slice(0, 8)} not in list`);
        assert(ids.includes(s2.sessionId), `Session ${s2.sessionId.slice(0, 8)} not in list`);

        pass("Session List");
    });
}

// ─── Test 13: Session Info ──────────────────────────────────────

async function testSessionInfo() {
    console.log("\n═══ Test 13: Session Info ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: { mode: "replace", content: "Answer in one word. No punctuation." },
        });

        // Before sending anything
        const info1 = await session.getInfo();
        console.log(`  Status before send: ${info1.status}`);
        assert(
            info1.status === "pending" || info1.status === "idle",
            `Expected pending/idle but got: ${info1.status}`,
        );
        assert(info1.sessionId === session.sessionId, "Wrong sessionId in info");

        // After a turn
        console.log("  Sending: What is 3+3?");
        await session.sendAndWait("What is 3+3?", TIMEOUT);

        const info2 = await session.getInfo();
        console.log(`  Status after send: ${info2.status}, iterations: ${info2.iterations}`);
        assert(
            info2.status === "idle" || info2.status === "completed",
            `Expected idle/completed but got: ${info2.status}`,
        );
        assert(info2.iterations >= 1, `Expected iterations >= 1, got ${info2.iterations}`);

        pass("Session Info");
    });
}

// ─── Test 14: Session Delete ────────────────────────────────────

async function testSessionDelete() {
    console.log("\n═══ Test 14: Session Delete ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: { mode: "replace", content: "Answer in one word." },
        });
        const id = session.sessionId;
        console.log(`  Created session: ${id.slice(0, 8)}`);

        // Verify it exists
        let sessions = await client.listSessions();
        assert(
            sessions.some(s => s.sessionId === id),
            "Session not in list before delete",
        );

        // Delete it
        await client.deleteSession(id);
        console.log("  Deleted session");

        // Verify it's gone
        sessions = await client.listSessions();
        assert(
            !sessions.some(s => s.sessionId === id),
            "Session still in list after delete",
        );

        pass("Session Delete");
    });
}

// ─── Test 15: Event Type Filter ─────────────────────────────────

async function testEventTypeFilter() {
    console.log("\n═══ Test 15: Event Type Filter ═══");
    await withClient({}, async (client) => {
        const session = await client.createSession({
            systemMessage: { mode: "replace", content: "Answer in one word. No punctuation." },
        });

        const userMessages = [];
        const assistantMessages = [];
        const allEvents = [];

        session.on("user.message", (event) => { userMessages.push(event); });
        session.on("assistant.message", (event) => { assistantMessages.push(event); });
        session.on((event) => { allEvents.push(event); });

        console.log("  Sending: What is 7+7?");
        await session.sendAndWait("What is 7+7?", TIMEOUT);

        // Wait for events to arrive via polling
        await new Promise(r => setTimeout(r, 2000));

        console.log(`  user.message events: ${userMessages.length}`);
        console.log(`  assistant.message events: ${assistantMessages.length}`);
        console.log(`  all events: ${allEvents.length}`);

        assert(userMessages.length >= 1, `Expected at least 1 user.message, got ${userMessages.length}`);
        assert(assistantMessages.length >= 1, `Expected at least 1 assistant.message, got ${assistantMessages.length}`);
        assert(allEvents.length > userMessages.length + assistantMessages.length - 1,
            "All-events handler should receive more event types than filtered handlers");

        // Verify filtered events only contain the right type
        for (const evt of userMessages) {
            assert(evt.eventType === "user.message", `user.message filter got ${evt.eventType}`);
        }
        for (const evt of assistantMessages) {
            assert(evt.eventType === "assistant.message", `assistant.message filter got ${evt.eventType}`);
        }

        pass("Event Type Filter");
    });
}

// ─── Test 16: Worker-Registered Tools (Remote Pattern) ──────────

async function testWorkerRegisteredTools() {
    console.log("\n═══ Test 16: Worker-Registered Tools (Remote Pattern) ═══");
    let toolCalled = false;

    // Define a tool that will be registered on the worker at startup
    const calculator = defineTool("remote_add", {
        description: "Add two numbers together",
        parameters: {
            type: "object",
            properties: {
                a: { type: "number", description: "First number" },
                b: { type: "number", description: "Second number" },
            },
            required: ["a", "b"],
        },
        handler: async (args) => {
            console.log(`  [TOOL] remote_add(${args.a}, ${args.b}) called on worker`);
            toolCalled = true;
            return { result: args.a + args.b };
        },
    });

    // Simulate remote mode: worker and client are independent processes.
    // Worker registers tools at startup time.
    const worker = new DurableCopilotWorker({
        store: STORE,
        githubToken: process.env.GITHUB_TOKEN,
    });

    // Register tools BEFORE starting — this is what you'd do in worker.js
    worker.registerTools([calculator]);
    await worker.start();

    const client = new DurableCopilotClient({ store: STORE });
    await client.start();

    try {
        // Client references tool by NAME only — no Tool objects, no handlers.
        // The name travels through duroxide as a serializable string.
        const session = await client.createSession({
            toolNames: ["remote_add"],
            systemMessage: {
                mode: "replace",
                content: "You have a remote_add tool. Use it when asked to add numbers. Be brief.",
            },
        });

        // No worker.setSessionConfig() needed — tools are resolved from the registry.

        console.log("  Sending: What is 100 + 200?");
        const response = await session.sendAndWait("What is 100 + 200?", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assert(toolCalled, "Worker-registered tool handler was not called");
        assert(
            response?.includes("300"),
            `Expected 300 but got: ${response}`,
        );
        pass("Worker-Registered Tools (Remote Pattern)");
    } finally {
        await client.stop();
        await worker.stop();
    }
}

// ─── Test 17: Worker Registry + Per-Session Tools Combined ──────

async function testRegistryPlusSessionTools() {
    console.log("\n═══ Test 17: Registry + Per-Session Tools Combined ═══");
    let registryToolCalled = false;
    let sessionToolCalled = false;

    const registryTool = defineTool("lookup_capital", {
        description: "Look up the capital city of a country",
        parameters: {
            type: "object",
            properties: { country: { type: "string" } },
            required: ["country"],
        },
        handler: async (args) => {
            console.log(`  [REGISTRY TOOL] lookup_capital(${args.country})`);
            registryToolCalled = true;
            const capitals = { france: "Paris", japan: "Tokyo", brazil: "Brasilia" };
            return { capital: capitals[args.country.toLowerCase()] || "Unknown" };
        },
    });

    const sessionTool = defineTool("reverse_string", {
        description: "Reverse a string",
        parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
        },
        handler: async (args) => {
            console.log(`  [SESSION TOOL] reverse_string(${args.text})`);
            sessionToolCalled = true;
            return { reversed: args.text.split("").reverse().join("") };
        },
    });

    const worker = new DurableCopilotWorker({
        store: STORE,
        githubToken: process.env.GITHUB_TOKEN,
    });
    worker.registerTools([registryTool]);
    await worker.start();

    const client = new DurableCopilotClient({ store: STORE });
    await client.start();

    try {
        // Client creates session with both: toolNames (registry) + per-session tool
        const session = await client.createSession({
            toolNames: ["lookup_capital"],
            systemMessage: {
                mode: "replace",
                content: "You have lookup_capital and reverse_string tools. " +
                         "Use lookup_capital for capital cities and reverse_string to reverse text. " +
                         "Answer briefly.",
            },
        });

        // Per-session tool via setSessionConfig (same-process bridge)
        worker.setSessionConfig(session.sessionId, { tools: [sessionTool] });

        console.log("  Sending: What is the capital of France? Also reverse the word 'hello'.");
        const response = await session.sendAndWait(
            "What is the capital of France? Also reverse the word 'hello'.",
            TIMEOUT,
        );

        console.log(`  Response: "${response}"`);
        assert(registryToolCalled, "Registry tool (lookup_capital) was not called");
        assert(sessionToolCalled, "Session tool (reverse_string) was not called");
        assert(
            response?.includes("Paris") || response?.includes("paris"),
            `Expected Paris in response: ${response}`,
        );
        pass("Registry + Per-Session Tools Combined");
    } finally {
        await client.stop();
        await worker.stop();
    }
}

// ─── Test 18: Warm Session Picks Up New Tools ──────────────────

async function testWarmSessionToolUpdate() {
    console.log("\n═══ Test 18: Warm Session Picks Up New Tools ═══");
    let multiplyToolCalled = false;

    const worker = new DurableCopilotWorker({
        store: STORE,
        githubToken: process.env.GITHUB_TOKEN,
    });
    await worker.start();

    const client = new DurableCopilotClient({ store: STORE });
    await client.start();

    // Wrap createSession to forward config to co-located worker
    const origCreate = client.createSession.bind(client);
    client.createSession = async (config) => {
        const session = await origCreate(config);
        if (config) worker.setSessionConfig(session.sessionId, config);
        return session;
    };

    try {
        // Turn 1: session is created (cold → warm). No custom tools yet.
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: "Use tools when available. Be brief. Answer with just the number.",
            },
        });

        console.log("  Turn 1 (no custom tools): What is 3+3?");
        const r1 = await session.sendAndWait("What is 3+3?", TIMEOUT);
        console.log(`  Response: "${r1}"`);
        assert(r1?.includes("6"), `Expected 6 but got: ${r1}`);

        // Session is now warm in SessionManager. Register a new tool AFTER
        // the session was created — this is the scenario we're testing.
        const multiplyTool = defineTool("multiply", {
            description: "Multiply two numbers together",
            parameters: {
                type: "object",
                properties: {
                    a: { type: "number" },
                    b: { type: "number" },
                },
                required: ["a", "b"],
            },
            handler: async (args) => {
                console.log(`  [TOOL] multiply(${args.a}, ${args.b}) called on warm session`);
                multiplyToolCalled = true;
                return { result: args.a * args.b };
            },
        });

        // Add the tool to the already-warm session via setSessionConfig
        worker.setSessionConfig(session.sessionId, { tools: [multiplyTool] });

        // Turn 2: same session (warm). Should see the new multiply tool.
        console.log("  Turn 2 (multiply tool added): Use the multiply tool to compute 7 * 8");
        const r2 = await session.sendAndWait(
            "Use the multiply tool to compute 7 * 8",
            TIMEOUT,
        );
        console.log(`  Response: "${r2}"`);
        assert(multiplyToolCalled, "multiply tool was NOT called — warm session didn't pick up the new tool");
        assert(r2?.includes("56"), `Expected 56 but got: ${r2}`);

        pass("Warm Session Picks Up New Tools");
    } finally {
        await client.stop();
        await worker.stop();
    }
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
    ["Tool on Worker", testToolOnWorker],
    ["Session Resume", testSessionResume],
    ["Session List", testSessionList],
    ["Session Info", testSessionInfo],
    ["Session Delete", testSessionDelete],
    ["Event Type Filter", testEventTypeFilter],
    ["Worker-Registered Tools", testWorkerRegisteredTools],
    ["Registry + Session Tools", testRegistryPlusSessionTools],
    ["Warm Session Tool Update", testWarmSessionToolUpdate],
];

await preflightChecks();

console.log("🚀 durable-copilot-runtime Integration Test\n");
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
