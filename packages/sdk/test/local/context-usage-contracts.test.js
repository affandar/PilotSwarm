import { describe, it } from "vitest";
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

        assertIncludes(orchestration, 'export const CURRENT_ORCHESTRATION_VERSION = "1.0.31";', "latest orchestration should be versioned for context usage changes");
        assertIncludes(orchestration, "function updateContextUsageFromEvents(", "orchestration should derive context usage from turn events");
        assertIncludes(orchestration, "...(contextUsage ? { contextUsage } : {}),", "context usage should be carried into status and continueAsNew state");
        assertIncludes(registry, '{ version: "1.0.30", handler: durableSessionOrchestration_1_0_30 },', "previous orchestration version should stay frozen");
    });

    it("renders context usage in the TUI header and warning badge in the session list", () => {
        const tui = readRepoFile("packages/cli/cli/tui.js");
        const tuiHelpers = readRepoFile("packages/cli/cli/context-usage.js");
        const client = readRepoFile("packages/sdk/src/client.ts");
        const management = readRepoFile("packages/sdk/src/management-client.ts");

        assertIncludes(tui, 'from "./context-usage.js"', "TUI should import shared context-usage helpers");
        assertIncludes(tuiHelpers, "export function formatContextHeaderBadge", "chat header should have a shared context meter helper");
        assertIncludes(tuiHelpers, 'ctx ${formatTokenCount(contextUsage.currentTokens)}/${formatTokenCount(contextUsage.tokenLimit)} ${percent}%', "chat header should show compact context usage");
        assertIncludes(tuiHelpers, 'return ` {${color}-fg}[ctx ${percent}%]{/${color}-fg}`;', "session list should show a compact warning badge");
        assertIncludes(tuiHelpers, 'export function formatCompactionActivityMarkup', "compaction lifecycle should be rendered as explicit activity lines");
        assertIncludes(client, "contextUsage: customStatus?.contextUsage", "client session info should surface context usage from status");
        assertIncludes(management, "contextUsage: customStatus?.contextUsage", "management getSession should surface context usage from status");
    });
});
