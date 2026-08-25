/**
 * `pilotswarm agents …` — the agent-packages CLI
 * (docs/proposals/agent-packages.md).
 *
 * Web-API mode is the default, like every other surface: the deployment's
 * own authorization decides what you can see and change, and the CLI needs
 * no datastore credentials. `pilotswarm auth login --api-url <url>` once,
 * then point at the deployment with --api-url or PILOTSWARM_API_URL.
 *
 * Direct-store mode (--store <postgres-url>) is break-glass. It bypasses
 * authentication and authorization entirely — anyone holding the URL owns
 * the database — and it is what local-dev tooling and the test suite use.
 * It is also the path for packages above the 2 MB inline-upload envelope.
 *
 *   pilotswarm agents validate ./my-agents
 *   pilotswarm agents push ./my-agents [--shared|--user] [--json]
 *   pilotswarm agents list | show <name> | pin <name>@<semver>
 *   pilotswarm agents promote <name> | demote <name>
 *   pilotswarm agents enable <name> | disable <name>
 *   pilotswarm agents tree <name> [--semver <v>]
 *   pilotswarm agents cat <name> <file> [--semver <v>]
 *   pilotswarm agents rm <name> --yes
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    PilotSwarmManagementClient,
    createSessionBlobStore,
    FilesystemArtifactStore,
    validateAgentPackageDir,
    stageAgentPackageDir,
    listBundledAgentNames,
    listDeploymentMcpServerNames,
    loadAgentFiles,
    AgentPackageValidationError,
} from "pilotswarm-sdk";
import { bootstrapApiAuth } from "./auth/cli.js";
import { getPluginDirsFromEnv } from "./plugin-config.js";

/** The server's inline-upload envelope (node-sdk-transport uploadAgentPackage). */
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_MAX_FILES = 2000;

/** Never worth uploading, and `.git` alone can dwarf the 2 MB envelope. */
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

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
        else if (arg === "--semver") flags.semver = argv[++i];
        else if (arg === "--output" || arg === "-o") flags.output = argv[++i];
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
  pilotswarm agents enable <name> | disable <name>
  pilotswarm agents editors <name> [--json]
  pilotswarm agents editors add <name> <provider>:<subject>
  pilotswarm agents editors remove <name> <provider>:<subject>
  pilotswarm agents tree <name> [--semver <v>] [--json]
  pilotswarm agents cat <name> <file> [--semver <v>]
    pilotswarm agents download <name> [--semver <v>] [--output <file>]
  pilotswarm agents rm <name> --yes

Connection (web API — the default):
  --api-url <url>          defaults to PILOTSWARM_API_URL
                           sign in first: pilotswarm auth login --api-url <url>

Connection (direct store — break-glass; no authn/authz):
  --store <postgres-url>   defaults to DATABASE_URL when no API URL is set
  --schema <cms-schema>    defaults to PILOTSWARM_CMS_SCHEMA

Scope:
  --user (default)  only you see the package's agents
    --shared          every user can create sessions from them

