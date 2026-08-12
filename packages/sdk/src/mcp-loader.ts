/**
 * MCP config loader — reads .mcp.json files from plugin directories.
 *
 * File format (matches @github/copilot-sdk MCPServerConfig):
 *
 *   {
 *     "my-server": {
 *       "command": "node",
 *       "args": ["server.js"],
 *       "tools": ["*"]
 *     },
 *     "remote-api": {
 *       "type": "http",
 *       "url": "https://api.example.com/mcp",
 *       "tools": ["query"],
 *       "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
 *       "default": true
 *     }
 *   }
 *
 * Environment variable references like `${VAR}` in string values
 * are expanded at load time.
 *
 * Servers are a deployment CATALOG, not an automatic every-session grant:
 * agents receive a server by naming it in their `.agent.md` `mcpServers:`
 * frontmatter, or — for servers tagged `"default": true` (the deployment
 * default set; a PilotSwarm-only tag stripped before the config reaches the
 * Copilot CLI) — via `inheritDefaultMcpServers: true`.
 *
 * A deployment catalog entry may additionally carry `"allowedAgents"`: a
 * list of agent identities that are the ONLY agents allowed to reference
 * it. See {@link mcpAllowlistAdmits} for the identity forms. Like `default`,
 * it is a PilotSwarm-only field, stripped before configs reach the CLI, and
 * it is honoured only in deployment plugin dirs — a package `.mcp.json`
 * can neither restrict a server nor redefine a restricted one.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────

/** Matches @github/copilot-sdk MCPServerConfig union. */
export type MCPServerConfig = MCPLocalServerConfig | MCPRemoteServerConfig;

export interface MCPLocalServerConfig {
    type?: "local" | "stdio";
    command: string;
    args: string[];
    tools: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
    /**
     * PilotSwarm-only deployment tag (not a Copilot SDK field): marks this
     * server as part of the deployment default MCP set, granted to agents
     * with `inheritDefaultMcpServers: true`. Stripped by the worker before
     * configs reach the Copilot CLI.
     */
    default?: boolean;
    /**
     * PilotSwarm-only deployment tag (not a Copilot SDK field): the agent
     * identities allowed to reference this server. Any other reference is
     * dropped at load. Entries are `name` (a deployment agent) or
     * `namespace:name` (an agent from the plugin/package with that
     * namespace; for a package, its shared copy only). Stripped by the
     * worker before configs reach the Copilot CLI. Ignored in package dirs.
     */
    allowedAgents?: string[];
}

export interface MCPRemoteServerConfig {
    type: "http" | "sse";
    url: string;
    tools: string[];
    headers?: Record<string, string>;
    timeout?: number;
    /**
     * PilotSwarm-only deployment tag (not a Copilot SDK field): marks this
     * server as part of the deployment default MCP set, granted to agents
     * with `inheritDefaultMcpServers: true`. Stripped by the worker before
     * configs reach the Copilot CLI.
     */
    default?: boolean;
    /**
     * PilotSwarm-only deployment tag (not a Copilot SDK field): the agent
     * identities allowed to reference this server. Any other reference is
     * dropped at load. Entries are `name` (a deployment agent) or
     * `namespace:name` (an agent from the plugin/package with that
     * namespace; for a package, its shared copy only). Stripped by the
     * worker before configs reach the Copilot CLI. Ignored in package dirs.
     */
    allowedAgents?: string[];
}

// ─── Allowlist ──────────────────────────────────────────────────

/** The parts of a loaded agent that an `allowedAgents` entry is matched against. */
export interface McpAllowlistAgent {
    name: string;
    /** Plugin namespace: the plugin.json name of the dir the agent came from. */
    namespace?: string | null;
    /** Set for agents loaded from an installed agent package. */
    packageId?: string | null;
    /** Which copy of the package the agent came from. */
    packageScope?: "shared" | "user" | null;
}

