import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { assertEqual, assertIncludes } from "../helpers/assertions.js";

const mockState = vi.hoisted(() => ({
    binaryArtifact: {
        filename: "tiny.png",
        sizeBytes: 68,
        contentType: "image/png",
        isBinary: true,
        uploadedAt: "2026-04-21T00:00:00.000Z",
        source: "agent",
        body: Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
            0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
            0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
            0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
            0x44, 0xae, 0x42, 0x60, 0x82,
        ]),
    },
    metadata: {
        filename: "tiny.png",
        sizeBytes: 68,
        contentType: "image/png",
        isBinary: true,
        uploadedAt: "2026-04-21T00:00:00.000Z",
        source: "agent",
    },
    bootstrap: {
        mode: "local",
        workerCount: 1,
        logConfig: null,
        defaultModel: null,
        modelsByProvider: [],
        creatableAgents: [],
        sessionCreationPolicy: null,
    },
}));

vi.mock("../../../portal/auth.js", () => ({
    authenticateRequest: async () => ({ ok: true, status: 200, principal: { rawClaims: {} } }),
    extractToken: () => null,
    getAuthConfig: async () => ({ enabled: false, provider: "none", client: null }),
    authenticateToken: async () => ({ ok: false, status: 401, error: "Unauthorized" }),
}));

vi.mock("../../../portal/auth/authz/engine.js", () => ({
    getPublicAuthContext: () => ({
        principal: null,
        authorization: {
            allowed: true,
            role: "admin",
            reason: null,
            matchedGroups: [],
        },
    }),
}));

vi.mock("../../../portal/runtime.js", () => ({
    PortalRuntime: class PortalRuntime {
        constructor() {
            this.started = false;
        }

        async start() {
            this.started = true;
        }

        async stop() {
            this.started = false;
        }

        async getBootstrap() {
            return mockState.bootstrap;
        }

        async call(method) {
            if (method === "getArtifactMetadata") return mockState.metadata;
            if (method === "listArtifacts") return mockState.metadata ? [mockState.metadata] : [];
            throw new Error(`Unexpected portal RPC method in test: ${method}`);
        }

        async downloadArtifactBinary() {
            if (!mockState.binaryArtifact) throw new Error("Artifact not found");
            return mockState.binaryArtifact;
        }

        async getArtifactMetadata() {
            return mockState.metadata;
        }

        subscribeSession() {
            return () => {};
        }

        startLogTail() {
            return () => {};
        }
    },
}));

async function closeServer(server) {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
}

describe("portal binary artifact routes", () => {
    let startServer;
    let server;

    beforeEach(async () => {
        vi.resetModules();
        mockState.metadata = {
            filename: "tiny.png",
            sizeBytes: 68,
            contentType: "image/png",
            isBinary: true,
            uploadedAt: "2026-04-21T00:00:00.000Z",
            source: "agent",
        };
        ({ startServer } = await import("../../../portal/server.js"));
    });

    afterEach(async () => {
        await closeServer(server);
        server = null;
    });

    it("serves raw binary bytes from /download and metadata from /meta", async () => {
        server = await startServer({ port: 0 });
        const { port } = server.address();
        const baseUrl = `http://127.0.0.1:${port}`;

        const downloadResponse = await fetch(`${baseUrl}/api/sessions/session-1/artifacts/tiny.png/download`);
        const downloadedBytes = Buffer.from(await downloadResponse.arrayBuffer());

        assertEqual(downloadResponse.status, 200, "download route should succeed for existing artifacts");
        assertEqual(downloadResponse.headers.get("content-type"), "image/png", "download route should preserve the artifact mime type");
        assertIncludes(downloadResponse.headers.get("content-disposition") || "", 'attachment; filename="tiny.png"', "download route should force attachment downloads");
        assertEqual(Buffer.compare(downloadedBytes, mockState.binaryArtifact.body), 0, "download route should return the original artifact bytes");

        const metaResponse = await fetch(`${baseUrl}/api/sessions/session-1/artifacts/tiny.png/meta`);
        const metadata = await metaResponse.json();

        assertEqual(metaResponse.status, 200, "meta route should succeed for existing artifacts");
        assertEqual(metadata.ok, true, "meta route should return ok=true");
        assertEqual(metadata.filename, "tiny.png", "meta route should expose the filename");
        assertEqual(metadata.contentType, "image/png", "meta route should expose the content type");
        assertEqual(metadata.sizeBytes, 68, "meta route should expose the byte size");
        assertEqual(metadata.isBinary, true, "meta route should expose binary classification");
    });

    it("returns 404 for missing artifact metadata", async () => {
        mockState.metadata = null;
        server = await startServer({ port: 0 });
        const { port } = server.address();
        const baseUrl = `http://127.0.0.1:${port}`;

        const response = await fetch(`${baseUrl}/api/sessions/session-1/artifacts/missing.png/meta`);
        const payload = await response.json();

        assertEqual(response.status, 404, "meta route should return 404 for missing artifacts");
        assertEqual(payload.ok, false, "missing metadata should return ok=false");
        assertEqual(payload.error, "Artifact not found", "missing metadata should return the expected error payload");
    });
});