For show/pin/promote/demote/enable/disable/tree/cat/download/rm, --user or
--shared selects which same-named package copy to target.`;

/**
 * Web unless direct is explicitly asked for. `--store` always wins; otherwise
 * an API URL wins over a stray DATABASE_URL, so a shell that happens to carry
 * datastore credentials no longer silently bypasses the deployment's authz.
 */
function resolveMode(flags) {
    if (flags.store) return { mode: "direct", store: flags.store };
    const apiUrl = String(flags.apiUrl || process.env.PILOTSWARM_API_URL || "").trim();
    if (apiUrl) return { mode: "web", apiUrl: apiUrl.replace(/\/+$/, "") };
    if (process.env.DATABASE_URL) return { mode: "direct", store: process.env.DATABASE_URL };
    throw new Error(
        "no deployment configured — pass --api-url <url> (or set PILOTSWARM_API_URL), "
        + "or --store <postgres-url> for direct break-glass access",
    );
}

async function makeWebContext({ apiUrl }) {
    const { getAccessToken } = await bootstrapApiAuth(apiUrl, { interactive: true });
    const client = new PilotSwarmManagementClient({ apiUrl, getAccessToken });
    await client.start();
    return { mode: "web", client, close: () => client.stop().catch(() => {}) };
}

async function makeDirectContext({ store }, flags) {
    const sessionStateDir = process.env.SESSION_STATE_DIR
        || path.join(os.homedir(), ".copilot", "session-state");
    const artifactStore = createSessionBlobStore(process.env, { sessionStateDir })
        ?? new FilesystemArtifactStore(path.join(path.dirname(sessionStateDir), "artifacts"));
    const client = new PilotSwarmManagementClient({
        store,
        cmsSchema: flags.schema || process.env.PILOTSWARM_CMS_SCHEMA || undefined,
        artifactStore,
    });
    try {
        await client.start();
        return { mode: "direct", client, close: () => client.stop() };
    } catch (error) {
        await client.stop().catch(() => {});
        throw error;
    }
}

async function makeContext(flags) {
    const resolved = resolveMode(flags);
    if (resolved.mode === "web") return makeWebContext(resolved);
    // Say so, every time. Direct mode bypasses authentication and
    // authorization entirely, and its output is indistinguishable from the
    // web path — a shell that happens to carry DATABASE_URL would otherwise
    // silently downgrade an intended-authorized command with no visible sign.
    console.error(
        `[pilotswarm agents] direct-store mode — no authentication or authorization (${flags.store ? "--store" : "DATABASE_URL"}).`
        + " Pass --api-url <url> (or set PILOTSWARM_API_URL) to go through a deployment.",
    );
    return makeDirectContext(resolved, flags);
}

/**
 * Build the web-mode upload payload: validate AND collect from the SAME
 * staged tree, so the uploaded bytes are the validated bytes — the invariant
 * `publishAgentPackageDir` maintains for the direct path.
 *
 * A manifest-mode package stages only the files its plugin.json declares.
 * Walking the original directory instead would upload whatever else happens
 * to sit beside it — files validation never saw, and enough of them to blow
 * the 2 MB envelope on a package that is comfortably under it.
 *
 * Throws AgentPackageValidationError so the caller can print the issues.
 */
export async function buildUploadPayload(rootDir) {
    const staged = stageAgentPackageDir(rootDir);
    try {
        const validation = await validateAgentPackageDir(staged.dir, { preStaged: staged.staged });
        if (!validation.ok) throw new AgentPackageValidationError(validation);
        return collectUploadFiles(staged.dir);
    } finally {
        staged.cleanup();
    }
}

/** Collect a package dir as the upload envelope: [{ path, contentBase64 }]. */
export function collectUploadFiles(rootDir) {
    const files = [];
    let total = 0;
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const abs = path.join(dir, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { walk(abs, rel); continue; }
            if (!entry.isFile()) continue;
            const bytes = fs.readFileSync(abs);
            total += bytes.length;
            if (files.length >= UPLOAD_MAX_FILES) {
                throw new Error(`package has more than ${UPLOAD_MAX_FILES} files — push it with --store instead`);
            }
            if (total > UPLOAD_MAX_BYTES) {
                throw new Error(
                    `package exceeds the ${(UPLOAD_MAX_BYTES / 1024 / 1024).toFixed(0)} MB inline-upload envelope — `
                    + "push it with --store <postgres-url> (direct mode packs up to 16 MB compressed)",
                );
            }
            files.push({ path: rel, contentBase64: bytes.toString("base64") });
        }
    };
    walk(rootDir, "");
    if (files.length === 0) throw new Error(`no files found under ${rootDir}`);
    return files;
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

/** Dates cross the Web API as ISO strings and arrive as Dates in direct mode. */
function asDay(value) {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function reservedAgentNamesForCli() {
    const names = new Set(listBundledAgentNames());
    for (const pluginDir of getPluginDirsFromEnv()) {
        for (const agent of loadAgentFiles(pluginDir)) {
            if (agent?.name) names.add(agent.name);
            if (agent?.id) names.add(agent.id);
        }
    }
    return [...names];
}

export function packageFileForCli(file) {
    if (file?.encoding === "base64" || file?.binary === true) {
        return { binary: true, size: file?.size ?? 0, text: "" };
    }
    return {
        binary: false,
        size: file?.size ?? 0,
        text: typeof file === "string" ? file : (file?.content ?? file?.text ?? ""),
    };
}

export async function runAgentsCommand(argv) {
    const { flags, positional } = parseArgs(argv);
    const [command, ...rest] = positional;
    if (flags.help || !command) {
        console.log(USAGE);
        return command ? 0 : 1;
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
    const web = ctx.mode === "web";
    const actor = null;            // direct store mode = operator = admin
    const isAdmin = true;
    const createdBy = `${os.userInfo().username}@cli`;
    const selector = flags.scope ? { scope: flags.scope } : null;
    try {
        switch (command) {
            case "push": {
                const dir = rest[0];
                if (!dir) { console.error("usage: pilotswarm agents push <dir> [--shared|--user]"); return 1; }
                const resolvedDir = path.resolve(dir);
                const scope = flags.scope ?? "user";
                let outcome;
                try {
                    if (web) {
                        outcome = await ctx.client.uploadAgentPackage(
                            await buildUploadPayload(resolvedDir), scope, actor, isAdmin,
                        );
                    } else {
                        outcome = await ctx.client.publishAgentPackageDirectory(
                            resolvedDir, scope, actor, isAdmin, {
                                createdBy,
                                reservedAgentNames: reservedAgentNamesForCli(),
                                reservedMcpServerNames: listDeploymentMcpServerNames(getPluginDirsFromEnv()),
                            },
                        );
                    }
                } catch (error) {
                    if (error instanceof AgentPackageValidationError) {
                        console.error(`✗ ${resolvedDir} failed validation:`);
                        printIssues(error.validation.errors);
                        return 1;
                    }
                    throw error;
                }
                if (flags.json) {
                    const { manifest: _m, warnings, ...summary } = outcome;
                    console.log(JSON.stringify({ ...summary, warnings: warnings ?? [] }, null, 2));
                } else {
                    const verb = outcome.status === "noop" ? "already up to date" : "published";
                    console.log(`✓ ${outcome.name}@${outcome.semver} ${verb} (${(outcome.sizeBytes / 1024).toFixed(1)} KB, sha ${outcome.sha256.slice(0, 12)}, scope ${scope})`);
                    for (const warning of outcome.warnings ?? []) console.error(`  ! ${warning.message}`);
                }
                return 0;
            }
            case "list": {
                const packages = await ctx.client.listAgentPackages(actor, isAdmin);
                if (flags.json) { console.log(JSON.stringify(packages, null, 2)); return 0; }
                if (packages.length === 0) { console.log("no agent packages registered"); return 0; }
                for (const pkg of packages) console.log(formatPackageLine(pkg));
                return 0;
            }
            case "show": {
                const name = rest[0];
                if (!name) { console.error("usage: pilotswarm agents show <name>"); return 1; }
                const detail = await ctx.client.getAgentPackage(name, actor, isAdmin, selector);
                if (!detail) { console.error(`package "${name}" not found`); return 1; }
                if (flags.json) { console.log(JSON.stringify(detail, null, 2)); return 0; }
                console.log(`${detail.name} · ${detail.scope} · ${detail.enabled ? "enabled" : "disabled"}`);
                if (detail.createdBy) console.log(`created by ${detail.createdBy} on ${asDay(detail.createdAt)}`);
                console.log("versions:");
                for (const version of detail.versions) {
                    const marker = version.versionId === detail.activeVersionId ? "●" : " ";
                    console.log(`  ${marker} ${version.semver.padEnd(14)} ${version.sha256.slice(0, 12)}  ${asDay(version.createdAt)}`);
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
                await ctx.client.pinAgentPackageVersion(name, semver, actor, isAdmin, selector);
                console.log(`✓ ${name} active version pinned to ${semver} — fleet converges on the next epoch poll`);
                return 0;
            }
            case "promote":
            case "demote": {
                const name = rest[0];
                if (!name) { console.error(`usage: pilotswarm agents ${command} <name>`); return 1; }
                const scope = command === "promote" ? "shared" : "user";
                await ctx.client.setAgentPackageScope(name, scope, actor, isAdmin, selector);
                console.log(`✓ ${name} is now ${scope}${scope === "shared" ? " — visible to every user" : " — visible only to its owner"} (running agents unaffected)`);
                return 0;
            }
            case "enable":
            case "disable": {
                const name = rest[0];
                if (!name) { console.error(`usage: pilotswarm agents ${command} <name>`); return 1; }
                const enabled = command === "enable";
                await ctx.client.setAgentPackageEnabled(name, enabled, actor, isAdmin, selector);
                console.log(`✓ ${name} ${enabled ? "enabled" : "disabled"} fleet-wide — workers converge on the next epoch poll`);
                return 0;
            }
            // Editors: write grants on a SHARED package. `<provider>:<subject>`
            // is the identity pair list_known_users / the share dialog show.
            case "editors": {
                const usage = "usage: pilotswarm agents editors <name> [--json] | editors add|remove <name> <provider>:<subject>";
                const verb = rest[0] === "add" || rest[0] === "remove" ? rest[0] : null;
                const name = verb ? rest[1] : rest[0];
                if (!name) { console.error(usage); return 1; }
                if (!verb) {
                    const editors = await ctx.client.listAgentPackageEditors(name);
                    if (flags.json) { console.log(JSON.stringify(editors, null, 2)); return 0; }
                    if (editors.length === 0) { console.log(`${name}: no editors (only the owner and admins can change it)`); return 0; }
                    for (const e of editors) {
                        const who = e.displayName || e.email || e.subject;
                        console.log(`  ${who}  ${e.provider}:${e.subject}  granted ${asDay(e.grantedAt)}${e.grantedByDisplay ? ` by ${e.grantedByDisplay}` : ""}`);
                    }
                    return 0;
                }
                const who = String(rest[2] ?? "");
                const sep = who.indexOf(":");
                if (sep <= 0 || sep === who.length - 1) { console.error(usage); return 1; }
                const grantee = { provider: who.slice(0, sep), subject: who.slice(sep + 1) };
                if (verb === "add") {
                    await ctx.client.grantAgentPackageEditor(name, grantee, actor, isAdmin);
                    console.log(`✓ ${grantee.provider}:${grantee.subject} can now publish, pin and enable ${name} (revoked if the package is demoted)`);
                } else {
                    await ctx.client.revokeAgentPackageEditor(name, grantee, actor, isAdmin);
                    console.log(`✓ ${grantee.provider}:${grantee.subject} is no longer an editor of ${name}`);
                }
                return 0;
            }
            case "tree": {
                const name = rest[0];
                if (!name) { console.error("usage: pilotswarm agents tree <name> [--semver <v>]"); return 1; }
                const tree = await ctx.client.getAgentPackageTree(name, flags.semver ?? null, actor, isAdmin, selector);
                if (flags.json) { console.log(JSON.stringify(tree, null, 2)); return 0; }
                const entries = Array.isArray(tree) ? tree : (tree?.files ?? tree?.entries ?? []);
                if (entries.length === 0) { console.log("(empty package)"); return 0; }
                for (const entry of entries) {
                    const p = typeof entry === "string" ? entry : entry.path;
                    const size = typeof entry === "string" ? null : entry.size;
                    console.log(size == null ? `  ${p}` : `  ${String(size).padStart(8)}  ${p}`);
                }
                return 0;
            }
            case "cat": {
                const name = rest[0];
                const filePath = rest[1];
                if (!name || !filePath) { console.error("usage: pilotswarm agents cat <name> <file> [--semver <v>]"); return 1; }
                const file = await ctx.client.getAgentPackageFile(name, flags.semver ?? null, filePath, actor, isAdmin, selector);
                if (flags.json) { console.log(JSON.stringify(file, null, 2)); return 0; }
                const formatted = packageFileForCli(file);
                if (formatted.binary) { console.error(`${filePath} is binary (${formatted.size || "?"} bytes)`); return 1; }
                process.stdout.write(formatted.text.endsWith("\n") ? formatted.text : `${formatted.text}\n`);
                return 0;
            }
            case "download": {
                const name = rest[0];
                if (!name) { console.error("usage: pilotswarm agents download <name> [--semver <v>] [--output <file>]"); return 1; }
                const pkg = await ctx.client.downloadAgentPackage(name, flags.semver ?? null, actor, isAdmin, selector);
                const output = path.resolve(flags.output || pkg.filename || `${name}.tgz`);
                fs.writeFileSync(output, Buffer.from(pkg.body));
                console.log(`✓ ${name}@${pkg.semver} downloaded to ${output} (sha ${pkg.sha256.slice(0, 12)})`);
                return 0;
            }
            case "rm": {
                const name = rest[0];
                if (!name) { console.error("usage: pilotswarm agents rm <name> --yes"); return 1; }
                if (!flags.yes) {
                    console.error(`refusing to delete "${name}" without --yes (removes every version and its artifacts; live sessions using its agents will fail resolution on their next turn)`);
                    return 1;
                }
                await ctx.client.deleteAgentPackage(name, actor, isAdmin, selector);
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

export async function directTree(ctx, name, semver, actor, isAdmin) {
    const tree = await ctx.client.getAgentPackageTree(name, semver ?? null, actor, isAdmin);
    return tree?.files ?? tree ?? [];
}

export async function directFile(ctx, name, semver, filePath, actor, isAdmin) {
    const file = await ctx.client.getAgentPackageFile(name, semver ?? null, filePath, actor, isAdmin);
    const formatted = packageFileForCli(file);
    return formatted.binary
        ? { binary: true, size: formatted.size }
        : { content: formatted.text, size: formatted.size };
}
