// Unit tests for the generic MCP auth discovery module (pure functions +
// resolveMcpServerAuth with mocked HttpDeps). Run: node test/local/mcp-auth-discovery.test.mjs
import assert from "node:assert";
import {
    parseWwwAuthenticate,
    appIdUriFromScope,
    normalizeAudience,
    decodeJwtAudiences,
    audienceMatches,
    resolveMcpServerAuth,
    multiTokenProvider,
    McpAuthFastFailError,
} from "../../dist/mcp-auth-discovery.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok - ${name}`); };

// --- parseWwwAuthenticate: real challenge shapes ---
t("parse: RFC 9728 resource_metadata challenge", () => {
    const wa = parseWwwAuthenticate(
        'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource/"',
    );
    assert.equal(wa.resourceMetadata, "https://example.com/.well-known/oauth-protected-resource/");
});
t("parse: tolerant of missing Bearer prefix + multiple params", () => {
    const wa = parseWwwAuthenticate('error="invalid_token", scope="api://abc/.default"');
    assert.equal(wa.error, "invalid_token");
    assert.equal(wa.scope, "api://abc/.default");
});
t("parse: Microsoft non-standard resource_id/authorization_uri", () => {
    const wa = parseWwwAuthenticate(
        'Bearer authorization_uri="https://login.microsoftonline.com/tid", resource_id="api://myapp"',
    );
    assert.equal(wa.resourceId, "api://myapp");
    assert.equal(wa.authorizationUri, "https://login.microsoftonline.com/tid");
});

// --- appIdUriFromScope: real scopes ---
t("appIdUri: bare GUID .default (ADO first-party)", () => {
    assert.equal(
        appIdUriFromScope("aaaaaaaa-1111-2222-3333-444444444444/.default"),
        "aaaaaaaa-1111-2222-3333-444444444444",
    );
});
t("appIdUri: api:// GUID .default (server's own app)", () => {
    assert.equal(
        appIdUriFromScope("api://11111111-2222-3333-4444-555555555555/.default"),
        "api://11111111-2222-3333-4444-555555555555",
    );
});
t("appIdUri: https resource keeps scheme://host", () => {
    assert.equal(
        appIdUriFromScope("https://resource.example.net/.default"),
        "https://resource.example.net",
    );
});
t("appIdUri: non-.default delegated perm still reduces to app id", () => {
    assert.equal(appIdUriFromScope("api://app-id/access_as_user"), "api://app-id");
});

// --- normalizeAudience / audienceMatches ---
t("normalize: api://<guid> == bare <guid> (case-insensitive)", () => {
    assert.equal(
        normalizeAudience("api://ABCD1234-5678-90AB-CDEF-000000000000/"),
        normalizeAudience("abcd1234-5678-90ab-cdef-000000000000"),
    );
});
t("audienceMatches: ADO token aud matches ADO app id", () => {
    assert.equal(
        audienceMatches("aaaaaaaa-1111-2222-3333-444444444444", ["aaaaaaaa-1111-2222-3333-444444444444"]),
        true,
    );
});
t("audienceMatches: ADO token does NOT match a different api:// app", () => {
    assert.equal(
        audienceMatches("api://11111111-2222-3333-4444-555555555555", ["aaaaaaaa-1111-2222-3333-444444444444"]),
        false,
    );
});

// --- decodeJwtAudiences: synthetic JWT (unverified decode) ---
t("decodeJwtAudiences: extracts aud from a JWT payload", () => {
    const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tok = `${b64url({ alg: "none" })}.${b64url({ aud: "aaaaaaaa-1111-2222-3333-444444444444" })}.sig`;
    assert.deepEqual(decodeJwtAudiences(tok), ["aaaaaaaa-1111-2222-3333-444444444444"]);
});
t("decodeJwtAudiences: array aud", () => {
    const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tok = `x.${b64url({ aud: ["a", "b"] })}.y`;
    assert.deepEqual(decodeJwtAudiences(tok), ["a", "b"]);
});
t("decodeJwtAudiences: garbage -> []", () => {
    assert.deepEqual(decodeJwtAudiences("not-a-jwt"), []);
});

// --- resolveMcpServerAuth: mocked HttpDeps (match case + audience-mismatch fast-fail) ---
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const adoToken = `x.${b64url({ aud: "aaaaaaaa-1111-2222-3333-444444444444" })}.y`;

// Mock: an ADO-audience server (matches caller) and a self-audience server (mismatch).
const makeHttp = () => ({
    async probe(url) {
        return {
            status: 401,
            wwwAuthenticate: `Bearer resource_metadata="https://${new URL(url).host}/.well-known/oauth-protected-resource/"`,
        };
    },
    async getText(url) {
        const host = new URL(url).host;
        if (host.startsWith("ado")) {
            return { status: 200, body: JSON.stringify({ resource: "ado", scopes_supported: ["aaaaaaaa-1111-2222-3333-444444444444/.default"], authorization_servers: ["https://login.microsoftonline.com/tid/v2.0"] }) };
        }
        return { status: 200, body: JSON.stringify({ resource: "self", scopes_supported: ["api://11111111-2222-3333-4444-555555555555/.default"], authorization_servers: ["https://login.microsoftonline.com/tid/v2.0"] }) };
    },
});

