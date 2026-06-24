// @pilotswarm/horizon-store — small SQL helpers for the adapter.
//
// AGE Cypher cannot be fully parameterized through pg bind params (the cypher()
// function takes a literal query string), so the adapter must build Cypher with
// embedded literals. These helpers make that safe: every value is escaped, and
// identifiers are validated against a strict allowlist.

/** Quote a SQL identifier (schema/table/graph). Rejects anything non-trivial. */
export function ident(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
    }
    return `"${name}"`;
}

/**
 * Escape a JS string as a single-quoted AGE Cypher string literal.
 *
 * These literals are consumed by AGE's Cypher (openCypher) parser inside
 * `cypher(graph, $$ ... $$)`, NOT by the SQL parser — so a single quote is
 * escaped with a backslash (`\'`), the Cypher way, NOT by SQL-style doubling
 * (`''`). Doubling produces `'Andres''s VM'`, which the Cypher parser reads as
 * the string `'Andres'` followed by stray tokens → `syntax error at or near
 * "'s VM'"` (verified against live AGE), silently dropping the write. Backslash
 * is escaped first so the quote-escape we add is not itself re-escaped; NULs are
 * stripped.
 */
export function cypherStr(value: string): string {
    const cleaned = String(value).replace(/\u0000/g, "");
    return `'${cleaned.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Render a number safely as a Cypher numeric literal. */
export function cypherNum(n: number): string {
    if (!Number.isFinite(n)) throw new Error(`non-finite number in cypher: ${n}`);
    return String(n);
}

/** Render a string[] as a Cypher list literal of escaped strings. */
export function cypherStrList(values: string[]): string {
    return `[${values.map(cypherStr).join(", ")}]`;
}
