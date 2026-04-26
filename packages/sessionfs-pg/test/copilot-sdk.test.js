/**
 * End-to-end: drive a real Copilot SDK session whose entire SessionFs
 * is backed by the Postgres provider. No tarball, no local disk.
 *
 * Requires DATABASE_URL and GITHUB_TOKEN in .env. Skips otherwise.
 *
 * What we assert:
 *   - The CLI starts a session, runs a one-word turn, and disconnects.
 *   - At dehydrate time the Postgres store contains real session state
 *     (workspace.yaml etc.) — i.e., the SDK actually routed writes
 *     through our provider.
 *   - The conversation reply is non-empty.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { createPgSessionFsHandler } from "../src/index.js";
import { makeStore } from "./helpers.js";

const TIMEOUT_MS = 180_000;

const HAVE_TOKEN = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
const HAVE_DB = Boolean(process.env.DATABASE_URL);

const maybe = (HAVE_TOKEN && HAVE_DB) ? describe : describe.skip;

maybe("e2e: Copilot SDK session backed by Postgres SessionFs", () => {
    let store, schema, cleanup;
    let client;
    let workDir;
    let sessionStateHostDir;

    beforeAll(async () => {
        ({ store, schema, cleanup } = await makeStore());
        // Both initialCwd and sessionStatePath are validated against the host
        // filesystem on session.create in @github/copilot 1.0.36 (the SDK
        // host-mkdirs sessionStatePath before any SessionFs RPC). After that,
        // every fs op the CLI emits during the turn is routed through our
        // provider, with paths expressed *relative* to sessionStatePath
        // (root within the SessionFs view comes through as "").
        workDir = mkdtempSync(join(tmpdir(), "pgsessionfs-cwd-"));
        sessionStateHostDir = mkdtempSync(join(tmpdir(), "pgsessionfs-state-"));
    });

    afterAll(async () => {
        try { await client?.disconnect?.(); } catch { /* ignore */ }
        await cleanup();
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { rmSync(sessionStateHostDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("creates a session, runs one turn, and persists files in PG", async () => {
        client = new CopilotClient({
            gitHubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
            logLevel: "error",
            sessionFs: {
                initialCwd: workDir,
                sessionStatePath: sessionStateHostDir,
                conventions: "posix",
            },
        });

        // Per-session handler factory. Uses the package's built-in handler
        // helper (which calls the SDK with the positional arg shape the
        // Copilot CLI actually uses). We wrap it just to count provider
        // calls for diagnostics.
        const providerCalls = [];
        const session = await client.createSession({
            onPermissionRequest: () => ({ allow: true, level: "always" }),
            createSessionFsHandler: (s) => {
                const real = createPgSessionFsHandler({ store, sessionId: s.sessionId });
                const proxy = {};
                for (const k of Object.keys(real)) {
                    proxy[k] = async (...args) => {
                        providerCalls.push(`${k} ${args[0] ?? ""}`);
                        return real[k](...args);
                    };
                }
                return proxy;
            },
        });

        // Fire one short turn. We only need the SDK to do real I/O.
        const events = [];
        const off = session.on((ev) => { events.push(ev.type); });
        let response;
        try {
            response = await session.sendAndWait({
                prompt: "Reply with the single word OK.",
            });
        } finally {
            try { off(); } catch { /* ignore */ }
        }

        const reply = response?.data?.content ?? "";
        // eslint-disable-next-line no-console
        console.log(`  Copilot reply: ${JSON.stringify(reply).slice(0, 100)}`);
        // eslint-disable-next-line no-console
        console.log(`  SessionFs provider calls: ${providerCalls.length}`);
        for (const c of providerCalls.slice(0, 30)) {
            // eslint-disable-next-line no-console
            console.log(`    ${c}`);
        }
        expect(typeof reply).toBe("string");
        expect(reply.length).toBeGreaterThan(0);
        // Sanity: the SDK should have emitted at least one event during the turn.
        expect(events.length).toBeGreaterThan(0);

        // The SDK should have called our provider at least once during the turn.
        expect(providerCalls.length).toBeGreaterThan(0);

        // Verify the SDK actually used the provider — at least one node row
        // must exist for this session, and at least one of them should be a
        // file (workspace.yaml or events.jsonl style).
        const r = await store.pool.query(
            `SELECT path, node_type
                FROM "${schema}".sessionfs_nodes
                WHERE session_id = $1
                ORDER BY path`,
            [session.sessionId],
        );
        const paths = r.rows.map((row) => `${row.node_type}:${row.path}`);
        // Surface what the CLI actually wrote so test failures are diagnosable.
        // eslint-disable-next-line no-console
        console.log(`  PG SessionFs after one turn (${session.sessionId}):`);
        for (const p of paths) console.log(`    ${p}`);
        expect(r.rows.length).toBeGreaterThan(1);
        expect(r.rows.some((row) => row.node_type === "file")).toBe(true);
    }, TIMEOUT_MS);
});
