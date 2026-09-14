import test from "node:test";
import assert from "node:assert/strict";

import {
    McpAuthParseError,
    audienceFromScope,
    bearerChallenges,
    normalizeAudience,
    parseProtectedResourceMetadata,
    parseWwwAuthenticate,
} from "../../dist/mcp-auth.js";
import {
    McpMetadataFetchError,
    discoverMcpResourceAudiences,
    fetchProtectedResourceMetadata,
    resolveMcpServerAuth,
} from "../../dist/mcp-auth-discovery.js";

const PUBLIC_ADDRESS = "93.184.216.34";

function dependencies(handler, addresses = [PUBLIC_ADDRESS]) {
    return {
        async resolveHostname() {
            return addresses;
        },
        request: handler,
    };
}

test("parses multiple challenges and commas inside quoted parameters", () => {
    const challenges = parseWwwAuthenticate([
        'Basic realm="login, please", Bearer resource="api://service", scope="api://service/.default"',
        'Bearer resource_metadata="https://metadata.example/.well-known/oauth-protected-resource"',
    ]);
    assert.deepEqual(challenges.map(({ scheme }) => scheme), ["Basic", "Bearer", "Bearer"]);
    assert.deepEqual(bearerChallenges([
        'Basic realm="login, please", Bearer resource="api://service", scope="api://service/.default"',
        'Bearer resource_metadata="https://metadata.example/.well-known/oauth-protected-resource"',
    ]), [
        { resourceMetadata: undefined, resource: "api://service", scope: "api://service/.default" },
        {
            resourceMetadata: "https://metadata.example/.well-known/oauth-protected-resource",
            resource: undefined,
            scope: undefined,
        },
    ]);
});

test("rejects malformed challenge quoting without partial parsing", () => {
    assert.throws(
        () => parseWwwAuthenticate('Bearer resource_metadata="https://metadata.example/path, scope="x"'),
        McpAuthParseError,
    );
});

test("parses only typed protected-resource fields", () => {
    assert.deepEqual(
        parseProtectedResourceMetadata(JSON.stringify({
            resource: "api://service",
            scopes_supported: ["api://service/.default"],
            ignored_private_field: "not surfaced",
        })),
        { resource: "api://service", scopesSupported: ["api://service/.default"] },
    );
    assert.throws(
        () => parseProtectedResourceMetadata('{"scopes_supported":[7]}'),
        McpAuthParseError,
    );
});

test("normalizes resource audiences for routing without decoding tokens", () => {
    const guid = "11111111-2222-4333-8444-555555555555";
    assert.equal(normalizeAudience(`api://${guid.toUpperCase()}/`), guid);
    assert.equal(normalizeAudience(guid), guid);
    assert.equal(normalizeAudience("HTTPS://Example.COM/resource/"), "https://example.com/resource");
    assert.equal(audienceFromScope("api://service/access_as_user"), "api://service");
    assert.equal(audienceFromScope("https://resource.example/.default"), "https://resource.example");
});

test("rejects non-HTTPS metadata before DNS or network access", async () => {
    let touched = false;
    await assert.rejects(
        fetchProtectedResourceMetadata("http://metadata.example/path", {
            dependencies: dependencies(async () => {
                touched = true;
                throw new Error("must not run");
            }),
        }),
        (error) => error instanceof McpMetadataFetchError && error.code === "INVALID_URL",
    );
    assert.equal(touched, false);
});

test("revalidates redirects and blocks a redirect to a private address", async () => {
    let requests = 0;
    await assert.rejects(
        fetchProtectedResourceMetadata("https://metadata.example/start", {
            dependencies: {
                async resolveHostname(hostname) {
                    return hostname === "metadata.example" ? [PUBLIC_ADDRESS] : ["127.0.0.1"];
                },
                async request() {
                    requests++;
                    return {
                        status: 302,
                        headers: { location: "https://private.example/metadata" },
                        body: "",
                    };
                },
            },
        }),
        (error) => error instanceof McpMetadataFetchError && error.code === "SSRF_BLOCKED",
    );
    assert.equal(requests, 1);
});

test("rejects deprecated IPv6 site-local metadata targets", async () => {
    for (const [url, addresses] of [
        ["https://[fec0::1]/metadata", [PUBLIC_ADDRESS]],
        ["https://metadata.example/path", ["feff::1"]],
    ]) {
        let requested = false;
        await assert.rejects(
            fetchProtectedResourceMetadata(url, {
                dependencies: dependencies(async () => {
                    requested = true;
                    throw new Error("must not run");
                }, addresses),
            }),
            (error) => error instanceof McpMetadataFetchError && error.code === "SSRF_BLOCKED",
        );
        assert.equal(requested, false);
    }
});

