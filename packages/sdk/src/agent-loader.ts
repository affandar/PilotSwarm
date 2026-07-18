/**
 * Agent loader — reads .agent.md files with YAML frontmatter from disk.
 *
 * Agent file format (standard Copilot .agent.md):
 *   ---
 *   name: planner
 *   description: Creates structured plans for complex tasks.
 *   tools:
 *     - view
 *     - grep
 *   ---
 *
 *   # Planner Agent
 *   You are a planning agent...
 *
 * The YAML frontmatter becomes CustomAgentConfig fields (name, description, tools).
 * The markdown body becomes the agent's `prompt`.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ─── System Agent UUID ──────────────────────────────────────────

/**
 * Derive a deterministic UUID from a system agent ID slug.
 * All workers and clients produce the same UUID for the same slug.
 */
export function systemAgentUUID(slug: string): string {
    const hash = crypto.createHash("sha256")
        .update("pilotswarm-system-agent:")
        .update(slug)
        .digest("hex");
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        hash.slice(12, 16),
        hash.slice(16, 20),
        hash.slice(20, 32),
    ].join("-");
}

/**
 * Derive a deterministic UUID for a system child agent from its parent session
 * and child slug. This keeps system children like sweeper/resource manager
 * stable across restarts while avoiding collisions between different parents.
 */
export function systemChildAgentUUID(parentSessionId: string, slug: string): string {
    const hash = crypto.createHash("sha256")
        .update("pilotswarm-system-child-agent:")
        .update(parentSessionId)
        .update(":")
        .update(slug)
        .digest("hex");
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        hash.slice(12, 16),
        hash.slice(16, 20),
        hash.slice(20, 32),
    ].join("-");
}

// ─── Types ───────────────────────────────────────────────────────

export interface AgentConfig {
    name: string;
    description?: string;
    prompt: string;
    tools?: string[] | null;
    /** Skill names to preload from the session's configured skill directories. */
    skills?: string[];
    /**
     * Named references to deployment-catalog MCP servers (entries in the
     * merged `.mcp.json` map) this agent's sessions should receive. Inline
     * server definitions are not accepted in frontmatter — define the server
     * in the plugin's `.mcp.json` (which puts it in the catalog) and
     * reference it here by name. Declared refs that miss the catalog are
     * dropped with a warning at load time. Agents using this field should
     * declare `schemaVersion: 2` so older loaders skip the file instead of
     * silently dropping its MCP servers.
     */
    mcpServers?: string[];
    /**
     * When true, the agent also receives the deployment's default MCP set
     * (catalog servers tagged `"default": true` in `.mcp.json`). Defaults to
     * false — an agent gets no MCP servers unless it declares or inherits
     * them.
     */
    inheritDefaultMcpServers?: boolean;
    /**
     * Restriction: when present, sessions bound to this agent may load ONLY
     * these SKILL.md skills from the deployment catalog (mapped to the CLI
     * as disabledSkills = catalog − allowedSkills; the complement is
     * recomputed against the live skill directories at session assembly so
     * skills added after worker boot stay governed). Absent means all
     * catalog skills — today's behavior. Distinct from `skills:`, which
     * eagerly preloads skill bodies into the agent prompt. A
     * schemaVersion-2 shape.
     *
     * Limitation: the Copilot CLI's own BUILTIN skills are outside the
     * deployment catalog and are not governed by this restriction.
     */
    allowedSkills?: string[];
    /**
     * Restriction on the agent's tool surface, mapped onto the CLI's
     * availableTools / excludedTools. `deny` removes the named tools;
     * `allow` switches to allow-list mode (everything not named is denied).
     * Composes with the built-in floor (e.g. the excluded native `task`
     * tool and identity gates): a policy can further restrict but never
     * widen past the floor. A schemaVersion-2 shape.
     */
    toolPolicy?: { allow?: string[]; deny?: string[] };
    /** If true, this is a system agent started automatically by workers. */
    system?: boolean;
    /** Deterministic ID slug for system agents (e.g. "sweeper"). Used to derive a fixed session UUID. */
    id?: string;
    /** Display title for the session list (e.g. "Resource Manager Agent"). Falls back to capitalized name + " Agent". */
    title?: string;
    /** Parent system agent ID slug (e.g. "pilotswarm"). Makes this a sub-agent of the parent. */
    parent?: string;
    /** Splash banner (terminal markup) shown in the TUI when the session is selected. */
    splash?: string;
    /** Narrow-viewport splash variant, swapped in when the main splash art is wider than the pane (mobile portal, narrow terminals). */
    splashMobile?: string;
    /** Initial prompt to send when the system agent is first created. */
    initialPrompt?: string;
    /** Source plugin namespace (e.g. "pilotswarm", "smelter"). Set by the worker during plugin loading. */
    namespace?: string;
    /** Internal: identifies which prompt layering path this agent should use. */
    promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent";
    /**
     * App-assigned CRAWLER role. When `true`, a session bound to this agent
     * receives the privileged crawl queue when a graph store is configured.
     * Graph extraction/fill is app-specific, so the app sets `crawler: true` in
     * its own crawler agent's frontmatter. The role is derived from this
     * definition on the worker every turn — never inherited from a parent
     * session.
     */
    crawler?: boolean;
    /** @deprecated Use `crawler: true`; accepted as a compatibility alias. */
    harvester?: boolean;
    /**
     * Frontmatter schema version. Defaults to 1 when the file omits it. Higher integers
     * indicate forward-incompatible frontmatter shapes the loader may reject in the future.
     */
    schemaVersion?: number;
    /**
     * Author-supplied version label for this agent definition. PilotSwarm-authored system
     * agents use SemVer; app authors may use any meaningful non-empty string.
     */
    version?: string;
    /** Absolute path the agent was loaded from, when known. Used for diagnostics. */
    sourcePath?: string;
}

