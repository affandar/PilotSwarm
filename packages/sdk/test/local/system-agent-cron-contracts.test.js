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
        assertIncludes(waitTool.description, "Do NOT keep burning tokens in an in-turn polling loop", "wait should forbid in-turn polling loops");
        assertIncludes(cronTool.description, "periodic monitoring", "cron should advertise recurring schedules");
        assertIncludes(cronTool.description, "keep pursuing a goal autonomously until it is done", "cron should frame recurring work as autonomous goal pursuit");
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

    it("hardens ambiguous long-running work guidance for parent and sub-agents", () => {
        const defaultAgent = readRepoFile("packages/sdk/plugins/system/agents/default.agent.md");
        const orchestration = readRepoFile("packages/sdk/src/orchestration.ts");
        const sessionProxy = readRepoFile("packages/sdk/src/session-proxy.ts");

        assertIncludes(defaultAgent, "ask the user a brief clarifying question", "default agent should ask when long-running intent is ambiguous");
        assertIncludes(defaultAgent, "autonomous, goal-driven agent", "default agent should describe autonomous goal-driven behavior");
        assertIncludes(defaultAgent, "If in doubt about whether to stop or keep going, keep going.", "default agent should prefer staying alive when progress is still possible");

        assertIncludes(orchestration, "use the \\`wait\\`, \\`wait_on_worker\\`, or \\`cron\\` tools", "sub-agent preamble should allow cron for recurring work");
        assertIncludes(orchestration, "report that ambiguity back to the parent", "sub-agent preamble should route long-running ambiguity to the parent");
        assertIncludes(orchestration, "Prefer using \\`store_fact\\` for larger structured context handoffs", "sub-agent preamble should push large context handoffs into facts");
        assertIncludes(orchestration, "pass fact keys or \\`read_facts\\` pointers in messages/prompts", "sub-agent preamble should tell children to send pointers instead of blobs");
        assert(!orchestration.includes("NEVER use setTimeout, sleep, setInterval, cron, or any other timing mechanism."), "latest orchestration should not forbid cron for sub-agents");

        assertIncludes(sessionProxy, "use the \\`wait\\`, \\`wait_on_worker\\`, or \\`cron\\` tools", "session-proxy sub-agent preamble should allow cron for recurring work");
        assertIncludes(sessionProxy, "report that ambiguity back to the parent", "session-proxy sub-agent preamble should route long-running ambiguity to the parent");
        assertIncludes(sessionProxy, "Prefer using \\`store_fact\\` for larger structured context handoffs", "session-proxy should push large context handoffs into facts");
        assertIncludes(sessionProxy, "pass fact keys or \\`read_facts\\` pointers in messages/prompts", "session-proxy should tell children to send pointers instead of blobs");
        assert(!sessionProxy.includes("NEVER use setTimeout, sleep, setInterval, cron, or any other timing mechanism."), "session-proxy should not forbid cron for sub-agents");
    });

    it("releases affinity for cron waits and renders cron wait state in the TUI", () => {
        const orchestration = readRepoFile("packages/sdk/src/orchestration.ts");
        const selectors = readRepoFile("packages/ui-core/src/selectors.js");

        assertIncludes(orchestration, 'yield* dehydrateForNextTurn("cron", true);', "cron waits should release worker affinity");
        assertIncludes(orchestration, "[orch] cron timer:", "cron waits should emit a dedicated trace event");
        assertIncludes(selectors, 'case "cron_waiting": return "yellow";', "cron wait sessions should render like normal waiting rows");
        assertIncludes(selectors, 'detail: `ZZ ${formatDehydrateSequenceDetail(event, preview)}`.trim()', "sequence view should show a reason-prefixed dehydration marker");
        assertIncludes(selectors, 'text: `[cron ${formatHumanDurationSeconds(session.cronInterval)}]`', "session rows should include a cron badge");
    });

    it("keeps cron, collapse, and unread badges in a stable order", () => {
        const selectors = readRepoFile("packages/ui-core/src/selectors.js");

        assertIncludes(selectors, "for (const badge of [", "session rows should build badges in one canonical place");
        assertIncludes(selectors, "getCronBadge(session),", "session-row suffixes should lead with the cron badge");
        assertIncludes(selectors, "getContextListBadge(session?.contextUsage),", "context badge should follow the cron badge");
        assertIncludes(selectors, "getCollapseBadge(session?.sessionId, entry, totalDescendantCounts, visibleDescendantCounts),", "collapse badge should follow cron and context badges");
    });

    it("keeps cron rows non-magenta in the session list while preserving the cron badge", () => {
        const selectors = readRepoFile("packages/ui-core/src/selectors.js");

        assertIncludes(selectors, 'case "cron_waiting": return "yellow";', "session-list cron waits should use the normal waiting row color");
        assertIncludes(selectors, 'case "cron_waiting": return "~";', "session-list cron icon should stay the regular wait icon");
        assertIncludes(selectors, 'color: "magenta"', "cron badge itself should stay magenta");
    });

});