await (async () => {
    // Match case: ADO-audience server gets the caller token injected.
    const res = await resolveMcpServerAuth({
        servers: { adoServer: { type: "http", url: "https://ado.example.com/mcp" } },
        getCallerToken: multiTokenProvider({ "aaaaaaaa-1111-2222-3333-444444444444": adoToken }),
        http: makeHttp(),
        trace: () => {},
    });
    assert.deepEqual(res.injected, ["adoServer"]);
    const authz = res.servers.adoServer.headers.Authorization;
    assert.ok(typeof authz === "string" && authz.startsWith("Bearer "), "Authorization header injected");
    passed++; console.log("  ok - resolve: ADO-audience server -> caller token injected");
})();

await (async () => {
    // Mismatch case: self-audience server has no matching caller token -> FAST-FAIL.
    let threw = null;
    try {
        await resolveMcpServerAuth({
            servers: { selfServer: { type: "http", url: "https://self.example.com/mcp" } },
            getCallerToken: multiTokenProvider({ "aaaaaaaa-1111-2222-3333-444444444444": adoToken }),
            http: makeHttp(),
            trace: () => {},
        });
    } catch (e) { threw = e; }
    assert.ok(threw instanceof McpAuthFastFailError, "expected McpAuthFastFailError");
    assert.equal(threw.serverName, "selfServer");
    assert.equal(threw.requiredAudience, "11111111-2222-3333-4444-555555555555");
    passed++; console.log("  ok - resolve: self-audience server -> FAST-FAIL (no MI fallback)");
})();

await (async () => {
    // Never touches the platform identity: stdio/command servers pass through untouched.
    const res = await resolveMcpServerAuth({
        servers: { local: { command: "node", args: ["x.js"] } },
        getCallerToken: multiTokenProvider({ "aaaaaaaa-1111-2222-3333-444444444444": adoToken }),
        http: makeHttp(),
        trace: () => {},
    });
    assert.deepEqual(res.injected, []);
    assert.ok(!res.servers.local.headers, "stdio server left untouched");
    passed++; console.log("  ok - resolve: stdio/command server passed through untouched");
})();

await (async () => {
    // Explicit Authorization already present -> left as-is, not re-resolved.
    const res = await resolveMcpServerAuth({
        servers: { preauth: { type: "http", url: "https://self.example.com/mcp", headers: { Authorization: "Bearer preset" } } },
        getCallerToken: multiTokenProvider({ "aaaaaaaa-1111-2222-3333-444444444444": adoToken }),
        http: makeHttp(),
        trace: () => {},
    });
    assert.deepEqual(res.injected, []);
    assert.equal(res.servers.preauth.headers.Authorization, "Bearer preset");
    passed++; console.log("  ok - resolve: pre-set Authorization preserved");
})();

await (async () => {
    // Provider seam: a getCallerToken that mints a token for ANY discovered
    // audience (simulating OBO exchange) injects into the self-audience server
    // that the static path would have fast-failed on.
    const oboLike = async ({ scope }) => `minted-for.${scope}`;
    const res = await resolveMcpServerAuth({
        servers: { selfServer: { type: "http", url: "https://self.example.com/mcp" } },
        getCallerToken: oboLike,
        http: makeHttp(),
        trace: () => {},
    });
    assert.deepEqual(res.injected, ["selfServer"]);
    assert.ok(
        res.servers.selfServer.headers.Authorization.includes("api://11111111-2222-3333-4444-555555555555/.default"),
        "OBO-like provider token injected for discovered audience",
    );
    passed++; console.log("  ok - resolve: getCallerToken provider mints per-audience token (OBO seam)");
})();

await (async () => {
    // A provider returning null for an audience -> FAST-FAIL (no MI fallback).
    let threw = null;
    try {
        await resolveMcpServerAuth({
            servers: { selfServer: { type: "http", url: "https://self.example.com/mcp" } },
            getCallerToken: async () => null,
            http: makeHttp(),
            trace: () => {},
        });
    } catch (e) { threw = e; }
    assert.ok(threw instanceof McpAuthFastFailError, "provider null -> fast-fail");
    passed++; console.log("  ok - resolve: provider returns null -> FAST-FAIL");
})();

await (async () => {
    // multiTokenProvider: the client-mints map — route by discovered audience.
    const adoAud = "aaaaaaaa-1111-2222-3333-444444444444";
    const p = multiTokenProvider({
        [adoAud]: "ado-token",
        "api://bbbbbbbb-1111-2222-3333-444444444444": "service-b-token",
        "api://empty": "",
    });
    // bare-guid discovered audience matches the map key
    assert.equal(await p({ appIdUri: adoAud, scope: `${adoAud}/.default` }), "ado-token");
    // api:// vs bare-guid normalization: api://<guid> key matches bare-guid discovery and vice-versa
    assert.equal(
        await p({ appIdUri: "api://bbbbbbbb-1111-2222-3333-444444444444", scope: "api://bbbbbbbb-1111-2222-3333-444444444444/.default" }),
        "service-b-token",
    );
    // audience absent from the map -> null (-> fast-fail upstream)
    assert.equal(await p({ appIdUri: "api://unknown", scope: "api://unknown/.default" }), null);
    // empty token value ignored -> null
    assert.equal(await p({ appIdUri: "api://empty", scope: "api://empty/.default" }), null);
    // empty/absent map -> always null
    assert.equal(await multiTokenProvider(null)({ appIdUri: adoAud, scope: `${adoAud}/.default` }), null);
    passed++; console.log("  ok - multiTokenProvider: routes by discovered audience, null when absent");
})();

