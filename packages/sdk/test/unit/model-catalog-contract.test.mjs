import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
    createManagementOps,
    normalizeRuntimeModels,
    WebPilotSwarmManagementClient,
} from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));

test("the public runtime model wire type has a stable normalized shape", () => {
    assert.deepEqual(normalizeRuntimeModels([{
        catalogKind: "runtime_provider",
        qualifiedName: " sample-provider:sample-model ",
        providerId: " sample-provider ",
        providerType: " sample-type ",
        modelName: " sample-model ",
        cost: 3,
        credentialAvailable: true,
        supportedReasoningEfforts: ["low", "", 42, "high"],
        defaultReasoningEffort: " low ",
        supportedContextTiers: ["standard"],
        contextWindowSizes: {
            standard: 128_000,
            invalid: "unknown",
        },
        ignoredFutureField: { enabled: true },
    }]), [{
        catalogKind: "runtime_provider",
        qualifiedName: "sample-provider:sample-model",
        providerId: "sample-provider",
        providerType: "sample-type",
        modelName: "sample-model",
        cost: "3",
        credentialAvailable: true,
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
        supportedContextTiers: ["standard"],
        contextWindowSizes: { standard: 128_000 },
        ignoredFutureField: { enabled: true },
    }]);
});

test("normalization preserves opaque capability values without provider policy", () => {
    assert.deepEqual(normalizeRuntimeModels([{
        qualifiedName: "provider:model",
        modelName: "model",
        providerId: "provider",
        providerType: "provider-type",
        cost: false,
        supportedReasoningEfforts: ["vendor-effort"],
        defaultReasoningEffort: "vendor-effort",
        supportedContextTiers: ["vendor-context"],
        defaultContextTier: "vendor-context",
        contextWindowSizes: { "vendor-context": 64_000 },
    }]), [{
        qualifiedName: "provider:model",
        modelName: "model",
        providerId: "provider",
        providerType: "provider-type",
        supportedReasoningEfforts: ["vendor-effort"],
        defaultReasoningEffort: "vendor-effort",
        supportedContextTiers: ["vendor-context"],
        defaultContextTier: "vendor-context",
        contextWindowSizes: { "vendor-context": 64_000 },
    }]);
});

test("runtime model normalization rejects unusable catalog payloads", () => {
    assert.throws(
        () => normalizeRuntimeModels({ models: [] }),
        /invalid runtime model catalog/,
    );
    assert.throws(
        () => normalizeRuntimeModels([{ providerId: "sample-provider" }]),
        /must have qualifiedName, modelName, providerType/,
    );
    assert.throws(
        () => normalizeRuntimeModels([null]),
        /entry 0 must be an object/,
    );
});

test("management ops and web catalog methods validate results before exposing them", async () => {
    const client = Object.create(WebPilotSwarmManagementClient.prototype);
    const calls = [];
    const ops = createManagementOps(async (name) => {
        calls.push(name);
        return [{
            qualifiedName: "sample-provider:sample-model",
            modelName: "sample-model",
            providerId: "sample-provider",
            providerType: "sample-type",
            supportedReasoningEfforts: ["medium"],
        }];
    });
    Object.defineProperty(client, "ops", {
        value: ops,
    });

    const expected = [{
        qualifiedName: "sample-provider:sample-model",
        modelName: "sample-model",
        providerId: "sample-provider",
        providerType: "sample-type",
        supportedReasoningEfforts: ["medium"],
        supportedContextTiers: [],
    }];
    assert.deepEqual(await ops.listModels(), expected);
    assert.deepEqual(await client.listModels(), expected);
    assert.deepEqual(await client.listRuntimeModels(), expected);
    assert.deepEqual(calls, ["listModels", "listModels", "listModels"]);
});

test("the package root exposes the catalog types used by web callers", () => {
    execFileSync(process.execPath, [
        resolve(here, "../../../../node_modules/typescript/bin/tsc"),
        "--noEmit",
        "-p",
        resolve(here, "../type/model-catalog/tsconfig.json"),
    ], { stdio: "pipe" });
});
