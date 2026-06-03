// poc/01-lexical.mjs — Phase 1: pg_textsearch ranked recall + ACL composition.
//
// Demonstrates:
//   1. Stemming: query "hydrate" matches a fact about "hydration".
//   2. Relevance ranking via ts_rank (not recency).
//   3. The governance invariant: lexical search composes with the ACL predicate,
//      so a caller never sees a fact outside its scope.
//
// Run: npm run build && node --env-file=.env poc/01-lexical.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect, seedFact, check, summarize, SCHEMA } from "./_common.mjs";

const here = dirname(fileURLToPath(import.meta.url));

async function applySql(client, file) {
    // Strip psql meta-commands (\set) — we substitute the schema literal instead.
    const raw = readFileSync(join(here, "..", "sql", file), "utf8");
    const sql = raw
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("\\"))
        .join("\n")
        .replaceAll(':"schema"', SCHEMA);
    await client.query(sql);
}

async function main() {
    const client = await connect();
    try {
        await applySql(client, "001_enrich_facts.sql");
        await applySql(client, "003_search_procs.sql");

        // Two sessions: 'owner' (caller) and 'other' (not in caller's lineage).
        await seedFact(client, {
            key: "skills/hydration-recovery",
            value: { name: "Recover from hydration blob-missing", description: "When a session fails to hydrate because the blob is missing, rebuild from CMS." },
            session_id: "owner", shared: true,
        });
        await seedFact(client, {
            key: "skills/unrelated-networking",
            value: { name: "Fix NSG rules", description: "Open CorpNet service tags for the portal." },
            session_id: "owner", shared: true,
        });
        // A private fact owned by 'other' — caller must NOT see it even if it matches.
        await seedFact(client, {
            key: "notes/hydrate-secret",
            value: { name: "private hydrate note", description: "hydration internal detail" },
            session_id: "other", shared: false,
        });

        // 1) Stemming + ranking: "hydrate" should top-rank the hydration skill.
        const lex = await client.query(
            `SELECT * FROM ${SCHEMA}.facts_lexical_candidates($1, $2, $3)`,
            ["hydrate blob", "skills/%", 10],
        );
        check("stemming: 'hydrate' matches 'hydration' skill", lex.rows.some((r) => r.scope_key === "shared:skills/hydration-recovery"));
        check("ranking: hydration skill out-ranks unrelated networking skill",
            lex.rows[0]?.scope_key === "shared:skills/hydration-recovery");

        // 2) Governance: resolve candidates for caller 'owner' (no lineage grants).
        //    The private 'other' note matches "hydrate" lexically but must be filtered.
        const allCandidates = await client.query(
            `SELECT * FROM ${SCHEMA}.facts_lexical_candidates($1, $2, $3)`,
            ["hydrate", null, 50],
        );
        const candidateKeys = allCandidates.rows.map((r) => r.scope_key);
        check("lexical candidate set includes the private match (pre-ACL)",
            candidateKeys.includes("session:other:notes/hydrate-secret"));

        const visible = await client.query(
            `SELECT * FROM ${SCHEMA}.facts_resolve_visible($1, $2, $3, $4)`,
            [candidateKeys, "owner", [], false],
        );
        const visibleKeys = visible.rows.map((r) => r.scope_key);
        check("INVARIANT: ACL filter removes the other session's private fact",
            !visibleKeys.includes("session:other:notes/hydrate-secret"));
        check("INVARIANT: caller still sees shared matches",
            visibleKeys.includes("shared:skills/hydration-recovery"));

        summarize("01-lexical");
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