await (async () => {
    // End-to-end: multiTokenProvider drives resolveMcpServerAuth injection + fast-fail.
    const adoAud = "aaaaaaaa-1111-2222-3333-444444444444";
    const provider = multiTokenProvider({ [adoAud]: adoToken });
    const okResult = await resolveMcpServerAuth({
        servers: { adoServer: { type: "http", url: "https://ado.example.com/mcp" } },
        getCallerToken: provider,
        http: makeHttp(),
        trace: () => {},
    });
    assert.deepEqual(okResult.injected, ["adoServer"], "server whose audience is in the map gets injected");

    let threw = null;
    try {
        await resolveMcpServerAuth({
            servers: { selfServer: { type: "http", url: "https://self.example.com/mcp" } },
            getCallerToken: provider,
            http: makeHttp(),
            trace: () => {},
        });
    } catch (e) { threw = e; }
    assert.ok(threw instanceof McpAuthFastFailError, "server whose audience is absent -> FAST-FAIL (no MI fallback)");
    passed++; console.log("  ok - multiTokenProvider: e2e inject for mapped audience, fast-fail for unmapped");
})();

await (async () => {
    // Optional (fleet-default) server whose audience the caller CAN reach:
    // injected exactly like a normal server, and the `optional` tag is stripped
    // from the emitted config (Copilot must never see it).
    const res = await resolveMcpServerAuth({
        servers: { ado: { type: "http", url: "https://ado.example.com/mcp", optional: true } },
        getCallerToken: multiTokenProvider({ "aaaaaaaa-1111-2222-3333-444444444444": adoToken }),
        http: makeHttp(),
        trace: () => {},
    });
    assert.deepEqual(res.injected, ["ado"], "optional server with a matching token is injected");
    assert.ok(res.servers.ado.headers.Authorization.startsWith("Bearer "), "token injected");
    assert.ok(!("optional" in res.servers.ado), "optional tag stripped from emitted config");
    passed++; console.log("  ok - resolve: optional server WITH matching token -> injected + tag stripped");
})();

await (async () => {
    // Optional (fleet-default) server whose audience the caller CANNOT reach:
    // SKIPPED (dropped from the map) so the session still runs -- NOT a fast-fail.
    const res = await resolveMcpServerAuth({
        servers: { self: { type: "http", url: "https://self.example.com/mcp", optional: true } },
        getCallerToken: multiTokenProvider({ "aaaaaaaa-1111-2222-3333-444444444444": adoToken }),
        http: makeHttp(),
        trace: () => {},
    });
    assert.deepEqual(res.injected, [], "nothing injected");
    assert.equal(res.servers.self, undefined, "optional server with no matching token is dropped, not thrown");
    passed++; console.log("  ok - resolve: optional server WITHOUT matching token -> SKIPPED (no fast-fail)");
})();

await (async () => {
    // Regression guard: a REPO-declared (non-optional) server with no matching
    // token STILL fast-fails -- the optional-skip must not weaken repo servers.
    let threw = null;
    try {
        await resolveMcpServerAuth({
            servers: { self: { type: "http", url: "https://self.example.com/mcp" } },
            getCallerToken: multiTokenProvider({ "aaaaaaaa-1111-2222-3333-444444444444": adoToken }),
            http: makeHttp(),
            trace: () => {},
        });
    } catch (e) { threw = e; }
    assert.ok(threw instanceof McpAuthFastFailError, "non-optional server still fast-fails");
    passed++; console.log("  ok - resolve: NON-optional server WITHOUT token -> still FAST-FAIL (guard)");
})();

await (async () => {
    // Optional tag is stripped even on the pass-through paths (explicit
    // Authorization present -> left as-is, but the tag is removed).
    const res = await resolveMcpServerAuth({
        servers: { preauth: { type: "http", url: "https://self.example.com/mcp", optional: true, headers: { Authorization: "Bearer pre" } } },
        getCallerToken: multiTokenProvider({ "aaaaaaaa-1111-2222-3333-444444444444": adoToken }),
        http: makeHttp(),
        trace: () => {},
    });
    assert.deepEqual(res.injected, []);
    assert.equal(res.servers.preauth.headers.Authorization, "Bearer pre", "explicit auth preserved");
    assert.ok(!("optional" in res.servers.preauth), "optional tag stripped on pass-through too");
    passed++; console.log("  ok - resolve: optional tag stripped on explicit-Authorization pass-through");
})();

console.log(`\n${passed} assertions passed`);
