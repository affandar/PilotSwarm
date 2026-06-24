#!/usr/bin/env node

/**
 * Horizon Harvester — Knowledge Graph → Markdown/Mermaid exporter
 *
 * Reads the harvested knowledge graph (Apache AGE) and writes a Markdown file
 * containing a summary table plus a Mermaid `graph` diagram of every entity and
 * relationship. This is the file-artifact form of the `graph-debug` skill: the
 * skill renders Mermaid inline in an agent reply; this script writes a standalone
 * `.md` you can open, commit, or paste into a PR / wiki.
 *
 * The sample graph is small (≈10 nodes / 13 edges), so this renders the WHOLE
 * graph. For a large production graph you would bound the export (one seed,
 * depth ≤ 2, or a single kind) — see the graph-debug skill.
 *
 * Connection: HORIZON_GRAPH_DATABASE_URL (falls back to HORIZON_DATABASE_URL).
 * Graph name: HORIZON_GRAPH_SCHEMA (default "horizon_graph").
 * Output:     first CLI arg, else HARVESTER_GRAPH_MD env, else <sample>/graph.md
 *
 * Usage:
 *   node --env-file=../../.env scripts/graph-to-mermaid.mjs [output.md]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const SAMPLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const graphUrl = process.env.HORIZON_GRAPH_DATABASE_URL || process.env.HORIZON_DATABASE_URL;
if (!graphUrl) {
    console.error("HORIZON_GRAPH_DATABASE_URL (or HORIZON_DATABASE_URL) is required.");
    process.exit(1);
}

const graphName = process.env.HORIZON_GRAPH_SCHEMA || "horizon_graph";
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(graphName)) {
    console.error(`Unsafe graph name: ${JSON.stringify(graphName)}`);
    process.exit(1);
}

const outPath = path.resolve(process.argv[2] || process.env.HARVESTER_GRAPH_MD || path.join(SAMPLE_DIR, "graph.md"));

/** Build a pg Client from a connection string, honoring sslmode (HorizonDB TLS). */
function pgClient(connStr) {
    const url = new URL(connStr);
    const ssl = ["require", "prefer", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "");
    url.searchParams.delete("sslmode");
    return new Client({
        connectionString: url.toString(),
        ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
}

/** Parse a scalar agtype column value (strip ::type suffix, JSON.parse). */
function ag(v) {
    if (v == null || typeof v !== "string") return v;
    const stripped = v.replace(/::[a-z]+$/i, "");
    try { return JSON.parse(stripped); } catch { return stripped; }
}

/** Run one Cypher query through AGE's cypher() table function. */
async function cy(client, query, cols) {
    const defs = cols.map((c) => `${c} agtype`).join(", ");
    const sql = `SELECT * FROM cypher('${graphName}', $$ ${query} $$) AS (${defs})`;
    const { rows } = await client.query(sql);
    return rows.map((r) => Object.fromEntries(cols.map((c) => [c, ag(r[c])])));
}

// Mermaid helpers: ids must be [A-Za-z0-9_]; labels quoted (escape inner quotes).
const mid = (key) => "n_" + String(key).replace(/[^A-Za-z0-9_]/g, "_");
const esc = (s) => String(s ?? "").replace(/"/g, "'");
const edgeLabel = (s) => String(s ?? "").replace(/[|\r\n]+/g, " ").trim();

// Stable color classes per kind (extend as new kinds appear).
const KIND_STYLES = {
    service: "fill:#dbeafe,stroke:#1e40af,color:#1e3a8a",
    team: "fill:#dcfce7,stroke:#166534,color:#14532d",
    person: "fill:#fef3c7,stroke:#92400e,color:#78350f",
};
const DEFAULT_STYLE = "fill:#ede9fe,stroke:#5b21b6,color:#4c1d95";

const client = pgClient(graphUrl);
try {
    await client.connect();
    // Prepare the AGE session. On HorizonDB `age` is preloaded, so an explicit
    // LOAD is rejected with "access to library ... not allowed" — tolerated.
    try { await client.query("LOAD 'age'"); } catch (err) {
        if (!/access to library "age" is not allowed/i.test(String(err?.message))) throw err;
    }
    await client.query(`SET search_path = ag_catalog, "$user", public`);

    const nodes = await cy(
        client,
        "MATCH (n:GraphNode) RETURN n.node_key AS key, n.kind AS kind, n.name AS name ORDER BY n.kind, n.name",
        ["key", "kind", "name"],
    );
    const rawEdges = await cy(
        client,
        "MATCH (a:GraphNode)-[r:REL]->(b:GraphNode) " +
        "RETURN a.node_key AS src, r.predicate AS predicate, b.node_key AS dst ORDER BY r.predicate, a.node_key",
        ["src", "predicate", "dst"],
    );
    // Collapse identical (subject, predicate, object) triples. A property graph
    // may hold parallel edges with the same predicate, but for a diagram they are
    // the same relationship — drawing the arrow twice only adds noise.
    const seenEdge = new Set();
    const edges = rawEdges.filter((e) => {
        const sig = `${e.src}\u0000${e.predicate}\u0000${e.dst}`;
        if (seenEdge.has(sig)) return false;
        seenEdge.add(sig);
        return true;
    });

    // Counts by kind / predicate for the summary tables.
    const byKind = {};
    for (const n of nodes) byKind[n.kind ?? "(none)"] = (byKind[n.kind ?? "(none)"] || 0) + 1;
    const byPred = {};
    for (const e of edges) byPred[e.predicate ?? "(none)"] = (byPred[e.predicate ?? "(none)"] || 0) + 1;

    const lines = [];
    lines.push("# Horizon Harvester — Knowledge Graph");
    lines.push("");
    lines.push(`Generated ${new Date().toISOString()} from graph \`${graphName}\`.`);
    lines.push("");
    lines.push(`**${nodes.length}** nodes · **${edges.length}** edges`);
    lines.push("");

    if (nodes.length === 0) {
        lines.push("> The graph is empty. Run a harvest first:");
        lines.push("> `./scripts/run-horizon-harvester-sample.sh`");
        lines.push("");
    } else {
        lines.push("## Entities by kind");
        lines.push("");
        lines.push("| Kind | Count |");
        lines.push("|------|------:|");
        for (const [k, n] of Object.entries(byKind).sort()) lines.push(`| ${k} | ${n} |`);
        lines.push("");

        lines.push("## Relationships by predicate");
        lines.push("");
        lines.push("| Predicate | Count |");
        lines.push("|-----------|------:|");
        for (const [p, n] of Object.entries(byPred).sort()) lines.push(`| ${p} | ${n} |`);
        lines.push("");

        lines.push("## Diagram");
        lines.push("");
        lines.push("```mermaid");
        lines.push("graph LR");
        for (const n of nodes) lines.push(`  ${mid(n.key)}["${esc(n.name)} (${esc(n.kind)})"]`);
        lines.push("");
        for (const e of edges) lines.push(`  ${mid(e.src)} -->|${edgeLabel(e.predicate)}| ${mid(e.dst)}`);
        lines.push("");
        // Style nodes by kind.
        const kindsPresent = [...new Set(nodes.map((n) => n.kind).filter(Boolean))];
        for (const k of kindsPresent) {
            const cls = String(k).replace(/[^A-Za-z0-9_]/g, "_");
            lines.push(`  classDef ${cls} ${KIND_STYLES[k] ?? DEFAULT_STYLE};`);
        }
        for (const n of nodes) {
            if (!n.kind) continue;
            const cls = String(n.kind).replace(/[^A-Za-z0-9_]/g, "_");
            lines.push(`  class ${mid(n.key)} ${cls};`);
        }
        lines.push("```");
        lines.push("");
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join("\n"));
    console.log(`Wrote ${nodes.length} nodes / ${edges.length} edges → ${outPath}`);
} catch (err) {
    console.error(`Graph export failed: ${err.message}`);
    if (/relation "ag_graph"|graph .* does not exist/i.test(String(err.message))) {
        console.error("The graph does not exist yet — run a harvest first: ./scripts/run-horizon-harvester-sample.sh");
    }
    process.exitCode = 1;
} finally {
    await client.end().catch(() => {});
}
