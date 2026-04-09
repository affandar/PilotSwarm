import { describe, it } from "vitest";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { decorateArtifactLinksForChat } from "../../../ui-core/src/formatting.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

function createController(transportOverrides = {}) {
    const transport = {
        start: async () => {},
        stop: async () => {},
        listSessions: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        listArtifacts: async () => [],
        downloadArtifact: async () => "",
        sendMessage: async () => {},
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    return {
        store,
        controller: new PilotSwarmUiController({ store, transport }),
    };
}

function seedSession(store, sessionId = "12345678-1234-1234-1234-1234567890ab") {
    store.dispatch({
        type: "sessions/loaded",
        sessions: [{
            sessionId,
            title: "Stress session",
            status: "waiting",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }],
    });
    store.dispatch({ type: "sessions/selected", sessionId });
    return sessionId;
}

function seedSessions(store, sessions, activeSessionId) {
    store.dispatch({
        type: "sessions/loaded",
        sessions,
    });
    store.dispatch({ type: "sessions/selected", sessionId: activeSessionId });
}

describe("prompt reference browsing", () => {
    it("syncs @ queries into the active session artifact browser", async () => {
        const sessionId = "12345678-1234-1234-1234-1234567890ab";
        const { controller, store } = createController({
            listArtifacts: async () => ["notes.md", "report.md"],
            downloadArtifact: async (_activeSessionId, filename) => `preview:${filename}`,
        });
        seedSession(store, sessionId);

        controller.setPrompt("Please review @repo", "Please review @repo".length);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const state = store.getState();
        assertEqual(state.ui.inspectorTab, "files", "@ browsing should surface the files pane");
        assertEqual(state.files.filter.scope, "selectedSession", "@ browsing should stay scoped to the active session");
        assertEqual(state.files.filter.query, "repo", "@ browsing should mirror the artifact query");
        assertEqual(state.files.bySessionId[sessionId]?.selectedFilename, "report.md", "@ browsing should select the first matching artifact");
    });

    it("syncs @@ queries into the global session browser", () => {
        const { controller, store } = createController();
        seedSession(store, "12345678-1234-1234-1234-1234567890ab");

        controller.setPrompt("Compare with @@stress", "Compare with @@stress".length);

        assertEqual(store.getState().sessions.filterQuery, "stress", "@@ browsing should filter the session list");
        assertEqual(store.getState().files.filter.query, "", "@@ browsing should clear artifact browsing");
    });

    it("accepts @ autocomplete into an attachment-backed artifact reference", async () => {
        const sessionId = "12345678-1234-1234-1234-1234567890ab";
        let sentPrompt = null;
        const { controller, store } = createController({
            listArtifacts: async () => ["durable-futures-internals.md", "notes.md"],
            sendMessage: async (_sessionId, prompt) => {
                sentPrompt = prompt;
            },
        });
        seedSession(store, sessionId);

        controller.setPrompt("read @durable", "read @durable".length);
        await new Promise((resolve) => setTimeout(resolve, 0));

        assertEqual(controller.acceptPromptReferenceAutocomplete(), true, "Tab acceptance should succeed for artifact references");

        const state = store.getState();
        assertEqual(state.ui.prompt, "read 📎 durable-futures-internals.md ", "artifact autocomplete should replace the @ query with an attachment token");
        assertEqual(state.ui.promptAttachments.length, 1, "artifact autocomplete should create a prompt attachment");
        assertEqual(state.ui.promptAttachments[0]?.filename, "durable-futures-internals.md", "artifact autocomplete should target the selected file");
        assertEqual(state.files.filter.query, "", "artifact autocomplete should clear the files query after accepting");

        await controller.sendPrompt();
        assertIncludes(sentPrompt, "artifact://12345678-1234-1234-1234-1234567890ab/durable-futures-internals.md", "send should expand the attachment token into an artifact URI");
        assert(!sentPrompt.includes("@durable"), "send should no longer contain the raw @ query");
        assertIncludes(
            decorateArtifactLinksForChat(`Attached durable artifact: artifact://${sessionId}/durable-futures-internals.md`),
            "[artifact: durable-futures-internals.md](artifact://12345678-1234-1234-1234-1234567890ab/durable-futures-internals.md)",
            "artifact references should still decorate into chat hyperlinks",
        );
    });

    it("accepts @@ autocomplete into a durable session reference", async () => {
        let sentPrompt = null;
        const { controller, store } = createController({
            sendMessage: async (_sessionId, prompt) => {
                sentPrompt = prompt;
            },
        });
        seedSessions(store, [
            {
                sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
                title: "Current workspace",
                status: "waiting",
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
            {
                sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
                title: "Missing durable timers reference",
                status: "waiting",
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ], "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1");

        controller.setPrompt("compare @@durable", "compare @@durable".length);

        assertEqual(controller.acceptPromptReferenceAutocomplete(), true, "Tab acceptance should succeed for session references");

        const state = store.getState();
        assertIncludes(
            state.ui.prompt,
            "Referenced session: Missing durable timers reference — session://bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
            "session autocomplete should insert the selected session reference",
        );
        assertEqual(state.sessions.filterQuery, "", "session autocomplete should clear the global session query after accepting");

        await controller.sendPrompt();
        assertIncludes(sentPrompt, "session://bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2", "send should preserve the durable session reference");
        assertIncludes(
            decorateArtifactLinksForChat("Referenced session: Missing durable timers reference — session://bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2"),
            "[session: bbbbbbbb](session://bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2)",
            "session references should decorate into chat hyperlinks",
        );
    });
});
