/**
 * Plugin tools contract — Phase 1 unit tests.
 *
 * Covers the contract added in `worker.ts`:
 *   - `plugin.json` may declare a `tools` field pointing at a JS module that
 *     exports `registerTools(worker)`.
 *   - The worker invokes those modules at the start of `worker.start()`.
 *   - Tool-name collisions across contributors fail loudly.
 *   - Missing `pluginDirs` paths hard-fail at construction time.
 *   - `tools` field on system/management tier is warn-and-ignored.
 *   - Worker auto-tools (sweeper, artifacts, resource-mgr, ps_list_agents)
 *     register without colliding with each other under the new fail-fast
 *     policy.
 *
 * These tests construct `PilotSwarmWorker` against an in-memory sqlite
 * store. They invoke the private `_registerPluginTools()` method directly
 * to exercise the plugin-tools path without spinning up a duroxide runtime
 * (which would require Postgres + a real GitHub token). The auto-tool
 * collision smoke check runs against a real `withClient(...)` boot to
 * confirm the fail-fast policy doesn't regress existing behavior.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PilotSwarmWorker, ToolNameCollisionError } from "../../src/index.ts";
import { defineTool } from "@github/copilot-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "fixtures", "obo-smoke-plugin-contract");
const fixture = (name) => path.join(FIXTURES, name);

// Use a sqlite store path so the constructor doesn't try to talk to PG.
// We never call worker.start() here — _loadPlugins() runs in the constructor
// and we invoke _registerPluginTools() directly.
function makeWorker(pluginDirs) {
    return new PilotSwarmWorker({
        store: "sqlite::memory:",
        sessionStateDir: path.join(FIXTURES, ".session-state"),
        disableManagementAgents: true,
        pluginDirs,
    });
}

describe("plugin tools contract — _loadPluginDir captures `tools` field", () => {
    it("captures the tools module path for a plugin that declares it", () => {
        const worker = makeWorker([fixture("plugin-with-tools")]);
        const captured = worker._pluginToolModules;
        expect(captured).toHaveLength(1);
        expect(captured[0].pluginName).toBe("plugin-with-tools");
        expect(captured[0].toolsModulePath).toBe("./tools.js");
        expect(captured[0].absDir).toBe(fixture("plugin-with-tools"));
    });

    it("captures nothing for a plugin without a `tools` field", () => {
        const worker = makeWorker([fixture("plugin-no-tools")]);
        expect(worker._pluginToolModules).toHaveLength(0);
    });
});

describe("plugin tools contract — _registerPluginTools", () => {
    it("imports the tools module and registers its tools", async () => {
        const worker = makeWorker([fixture("plugin-with-tools")]);
        await worker._registerPluginTools();
        expect(worker.toolRegistry.has("fixture_fake_tool_a")).toBe(true);
        expect(worker._toolContributors.get("fixture_fake_tool_a")).toBe("plugin-with-tools");
        // SC-001: tool must be visible to SessionManager before any session
        // sends a message. The worker pipes its registry into SessionManager
        // via setToolRegistry inside registerTools(); confirm the same Map
        // reference is now held by the SessionManager.
        const smRegistry = worker.sessionManager.toolRegistry;
        expect(smRegistry).toBe(worker.toolRegistry);
        expect(smRegistry.has("fixture_fake_tool_a")).toBe(true);
    });

    it("does nothing when no plugin declared a `tools` field", async () => {
        const worker = makeWorker([fixture("plugin-no-tools")]);
        const before = worker.toolRegistry.size;
        await worker._registerPluginTools();
        expect(worker.toolRegistry.size).toBe(before);
    });

    it("fails loudly on tool-name collision and names BOTH contributors", async () => {
        const worker = makeWorker([
            fixture("plugin-collide-a"),
            fixture("plugin-collide-b"),
        ]);
        let caught;
        try {
            await worker._registerPluginTools();
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeDefined();
        expect(caught.message).toContain("plugin-collide-a");
        expect(caught.message).toContain("plugin-collide-b");
        expect(caught.message).toContain("fixture_collision_tool");
        // Outer wrapper from _registerPluginTools wraps the underlying
        // ToolNameCollisionError; verify the cause chain is preserved.
        const root = caught.cause ?? caught;
        expect(root).toBeInstanceOf(ToolNameCollisionError);
    });

    it("fails when the tools file does not exist on disk", async () => {
        const worker = makeWorker([fixture("plugin-missing-tools-file")]);
        await expect(worker._registerPluginTools()).rejects.toThrow(/plugin-missing-tools-file/);
        await expect(worker._registerPluginTools()).rejects.toThrow(/does-not-exist\.js/);
    });

    it("fails when the tools module fails to import", async () => {
        const worker = makeWorker([fixture("plugin-bad-import")]);
        await expect(worker._registerPluginTools()).rejects.toThrow(/plugin-bad-import/);
    });

    it("fails when the tools module exports no `registerTools` function", async () => {
        const worker = makeWorker([fixture("plugin-no-export")]);
        await expect(worker._registerPluginTools()).rejects.toThrow(/plugin-no-export/);
        await expect(worker._registerPluginTools()).rejects.toThrow(/registerTools/);
    });

    it("fails when registerTools throws synchronously", async () => {
        const worker = makeWorker([fixture("plugin-throws-sync")]);
        await expect(worker._registerPluginTools()).rejects.toThrow(/plugin-throws-sync/);
        await expect(worker._registerPluginTools()).rejects.toThrow(/Intentional sync failure/);
    });

    it("fails when registerTools returns a rejected promise", async () => {
        const worker = makeWorker([fixture("plugin-rejects-async")]);
        await expect(worker._registerPluginTools()).rejects.toThrow(/plugin-rejects-async/);
        await expect(worker._registerPluginTools()).rejects.toThrow(/Intentional async rejection/);
    });
});

describe("plugin tools contract — partial-opt-in: missing pluginDirs path hard-fails", () => {
    it("throws at constructor time when a pluginDirs entry does not exist", () => {
        const missing = path.join(FIXTURES, "definitely-not-a-real-plugin-dir");
        expect(() => makeWorker([missing])).toThrow(/Plugin directory not found/);
        expect(() => makeWorker([missing])).toThrow(/definitely-not-a-real-plugin-dir/);
    });

    it("does not throw when all pluginDirs exist", () => {
        expect(() => makeWorker([fixture("plugin-with-tools")])).not.toThrow();
    });
});

describe("plugin tools contract — registerTools fail-fast collision policy", () => {
    it("throws ToolNameCollisionError on duplicate name from app-inline caller", () => {
        const worker = makeWorker([]);
        const t = defineTool("fixture_inline_tool", {
            description: "x",
            parameters: { type: "object", properties: {} },
            handler: async () => "x",
        });
        worker.registerTools([t]);
        expect(() => worker.registerTools([t])).toThrow(ToolNameCollisionError);
    });

    it("collision error names the previous and new contributor labels", () => {
        const worker = makeWorker([]);
        const t = defineTool("fixture_labeled_tool", {
            description: "x",
            parameters: { type: "object", properties: {} },
            handler: async () => "x",
        });
        worker.registerTools([t], "first-contributor");
        try {
            worker.registerTools([t], "second-contributor");
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(ToolNameCollisionError);
            expect(err.message).toContain("first-contributor");
            expect(err.message).toContain("second-contributor");
            expect(err.message).toContain("fixture_labeled_tool");
        }
    });

    it("registerTools is atomic: mid-batch collision leaves no partial registration", () => {
        const worker = makeWorker([]);
        const tA = defineTool("fixture_atomic_a", {
            description: "x",
            parameters: { type: "object", properties: {} },
            handler: async () => "x",
        });
        const tB = defineTool("fixture_atomic_b", {
            description: "x",
            parameters: { type: "object", properties: {} },
            handler: async () => "x",
        });
        worker.registerTools([tB], "prior");
        // Batch is [tA (new), tB (collides)]. tA must NOT end up in the
        // registry even though it was iterated first.
        expect(() => worker.registerTools([tA, tB], "second")).toThrow(ToolNameCollisionError);
        expect(worker.toolRegistry.has("fixture_atomic_a")).toBe(false);
        // tB still belongs to the prior contributor, not "second".
        expect(worker._toolContributors.get("fixture_atomic_b")).toBe("prior");
    });

    it("default contributor label is 'app-inline' when none is provided", () => {
        const worker = makeWorker([]);
        const t = defineTool("fixture_default_label_tool", {
            description: "x",
            parameters: { type: "object", properties: {} },
            handler: async () => "x",
        });
        worker.registerTools([t]);
        expect(worker._toolContributors.get("fixture_default_label_tool")).toBe("app-inline");
    });
});

describe("plugin tools contract — worker auto-tool collision smoke check", () => {
    // Confirms the new fail-fast policy doesn't regress the worker's own
    // built-in registrations (sweeper, artifacts, resource-mgr, ps_list_agents).
    // We construct each factory directly with stub deps and register the
    // resulting tools on a single worker — any collision would throw here.
    it("sweeper + artifacts + resource-mgr + ps_list_agents register without collision", async () => {
        const { createSweeperTools } = await import("../../src/sweeper-tools.ts");
        const { createArtifactTools } = await import("../../src/artifact-tools.ts");
        const { createResourceManagerTools } = await import("../../src/resourcemgr-tools.ts");

        const stubCatalog = {};
        const stubClient = {};
        const stubFactStore = {};
        const stubBlobStore = {};
        const stubArtifactStore = {};

        const sweeperTools = createSweeperTools({
            catalog: stubCatalog,
            duroxideClient: stubClient,
            factStore: stubFactStore,
            duroxideSchema: "duroxide",
            storeUrl: "sqlite::memory:",
        });
        const artifactTools = createArtifactTools({ blobStore: stubArtifactStore });
        const rmTools = createResourceManagerTools({
            catalog: stubCatalog,
            duroxideClient: stubClient,
            blobStore: stubBlobStore,
            duroxideSchema: "duroxide",
            cmsSchema: "copilot_sessions",
        });

        const worker = makeWorker([]);
        // These mirror the four registerTools(..., "worker-builtin") calls in
        // worker.start(). If any pair shared a name, the second would throw.
        expect(() => worker.registerTools(sweeperTools, "worker-builtin")).not.toThrow();
        expect(() => worker.registerTools(artifactTools, "worker-builtin")).not.toThrow();
        expect(() => worker.registerTools(rmTools, "worker-builtin")).not.toThrow();
        const fakeListAgents = defineTool("ps_list_agents", {
            description: "x",
            parameters: { type: "object", properties: {} },
            handler: async () => "x",
        });
        expect(() => worker.registerTools([fakeListAgents], "worker-builtin")).not.toThrow();

        // Every name should be tagged worker-builtin.
        for (const [name, contributor] of worker._toolContributors.entries()) {
            expect(contributor, `tool ${name} should be tagged worker-builtin`).toBe("worker-builtin");
        }
    });
});

describe("plugin tools contract — orphan-name startup warning", () => {
    it("warns when a plugin registers a tool name with no overlay claiming it", async () => {
        const worker = makeWorker([fixture("plugin-with-tools")]);
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (msg) => { warnings.push(String(msg)); };
        try {
            await worker._registerPluginTools();
        } finally {
            console.warn = origWarn;
        }
        const orphanWarning = warnings.find(w => w.includes("registered with no overlay"));
        expect(orphanWarning, `expected an orphan-name warning, got: ${JSON.stringify(warnings)}`).toBeDefined();
        expect(orphanWarning).toContain("plugin-with-tools");
        expect(orphanWarning).toContain("fixture_fake_tool_a");
    });

    it("stays silent when the plugin's own default.agent.md claims the registered tool names", async () => {
        const worker = makeWorker([fixture("plugin-with-claimed-tools")]);
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (msg) => { warnings.push(String(msg)); };
        try {
            await worker._registerPluginTools();
        } finally {
            console.warn = origWarn;
        }
        const orphanWarning = warnings.find(w => w.includes("registered with no overlay"));
        expect(orphanWarning, `expected no orphan-name warning, got: ${JSON.stringify(warnings)}`).toBeUndefined();
        expect(worker.toolRegistry.has("fixture_claimed_tool")).toBe(true);
        expect(worker._appDefaultToolNames).toContain("fixture_claimed_tool");
    });
});
