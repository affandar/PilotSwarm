/**
 * A provider type that stores no key: `anthropic-wif`.
 *
 * Everything in the provider machinery was built around a stored credential.
 * The registry drops a non-github provider with no `apiKey`; the deployment
 * seed writes nothing for an entry with no key; `buildRuntimeRegistry` drops
 * an instance whose credential does not resolve; `normalizeCallerSecret`
 * refuses a create with no credential in it. Each of those is correct for a
 * key provider and wrong for this one, where having no key IS the
 * configuration — the worker authenticates as itself and mints a short-lived
 * token per request.
 *
 * So these tests pin two things at once. That a workload-identity provider
 * survives every one of those gates, AND that a plain `anthropic` provider
 * with no key still dies at all of them: the exemption must be attached to
 * the type, never widened into "a missing credential is fine". The drop is
 * load-bearing — the comment on `buildRuntimeRegistry` records that
 * inheriting the type's key let a personal provider spend the cluster's.
 *
 * Run: node --test test/unit/provider-workload-identity.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    ModelProviderRegistry,
    providerTypeUsesWorkloadIdentity,
    toSdkProviderType,
} from "../../dist/model-providers.js";
import {
    bootstrapSeedFromConfig,
    buildRuntimeRegistry,
    CONFIG_ORIGIN,
    loadProviderTypes,
    resolveProviderCredential,
} from "../../dist/provider-catalog.js";
import { normalizeCallerSecret, WORKLOAD_IDENTITY_KIND } from "../../dist/provider-store.js";
import {
    AnthropicWifCredentials,
    attachWorkloadIdentity,
    readAnthropicWifSettings,
} from "../../dist/wif-credentials.js";

const MODELS = [{ name: "claude-opus-5" }];

const CONFIG = {
    providers: [
        { id: "wif", type: "anthropic-wif", baseUrl: "https://api.anthropic.com", models: MODELS },
        { id: "keyed", type: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-real", models: MODELS },
        { id: "keyless", type: "anthropic", baseUrl: "https://api.anthropic.com", models: MODELS },
    ],
};

/** The environment a correctly configured worker has, Entra two-hop shape. */
const ENTRA_ENV = {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
    ANTHROPIC_ORGANIZATION_ID: "org-uuid",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
    ANTHROPIC_WORKSPACE_ID: "wrkspc_test",
    AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/token",
    AZURE_TENANT_ID: "tenant-guid",
    AZURE_CLIENT_ID: "client-guid",
};

// ── the type itself ──────────────────────────────────────────────

test("only anthropic-wif authenticates as the worker", () => {
    assert.equal(providerTypeUsesWorkloadIdentity("anthropic-wif"), true);
    for (const type of ["anthropic", "openai", "openai-proxy", "azure", "github", undefined, null, ""]) {
        assert.equal(providerTypeUsesWorkloadIdentity(type), false, `${type} must not be exempt`);
    }
});

test("anthropic-wif is anthropic on the wire", () => {
    assert.equal(toSdkProviderType("anthropic-wif"), "anthropic");
    // The existing mappings are unchanged.
    assert.equal(toSdkProviderType("openai-proxy"), "openai");
    assert.equal(toSdkProviderType("anthropic"), "anthropic");
    assert.equal(toSdkProviderType("openai"), "openai");
    assert.equal(toSdkProviderType("azure"), "azure");
});

// ── the registry ─────────────────────────────────────────────────

test("the registry keeps a keyless wif provider and still drops a keyless anthropic one", () => {
    const registry = new ModelProviderRegistry(CONFIG);
    const ids = registry.getModelsByProvider().map((group) => group.providerId);
    assert.deepEqual(ids.sort(), ["keyed", "wif"]);
});

test("resolve() yields an anthropic provider with no apiKey and the flag set", () => {
    const resolved = new ModelProviderRegistry(CONFIG).resolve("wif:claude-opus-5");
    assert.equal(resolved.type, "anthropic-wif", "the declared type survives for the catalog");
    assert.equal(resolved.usesWorkloadIdentity, true);
    assert.equal(resolved.sdkProvider.type, "anthropic", "the SDK never sees the PilotSwarm-only value");
    assert.equal(resolved.sdkProvider.baseUrl, "https://api.anthropic.com");
    assert.ok(!("apiKey" in resolved.sdkProvider),
        "an apiKey key present with no value reads as a broken credential downstream");
});

