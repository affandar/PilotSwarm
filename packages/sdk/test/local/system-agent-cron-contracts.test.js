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
        const subAgentSkill = readRepoFile("packages/sdk/plugins/system/skills/sub-agents/SKILL.md");
        const orchestration = readRepoFile("packages/sdk/src/orchestration.ts");
        const orchestrationAgents = readRepoFile("packages/sdk/src/orchestration/agents.ts");
        const orchestrationTurn = readRepoFile("packages/sdk/src/orchestration/turn.ts");
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
        assertIncludes(defaultAgent, "Qualifying child updates wake you automatically", "default agent should explain reactive child coordination");
        assertIncludes(defaultAgent, "Do not create a `wait` or `cron` schedule whose only purpose is calling `check_agents`", "default agent should forbid timer-only child polling");
        assertIncludes(defaultAgent, "version: 1.7.0", "default agent should version the reactive coordination contract");
        assert(!defaultAgent.includes("Continue your poll/summarize loop"), "default agent should not require a polling loop for child coordination");
        assert(!defaultAgent.includes("Preferred**: Poll with `wait` + `check_agents`"), "default agent should not prefer wait-based child polling");

        assertIncludes(subAgentSkill, "Parent coordination is reactive", "sub-agent skill should teach reactive parent coordination");
        assertIncludes(subAgentSkill, "Do not schedule `wait` or `cron` solely to poll `check_agents`", "sub-agent skill should forbid redundant polling timers");
        assert(!subAgentSkill.includes("Periodically check_agents() to see updates"), "sub-agent skill should not teach periodic status polling");

        assertIncludes(orchestration, "use the \\`wait\\`, \\`wait_on_worker\\`, \\`cron\\`, or \\`cron_at\\` tools", "sub-agent preamble should allow cron and cron_at for recurring work");
        assertIncludes(orchestration, "report that ambiguity back to the parent", "sub-agent preamble should route long-running ambiguity to the parent");
        assertIncludes(orchestration, "Prefer using \\`store_fact\\` for larger structured context handoffs", "sub-agent preamble should push large context handoffs into facts");
        assertIncludes(orchestration, "pass fact keys or \\`read_facts\\` pointers in messages/prompts", "sub-agent preamble should tell children to send pointers instead of blobs");
        assert(!orchestration.includes("NEVER use setTimeout, sleep, setInterval, cron, or any other timing mechanism."), "latest orchestration should not forbid cron for sub-agents");
        assert(!orchestrationTurn.includes("forgotten-timer safety"), "orchestration should not force an extra turn when reactive children remain running");
        assert(!orchestrationTurn.includes("forgottenTimerNudged"), "orchestration should not carry a one-shot polling nudge");
        assert(!orchestrationTurn.includes("your monitoring/polling loop is DEAD"), "orchestration should not falsely claim child updates cannot wake the parent");
        assertIncludes(orchestrationAgents, "finish the turn normally and let qualifying child updates wake you", "durable nested-agent preamble should coordinate reactively");
        assertIncludes(orchestrationAgents, "Do not schedule wait or cron solely to poll check_agents", "durable nested-agent preamble should forbid polling timers");
        assertIncludes(sessionProxy, "finish the turn normally and let qualifying child updates wake you", "inline nested-agent preamble should coordinate reactively");
        assertIncludes(sessionProxy, "Do not schedule wait or cron solely to poll check_agents", "inline nested-agent preamble should forbid polling timers");

        const systemTools = ManagedSession.systemToolDefs();
        const cronTool = systemTools.find((tool) => tool.name === "cron");
        const subAgentTools = ManagedSession.subAgentToolDefs();
        const spawnTool = subAgentTools.find((tool) => tool.name === "spawn_agent");
        const checkTool = subAgentTools.find((tool) => tool.name === "check_agents");
        assertIncludes(cronTool?.description || "", "Do not use cron solely to poll sub-agent status", "cron tool should reject redundant child polling");
        assertIncludes(spawnTool?.parameters?.properties?.contract?.description || "", "Qualifying updates wake the parent automatically", "spawn contract should explain reactive wakeups");
        assertIncludes(checkTool?.description || "", "on-demand snapshot, not a scheduling primitive", "check_agents should not invite scheduled polling");

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

    it("keeps cron, collapse, and context rendering in a stable structure", () => {
        const selectors = readRepoFile("packages/app/ui/core/src/selectors.js");

        // The dense session row resolves each decoration in one canonical place.
        // Collapse badge renders inline with the session title.
        assertIncludes(selectors, "const collapseBadge = getCollapseBadge(session?.sessionId, entry, totalDescendantCounts, visibleDescendantCounts);", "collapse badge should render inline with the session title");
        // Scheduled rows carry a compact clock glyph on the title; the full cron
        // cadence rides in the detail line revealed on expand.
        assertIncludes(selectors, "const cronBadge = getCronBadge(session);", "session rows should resolve the cron badge in one canonical place");
        assertIncludes(selectors, 'titleRuns.push({ text: " ⏱", color: "magenta" });', "scheduled rows should show the compact clock glyph on the title");
        assertIncludes(selectors, "detailRuns.push({ text: cronBadge.text, color: cronBadge.color });", "the full cron cadence should render in the detail line");
        // Context usage renders as a right-column percentage, not a suffix badge.
        assertIncludes(selectors, "const ctxPercent = computeContextPercent(session?.contextUsage);", "context usage should render as the right-column percentage");
    });

    it("keeps cron rows non-magenta in the session list while preserving the cron badge", () => {
        const selectors = readRepoFile("packages/app/ui/core/src/selectors.js");

        assertIncludes(selectors, 'case "cron_waiting": return "yellow";', "session-list cron waits should use the normal waiting row color");
        assertIncludes(selectors, 'case "cron_waiting": return "~";', "session-list cron icon should stay the regular wait icon");
        assertIncludes(selectors, 'color: "magenta"', "cron badge itself should stay magenta");
    });

});
