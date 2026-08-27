/**
 * Provider budgets: the same capabilities on all three surfaces.
 *
 * The contract (docs/proposals/providers-and-budgets-surface.md) makes parity
 * the rule — every capability reaches the HTTP API, the MCP server and the
 * agent tools, and the database, not the surface, decides who may do what.
 * Three surfaces written separately drift quietly: a capability lands on the
 * portal and never reaches an agent, or a grouped tool routes three of its four
 * sub-capabilities and drops the fourth with no error anywhere.
 *
 * Almost nothing here reads source text. Each surface is driven for real: the
 * protocol table's own rows, the management client's prototype, the MCP tool
 * file registering into a recording server, and the agent tools' handlers
 * running against a recording store. That matters because a substring check
 * cannot fail — `src.includes("deleteProvider")` is still true after
 * `deleteProvider` becomes `deleteProviderXX`, and this repo has shipped a
 * broken surface behind exactly that assertion.
 *
 * Two checks do read source, both as whole-identifier regexes and both because
 * the alternative is booting a real MCP server: the one line in server.ts that
 * wires the tool file in, and the tool names in the tool file (which catch a
 * stale build of the app package).
 *
 * The MCP half loads packages/app/mcp/dist. Build it with
 * `npm run build --workspace=pilotswarm`.
 *
 * Run: node --test test/unit/provider-surface-parity.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { OPERATIONS } from "../../api/src/protocol.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { loadAgentFiles } from "../../dist/agent-loader.js";
import {
    PROVIDER_TOOL_NAMES,
    createProviderTools,
    providerToolDefs,
} from "../../dist/provider-tools.js";

const MCP_TOOLS_DIST = new URL("../../../app/mcp/dist/src/tools/providers.js", import.meta.url);
const MCP_TOOLS_SRC = fileURLToPath(new URL("../../../app/mcp/src/tools/providers.ts", import.meta.url));
const MCP_SERVER_SRC = fileURLToPath(new URL("../../../app/mcp/src/server.ts", import.meta.url));
// The Token Manager lives with the other management agents (sweeper,
// resourcemgr, facts-manager), not in the unconditional worker tier: it is
// covered by the same disableManagementAgents opt-out they are, and
// loadSystemAgentConfigs only scans this directory.
const SYSTEM_AGENTS_DIR = fileURLToPath(new URL("../../plugins/mgmt/agents", import.meta.url));

/** The person the agent tools ask as. A number, because the procedures take numbers. */
const VIEWER = { userId: 7, isAdmin: true };

/**
 * The capabilities, numbered as the contract numbers them.
 *
 * `op` is the HTTP operation name, which is also the management-client method
 * name and the method every MCP tool calls — one name for the capability all
 * the way down. `mcp` and `agent` name the tool that carries it plus one legal
 * call; a grouped tool appears once per capability it carries, with the
 * arguments that pick that branch. `calls` is what the call must reach in the
 * data layer, so a branch that silently falls through to its neighbour fails.
 */