test("a keyed provider is untouched by any of this", () => {
    const resolved = new ModelProviderRegistry(CONFIG).resolve("keyed:claude-opus-5");
    assert.equal(resolved.usesWorkloadIdentity, undefined);
    assert.equal(resolved.sdkProvider.apiKey, "sk-real");
});

// ── the deployment seed and the runtime registry ─────────────────

test("a wif type seeds a provider, and its marker is not empty", () => {
    const { instances } = bootstrapSeedFromConfig(CONFIG);
    const seeded = instances.find((instance) => instance.name === "wif");
    assert.ok(seeded, "a wif type must seed a provider, or nobody can spend from it");
    assert.equal(seeded.secretRef.kind, WORKLOAD_IDENTITY_KIND);
    assert.equal(seeded.secretRef.source, CONFIG_ORIGIN);
    // has_credential in SQL is `secret_ref <> '{}'`. An empty blob would grey
    // the provider out in the portal and refuse it as a default.
    assert.notDeepEqual(seeded.secretRef, {});
    // The keyless key-provider still seeds nothing.
    assert.equal(instances.some((instance) => instance.name === "keyless"), false);
});

test("buildRuntimeRegistry keeps a wif instance and drops a credential-less keyed one", () => {
    const types = loadProviderTypes(CONFIG);
    const registry = buildRuntimeRegistry(types, [
        { name: "mine", typeId: "wif", class: "shared", secretRef: { kind: WORKLOAD_IDENTITY_KIND } },
        { name: "broken", typeId: "keyed", class: "shared", secretRef: {} },
    ], null);
    const ids = registry.getModelsByProvider().map((group) => group.providerId);
    assert.deepEqual(ids, ["mine"]);

    const resolved = registry.resolve("mine:claude-opus-5");
    assert.equal(resolved.usesWorkloadIdentity, true);
    assert.ok(!("apiKey" in resolved.sdkProvider));
});

test("resolveProviderCredential resolves a wif instance without a secret", () => {
    const types = loadProviderTypes(CONFIG);
    const resolved = resolveProviderCredential(
        types,
        { name: "mine", typeId: "wif", class: "shared", secretRef: { kind: WORKLOAD_IDENTITY_KIND } },
        "claude-opus-5",
    );
    assert.ok(resolved, "a wif provider needs an endpoint but never a key");
    assert.equal(resolved.usesWorkloadIdentity, true);
    assert.equal(resolved.sdkProvider.type, "anthropic");
    assert.ok(!("apiKey" in resolved.sdkProvider));

    // The same call on a key type with no key still refuses.
    assert.equal(
        resolveProviderCredential(types, { name: "x", typeId: "keyed", class: "shared", secretRef: {} }, "claude-opus-5"),
        null);
});

test("a per-instance baseUrl cannot redirect the worker's own credential", () => {
    // The exploit this closes: `createMyProvider` is open to any signed-in
    // user and takes a baseUrl straight from the request body. On a key type
    // that is harmless — the row carries the caller's own key, so aiming it
    // elsewhere leaks only their own. On a workload-identity type the
    // credential is the WORKER'S, so honouring the override would deliver a
    // live Anthropic token to a host the requester named.
    const types = loadProviderTypes(CONFIG);
    // Shared, because a personal one of this type is refused outright now (see
    // the test below). An administrator naming a hostile endpoint is the
    // weaker threat, and this must hold for them too.
    const hostile = {
        name: "mine", typeId: "wif", class: "shared",
        baseUrl: "https://evil.example.com", secretRef: { kind: WORKLOAD_IDENTITY_KIND },
    };

    const direct = resolveProviderCredential(types, hostile, "claude-opus-5");
    assert.equal(direct.sdkProvider.baseUrl, "https://api.anthropic.com",
        "a workload-identity provider is pinned to the endpoint its type declares");

    const registry = buildRuntimeRegistry(types, [hostile], null);
    assert.equal(registry.resolve("mine:claude-opus-5").sdkProvider.baseUrl, "https://api.anthropic.com");

    // The override still works where it is safe, or the fix has broken a
    // legitimate feature: a row carrying its own key may name its own endpoint.
    const keyed = resolveProviderCredential(
        types,
        {
            name: "k", typeId: "keyed", class: "personal",
            baseUrl: "https://my-gateway.example.com", secretRef: { kind: "apiKey", value: "sk-mine" },
        },
        "claude-opus-5");
    assert.equal(keyed.sdkProvider.baseUrl, "https://my-gateway.example.com");
});

