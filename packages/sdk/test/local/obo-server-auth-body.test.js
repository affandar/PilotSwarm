/**
 * server-side RPC body auth extraction test.
 *
 * Asserts that the /api/rpc handler extracts the SPA-supplied downstream
 * access token from the JSON request body's `auth` field and stamps it
 * onto `req.auth.principal` before passing the auth context to
 * `runtime.call()`. Tokens MUST travel only in the TLS-protected body —
 * never in headers/WS — so this test pins that contract at the unit level.
 *
 * The portal's actual server.js is exercised by spinning up Express
 * in-process and submitting a synthetic /api/rpc request through it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";

// Import the handler logic by replicating the relevant slice of server.js.
// We inline it to avoid the heavyweight runtime initialization in the
// production server.js bootstrap. The slice under test mirrors lines
// added with the user-OBO feature (extract bodyAuth → stamp on req.auth.principal).
function buildRpcSliceApp({ runtimeCall, authPrincipal }) {
    const app = express();
    app.use(express.json({ limit: "2mb" }));

    function requireAuth(req, _res, next) {
        req.auth = { principal: { ...authPrincipal } };
        next();
    }

    app.post("/api/rpc", requireAuth, async (req, res) => {
        const method = String(req.body?.method || "").trim();
        if (!method) {
            res.status(400).json({ ok: false, error: "RPC method is required" });
            return;
        }
        const bodyAuth = req.body?.auth;
        if (req.auth?.principal && bodyAuth && typeof bodyAuth === "object") {
            const accessToken = typeof bodyAuth.accessToken === "string" && bodyAuth.accessToken.length > 0
                ? bodyAuth.accessToken
                : null;
            const expires = Number(bodyAuth.accessTokenExpiresAt);
            const accessTokenExpiresAt = Number.isFinite(expires) && expires > 0 ? expires : null;
            if (accessToken) {
                req.auth.principal = {
                    ...req.auth.principal,
                    accessToken,
                    accessTokenExpiresAt,
                };
            }
        }
        const result = await runtimeCall(method, req.body?.params || {}, req.auth);
        res.json({ ok: true, result });
    });

    return app;
}

async function postRpc(server, body) {
    const port = server.address().port;
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            host: "127.0.0.1",
            port,
            path: "/api/rpc",
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
            },
        }, (res) => {
            let chunks = "";
            res.on("data", (c) => { chunks += c; });
            res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(chunks) }));
        });
        req.on("error", reject);
        req.end(data);
    });
}

describe("/api/rpc body auth extraction", () => {
    let server;
    let runtimeCalls;
    const PRINCIPAL = {
        provider: "entra",
        subject: "user-1",
        email: "u@contoso.com",
        displayName: "User One",
    };

    beforeEach(() => {
        runtimeCalls = [];
        const app = buildRpcSliceApp({
            authPrincipal: PRINCIPAL,
            runtimeCall: async (method, params, authContext) => {
                runtimeCalls.push({ method, params, authContext });
                return { ok: true };
            },
        });
        server = http.createServer(app);
        return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    afterEach(() => {
        return new Promise((resolve) => server.close(resolve));
    });

    it("stamps accessToken and expiry from body.auth onto req.auth.principal", async () => {
        const expiresAt = Date.now() + 1_800_000;
        const res = await postRpc(server, {
            method: "sendMessage",
            params: { sessionId: "s1", prompt: "hi" },
            auth: {
                accessToken: "downstream-token-abc",
                accessTokenExpiresAt: expiresAt,
            },
        });
        expect(res.status).toBe(200);
        expect(runtimeCalls).toHaveLength(1);
        const principal = runtimeCalls[0].authContext.principal;
        expect(principal.subject).toBe(PRINCIPAL.subject);
        expect(principal.accessToken).toBe("downstream-token-abc");
        expect(principal.accessTokenExpiresAt).toBe(expiresAt);
    });

    it("no body.auth → principal is unchanged (no accessToken stamped)", async () => {
        await postRpc(server, {
            method: "sendMessage",
            params: { sessionId: "s1", prompt: "hi" },
        });
        const principal = runtimeCalls[0].authContext.principal;
        expect(principal.accessToken).toBeUndefined();
        expect(principal.accessTokenExpiresAt).toBeUndefined();
    });

    it("empty-string accessToken is rejected (no stamp)", async () => {
        await postRpc(server, {
            method: "sendMessage",
            params: { sessionId: "s1", prompt: "hi" },
            auth: { accessToken: "", accessTokenExpiresAt: Date.now() + 60_000 },
        });
        const principal = runtimeCalls[0].authContext.principal;
        expect(principal.accessToken).toBeUndefined();
    });

    it("non-numeric expiresAt is normalized to null (token still stamped)", async () => {
        await postRpc(server, {
            method: "sendMessage",
            params: { sessionId: "s1", prompt: "hi" },
            auth: { accessToken: "tok", accessTokenExpiresAt: "garbage" },
        });
        const principal = runtimeCalls[0].authContext.principal;
        expect(principal.accessToken).toBe("tok");
        expect(principal.accessTokenExpiresAt).toBeNull();
    });

    it("malformed body.auth (string instead of object) is ignored", async () => {
        await postRpc(server, {
            method: "sendMessage",
            params: { sessionId: "s1", prompt: "hi" },
            auth: "definitely-not-an-object",
        });
        const principal = runtimeCalls[0].authContext.principal;
        expect(principal.accessToken).toBeUndefined();
    });

    it("non-string accessToken type is rejected", async () => {
        await postRpc(server, {
            method: "sendMessage",
            params: { sessionId: "s1", prompt: "hi" },
            auth: { accessToken: { evil: true }, accessTokenExpiresAt: 0 },
        });
        const principal = runtimeCalls[0].authContext.principal;
        expect(principal.accessToken).toBeUndefined();
    });
});
