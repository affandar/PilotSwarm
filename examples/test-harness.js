#!/usr/bin/env node

/**
 * Headless test harness for the durable-copilot-sdk core engine.
 *
 * Exercises session creation, observer pattern, message sending,
 * session switching, timer interrupts, and log collection —
 * all without the blessed TUI.
 *
 * Usage:
 *   WORKERS=0 node --env-file=.env.remote examples/test-harness.js
 *   node --env-file=.env.remote examples/test-harness.js           # 2 embedded workers
 */

import { DurableCopilotClient } from "../dist/index.js";
import { initTracing } from "duroxide";
import fs from "node:fs";

// ─── Configuration ───────────────────────────────────────────────

const store = process.env.DATABASE_URL || "sqlite::memory:";
const numWorkers = parseInt(process.env.WORKERS ?? "2", 10);
const isRemote = numWorkers === 0;

const SYSTEM_MESSAGE =
    "You are a helpful assistant running in a durable execution environment. Be concise. " +
    "CRITICAL RULE: When you need to wait, pause, sleep, delay, or do anything periodically/recurring, " +
    "you MUST use the 'wait' tool. NEVER use bash sleep, setTimeout, setInterval, detached processes, " +
    "or any other timing mechanism. The 'wait' tool is the only way to wait — it enables durable timers " +
    "that survive process restarts and node migrations.";

// ─── Logging ─────────────────────────────────────────────────────

const LOG_COLORS = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
    white: "\x1b[37m",
};

const SESSION_COLORS = [LOG_COLORS.cyan, LOG_COLORS.magenta, LOG_COLORS.green, LOG_COLORS.yellow, LOG_COLORS.blue];

function log(msg, color = LOG_COLORS.white) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`${LOG_COLORS.gray}[${ts}]${LOG_COLORS.reset} ${color}${msg}${LOG_COLORS.reset}`);
}

function logSession(sessionIdx, msg) {
    const color = SESSION_COLORS[sessionIdx % SESSION_COLORS.length];
    const tag = `[S${sessionIdx}]`;
    log(`${tag} ${msg}`, color);
}

function logError(msg) { log(`❌ ${msg}`, LOG_COLORS.red); }
function logOk(msg) { log(`✅ ${msg}`, LOG_COLORS.green); }
function logWarn(msg) { log(`⚠️  ${msg}`, LOG_COLORS.yellow); }

// ─── Core Engine (extracted from TUI) ────────────────────────────

class CoreEngine {
    constructor() {
        this.workers = [];
        this.client = null;
        this.dc = null;

        // Per-session state
        this.sessions = new Map();          // sessionId → DurableSession
        this.chatBuffers = new Map();       // orchId → string[]
        this.observers = new Map();         // orchId → AbortController
        this.liveStatus = new Map();        // orchId → "idle"|"running"|"waiting"|"input_required"
        this.lastSeenVersion = new Map();   // orchId → number
        this.lastSeenIteration = new Map(); // orchId → number
        this.orchIds = new Set();           // all known orchestration IDs

        // Callbacks
        this.onStatusChange = null;         // (orchId, status) => void
        this.onMessage = null;              // (orchId, content) => void
        this.onIntermediateContent = null;   // (orchId, content) => void
    }

    async start() {
        // Start workers (if not remote)
        if (!isRemote) {
            const logFile = "/tmp/duroxide-test-harness.log";
            try { fs.writeFileSync(logFile, ""); } catch {}
            try {
                initTracing({ logFile, logLevel: process.env.LOG_LEVEL || "info", logFormat: "compact" });
            } catch {}

            const origStdout = process.stdout.write.bind(process.stdout);
            const origStderr = process.stderr.write.bind(process.stderr);
            process.stdout.write = () => true;
            process.stderr.write = () => true;

            for (let i = 0; i < numWorkers; i++) {
                const w = new DurableCopilotClient({
                    store,
                    githubToken: process.env.GITHUB_TOKEN,
                    logLevel: process.env.LOG_LEVEL || "error",
                    blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
                    blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
                    workerNodeId: `test-rt-${i}`,
                });
                await w.start();
                this.workers.push(w);
                log(`Worker test-rt-${i} started`);
            }

            process.stdout.write = origStdout;
            process.stderr.write = origStderr;
        }

        // Start thin client
        this.client = new DurableCopilotClient({
            store,
            blobEnabled: true,
            logLevel: "error",
        });
        await this.client.startClientOnly();
        this.dc = this.client._getDuroxideClient();
        log("Thin client connected");
    }