test("follows bounded HTTPS redirects and returns metadata", async () => {
    const visited = [];
    const body = await fetchProtectedResourceMetadata("https://metadata.example/start", {
        dependencies: dependencies(async (url, address) => {
            visited.push([url.href, address]);
            return visited.length === 1
                ? { status: 307, headers: { Location: "/final" }, body: "" }
                : { status: 200, body: '{"resource":"api://service"}' };
        }),
    });
    assert.equal(body, '{"resource":"api://service"}');
    assert.deepEqual(visited, [
        ["https://metadata.example/start", PUBLIC_ADDRESS],
        ["https://metadata.example/final", PUBLIC_ADDRESS],
    ]);
});

test("rejects oversized streaming metadata responses", async () => {
    async function* oversized() {
        yield Buffer.alloc(5);
        yield Buffer.alloc(5);
    }
    await assert.rejects(
        fetchProtectedResourceMetadata("https://metadata.example/path", {
            maxResponseBytes: 8,
            dependencies: dependencies(async () => ({ status: 200, body: oversized() })),
        }),
        (error) => error instanceof McpMetadataFetchError && error.code === "RESPONSE_TOO_LARGE",
    );
});

test("times out a metadata transport that does not settle", async () => {
    await assert.rejects(
        fetchProtectedResourceMetadata("https://metadata.example/path", {
            timeoutMs: 10,
            dependencies: dependencies(() => new Promise(() => {})),
        }),
        (error) => error instanceof McpMetadataFetchError && error.code === "TIMEOUT",
    );
});

test("times out DNS resolution as part of the metadata deadline", async () => {
    await assert.rejects(
        fetchProtectedResourceMetadata("https://metadata.example/path", {
            timeoutMs: 10,
            dependencies: {
                resolveHostname: () => new Promise(() => {}),
                async request() {
                    throw new Error("must not run");
                },
            },
        }),
        (error) => error instanceof McpMetadataFetchError && error.code === "TIMEOUT",
    );
});

test("times out a metadata response body that stalls after headers", async () => {
    async function* stalled() {
        yield "{}";
        await new Promise(() => {});
    }
    await assert.rejects(
        fetchProtectedResourceMetadata("https://metadata.example/path", {
            timeoutMs: 10,
            dependencies: dependencies(async () => ({ status: 200, body: stalled() })),
        }),
        (error) => error instanceof McpMetadataFetchError && error.code === "TIMEOUT",
    );
});

test("rejects invalid metadata JSON during audience discovery", async () => {
    await assert.rejects(
        discoverMcpResourceAudiences(
            'Bearer resource_metadata="https://metadata.example/path"',
            {
                dependencies: dependencies(async () => ({ status: 200, body: "not-json" })),
            },
        ),
        McpAuthParseError,
    );
});

test("discovers and deduplicates inline and metadata audiences", async () => {
    const audiences = await discoverMcpResourceAudiences([
        'Bearer resource="api://11111111-2222-4333-8444-555555555555"',
        'Bearer resource_metadata="https://metadata.example/path"',
    ], {
        dependencies: dependencies(async () => ({
            status: 200,
            body: JSON.stringify({
                resource: "11111111-2222-4333-8444-555555555555",
                scopes_supported: ["11111111-2222-4333-8444-555555555555/.default"],
            }),
        })),
    });
    assert.equal(audiences.length, 1);
    assert.equal(audiences[0].normalizedAudience, "11111111-2222-4333-8444-555555555555");
});

test("metadata requests cannot receive bearer tokens or unknown challenge parameters", async () => {
    const secret = "secret-value-that-must-not-leak";
    const observed = [];
    await discoverMcpResourceAudiences(
        `Bearer resource_metadata="https://metadata.example/path", token="${secret}"`,
        {
            dependencies: dependencies(async (...args) => {
                observed.push(args);
                return { status: 200, body: '{"resource":"api://service"}' };
            }),
        },
    );
    assert.equal(JSON.stringify(observed).includes(secret), false);
    assert.equal(observed[0].length, 3);
    assert.equal(observed[0][0].href, "https://metadata.example/path");
});

test("required servers fail closed on rejected metadata while optional servers are omitted", async () => {
    const http = {
        async probe() {
            return {
                status: 401,
                wwwAuthenticate: 'Bearer resource_metadata="http://metadata.example/path"',
            };
        },
        async getText() {
            throw new Error("insecure metadata must be rejected before fetching");
        },
    };

    await assert.rejects(
        resolveMcpServerAuth({
            servers: { required: { type: "http", url: "https://service.example/mcp" } },
            http,
        }),
        (error) => error instanceof McpMetadataFetchError && error.code === "INVALID_URL",
    );

    assert.deepEqual(await resolveMcpServerAuth({
        servers: {
            optional: {
                type: "http",
                url: "https://service.example/mcp",
                optional: true,
            },
        },
        http,
    }), {
        servers: {},
        injected: [],
    });
});