test("a workload-identity provider may not be personal — it spends the cluster's account", () => {
    // The other half of the same bypass the comment in buildRuntimeRegistry
    // describes. This credential is the ORGANIZATION'S, and a personal
    // provider answers only to its owner: `cms_provider_assert_manage` does
    // not consult the admin flag on the personal branch, so an administrator
    // cannot cap, hold, or even delete one — and any signed-in person may
    // create one through POST /me/providers. So a personal row of this type
    // never runs, whichever path wrote it.
    const types = loadProviderTypes(CONFIG);
    const personal = { name: "sneaky", typeId: "wif", class: "personal", secretRef: { kind: WORKLOAD_IDENTITY_KIND } };
    const shared = { name: "fleet", typeId: "wif", class: "shared", secretRef: { kind: WORKLOAD_IDENTITY_KIND } };

    const registry = buildRuntimeRegistry(types, [personal, shared], null);
    const ids = registry.getModelsByProvider().map((group) => group.providerId);
    assert.deepEqual(ids, ["fleet"], "only the shared one survives");

    // A personal provider of a KEY type is untouched — it runs on its owner's
    // own key, which is the entire point of a personal provider.
    const keyedPersonal = buildRuntimeRegistry(types, [
        { name: "carol", typeId: "keyed", class: "personal", secretRef: { kind: "apiKey", value: "sk-carol" } },
    ], null);
    assert.deepEqual(keyedPersonal.getModelsByProvider().map((group) => group.providerId), ["carol"]);
});

// ── the credential boundary ──────────────────────────────────────

test("a wif create stores a marker and keeps no key, however the caller asked", () => {
    assert.deepEqual(normalizeCallerSecret(null, { workloadIdentity: true }), { kind: WORKLOAD_IDENTITY_KIND });
    // A key sent for a type that cannot use one is DISCARDED, not stored: it
    // would be a real secret sitting in a row nothing reads a secret from.
    assert.deepEqual(
        normalizeCallerSecret({ apiKey: "sk-oops" }, { workloadIdentity: true }),
        { kind: WORKLOAD_IDENTITY_KIND });
});

test("a caller cannot declare itself keyless — only the type-aware layer may", () => {
    // Honouring a caller-declared `kind` looked harmless, because a provider
    // runs only if its TYPE is a workload-identity type. But it is a way to
    // write a credential-less row on ANY type: on a create, a provider the
    // portal shows as credentialed that can never run a turn; on an update,
    // a real key REPLACED by a marker and reported as a rotation.
    assert.throws(() => normalizeCallerSecret({ kind: WORKLOAD_IDENTITY_KIND }), /needs a credential/);
    assert.throws(() => normalizeCallerSecret({ kind: WORKLOAD_IDENTITY_KIND, apiKey: "" }), /needs a credential/);
    // A key sent alongside the declaration is still stored as the key it is,
    // so an update carrying one is a real rotation and not a silent wipe.
    assert.deepEqual(
        normalizeCallerSecret({ kind: WORKLOAD_IDENTITY_KIND, apiKey: "sk-real" }),
        { kind: "apiKey", value: "sk-real" });
});

test("the boundary for every other provider is unchanged", () => {
    assert.throws(() => normalizeCallerSecret(null), /needs a credential/);
    assert.throws(() => normalizeCallerSecret({}), /needs a credential/);
    // The pointer refusal is the reason this boundary exists; a new exemption
    // must not have opened a way around it.
    assert.throws(() => normalizeCallerSecret({ apiKey: "env:AZURE_KEY" }), /not a reference/);
    assert.throws(() => normalizeCallerSecret({ value: " Env:AZURE_KEY" }), /not a reference/);
    assert.deepEqual(normalizeCallerSecret({ apiKey: "sk-1" }), { kind: "apiKey", value: "sk-1" });
});

