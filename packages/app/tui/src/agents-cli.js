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
    PgSessionCatalog,
    PilotSwarmManagementClient,
    createSessionBlobStore,
    FilesystemArtifactStore,
    validateAgentPackageDir,
    stageAgentPackageDir,
    publishAgentPackageDir,
    deleteAgentPackageEverywhere,
    readAgentPackageTarGz,
    fetchAgentPackageTarGz,
    AgentPackageValidationError,
} from "pilotswarm-sdk";
import { bootstrapApiAuth } from "./auth/cli.js";

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
  pilotswarm agents tree <name> [--semver <v>] [--json]
  pilotswarm agents cat <name> <file> [--semver <v>]
  pilotswarm agents rm <name> --yes

Connection (web API — the default):
  --api-url <url>          defaults to PILOTSWARM_API_URL
                           sign in first: pilotswarm auth login --api-url <url>

Connection (direct store — break-glass; no authn/authz):
  --store <postgres-url>   defaults to DATABASE_URL when no API URL is set
  --schema <cms-schema>    defaults to PILOTSWARM_CMS_SCHEMA

Scope:
  --user (default)  only you see the package's agents
  --shared          every user can create sessions from them`;

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
    const catalog = await PgSessionCatalog.create(store, flags.schema || process.env.PILOTSWARM_CMS_SCHEMA || undefined);
    try {
        await catalog.initialize();
        const sessionStateDir = process.env.SESSION_STATE_DIR
            || path.join(os.homedir(), ".copilot", "session-state");
        const artifactStore = createSessionBlobStore(process.env, { sessionStateDir })
            ?? new FilesystemArtifactStore(path.join(path.dirname(sessionStateDir), "artifacts"));
        return { mode: "direct", catalog, artifactStore, close: () => catalog.close() };
    } catch (error) {
        // Close the pool on init failure or the CLI hangs on idle pg clients
        // instead of exiting non-zero.
        await catalog.close().catch(() => {});
        throw error;
    }
}

async function makeContext(flags) {
    const resolved = resolveMode(flags);
    return resolved.mode === "web" ? makeWebContext(resolved) : makeDirectContext(resolved, flags);
}

/** Collect a package dir as the upload envelope: [{ path, contentBase64 }]. */
function collectUploadFiles(rootDir) {
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
                        // Validate the staged tree locally for a good error
                        // message; the server stages and re-validates the
                        // uploaded files authoritatively.
                        const staged = stageAgentPackageDir(resolvedDir);
                        try {
                            const validation = await validateAgentPackageDir(staged.dir, { preStaged: staged.staged });
                            if (!validation.ok) throw new AgentPackageValidationError(validation);
                        } finally {
                            staged.cleanup();
                        }
                        outcome = await ctx.client.uploadAgentPackage({ files: collectUploadFiles(resolvedDir), scope });
                    } else {
                        outcome = await publishAgentPackageDir(ctx, {
                            dir: resolvedDir,
                            scope,
                            owner: actor,
                            createdBy,
                            isAdmin,
                        });
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
                const packages = web
                    ? await ctx.client.listAgentPackages()
                    : await ctx.catalog.listAgentPackages(actor, isAdmin);
                if (flags.json) { console.log(JSON.stringify(packages, null, 2)); return 0; }
                if (packages.length === 0) { console.log("no agent packages registered"); return 0; }
                for (const pkg of packages) console.log(formatPackageLine(pkg));
                return 0;
            }
            case "show": {
                const name = rest[0];
                if (!name) { console.error("usage: pilotswarm agents show <name>"); return 1; }
                const detail = web
                    ? await ctx.client.getAgentPackage({ name })
                    : await ctx.catalog.getAgentPackage(name, actor, isAdmin);
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
                if (web) await ctx.client.pinAgentPackageVersion({ name, semver });
                else await ctx.catalog.pinAgentPackageVersion(name, semver, actor, isAdmin);
                console.log(`✓ ${name} active version pinned to ${semver} — fleet converges on the next epoch poll`);
                return 0;
            }
            case "promote":
            case "demote": {
                const name = rest[0];
                if (!name) { console.error(`usage: pilotswarm agents ${command} <name>`); return 1; }
                const scope = command === "promote" ? "shared" : "user";
                if (web) await ctx.client.setAgentPackageScope({ name, scope });
                else await ctx.catalog.setAgentPackageScope(name, scope, actor, isAdmin);
                console.log(`✓ ${name} is now ${scope}${scope === "shared" ? " — visible to every user" : " — visible only to its owner"} (running agents unaffected)`);
                return 0;
            }
            case "enable":
            case "disable": {
                const name = rest[0];
                if (!name) { console.error(`usage: pilotswarm agents ${command} <name>`); return 1; }
                const enabled = command === "enable";
                if (web) await ctx.client.setAgentPackageEnabled({ name, enabled });
                else await ctx.catalog.setAgentPackageEnabled(name, enabled, actor, isAdmin);
                console.log(`✓ ${name} ${enabled ? "enabled" : "disabled"} fleet-wide — workers converge on the next epoch poll`);
                return 0;
            }
            case "tree": {
                const name = rest[0];
                if (!name) { console.error("usage: pilotswarm agents tree <name> [--semver <v>]"); return 1; }
                const tree = web
                    ? await ctx.client.getAgentPackageTree({ name, semver: flags.semver })
                    : await directTree(ctx, name, flags.semver, actor, isAdmin);
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
                const file = web
                    ? await ctx.client.getAgentPackageFile({ name, semver: flags.semver, filePath })
                    : await directFile(ctx, name, flags.semver, filePath, actor, isAdmin);
                if (flags.json) { console.log(JSON.stringify(file, null, 2)); return 0; }
                if (file?.binary) { console.error(`${filePath} is binary (${file.size ?? "?"} bytes)`); return 1; }
                const text = typeof file === "string" ? file : (file?.content ?? file?.text ?? "");
                process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
                return 0;
            }
            case "rm": {
                const name = rest[0];
                if (!name) { console.error("usage: pilotswarm agents rm <name> --yes"); return 1; }
                if (!flags.yes) {
                    console.error(`refusing to delete "${name}" without --yes (removes every version and its artifacts; live sessions using its agents will fail resolution on their next turn)`);
                    return 1;
                }
                if (web) await ctx.client.deleteAgentPackage({ name });
                else await deleteAgentPackageEverywhere(ctx, name, actor, isAdmin);
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

/** Direct-mode tree/cat read the tarball the same way the portal ops do. */
async function loadDirectPackageEntries(ctx, name, semver, actor, isAdmin) {
    const detail = await ctx.catalog.getAgentPackage(name, actor, isAdmin);
    if (!detail) throw Object.assign(new Error(`package "${name}" not found`), { code: "NOT_FOUND" });
    const version = semver
        ? detail.versions.find((v) => v.semver === semver)
        : detail.versions.find((v) => v.versionId === detail.activeVersionId) ?? detail.versions[0];
    if (!version) {
        throw Object.assign(new Error(`package "${name}" has no ${semver ? `version ${semver}` : "versions"}`), { code: "NOT_FOUND" });
    }
    const targz = await fetchAgentPackageTarGz(ctx.artifactStore, version.artifactFilename, version.sha256);
    return readAgentPackageTarGz(targz);
}

async function directTree(ctx, name, semver, actor, isAdmin) {
    const entries = await loadDirectPackageEntries(ctx, name, semver, actor, isAdmin);
    return entries.map((entry) => ({ path: entry.path, size: entry.body.length }));
}

async function directFile(ctx, name, semver, filePath, actor, isAdmin) {
    const entries = await loadDirectPackageEntries(ctx, name, semver, actor, isAdmin);
    const entry = entries.find((e) => e.path === filePath);
    if (!entry) throw Object.assign(new Error(`${filePath} not found in ${name}`), { code: "NOT_FOUND" });
    // A NUL byte in the first block is the usual binary tell — it is also what
    // makes grep silently treat a source file as unsearchable.
    if (entry.body.subarray(0, 4096).includes(0)) {
        return { binary: true, size: entry.body.length };
    }
    return { content: entry.body.toString("utf8"), size: entry.body.length };
}
