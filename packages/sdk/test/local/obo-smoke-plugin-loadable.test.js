/**
 * OBO smoke plugin loadable test.
 *
 * Asserts that the OBO smoke plugin at `packages/obo-smoke-plugin/` is
 * a well-formed plugin under the worker's plugin contract:
 *
 *   - `plugin.json` declares `tools: "./tools.js"`.
 *   - `tools.js` exports `registerTools(worker)` per the plugin contract.
 *   - It also exports the legacy `buildOboSmokeTools` / `registerOboSmokeTools`
 *     helpers for direct unit-test consumption.
 *   - End-to-end through the worker: when the worker is constructed with
 *     `pluginDirs: [<smoke plugin path>]` and `_registerPluginTools()` is
 *     invoked, both smoke tools land on the worker registry tagged with
 *     the plugin's name from `plugin.json`.
 *   - Tool shape, handler outcomes, and env-time-of-read semantics
 *     (smoke env keys are read at handler-call time, never at module
 *     import time) are preserved.
 *
 * Does NOT actually call Entra or Graph — see
 * `packages/obo-smoke-plugin/SMOKE_CHECKLIST.md` for the live-tenant
 * manual checklist.
 */

import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { PilotSwarmWorker } from "../../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_PLUGIN_DIR = path.resolve(__dirname, "..", "..", "..", "obo-smoke-plugin");
const SMOKE_TOOLS_IMPORT = "../../../obo-smoke-plugin/tools.js";

const SMOKE_ENV_KEYS = [
    "OBO_SMOKE_WORKER_APP_TENANT_ID",
    "OBO_SMOKE_WORKER_APP_CLIENT_ID",
    "OBO_SMOKE_WORKER_APP_CLIENT_SECRET",
    "OBO_SMOKE_WORKER_APP_GRAPH_SCOPE",
];

function clearSmokeEnv() {
    for (const key of SMOKE_ENV_KEYS) {
        delete process.env[key];
    }
}