// ── reading the worker's environment ─────────────────────────────

test("the Entra two-hop shape is read, and the scope defaults to the identity itself", () => {
    const found = readAnthropicWifSettings(ENTRA_ENV);
    assert.equal(found.ok, true);
    assert.deepEqual(found.settings.identity, {
        kind: "entra",
        tokenFile: "/var/run/secrets/token",
        tenantId: "tenant-guid",
        clientId: "client-guid",
        scope: "client-guid/.default",
    });
    assert.equal(found.settings.workspaceId, "wrkspc_test");
    assert.equal(found.settings.baseUrl, "https://api.anthropic.com");
});

test("the identity to claim and the audience can each be overridden", () => {
    const found = readAnthropicWifSettings({
        ...ENTRA_ENV,
        ANTHROPIC_WIF_AZURE_CLIENT_ID: "other-identity",
        ANTHROPIC_WIF_AZURE_SCOPE: "api://audience-app/.default",
    });
    assert.equal(found.settings.identity.clientId, "other-identity",
        "the injected AZURE_CLIENT_ID is not always the identity the rule names");
    assert.equal(found.settings.identity.scope, "api://audience-app/.default");
});

test("a ready-made assertion wins over the Azure hop", () => {
    const file = readAnthropicWifSettings({ ...ENTRA_ENV, ANTHROPIC_IDENTITY_TOKEN_FILE: "/tmp/jwt" });
    assert.deepEqual(file.settings.identity, { kind: "file", path: "/tmp/jwt" });
    const literal = readAnthropicWifSettings({ ...ENTRA_ENV, ANTHROPIC_IDENTITY_TOKEN: "ey.J.WT" });
    assert.deepEqual(literal.settings.identity, { kind: "literal", token: "ey.J.WT" });
});

test("what is missing is named, rather than discovered as a 401", () => {
    const found = readAnthropicWifSettings({ AZURE_FEDERATED_TOKEN_FILE: "/t", AZURE_TENANT_ID: "x", AZURE_CLIENT_ID: "c" });
    assert.equal(found.ok, false);
    assert.deepEqual(found.missing, [
        "ANTHROPIC_FEDERATION_RULE_ID",
        "ANTHROPIC_ORGANIZATION_ID",
        "ANTHROPIC_SERVICE_ACCOUNT_ID",
    ]);

    const noIdentity = readAnthropicWifSettings({
        ANTHROPIC_FEDERATION_RULE_ID: "r", ANTHROPIC_ORGANIZATION_ID: "o", ANTHROPIC_SERVICE_ACCOUNT_ID: "s",
    });
    assert.equal(noIdentity.ok, false);
    assert.match(noIdentity.missing.join(" "), /ANTHROPIC_IDENTITY_TOKEN_FILE/);
});

// ── minting, caching and refreshing the token ────────────────────

/** A fetch double that records calls and answers from a script. */
function stubFetch(handlers) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        const handler = handlers.find((candidate) => String(url).includes(candidate.match));
        if (!handler) throw new Error(`unexpected fetch: ${url}`);
        const body = handler.body();
        return {
            ok: handler.ok !== false,
            status: handler.status ?? 200,
            headers: { get: (name) => (handler.headers ?? {})[name] ?? null },
            json: async () => body,
        };
    };
    return { fetchImpl, calls };
}

const entraOk = (expiresIn = 3600) => ({
    match: "login.microsoftonline.com",
    body: () => ({ access_token: "entra-jwt", expires_in: expiresIn }),
});
const anthropicOk = (expiresIn = 3600, token = "sk-ant-oat01-x") => ({
    match: "/v1/oauth/token",
    body: () => ({ access_token: token, expires_in: expiresIn }),
});

function credentialsFor(handlers, { now = () => 0, readFile = async () => "projected-token" } = {}) {
    const { fetchImpl, calls } = stubFetch(handlers);
    const settings = readAnthropicWifSettings(ENTRA_ENV).settings;
    return { creds: new AnthropicWifCredentials(settings, { fetch: fetchImpl, readFile, now }), calls };
}