// ─── Frontmatter Parser ─────────────────────────────────────────

/**
 * Parse YAML frontmatter from an .agent.md file.
 * Handles simple `key: value` pairs and YAML list syntax for `tools` and `skills`.
 */
interface ParsedAgentMeta {
    name?: string;
    description?: string;
    tools?: string[];
    skills?: string[];
    mcpServers?: string[];
    inheritDefaultMcpServers?: boolean;
    allowedSkills?: string[];
    toolPolicy?: { allow?: string[]; deny?: string[] };
    system?: boolean;
    id?: string;
    title?: string;
    parent?: string;
    splash?: string;
    splashMobile?: string;
    initialPrompt?: string;
    crawler?: boolean;
    harvester?: boolean;
    schemaVersion?: number;
    version?: string;
}

function stripSurroundingQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
        return value.slice(1, -1);
    }
    return value;
}

function parseInlineList(value: string): string[] {
    return value.replace(/[\[\]]/g, "")
        .split(",")
        .map((s) => stripSurroundingQuotes(s.trim()))
        .filter(Boolean);
}

/**
 * Parse the YAML flow-map spelling `{ allow: [a, b], deny: [c] }` for
 * toolPolicy. Returns null when the value is not a recognizable flow map —
 * callers must warn loudly rather than silently dropping a RESTRICTION.
 */
function parseToolPolicyFlowMap(value: string): { allow?: string[]; deny?: string[] } | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    const inner = trimmed.slice(1, -1);
    const result: { allow?: string[]; deny?: string[] } = {};
    const re = /(allow|deny)\s*:\s*\[([^\]]*)\]/g;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = re.exec(inner)) !== null) {
        found = true;
        result[match[1] as "allow" | "deny"] = match[2]
            .split(",")
            .map((s) => stripSurroundingQuotes(s.trim()))
            .filter(Boolean);
    }
    return found ? result : null;
}

