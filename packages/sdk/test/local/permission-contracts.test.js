import { describe, it } from "vitest";
import { SessionManager } from "../../src/session-manager.ts";
import { approvePermissionForSession, sessionApprovalForPermissionRequest } from "../../src/permissions.ts";
import { assertEqual, assertNotNull } from "../helpers/assertions.js";
import { createTempSessionLayout } from "../helpers/temp-session-layout.js";

class FakeCopilotSession {}

class FakeCopilotClient {
    createdSessionConfigs = [];
    session = new FakeCopilotSession();

    async createSession(config) {
        this.createdSessionConfigs.push(config);
        return this.session;
    }

    async resumeSession(_sessionId, config) {
        this.createdSessionConfigs.push(config);
        return this.session;
    }

    async stop() {}
}

function createNoopFactStore() {
    return {
        async initialize() {},
        async storeFact(input) {
            return { key: input.key, shared: input.shared === true, stored: true };
        },
        async readFacts() {
            return { count: 0, facts: [] };
        },
        async deleteFact(input) {
            return { key: input.key, shared: input.shared === true, deleted: true };
        },
        async deleteSessionFactsForSession() {
            return 0;
        },
        async close() {},
    };
}

function createManagerHarness() {
    const layout = createTempSessionLayout("pilotswarm-permission-contract-");
    const manager = new SessionManager(process.env.GITHUB_TOKEN, null, {}, layout.sessionStateDir);
    const fakeClient = new FakeCopilotClient();
    manager.client = fakeClient;
    manager.setFactStore(createNoopFactStore());

    return {
        manager,
        fakeClient,
        cleanup: layout.cleanup,
    };
}

describe("Permission handler contracts", () => {
    it("uses a session-scoped SDK permission response for the default permission handler", async () => {
        const harness = createManagerHarness();
        try {
            await harness.manager.getOrCreate("default-permission-session", {
                toolNames: [],
            }, { turnIndex: 0 });

            const sessionConfig = harness.fakeClient.createdSessionConfigs[0];
            assertNotNull(sessionConfig, "SDK session config should be captured");
            assertEqual(typeof sessionConfig.onPermissionRequest, "function", "default permission handler should be installed");

            const result = await sessionConfig.onPermissionRequest({
                kind: "shell",
                commands: [{ identifier: "echo", readOnly: true }],
                fullCommandText: "echo permission-probe",
            }, { sessionId: "default-permission-session" });

            assertEqual(result.kind, "approve-for-session", "default permission handler should return the SDK 0.3 session approval shape");
            assertEqual(result.approval.kind, "commands", "shell permissions should approve command identifiers for the session");
            assertEqual(JSON.stringify(result.approval.commandIdentifiers), JSON.stringify(["echo"]), "shell session approval should preserve command identifiers");
        } finally {
            harness.cleanup();
        }
    });

    it("maps common permission request kinds to session approvals", async () => {
        const shellApproval = sessionApprovalForPermissionRequest({
            kind: "shell",
            commands: [{ identifier: "git" }, { identifier: "git" }, { identifier: "az" }],
        });
        assertEqual(shellApproval?.kind, "commands", "shell requests should map to command approval");
        assertEqual(JSON.stringify(shellApproval?.commandIdentifiers), JSON.stringify(["git", "az"]), "shell approvals should dedupe command identifiers");

        assertEqual(sessionApprovalForPermissionRequest({ kind: "read" })?.kind, "read", "read requests should map to read approval");
        assertEqual(sessionApprovalForPermissionRequest({ kind: "write" })?.kind, "write", "write requests should map to write approval");
        assertEqual(sessionApprovalForPermissionRequest({ kind: "memory" })?.kind, "memory", "memory requests should map to memory approval");

        const mcpApproval = sessionApprovalForPermissionRequest({
            kind: "mcp",
            serverName: "server-a",
            toolName: "tool-a",
        });
        assertEqual(mcpApproval?.kind, "mcp", "MCP requests should map to MCP approval");
        assertEqual(mcpApproval?.serverName, "server-a", "MCP approval should preserve server name");
        assertEqual(mcpApproval?.toolName, "tool-a", "MCP approval should preserve tool name");

        const customToolApproval = sessionApprovalForPermissionRequest({
            kind: "custom-tool",
            toolName: "publish_report",
        });
        assertEqual(customToolApproval?.kind, "custom-tool", "custom tools should map to custom-tool approval");
        assertEqual(customToolApproval?.toolName, "publish_report", "custom tool approval should preserve tool name");

        const urlResult = approvePermissionForSession({ kind: "url" });
        assertEqual(urlResult.kind, "approve-once", "unsupported session approval kinds should fall back to one-shot approval");
    });

    it("forwards worker-side custom permission handlers without changing the result shape", async () => {
        const harness = createManagerHarness();
        const seenRequests = [];
        const customHandler = async (request, invocation) => {
            seenRequests.push({ request, invocation });
            return { kind: "approve-once" };
        };

        try {
            harness.manager.setConfig("custom-permission-session", {
                toolNames: [],
                onPermissionRequest: customHandler,
            });

            await harness.manager.getOrCreate("custom-permission-session", {
                toolNames: [],
            }, { turnIndex: 0 });

            const sessionConfig = harness.fakeClient.createdSessionConfigs[0];
            assertNotNull(sessionConfig, "SDK session config should be captured");
            assertEqual(sessionConfig.onPermissionRequest, customHandler, "custom permission handler should be forwarded unchanged");

            const result = await sessionConfig.onPermissionRequest({
                kind: "shell",
                fullCommandText: "echo permission-probe",
            }, { sessionId: "custom-permission-session" });

            assertEqual(result.kind, "approve-once", "custom permission handler result should be returned unchanged");
            assertEqual(seenRequests.length, 1, "custom permission handler should see the shell request");
            assertEqual(seenRequests[0].request.kind, "shell", "request kind should be preserved");
            assertEqual(seenRequests[0].invocation.sessionId, "custom-permission-session", "invocation session id should be preserved");
        } finally {
            harness.cleanup();
        }
    });
});
