import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    NodeWebAuthError,
    createNodeWebAuth,
} from "../../dist/node-auth.js";

const apiUrl = "https://portal.example";
const sdkRoot = fileURLToPath(new URL("../..", import.meta.url));
const api = (authConfig) => ({
    async getAuthConfig() {
        return authConfig;
    },
});

test("authentication bootstrap is exported only from the Node subpath", () => {
    const packageJson = JSON.parse(readFileSync(`${sdkRoot}/package.json`, "utf8"));
    const rootIndex = readFileSync(`${sdkRoot}/src/index.ts`, "utf8");
    assert.equal(packageJson.exports["./node-auth"].import, "./dist/node-auth.js");
    assert.doesNotMatch(rootIndex, /node-auth/);
});

test("no-auth deployment never emits a configured credential", async () => {
    let created = false;
    const auth = await createNodeWebAuth({
        apiUrl,
        api: api({ enabled: false, provider: "none", client: null }),
        token: "must-not-be-used",
        createCredential() {
            created = true;
            throw new Error("must not run");
        },
    });
    assert.equal(auth.mode, "none");
    assert.equal(auth.credentialOwnership, "none");
    assert.equal(await auth.getAccessToken(), null);
    assert.equal(created, false);
    await auth.close();
    await assert.rejects(
        auth.getAccessToken(),
        (error) => error instanceof NodeWebAuthError && error.code === "CLOSED",
    );
});

test("dev auth uses explicit persona before environment", async () => {
    const auth = await createNodeWebAuth({
        apiUrl,
        api: api({ enabled: true, provider: "dev", client: null }),
        devUser: " ExplicitUser ",
        env: {
            PILOTSWARM_DEV_USER: "environment-user",
        },
    });
    assert.equal(auth.mode, "dev");
    assert.equal(await auth.getAccessToken(), "dev:explicituser");
});

test("dev auth reports a missing persona when explicit null suppresses environment", async () => {
    await assert.rejects(
        createNodeWebAuth({
            apiUrl,
            api: api({ enabled: true, provider: "dev", client: null }),
            devUser: null,
            env: { PILOTSWARM_DEV_USER: "environment-user" },
        }),
        (error) => error instanceof NodeWebAuthError && error.code === "MISSING_DEV_USER",
    );
});

test("configured token wins over environment and identity acquisition", async () => {
    let created = false;
    const auth = await createNodeWebAuth({
        apiUrl,
        api: api({
            enabled: true,
            provider: "entra",
            client: { clientId: "public-client-id" },
        }),
        token: "explicit-token",
        env: { PILOTSWARM_API_TOKEN: "environment-token" },
        createCredential() {
            created = true;
            throw new Error("must not run");
        },
    });
    assert.equal(auth.mode, "configured-token");
    assert.equal(await auth.getAccessToken(), "explicit-token");
    assert.equal(created, false);
});

test("configured identity provider caches, refreshes, and collapses acquisition", async () => {
    let now = 1_000;
    let calls = 0;
    const scopes = [];
    const credential = {
        async getToken(scope) {
            calls++;
            scopes.push(scope);
            await Promise.resolve();
            return {
                token: `token-${calls}`,
                expiresOnTimestamp: now + 1_000,
            };
        },
    };
    const auth = await createNodeWebAuth({
        apiUrl,
        api: api({
            enabled: true,
            provider: "entra",
            client: { clientId: "public-client-id" },
        }),
        token: null,
        env: { PILOTSWARM_API_TOKEN: "suppressed-environment-token" },
        credential,
        refreshSkewMs: 100,
        now: () => now,
    });
    assert.equal(auth.mode, "identity");
    assert.equal(auth.credentialOwnership, "caller");
    assert.deepEqual(await Promise.all([
        auth.getAccessToken(),
        auth.getAccessToken(),
        auth.getAccessToken(),
    ]), ["token-1", "token-1", "token-1"]);
    assert.equal(calls, 1);
    assert.equal(await auth.getAccessToken(), "token-1");

    now = 1_901;
    assert.equal(await auth.getAccessToken(), "token-2");
    assert.equal(calls, 2);
    assert.deepEqual(scopes, ["public-client-id/.default", "public-client-id/.default"]);
});

test("bootstrap closes only credentials it creates", async () => {
    let callerCloseCalls = 0;
    const callerAuth = await createNodeWebAuth({
        apiUrl,
        api: api({
            enabled: true,
            provider: "entra",
            client: { clientId: "public-client-id" },
        }),
        credential: {
            async getToken() {
                return { token: "caller", expiresOnTimestamp: Date.now() + 60_000 };
            },
            async close() {
                callerCloseCalls++;
            },
        },
        refreshSkewMs: 0,
    });
    await callerAuth.close();
    assert.equal(callerCloseCalls, 0);

    let ownedCloseCalls = 0;
    const ownedAuth = await createNodeWebAuth({
        apiUrl,
        api: api({
            enabled: true,
            provider: "entra",
            client: { clientId: "public-client-id" },
        }),
        createCredential: () => ({
            async getToken() {
                return { token: "owned", expiresOnTimestamp: Date.now() + 60_000 };
            },
            async close() {
                ownedCloseCalls++;
            },
        }),
    });
    assert.equal(ownedAuth.credentialOwnership, "bootstrap");
    await ownedAuth.close();
    await ownedAuth.close();
    assert.equal(ownedCloseCalls, 1);
    await assert.rejects(
        ownedAuth.getAccessToken(),
        (error) => error instanceof NodeWebAuthError && error.code === "CLOSED",
    );
});

test("unknown provider fails unless an explicit configured token handles it", async () => {
    await assert.rejects(
        createNodeWebAuth({
            apiUrl,
            api: api({ enabled: true, provider: "unknown", client: null }),
            env: {},
        }),
        (error) => error instanceof NodeWebAuthError && error.code === "UNSUPPORTED_PROVIDER",
    );

    const configured = await createNodeWebAuth({
        apiUrl,
        api: api({ enabled: true, provider: "unknown", client: null }),
        token: "caller-supplied",
    });
    assert.equal(await configured.getAccessToken(), "caller-supplied");
});

test("identity provider requires a public client ID", async () => {
    await assert.rejects(
        createNodeWebAuth({
            apiUrl,
            api: api({ enabled: true, provider: "entra", client: {} }),
            env: {},
        }),
        (error) => error instanceof NodeWebAuthError && error.code === "MISSING_CLIENT_ID",
    );
});

test("token acquisition failure is explicit and does not fall back to anonymous", async () => {
    const auth = await createNodeWebAuth({
        apiUrl,
        api: api({
            enabled: true,
            provider: "entra",
            client: { clientId: "public-client-id" },
        }),
        credential: {
            async getToken() {
                throw new Error("mock acquisition failed");
            },
        },
    });
    await assert.rejects(
        auth.getAccessToken(),
        (error) => {
            assert.ok(error instanceof NodeWebAuthError);
            assert.equal(error.code, "TOKEN_ACQUISITION_FAILED");
            assert.equal(error.message.includes("mock acquisition failed"), false);
            return true;
        },
    );
});

test("auth configuration fetch failures use a stable error code", async () => {
    await assert.rejects(
        createNodeWebAuth({
            apiUrl,
            api: {
                async getAuthConfig() {
                    throw new Error("network detail");
                },
            },
        }),
        (error) => {
            assert.ok(error instanceof NodeWebAuthError);
            assert.equal(error.code, "AUTH_CONFIG_FETCH_FAILED");
            assert.equal(error.message.includes("network detail"), false);
            return true;
        },
    );
});
