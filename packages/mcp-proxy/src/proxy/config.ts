/**
 * Generic env parsing helpers shared by the proxy core and its adapters.
 * Kept dependency-free so both the generic middleware and any upstream adapter
 * (Kusto, ...) read configuration the same way.
 */

/** Parse a boolean env var. Accepts 1/true/yes/on (case-insensitive) as true. */
export function envBool(name: string, def: boolean): boolean {
    const raw = process.env[name];
    if (raw == null) return def;
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse an integer env var, falling back to `def` on missing/invalid input. */
export function envInt(name: string, def: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
}

/**
 * Parse a comma-separated env var into a lower-cased host allowlist. Each item
 * may be a bare host (`help.kusto.windows.net`) or a full URL (the host is
 * extracted). Falls back to `def` when unset/empty.
 */
export function envHosts(name: string, def: string[]): Set<string> {
    const fallback = () => new Set(def.map((h) => h.toLowerCase()));
    const raw = process.env[name];
    if (!raw) return fallback();
    const hosts = new Set<string>();
    for (const rawItem of raw.split(",")) {
        const item = rawItem.trim().toLowerCase();
        if (!item) continue;
        let host = item;
        if (item.includes("://")) {
            try {
                host = new URL(item).hostname.toLowerCase();
            } catch {
                continue;
            }
        }
        if (host) hosts.add(host);
    }
    return hosts.size ? hosts : fallback();
}