function parseAgentFrontmatter(content: string): {
    meta: ParsedAgentMeta;
    body: string;
} {
    const meta: ParsedAgentMeta = {};

    if (!content.startsWith("---")) {
        return { meta, body: content };
    }

    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) {
        return { meta, body: content };
    }

    const yamlBlock = content.slice(4, endIdx); // skip opening "---\n"
    const lines = yamlBlock.split("\n");
    let currentKey: string | null = null;
    let multilineValue: string[] | null = null;
    let currentBlockStyle: string | null = null;

    const flushMultiline = () => {
        if (multilineValue !== null && currentKey) {
            const val = multilineValue.join("\n").trimEnd();
            if (currentKey === "splash") meta.splash = val;
            else if (currentKey === "splashMobile") meta.splashMobile = val;
            else if (currentKey === "initialPrompt") {
                // For > (folded) scalars, collapse newlines to spaces
                meta.initialPrompt = currentBlockStyle === ">" ? val.replace(/\n/g, " ").trim() : val;
            }
            multilineValue = null;
            currentBlockStyle = null;
        }
    };

    // Tracks whether we are inside a `toolPolicy:` nested block: its
    // indented `allow:` / `deny:` sub-keys are the only two-level shape the
    // parser supports. Any non-indented key exits the block.
    let inToolPolicy = false;

    const LIST_KEYS = new Set(["tools", "skills", "mcpServers", "allowedSkills", "toolPolicy.allow", "toolPolicy.deny"]);

    for (const line of lines) {
        const trimmed = line.trim();

        // Collecting multiline block scalar value (YAML | syntax)
        if (multilineValue !== null) {
            // A new top-level key ends the block
            if (/^[a-zA-Z]/.test(line) && line.includes(":")) {
                flushMultiline();
                // fall through to key-value parsing below
            } else {
                // Strip 2-space indent if present, preserve content
                multilineValue.push(line.startsWith("  ") ? line.slice(2) : line);
                continue;
            }
        }

        // YAML comment — never a key or a list item. Skipped before the
        // key-value branch so a comment containing a colon cannot clobber
        // currentKey and orphan the list items that follow it. (Comments
        // inside splash/initialPrompt block scalars are preserved above.)
        if (trimmed.startsWith("#")) continue;

        // YAML list item (e.g. "  - view")
        if (trimmed.startsWith("- ") && currentKey && LIST_KEYS.has(currentKey)) {
            const item = stripSurroundingQuotes(trimmed.slice(2).trim());
            if (currentKey === "tools") {
                (meta.tools ??= []).push(item);
            } else if (currentKey === "skills") {
                (meta.skills ??= []).push(item);
            } else if (currentKey === "mcpServers") {
                (meta.mcpServers ??= []).push(item);
            } else if (currentKey === "allowedSkills") {
                (meta.allowedSkills ??= []).push(item);
            } else if (currentKey === "toolPolicy.allow") {
                ((meta.toolPolicy ??= {}).allow ??= []).push(item);
            } else if (currentKey === "toolPolicy.deny") {
                ((meta.toolPolicy ??= {}).deny ??= []).push(item);
            }
            continue;
        }

        // Key-value pair
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;

        const indented = /^\s/.test(line);
        if (inToolPolicy && !indented) inToolPolicy = false;

        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();

        // Strip surrounding quotes; for UNQUOTED scalars strip trailing YAML
        // comments (a bare `#...` value IS a comment; " #" ends the scalar).
        // Without this, `toolPolicy: # restrict` reads as a non-empty value
        // and the whole nested restriction silently fails OPEN.
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        } else if (value.startsWith("#")) {
            value = "";
        } else {
            const commentIdx = value.search(/\s#/);
            if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
        }

        // An indented allow:/deny: OUTSIDE a toolPolicy block means the
        // block entry failed to parse — never silently ignore a restriction.
        if (!inToolPolicy && indented && (key === "allow" || key === "deny")) {
            console.warn(`[agent-loader] Indented "${key}:" found outside a toolPolicy block — the restriction was NOT applied. Check the toolPolicy line's formatting.`);
        }

        // toolPolicy sub-keys (indented allow:/deny: inside the block)
        if (inToolPolicy && indented && (key === "allow" || key === "deny")) {
            if (value) {
                (meta.toolPolicy ??= {})[key] = parseInlineList(value);
                currentKey = null;
            } else {
                (meta.toolPolicy ??= {})[key] = [];
                currentKey = `toolPolicy.${key}`;
            }
            continue;
        }

        currentKey = key;

        if (key === "name") meta.name = value;
        else if (key === "description") meta.description = value;
        else if (key === "system") meta.system = value === "true";
        else if (key === "crawler") meta.crawler = value === "true";
        else if (key === "harvester") meta.harvester = value === "true";
        else if (key === "id") meta.id = value;
        else if (key === "title") meta.title = value;
        else if (key === "parent") meta.parent = value;
        else if (key === "schemaVersion") {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) meta.schemaVersion = Math.floor(n);
        }
        else if (key === "version") meta.version = value;
        else if (key === "tools" && value) {
            // Inline array: tools: [view, grep]
            meta.tools = value.replace(/[\[\]]/g, "").split(",").map(s => s.trim()).filter(Boolean);
        } else if (key === "tools" && !value) {
            // Will be followed by list items
            meta.tools = [];
        } else if (key === "skills" && value) {
            meta.skills = value.replace(/[\[\]]/g, "").split(",").map(s => s.trim()).filter(Boolean);
        } else if (key === "skills" && !value) {
            meta.skills = [];
        } else if (key === "mcpServers" && value) {
            // Inline array: mcpServers: [github, jira]
            meta.mcpServers = parseInlineList(value);
        } else if (key === "mcpServers" && !value) {
            meta.mcpServers = [];
        } else if (key === "inheritDefaultMcpServers") {
            meta.inheritDefaultMcpServers = value === "true";
        } else if (key === "allowedSkills" && value) {
            meta.allowedSkills = parseInlineList(value);
        } else if (key === "allowedSkills" && !value) {
            meta.allowedSkills = [];
        } else if (key === "toolPolicy" && value) {
            // Inline flow-map spelling: toolPolicy: { allow: [a], deny: [b] }
            const flowPolicy = parseToolPolicyFlowMap(value);
            if (flowPolicy) {
                meta.toolPolicy = flowPolicy;
            } else {
                console.warn(`[agent-loader] Unrecognized inline toolPolicy value ${JSON.stringify(value)} — the restriction was NOT applied. Use the nested block form or { allow: [...], deny: [...] }.`);
            }
            currentKey = null;
        } else if (key === "toolPolicy" && !value) {
            inToolPolicy = true;
            currentKey = null;
        } else if ((key === "splash" || key === "splashMobile" || key === "initialPrompt") && (value === "|" || value === ">")) {
            // YAML block scalar (| literal, > folded)
            currentBlockStyle = value;
            multilineValue = [];
        } else if (key === "splash") {
            meta.splash = value;
        } else if (key === "splashMobile") {
            meta.splashMobile = value;
        } else if (key === "initialPrompt") {
            meta.initialPrompt = value;
        }
    }

    flushMultiline();

    const body = content.slice(endIdx + 4).trimStart(); // skip closing "---\n"
    return { meta, body };
}

