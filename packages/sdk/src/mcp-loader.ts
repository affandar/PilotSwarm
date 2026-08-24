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
import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser";

// ─── JSONC parsing ───────────────────────────────────────────────

/**
 * Parse an MCP config file that may be JSONC rather than strict JSON.
 *
 * RATIONALE: VS Code's `.vscode/mcp.json` (and, by extension, the MCP configs
 * customers hand-author) is JSON-with-comments — the same format VS Code uses
 * for `settings.json`. Real repos routinely carry `//` line comments to
 * annotate or temporarily disable a server, and trailing commas after the last
 * entry. Strict `JSON.parse` throws on both, which previously caused the loader
 * to silently load ZERO servers for such a repo (the whole file is rejected on
 * the first comment), so delegated MCP appeared broken when the config was in
 * fact valid VS Code JSONC.
 *
 * We use `jsonc-parser` (the library VS Code itself uses) rather than stripping
 * comments with a regex: a naive stripper would corrupt the `//` inside server
 * URLs (e.g. `"https://mcp.example.net"`), whereas `jsonc-parser` is
 * string-aware and only treats line and block comments OUTSIDE of string
 * literals as comments. `allowTrailingComma` covers the other common JSONC
 * affordance.
 *
 * The parser is lenient (it recovers from errors and returns a best-effort
 * value); we collect its errors and treat any as a hard parse failure so a
 * genuinely broken file is still reported, not silently half-loaded.
 *
 * @returns the parsed value.
 * @throws if the content cannot be parsed as JSONC.
 */
function parseMcpJsonc(raw: string): unknown {
    const errors: ParseError[] = [];
    const value = parseJsonc(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
        const first = errors[0];
        throw new Error(
            `${printParseErrorCode(first.error)} at offset ${first.offset}` +
            (errors.length > 1 ? ` (+${errors.length - 1} more)` : ""),
        );
    }
    return value;
}

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
    /**
     * PilotSwarm-only deployment tag (not a Copilot SDK field): marks this
     * server as a BEST-EFFORT fleet default (see `loadDefaultMcpConfig`). When
     * the caller has no token for the server's discovered audience,
     * `resolveMcpServerAuth` SKIPS it instead of fast-failing the session.
     * Consumed and stripped during auth resolution, before the config reaches
     * the Copilot CLI.
     */
    optional?: boolean;
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
    /**
     * PilotSwarm-only deployment tag (not a Copilot SDK field): marks this
     * server as a BEST-EFFORT fleet default (see `loadDefaultMcpConfig`). When
     * the caller has no token for the server's discovered audience,
     * `resolveMcpServerAuth` SKIPS it instead of fast-failing the session.
     * Consumed and stripped during auth resolution, before the config reaches
     * the Copilot CLI.
     */
    optional?: boolean;
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
        const parsed = parseMcpJsonc(raw);

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
    /**
     * Private NuGet feed URLs the worker has credentialed via the user-level
     * `NuGet.Config` (`packageSourceCredentials`). A repo stdio server launched
     * through `dotnet dnx` commonly pins its feed with a `--source <URL>`
     * argument. .NET's tool-restore path treats
     * that command-line override as an isolated source and does NOT apply
     * `packageSourceCredentials`, so an authenticated feed still 401s and the
     * tool exposes zero MCP tools. For each URL listed here, a matching
     * `--source <URL>` / `--source=<URL>` (also `-s` / `--add-source`) pair is
     * stripped from a loaded stdio server's args so `dnx` falls back to the
     * credentialed config default source and authenticates. Empty/undefined =
     * no rewriting.
     */
    credentialedNuGetFeeds?: string[];
    /** Optional trace sink for per-server load decisions (defaults to no-op). */
    trace?: (message: string) => void;
}

/** Normalize a feed URL for tolerant matching (case- and trailing-slash-insensitive). */
function normalizeFeedUrl(url: string): string {
    return String(url).trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Remove `--source <URL>` argument pairs that point at a credentialed private
 * NuGet feed, so a `dnx`-launched stdio server authenticates via the worker's
 * user-level `NuGet.Config` instead of an uncredentialed command-line override.
 * Handles `--source URL` (two tokens), `--source=URL` (one token), and the
 * `-s` / `--add-source` aliases. Non-matching sources are left untouched.
 */
function stripCredentialedSourceArgs(
    args: string[],
    feeds: string[],
    serverName: string,
    trace: (message: string) => void,
): string[] {
    const feedSet = new Set(feeds.map(normalizeFeedUrl).filter(Boolean));
    if (feedSet.size === 0) return args;
    const flags = new Set(["--source", "-s", "--add-source"]);
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (typeof a === "string") {
            const eq = a.match(/^(--source|--add-source|-s)=(.+)$/);
            if (eq && feedSet.has(normalizeFeedUrl(eq[2]))) {
                trace(`[mcp-loader] repo server "${serverName}": stripped credentialed "${a}" (dnx uses config feed creds)`);
                continue;
            }
            if (
                flags.has(a) &&
                i + 1 < args.length &&
                typeof args[i + 1] === "string" &&
                feedSet.has(normalizeFeedUrl(args[i + 1]))
            ) {
                trace(`[mcp-loader] repo server "${serverName}": stripped credentialed "${a} ${args[i + 1]}" (dnx uses config feed creds)`);
                i++;
                continue;
            }
        }
        out.push(a);
    }
    return out;
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
 *   - The file is parsed as JSONC (VS Code's format): line and block
 *     comments and trailing commas are tolerated. See `parseMcpJsonc`.
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
        parsed = parseMcpJsonc(fs.readFileSync(mcpPath, "utf-8"));
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
            if (opts.credentialedNuGetFeeds && opts.credentialedNuGetFeeds.length > 0) {
                expanded.args = stripCredentialedSourceArgs(
                    expanded.args,
                    opts.credentialedNuGetFeeds,
                    name,
                    trace,
                );
            }
        }

        result[name] = expanded as MCPServerConfig;
        trace(`[mcp-loader] repo server "${name}": loaded (${isRemote ? expanded.type ?? "http" : "stdio"})`);
    }

    return result;
}

