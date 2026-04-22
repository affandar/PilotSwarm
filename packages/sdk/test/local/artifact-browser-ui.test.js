import { describe, it } from "vitest";
import { BrowserPortalTransport } from "../../../portal/src/browser-transport.js";
import { NodeSdkTransport } from "../../../cli/src/node-sdk-transport.js";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import { selectFileBrowserItems } from "../../../ui-core/src/selectors.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { assertEqual, assertIncludes } from "../helpers/assertions.js";

function createController(transportOverrides = {}) {
    const transport = {
        start: async () => {},
        stop: async () => {},
        listSessions: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    return {
        store,
        transport,
        controller: new PilotSwarmUiController({ store, transport }),
    };
}

function seedSession(store, sessionId = "session-12345678") {
    store.dispatch({
        type: "sessions/loaded",
        sessions: [{
            sessionId,
            title: "Artifact Browser Test",
            status: "completed",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }],
    });
    return sessionId;
}

describe("artifact browser UI", () => {
    it("encodes browser file uploads as base64 for binary-safe RPC transport", async () => {
        const transport = new BrowserPortalTransport({
            getAccessToken: async () => null,
        });
        let rpcCall = null;
        transport.rpc = async (method, params) => {
            rpcCall = { method, params };
            return { ok: true };
        };

        await transport.uploadArtifactFromFile("session-upload", {
            name: "tiny.jpg",
            type: "image/jpeg",
            arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]).buffer,
        });

        assertEqual(rpcCall?.method, "uploadArtifact", "browser uploads should still use the uploadArtifact RPC");
        assertEqual(rpcCall?.params?.contentEncoding, "base64", "browser uploads should mark binary payloads as base64");
        assertEqual(rpcCall?.params?.content, "/9j/2wBD", "browser uploads should preserve the raw JPEG bytes in base64 form");
    });

    it("decodes base64 upload payloads back to raw bytes before storing artifacts", async () => {
        let storedUpload = null;
        const transport = Object.create(NodeSdkTransport.prototype);
        transport.artifactStore = {
            uploadArtifact: async (sessionId, filename, content, contentType) => {
                storedUpload = { sessionId, filename, content, contentType };
            },
        };

        const upload = await transport.uploadArtifactContent(
            "session-upload",
            "tiny.jpg",
            "/9j/2wBD",
            "image/jpeg",
            "base64",
        );

        assertEqual(Buffer.isBuffer(storedUpload?.content), true, "base64 uploads should be decoded to Buffer before storage");
        assertEqual(storedUpload?.content.equals(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43])), true, "decoded upload bytes should match the original JPEG payload");
        assertEqual(upload.sizeBytes, 6, "binary upload size should reflect the decoded byte length");
    });

    it("deletes the selected artifact through the shared controller flow", async () => {
        const sessionId = "session-delete-ui";
        let artifactEntries = [
            {
                filename: "alpha.txt",
                sizeBytes: 12,
                contentType: "text/plain",
                isBinary: false,
                uploadedAt: "2026-04-21T00:00:00.000Z",
                source: "agent",
            },
            {
                filename: "beta.txt",
                sizeBytes: 10,
                contentType: "text/plain",
                isBinary: false,
                uploadedAt: "2026-04-21T00:00:01.000Z",
                source: "agent",
            },
        ];
        const deleted = [];
        const { controller, store } = createController({
            listArtifacts: async () => artifactEntries,
            downloadArtifact: async (_sessionId, filename) => `${filename} preview`,
            deleteArtifact: async (_sessionId, filename) => {
                deleted.push(filename);
                artifactEntries = artifactEntries.filter((entry) => entry.filename !== filename);
                return true;
            },
        });
        seedSession(store, sessionId);

        await controller.ensureFilesForSession(sessionId);
        store.dispatch({ type: "files/select", sessionId, filename: "alpha.txt" });

        await controller.deleteSelectedArtifact();

        const confirmModal = store.getState().ui.modal;
        assertEqual(confirmModal?.type, "confirm", "deleting from the viewer should use the shared confirm modal");
        assertEqual(confirmModal?.action, "deleteArtifact", "the confirm modal should route back to the artifact delete action");

        await controller.confirmModal();

        const fileState = store.getState().files.bySessionId[sessionId];
        assertEqual(deleted.join(","), "alpha.txt", "the selected artifact should be deleted through the transport");
        assertEqual(fileState.entries.length, 1, "deleted artifacts should be removed from files state");
        assertEqual(fileState.entries[0].filename, "beta.txt", "the remaining artifact should stay visible");
        assertEqual(fileState.selectedFilename, "beta.txt", "selection should advance to the next remaining artifact");
        assertEqual(store.getState().ui.statusText, "Deleted alpha.txt", "the controller should surface a clear delete status");
    });

    it("keeps artifact metadata in state and skips downloading binary previews", async () => {
        let downloadCalls = 0;
        const sessionId = "session-binary-ui";
        const { controller, store } = createController({
            listArtifacts: async () => [{
                filename: "tiny.png",
                sizeBytes: 68,
                contentType: "image/png",
                isBinary: true,
                uploadedAt: "2026-04-21T00:00:00.000Z",
                source: "agent",
            }],
            downloadArtifact: async () => {
                downloadCalls += 1;
                return "should not be fetched for binary previews";
            },
        });
        seedSession(store, sessionId);

        await controller.ensureFilesForSession(sessionId);

        const fileState = store.getState().files.bySessionId[sessionId];
        const items = selectFileBrowserItems(store.getState());

        assertEqual(downloadCalls, 0, "binary previews should not call the text download path when metadata already marks the file binary");
        assertEqual(fileState.selectedFilename, "tiny.png", "the binary artifact should still become the selected file");
        assertEqual(fileState.entries[0].filename, "tiny.png", "files state should store metadata records");
        assertEqual(fileState.entries[0].isBinary, true, "files state should preserve binary metadata");
        assertEqual(fileState.previews["tiny.png"].renderMode, "note", "binary artifacts should render through the note preview path");
        assertIncludes(fileState.previews["tiny.png"].content, "Type: image/png", "binary preview notes should include the artifact content type");
        assertIncludes(fileState.previews["tiny.png"].content, "Size: 68 B", "binary preview notes should include the artifact size");
        assertEqual(items[0].entry.contentType, "image/png", "file browser items should carry the stored artifact metadata");
    });

    it("preserves the selected filename across metadata-based refreshes", async () => {
        const sessionId = "session-refresh-ui";
        let artifactEntries = [
            {
                filename: "note.md",
                sizeBytes: 16,
                contentType: "text/markdown",
                isBinary: false,
                uploadedAt: "2026-04-21T00:00:00.000Z",
                source: "agent",
            },
            {
                filename: "tiny.png",
                sizeBytes: 68,
                contentType: "image/png",
                isBinary: true,
                uploadedAt: "2026-04-21T00:00:01.000Z",
                source: "agent",
            },
        ];
        const { controller, store } = createController({
            listArtifacts: async () => artifactEntries,
            downloadArtifact: async (_sessionId, filename) => `# ${filename}\n`,
        });
        seedSession(store, sessionId);

        await controller.ensureFilesForSession(sessionId);
        store.dispatch({ type: "files/select", sessionId, filename: "note.md" });

        artifactEntries = [artifactEntries[1], artifactEntries[0]];
        await controller.ensureFilesForSession(sessionId, { force: true });

        const fileState = store.getState().files.bySessionId[sessionId];
        assertEqual(fileState.selectedFilename, "note.md", "metadata refreshes should preserve the existing filename selection when the file still exists");
        assertEqual(fileState.previews["note.md"].renderMode, "markdown", "text artifacts should remain previewable after a metadata refresh");
    });
});