test("the two hops are made in order, with the shapes each endpoint requires", async () => {
    const { creds, calls } = credentialsFor([entraOk(), anthropicOk()]);
    assert.equal(await creds.getToken(), "sk-ant-oat01-x");
    assert.equal(calls.length, 2);

    const [entra, anthropic] = calls;
    assert.match(entra.url, /login\.microsoftonline\.com\/tenant-guid\/oauth2\/v2\.0\/token$/);
    const form = new URLSearchParams(entra.init.body);
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("client_id"), "client-guid");
    assert.equal(form.get("scope"), "client-guid/.default");
    assert.equal(form.get("client_assertion"), "projected-token");
    assert.equal(form.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");

    assert.equal(anthropic.url, "https://api.anthropic.com/v1/oauth/token");
    assert.deepEqual(JSON.parse(anthropic.init.body), {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: "entra-jwt",
        federation_rule_id: "fdrl_test",
        organization_id: "org-uuid",
        service_account_id: "svac_test",
        workspace_id: "wrkspc_test",
    });
});

test("an absent workspace is omitted rather than sent empty", async () => {
    const { fetchImpl, calls } = stubFetch([entraOk(), anthropicOk()]);
    const { ANTHROPIC_WORKSPACE_ID, ...rest } = ENTRA_ENV;
    const settings = readAnthropicWifSettings(rest).settings;
    await new AnthropicWifCredentials(settings, { fetch: fetchImpl, readFile: async () => "t", now: () => 0 }).getToken();
    assert.ok(!("workspace_id" in JSON.parse(calls[1].init.body)),
        "the exchange validates the shape of a workspace it is given");
});

test("the token is cached — without it every request would mint two", async () => {
    const { creds, calls } = credentialsFor([entraOk(), anthropicOk()]);
    for (let i = 0; i < 5; i += 1) assert.equal(await creds.getToken(), "sk-ant-oat01-x");
    assert.equal(calls.length, 2, "one Entra hop and one exchange serve every later request");
});

test("concurrent callers share one exchange", async () => {
    // The callback fires per outbound request and a worker runs many turns at
    // once; without single-flight a burst mints a token each.
    const { creds, calls } = credentialsFor([entraOk(), anthropicOk()]);
    const tokens = await Promise.all(Array.from({ length: 10 }, () => creds.getToken()));
    assert.deepEqual(new Set(tokens), new Set(["sk-ant-oat01-x"]));
    assert.equal(calls.length, 2);
});

test("a token is replaced before it expires, not after", async () => {
    let clock = 0;
    let issued = 0;
    const { fetchImpl, calls } = stubFetch([
        entraOk(86_400),
        { match: "/v1/oauth/token", body: () => ({ access_token: `tok-${++issued}`, expires_in: 3600 }) },
    ]);
    const settings = readAnthropicWifSettings(ENTRA_ENV).settings;
    const creds = new AnthropicWifCredentials(settings, {
        fetch: fetchImpl, readFile: async () => "projected", now: () => clock,
    });

    assert.equal(await creds.getToken(), "tok-1");
    // The token lives an hour and is replaced five minutes early, so 50
    // minutes in it is still the same one — the margin is not a re-mint on
    // every call.
    clock = 3_000_000;
    assert.equal(await creds.getToken(), "tok-1");
    // 56 minutes: inside the hour, but inside the margin too. A token used at
    // the instant it expires is a failed request — the clock on the far side
    // is not this one, and the request still has to travel.
    clock = 3_360_000;
    assert.equal(await creds.getToken(), "tok-2");
    // Both hops re-ran: the Entra token claimed a day, but nothing tells this
    // process that a credential was revoked, so no token is trusted for more
    // than an hour however long it says it is good for.
    assert.equal(calls.filter((call) => call.url.includes("microsoftonline")).length, 2);
});