// ─── Fleet-default config (deploy-time `DEFAULT_MCP_JSON`) ────────

/**
 * Expand `${env:VAR}` (VS Code variable syntax) and bare `${VAR}` references in
 * a string from process.env. A fleet default has no enlistment, so there is no
 * `${workspaceFolder}` to resolve.
 */
function expandDefaultVars(value: string): string {
    return value
        .replace(/\$\{env:(\w+)\}/g, (_, name) => process.env[name] ?? "")
        .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

/** Recursively expand `${env:VAR}`/`${VAR}` in all string values of an object. */
function expandDefaultVarsDeep(obj: any): any {
    if (typeof obj === "string") return expandDefaultVars(obj);
    if (Array.isArray(obj)) return obj.map(expandDefaultVarsDeep);
    if (obj && typeof obj === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = expandDefaultVarsDeep(value);
        }
        return result;
    }
    return obj;
}

export interface LoadDefaultMcpOptions {
    /** Optional trace sink for per-server load decisions (defaults to no-op). */
    trace?: (message: string) => void;
}

/**
 * Load the fleet-default MCP servers a worker injects into EVERY session,
 * independent of the target repo's `.vscode/mcp.json`, from an inline JSONC
 * value (the `DEFAULT_MCP_JSON` deploy token). This is the third MCP source
 * (after the plugin catalog and repo-declared servers): a deploy-time,
 * fleet-level set of REMOTE servers — canonically the Azure DevOps MCP — so a
 * session can reach ADO even when the repo never declared an `ado` server.
 *
 * Differences vs. `loadRepoMcpConfig`:
 *   - Source is an inline string (env/ConfigMap value), not a file on disk.
 *   - `remoteOnly` is FORCED true: a fleet default runs on a Linux worker pod,
 *     so a local stdio server would never spawn — it is a config error.
 *   - Every loaded server is marked `optional: true` so `resolveMcpServerAuth`
 *     SKIPS it (rather than fast-failing the session) when the caller has no
 *     token for its discovered audience. A default is injected without the
 *     caller asking, so a session that never intended to use it must still run.
 *   - `${env:VAR}` / `${VAR}` are expanded; there is no `${workspaceFolder}`.
 *
 * The `{ servers }` wrapper (VS Code shape) or a flat top-level map are both
 * accepted. Missing/empty `tools` defaults to `["*"]`. A server still carrying
 * an unresolved `${input:…}`/`${command:…}` placeholder is skipped.
 *
 * @param raw - The inline JSONC value, or undefined/empty (returns `{}`).
 * @returns Record of server name → config (each tagged `optional: true`).
 */
export function loadDefaultMcpConfig(
    raw: string | undefined | null,
    opts: LoadDefaultMcpOptions = {},
): Record<string, MCPServerConfig> {
    const trace = opts.trace ?? (() => {});
    if (typeof raw !== "string" || raw.trim().length === 0) {
        return {};
    }

    let parsed: any;
    try {
        parsed = parseMcpJsonc(raw);
    } catch (err: any) {
        console.warn(`[mcp-loader] Failed to parse DEFAULT_MCP_JSON: ${err.message}`);
        return {};
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.warn(`[mcp-loader] Invalid DEFAULT_MCP_JSON: expected object`);
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
            trace(`[mcp-loader] default server "${name}": invalid config, skipped`);
            continue;
        }
        const expanded = expandDefaultVarsDeep(config) as any;

        const isRemote =
            expanded.type === "http" ||
            expanded.type === "sse" ||
            (typeof expanded.url === "string" && !expanded.command);
        // Fleet defaults are always remote — a stdio default cannot run on the
        // worker pod, so drop it loudly rather than ship a server that can never
        // start.
        if (!isRemote) {
            trace(`[mcp-loader] default server "${name}": stdio server skipped (fleet defaults are remote-only)`);
            continue;
        }

        // A leftover interactive placeholder means a value we cannot resolve
        // headlessly (a prompted secret / command). Skip rather than ship a
        // literal "${input:…}" as an auth header.
        if (/\$\{(?:input|command):/.test(JSON.stringify(expanded))) {
            trace(`[mcp-loader] default server "${name}": unresolved \${input}/\${command} placeholder, skipped`);
            continue;
        }

        // Copilot requires a `tools` list; a missing/empty list means "all".
        if (!Array.isArray(expanded.tools) || expanded.tools.length === 0) {
            expanded.tools = ["*"];
        }

        // Best-effort: a caller lacking a token for this server's audience must
        // not fast-fail the whole session (they never asked for it).
        expanded.optional = true;

        result[name] = expanded as MCPServerConfig;
        trace(`[mcp-loader] default server "${name}": loaded (${expanded.type ?? "http"}, optional)`);
    }

    return result;
}
