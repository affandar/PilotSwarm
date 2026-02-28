/**
 * Skills loader — reads SKILL.md files with YAML frontmatter from disk.
 *
 * Skill directory structure:
 *   skills/<name>/
 *     SKILL.md        — Required. YAML frontmatter (name, description) + markdown body.
 *     tools.json       — Optional. { "tools": ["tool_name_1", ...] }
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────

export interface Skill {
    /** Skill name from YAML frontmatter (falls back to directory name). */
    name: string;
    /** Skill description from YAML frontmatter. */
    description: string;
    /** Markdown body (everything after the YAML frontmatter). */
    prompt: string;
    /** Tool names declared in tools.json (empty if no tools.json). */
    toolNames: string[];
    /** Absolute path to the skill directory. */
    dir: string;
}

// ─── Frontmatter Parser ─────────────────────────────────────────

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Expects `---` delimiters. Handles only simple `key: value` pairs.
 */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
    const meta: Record<string, string> = {};

    if (!content.startsWith("---")) {
        return { meta, body: content };
    }

    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) {
        return { meta, body: content };
    }

    const yamlBlock = content.slice(4, endIdx); // skip opening "---\n"
    for (const line of yamlBlock.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) meta[key] = value;
    }

    const body = content.slice(endIdx + 4).trimStart(); // skip closing "---\n"
    return { meta, body };
}

// ─── Loader ─────────────────────────────────────────────────────

/**
 * Load all skills from a directory. Each subdirectory containing a
 * SKILL.md file is treated as a skill.
 *
 * @param skillsDir - Path to the skills root directory.
 * @returns Array of loaded skills. Directories without SKILL.md are skipped.
 */
export async function loadSkills(skillsDir: string): Promise<Skill[]> {
    const absDir = path.resolve(skillsDir);

    if (!fs.existsSync(absDir)) {
        return [];
    }

    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    const skills: Skill[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(absDir, entry.name);
        const skillMdPath = path.join(skillDir, "SKILL.md");

        if (!fs.existsSync(skillMdPath)) continue;

        const content = fs.readFileSync(skillMdPath, "utf-8");
        const { meta, body } = parseFrontmatter(content);

        // Read optional tools.json
        let toolNames: string[] = [];
        const toolsJsonPath = path.join(skillDir, "tools.json");
        if (fs.existsSync(toolsJsonPath)) {
            try {
                const toolsData = JSON.parse(fs.readFileSync(toolsJsonPath, "utf-8"));
                if (Array.isArray(toolsData.tools)) {
                    toolNames = toolsData.tools;
                }
            } catch {
                // Skip malformed tools.json
            }
        }

        skills.push({
            name: meta.name || entry.name,
            description: meta.description || "",
            prompt: body,
            toolNames,
            dir: skillDir,
        });
    }

    return skills;
}