    async stop() {
        // Stop all observers
        for (const [id, ac] of this.observers) {
            ac.abort();
        }
        this.observers.clear();

        // Stop workers
        await Promise.allSettled(this.workers.map(w => w.stop()));

        // Stop client
        if (this.client) await this.client.stop();
        log("Engine stopped");
    }

    async createSession(systemMessage) {
        const sess = await this.client.createSession({
            systemMessage: systemMessage || SYSTEM_MESSAGE,
        });
        const orchId = `session-${sess.sessionId}`;
        this.sessions.set(sess.sessionId, sess);
        this.orchIds.add(orchId);
        if (!this.chatBuffers.has(orchId)) this.chatBuffers.set(orchId, []);
        this.startObserver(orchId);
        return { session: sess, orchId };
    }

    async sendMessage(orchId, prompt) {
        const sessionId = orchId.replace("session-", "");
        const sess = this.sessions.get(sessionId);

        // Buffer the user message
        this._appendChat(orchId, `You: ${prompt}`);

        if (sess) {
            await sess.send(prompt);
        } else {
            // Existing orchestration — just enqueue
            await this.dc.enqueueEvent(orchId, "messages", JSON.stringify({ prompt }));
        }
    }

    _appendChat(orchId, text) {
        if (!this.chatBuffers.has(orchId)) this.chatBuffers.set(orchId, []);
        this.chatBuffers.get(orchId).push(text);
    }

    getChatBuffer(orchId) {
        return this.chatBuffers.get(orchId) || [];
    }

    getStatus(orchId) {
        return this.liveStatus.get(orchId) || "unknown";
    }