test("no token is trusted for longer than an hour, whatever it claims", async () => {
    // A revoked credential produces no signal here — the only symptom is that
    // requests start failing. Cached for its full claimed life, a day-long
    // token would keep a worker broken for a day. An absurd claim is capped
    // the same way.
    let clock = 0;
    let issued = 0;
    const { fetchImpl } = stubFetch([
        entraOk(86_400),
        { match: "/v1/oauth/token", body: () => ({ access_token: `tok-${++issued}`, expires_in: 1e15 }) },
    ]);
    const settings = readAnthropicWifSettings(ENTRA_ENV).settings;
    const creds = new AnthropicWifCredentials(settings, {
        fetch: fetchImpl, readFile: async () => "projected", now: () => clock,
    });

    assert.equal(await creds.getToken(), "tok-1");
    clock = 50 * 60_000;                       // 50 min — still inside the hour
    assert.equal(await creds.getToken(), "tok-1");
    clock = 56 * 60_000;                       // past the hour minus the margin
    assert.equal(await creds.getToken(), "tok-2");
});

test("a lifetime the endpoint does not give is assumed, never treated as zero", async () => {
    // Reading a missing `expires_in` as "expires now" turns the cache off in
    // silence. The callback runs before EVERY outbound request, so that is one
    // token exchange per LLM request until the endpoint throttles — no error,
    // no log, just latency and then 429s.
    for (const expiresIn of [undefined, 0, null, -1, "abc"]) {
        let clock = 0;
        const { fetchImpl, calls } = stubFetch([
            entraOk(3600),
            { match: "/v1/oauth/token", body: () => ({ access_token: "tok", expires_in: expiresIn }) },
        ]);
        const settings = readAnthropicWifSettings(ENTRA_ENV).settings;
        const creds = new AnthropicWifCredentials(settings, {
            fetch: fetchImpl, readFile: async () => "projected", now: () => clock,
        });
        for (let i = 0; i < 5; i += 1) assert.equal(await creds.getToken(), "tok");
        const exchanges = calls.filter((call) => call.url.includes("/v1/oauth/token")).length;
        assert.equal(exchanges, 1, `expires_in ${JSON.stringify(expiresIn)} must not disable caching`);
        // Assumed a minute, so it is still replaced promptly rather than held
        // past a lifetime nobody promised.
        clock = 60_000;
        await creds.getToken();
        assert.equal(calls.filter((call) => call.url.includes("/v1/oauth/token")).length, 2);
    }
});

test("reset() is not undone by an exchange that was already in flight", async () => {
    // Clearing the fields alone does not work: the in-flight mint resolves
    // afterwards and writes the very token reset() was called to discard
    // straight back into the cache, so the next caller gets the revoked one.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let issued = 0;
    const { fetchImpl } = stubFetch([
        entraOk(),
        {
            match: "/v1/oauth/token",
            body: () => ({ access_token: `tok-${++issued}`, expires_in: 3600 }),
        },
    ]);
    const settings = readAnthropicWifSettings(ENTRA_ENV).settings;
    const creds = new AnthropicWifCredentials(settings, {
        now: () => 0,
        readFile: async () => "projected",
        fetch: async (url, init) => { await gate; return fetchImpl(url, init); },
    });

    const inFlight = creds.getToken();
    creds.reset();
    release();
    assert.equal(await inFlight, "tok-1", "the caller that asked still gets an answer");
    assert.equal(await creds.getToken(), "tok-2", "but the discarded token was not cached");
});

test("the projected token file is re-read on every exchange", async () => {
    // Kubernetes rewrites that file as it rotates; a copy read at startup
    // stops verifying the moment it does.
    let clock = 0;
    const reads = [];
    const { fetchImpl } = stubFetch([
        { match: "login.microsoftonline.com", body: () => ({ access_token: "e", expires_in: 60 }) },
        { match: "/v1/oauth/token", body: () => ({ access_token: "a", expires_in: 60 }) },
    ]);
    const settings = readAnthropicWifSettings(ENTRA_ENV).settings;
    const creds = new AnthropicWifCredentials(settings, {
        fetch: fetchImpl, now: () => clock,
        readFile: async (path) => { reads.push(path); return "projected"; },
    });
    await creds.getToken();
    clock = 120_000;
    await creds.getToken();
    assert.equal(reads.length, 2);
    assert.deepEqual(new Set(reads), new Set(["/var/run/secrets/token"]));
});

