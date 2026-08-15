// A model switch used to be invisible in substance: the orchestration records
// a full session.model_changed event (old/new model, efforts, tiers), but the
// sequence renderer dropped it (default: null) and the activity formatter fell
// through to a bare gray "[session.model_changed]" with an empty body — the
// structured data carries no message text. Debugged live on chk 2026-08-15:
// a gpt-5.4 → gpt-5.6-terra switch showed nothing that named either model.
import test from "node:test";
import assert from "node:assert/strict";
import { selectInspector } from "../src/selectors.js";
import { buildHistoryModel } from "../src/history.js";

// Short model ids on purpose: the sequence detail column is ~27 chars wide and
// truncates with an ellipsis, so long real-world ids would hide the suffix the
// assertions check. createdAt is "now" so the recent-window filter keeps it.
const MODEL_CHANGED_EVENT = {
    sessionId: "s1",
    seq: 42,
    eventType: "session.model_changed",
    createdAt: new Date(),
    workerNodeId: "worker-abc123",
    data: {
        source: "ui",
        oldModel: "azure-openai:gpt-a",
        newModel: "azure-openai:gpt-b",
        oldReasoningEffort: null,
        newReasoningEffort: "high",
        oldContextTier: null,
        newContextTier: "default",
    },
};

function stateWithEvents(events) {
    const sessionId = "s1";
    return {
        sessions: { activeSessionId: sessionId, byId: { [sessionId]: { sessionId, title: "t" } }, flat: [{ sessionId }] },
        history: { bySessionId: new Map([[sessionId, { events }]]) },
        ui: { inspectorTab: "sequence", scroll: {}, followBottom: {} },
        orchestration: { bySessionId: {} },
        logs: {}, files: {},
    };
}

function flattenView(view) {
    const lines = [...(view.stickyLines || []), ...(view.lines || [])];
    return lines
        .map((line) => {
            const runs = Array.isArray(line?.runs) ? line.runs : (Array.isArray(line) ? line : null);
            if (runs) return runs.map((run) => String(run.text ?? "")).join("");
            return String(line?.text ?? "");
        })
        .join("\n");
}

test("sequence renders a model row naming old → new (bare ids, effort suffix)", () => {
    const view = selectInspector(stateWithEvents([MODEL_CHANGED_EVENT]), 120);
    const text = flattenView(view);
    assert.match(text, /model gpt-a → gpt-b:high/, `sequence output missing the model row:\n${text}`);
    // Provider prefixes stay out of the narrow column.
    assert.ok(!text.includes("azure-openai:"), "sequence row should use bare model ids");
});

test("sequence model row omits the effort suffix when effort did not change", () => {
    const event = {
        ...MODEL_CHANGED_EVENT,
        data: { ...MODEL_CHANGED_EVENT.data, oldReasoningEffort: "high", newReasoningEffort: "high" },
    };
    const text = flattenView(selectInspector(stateWithEvents([event]), 120));
    assert.match(text, /model gpt-a → gpt-b(?!:high)/);
});

test("activity renders a [model] line with old → new and changed extras", () => {
    const { activity } = buildHistoryModel([MODEL_CHANGED_EVENT]);
    assert.equal(activity.length, 1, "model_changed should produce exactly one activity item");
    const runsText = activity[0].line.map((run) => String(run.text ?? "")).join("");
    assert.match(runsText, /\[model\]/);
    assert.match(runsText, /gpt-a → gpt-b \(effort high\)/, runsText);
    // A default context tier is not news; it must not clutter the line.
    assert.ok(!runsText.includes("context default"), runsText);
});

test("activity [model] line is not the generic event-type fallback", () => {
    const { activity } = buildHistoryModel([MODEL_CHANGED_EVENT]);
    const runsText = activity[0].line.map((run) => String(run.text ?? "")).join("");
    assert.ok(!runsText.includes("[session.model_changed]"), runsText);
});
