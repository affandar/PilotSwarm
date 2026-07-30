/**
 * `pilotswarm agents …` — the agent-packages CLI
 * (docs/proposals/agent-packages.md).
 *
 * The local convenience the proposal promises: point it at a folder, it
 * validates, canonically tars, uploads to the reserved artifact location,
 * and registers — the exact pipeline every other source kind rides.
 *
 * Direct-store mode (operator): --store <postgres-url> or DATABASE_URL.
 * Web-API mode is served by the portal admin ops; from a terminal, direct
 * mode is the supported path (operators already hold store credentials).
 *
 *   pilotswarm agents validate ./my-agents
 *   pilotswarm agents push ./my-agents [--shared|--user] [--json]
 *   pilotswarm agents list | show <name> | pin <name>@<semver>
 *   pilotswarm agents promote <name> | demote <name> | rm <name> --yes
 */

import * as os from "node:os";
import * as path from "node:path";
import {
    PgSessionCatalog,
    createSessionBlobStore,
    FilesystemArtifactStore,
    validateAgentPackageDir,
    publishAgentPackageDir,
    deleteAgentPackageEverywhere,
    AgentPackageValidationError,
} from "pilotswarm-sdk";

function parseArgs(argv) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--shared") flags.scope = "shared";
        else if (arg === "--user") flags.scope = "user";
        else if (arg === "--json") flags.json = true;
        else if (arg === "--yes" || arg === "-y") flags.yes = true;
        else if (arg === "--store") flags.store = argv[++i];
        else if (arg === "--schema") flags.schema = argv[++i];
        else if (arg === "--api-url") flags.apiUrl = argv[++i];
        else if (arg === "--help" || arg === "-h") flags.help = true;
        else positional.push(arg);
    }
    return { flags, positional };
}

const USAGE = `pilotswarm agents — manage registry agent packages

Usage:
  pilotswarm agents validate <dir>
  pilotswarm agents push <dir> [--shared|--user] [--json]
  pilotswarm agents list [--json]
  pilotswarm agents show <name> [--json]
  pilotswarm agents pin <name>@<semver>
  pilotswarm agents promote <name> | demote <name>
  pilotswarm agents rm <name> --yes

Connection (direct store mode):
  --store <postgres-url>   defaults to DATABASE_URL
  --schema <cms-schema>    defaults to PILOTSWARM_CMS_SCHEMA

Scope:
  --user (default)  only you see the package's agents
  --shared          every user can create sessions from them`;

async function makeContext(flags) {
    const store = flags.store || process.env.DATABASE_URL;
    if (!store) {
        throw new Error("no store configured — pass --store <postgres-url> or set DATABASE_URL");
    }
    const catalog = await PgSessionCatalog.create(store, flags.schema || process.env.PILOTSWARM_CMS_SCHEMA || undefined);
    await catalog.initialize();
    const sessionStateDir = process.env.SESSION_STATE_DIR
        || path.join(os.homedir(), ".copilot", "session-state");
    const artifactStore = createSessionBlobStore(process.env, { sessionStateDir })
        ?? new FilesystemArtifactStore(path.join(path.dirname(sessionStateDir), "artifacts"));
    return { catalog, artifactStore, close: () => catalog.close() };
}

function printIssues(issues, stream = console.error) {
    for (const issue of issues) {
        stream(`  - [${issue.code}] ${issue.message}`);
    }
}

function formatPackageLine(pkg) {
    const scope = pkg.scope === "shared" ? "shared" : "user  ";
    const active = pkg.active
        ? `${pkg.active.semver} · ${pkg.active.sha256.slice(0, 7)}`
        : "(no active version)";
    const state = pkg.enabled ? "" : "  [disabled]";
    return `${pkg.enabled ? "●" : "○"} ${pkg.name.padEnd(28)} ${scope}  ${active}${state}`;
}

