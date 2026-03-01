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

// ─── Types ───────────────────────────────────────────────────────

export interface AgentConfig {
    name: string;
    description?: string;
    prompt: string;
    tools?: string[] | null;
}

// ─── Frontmatter Parser ─────────────────────────────────────────

/**
 * Parse YAML frontmatter from an .agent.md file.
 * Handles simple `key: value` pairs and YAML list syntax for `tools`.
 */
function parseAgentFrontmatter(content: string): {
    meta: { name?: string; description?: string; tools?: string[] };
    body: string;
} {
    const meta: { name?: string; description?: string; tools?: string[] } = {};

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

    for (const line of lines) {
        const trimmed = line.trim();

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
        else if (key === "tools" && value) {
            // Inline array: tools: [view, grep]
            meta.tools = value.replace(/[\[\]]/g, "").split(",").map(s => s.trim()).filter(Boolean);
        } else if (key === "tools" && !value) {
            // Will be followed by list items
            meta.tools = [];
        }
    }

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

            agents.push({
                name: meta.name,
                description: meta.description,
                prompt: body,
                tools: meta.tools && meta.tools.length > 0 ? meta.tools : null,
            });
        } catch (err: any) {
            console.warn(`[agent-loader] Failed to parse ${entry.name}: ${err.message}`);
        }
    }

    return agents;
}
