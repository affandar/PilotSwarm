import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedSession } from "../../src/managed-session.ts";
import { assert, assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("system agent cron contracts", () => {
    it("exposes wait as a one-shot timer and cron as the recurring timer", () => {
        const tools = ManagedSession.systemToolDefs();
        const waitTool = tools.find((tool) => tool.name === "wait");
        const cronTool = tools.find((tool) => tool.name === "cron");

        assert(waitTool, "wait tool should exist");
        assert(cronTool, "cron tool should exist");
        assertIncludes(waitTool.description, "inside a turn", "wait should be scoped to one-shot in-turn delays");
        assertIncludes(waitTool.description, "use the cron tool instead", "wait should redirect recurring schedules to cron");
        assertIncludes(cronTool.description, "periodic monitoring", "cron should advertise recurring schedules");
    });

    it("documents recurring management agents in terms of cron, not wait loops", () => {
        const pilotswarm = readRepoFile("packages/sdk/plugins/mgmt/agents/pilotswarm.agent.md");
        const sweeper = readRepoFile("packages/sdk/plugins/mgmt/agents/sweeper.agent.md");
        const resourcemgr = readRepoFile("packages/sdk/plugins/mgmt/agents/resourcemgr.agent.md");
        const factsManager = readRepoFile("packages/sdk/plugins/mgmt/agents/facts-manager.agent.md");

        assertIncludes(pilotswarm, 'cron(seconds=60, reason="supervise permanent PilotSwarm system agents")', "pilotswarm should maintain its supervision loop via cron");
        assertIncludes(sweeper, "cron(seconds=60", "sweeper should establish a recurring cron schedule");
        assertIncludes(resourcemgr, "cron(seconds=300", "resource manager should establish a recurring cron schedule");
        assertIncludes(factsManager, "cron(seconds=<interval>", "facts manager should schedule curation via cron");
        assert(!pilotswarm.includes("For ANY waiting, use the `wait` tool."), "pilotswarm should not require wait for its main loop");
        assert(!sweeper.includes("ALWAYS end every turn by calling the wait tool"), "sweeper should not require wait for its main loop");
        assert(!resourcemgr.includes("ALWAYS end every turn by calling the wait tool"), "resource manager should not require wait for its main loop");
        assert(!factsManager.includes("scheduling your next cycle via `wait`"), "facts manager should not require wait for its main loop");
    });

    it("releases affinity for cron waits and renders cron wait state in the TUI", () => {
        const orchestration = readRepoFile("packages/sdk/src/orchestration.ts");
        const tui = readRepoFile("packages/cli/cli/tui.js");

        assertIncludes(orchestration, 'yield* dehydrateForNextTurn("cron", true);', "cron waits should release worker affinity");
        assertIncludes(orchestration, "[orch] cron timer:", "cron waits should emit a dedicated trace event");
        assertIncludes(tui, 'case "cron_waiting": return "magenta";', "cron wait sessions should render in magenta");
        assertIncludes(tui, 'detail: `ZZ ${evt.data?.reason ?? ""}`', "sequence view should show a reason-prefixed dehydration marker");
        assertIncludes(tui, "{magenta-fg}~ cron{/magenta-fg}", "worker legend should include cron wait state");
    });

    it("keeps cron, collapse, and unread badges in a stable order", () => {
        const tui = readRepoFile("packages/cli/cli/tui.js");

        assertIncludes(tui, "function formatSessionListSuffixes(orchId)", "session rows should use a shared suffix formatter");
        assertIncludes(tui, 'return `${cronBadge}${contextBadge}${collapseBadge}${changeSuffix}`;', "session-row suffixes should have one canonical order");
        assertIncludes(tui, "const badgeSuffix = formatSessionListSuffixes(id);", "both render paths should use the shared suffix formatter");
    });

    it("keeps cron rows non-magenta in the session list while preserving the cron badge", () => {
        const tui = readRepoFile("packages/cli/cli/tui.js");

        assertIncludes(tui, 'return state === "cron_waiting" ? "yellow" : getSessionStateColor(state);', "session-list rows should treat cron waits like normal waiting rows");
        assertIncludes(tui, '? "{yellow-fg}~{/yellow-fg}"', "session-list cron icon should stay non-magenta");
        assertIncludes(tui, 'return ` {magenta-fg}[cron ${formatHumanDurationSeconds(cron.interval)}]{/magenta-fg}`;', "cron badge itself should stay magenta");
    });

});
