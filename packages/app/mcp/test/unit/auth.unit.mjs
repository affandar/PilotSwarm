#!/usr/bin/env node
// Unit test — createApiTokenProvider's credential resolution order.
//
// Regression for the 2026-08-24 campaign fix: PILOTSWARM_API_TOKEN is a
// provider-agnostic static bearer and must win BEFORE the entra-only
// provider gate. Before the fix the gate ran first, so the MCP binary
// refused every dev-auth deployment even with a token in hand.
//
// Usage:  node packages/app/mcp/test/unit/auth.unit.mjs

import http from "node:http";
import { createApiTokenProvider } from "../../dist/src/auth.js";

const results = [];
function record(name, ok, detail = "") {
    results.push({ name, ok });
    console.log(`${ok ? "✅" : "❌"} ${name.padEnd(64)} ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
}

function serveAuthConfig(payload) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url.endsWith("/auth/config")) {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(payload));
                return;
            }
            res.statusCode = 404;
            res.end("{}");
        });
        server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}` }));
    });
}

const devAuth = { enabled: true, provider: "dev" };

// 1. Static token + dev-auth deployment → the token wins; no throw.
{
    const { server, url } = await serveAuthConfig(devAuth);
    process.env.PILOTSWARM_API_TOKEN = "dev:ada";
    try {
        const provider = await createApiTokenProvider(url);
        const token = provider ? await provider() : null;
        record("static token beats the provider gate on a dev-auth deployment", token === "dev:ada", `token=${token}`);
    } catch (error) {
        record("static token beats the provider gate on a dev-auth deployment", false, error.message);
    } finally {
        delete process.env.PILOTSWARM_API_TOKEN;
        server.close();
    }
}

// 2. No token + dev-auth deployment → the unsupported-provider error stands.
{
    const { server, url } = await serveAuthConfig(devAuth);
    try {
        await createApiTokenProvider(url);
        record("no token on a dev-auth deployment still refuses", false, "did not throw");
    } catch (error) {
        record("no token on a dev-auth deployment still refuses", /Unsupported auth provider 'dev'/.test(error.message), error.message);
    } finally {
        server.close();
    }
}

// 3. Auth disabled → null provider, token or not.
{
    const { server, url } = await serveAuthConfig({ enabled: false, provider: "none" });
    process.env.PILOTSWARM_API_TOKEN = "dev:ada";
    try {
        const provider = await createApiTokenProvider(url);
        record("disabled auth needs no provider", provider === null);
    } catch (error) {
        record("disabled auth needs no provider", false, error.message);
    } finally {
        delete process.env.PILOTSWARM_API_TOKEN;
        server.close();
    }
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
    console.error(`\n${failed.length} failure(s)`);
    process.exit(1);
}
console.log(`\nAll ${results.length} auth resolution checks passed`);