/**
 * Does an `allowedAgents` list admit this agent?
 *
 * Entries are agent identities, in the two forms the loader already uses:
 *
 *   `name`            a DEPLOYMENT agent (baked plugin dir or inline config)
 *                     with that name. Never a package agent, even one with
 *                     the same name — any shared package could ship one.
 *   `namespace:name`  the agent `name` from the plugin or package whose
 *                     namespace is `namespace` (a package's namespace is its
 *                     plugin.json name). For a package agent this admits only
 *                     the SHARED copy: a user-scope copy of the same package
 *                     is a different package, and a personal copy must not be
 *                     a way to borrow a restricted server.
 *
 * Returns false for a missing agent (base-agent and direct-config references
 * carry no agent), so a restricted server never reaches the every-session map.
 */
export function mcpAllowlistAdmits(allowed: Iterable<string>, agent: McpAllowlistAgent | null | undefined): boolean {
    if (!agent || typeof agent.name !== "string" || !agent.name) return false;
    const isPackage = Boolean(agent.packageId);
    for (const raw of allowed) {
        const entry = String(raw ?? "").trim();
        if (!entry) continue;
        const sep = entry.indexOf(":");
        if (sep < 0) {
            if (!isPackage && entry === agent.name) return true;
            continue;
        }
        const ns = entry.slice(0, sep);
        const name = entry.slice(sep + 1);
        if (name !== agent.name || ns !== (agent.namespace ?? "")) continue;
        if (isPackage && agent.packageScope !== "shared") continue;
        return true;
    }
    return false;
}

/**
 * Names of servers that a deployment restricts with `allowedAgents`, read
 * from the given plugin dirs' `.mcp.json` files. Used at package publish
 * time: a package that defines one of these names would be dropped by every
 * worker, so validation rejects it up front.
 */
export function listRestrictedMcpServerNames(pluginDirs: string[]): string[] {
    const names = new Set<string>();
    for (const dir of pluginDirs ?? []) {
        for (const [name, cfg] of Object.entries(loadMcpConfig(dir))) {
            if (Array.isArray((cfg as any)?.allowedAgents)) names.add(name);
        }
    }
    return [...names];
}

/**
 * Every server name the deployment's plugin dirs define. A package may not
 * define any of these: the catalog is flat, and a package entry with a
 * deployment name would replace the server every agent in the fleet talks
 * to. The worker drops such entries at load; publish rejects them up front.
 */
export function listDeploymentMcpServerNames(pluginDirs: string[]): string[] {
    const names = new Set<string>();
    for (const dir of pluginDirs ?? []) {
        for (const name of Object.keys(loadMcpConfig(dir))) names.add(name);
    }
    return [...names];
}

// ─── Env Expansion ──────────────────────────────────────────────

/** Expand `${VAR}` references in a string using process.env. */
function expandEnv(value: string): string {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

/** Recursively expand env vars in all string values of an object. */
function expandEnvDeep(obj: any): any {
    if (typeof obj === "string") return expandEnv(obj);
    if (Array.isArray(obj)) return obj.map(expandEnvDeep);
    if (obj && typeof obj === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = expandEnvDeep(value);
        }
        return result;
    }
    return obj;
}

// ─── Loader ─────────────────────────────────────────────────────

/**
 * Load MCP server config from a `.mcp.json` file in a plugin directory.
 *
 * @param pluginDir - Path to the plugin directory (looks for `.mcp.json` at root).
 * @returns Record of server name → config. Empty record if no `.mcp.json` found.
 */
