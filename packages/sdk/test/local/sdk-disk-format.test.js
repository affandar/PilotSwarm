/**
 * Verifies that the Copilot SDK actually writes per-session state into the
 * `sessionStateDir` we hand it, not into the spawning process's $HOME/.copilot.
 *
 * This locks down the `COPILOT_HOME` plumbing in `SessionManager.ensureClient()`
 * — without that env var the CLI ignores `SessionConfig.configDir` and writes
 * to `~/.copilot/session-state/<id>/`, which silently breaks test isolation
 * and any deployment that mounts state on a non-default path.
 */

import { describe, it, beforeAll } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testStateLandsInSessionStateDir(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        // Drive at least one turn so events.jsonl + session.db get created.
        const reply = await session.sendAndWait("Reply with the single word OK.", TIMEOUT);
        assert(reply && reply.length > 0, "Expected non-empty reply from one-turn fixture");

        const sessionDir = join(env.sessionStateDir, session.sessionId);
        assert(
            existsSync(sessionDir),
            `Expected SDK to write session state under ${sessionDir}; instead the directory does not exist. ` +
            `The CLI is probably ignoring COPILOT_HOME and writing to ~/.copilot/session-state.`,
        );

        const entries = readdirSync(sessionDir);
        console.log(`  ${session.sessionId}/ contains: ${entries.sort().join(", ")}`);

        // workspace.yaml is the canonical post-create signal across CLI 1.0.x.
        assert(
            entries.includes("workspace.yaml"),
            `Expected workspace.yaml in ${sessionDir}; got [${entries.join(", ")}]`,
        );
    });
}

async function testNoStaleLockAfterArchive(env) {
    // Drive a real graceful-shutdown dehydrate using the same plumbing the
    // multi-worker tests use, so we know an archive is actually produced.
    const { PilotSwarmClient, PilotSwarmWorker } = await import("../helpers/local-workers.js");
    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "disk-format-worker",
        disableManagementAgents: true,
    });
    await worker.start();

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await client.start();

    let sessionId;
    try {
        const session = await client.createSession(ONEWORD_CONFIG);
        sessionId = session.sessionId;
        const reply = await session.sendAndWait("Reply with the single word OK.", TIMEOUT);
        assert(reply && reply.length > 0, "Expected non-empty reply");
    } finally {
        await client.stop();
        await worker.gracefulShutdown();
    }

    const archivePath = join(env.baseDir, "session-store", `${sessionId}.tar.gz`);
    assert(existsSync(archivePath), `Expected dehydrate archive at ${archivePath}`);

    const { execSync } = await import("node:child_process");
    const listing = execSync(`tar tzf "${archivePath}"`, { encoding: "utf8" });
    const stale = listing.split("\n").filter((line) => /\/inuse\.[^/]+\.lock$/.test(line));
    assertEqual(
        stale.length,
        0,
        `Expected no inuse.<pid>.lock entries in ${archivePath}; found:\n${stale.join("\n")}`,
    );

    // Sanity: the archive should still contain workspace.yaml.
    assert(
        listing.includes(`${sessionId}/workspace.yaml`),
        `Expected ${sessionId}/workspace.yaml in archive; got listing:\n${listing}`,
    );
}

describe("Level 1c: SDK Disk Format", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("session state lands in our sessionStateDir", { timeout: TIMEOUT }, async () => {
        await testStateLandsInSessionStateDir(getEnv());
    });

    it("dehydrate archive excludes inuse.<pid>.lock", { timeout: TIMEOUT }, async () => {
        await testNoStaleLockAfterArchive(getEnv());
    });
});