test("a failed exchange carries the request id, and is not cached", async () => {
    let attempt = 0;
    const { fetchImpl } = stubFetch([
        entraOk(),
        {
            match: "/v1/oauth/token",
            get ok() { return attempt > 0; },
            get status() { return attempt++ === 0 ? 401 : 200; },
            headers: { "request-id": "req_abc" },
            body: () => ({ access_token: "sk-ant-oat01-later", expires_in: 3600 }),
        },
    ]);
    const settings = readAnthropicWifSettings(ENTRA_ENV).settings;
    const creds = new AnthropicWifCredentials(settings, { fetch: fetchImpl, readFile: async () => "t", now: () => 0 });

    // Every denial is the same opaque 401; the id is the only way to look up
    // which check failed in the console's authentication history.
    await assert.rejects(() => creds.getToken(), (error) => {
        assert.match(error.message, /req_abc/);
        assert.match(error.message, /authentication history/);
        assert.equal(error.status, 401);
        assert.equal(error.requestId, "req_abc");
        return true;
    });
    // A failure is never cached: this is what recovers a worker that started
    // before its token file was mounted.
    assert.equal(await creds.getToken(), "sk-ant-oat01-later");
});

test("an Entra refusal says what Entra said", async () => {
    const { fetchImpl } = stubFetch([{
        match: "login.microsoftonline.com",
        ok: false,
        status: 400,
        body: () => ({
            error: "invalid_request",
            error_description: "AADSTS500011: The resource principal was not found in the tenant.\nTrace ID: x",
        }),
    }]);
    const settings = readAnthropicWifSettings(ENTRA_ENV).settings;
    const creds = new AnthropicWifCredentials(settings, { fetch: fetchImpl, readFile: async () => "t", now: () => 0 });
    await assert.rejects(() => creds.getToken(), (error) => {
        assert.match(error.message, /AADSTS500011/);
        assert.ok(!error.message.includes("Trace ID"), "the first line is the useful one");
        return true;
    });
});

// ── handing the callback to the Copilot SDK ──────────────────────

test("a wif provider is given a callback, and nothing else is touched", async () => {
    const resolved = new ModelProviderRegistry(CONFIG).resolve("wif:claude-opus-5");
    const provider = attachWorkloadIdentity(resolved, {
        env: ENTRA_ENV,
        credentials: () => ({ getToken: async () => "sk-ant-oat01-live" }),
    });
    assert.equal(typeof provider.bearerTokenProvider, "function");
    assert.equal(await provider.bearerTokenProvider(), "sk-ant-oat01-live");
    assert.equal(provider.type, "anthropic");
    assert.ok(!("apiKey" in provider), "a bearer token is not an api key; the runtime sends x-api-key for one");

    // A keyed provider comes back by identity — this runs on the whole path.
    const keyed = new ModelProviderRegistry(CONFIG).resolve("keyed:claude-opus-5");
    assert.equal(attachWorkloadIdentity(keyed, { env: ENTRA_ENV }), keyed.sdkProvider);
});

test("the callback does not disturb the provider fingerprint", () => {
    // session-manager hashes JSON.stringify(provider) to decide whether the
    // provider changed under a session. JSON.stringify drops functions, so a
    // resumed session must hash the same as it did when created — otherwise
    // every resume looks like a provider change and forces a fresh CLI session.
    const resolved = new ModelProviderRegistry(CONFIG).resolve("wif:claude-opus-5");
    const withCallback = attachWorkloadIdentity(resolved, {
        env: ENTRA_ENV,
        credentials: () => ({ getToken: async () => "t" }),
    });
    assert.equal(JSON.stringify(withCallback), JSON.stringify(resolved.sdkProvider));
});

test("a misconfigured worker is told which variables are missing", () => {
    const resolved = new ModelProviderRegistry(CONFIG).resolve("wif:claude-opus-5");
    assert.throws(
        () => attachWorkloadIdentity(resolved, { env: {} }),
        (error) => {
            assert.match(error.message, /"wif"/);
            assert.match(error.message, /ANTHROPIC_FEDERATION_RULE_ID/);
            return true;
        },
        "an opaque 401 on the first turn of every session is the alternative");
});
