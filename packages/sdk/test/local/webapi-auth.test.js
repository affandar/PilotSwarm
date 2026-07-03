/**
 * Web API auth behaviors — Entra-configured deployment rejecting
 * unauthenticated/garbage callers, and the public discovery route.
 *
 * Uses a throwaway server with Entra env config and no workers; every
 * assertion here fails before the runtime touches any store, so no
 * database is required.
 *
 * Run: npx vitest run test/local/webapi-auth.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { assert, assertEqual } from "../helpers/assertions.js";

let server;
let apiUrl;

describe("web api auth (entra-configured)", () => {
    beforeAll(async () => {
        process.env.PORTAL_AUTH_PROVIDER = "entra";
        process.env.PORTAL_AUTH_ENTRA_TENANT_ID = "11111111-2222-3333-4444-555555555555";
        process.env.PORTAL_AUTH_ENTRA_CLIENT_ID = "66666666-7777-8888-9999-000000000000";
        process.env.PORTAL_AUTHZ_DEFAULT_ROLE = "user";
        process.env.DATABASE_URL = "sqlite::memory:";
        process.env.WORKERS = "0";

        const { startServer } = await import("pilotswarm/web");
        server = await startServer({ port: 0 });
        apiUrl = `http://localhost:${server.address().port}`;
    }, 60_000);

    afterAll(async () => {
        if (server?.stopPortal) await server.stopPortal();
    });

    it("publishes the auth config without a token", async () => {
        const response = await fetch(`${apiUrl}/api/v1/auth/config`);
        assertEqual(response.status, 200, "auth config is public");
        const config = await response.json();
        assertEqual(config.provider, "entra", "provider advertised");
        assertEqual(config.enabled, true, "auth enabled");
        assertEqual(config.client?.clientId, "66666666-7777-8888-9999-000000000000", "public client id advertised");
        assert(String(config.client?.authority || "").includes("11111111-2222-3333-4444-555555555555"), "authority carries tenant");
    });

    it("serves health without a token", async () => {
        const response = await fetch(`${apiUrl}/api/v1/health`);
        assertEqual(response.status, 200, "health is public");
    });

    it("rejects missing tokens with 401 envelopes", async () => {
        for (const path of ["/api/v1/sessions", "/api/v1/bootstrap", "/api/v1/auth/me", "/api/v1/models"]) {
            const response = await fetch(`${apiUrl}${path}`);
            assertEqual(response.status, 401, `401 for ${path}`);
            const payload = await response.json();
            assertEqual(payload.ok, false, `envelope ok=false for ${path}`);
        }
    });

    it("rejects malformed bearer tokens with 401", async () => {
        const response = await fetch(`${apiUrl}/api/v1/sessions`, {
            headers: { authorization: "Bearer not-a-jwt" },
        });
        assertEqual(response.status, 401, "garbage token rejected");
    });

    it("closes unauthenticated websockets with 4401", async () => {
        const closeCode = await new Promise((resolve, reject) => {
            const socket = new WebSocket(`${apiUrl.replace("http", "ws")}/api/v1/ws`);
            const timer = setTimeout(() => reject(new Error("ws close timeout")), 10_000);
            socket.on("close", (code) => {
                clearTimeout(timer);
                resolve(code);
            });
            socket.on("error", () => {});
        });
        assertEqual(closeCode, 4401, "ws upgrade rejected as unauthorized");
    });
});
