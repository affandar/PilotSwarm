import test from "node:test";
import assert from "node:assert/strict";
import { projectWorker } from "../../../sdk/api/src/admin-diagnostics.js";
import { FEATURE_FLAGS } from "../../../sdk/dist/feature-flags.js";
import { PortalRuntime } from "../runtime.js";

const KEY = "copilot.native_tasks";
const CANARY = "PRIVATE-FEATURE-DIAGNOSTIC-CANARY";
const AT = "2026-09-09T16:21:04.000Z";
const featureState = () => ({
    protocolVersion: 1, initialized: true,
    supportedKeys: [KEY], appliedRevisions: { [KEY]: "4" },
    lastCheckedAt: AT, lastLoadedAt: AT,
    nativeCapability: "sync", lastError: null,
});
const worker = (state = featureState()) => ({
    workerNodeId: "worker-1", pool: "default", phase: "ready", updatedAt: AT,
    owner: { subject: CANARY }, info: { sdkVersion: "0.5.63", manifest: CANARY },
    health: { rssBytes: 100, private: CANARY },
    state: { "feature-flags": state, "private-domain": { secret: CANARY },
        "agent-packages": { installed: { [CANARY]: { status: "error", error: CANARY } } } },
});
function runtimeFor(rows, adminScope = "cluster") {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.authz = { ...runtime.authz, enforce: true, adminScope };
    runtime.start = async () => {};
    runtime.transport = { listWorkers: async () => rows };
    return runtime;
}
const actor = role => ({ principal: { provider: "entra", subject: "operator" }, authorization: { role } });

test("restricted listWorkers keeps safe feature delivery state without exposing private diagnostics", async () => {
    const source = worker({ ...featureState(), lastError: CANARY, unknown: CANARY });
    const result = await runtimeFor([source]).call("listWorkers", {}, actor("admin"));
    assert.deepEqual(result[0].state["feature-flags"], {
        protocolVersion: 1, initialized: true, supportedKeys: [KEY], appliedRevisions: { [KEY]: "4" },
        lastCheckedAt: AT, lastLoadedAt: AT, nativeCapability: "sync", hasRefreshError: true,
    });
    assert.equal(result[0].contentRedacted, true);
    assert.equal(result[0].state["agent-packages"].installedCount, 1);
    assert.ok(!JSON.stringify(result).includes(CANARY));
    assert.equal(source.state["feature-flags"].lastError, CANARY, "projection must not mutate the trusted row");
    assert.equal(result[0].state["feature-flags"].appliedRevisions[KEY], "4", "revision is sufficient to report adoption, not a false 0/1");
});

test("worker diagnostics remain admin-only and unrestricted admins retain the original detail", async () => {
    const rows = [worker({ ...featureState(), lastError: CANARY })];
    for (const adminScope of ["cluster", "unrestricted"]) {
        await assert.rejects(runtimeFor(rows, adminScope).call("listWorkers", {}, actor("user")), /admin role/i);
    }
    assert.equal(await runtimeFor(rows, "unrestricted").call("listWorkers", {}, actor("admin")), rows);
});

test("missing and malformed feature diagnostics stay unknown instead of becoming false states", () => {
    for (const value of [undefined, null, false, "off", [], 1]) {
        const source = worker();
        source.state["feature-flags"] = value;
        assert.equal(Object.hasOwn(projectWorker(source).state, "feature-flags"), false);
    }
    const projected = projectWorker(worker({
        protocolVersion: "1", initialized: "false", supportedKeys: "copilot.native_tasks",
        appliedRevisions: [], nativeCapability: "disabled", lastCheckedAt: CANARY,
        lastLoadedAt: "2026-02-30T16:21:04.000Z", lastError: { secret: CANARY }, secret: CANARY,
    })).state["feature-flags"];
    assert.deepEqual(projected, {});
    assert.deepEqual(projectWorker(worker({ protocolVersion: 1, initialized: false,
        supportedKeys: [], appliedRevisions: {}, nativeCapability: "off", lastCheckedAt: null,
        lastLoadedAt: null, lastError: null })).state["feature-flags"], {
        protocolVersion: 1, initialized: false, supportedKeys: [], appliedRevisions: {},
        nativeCapability: "off", lastCheckedAt: null, lastLoadedAt: null, hasRefreshError: false,
    });
});

test("feature telemetry accepts only code-defined keys and lossless positive bigint revisions", () => {
    const keys = Object.keys(FEATURE_FLAGS);
    const projected = projectWorker(worker({ ...featureState(),
        supportedKeys: [...keys, CANARY, "private.feature", KEY],
        appliedRevisions: Object.fromEntries([...keys.map(key => [key, "9223372036854775807"]),
            [CANARY, "1"], ["private.feature", "2"]]),
    })).state["feature-flags"];
    assert.deepEqual(projected.supportedKeys, keys, "update the public telemetry allowlist when adding code-defined flags");
    assert.deepEqual(projected.appliedRevisions, Object.fromEntries(keys.map(key => [key, "9223372036854775807"])));
    assert.ok(!JSON.stringify(projected).includes(CANARY));
    for (const value of [undefined, null, 4, 0, "0", "-1", "1.5", "04", "1e3", "9223372036854775808", "9".repeat(10_000), {}, []]) {
        assert.deepEqual(projectWorker(worker({ appliedRevisions: { [KEY]: value } })).state["feature-flags"], { appliedRevisions: {} });
    }
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.deepEqual(projectWorker(worker({ protocolVersion: value })).state["feature-flags"], {});
    }
});

test("restricted listWorkers keeps malformed support reports unknown rather than confirmed unsupported", async () => {
    for (const supportedKeys of [[7, null], [KEY, null], [false], [{}], [[KEY]]]) {
        const result = await runtimeFor([worker({ ...featureState(), supportedKeys })]).call("listWorkers", {}, actor("admin"));
        assert.equal(Object.hasOwn(result[0].state["feature-flags"], "supportedKeys"), false);
        assert.equal(result[0].state["feature-flags"].appliedRevisions[KEY], "4");
    }
    for (const supportedKeys of [[], ["private.feature"]]) {
        const result = await runtimeFor([worker({ ...featureState(), supportedKeys })]).call("listWorkers", {}, actor("admin"));
        assert.deepEqual(result[0].state["feature-flags"].supportedKeys, [], "a valid string array can confirm no supported public flags");
    }
});

test("feature diagnostic projection is idempotent and retains only boolean refresh-error status", () => {
    for (const lastError of [null, "", CANARY]) {
        const once = projectWorker(worker({ ...featureState(), lastError }));
        assert.equal(once.state["feature-flags"].hasRefreshError, Boolean(lastError));
        assert.deepEqual(projectWorker(once).state["feature-flags"], once.state["feature-flags"]);
    }
});
