/**
 * Verifies the dehydrate "happy path": the post-disconnect snapshot is
 * archived directly, with no fall-through to the pre-destroy checkpoint.
 *
 * Before the @github/copilot 1.0.36 audit, the dehydrate flow looked in the
 * wrong directory after `destroy()` and always failed three times before
 * recovering via the pre-destroy checkpoint. With COPILOT_HOME plumbed into
 * the spawned CLI, the SDK actually writes into our `sessionStateDir` and
 * the post-disconnect snapshot succeeds on the first try.
 *
 * If this test starts logging "falling back to pre-destroy checkpoint" again,
 * we have regressed the location plumbing or the dehydrate gate logic.
 */

import { describe, it, beforeAll, afterEach } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

function captureWarn() {
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => {
        try { lines.push(args.map(String).join(" ")); } catch {}
        original.apply(console, args);
    };
    return {
        lines,
        restore() { console.warn = original; },
    };
}

async function testNoFallbackOnHappyPath(env) {
    const cap = captureWarn();
    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);
            const reply = await session.sendAndWait("Reply with the single word OK.", TIMEOUT);
            assert(reply && reply.length > 0, "Expected non-empty reply");
            // Closing the client during teardown drives the dehydrate path.
        });
    } finally {
        cap.restore();
    }

    const fallbackLines = cap.lines.filter((line) =>
        line.includes("falling back to pre-destroy checkpoint")
        || line.includes("session-store dehydrate snapshot missing after destroy"),
    );
    const missingSnapshotLines = cap.lines.filter((line) =>
        line.includes("Session state directory not ready during dehydrate"),
    );

    if (fallbackLines.length > 0 || missingSnapshotLines.length > 0) {
        console.log("  Captured warnings:");
        for (const line of cap.lines) console.log(`    ${line}`);
    }

    assertEqual(
        fallbackLines.length,
        0,
        "Expected no pre-destroy-checkpoint fallback on the happy dehydrate path; " +
        "the post-disconnect snapshot should succeed on the first attempt.",
    );
    assertEqual(
        missingSnapshotLines.length,
        0,
        "Expected no 'Session state directory not ready during dehydrate' warnings; " +
        "the SDK should have written workspace.yaml into sessionStateDir before disconnect.",
    );
}

describe("Level 1c: Dehydrate happy path", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("no fallback to pre-destroy checkpoint", { timeout: TIMEOUT }, async () => {
        await testNoFallbackOnHappyPath(getEnv());
    });
});