const CAPABILITIES = [
    {
        n: 1,
        op: "listProviders",
        http: { method: "GET", path: "/providers", access: "authed" },
        mcp: { tool: "list_providers", args: {} },
        agent: { tool: "list_providers", args: {}, calls: ["listProviders"] },
    },
    {
        n: 2,
        op: "getProviderStatus",
        http: { method: "GET", path: "/providers/status", access: "authed" },
        mcp: { tool: "get_provider_status", args: { names: ["team"] } },
        agent: { tool: "get_provider_status", args: { names: ["team"] }, calls: ["providerStatus"] },
    },
    {
        n: 3,
        op: "createProvider",
        http: { method: "POST", path: "/management/providers", access: "fleet:admin" },
        mcp: { tool: "manage_provider", args: { action: "create", name: "team", mine: false, type: "openai" } },
        agent: {
            tool: "manage_provider",
            args: { action: "create", name: "team", mine: false, type: "openai" },
            calls: ["createProvider"],
            check: ([{ args }]) => {
                assert.equal(args[0].class, "shared", "mine:false must create a shared provider");
                assert.equal(args[0].ownerUserId, null, "a shared provider has no owner");
            },
        },
    },
    {
        n: 4,
        op: "createMyProvider",
        http: { method: "POST", path: "/me/providers", access: "authed" },
        mcp: { tool: "manage_provider", args: { action: "create", name: "mine", mine: true, type: "openai" } },
        agent: {
            tool: "manage_provider",
            args: { action: "create", name: "mine", mine: true, type: "openai" },
            calls: ["createProvider"],
            check: ([{ args }]) => {
                assert.equal(args[0].class, "personal", "mine:true must create a personal provider");
                assert.equal(args[0].ownerUserId, VIEWER.userId, "a personal provider belongs to the caller");
            },
        },
    },
    {
        n: 5,
        op: "deleteProvider",
        http: { method: "DELETE", path: "/management/providers/:name", access: "fleet:admin" },
        mcp: { tool: "manage_provider", args: { action: "delete", name: "team", mine: false } },
        // Deleting a shared provider and deleting your own are one call in the
        // data layer: `cms_provider_delete` refuses a name the caller may not
        // touch, so 5 and 6 differ only in which door offers them. Both routes
        // must still reach it with the name they were given.
        agent: {
            tool: "manage_provider",
            args: { action: "delete", name: "team", mine: false },
            calls: ["deleteProvider"],
            check: ([{ args }]) => assert.equal(args[0], "team"),
        },
    },
    {
        n: 6,
        op: "deleteMyProvider",
        http: { method: "DELETE", path: "/me/providers/:name", access: "authed" },
        mcp: { tool: "manage_provider", args: { action: "delete", name: "mine", mine: true } },
        agent: {
            tool: "manage_provider",
            args: { action: "delete", name: "mine", mine: true },
            calls: ["deleteProvider"],
            check: ([{ args }]) => assert.equal(args[0], "mine"),
        },
    },
    {
        n: 7,
        op: "setProviderLimit",
        http: { method: "PUT", path: "/providers/:name/limit", access: "authed" },
        mcp: { tool: "set_provider_limit", args: { provider: "team", period: "day", tokens: 1000 } },
        agent: {
            tool: "set_provider_limit",
            args: { provider: "team", period: "day", tokens: 1000 },
            calls: ["setLimit"],
        },
    },
    {
        n: 8,
        op: "removeProviderLimit",
        http: { method: "DELETE", path: "/providers/:name/limit", access: "authed" },
        // No tokens is the remove branch — the one place an omitted argument
        // changes which capability runs.
        mcp: { tool: "set_provider_limit", args: { provider: "team", period: "day" } },
        agent: {
            tool: "set_provider_limit",
            args: { provider: "team", period: "day" },
            calls: ["removeLimit"],
        },
    },
    {
        n: 9,
        op: "setProviderAllowance",
        http: { method: "PUT", path: "/management/providers/:name/allowance", access: "fleet:admin" },
        mcp: { tool: "set_provider_allowance", args: { provider: "team", pct: 25 } },
        agent: {
            tool: "set_provider_allowance",
            args: { provider: "team", pct: 25 },
            calls: ["setAllowance"],
        },
    },
    {
        n: 10,
        op: "setProviderHold",
        http: { method: "PUT", path: "/management/providers/:name/hold", access: "fleet:admin" },
        mcp: { tool: "provider_hold", args: { provider: "team", action: "hold" } },
        agent: {
            tool: "provider_hold",
            args: { provider: "team", action: "hold" },
            calls: ["setHold"],
            check: ([{ args }]) => assert.equal(args[1].indefinite, true, "a hold with no end time never ends"),
        },
    },
    {
        n: 11,
        op: "getDefaults",
        http: { method: "GET", path: "/defaults", access: "authed" },
        mcp: { tool: "get_provider_defaults", args: {} },
        agent: { tool: "get_provider_defaults", args: {}, calls: ["getDefaults"] },
    },
    {
        n: 12,
        op: "setClusterDefault",
        http: { method: "PUT", path: "/management/defaults", access: "fleet:admin" },
        mcp: { tool: "set_provider_default", args: { scope: "cluster", provider: "team", model: "gpt-5" } },
        agent: {
            tool: "set_provider_default",
            args: { scope: "cluster", provider: "team", model: "gpt-5" },
            calls: ["setClusterDefault"],
        },
    },
    {
        n: 13,
        op: "setMyDefault",
        http: { method: "PUT", path: "/me/default", access: "authed" },
        mcp: { tool: "set_provider_default", args: { scope: "me", provider: "team", model: "gpt-5" } },
        agent: {
            tool: "set_provider_default",
            args: { scope: "me", provider: "team", model: "gpt-5" },
            calls: ["setUserDefault"],
        },
    },
    {
        n: 14,
        op: "getProviderUsage",
        http: { method: "GET", path: "/providers/usage", access: "authed" },
        mcp: { tool: "get_provider_usage", args: { days: 3, dimension: "model" } },
        // One question, three reads over one filter set: a report whose total
        // and whose chart came from different filters is one nobody can act on.
        agent: {
            tool: "get_provider_usage",
            args: { days: 3, dimension: "model" },
            calls: ["usageTotals", "usageDaily", "usageBreakdown"],
        },
    },
    {
        n: 15,
        op: "listPausedSessions",
        http: { method: "GET", path: "/providers/paused", access: "authed" },
        mcp: { tool: "list_paused_sessions", args: {} },
        agent: { tool: "list_paused_sessions", args: {}, calls: ["listPaused"] },
    },
    {
        n: 16,
        op: "getProviderUsageGrid",
        http: { method: "GET", path: "/providers/usage-grid", access: "authed" },
        // Not a re-shape of #2 for one screen. #2 lists LIMITS, so a period
        // nobody capped has nothing to report; this reports what that period
        // spent anyway. A capability that answers a question no other
        // capability answers has to reach every surface, like the rest.
        mcp: { tool: "get_provider_usage_grid", args: {} },
        agent: { tool: "get_provider_usage_grid", args: {}, calls: ["usageGrid"] },
    },
    {
        n: 17,
        op: "getModelDefaults",
        http: { method: "GET", path: "/model-defaults", access: "authed" },
        mcp: { tool: "get_model_defaults", args: {} },
        agent: { tool: "get_model_defaults", args: {}, calls: ["getDefaults", "listSystemAgentModels"] },
    },
    {
        n: 18,
        op: "setModelDefault",
        http: { method: "PUT", path: "/model-defaults", access: "authed" },
        mcp: { tool: "set_model_default", args: { scope: "user", provider: "team", model: "team:gpt" } },
        agent: { tool: "set_model_default", args: { scope: "user", provider: "team", model: "team:gpt" }, calls: ["setUserDefault"] },
    },
    {
        n: 19,
        op: "setProviderSystemUse",
        http: { method: "PUT", path: "/management/providers/:name/system-use", access: "fleet:admin" },
        mcp: { tool: "set_provider_system_use", args: { provider: "mine", enabled: true } },
        agent: { tool: "set_provider_system_use", args: { provider: "mine", enabled: true }, calls: ["setSystemUse"] },
    },
    {
        n: 20,
        op: "setSystemModelDefault",
        http: { method: "PUT", path: "/management/system-model-default", access: "fleet:admin" },
        mcp: { tool: "set_system_model_default", args: { provider: "team", model: "team:gpt" } },
        agent: { tool: "set_system_model_default", args: { provider: "team", model: "team:gpt" }, calls: ["setSystemDefault"] },
    },
    {
        n: 21,
        op: "setSystemSessionModel",
        http: { method: "PUT", path: "/management/system-sessions/:agentId/model", access: "fleet:admin" },
        mcp: { tool: "manage_system_session_model", args: { action: "set", agent_id: "sweeper", provider: "team", model: "team:gpt" } },
        agent: { tool: "manage_system_session_model", args: { action: "set", agent_id: "sweeper", provider: "team", model: "team:gpt" }, calls: ["setSystemAgentModel"] },
    },
    {
        n: 22,
        op: "clearSystemSessionModel",
        http: { method: "DELETE", path: "/management/system-sessions/:agentId/model", access: "fleet:admin" },
        mcp: { tool: "manage_system_session_model", args: { action: "clear", agent_id: "sweeper" } },
        agent: { tool: "manage_system_session_model", args: { action: "clear", agent_id: "sweeper" }, calls: ["clearSystemAgentModel"] },
    },
    {
        n: 23,
        op: "getLegacyProviderMigrationStatus",
        http: { method: "GET", path: "/management/providers/legacy-key-migration", access: "fleet:admin" },
        mcp: { tool: "get_legacy_provider_migration_status", args: {} },
        agent: { tool: "get_legacy_provider_migration_status", args: {}, calls: ["getLegacyKeyMigrationStatus"] },
    },
    {
        n: 24,
        op: "adoptLegacySystemGitHubCopilotKey",
        http: { method: "POST", path: "/management/providers/adopt-system-github-key", access: "fleet:admin" },
        mcp: { tool: "adopt_legacy_system_github_key", args: { name: "system-ghcp" } },
        agent: { tool: "adopt_legacy_system_github_key", args: { name: "system-ghcp" }, calls: ["adoptLegacySystemGitHubKey", "getLegacyKeyMigrationStatus"] },
    },
    {
        n: 25,
        op: "clearProviderRoutingDependencies",
        http: { method: "POST", path: "/providers/:name/clear-routing", access: "authed" },
        mcp: { tool: "manage_provider", args: { action: "clear_routing", name: "team", mine: false } },
        agent: { tool: "manage_provider", args: { action: "clear_routing", name: "team", mine: false }, calls: ["clearRoutingDependencies"] },
    },
    {
        n: 26,
        op: "updateMyProviderCredential",
        http: { method: "PUT", path: "/me/providers/:name/credential", access: "authed" },
        mcp: { tool: "manage_provider", args: { action: "update_credential", name: "mine", mine: true, credentials: { apiKey: "new" } } },
        agent: {
            tool: "manage_provider",
            args: { action: "update_credential", name: "mine", mine: true, credentials: { apiKey: "new" } },
            calls: ["updatePersonalCredential"],
        },
    },
    {
        n: 28,
        op: "getProviderUsageSummary",
        http: { method: "GET", path: "/providers/usage-summary", access: "authed" },
        mcp: { tool: "get_provider_usage_summary", args: { days: 14, providers: ["team"] } },
        agent: {
            tool: "get_provider_usage_summary",
            args: { days: 14, providers: ["team"] },
            calls: ["usageSummary"],
        },
    },
    {
        n: 27,
        op: "updateSharedProviderCredential",
        http: { method: "PUT", path: "/management/providers/:name/credential", access: "fleet:admin" },
        mcp: { tool: "manage_provider", args: { action: "update_credential", name: "team", mine: false, credentials: { apiKey: "new" } } },
        agent: {
            tool: "manage_provider",
            args: { action: "update_credential", name: "team", mine: false, credentials: { apiKey: "new" } },
            calls: ["updateSharedCredential"],
        },
    },
];

