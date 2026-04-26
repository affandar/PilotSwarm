/**
 * Heavier end-to-end scenarios.
 *
 * Goals — exercise the Postgres SessionFs provider under load that resembles
 * real Copilot CLI usage:
 *
 *   1. Multi-turn conversation that builds context across turns.
 *   2. A custom tool that the agent is required to call.
 *   3. The CLI's plan/todo flow, which writes through SessionFs and (for the
 *      newer CLI builds) backs onto SQLite (`session.db`).
 *   4. A heavy-content turn that produces a large structured response and
 *      grows `events.jsonl` substantially.
 *
 * Each test reuses one CopilotClient + Store but creates a fresh session,
 * so failures are isolated and provider-call counts are per-session.
 *
 * Requires DATABASE_URL and GITHUB_TOKEN in .env. Skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { createPgSessionFsHandler } from "../src/index.js";
import { makeStore } from "./helpers.js";

const TURN_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 600_000;

const HAVE_TOKEN = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
const HAVE_DB = Boolean(process.env.DATABASE_URL);
const maybe = (HAVE_TOKEN && HAVE_DB) ? describe : describe.skip;

/**
 * Wrap createPgSessionFsHandler so we can count and inspect provider calls
 * during each session without losing the underlying behavior.
 */
function instrumentedHandler(store, sessionId, calls) {
    const real = createPgSessionFsHandler({ store, sessionId });
    const proxy = {};
    for (const k of Object.keys(real)) {
        proxy[k] = async (...args) => {
            calls.push({ verb: k, path: typeof args[0] === "string" ? args[0] : undefined });
            return real[k](...args);
        };
    }
    return proxy;
}

async function runOneTurn(session, prompt) {
    return await session.sendAndWait({ prompt }, TURN_TIMEOUT_MS);
}

function replyText(response) {
    return response?.data?.content ?? "";
}

/** All node rows in PG for one session, as `{ path, type, sizeBytes }`. */
async function listFsRows(store, sessionId) {
    const r = await store.pool.query(
        `SELECT path, node_type, size_bytes, pending_segment_bytes
            FROM "${store.schema}".sessionfs_nodes
            WHERE session_id = $1 ORDER BY path`,
        [sessionId],
    );
    return r.rows.map((row) => ({
        path: row.path,
        type: row.node_type,
        sizeBytes: Number(row.size_bytes) + Number(row.pending_segment_bytes),
    }));
}

