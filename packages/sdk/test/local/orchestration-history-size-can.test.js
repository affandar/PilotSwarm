import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("orchestration history-size continueAsNew contracts", () => {
    it("checks orchestration history size every three loops and rolls at 800KB using the normal CAN path", () => {
        const orchestration = readRepoFile("packages/sdk/src/orchestration.ts");

        assertIncludes(
            orchestration,
            "const MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES = 800 * 1024;",
            "orchestration should use an 800KB history-size threshold",
        );
        assertIncludes(
            orchestration,
            "const HISTORY_SIZE_CHECK_INTERVAL_ITERATIONS = 3;",
            "orchestration should only check history size every three loop iterations",
        );
        assertIncludes(
            orchestration,
            "if (loopIteration % HISTORY_SIZE_CHECK_INTERVAL_ITERATIONS === 0) {",
            "history-size checks should be cadence-gated by loop iteration count",
        );
        expect(orchestration).toMatch(
            /if \(historySizeBytes >= MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES\) \{[\s\S]*?yield\* versionedContinueAsNew\(continueInput\(\)\);[\s\S]*?return "";/,
        );
    });

    it("plumbs orchestration stats into the runtime manager proxy", () => {
        const sessionProxy = readRepoFile("packages/sdk/src/session-proxy.ts");

        assertIncludes(
            sessionProxy,
            "getOrchestrationStats(sessionId: string) {",
            "session manager proxy should expose orchestration stats to the orchestration",
        );
        assertIncludes(
            sessionProxy,
            'return ctx.scheduleActivity("getOrchestrationStats", { sessionId });',
            "orchestration stats should be fetched through a dedicated runtime activity",
        );
        assertIncludes(
            sessionProxy,
            'runtime.registerActivity("getOrchestrationStats", async (',
            "worker runtime should register a getOrchestrationStats activity",
        );
        assertIncludes(
            sessionProxy,
            "return await managementClient.getOrchestrationStats(input.sessionId);",
            "worker activity should delegate to the management client for stats lookup",
        );
    });
});