const CAPABILITY_OPS = CAPABILITIES.map((cap) => cap.op);

/**
 * The sample call is one the model could actually make: no argument the tool
 * never declared, and every argument it demands. Without this a routing proof
 * can pass on arguments the surface would reject.
 */
function assertLegalCall(where, declared, required, args) {
    const keys = Object.keys(args);
    assert.deepEqual(
        keys.filter((key) => !declared.includes(key)),
        [],
        `${where}: sends arguments the tool never declares`,
    );
    assert.deepEqual(
        required.filter((key) => !keys.includes(key)),
        [],
        `${where}: leaves out an argument the tool requires`,
    );
}

// ─── MCP ────────────────────────────────────────────────────────

let mcpToolFile = null;

/**
 * Register the MCP tools into a server that only remembers them, with a
 * management client that only remembers what it was asked for.
 *
 * `mgmt` is a Proxy rather than a fixed object so a tool calling a MISNAMED
 * management method records that name and fails the comparison below. A fixed
 * object would throw a TypeError, which the tool wrapper turns into a tidy
 * error result — a failure that reads like a refusal.
 */
async function registerMcpTools() {
    if (!mcpToolFile) {
        assert.ok(
            existsSync(fileURLToPath(MCP_TOOLS_DIST)),
            "packages/app/mcp is not built — run `npm run build --workspace=pilotswarm`",
        );
        mcpToolFile = await import(MCP_TOOLS_DIST.href);
    }
    const tools = new Map();
    const calls = [];
    const mgmt = new Proxy({}, {
        get: (_target, method) => async (...args) => {
            calls.push({ method: String(method), args });
            return {};
        },
    });
    mcpToolFile.registerProviderTools(
        { registerTool: (name, spec, handler) => tools.set(name, { spec, handler }) },
        { admin: true, mgmt },
    );
    return { tools, calls };
}