export function loadMcpConfig(pluginDir: string): Record<string, MCPServerConfig> {
    const absDir = path.resolve(pluginDir);
    const mcpPath = path.join(absDir, ".mcp.json");

    if (!fs.existsSync(mcpPath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(mcpPath, "utf-8");
        const parsed = JSON.parse(raw);

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            console.warn(`[mcp-loader] Invalid .mcp.json in ${absDir}: expected object`);
            return {};
        }

        // Expand env vars and validate each entry
        const result: Record<string, MCPServerConfig> = {};
        for (const [name, config] of Object.entries(parsed)) {
            if (typeof config !== "object" || config === null) {
                console.warn(`[mcp-loader] Skipping MCP server "${name}": invalid config`);
                continue;
            }
            const expanded = expandEnvDeep(config);
            // Stdio servers ship their code INSIDE the plugin/package dir and
            // reference it relatively ("./mcp-servers/x.js"), but the Copilot
            // CLI spawns them from ITS cwd — and for agent packages the
            // unpacked cache path varies per worker, so an author cannot
            // write an absolute cwd. Anchor relative worlds to the dir that
            // owns the .mcp.json: default a missing cwd to it, resolve a
            // relative cwd against it.
            if (typeof expanded?.command === "string") {
                if (!expanded.cwd) {
                    expanded.cwd = absDir;
                } else if (!path.isAbsolute(expanded.cwd)) {
                    expanded.cwd = path.resolve(absDir, expanded.cwd);
                }
            }
            result[name] = expanded;
        }

        return result;
    } catch (err: any) {
        console.warn(`[mcp-loader] Failed to parse .mcp.json in ${absDir}: ${err.message}`);
        return {};
    }
}

// ─── Repo-stored config (VS Code `.vscode/mcp.json`) ─────────────

/**
 * Expand `${env:VAR}` (VS Code variable syntax) references in a string from
 * process.env, plus `${workspaceFolder}` → the enlistment root. VS Code's
 * `${input:id}` prompts and `${command:id}` resolvers are interactive and have
 * no headless equivalent, so they are intentionally left untouched — a server
 * that still carries one after expansion is skipped by `loadRepoMcpConfig`
 * rather than shipping a literal placeholder (e.g. an unresolved auth header).
 */
function expandVscodeVars(value: string, workspaceFolder: string): string {
    return value
        .replace(/\$\{env:(\w+)\}/g, (_, name) => process.env[name] ?? "")
        .replace(/\$\{workspaceFolder\}/g, workspaceFolder);
}

/** Recursively expand VS Code variables in all string values of an object. */
function expandVscodeVarsDeep(obj: any, workspaceFolder: string): any {
    if (typeof obj === "string") return expandVscodeVars(obj, workspaceFolder);
    if (Array.isArray(obj)) return obj.map((v) => expandVscodeVarsDeep(v, workspaceFolder));
    if (obj && typeof obj === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = expandVscodeVarsDeep(value, workspaceFolder);
        }
        return result;
    }
    return obj;
}

export interface LoadRepoMcpOptions {
    /**
     * When true (default), only remote (http/sse) servers are loaded and stdio
     * servers are skipped. Repo stdio servers are authored to run on a developer
     * workstation (Windows paths, local toolchains) and will not spawn on a
     * repo-pinned Linux worker; the delegated-access scenario this feature
     * targets is inherently about remote servers. Set false to load stdio too.
     */
    remoteOnly?: boolean;
    /**
     * When set, only servers whose name is in this allowlist are loaded. Lets a
     * repo-pinned worker expose a curated subset of the servers a repo declares
     * for its developers (a repo `.vscode/mcp.json` may list a dozen), rather
     * than all of them. Empty/undefined = load all (subject to remoteOnly).
     */
    allow?: string[];
    /** Optional trace sink for per-server load decisions (defaults to no-op). */
    trace?: (message: string) => void;
}

