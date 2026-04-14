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

describe("context usage contracts", () => {
    it("exposes context usage in the public SDK types", () => {
        const types = readRepoFile("packages/sdk/src/types.ts");
        const index = readRepoFile("packages/sdk/src/index.ts");

        assertIncludes(types, "export interface SessionContextUsage", "types should define a shared context usage snapshot");
        assertIncludes(types, "contextUsage?: SessionContextUsage;", "session info and status should expose context usage");
        assertIncludes(index, "SessionContextUsage", "SDK index should re-export context usage types");
    });

    it("carries context usage through orchestration state and custom status", () => {
        const orchestration = readRepoFile("packages/sdk/src/orchestration.ts");
        const registry = readRepoFile("packages/sdk/src/orchestration-registry.ts");
        const versions = readRepoFile("packages/sdk/src/orchestration-version.ts");

        assertIncludes(versions, 'export const DURABLE_SESSION_LATEST_VERSION = "', "shared version file should define the canonical latest version");
        assertIncludes(orchestration, "export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;", "orchestration should read the latest version from the shared constant");
        assertIncludes(orchestration, "function updateContextUsageFromEvents(", "orchestration should derive context usage from turn events");
        assertIncludes(orchestration, "...(contextUsage ? { contextUsage } : {}),", "context usage should be carried into status and continueAsNew state");
        assertIncludes(registry, "version: DURABLE_SESSION_LATEST_VERSION", "registry should expose the latest orchestration via the shared alias");
        expect(registry).toMatch(
            /\{ version: "\d+\.\d+\.\d+", handler: durableSessionOrchestration_\d+_\d+_\d+ \},/,
        );
    });

    it("renders context usage in the TUI header and warning badge in the session list", () => {
        const selectors = readRepoFile("packages/ui-core/src/selectors.js");
        const tuiHelpers = readRepoFile("packages/ui-core/src/context-usage.js");
        const client = readRepoFile("packages/sdk/src/client.ts");
        const management = readRepoFile("packages/sdk/src/management-client.ts");

        assertIncludes(selectors, "getContextHeaderBadge", "selectors should import shared context-usage helpers");
        assertIncludes(tuiHelpers, "export function getContextHeaderBadge", "chat header should have a shared context meter helper");
        assertIncludes(tuiHelpers, 'text: `ctx ${formatTokenCount(contextUsage.currentTokens)}/${formatTokenCount(contextUsage.tokenLimit)} ${percent}%`', "chat header should show compact context usage");
        assertIncludes(tuiHelpers, 'text: `[ctx ${percent}%]`', "session list should show a compact warning badge");
        assertIncludes(tuiHelpers, "export function formatCompactionActivityRuns", "compaction lifecycle should be rendered as explicit activity lines");
        assertIncludes(client, "contextUsage: customStatus?.contextUsage", "client session info should surface context usage from status");
        assertIncludes(management, "contextUsage: customStatus?.contextUsage", "management getSession should surface context usage from status");
    });
});