// ─── Agent tools ────────────────────────────────────────────────

/** Build the agent tools over a ProviderStore that only remembers its calls. */
function createRecordingProviderTools() {
    const calls = [];
    const record = (method, value) => (...args) => {
        calls.push({ method, args });
        return value;
    };
    const store = {
        listProviders: record("listProviders", []),
        providerStatus: record("providerStatus", []),
        usageGrid: record("usageGrid", []),
        createProvider: record("createProvider", { name: "team" }),
        updatePersonalCredential: record("updatePersonalCredential", { name: "mine" }),
        updateSharedCredential: record("updateSharedCredential", { name: "team" }),
        usageSummary: record("usageSummary", { days: 14, windows: {}, daily: [], models: [], classes: [] }),
        deleteProvider: record("deleteProvider", 0),
        setLimit: record("setLimit", { ruleId: 1, seededTokens: 0 }),
        removeLimit: record("removeLimit", true),
        setAllowance: record("setAllowance", 25),
        setHold: record("setHold", undefined),
        getDefaults: record("getDefaults", { cluster: {}, mine: {} }),
        setClusterDefault: record("setClusterDefault", undefined),
        setUserDefault: record("setUserDefault", undefined),
        setSystemUse: record("setSystemUse", true),
        setSystemDefault: record("setSystemDefault", undefined),
        setSystemAgentModel: record("setSystemAgentModel", undefined),
        clearSystemAgentModel: record("clearSystemAgentModel", true),
        listSystemAgentModels: record("listSystemAgentModels", []),
        getLegacyKeyMigrationStatus: record("getLegacyKeyMigrationStatus", {}),
        adoptLegacySystemGitHubKey: record("adoptLegacySystemGitHubKey", { name: "system-ghcp" }),
        clearRoutingDependencies: record("clearRoutingDependencies", {}),
        usageTotals: record("usageTotals", { tokensTotal: 0, turns: 0, sessions: 0 }),
        usageDaily: record("usageDaily", []),
        usageBreakdown: record("usageBreakdown", []),
        listPaused: record("listPaused", []),
    };
    const tools = new Map(
        createProviderTools({ catalog: { providers: store }, resolveViewer: () => VIEWER })
            .map((tool) => [tool.name, tool]),
    );
    return { tools, calls };
}