// ─── Loader ─────────────────────────────────────────────────────

/**
 * Load all .agent.md files from a directory and convert to CustomAgentConfig[].
 *
 * @param agentsDir - Path to the agents directory.
 * @returns Array of agent configs. Files that fail to parse are skipped with a warning.
 */
export function loadAgentFiles(agentsDir: string): AgentConfig[] {
    const absDir = path.resolve(agentsDir);

    if (!fs.existsSync(absDir)) {
        return [];
    }

    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    const agents: AgentConfig[] = [];

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".agent.md")) continue;

        const filePath = path.join(absDir, entry.name);

        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const { meta, body } = parseAgentFrontmatter(content);

            if (!meta.name) {
                // Derive name from filename: planner.agent.md → planner
                meta.name = entry.name.replace(/\.agent\.md$/, "");
            }

            if (!body.trim()) {
                console.warn(`[agent-loader] Skipping ${entry.name}: empty prompt body`);
                continue;
            }

            if (meta.schemaVersion !== undefined && meta.schemaVersion !== 1 && meta.schemaVersion !== 2) {
                console.warn(`[agent-loader] Skipping ${entry.name}: unsupported schemaVersion ${meta.schemaVersion}; expected schemaVersion 1 or 2`);
                continue;
            }

            // Capability frontmatter (MCP servers, allowedSkills, toolPolicy)
            // is a schemaVersion-2 shape: version-1 loaders load the file but
            // silently drop these fields, which for a capability-dependent
            // agent is worse than not loading at all.
            // (`inheritDefaultMcpServers: false` is inert everywhere, so it
            // does not trigger this.)
            const hasCapabilityFrontmatter = Boolean(
                meta.mcpServers?.length
                || meta.inheritDefaultMcpServers === true
                || meta.allowedSkills !== undefined
                || meta.toolPolicy !== undefined,
            );
            if (hasCapabilityFrontmatter && (meta.schemaVersion ?? 1) < 2) {
                console.warn(`[agent-loader] ${entry.name}: declares capability frontmatter (mcpServers/allowedSkills/toolPolicy) but schemaVersion ${meta.schemaVersion ?? 1}; declare 'schemaVersion: 2' so older loaders skip this agent instead of silently dropping its capability configuration.`);
            }

            const crawler = meta.crawler === true || meta.harvester === true;
            agents.push({
                name: meta.name,
                description: meta.description,
                prompt: body,
                tools: meta.tools && meta.tools.length > 0 ? meta.tools : null,
                skills: meta.skills && meta.skills.length > 0 ? meta.skills : undefined,
                mcpServers: meta.mcpServers && meta.mcpServers.length > 0 ? meta.mcpServers : undefined,
                inheritDefaultMcpServers: meta.inheritDefaultMcpServers,
                // An explicitly empty allowedSkills is a valid "no skills"
                // restriction, so undefined-ness (not length) gates it —
                // and likewise an explicitly empty toolPolicy.allow is a
                // valid "floor tools only" restriction.
                allowedSkills: meta.allowedSkills,
                toolPolicy: meta.toolPolicy && (meta.toolPolicy.allow !== undefined || meta.toolPolicy.deny?.length)
                    ? meta.toolPolicy
                    : undefined,
                system: meta.system,
                id: meta.id,
                title: meta.title,
                parent: meta.parent,
                splash: meta.splash,
                splashMobile: meta.splashMobile,
                initialPrompt: meta.initialPrompt,
                crawler,
                harvester: crawler,
                schemaVersion: meta.schemaVersion,
                version: meta.version,
                sourcePath: filePath,
            });
            if (meta.schemaVersion === undefined) {
                console.warn(`[agent-loader] ${entry.name}: missing frontmatter 'schemaVersion'. Defaulting to 1; add 'schemaVersion: 1' to silence this warning.`);
            }
            if (!meta.version) {
                console.warn(`[agent-loader] ${entry.name}: missing frontmatter 'version'. Add 'version: x.y.z' (or any non-empty label) to track agent prompt changes.`);
            }
        } catch (err: any) {
            console.warn(`[agent-loader] Failed to parse ${entry.name}: ${err.message}`);
        }
    }

    return agents;
}
