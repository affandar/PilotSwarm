#!/usr/bin/env node
/**
 * Turn a disk SKILL.md into a discoverable shared fact.
 *
 * Why this exists: a skill in a plugin's skills directory only reaches a prompt when an
 * agent declares it in `skills:` — and then its WHOLE body is inlined into
 * every turn of every session on that agent. There is no runtime discovery
 * path for disk skills.
 *
 * The shared `skills/*` namespace is the path that IS discoverable. On
 * enhanced deployments the agent calls search_skills with a task-derived
 * query, gets a ranked hint, and loads the body with read_facts only when it
 * is relevant. On base deployments the capped skills push advertises the
 * name + description the same way.
 *
 * Usage:
 *   node scripts/publish-skill-as-fact.mjs \
 *     packages/sdk/plugins/system/skills/canvas-apps/SKILL.md \
 *     --key skills/canvas/apps [--dry-run]
 *
 * Reads DATABASE_URL (and PILOTSWARM_FACTS_SCHEMA, default pilotswarm_facts).
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const keyArg = args[args.indexOf("--key") + 1];
const dryRun = args.includes("--dry-run");

if (!file || !fs.existsSync(file)) {
    console.error("usage: publish-skill-as-fact.mjs <path/to/SKILL.md> --key skills/<topic>/<sub> [--dry-run]");
    process.exit(1);
}

const raw = fs.readFileSync(file, "utf8");
if (!raw.startsWith("---")) {
    console.error(`${file}: no YAML frontmatter`);
    process.exit(1);
}
const end = raw.indexOf("\n---", 3);
if (end === -1) {
    console.error(`${file}: frontmatter is never closed`);
    process.exit(1);
}
const meta = {};
for (const line of raw.slice(4, end).split("\n")) {
    const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim();
}
const instructions = raw.slice(end + 4).replace(/^\n+/, "");

const name = meta.name || path.basename(path.dirname(file));
const key = keyArg && !keyArg.startsWith("--") ? keyArg : `skills/${name}`;

if (!meta.description) {
    console.error(`${file}: frontmatter has no description — that IS the ranking text, it cannot be empty`);
    process.exit(1);
}

const value = {
    name,
    description: meta.description,
    instructions,
    tools: [],
    confidence: "high",
    version: 1,
    source: `repo:${file}`,
    last_reviewed: new Date().toISOString().slice(0, 10),
};

console.log(`key:          ${key}`);
console.log(`name:         ${name}`);
console.log(`description:  ${meta.description.length} chars`);
console.log(`instructions: ${instructions.length} chars (~${Math.round(instructions.length / 4)} tokens)`);

if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
    console.error("\nDATABASE_URL is not set.");
    process.exit(1);
}
const schema = process.env.PILOTSWARM_FACTS_SCHEMA || "pilotswarm_facts";

const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
    await client.query(
        `INSERT INTO ${schema}.facts (scope_key, key, value, shared, transient, tags)
         VALUES ($1, $2, $3::jsonb, TRUE, FALSE, ARRAY['skill','canvas'])
         ON CONFLICT (scope_key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now(), deleted_at = NULL`,
        [`shared:${key}`, key, JSON.stringify(value)],
    );
    console.log(`\npublished shared:${key}`);
} finally {
    await client.end();
}