// ─── The three surfaces ─────────────────────────────────────────

test("every capability is a method on HttpApiTransport — the browser's and CLI's only path", async () => {
    // The HTTP table, the MCP and the agent tools are three surfaces; the
    // portal and the CLI reach the table through HttpApiTransport, whose
    // methods are hand-listed. 0.5.47 added updateSharedProviderCredential to
    // the other three and not here, so the portal's Update Key on a shared
    // row opened the sheet and then reported "not available on this
    // transport". A capability the transport cannot call is not shipped.
    const { HttpApiTransport } = await import("../../api/src/http-api-transport.js");
    const missing = CAPABILITIES
        .map((cap) => cap.op)
        .filter((op) => typeof HttpApiTransport.prototype[op] !== "function");
    assert.deepEqual(missing, [], `HttpApiTransport has no method for: ${missing.join(", ")}`);
});

test("every capability is an operation on the HTTP table", () => {
    assert.equal(CAPABILITIES.length, 28, "the contract lists twenty-eight capabilities");

    for (const cap of CAPABILITIES) {
        const op = OPERATIONS.find((row) => row.name === cap.op);
        assert.ok(op, `#${cap.n} ${cap.op}: no operation of that name in the protocol table`);
        assert.equal(op.method, cap.http.method, `#${cap.n} ${cap.op}: method`);
        assert.equal(op.path, cap.http.path, `#${cap.n} ${cap.op}: path`);
        assert.equal(op.access, cap.http.access, `#${cap.n} ${cap.op}: access`);
    }
});

