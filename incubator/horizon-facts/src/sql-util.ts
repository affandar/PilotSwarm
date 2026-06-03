// @incubator/horizon-facts — small SQL helpers for the adapter.
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
 * Escape a JS string as a single-quoted Cypher/SQL string literal.
 * Doubles single quotes and backslashes; strips NULs. Cypher inside AGE uses
 * SQL-style single-quote escaping.
 */
export function cypherStr(value: string): string {
    const cleaned = String(value).replace(/\u0000/g, "");
    return `'${cleaned.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
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
