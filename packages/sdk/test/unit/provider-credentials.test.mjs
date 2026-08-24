/**
 * Provider budgets — the credential boundary.
 *
 * A live audit against the running portal found two ways a credential could
 * become something it was not, both reachable by any signed-in user through
 * `POST /me/providers`:
 *
 * 1. A caller could send `{"ref": "env:AZURE_OAI_KEY"}`. The config file is
 *    allowed to store a POINTER like that, resolved against the worker's own
 *    environment — so the worker would read the CLUSTER's key (or the
 *    database URL, or any variable it holds), and send it to whatever
 *    baseUrl the same request named.
 *
 * 2. A caller who sent the natural `{"apiKey": "..."}` shape got a provider
 *    whose credential the runtime could not read, and the registry then fell
 *    back to the TYPE's credential — so a personal provider silently spent
 *    the cluster's key, under a name no administrator can put a limit on,
 *    because a personal provider answers only to its owner.
 *
 * Both are boundary questions, so both are pinned here rather than in the
 * database tests: the boundary is where a request stops being a request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCallerSecret } from "../../dist/provider-store.js";
import {
    bootstrapSeedFromConfig,
    buildRuntimeRegistry,
    CONFIG_ORIGIN,
    ModelAmbiguousError,
    resolveRuntimeModelSelection,
} from "../../dist/provider-catalog.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { SessionManager } from "../../dist/session-manager.js";

const TYPES = new ModelProviderRegistry({
    providers: [
        {
            id: "azure-openai", type: "openai",
            baseUrl: "https://cluster.example/openai/v1",
            apiKey: "CLUSTER-AZURE-KEY",
            models: [{ name: "gpt-5.4" }],
        },
        {
            id: "github-copilot", type: "github",
            githubToken: "CLUSTER-GHCP-TOKEN",
            models: [{ name: "claude-opus-5" }],
        },
    ],
}, { keepUncredentialed: true });

const personal = (name, typeId, secretRef) => ({
    name, typeId, class: "personal", ownerUserId: 2, baseUrl: null, secretRef,
});

test("bootstrap omits a default whose provider has no shared credential", () => {
    const seed = bootstrapSeedFromConfig({
        providers: [{ id: "github-copilot", type: "github", models: ["claude-opus-5"] }],
        defaultModel: "github-copilot:claude-opus-5",
    });

    assert.deepEqual(seed.instances, []);
    assert.equal(seed.defaults, null);
});

// ── what a caller may send ───────────────────────────────────────────

test("the shapes people actually send are accepted, and stored as a value", () => {
    for (const input of [{ apiKey: "sk-mine" }, { value: "sk-mine" }, "sk-mine",
        { kind: "apiKey", value: "sk-mine" }, { token: "sk-mine" }]) {
        assert.deepEqual(normalizeCallerSecret(input), { kind: "apiKey", value: "sk-mine" });
    }
    assert.deepEqual(normalizeCallerSecret({ githubToken: "gho_mine" }),
        { kind: "githubToken", value: "gho_mine" });
});

test("a credential may not be a pointer into the worker's environment", () => {
    assert.throws(() => normalizeCallerSecret({ apiKey: "env:AZURE_OAI_KEY" }),
        (err) => err.code === "PROVIDER_INVALID" && /not a reference/.test(err.message));
    assert.throws(() => normalizeCallerSecret({ apiKey: "env:DATABASE_URL" }),
        (err) => err.code === "PROVIDER_INVALID");
});

test("the config file's own pointer field is never read from a request", () => {
    // `ref` is how the deployment stores env:VAR. A request that supplies it
    // has supplied no credential at all, and is told so.
    assert.throws(() => normalizeCallerSecret({ kind: "apiKey", ref: "env:AZURE_OAI_KEY" }),
        (err) => err.code === "PROVIDER_INVALID" && /needs a credential/.test(err.message));
});

test("a forged config origin is stripped, not honoured", () => {
    const stored = normalizeCallerSecret({
        kind: "apiKey", value: "sk-mine", source: CONFIG_ORIGIN, ref: "env:AZURE_OAI_KEY",
    });
    assert.deepEqual(stored, { kind: "apiKey", value: "sk-mine" });
    assert.equal(stored.source, undefined, "a caller cannot claim the config file's origin");
    assert.equal(stored.ref, undefined, "a caller cannot smuggle a pointer past the value");
});

test("a provider with no credential is refused, because it could never run", () => {
    for (const empty of [null, undefined, {}, "", { apiKey: "" }]) {
        assert.throws(() => normalizeCallerSecret(empty),
            (err) => err.code === "PROVIDER_INVALID" && /needs a credential/.test(err.message));
    }
});

test("an api version rides along, since some backends need one", () => {
    assert.deepEqual(normalizeCallerSecret({ apiKey: "sk", apiVersion: "2024-10-21" }),
        { kind: "apiKey", value: "sk", apiVersion: "2024-10-21" });
});

// ── what the runtime does with what was stored ───────────────────────

test("a provider runs on its OWN credential", () => {
    const reg = buildRuntimeRegistry(TYPES, [
        personal("bob-azure", "azure-openai", { kind: "apiKey", value: "BOB-OWN-KEY" }),
    ]);
    assert.equal(reg.resolve("bob-azure:gpt-5.4").sdkProvider.apiKey, "BOB-OWN-KEY");
});

test("a provider whose credential does not resolve is DROPPED, never given the cluster's", () => {
    // This is the uncappable bypass: a personal provider spending the
    // cluster's key, under a name only its owner can govern.
    const reg = buildRuntimeRegistry(TYPES, [
        personal("bob-azure", "azure-openai", { kind: "apiKey" }),
        personal("bob-ghcp", "github-copilot", { nonsense: true }),
    ]);
    assert.equal(reg.resolve("bob-azure:gpt-5.4"), undefined);
    assert.equal(reg.resolve("bob-ghcp:claude-opus-5"), undefined);
    for (const model of reg.allModels) {
        assert.ok(!model.qualifiedName.startsWith("bob-"),
            `${model.qualifiedName} is offered by a provider that has no credential of its own`);
    }
});

test("a stored env pointer is inert unless the config file wrote it", () => {
    process.env.PB_TEST_SECRET = "SECRET-FROM-THE-WORKER";
    try {
        const forged = buildRuntimeRegistry(TYPES, [
            personal("sneaky", "azure-openai", { kind: "apiKey", ref: "env:PB_TEST_SECRET" }),
        ]);
        assert.equal(forged.resolve("sneaky:gpt-5.4"), undefined,
            "a pointer with no trusted origin must resolve to nothing");

        const seeded = buildRuntimeRegistry(TYPES, [{
            name: "azure-prod", typeId: "azure-openai", class: "shared", ownerUserId: null,
            baseUrl: null, secretRef: { kind: "apiKey", ref: "env:PB_TEST_SECRET", source: CONFIG_ORIGIN },
        }]);
        assert.equal(seeded.resolve("azure-prod:gpt-5.4").sdkProvider.apiKey, "SECRET-FROM-THE-WORKER",
            "the deployment's own pointer still resolves");
    } finally {
        delete process.env.PB_TEST_SECRET;
    }
});

test("a provider whose type left the config file is dropped rather than guessed at", () => {
    const reg = buildRuntimeRegistry(TYPES, [
        personal("orphan", "a-type-that-was-removed", { kind: "apiKey", value: "sk" }),
    ]);
    assert.equal(reg.allModels.length, 0);
});

test("an API provider with a key but no endpoint is dropped", () => {
    const types = new ModelProviderRegistry({
        providers: [{ id: "broken-openai", type: "openai", models: [{ name: "gpt" }] }],
    }, { keepUncredentialed: true });
    const reg = buildRuntimeRegistry(types, [{
        name: "broken", typeId: "broken-openai", class: "shared", ownerUserId: null,
        baseUrl: null, secretRef: { kind: "apiKey", value: "secret" },
    }]);
    assert.equal(reg.allModels.length, 0);
});

test("the provider's NAME is what a model reference resolves through", () => {
    const reg = buildRuntimeRegistry(TYPES, [
        personal("carol-ghcp", "github-copilot", { kind: "githubToken", value: "gho_carol" }),
    ]);
    assert.equal(reg.resolve("carol-ghcp:claude-opus-5").githubToken, "gho_carol");
    assert.equal(reg.resolve("github-copilot:claude-opus-5"), undefined,
        "the TYPE is not a provider — only instances are");
});

test("the first shared runtime provider supplies the fallback default", () => {
    const reg = buildRuntimeRegistry(TYPES, [
        personal("bob-ghcp", "github-copilot", { kind: "githubToken", value: "gho_bob" }),
        {
            name: "team-azure", typeId: "azure-openai", class: "shared", ownerUserId: null,
            baseUrl: null, secretRef: { kind: "apiKey", value: "TEAM-KEY" },
        },
    ]);
    assert.equal(reg.defaultModel, "team-azure:gpt-5.4");
});

test("a personal provider never becomes the implicit cluster default", () => {
    const reg = buildRuntimeRegistry(TYPES, [
        personal("bob-ghcp", "github-copilot", { kind: "githubToken", value: "gho_bob" }),
    ]);
    assert.equal(reg.defaultModel, undefined);
    assert.ok(reg.resolve("bob-ghcp:claude-opus-5"), "personal provider remains exactly addressable");
});

test("runtime selection resolves a unique bare alias and stamps the provider name", () => {
    const selected = resolveRuntimeModelSelection(TYPES, [
        personal("bob-ghcp", "github-copilot", { kind: "githubToken", value: "gho_bob" }),
    ], {
        requestedModel: "claude-opus-5",
        eligible: () => true,
    });
    assert.equal(selected.model, "bob-ghcp:claude-opus-5");
    assert.equal(selected.source, "explicit");
});

test("runtime selection rejects an ambiguous bare alias", () => {
    assert.throws(
        () => resolveRuntimeModelSelection(TYPES, [
            personal("bob-ghcp", "github-copilot", { kind: "githubToken", value: "gho_bob" }),
            personal("carol-ghcp", "github-copilot", { kind: "githubToken", value: "gho_carol" }),
        ], {
            requestedModel: "claude-opus-5",
            eligible: () => true,
        }),
        (error) => error instanceof ModelAmbiguousError
            && error.code === "MODEL_AMBIGUOUS"
            && JSON.stringify(error.candidates) === JSON.stringify([
                "bob-ghcp:claude-opus-5",
                "carol-ghcp:claude-opus-5",
            ]),
    );
});

test("in-agent model summaries hide foreign personal providers", async () => {
    const registry = buildRuntimeRegistry(TYPES, [
        {
            name: "team-azure", typeId: "azure-openai", class: "shared", ownerUserId: null,
            baseUrl: null, secretRef: { kind: "apiKey", value: "TEAM-KEY" },
        },
        personal("alice-ghcp", "github-copilot", { kind: "githubToken", value: "alice-key" }),
        personal("bob-ghcp", "github-copilot", { kind: "githubToken", value: "bob-key" }),
    ], "team-azure:gpt-5.4");
    const manager = new SessionManager(undefined, null, { modelProviders: registry });
    manager.setSessionCatalog({
        getSession: async (sessionId) => sessionId === "system"
            ? { sessionId, isSystem: true, owner: null }
            : { sessionId, isSystem: false, owner: { provider: "test", subject: "alice" } },
        providers: {
            lookupUserId: async () => 11,
            listProviders: async () => [
                { name: "team-azure", usableByMe: true },
                { name: "alice-ghcp", usableByMe: true },
            ],
            allCredentials: async () => [
                { name: "team-azure", class: "shared", systemUseEnabled: false },
                { name: "alice-ghcp", class: "personal", systemUseEnabled: true },
                { name: "bob-ghcp", class: "personal", systemUseEnabled: false },
            ],
        },
    });

    const userSummary = await manager.getModelSummary("user");
    assert.match(userSummary, /team-azure:gpt-5\.4/);
    assert.match(userSummary, /alice-ghcp:claude-opus-5/);
    assert.doesNotMatch(userSummary, /bob-ghcp/);
    await assert.rejects(
        () => manager.normalizeModelRefForSession("user", "bob-ghcp:claude-opus-5", { requireQualified: true }),
        /Unknown model/,
    );
    await assert.rejects(
        () => manager.normalizeModelRefForSession("user", "missing:claude-opus-5", { requireQualified: true }),
        /Unknown model/,
    );

    const systemSummary = await manager.getModelSummary("system");
    assert.match(systemSummary, /team-azure:gpt-5\.4/);
    assert.match(systemSummary, /alice-ghcp:claude-opus-5/);
    assert.doesNotMatch(systemSummary, /bob-ghcp/);
});

test("runtime selection uses defaults in caller-supplied precedence order", () => {
    const selected = resolveRuntimeModelSelection(TYPES, [
        personal("bob-ghcp", "github-copilot", { kind: "githubToken", value: "gho_bob" }),
        {
            name: "team-azure", typeId: "azure-openai", class: "shared", ownerUserId: null,
            baseUrl: null, secretRef: { kind: "apiKey", value: "TEAM-KEY" },
        },
    ], {
        defaults: [
            { tuple: { provider: "bob-ghcp", model: "bob-ghcp:claude-opus-5", reasoning: null, context: null }, source: "user_default" },
            { tuple: { provider: "team-azure", model: "team-azure:gpt-5.4", reasoning: null, context: null }, source: "cluster_default" },
        ],
        eligible: () => true,
    });
    assert.equal(selected.model, "bob-ghcp:claude-opus-5");
    assert.equal(selected.source, "user_default");
});

test("runtime selection never falls through an invalid configured default", () => {
    assert.throws(() => resolveRuntimeModelSelection(TYPES, [{
        name: "team-azure", typeId: "azure-openai", class: "shared", ownerUserId: null,
        baseUrl: null, secretRef: { kind: "apiKey", value: "TEAM-KEY" },
    }], {
        defaults: [
            { tuple: { provider: "gone", model: "gone:gpt-5.4", reasoning: null, context: null }, source: "cluster_default" },
        ],
        eligible: () => true,
    }), /No usable provider/);
});

test("system fallback includes only shared or explicitly enabled personal providers", () => {
    const personalOnly = personal("bob-ghcp", "github-copilot", { kind: "githubToken", value: "gho_bob" });
    personalOnly.systemUseEnabled = false;
    assert.throws(() => resolveRuntimeModelSelection(TYPES, [personalOnly], {
        eligible: (provider) => provider.class === "shared" || provider.systemUseEnabled === true,
    }), /No usable model provider/);
    personalOnly.systemUseEnabled = true;
    const selected = resolveRuntimeModelSelection(TYPES, [personalOnly], {
        eligible: (provider) => provider.class === "shared" || provider.systemUseEnabled === true,
    });
    assert.equal(selected.model, "bob-ghcp:claude-opus-5");
});