test("every capability is a method on the management client", () => {
    // The generated web client is pinned to the table by
    // web-client-op-coverage.test.mjs; the direct client is pinned by nothing,
    // so a capability can sit in the table with no method behind it.
    for (const cap of CAPABILITIES) {
        assert.equal(
            typeof PilotSwarmManagementClient.prototype[cap.op],
            "function",
            `#${cap.n} ${cap.op}: the management client has no method of that name`,
        );
    }
});

test("every capability is reachable on the MCP tool surface", async () => {
    const { tools, calls } = await registerMcpTools();

    for (const cap of CAPABILITIES) {
        const entry = tools.get(cap.mcp.tool);
        assert.ok(entry, `#${cap.n} ${cap.op}: no MCP tool named ${cap.mcp.tool}`);

        const declared = Object.keys(entry.spec.inputSchema);
        const required = declared.filter((key) => !entry.spec.inputSchema[key].isOptional());
        assertLegalCall(`#${cap.n} ${cap.mcp.tool}`, declared, required, cap.mcp.args);

        calls.length = 0;
        const result = await entry.handler(cap.mcp.args, {});
        assert.ok(
            !result?.isError,
            `#${cap.n} ${cap.op}: ${cap.mcp.tool} refused a legal call: ${result?.content?.[0]?.text}`,
        );
        assert.deepEqual(
            calls.map((call) => call.method),
            [cap.op],
            `#${cap.n}: ${cap.mcp.tool}(${JSON.stringify(cap.mcp.args)}) must reach ${cap.op}`,
        );
    }
});

test("the MCP tool file is wired into the server", () => {
    // A regex, not a driven server: constructing the real one needs a live
    // ServerContext. Whole identifiers, so a rename on either side fails.
    const src = readFileSync(MCP_SERVER_SRC, "utf8");
    assert.match(src, /\bimport\s*\{\s*registerProviderTools\s*\}\s*from\s*"\.\/tools\/providers\.js"/);
    assert.match(src, /\bregisterProviderTools\s*\(\s*server\s*,\s*ctx\s*\)/);
});