/**
 * Load the MCP servers a repository declares for its own developers in
 * `<enlistmentDir>/.vscode/mcp.json` and translate them into Copilot
 * `MCPServerConfig` entries.
 *
 * A git-repo worker is pinned to ONE repository, so every session it runs is a
 * session "for that repo". Passing the result as the worker's direct
 * `mcpServers` config therefore grants the repo's declared servers to every
 * session on that worker — letting a customer talking to the repo's agent reach
 * the repo's MCP servers without attaching them per request. This is the
 * repo-stored half of delegated MCP access; per-user credential injection is
 * layered on separately.
 *
 * Format differences handled vs. the Copilot `.mcp.json` loader:
 *   - VS Code wraps entries under a top-level `servers` key (and may carry an
 *     `inputs` array); a flat top-level map is also accepted as a fallback.
 *   - Entries may omit `tools`; Copilot requires it, so a missing or empty list
 *     defaults to `["*"]` (all tools).
 *   - VS Code uses `${env:VAR}` / `${workspaceFolder}`; both are expanded here.
 *     A server still carrying an unresolved `${input:…}` / `${command:…}` after
 *     expansion is skipped rather than shipped with a literal placeholder.
 *
 * @param enlistmentDir - Repository working-tree root (contains `.vscode/`).
 * @returns Record of server name → config. Empty if no readable `mcp.json`.
 */
export function loadRepoMcpConfig(
    enlistmentDir: string,
    opts: LoadRepoMcpOptions = {},
): Record<string, MCPServerConfig> {
    const remoteOnly = opts.remoteOnly !== false;
    const allow = opts.allow && opts.allow.length > 0 ? new Set(opts.allow) : null;
    const trace = opts.trace ?? (() => {});
    const workspaceFolder = path.resolve(enlistmentDir);
    const mcpPath = path.join(workspaceFolder, ".vscode", "mcp.json");

    if (!fs.existsSync(mcpPath)) {
        return {};
    }

    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    } catch (err: any) {
        console.warn(`[mcp-loader] Failed to parse ${mcpPath}: ${err.message}`);
        return {};
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.warn(`[mcp-loader] Invalid ${mcpPath}: expected object`);
        return {};
    }

    // VS Code nests servers under `servers`; tolerate a flat map as a fallback.
    const servers =
        parsed.servers && typeof parsed.servers === "object" && !Array.isArray(parsed.servers)
            ? parsed.servers
            : parsed;

    const result: Record<string, MCPServerConfig> = {};
    for (const [name, config] of Object.entries(servers)) {
        if (typeof config !== "object" || config === null || Array.isArray(config)) {
            trace(`[mcp-loader] repo server "${name}": invalid config, skipped`);
            continue;
        }
        if (allow && !allow.has(name)) {
            trace(`[mcp-loader] repo server "${name}": not in allowlist, skipped`);
            continue;
        }
        const expanded = expandVscodeVarsDeep(config, workspaceFolder) as any;

        const isRemote =
            expanded.type === "http" ||
            expanded.type === "sse" ||
            (typeof expanded.url === "string" && !expanded.command);
        if (remoteOnly && !isRemote) {
            trace(`[mcp-loader] repo server "${name}": stdio server skipped (remoteOnly)`);
            continue;
        }

        // A leftover interactive placeholder means a value we cannot resolve
        // headlessly (a prompted secret / command). Shipping it verbatim would
        // send a literal "${input:…}" as an auth header; skip instead.
        if (/\$\{(?:input|command):/.test(JSON.stringify(expanded))) {
            trace(`[mcp-loader] repo server "${name}": unresolved \${input}/\${command} placeholder, skipped`);
            continue;
        }

        // Copilot requires a `tools` list; VS Code entries routinely omit it,
        // which means "all tools" — encode that as ["*"].
        if (!Array.isArray(expanded.tools) || expanded.tools.length === 0) {
            expanded.tools = ["*"];
        }

        // Anchor a relative stdio cwd to the enlistment (matches loadMcpConfig).
        if (!isRemote && typeof expanded.command === "string") {
            if (!expanded.cwd) {
                expanded.cwd = workspaceFolder;
            } else if (!path.isAbsolute(expanded.cwd)) {
                expanded.cwd = path.resolve(workspaceFolder, expanded.cwd);
            }
            if (!Array.isArray(expanded.args)) expanded.args = [];
        }

        result[name] = expanded as MCPServerConfig;
        trace(`[mcp-loader] repo server "${name}": loaded (${isRemote ? expanded.type ?? "http" : "stdio"})`);
    }

    return result;
}
