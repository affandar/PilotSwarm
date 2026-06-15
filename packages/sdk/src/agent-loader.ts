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
    /** Initial prompt to send when the system agent is first created. */
    initialPrompt?: string;
    /** Source plugin namespace (e.g. "pilotswarm", "smelter"). Set by the worker during plugin loading. */
    namespace?: string;
    /** Internal: identifies which prompt layering path this agent should use. */
    promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent";
    /**
     * App-assigned HARVESTER role (enhancedfactstore 07 §1.5). When `true`, a
     * session bound to this agent receives the privileged crawl-queue +
     * graph write/delete tools (only when a graph store is configured) and is
     * the active graph crawler. Graph extraction is app-specific, so the app
     * sets `harvester: true` in its own harvester agent's frontmatter. The
     * role is derived from this definition on the worker every turn — never
     * inherited from a parent session.
     */
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
 * Handles simple `key: value` pairs and YAML list syntax for `tools`.
 */
function parseAgentFrontmatter(content: string): {
    meta: { name?: string; description?: string; tools?: string[]; system?: boolean; id?: string; title?: string; parent?: string; splash?: string; initialPrompt?: string; harvester?: boolean; schemaVersion?: number; version?: string };
    body: string;
} {
    const meta: { name?: string; description?: string; tools?: string[]; system?: boolean; id?: string; title?: string; parent?: string; splash?: string; initialPrompt?: string; harvester?: boolean; schemaVersion?: number; version?: string } = {};

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
            else if (currentKey === "initialPrompt") {
                // For > (folded) scalars, collapse newlines to spaces
                meta.initialPrompt = currentBlockStyle === ">" ? val.replace(/\n/g, " ").trim() : val;
            }
            multilineValue = null;
            currentBlockStyle = null;
        }
    };

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

        // YAML list item (e.g. "  - view")
        if (trimmed.startsWith("- ") && currentKey === "tools") {
            if (!meta.tools) meta.tools = [];
            meta.tools.push(trimmed.slice(2).trim());
            continue;
        }

        // Key-value pair
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();

        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        currentKey = key;

        if (key === "name") meta.name = value;
        else if (key === "description") meta.description = value;
        else if (key === "system") meta.system = value === "true";
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
        } else if ((key === "splash" || key === "initialPrompt") && (value === "|" || value === ">")) {
            // YAML block scalar (| literal, > folded)
            currentBlockStyle = value;
            multilineValue = [];
        } else if (key === "splash") {
            meta.splash = value;
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

            if (meta.schemaVersion !== undefined && meta.schemaVersion !== 1) {
                console.warn(`[agent-loader] Skipping ${entry.name}: unsupported schemaVersion ${meta.schemaVersion}; expected schemaVersion: 1`);
                continue;
            }

            agents.push({
                name: meta.name,
                description: meta.description,
                prompt: body,
                tools: meta.tools && meta.tools.length > 0 ? meta.tools : null,
                system: meta.system,
                id: meta.id,
                title: meta.title,
                parent: meta.parent,
                splash: meta.splash,
                initialPrompt: meta.initialPrompt,
                harvester: meta.harvester,
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
