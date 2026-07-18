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

/** Capability tier declared in SKILL.md frontmatter (`tier:`). */
export type SkillTier = "base" | "default" | "extended" | "system";

export interface Skill {
    /** Skill name from YAML frontmatter (falls back to directory name). */
    name: string;
    /** Skill description from YAML frontmatter. */
    description: string;
    /** Markdown body (everything after the YAML frontmatter). */
    prompt: string;
    /** Tool names declared in tools.json (empty if no tools.json). */
    toolNames: string[];
    /** Skill group from frontmatter `group:` (undefined = "Other" in the picker). */
    group?: string;
    /** Capability tier from frontmatter `tier:` (undefined = "default"). */
    tier?: SkillTier;
    /** Absolute path to the skill directory. */
    dir: string;
}

const VALID_SKILL_TIERS = new Set(["base", "default", "extended", "system"]);

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
    const lines = yamlBlock.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        // Only treat top-level (non-indented) lines as keys, so block-scalar
        // continuation lines (indented, and possibly containing colons) are
        // never mistaken for keys.
        if (/^\s/.test(line)) continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        if (!key) continue;
        // YAML block scalar (| literal, > folded): fold the indented
        // continuation lines that follow into a single value. Without this a
        // `description: |` block was read as the literal "|".
        if (value === "|" || value === ">") {
            const folded = value === ">";
            const collected: string[] = [];
            while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
                collected.push(lines[++i].replace(/^\s{1,2}/, ""));
            }
            value = collected.join(folded ? " " : "\n").replace(/\s+$/g, "").trim();
        } else if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        meta[key] = value;
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
export function loadSkillsSync(skillsDir: string): Skill[] {
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

        const tier = VALID_SKILL_TIERS.has(meta.tier) ? (meta.tier as SkillTier) : undefined;
        skills.push({
            name: meta.name || entry.name,
            description: meta.description || "",
            prompt: body,
            toolNames,
            ...(meta.group ? { group: meta.group } : {}),
            ...(tier ? { tier } : {}),
            dir: skillDir,
        });
    }

    return skills;
}

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
    return loadSkillsSync(skillsDir);
}

export function composeDeclaredSkillsPrompt(
    agentPrompt: string,
    declaredSkillNames: string[] | undefined,
    skills: Skill[],
): { prompt: string; missing: string[] } {
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    const sections = [agentPrompt];
    const missing: string[] = [];
    for (const name of [...new Set(declaredSkillNames ?? [])]) {
        const skill = byName.get(name);
        if (!skill) {
            missing.push(name);
            continue;
        }
        sections.push(`[PRELOADED SKILL: ${name}]\n${skill.prompt}`);
    }
    return { prompt: sections.filter(Boolean).join("\n\n"), missing };
}