test("the built MCP tools are the ones the source registers", async () => {
    // The check above drives packages/app/mcp/dist, which a checkout can carry
    // stale. Comparing it with the source's own registrations turns a stale
    // build into a named failure rather than a passing test of old code.
    const src = readFileSync(MCP_TOOLS_SRC, "utf8");
    const inSource = [...src.matchAll(/\bregisterTool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    const { tools } = await registerMcpTools();
    assert.deepEqual(
        [...tools.keys()].sort(),
        inSource.sort(),
        "packages/app/mcp/dist is stale — run `npm run build --workspace=pilotswarm`",
    );
});

test("every capability is reachable in the agent tools", async () => {
    const { tools, calls } = createRecordingProviderTools();

    for (const cap of CAPABILITIES) {
        const tool = tools.get(cap.agent.tool);
        assert.ok(tool, `#${cap.n} ${cap.op}: no agent tool named ${cap.agent.tool}`);

        assertLegalCall(
            `#${cap.n} ${cap.agent.tool}`,
            Object.keys(tool.parameters.properties),
            tool.parameters.required ?? [],
            cap.agent.args,
        );

        calls.length = 0;
        const result = await tool.handler(cap.agent.args, {});
        assert.equal(
            result?.error,
            undefined,
            `#${cap.n} ${cap.op}: ${cap.agent.tool} refused a legal call: ${result?.error}`,
        );
        assert.deepEqual(
            calls.map((call) => call.method),
            cap.agent.calls,
            `#${cap.n}: ${cap.agent.tool}(${JSON.stringify(cap.agent.args)}) must reach the data layer`,
        );
        cap.agent.check?.(calls);
    }
});

test("both halves of the agent surface carry the same tools", () => {
    // The two-place trap: a declaration with no handler hangs the turn, a
    // handler with no declaration is invisible to the model. Same names, both
    // halves, every time.
    const declared = providerToolDefs().map((tool) => tool.name).sort();
    const { tools } = createRecordingProviderTools();
    assert.deepEqual([...tools.keys()].sort(), declared);
    assert.deepEqual([...PROVIDER_TOOL_NAMES].sort(), declared);

    // Every capability's tool is one of them — no capability routed to a tool
    // that only this test believes in.
    for (const cap of CAPABILITIES) {
        assert.ok(declared.includes(cap.agent.tool), `#${cap.n} ${cap.op}: ${cap.agent.tool} is not declared`);
    }

    // The declarations reach the Token Manager and nobody else: ten of them on
    // every session would be resident context the fleet pays for each turn.
    const tokenManager = ManagedSession.systemToolDefs({ agentIdentity: "token-manager" }).map((t) => t.name);
    const ordinary = ManagedSession.systemToolDefs().map((t) => t.name);
    for (const name of declared) {
        assert.ok(tokenManager.includes(name), `the Token Manager is not shown ${name}`);
        assert.ok(!ordinary.includes(name), `an ordinary session is shown ${name}`);
    }
});

test("the Token Manager's own tools list carries every one of them", () => {
    // The third place. An agent's frontmatter list is the set of tools the
    // worker gives it, so a tool missing here is declared, handled, and still
    // unreachable.
    const agent = loadAgentFiles(SYSTEM_AGENTS_DIR).find((a) => a.name === "token-manager");
    assert.ok(agent, "token-manager.agent.md did not load");
    for (const name of PROVIDER_TOOL_NAMES) {
        assert.ok(agent.tools.includes(name), `token-manager.agent.md does not list ${name}`);
    }
});

// ─── The list above cannot go stale ─────────────────────────────

test("no provider budget operation is missing from the capability list", () => {
    // By path: everything under the roots the contract gives the feature.
    const byPath = OPERATIONS
        .filter((op) => /^\/(management\/)?(providers|defaults|system-model-default)(\/|$)|^\/model-defaults$|^\/management\/system-sessions\/.*\/model$|^\/me\/(providers|default)(\/|$)/.test(op.path))
        .map((op) => op.name);
    assert.deepEqual(
        byPath.sort(),
        [...CAPABILITY_OPS].sort(),
        "an operation on a provider budget path is not in CAPABILITIES — add it, with its MCP and agent tools",
    );

    // By name, for a sixteenth capability parked on some other path. Two
    // operations read as budget-shaped and are not: they are the model catalog,
    // which predates budgets and answers what a deployment can run, not who pays.
    const notBudget = ["getModelsByProvider", "getDefaultModel"];
    for (const name of notBudget) {
        assert.ok(
            OPERATIONS.some((op) => op.name === name),
            `${name} is no longer an operation — drop it from this list rather than leaving it here`,
        );
    }
    const byName = OPERATIONS
        .map((op) => op.name)
        .filter((name) => (
            /provider|default|paused/i.test(name)
            || name === "setSystemSessionModel"
            || name === "clearSystemSessionModel"
            || name === "adoptLegacySystemGitHubCopilotKey"
        ) && !notBudget.includes(name));
    assert.deepEqual(
        byName.sort(),
        [...CAPABILITY_OPS].sort(),
        "a budget-shaped operation is not in CAPABILITIES — add it, or add it to notBudget with a reason",
    );
});
