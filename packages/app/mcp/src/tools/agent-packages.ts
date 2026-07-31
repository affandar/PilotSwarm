import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Agent-package management tools (docs/proposals/agent-packages.md).
 *
 * Web-mode only: every call rides the portal's /api/v1 ops, so the caller's
 * own credential decides visibility (user-scope packages) and authority
 * (creator-or-admin) — this process adds no privilege of its own.
 *
 * Tiered by ctx.agentMgmt: "off" registers nothing, "read" the inspection
 * tools, "full" (default) adds publish/sync/scope/pin/delete.
 */
export function registerAgentPackageTools(server: McpServer, ctx: ServerContext) {
    const api = ctx.api;
    if (!api || ctx.agentMgmt === "off") return;

    server.registerTool(
        "list_agent_packages",
        {
            title: "List Agent Packages",
            description:
                "List registry agent packages visible to this credential: shared packages plus your own "
                + "user-scope ones (admins see all). Each row carries the active version (semver, sha, size) "
                + "and its manifest (agents/skills/tools).",
            inputSchema: {},
        },
        withToolErrors(async () => {
            const packages = await api.call("listAgentPackages");
            return jsonResult({ count: Array.isArray(packages) ? packages.length : 0, packages });
        }),
    );

    server.registerTool(
        "get_agent_package",
        {
            title: "Get Agent Package",
            description: "One agent package with its full version history, plus the file tree of a version (workspace view).",
            inputSchema: {
                name: z.string().min(1).describe("Package name"),
                include_tree: z.boolean().optional().describe("Also return the file tree of the active (or given) version"),
                semver: z.string().optional().describe("Version for the tree (default: active)"),
            },
        },
        withToolErrors(async ({ name, include_tree, semver }) => {
            const detail = await api.call("getAgentPackage", { name });
            if (!detail) return errorResult(`package "${name}" not found or not visible to you`, { name });
            const result: Record<string, unknown> = { package: detail };
            if (include_tree) {
                result.tree = await api.call("getAgentPackageTree", { name, ...(semver ? { semver } : {}) });
            }
            return jsonResult(result);
        }),
    );

    server.registerTool(
        "get_agent_package_file",
        {
            title: "Get Agent Package File",
            description: "One file from a package version (agent prompts, SKILL.md, plugin.json, tool code). Text is size-capped; binaries come back base64.",
            inputSchema: {
                name: z.string().min(1).describe("Package name"),
                file_path: z.string().min(1).describe("File path inside the package (e.g. agents/triager.agent.md)"),
                semver: z.string().optional().describe("Version (default: active)"),
            },
        },
        withToolErrors(async ({ name, file_path, semver }) => {
            const file = await api.call("getAgentPackageFile", { name, filePath: file_path, ...(semver ? { semver } : {}) });
            return jsonResult(file);
        }),
    );

    if (ctx.agentMgmt !== "full") return;

    server.registerTool(
        "push_agent_package",
        {
            title: "Push Agent Package",
            description:
                "Publish an agent package from inline files — the MCP twin of `pilotswarm agents push`. "
                + "files is [{path, content_base64}] for a plugin directory (plugin.json + agents/ + skills/ "
                + "+ .mcp.json + tools/worker-module.js), ≤ 2 MB total. Validates, canonically packs, and "
                + "registers as your credential. Identical content republish is a no-op; same semver with "
                + "different content is rejected (bump the version).",
            inputSchema: {
                files: z.array(z.object({
                    path: z.string().min(1),
                    content_base64: z.string(),
                })).min(1).describe("Package files, paths relative to the package root"),
                scope: z.enum(["shared", "user"]).optional().describe("Visibility (default user)"),
            },
        },
        withToolErrors(async ({ files, scope }) => {
            const outcome = await api.call("uploadAgentPackage", {
                files: files.map((f: { path: string; content_base64: string }) => ({ path: f.path, contentBase64: f.content_base64 })),
                scope: scope ?? "user",
            });
            return jsonResult(outcome);
        }),
    );

    server.registerTool(
        "set_agent_package_scope",
        {
            title: "Promote / Demote Agent Package",
            description: "Set scope: shared (everyone can use its agents) or user (only the owner). Running agents are unaffected. Creator or admin.",
            inputSchema: {
                name: z.string().min(1),
                scope: z.enum(["shared", "user"]),
            },
        },
        withToolErrors(async ({ name, scope }) => {
            await api.call("setAgentPackageScope", { name, scope });
            return jsonResult({ ok: true, name, scope });
        }),
    );

    server.registerTool(
        "pin_agent_package_version",
        {
            title: "Pin Agent Package Version",
            description: "Point the package at a published version (rollback/roll-forward). The fleet converges on the next epoch poll. Creator or admin.",
            inputSchema: {
                name: z.string().min(1),
                semver: z.string().min(1),
            },
        },
        withToolErrors(async ({ name, semver }) => {
            await api.call("pinAgentPackageVersion", { name, semver });
            return jsonResult({ ok: true, name, active: semver });
        }),
    );

    server.registerTool(
        "set_agent_package_enabled",
        {
            title: "Enable / Disable Agent Package",
            description: "Disable removes the package's agents fleet-wide on the next epoch poll (live sessions fail resolution on their next turn); enable restores. Creator or admin.",
            inputSchema: {
                name: z.string().min(1),
                enabled: z.boolean(),
            },
        },
        withToolErrors(async ({ name, enabled }) => {
            await api.call("setAgentPackageEnabled", { name, enabled });
            return jsonResult({ ok: true, name, enabled });
        }),
    );

    server.registerTool(
        "delete_agent_package",
        {
            title: "Delete Agent Package",
            description: "Delete a package: every version and its artifacts. Live sessions using its agents fail resolution on their next turn. Creator or admin. This cannot be undone.",
            inputSchema: {
                name: z.string().min(1),
                confirm: z.literal(true).describe("Must be true — acknowledges the deletion is permanent"),
            },
        },
        withToolErrors(async ({ name }) => {
            await api.call("deleteAgentPackage", { name });
            return jsonResult({ ok: true, deleted: name });
        }),
    );
}