maybe("e2e (heavy): Postgres SessionFs under realistic Copilot workloads", () => {
    let store, schema, cleanup;
    let client;
    let workDir;
    let sessionStateHostDir;

    beforeAll(async () => {
        ({ store, schema, cleanup } = await makeStore());
        workDir = mkdtempSync(join(tmpdir(), "pgsessionfs-heavy-cwd-"));
        sessionStateHostDir = mkdtempSync(join(tmpdir(), "pgsessionfs-heavy-state-"));
        client = new CopilotClient({
            gitHubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
            logLevel: "error",
            sessionFs: {
                initialCwd: workDir,
                sessionStatePath: sessionStateHostDir,
                conventions: "posix",
            },
        });
    });

    afterAll(async () => {
        try { await client?.disconnect?.(); } catch { /* ignore */ }
        await cleanup();
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { rmSync(sessionStateHostDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ───────────────────────────────────────────────────────────────────
    // 1. Multi-turn context retention
    // ───────────────────────────────────────────────────────────────────
    it("preserves context across 3 turns and grows events.jsonl monotonically", async () => {
        const calls = [];
        const session = await client.createSession({
            onPermissionRequest: () => ({ allow: true, level: "always" }),
            createSessionFsHandler: (s) => instrumentedHandler(store, s.sessionId, calls),
        });

        const sizes = [];
        async function snapshotEventsSize() {
            const rows = await listFsRows(store, session.sessionId);
            const ev = rows.find((r) => r.path.endsWith("/events.jsonl"));
            sizes.push(ev?.sizeBytes ?? 0);
        }

        const r1 = await runOneTurn(session, "My favorite color is cobalt blue. Just acknowledge with a single short sentence.");
        await snapshotEventsSize();
        const r2 = await runOneTurn(session, "What did I say my favorite color was? Reply with just the color name.");
        await snapshotEventsSize();
        const r3 = await runOneTurn(session, "Now my favorite is crimson. List both colors I have ever told you about, separated by ' and '.");
        await snapshotEventsSize();

        const t1 = replyText(r1).toLowerCase();
        const t2 = replyText(r2).toLowerCase();
        const t3 = replyText(r3).toLowerCase();

        // eslint-disable-next-line no-console
        console.log("  multi-turn replies:");
        // eslint-disable-next-line no-console
        console.log(`    1: ${t1.slice(0, 80)}`);
        // eslint-disable-next-line no-console
        console.log(`    2: ${t2.slice(0, 80)}`);
        // eslint-disable-next-line no-console
        console.log(`    3: ${t3.slice(0, 80)}`);
        // eslint-disable-next-line no-console
        console.log(`  events.jsonl size after each turn: ${sizes.join(", ")} bytes`);
        // eslint-disable-next-line no-console
        console.log(`  total provider calls across 3 turns: ${calls.length}`);

        // Turn 2 must remember turn 1.
        expect(t2).toContain("blue");
        // Turn 3 must mention both.
        expect(t3).toContain("blue");
        expect(t3).toContain("crimson");

        // Provider was exercised across all turns.
        expect(calls.length).toBeGreaterThan(5);
        // events.jsonl exists and grew monotonically.
        expect(sizes.length).toBe(3);
        expect(sizes[0]).toBeGreaterThan(0);
        expect(sizes[1]).toBeGreaterThan(sizes[0]);
        expect(sizes[2]).toBeGreaterThan(sizes[1]);
    }, TEST_TIMEOUT_MS);

    // ───────────────────────────────────────────────────────────────────
    // 2. Forced custom tool use
    // ───────────────────────────────────────────────────────────────────
    it("agent calls a custom tool and uses its result", async () => {
        let toolCalls = 0;
        const calls = [];
        const session = await client.createSession({
            onPermissionRequest: () => ({ allow: true, level: "always" }),
            createSessionFsHandler: (s) => instrumentedHandler(store, s.sessionId, calls),
            tools: [
                defineTool("get_secret_number", {
                    description: "Returns the user's secret number. The agent MUST call this tool when the user asks for the secret number.",
                    parameters: { type: "object", properties: {}, additionalProperties: false },
                    skipPermission: true,
                    handler: async () => {
                        toolCalls += 1;
                        return { secret_number: 73101 };
                    },
                }),
            ],
        });

        const reply = replyText(await runOneTurn(
            session,
            "Use the get_secret_number tool, then tell me the exact integer it returned. Just answer with the number.",
        ));
        // eslint-disable-next-line no-console
        console.log(`  custom-tool reply: ${reply.slice(0, 120)}`);
        // eslint-disable-next-line no-console
        console.log(`  custom-tool invocations: ${toolCalls}`);

        expect(toolCalls).toBeGreaterThan(0);
        expect(reply).toContain("73101");
        // The tool round-trip should have produced provider activity too.
        expect(calls.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT_MS);

    // ───────────────────────────────────────────────────────────────────
    // 3. Plan / todo flow (exercises the CLI's task/plan tool, which
    //    in newer builds writes through SessionFs and lands in session.db).
    // ───────────────────────────────────────────────────────────────────
    it("plan/todo workflow writes additional session state through the provider", async () => {
        const calls = [];
        const session = await client.createSession({
            onPermissionRequest: () => ({ allow: true, level: "always" }),
            createSessionFsHandler: (s) => instrumentedHandler(store, s.sessionId, calls),
        });

        const r1 = await runOneTurn(session, [
            "Use your task/todo tool to create a 5-step plan for baking a chocolate cake.",
            "Each step must be 1 short sentence. Then mark step 1 as completed.",
            "Reply with the final plan as a numbered list, indicating which step is done.",
        ].join(" "));
        const t1 = replyText(r1);

        const r2 = await runOneTurn(session,
            "Now mark step 2 of the cake plan as completed and show me the updated list.",
        );
        const t2 = replyText(r2);

        const rows = await listFsRows(store, session.sessionId);
        // eslint-disable-next-line no-console
        console.log("  plan-flow PG nodes after 2 turns:");
        for (const row of rows) {
            // eslint-disable-next-line no-console
            console.log(`    ${row.type} ${row.path} (${row.sizeBytes} bytes)`);
        }

        // Replies should look like a numbered plan.
        expect(/1\.|step\s*1/i.test(t1)).toBe(true);
        expect(t2.length).toBeGreaterThan(20);

        // Provider activity should be substantially higher than a 1-turn echo.
        expect(calls.length).toBeGreaterThan(8);

        // Beyond events.jsonl, the plan/todo flow should have written at
        // least one additional file (plan.md, session.db, etc.). If this
        // assertion ever fails it means the CLI used in-memory plan state
        // for this build — record that as a finding rather than masking it.
        const fileNodes = rows.filter((r) => r.type === "file");
        // eslint-disable-next-line no-console
        console.log(`  file nodes in PG: ${fileNodes.length}`);
        expect(fileNodes.length).toBeGreaterThanOrEqual(1);
    }, TEST_TIMEOUT_MS);

    // ───────────────────────────────────────────────────────────────────
    // 4. Heavy content
    // ───────────────────────────────────────────────────────────────────
    it("produces a large structured response and grows events.jsonl past 10 KB", async () => {
        const calls = [];
        const session = await client.createSession({
            onPermissionRequest: () => ({ allow: true, level: "always" }),
            createSessionFsHandler: (s) => instrumentedHandler(store, s.sessionId, calls),
        });

        const reply = replyText(await runOneTurn(session, [
            "Write a Markdown reference document with the following structure:",
            "## 1xx, ## 2xx, ## 3xx, ## 4xx, ## 5xx — one section per HTTP status class.",
            "Inside each section, list at least 5 specific status codes with their name and a one-sentence description.",
            "End with a ## Summary section that has 3 short bullet points.",
            "No prose outside those sections.",
        ].join(" ")));

        const headingCount = (reply.match(/^##\s+/gm) ?? []).length;
        const rows = await listFsRows(store, session.sessionId);
        const ev = rows.find((r) => r.path.endsWith("/events.jsonl"));
        const evSize = ev?.sizeBytes ?? 0;

        // eslint-disable-next-line no-console
        console.log(`  heavy reply length: ${reply.length} chars, ## headings: ${headingCount}`);
        // eslint-disable-next-line no-console
        console.log(`  events.jsonl size in PG: ${evSize} bytes`);

        expect(headingCount).toBeGreaterThanOrEqual(6); // 5 sections + summary
        expect(reply.length).toBeGreaterThan(800);
        expect(evSize).toBeGreaterThan(10_000);
    }, TEST_TIMEOUT_MS);
});
