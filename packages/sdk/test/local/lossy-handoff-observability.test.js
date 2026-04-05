import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHistoryModel } from "../../../ui-core/src/history.js";
import { selectInspector } from "../../../ui-core/src/selectors.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { assertEqual, assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function flattenLine(line) {
    if (Array.isArray(line)) return line.map((run) => run?.text || "").join("");
    if (typeof line === "string") return line;
    return line?.text || "";
}

describe("lossy handoff observability", () => {
    it("documents fixed-delay retries and worker handoff for closed Copilot connections", () => {
        const orchestration = readRepoFile("packages/sdk/src/orchestration.ts");

        assertIncludes(orchestration, "const COPILOT_CONNECTION_CLOSED_MAX_RETRIES = 3;", "closed connections should retry three times");
        assertIncludes(orchestration, "const COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS = 15;", "closed connections should retry every 15 seconds");
        assertIncludes(orchestration, "retryCount <= COPILOT_CONNECTION_CLOSED_MAX_RETRIES", "the latest orchestration should allow the full three retries");
        assertIncludes(orchestration, "yield ctx.scheduleTimer(COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS * 1000);", "closed-connection retries should use the fixed 15 second delay");
        assertIncludes(orchestration, 'eventType: "session.lossy_handoff"', "closed-connection exhaustion should record a dedicated lossy handoff event");
        assertIncludes(orchestration, 'yield* dehydrateForNextTurn("lossy_handoff", true, {', "closed-connection exhaustion should dehydrate for worker handoff");
    });

    it("surfaces lossy handoffs and detailed dehydration reasons in the TUI", () => {
        const sessionId = "session-lossy-ui";
        const events = [
            {
                sessionId,
                seq: 1,
                eventType: "session.lossy_handoff",
                createdAt: new Date("2026-04-05T09:50:10.000Z"),
                workerNodeId: "worker-cdrr7",
                data: {
                    message: "Live Copilot connection stayed closed after 3 retries; dehydrating for handoff to a new worker.",
                    error: "Connection is closed.",
                },
            },
            {
                sessionId,
                seq: 2,
                eventType: "session.dehydrated",
                createdAt: new Date("2026-04-05T09:50:11.000Z"),
                workerNodeId: "worker-cdrr7",
                data: {
                    reason: "lossy_handoff",
                    detail: "Live Copilot connection stayed closed after 3 retries; dehydrating for handoff to a new worker.",
                    error: "Connection is closed.",
                },
            },
        ];

        const history = buildHistoryModel(events);
        assertEqual(history.activity.length, 2, "both observability events should appear in activity");
        assertIncludes(history.activity[0].text, "[lossy handoff]", "activity should render the lossy handoff event");
        assertIncludes(history.activity[0].text, "Connection is closed.", "activity should show the raw connection failure");
        assertIncludes(history.activity[1].text, "[dehydrated]", "activity should still show the dehydration event");
        assertIncludes(history.activity[1].text, "lossy_handoff", "activity should show the special dehydration reason");
        assertIncludes(history.activity[1].text, "Connection is closed.", "dehydration activity should include the raw error");

        const state = createInitialState({ mode: "local" });
        state.ui.inspectorTab = "sequence";
        state.sessions.byId[sessionId] = {
            sessionId,
            status: "error",
            title: "Lossy test",
            createdAt: new Date("2026-04-05T09:49:00.000Z"),
            updatedAt: new Date("2026-04-05T09:50:11.000Z"),
            iterations: 7,
        };
        state.sessions.activeSessionId = sessionId;
        state.history.bySessionId.set(sessionId, history);
        state.orchestration.bySessionId[sessionId] = {
            stats: {
                historyEventCount: 2,
                historySizeBytes: 1024,
                queuePendingCount: 0,
                kvUserKeyCount: 0,
                kvTotalValueBytes: 0,
            },
        };

        const inspector = selectInspector(state, { width: 180 });
        const sequenceText = inspector.lines.map(flattenLine).join("\n");
        assertIncludes(sequenceText, "lossy", "sequence view should show the lossy handoff row");
        assertIncludes(sequenceText, "closed", "sequence view should expose the connection failure detail");
        assertIncludes(sequenceText, "lossy_handoff", "sequence view should include the special dehydration reason");
    });
});