    startObserver(orchId) {
        if (this.observers.has(orchId)) return;

        const ac = new AbortController();
        this.observers.set(orchId, ac);

        let lastVersion = this.lastSeenVersion.get(orchId) || 0;
        let lastIteration = this.lastSeenIteration.get(orchId) || -1;

        const run = async () => {
            // Initial read
            try {
                const currentStatus = await this.dc.getStatus(orchId);
                if (ac.signal.aborted) return;
                if (currentStatus?.customStatus) {
                    let cs;
                    try {
                        cs = typeof currentStatus.customStatus === "string"
                            ? JSON.parse(currentStatus.customStatus) : currentStatus.customStatus;
                    } catch {}
                    if (cs) {
                        lastVersion = currentStatus.customStatusVersion || 0;
                        if (cs.status) {
                            this.liveStatus.set(orchId, cs.status);
                            if (this.onStatusChange) this.onStatusChange(orchId, cs.status);
                        }
                        if (cs.turnResult && cs.turnResult.type === "completed") {
                            lastIteration = cs.iteration || 0;
                            this._appendChat(orchId, `Copilot: ${cs.turnResult.content}`);
                            if (this.onMessage) this.onMessage(orchId, cs.turnResult.content);
                        }
                    }
                }
            } catch {}

            // Poll loop
            while (!ac.signal.aborted) {
                try {
                    const statusResult = await this.dc.waitForStatusChange(
                        orchId, lastVersion, 200, 30_000
                    );
                    if (ac.signal.aborted) break;

                    if (statusResult.customStatusVersion > lastVersion) {
                        lastVersion = statusResult.customStatusVersion;
                        this.lastSeenVersion.set(orchId, lastVersion);
                    } else if (statusResult.customStatusVersion < lastVersion) {
                        // continueAsNew happened — version reset. Reset watermarks.
                        lastVersion = statusResult.customStatusVersion;
                        lastIteration = -1;
                        this.lastSeenVersion.set(orchId, lastVersion);
                        this.lastSeenIteration.set(orchId, lastIteration);
                    }

                    let cs = null;
                    if (statusResult.customStatus) {
                        try {
                            cs = typeof statusResult.customStatus === "string"
                                ? JSON.parse(statusResult.customStatus) : statusResult.customStatus;
                        } catch {}
                    }

                    if (cs) {
                        // Track status
                        if (cs.status) {
                            const prevStatus = this.liveStatus.get(orchId);
                            this.liveStatus.set(orchId, cs.status);
                            if (prevStatus !== cs.status && this.onStatusChange) {
                                this.onStatusChange(orchId, cs.status);
                            }
                        }

                        // DEBUG: Log raw observer data on every status change
                        const short = orchId.slice(8, 16);
                        log(`    [${short}] RAW: ver=${statusResult.customStatusVersion} iter=${cs.iteration} lastIter=${lastIteration} lastVer=${lastVersion} status=${cs.status} hasTR=${!!cs.turnResult} trType=${cs.turnResult?.type || "none"}`, LOG_COLORS.gray);

                        // Intermediate content
                        if (cs.intermediateContent) {
                            this._appendChat(orchId, `Copilot (partial): ${cs.intermediateContent}`);
                            if (this.onIntermediateContent) {
                                this.onIntermediateContent(orchId, cs.intermediateContent);
                            }
                        }

                        // Turn result
                        if (cs.turnResult && cs.iteration > lastIteration) {
                            lastIteration = cs.iteration;
                            this.lastSeenIteration.set(orchId, lastIteration);

                            if (cs.turnResult.type === "completed") {
                                const content = cs.turnResult.content;
                                // Don't double-add if already shown as intermediate
                                if (!cs.intermediateContent || cs.intermediateContent !== content) {
                                    this._appendChat(orchId, `Copilot: ${content}`);
                                    if (this.onMessage) this.onMessage(orchId, content);
                                }
                            } else if (cs.turnResult.type === "input_required") {
                                this._appendChat(orchId, `Copilot asks: ${cs.turnResult.question}`);
                                if (this.onMessage) this.onMessage(orchId, `[INPUT_REQUIRED] ${cs.turnResult.question}`);
                            }
                        } else if (cs.turnResult) {
                            log(`    [${short}] SKIPPED turnResult: iter=${cs.iteration} <= lastIter=${lastIteration}`, LOG_COLORS.yellow);
                        }
                    }
                } catch {
                    // waitForStatusChange timed out — check for continueAsNew or terminal states
                    try {
                        const info = await this.dc.getStatus(orchId);
                        if (["Completed", "Failed", "Terminated"].includes(info.status)) {
                            this.liveStatus.set(orchId, info.status.toLowerCase());
                            if (this.onStatusChange) this.onStatusChange(orchId, info.status.toLowerCase());
                            break;
                        }
                        // Detect continueAsNew: version went backwards
                        const currentVersion = info.customStatusVersion || 0;
                        if (currentVersion < lastVersion) {
                            lastVersion = 0;
                            lastIteration = -1;
                            this.lastSeenVersion.set(orchId, 0);
                            this.lastSeenIteration.set(orchId, -1);
                        }
                    } catch {}
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        };

        run().catch(() => {});
    }

    stopObserver(orchId) {
        const ac = this.observers.get(orchId);
        if (ac) {
            ac.abort();
            this.observers.delete(orchId);
        }
    }

    async listOrchestrations() {
        const ids = await this.dc.listAllInstances();
        const results = [];
        for (const id of ids) {
            try {
                const info = await this.dc.getInstanceInfo(id);
                const status = await this.dc.getStatus(id);
                results.push({
                    id,
                    status: info.status,
                    createdAt: info.createdAt,
                    liveStatus: this.liveStatus.get(id),
                    customStatus: status?.customStatus,
                });
            } catch {}
        }
        return results;
    }

    /**
     * Wait for a specific status on a session, with timeout.
     */
    async waitForStatus(orchId, targetStatus, timeoutMs = 60_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const current = this.liveStatus.get(orchId);
            if (current === targetStatus) return true;
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    }

    /**
     * Wait for a new message in the chat buffer, with timeout.
     * Returns the new messages added since calling this.
     */
    async waitForNewMessage(orchId, timeoutMs = 120_000) {
        const buf = this.chatBuffers.get(orchId) || [];
        const startLen = buf.length;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const current = this.chatBuffers.get(orchId) || [];
            if (current.length > startLen) {
                // Return only new entries that start with "Copilot:"
                const newEntries = current.slice(startLen).filter(l => l.startsWith("Copilot:"));
                if (newEntries.length > 0) return newEntries;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        return null;
    }

    /**
     * Wait until the chat buffer has at least N copilot messages, with timeout.
     */
    async waitForMessageCount(orchId, count, timeoutMs = 300_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const buf = this.chatBuffers.get(orchId) || [];
            const copilotMsgs = buf.filter(l => l.startsWith("Copilot:"));
            if (copilotMsgs.length >= count) return copilotMsgs;
            await new Promise(r => setTimeout(r, 1000));
        }
        return null;
    }
}

// ─── Test Scenarios ──────────────────────────────────────────────

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

let passCount = 0;
let failCount = 0;

function assert(condition, msg) {
    if (condition) {
        logOk(msg);
        passCount++;
    } else {
        logError(`ASSERT FAILED: ${msg}`);
        failCount++;
    }
}

/**
 * Scenario 1: Create a session, send a message, get a response.
 */
async function testBasicSendReceive(engine) {
    log("\n═══ Scenario 1: Basic Send/Receive ═══", LOG_COLORS.cyan);

    const { session, orchId } = await engine.createSession();
    logSession(0, `Created session ${session.sessionId.slice(0, 8)}`);

    await engine.sendMessage(orchId, "Say exactly: HELLO_TEST_123");
    logSession(0, "Sent message, waiting for response...");

    const msgs = await engine.waitForNewMessage(orchId, 90_000);
    assert(msgs !== null, "Got a response from copilot");
    if (msgs) {
        const responseText = msgs.join(" ");
        logSession(0, `Response: ${responseText.slice(0, 100)}`);
        assert(responseText.includes("HELLO_TEST_123"), "Response contains expected text");
    }

    const status = engine.getStatus(orchId);
    assert(status === "idle", `Session is idle after response (got: ${status})`);

    return orchId;
}

/**
 * Scenario 2: Create 3 sessions with recurring timers.
 * Verify each session independently produces timer-based output.
 */
async function testRecurringTimers(engine) {
    log("\n═══ Scenario 2: 3 Sessions with Recurring Timers ═══", LOG_COLORS.cyan);

    const sessionPrompts = [
        "Start a recurring 60-second timer. Every time it fires, say 'TIMER_A_FIRED' followed by the count.",
        "Start a recurring 60-second timer. Every time it fires, say 'TIMER_B_FIRED' followed by the count.",
        "Start a recurring 60-second timer. Every time it fires, say 'TIMER_C_FIRED' followed by the count.",
    ];

    const orchIds = [];
    for (let i = 0; i < sessionPrompts.length; i++) {
        const { session, orchId } = await engine.createSession();
        orchIds.push(orchId);
        logSession(i, `Created session ${session.sessionId.slice(0, 8)}`);

        await engine.sendMessage(orchId, sessionPrompts[i]);
        logSession(i, "Sent timer request");
    }

    // Wait for all sessions to acknowledge the timer setup
    log("Waiting for timer acknowledgments (up to 90s)...");
    for (let i = 0; i < orchIds.length; i++) {
        const firstMsg = await engine.waitForNewMessage(orchIds[i], 90_000);
        if (firstMsg) {
            logSession(i, `Ack: ${firstMsg[0].slice(0, 80)}`);
        } else {
            logSession(i, "No ack received within timeout");
        }
    }

    // Check all go to "waiting" status (durable timer)
    log("Checking timer status...");
    await sleep(5_000); // Give time for status to propagate
    for (let i = 0; i < orchIds.length; i++) {
        const status = engine.getStatus(orchIds[i]);
        logSession(i, `Status: ${status}`);
        assert(
            status === "waiting" || status === "running" || status === "idle",
            `Session ${i} is in expected state (got: ${status})`
        );
    }

    return orchIds;
}

/**
 * Scenario 3: Interrupt a timer session and change its task.
 */
async function testInterruptAndChange(engine, orchIds) {
    log("\n═══ Scenario 3: Interrupt Timer & Change Task ═══", LOG_COLORS.cyan);

    if (!orchIds || orchIds.length === 0) {
        logWarn("Skipping — no sessions from previous scenario");
        return;
    }

    // Interrupt session 0: change the timer interval
    const targetOrchId = orchIds[0];
    logSession(0, "Interrupting session 0 — changing to 45s timer");

    // Start a rapid status poller to capture every version transition
    let pollRunning = true;
    let lastPollVer = -1;
    const doPoll = async () => {
        while (pollRunning) {
            try {
                const s = await engine.dc.getStatus(targetOrchId);
                const ver = s.customStatusVersion || 0;
                if (ver !== lastPollVer) {
                    lastPollVer = ver;
                    let cs = null;
                    try {
                        cs = typeof s.customStatus === "string" ? JSON.parse(s.customStatus) : s.customStatus;
                    } catch {}
                    const short = targetOrchId.slice(8, 16);
                    log(`  POLL [${short}] ver=${ver} orchStatus=${s.status} cs.status=${cs?.status} iter=${cs?.iteration} hasTR=${!!cs?.turnResult} trType=${cs?.turnResult?.type || "none"} content=${(cs?.turnResult?.content || "").slice(0, 40)}`, LOG_COLORS.yellow);
                }
            } catch {}
            await new Promise(r => setTimeout(r, 100));
        }
    };
    const pollPromise = doPoll();

    await engine.sendMessage(targetOrchId, "Stop the current timer. Start a new recurring 45-second timer instead. Each time say 'TIMER_A_MODIFIED' followed by the count.");

    const response = await engine.waitForNewMessage(targetOrchId, 90_000);
    pollRunning = false;
    await pollPromise;

    if (response) {
        logSession(0, `Response to interrupt: ${response[0].slice(0, 100)}`);
        assert(true, "Session responded to interrupt");
    } else {
        assert(false, "Session responded to interrupt (timed out)");
    }

    // Interrupt session 1: change the task type entirely
    if (orchIds.length >= 2) {
        logSession(1, "Interrupting session 1 — changing task to jokes");
        await engine.sendMessage(orchIds[1], "Stop the timer. Instead, tell me a joke every 60 seconds. Say 'JOKE_TIME' before each joke.");

        const response2 = await engine.waitForNewMessage(orchIds[1], 90_000);
        if (response2) {
            logSession(1, `Response: ${response2[0].slice(0, 100)}`);
            assert(true, "Session 1 changed task type");
        } else {
            assert(false, "Session 1 changed task type (timed out)");
        }
    }
}

/**
 * Scenario 4: Simulate session switching — verify buffers.
 */
async function testSessionSwitching(engine, orchIds) {
    log("\n═══ Scenario 4: Session Switching & Buffer Integrity ═══", LOG_COLORS.cyan);

    if (!orchIds || orchIds.length < 2) {
        logWarn("Skipping — need at least 2 sessions");
        return;
    }

    // Snapshot current buffer sizes
    const bufferSizes = orchIds.map(id => engine.getChatBuffer(id).length);
    log(`Buffer sizes: ${bufferSizes.join(", ")}`);

    // Simulate "switching" by checking each session's buffer
    for (let i = 0; i < orchIds.length; i++) {
        const buf = engine.getChatBuffer(orchIds[i]);
        logSession(i, `Buffer has ${buf.length} entries`);
        assert(buf.length > 0, `Session ${i} has non-empty chat buffer`);

        // Verify buffer contains at least one user message and one copilot message
        const hasUser = buf.some(l => l.startsWith("You:"));
        const hasCopilot = buf.some(l => l.startsWith("Copilot:"));
        assert(hasUser, `Session ${i} buffer has user messages`);
        assert(hasCopilot, `Session ${i} buffer has copilot messages`);
    }

    // Wait for timer-based messages on all sessions concurrently
    log("Waiting 70s for timer-triggered messages across all sessions...");
    await sleep(70_000);

    // Check buffers grew
    for (let i = 0; i < orchIds.length; i++) {
        const newSize = engine.getChatBuffer(orchIds[i]).length;
        logSession(i, `Buffer grew: ${bufferSizes[i]} → ${newSize}`);
        // At least the first session should have a timer fire
        if (newSize > bufferSizes[i]) {
            logOk(`Session ${i} received timer-triggered messages`);
        } else {
            logWarn(`Session ${i} buffer didn't grow (timer may not have fired yet)`);
        }
    }
}

/**
 * Scenario 5: Observer lifecycle — stop and restart.
 */
async function testObserverLifecycle(engine, orchId) {
    log("\n═══ Scenario 5: Observer Stop/Restart ═══", LOG_COLORS.cyan);

    if (!orchId) {
        logWarn("Skipping — no session");
        return;
    }

    // Stop the observer
    engine.stopObserver(orchId);
    assert(!engine.observers.has(orchId), "Observer stopped");

    const bufBefore = engine.getChatBuffer(orchId).length;

    // Send a message while observer is stopped
    await engine.sendMessage(orchId, "Say exactly: OBSERVER_WAS_STOPPED");
    log("Sent message with observer stopped, waiting 10s...");
    await sleep(10_000);

    // Buffer shouldn't have grown (no observer to pick up the response)
    const bufAfter = engine.getChatBuffer(orchId).length;
    // It will have 1 more (the user message we just sent)
    assert(
        bufAfter === bufBefore + 1,
        `Buffer only has user message while observer stopped (${bufBefore} → ${bufAfter})`
    );

    // Restart observer
    engine.startObserver(orchId);
    assert(engine.observers.has(orchId), "Observer restarted");

    // Now the observer should pick up the pending response
    log("Observer restarted, waiting for pending response...");
    const msgs = await engine.waitForNewMessage(orchId, 90_000);
    assert(msgs !== null, "Observer picked up pending response after restart");
    if (msgs) {
        const txt = msgs.join(" ");
        logSession(0, `Caught up: ${txt.slice(0, 100)}`);
        assert(txt.includes("OBSERVER_WAS_STOPPED"), "Response matches expected text");
    }
}

/**
 * Scenario 6: List orchestrations and verify all are tracked.
 */
async function testListOrchestrations(engine, expectedCount) {
    log("\n═══ Scenario 6: List Orchestrations ═══", LOG_COLORS.cyan);

    const orchs = await engine.listOrchestrations();
    log(`Found ${orchs.length} orchestrations`);
    for (const o of orchs) {
        const shortId = o.id.startsWith("session-") ? o.id.slice(8, 16) : o.id.slice(0, 8);
        log(`  ${shortId}: ${o.status} (live: ${o.liveStatus || "?"})`);
    }

    const running = orchs.filter(o => o.status === "Running");
    assert(
        running.length >= expectedCount,
        `At least ${expectedCount} orchestrations running (found ${running.length})`
    );
}

/**
 * Scenario 7: Clean up — cancel all test sessions.
 */
async function testCleanup(engine, orchIds) {
    log("\n═══ Scenario 7: Cleanup ═══", LOG_COLORS.cyan);

    for (let i = 0; i < orchIds.length; i++) {
        try {
            engine.stopObserver(orchIds[i]);
            if (engine.dc.cancelInstance) {
                await engine.dc.cancelInstance(orchIds[i]);
                logSession(i, "Cancelled");
            }
        } catch (err) {
            logSession(i, `Cancel failed: ${err.message}`);
        }
    }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
    log("╔══════════════════════════════════════════════╗");
    log("║  Durable Copilot SDK — Headless Test Harness ║");
    log("╚══════════════════════════════════════════════╝");
    log(`Mode: ${isRemote ? "Remote (AKS)" : `Local (${numWorkers} workers)`}`);
    log(`Store: ${store.includes("postgres") ? "PostgreSQL" : store}`);
    log("");

    const engine = new CoreEngine();

    // Wire up event handlers for visibility
    engine.onStatusChange = (orchId, status) => {
        const short = orchId.slice(8, 16);
        log(`  [${short}] status → ${status}`, LOG_COLORS.gray);
    };

    engine.onMessage = (orchId, content) => {
        const short = orchId.slice(8, 16);
        const preview = content.slice(0, 80).replace(/\n/g, " ");
        log(`  [${short}] 💬 ${preview}`, LOG_COLORS.gray);
    };

    try {
        await engine.start();
        log("");

        // Run scenarios sequentially
        const basicOrchId = await testBasicSendReceive(engine);

        const timerOrchIds = await testRecurringTimers(engine);
        const allOrchIds = [basicOrchId, ...timerOrchIds];

        await testInterruptAndChange(engine, timerOrchIds);

        await testSessionSwitching(engine, timerOrchIds);

        await testObserverLifecycle(engine, basicOrchId);

        await testListOrchestrations(engine, allOrchIds.length);

        // Print summary
        log("\n╔══════════════════════════════════════════════╗");
        log(`║  Results: ${passCount} passed, ${failCount} failed${" ".repeat(Math.max(0, 21 - String(passCount).length - String(failCount).length))}║`);
        log("╚══════════════════════════════════════════════╝");

        if (failCount > 0) {
            log("\nFailed assertions need investigation.", LOG_COLORS.red);
        } else {
            log("\nAll tests passed! Core engine is solid.", LOG_COLORS.green);
        }

        // Print full chat buffers for inspection
        log("\n─── Chat Buffer Dump ───", LOG_COLORS.gray);
        for (const orchId of allOrchIds) {
            const short = orchId.slice(8, 16);
            const buf = engine.getChatBuffer(orchId);
            log(`\n[${short}] (${buf.length} entries):`, LOG_COLORS.gray);
            for (const line of buf.slice(-10)) {
                log(`  ${line.slice(0, 120)}`, LOG_COLORS.gray);
            }
        }

        // Cleanup
        await testCleanup(engine, allOrchIds);
        await engine.stop();
    } catch (err) {
        logError(`Fatal: ${err.message}`);
        console.error(err.stack);
        try { await engine.stop(); } catch {}
        process.exit(1);
    }

    process.exit(failCount > 0 ? 1 : 0);
}

main();