export async function runAgentsCommand(argv) {
    const { flags, positional } = parseArgs(argv);
    const [command, ...rest] = positional;
    if (flags.help || !command) {
        console.log(USAGE);
        return command ? 0 : 1;
    }
    if (flags.apiUrl) {
        console.error("[pilotswarm agents] --api-url mode: use the portal Admin console for remote package management; the terminal path is direct-store mode (--store / DATABASE_URL).");
        return 1;
    }

    // ── validate: purely local, no connection needed ──────────────
    if (command === "validate") {
        const dir = rest[0];
        if (!dir) { console.error("usage: pilotswarm agents validate <dir>"); return 1; }
        const result = await validateAgentPackageDir(path.resolve(dir));
        if (flags.json) {
            console.log(JSON.stringify(result, null, 2));
            return result.ok ? 0 : 1;
        }
        if (result.ok) {
            const m = result.manifest;
            console.log(`✓ ${m.name}@${m.version} — ${m.agents.length} agent(s), ${m.skills.length} skill(s), ${m.mcpServers.length} MCP server(s)${m.hasTools ? ", tools module" : ""}`);
        } else {
            console.error(`✗ package failed validation (${result.errors.length} error${result.errors.length === 1 ? "" : "s"}):`);
            printIssues(result.errors);
        }
        if (result.warnings.length > 0) {
            console.error("warnings:");
            printIssues(result.warnings, console.error);
        }
        return result.ok ? 0 : 1;
    }

    const ctx = await makeContext(flags);
    const actor = null;            // direct store mode = operator = admin
    const isAdmin = true;
    const createdBy = `${os.userInfo().username}@cli`;
    try {
        switch (command) {
            case "push": {
                const dir = rest[0];
                if (!dir) { console.error("usage: pilotswarm agents push <dir> [--shared|--user]"); return 1; }
                let outcome;
                try {
                    outcome = await publishAgentPackageDir(ctx, {
                        dir: path.resolve(dir),
                        scope: flags.scope ?? "user",
                        owner: actor,
                        createdBy,
                        isAdmin,
                    });
                } catch (error) {
                    if (error instanceof AgentPackageValidationError) {
                        console.error(`✗ ${path.resolve(dir)} failed validation:`);
                        printIssues(error.validation.errors);
                        return 1;
                    }
                    throw error;
                }
                if (flags.json) {
                    const { manifest: _m, warnings, ...summary } = outcome;
                    console.log(JSON.stringify({ ...summary, warnings }, null, 2));
                } else {
                    const verb = outcome.status === "noop" ? "already up to date" : "published";
                    console.log(`✓ ${outcome.name}@${outcome.semver} ${verb} (${(outcome.sizeBytes / 1024).toFixed(1)} KB, sha ${outcome.sha256.slice(0, 12)}, scope ${flags.scope ?? "user"})`);
                    for (const warning of outcome.warnings) console.error(`  ! ${warning.message}`);
                }
                return 0;
            }
            case "list": {
                const packages = await ctx.catalog.listAgentPackages(actor, isAdmin);
                if (flags.json) { console.log(JSON.stringify(packages, null, 2)); return 0; }
                if (packages.length === 0) { console.log("no agent packages registered"); return 0; }
                for (const pkg of packages) console.log(formatPackageLine(pkg));
                return 0;
            }
            case "show": {
                const name = rest[0];
                if (!name) { console.error("usage: pilotswarm agents show <name>"); return 1; }
                const detail = await ctx.catalog.getAgentPackage(name, actor, isAdmin);
                if (!detail) { console.error(`package "${name}" not found`); return 1; }
                if (flags.json) { console.log(JSON.stringify(detail, null, 2)); return 0; }
                console.log(`${detail.name} · ${detail.scope} · ${detail.enabled ? "enabled" : "disabled"}`);
                if (detail.createdBy) console.log(`created by ${detail.createdBy} on ${detail.createdAt.toISOString().slice(0, 10)}`);
                console.log("versions:");
                for (const version of detail.versions) {
                    const marker = version.versionId === detail.activeVersionId ? "●" : " ";
                    console.log(`  ${marker} ${version.semver.padEnd(14)} ${version.sha256.slice(0, 12)}  ${version.createdAt.toISOString().slice(0, 10)}`);
                }
                const agents = Array.isArray(detail.versions[0]?.manifest?.agents) ? detail.versions[0].manifest.agents : [];
                if (agents.length > 0) console.log(`agents: ${agents.map((a) => a.name).join(", ")}`);
                return 0;
            }
            case "pin": {
                let name = rest[0];
                let semver = rest[1];
                if (name?.includes("@")) [name, semver] = name.split("@");
                if (!name || !semver) { console.error("usage: pilotswarm agents pin <name>@<semver>"); return 1; }
                await ctx.catalog.pinAgentPackageVersion(name, semver, actor, isAdmin);
                console.log(`✓ ${name} active version pinned to ${semver} — fleet converges on the next epoch poll`);
                return 0;
            }
            case "promote":
            case "demote": {
                const name = rest[0];
                if (!name) { console.error(`usage: pilotswarm agents ${command} <name>`); return 1; }
                const scope = command === "promote" ? "shared" : "user";
                await ctx.catalog.setAgentPackageScope(name, scope, actor, isAdmin);
                console.log(`✓ ${name} is now ${scope}${scope === "shared" ? " — visible to every user" : " — visible only to its owner"} (running agents unaffected)`);
                return 0;
            }
            case "rm": {
                const name = rest[0];
                if (!name) { console.error("usage: pilotswarm agents rm <name> --yes"); return 1; }
                if (!flags.yes) {
                    console.error(`refusing to delete "${name}" without --yes (removes every version and its artifacts; live sessions using its agents will fail resolution on their next turn)`);
                    return 1;
                }
                await deleteAgentPackageEverywhere(ctx, name, actor, isAdmin);
                console.log(`✓ ${name} deleted (registry rows and artifacts)`);
                return 0;
            }
            default:
                console.error(`unknown agents command: ${command}\n`);
                console.log(USAGE);
                return 1;
        }
    } finally {
        await ctx.close();
    }
}
