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
    const web = ctx.web;
    if (!web || ctx.agentMgmt === "off") return;
    const owner = null;

    server.registerTool(
        "list_agent_packages",
        {
            title: "List Agent Packages",
            description:
                "List registry agent packages visible to this credential: shared packages plus your own "
                + "user-scope ones (unrestricted admins see all; cluster-scoped admins use ordinary access). Each row carries the active version (semver, sha, size) "
                + "and its manifest (agents/skills/tools).",
            inputSchema: {},
        },
        withToolErrors(async () => {
            const packages = await ctx.mgmt.listAgentPackages(owner, ctx.admin);
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
                scope: z.enum(["shared", "user"]).optional().describe("Which same-named copy (scope shadowing): default walks your copy, then shared"),
            },
        },
        withToolErrors(async ({ name, include_tree, semver, scope }) => {
            const sel = scope ? { scope } : {};
            const detail = await ctx.mgmt.getAgentPackage(name, owner, ctx.admin, sel);
            if (!detail) return errorResult(`package "${name}" not found or not visible to you`, { name });
            const query = new URLSearchParams();
            if (semver) query.set("semver", semver);
            if (scope) query.set("scope", scope);
            const suffix = query.toString() ? `?${query}` : "";
            const result: Record<string, unknown> = {
                package: detail,
                download_url: `/api/v1/agent-packages/${encodeURIComponent(name)}/download${suffix}`,
            };
            if (include_tree) {
                result.tree = await ctx.mgmt.getAgentPackageTree(name, semver ?? null, owner, ctx.admin, sel);
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
                scope: z.enum(["shared", "user"]).optional().describe("Which same-named copy (scope shadowing)"),
            },
        },
        withToolErrors(async ({ name, file_path, semver, scope }) => {
            const file = await ctx.mgmt.getAgentPackageFile(
                name, semver ?? null, file_path, owner, ctx.admin, scope ? { scope } : null,
            );
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
            const outcome = await ctx.mgmt.uploadAgentPackage(
                files.map((f: { path: string; content_base64: string }) => ({ path: f.path, contentBase64: f.content_base64 })),
                scope ?? "user", owner, ctx.admin,
            );
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
            await ctx.mgmt.setAgentPackageScope(name, scope, owner, ctx.admin);
            return jsonResult({ ok: true, name, scope });
        }),
    );

    server.registerTool(
        "republish_agent_package_version",
        {
            title: "Republish Agent Package Version Across Scopes",
            description:
                "Publish an existing version's exact bytes into the same-named package in the other scope. "
                + "THE update path for an already-published shared package: promote can only move a row to an "
                + "unused name, this adds a version to the existing one. Creator or admin.",
            inputSchema: {
                name: z.string().min(1),
                semver: z.string().optional().describe("Source version (default: the source copy's active version)"),
                target_scope: z.enum(["shared", "user"]).describe("Destination scope; the source is the same-named package in the other scope"),
                owner_provider: z.string().optional().describe("Admin only: provider of another user's source copy"),
                owner_subject: z.string().optional().describe("Admin only: subject of another user's source copy"),
            },
        },
        withToolErrors(async ({ name, semver, target_scope, owner_provider, owner_subject }) => {
            const outcome = await ctx.mgmt.republishAgentPackageVersion(
                name, semver ?? null, target_scope, owner, ctx.admin, {
                    selector: owner_provider && owner_subject
                        ? { owner: { provider: owner_provider, subject: owner_subject } }
                        : null,
                },
            );
            return jsonResult(outcome);
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
                scope: z.enum(["shared", "user"]).optional().describe("Which same-named copy to pin (scope shadowing): default walks your copy, then shared"),
            },
        },
        withToolErrors(async ({ name, semver, scope }) => {
            await ctx.mgmt.pinAgentPackageVersion(name, semver, owner, ctx.admin, scope ? { scope } : null);
            return jsonResult({ ok: true, name, active: semver, ...(scope ? { scope } : {}) });
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
                scope: z.enum(["shared", "user"]).optional().describe("Which same-named copy (scope shadowing): default walks your copy, then shared"),
            },
        },
        withToolErrors(async ({ name, enabled, scope }) => {
            await ctx.mgmt.setAgentPackageEnabled(name, enabled, owner, ctx.admin, scope ? { scope } : null);
            return jsonResult({ ok: true, name, enabled, ...(scope ? { scope } : {}) });
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
                scope: z.enum(["shared", "user"]).optional().describe("Which same-named copy to delete (scope shadowing). Strongly recommended when both copies exist."),
            },
        },
        withToolErrors(async ({ name, scope }) => {
            await ctx.mgmt.deleteAgentPackage(name, owner, ctx.admin, scope ? { scope } : null);
            return jsonResult({ ok: true, deleted: name, ...(scope ? { scope } : {}) });
        }),
    );

    // ── Editors: write grants on a SHARED package ──────────────────────
    const editorUser = {
        provider: z.string().min(1).describe("Grantee identity provider (as in list_known_users)"),
        subject: z.string().min(1).describe("Grantee subject id (as in list_known_users)"),
    };

    server.registerTool(
        "grant_agent_package_editor",
        {
            title: "Grant Agent Package Editor",
            description:
                "Give a user WRITE access to a SHARED package: publish new versions, republish into it, pin, "
                + "enable/disable. Not scope changes, delete, or the editor list — those stay with the owner. "
                + "Owner or admin. The grant is deleted when the package is demoted to user scope. "
                + "Find the user with list_known_users.",
            inputSchema: { name: z.string().min(1), ...editorUser },
        },
        withToolErrors(async ({ name, provider, subject }) => {
            await ctx.mgmt.grantAgentPackageEditor(name, { provider, subject }, owner, ctx.admin);
            return jsonResult({ ok: true, name, editor: { provider, subject } });
        }),
    );

    server.registerTool(
        "revoke_agent_package_editor",
        {
            title: "Revoke Agent Package Editor",
            description: "Remove a user's editor grant on a shared package. Owner or admin; idempotent.",
            inputSchema: { name: z.string().min(1), ...editorUser },
        },
        withToolErrors(async ({ name, provider, subject }) => {
            await ctx.mgmt.revokeAgentPackageEditor(name, { provider, subject }, owner, ctx.admin);
            return jsonResult({ ok: true, name, revoked: { provider, subject } });
        }),
    );

    server.registerTool(
        "list_agent_package_editors",
        {
            title: "List Agent Package Editors",
            description: "Editors of the shared copy of a package. Visible to anyone who can see the package.",
            inputSchema: { name: z.string().min(1) },
        },
        withToolErrors(async ({ name }) => {
            return jsonResult({ name, editors: await ctx.mgmt.listAgentPackageEditors(name) });
        }),
    );
}