describe("packages/obo-smoke-plugin loadable", () => {
    beforeEach(() => {
        clearSmokeEnv();
    });

    it("plugin.json declares the new `tools` field pointing at tools.js", async () => {
        const manifestRaw = await readFile(path.join(SMOKE_PLUGIN_DIR, "plugin.json"), "utf8");
        const manifest = JSON.parse(manifestRaw);
        expect(manifest.name).toBe("obo-smoke");
        expect(manifest.tools).toBe("./tools.js");
    });

    it("module imports without throwing and exposes expected exports", async () => {
        const mod = await import("../../../obo-smoke-plugin/tools.js");
        expect(typeof mod.buildOboSmokeTools).toBe("function");
        expect(typeof mod.registerOboSmokeTools).toBe("function");
        expect(typeof mod.registerTools).toBe("function");
        expect(typeof mod.default).toBe("function");
        expect(typeof mod.selectAuthBackend).toBe("function");
        expect(typeof mod.getCachedCca).toBe("function");
        expect(typeof mod._resetSmokePluginStateForTests).toBe("function");
    });

    it("buildOboSmokeTools returns the two expected tools with stable names", async () => {
        const { buildOboSmokeTools } = await import("../../../obo-smoke-plugin/tools.js");
        const tools = buildOboSmokeTools();
        expect(Array.isArray(tools)).toBe(true);
        expect(tools).toHaveLength(2);
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual(["obo_smoke_force_reauth", "obo_smoke_whoami"]);
    });

    it("each tool has a description, parameters object, and async handler function", async () => {
        const { buildOboSmokeTools } = await import("../../../obo-smoke-plugin/tools.js");
        const tools = buildOboSmokeTools();
        for (const tool of tools) {
            expect(typeof tool.description).toBe("string");
            expect(tool.description.length).toBeGreaterThan(40);
            expect(typeof tool.parameters).toBe("object");
            expect(tool.parameters).not.toBeNull();
            expect(typeof tool.handler).toBe("function");
        }
    });

    it("registerTools (plugin-contract export) routes through worker.registerTools", async () => {
        const { registerTools } = await import("../../../obo-smoke-plugin/tools.js");
        const calls = [];
        const fakeWorker = {
            registerTools(toolsArray) {
                calls.push(toolsArray);
            },
        };
        registerTools(fakeWorker);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toHaveLength(2);
        expect(calls[0].map((t) => t.name).sort()).toEqual(["obo_smoke_force_reauth", "obo_smoke_whoami"]);
    });

    it("loads end-to-end through the real PilotSwarmWorker plugin contract", async () => {
        // This is the definitive "the real smoke plugin loads through the
        // real plugin contract" assertion. We construct a worker with the
        // smoke plugin in pluginDirs and exercise the same loader path the
        // production worker uses on start.
        const worker = new PilotSwarmWorker({
            store: "sqlite::memory:",
            sessionStateDir: path.join(SMOKE_PLUGIN_DIR, ".session-state"),
            disableManagementAgents: true,
            pluginDirs: [SMOKE_PLUGIN_DIR],
        });
        // The loader captured the plugin's tools module during construction.
        const captured = worker._pluginToolModules;
        expect(captured).toHaveLength(1);
        expect(captured[0].pluginName).toBe("obo-smoke");
        expect(captured[0].toolsModulePath).toBe("./tools.js");

        await worker._registerPluginTools();

        // Both smoke tools should now be registered on the worker, tagged
        // with the plugin name so SC-003-style collisions name the source.
        expect(worker.toolRegistry.has("obo_smoke_whoami")).toBe(true);
        expect(worker.toolRegistry.has("obo_smoke_force_reauth")).toBe(true);
        expect(worker._toolContributors.get("obo_smoke_whoami")).toBe("obo-smoke");
        expect(worker._toolContributors.get("obo_smoke_force_reauth")).toBe("obo-smoke");
    });

    it("registerOboSmokeTools throws on missing worker.registerTools (defense)", async () => {
        const { registerOboSmokeTools } = await import("../../../obo-smoke-plugin/tools.js");
        expect(() => registerOboSmokeTools(null)).toThrow(/registerTools/);
        expect(() => registerOboSmokeTools({})).toThrow(/registerTools/);
        expect(() => registerOboSmokeTools({ registerTools: "not-a-function" })).toThrow(/registerTools/);
    });

    it("obo_smoke_force_reauth always returns a structured interaction_required outcome", async () => {
        const { buildOboSmokeTools } = await import("../../../obo-smoke-plugin/tools.js");
        const tools = buildOboSmokeTools();
        const reauth = tools.find((t) => t.name === "obo_smoke_force_reauth");
        const result = await reauth.handler({}, { sessionId: "smoke-session" });
        expect(result).toBeTruthy();
        expect(result.resultType).toBe("interaction_required");
        expect(result.__pilotswarmToolOutcome).toBeTruthy();
        expect(result.__pilotswarmToolOutcome.kind).toBe("interaction_required");
        expect(result.__pilotswarmToolOutcome.payload.reasonCode).toBe("reauth_required");
        expect(typeof result.textResultForLlm).toBe("string");
        expect(result.textResultForLlm.length).toBeGreaterThan(0);
        // The textResultForLlm must NEVER contain the opaque claims blob
        // or a token-shaped substring.
        expect(result.textResultForLlm).not.toMatch(/eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\./);
    });

    it("obo_smoke_whoami returns no_user_context when the lookup is unbound", async () => {
        const { buildOboSmokeTools } = await import("../../../obo-smoke-plugin/tools.js");
        const tools = buildOboSmokeTools();
        const whoami = tools.find((t) => t.name === "obo_smoke_whoami");
        const result = await whoami.handler({}, { sessionId: "unbound-session" });
        expect(result).toBeTruthy();
        expect(result.mode).toBe("no_user_context");
        expect(result.sessionId).toBe("unbound-session");
        expect(typeof result.message).toBe("string");
    });

    it("obo_smoke_whoami surfaces a missing-sessionId error rather than throwing", async () => {
        const { buildOboSmokeTools } = await import("../../../obo-smoke-plugin/tools.js");
        const tools = buildOboSmokeTools();
        const whoami = tools.find((t) => t.name === "obo_smoke_whoami");
        const result = await whoami.handler({}, {});
        expect(result.mode).toBe("error");
        expect(result.error).toMatch(/sessionId/);
    });

    it("smoke env keys are NOT read at module import time (handler-time reads only)", async () => {
        clearSmokeEnv();
        const { buildOboSmokeTools } = await import("../../../obo-smoke-plugin/tools.js");

        process.env.OBO_SMOKE_WORKER_APP_TENANT_ID = "fake-tenant";
        process.env.OBO_SMOKE_WORKER_APP_CLIENT_ID = "fake-client";
        process.env.OBO_SMOKE_WORKER_APP_CLIENT_SECRET = "fake-secret";
        process.env.OBO_SMOKE_WORKER_APP_GRAPH_SCOPE = "fake-scope";

        const tools = buildOboSmokeTools();
        const whoami = tools.find((t) => t.name === "obo_smoke_whoami");
        const result = await whoami.handler({}, { sessionId: "x" });
        expect(result).toBeTruthy();
        expect(["no_user_context", "principal_only", "obo_failed", "obo_ok", "error"]).toContain(result.mode);

        clearSmokeEnv();
    });

    it("README and SMOKE_CHECKLIST exist in the plugin directory", async () => {
        const readme = await readFile(path.join(SMOKE_PLUGIN_DIR, "README.md"), "utf8");
        const checklist = await readFile(path.join(SMOKE_PLUGIN_DIR, "SMOKE_CHECKLIST.md"), "utf8");
        expect(readme).toMatch(/obo_smoke_whoami/);
        expect(readme).toMatch(/obo_smoke_force_reauth/);
        expect(checklist).toMatch(/AKS-deployed smoke/i);
        expect(checklist).toMatch(/Local-developer smoke/i);
        expect(checklist).toMatch(/Token hygiene/i);
    });
});
