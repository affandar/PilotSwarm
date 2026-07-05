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

    it("documents management agent scheduling as reactive or low-frequency cron", () => {
        const pilotswarm = readRepoFile("packages/sdk/plugins/mgmt/agents/pilotswarm.agent.md");
        const sweeper = readRepoFile("packages/sdk/plugins/mgmt/agents/sweeper.agent.md");
        const resourcemgr = readRepoFile("packages/sdk/plugins/mgmt/agents/resourcemgr.agent.md");
        const factsManager = readRepoFile("packages/sdk/plugins/mgmt/agents/facts-manager.agent.md");

        assertIncludes(pilotswarm, "Do not start a recurring supervision cron", "pilotswarm should be reactive instead of maintaining a supervision cron");
        assertIncludes(pilotswarm, "wake only for direct operator prompts or implementation-defined runtime stimuli", "pilotswarm should document its wake sources");
        assertIncludes(sweeper, 'cron(seconds=21600, reason="scan for stale sessions and prune orchestration history")', "sweeper should establish a low-frequency maintenance cron schedule");
        assertIncludes(resourcemgr, "Do not start a recurring cron monitoring loop", "resource manager should be reactive instead of maintaining a monitoring cron");
        assertIncludes(resourcemgr, "Wake only for direct operator prompts or implementation-defined runtime stimuli", "resource manager should document its wake sources");
        assertIncludes(factsManager, 'cron(seconds=21600, reason="facts-manager maintenance")', "facts manager should schedule low-frequency maintenance via cron");
        assertIncludes(factsManager, '`config/facts-manager/cycle-interval` → `{ "value": 21600', "facts manager should default to a six-hour maintenance cycle");
        assertIncludes(factsManager, "Reactive intake wake-ups handle normal processing", "facts manager should document reactive intake wake-ups");
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
        assertIncludes(defaultAgent, "When a `cron` or `cron_at` wake-up resumes you, do the scheduled work immediately", "default agent should perform scheduled work on cron wake-up");
        assertIncludes(defaultAgent, "tangible progress toward the user's goal", "default agent should update summaries for tangible progress");
        assertIncludes(defaultAgent, "received cross-session replies", "default agent should update summaries after useful cross-session replies");
        assertIncludes(defaultAgent, "Keep your `update_session_summary` state concise, scannable, and useful", "default agent should keep summaries concise and scannable");
        assertIncludes(defaultAgent, "short Markdown tables", "default agent should prefer tables for structured summary details");
        assertIncludes(defaultAgent, "Do not paste long transcripts, raw logs, or bulky JSON into summary fields", "default agent should avoid oversized summary payloads");

        assertIncludes(orchestration, "use the \\`wait\\`, \\`wait_on_worker\\`, \\`cron\\`, or \\`cron_at\\` tools", "sub-agent preamble should allow cron and cron_at for recurring work");
        assertIncludes(orchestration, "report that ambiguity back to the parent", "sub-agent preamble should route long-running ambiguity to the parent");
        assertIncludes(orchestration, "Prefer using \\`store_fact\\` for larger structured context handoffs", "sub-agent preamble should push large context handoffs into facts");
        assertIncludes(orchestration, "pass fact keys or \\`read_facts\\` pointers in messages/prompts", "sub-agent preamble should tell children to send pointers instead of blobs");
        assert(!orchestration.includes("NEVER use setTimeout, sleep, setInterval, cron, or any other timing mechanism."), "latest orchestration should not forbid cron for sub-agents");

        assertIncludes(sessionProxy, "use the \\`wait\\`, \\`wait_on_worker\\`, \\`cron\\`, or \\`cron_at\\` tools", "session-proxy sub-agent preamble should allow cron and cron_at for recurring work");
        assertIncludes(sessionProxy, "report that ambiguity back to the parent", "session-proxy sub-agent preamble should route long-running ambiguity to the parent");
        assertIncludes(sessionProxy, "Prefer using \\`store_fact\\` for larger structured context handoffs", "session-proxy should push large context handoffs into facts");
        assertIncludes(sessionProxy, "pass fact keys or \\`read_facts\\` pointers in messages/prompts", "session-proxy should tell children to send pointers instead of blobs");
        assert(!sessionProxy.includes("NEVER use setTimeout, sleep, setInterval, cron, or any other timing mechanism."), "session-proxy should not forbid cron for sub-agents");
    });

    it("releases affinity for cron waits and renders cron wait state in the TUI", () => {
        const orchestration = readRepoFile("packages/sdk/src/orchestration.ts");
        const selectors = readRepoFile("packages/app/ui/core/src/selectors.js");

        assertIncludes(orchestration, "const cronPlan = planHoldRelease({", "cron waits should compute hold-vs-release through the shared lifecycle planner");
        assertIncludes(orchestration, 'yield* releaseAffinity(runtime, "cron");', "cron waits past the hold window should release worker affinity (no dehydrate — turns commit inside the activity)");
        assertIncludes(orchestration, "[orch] cron timer:", "cron waits should emit a dedicated trace event");
        assertIncludes(selectors, 'case "cron_waiting": return "yellow";', "cron wait sessions should render like normal waiting rows");
        assertIncludes(selectors, 'detail: `ZZ ${formatDehydrateSequenceDetail(event, preview)}`.trim()', "sequence view should show a reason-prefixed dehydration marker");
        assertIncludes(selectors, 'text: `[cron ${formatHumanDurationSeconds(session.cronInterval)}]`', "session rows should include a cron badge");
        assertIncludes(selectors, 'text: `[cron ${formatCronTimestampForClient(session.cronNextFireAt)}]`', "session rows should show wall-clock cron with the unified cron badge");
        assertIncludes(selectors, 'case "session.cron_at_fired":', "sequence view should render cron_at wake-ups");
        assertIncludes(selectors, 'detail: `cron fired ${formatCronTimestampForClient(event?.data?.scheduledAt)}`', "sequence view should show a visual cron_at wake indicator");
    });

    it("propagates cron_at metadata through session info APIs", () => {
        const managementClient = readRepoFile("packages/sdk/src/management-client.ts");
        const client = readRepoFile("packages/sdk/src/client.ts");

        assertIncludes(managementClient, "const cronKind = cronActive", "management getSession should read cronKind from custom status");
        assertIncludes(managementClient, "cronNextFireAt,", "management session info should expose cronNextFireAt");
        assertIncludes(client, "const cronKind = cronActive", "client getInfo should read cronKind from custom status");
        assertIncludes(client, "cronNextFireAt,", "client session info should expose cronNextFireAt");
    });

    it("keeps cron, collapse, and unread badges in a stable order", () => {
        const selectors = readRepoFile("packages/app/ui/core/src/selectors.js");

        assertIncludes(selectors, "for (const badge of [", "session rows should build badges in one canonical place");
        assertIncludes(selectors, "getCronBadge(session),", "session-row suffixes should lead with the cron badge");
        assertIncludes(selectors, "getContextListBadge(session?.contextUsage),", "context badge should follow the cron badge");
        // Since the portal sessions/themes refresh, the collapse badge renders
        // inline with the session title rather than in the suffix badge array.
        assertIncludes(selectors, "getCollapseBadge(session?.sessionId, entry, totalDescendantCounts, visibleDescendantCounts);", "collapse badge should render inline with the session title");
    });

    it("keeps cron rows non-magenta in the session list while preserving the cron badge", () => {
        const selectors = readRepoFile("packages/app/ui/core/src/selectors.js");

        assertIncludes(selectors, 'case "cron_waiting": return "yellow";', "session-list cron waits should use the normal waiting row color");
        assertIncludes(selectors, 'case "cron_waiting": return "~";', "session-list cron icon should stay the regular wait icon");
        assertIncludes(selectors, 'color: "magenta"', "cron badge itself should stay magenta");
    });

});
