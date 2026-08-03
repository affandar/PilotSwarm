/**
 * Import policy — the allowlist and network guards for `import_agent_package`.
 *
 * ── Why this file is defensive out of proportion to its size ────────────
 *
 * `import_agent_package` is the worker's FIRST outbound-fetch primitive
 * (§15 A1). Before it, there was no `fetch(` anywhere in the worker core. It
 * is reachable with a model-chosen URL, inside an agent whose entire job is
 * reading untrusted material — session transcripts, archives, other people's
 * packages. That is the lethal trifecta in one tool: private data, untrusted
 * content, and an outbound channel.
 *
 * The primary control is an ALLOWLIST rather than a blocklist, because there
 * is then no hostile URL to filter — anything off the list is simply
 * unreachable. A prompt injection saying "also import from
 * http://169.254.169.254/metadata/identity/oauth2/token" cannot be honoured,
 * not because we recognized it, but because that origin was never permitted.
 *
 * Layered underneath, because an allowlist alone is not enough: DNS is not
 * ours to trust, so an allowlisted NAME that resolves into private address
 * space must still be refused — and re-checked on every redirect hop.
 *
 * ── Everything here is a pure decision ──────────────────────────────────
 *
 * No sockets are opened in this module. It decides; the caller connects. That
 * keeps the whole bypass surface unit-testable without a network.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The base allowlist is a CONSTANT IN SOURCE, not a config default.
 *
 * Three entries because GitHub serves one repository from three hosts. Keeping
 * them here rather than in the shipped config file means changing them shows
 * up in a PR diff, and a deployment cannot silently drop them by overwriting a
 * file it mounts.
 */
export const BASE_IMPORT_ALLOWLIST: readonly string[] = Object.freeze([
    "https://github.com/affandar/pilotswarm/",
    "https://raw.githubusercontent.com/affandar/pilotswarm/",
    "https://codeload.github.com/affandar/pilotswarm/",
]);

export const IMPORT_CONFIG_FILENAME = ".agent_packages.json";

export interface ImportAllowlistEntry {
    protocol: "https:";
    /** Lower-cased, trailing dot stripped. */
    host: string;
    /** Explicit port, or null meaning "default only". */
    port: string | null;
    /** Normalized path prefix, always starting with `/`. */
    pathPrefix: string;
    /** The entry as written, for error messages. */
    raw: string;
}

export interface ImportPolicy {
    entries: ImportAllowlistEntry[];
    mode: "append" | "replace";
    /** Where the deployment config came from, for diagnostics. */
    configPath: string | null;
}

export interface UrlDecision {
    allowed: boolean;
    /** Populated only when refused. Never contains a response body. */
    reason?: string;
    /** The normalized URL that was checked. */
    url?: string;
}

// ── Allowlist entry parsing ──────────────────────────────────────

/**
 * Normalize a path for prefix comparison.
 *
 * Percent-decoding happens BEFORE `..` resolution, because otherwise
 * `%2e%2e%2f` survives as literal text and slips past a traversal check that
 * only looked for `../`.
 */
export function normalizePathForMatch(rawPath: string): string {
    let decoded = rawPath || "/";
    // Decode repeatedly: a double-encoded `%252e` becomes `%2e` on the first
    // pass and `.` only on the second. Bounded so a crafted input cannot spin.
    for (let i = 0; i < 3; i += 1) {
        let next: string;
        try {
            next = decodeURIComponent(decoded);
        } catch {
            // Malformed escape: keep what we have rather than throwing. It
            // will simply fail to match anything.
            break;
        }
        if (next === decoded) break;
        decoded = next;
    }
    // Backslashes are path separators on some servers and not others; fold
    // them so `..\..` cannot evade the segment walk below.
    decoded = decoded.replace(/\\/g, "/");
    const out: string[] = [];
    for (const segment of decoded.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") { out.pop(); continue; }
        out.push(segment);
    }
    const trailingSlash = decoded.endsWith("/") && out.length > 0;
    return `/${out.join("/")}${trailingSlash ? "/" : ""}`;
}

/** Strip a single trailing dot and lower-case. `GitHub.COM.` → `github.com`. */
export function normalizeHost(host: string): string {
    return String(host || "").toLowerCase().replace(/\.$/, "");
}

/**
 * Parse one allowlist entry. Returns null (with no exception) for anything
 * unusable — a malformed entry must never widen the list.
 */
export function parseAllowlistEntry(raw: string): ImportAllowlistEntry | null {
    if (typeof raw !== "string" || !raw.trim()) return null;
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const host = normalizeHost(url.hostname);
    if (!host) return null;
    return {
        protocol: "https:",
        host,
        port: url.port === "" ? null : url.port,
        pathPrefix: normalizePathForMatch(url.pathname),
        raw: raw.trim(),
    };
}

// ── Deployment config ────────────────────────────────────────────

/**
 * Load `.agent_packages.json` and compose it with the base list.
 *
 * A MALFORMED FILE IS FATAL rather than ignored. A security control that
 * silently falls back to a default when its config is broken is how
 * deployments end up unknowingly running the permissive version — the operator
 * edited the file, fat-fingered a comma, and never learned the edit did
 * nothing.
 */
export function loadImportPolicy(opts: { configDir?: string; configPath?: string } = {}): ImportPolicy {
    const configPath = opts.configPath
        ?? (opts.configDir ? path.join(opts.configDir, IMPORT_CONFIG_FILENAME) : null);

    const base = BASE_IMPORT_ALLOWLIST
        .map(parseAllowlistEntry)
        .filter((e): e is ImportAllowlistEntry => e !== null);

    if (!configPath || !fs.existsSync(configPath)) {
        // No file at all is a legitimate posture: the base list only.
        return { entries: base, mode: "append", configPath: null };
    }

    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error: any) {
        throw new Error(
            `${IMPORT_CONFIG_FILENAME} at ${configPath} is not valid JSON: ${error?.message ?? error}. `
            + "Refusing to start rather than fall back to a different import policy than the operator intended.",
        );
    }

    const importCfg = parsed?.import ?? {};
    const rawMode = importCfg?.mode ?? "append";
    if (rawMode !== "append" && rawMode !== "replace") {
        throw new Error(
            `${IMPORT_CONFIG_FILENAME}: import.mode must be "append" or "replace", got ${JSON.stringify(rawMode)}.`,
        );
    }
    const rawList = importCfg?.allowlist;
    if (rawList != null && !Array.isArray(rawList)) {
        throw new Error(`${IMPORT_CONFIG_FILENAME}: import.allowlist must be an array of origin strings.`);
    }

    const configured: ImportAllowlistEntry[] = [];
    for (const raw of rawList ?? []) {
        const entry = parseAllowlistEntry(raw);
        if (!entry) {
            throw new Error(
                `${IMPORT_CONFIG_FILENAME}: allowlist entry ${JSON.stringify(raw)} is not a usable https origin. `
                + "Entries must be absolute https URLs with no credentials.",
            );
        }
        configured.push(entry);
    }

    // `replace` is the ONLY way to drop a base entry, deliberately explicit:
    // it is the single setting that can remove the PilotSwarm repo.
    const entries = rawMode === "replace" ? configured : [...base, ...configured];
    return { entries, mode: rawMode, configPath };
}

// ── Address checks ───────────────────────────────────────────────

/**
 * Is this resolved address inside a range we must never fetch from?
 *
 * Applied to the RESOLVED ADDRESS, not the hostname, and on every redirect
 * hop — an allowlisted name whose DNS answers `169.254.169.254` is exactly
 * the attack this stops.
 */
export function isBlockedAddress(address: string): boolean {
    const addr = String(address || "").trim().toLowerCase();
    if (!addr) return true;

    // IPv6, including the IPv4-mapped form that would otherwise smuggle a
    // private v4 address past a v4-only check.
    if (addr.includes(":")) {
        const bare = addr.replace(/^\[|\]$/g, "");
        if (bare === "::1" || bare === "::") return true;
        if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;   // unique-local
        if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;   // link-local
        const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isBlockedAddress(mapped[1]);
        return false;
    }

    const octets = addr.split(".");
    if (octets.length !== 4) return true;   // not a plain IPv4 literal → refuse
    const nums = octets.map((o) => Number(o));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = nums;

    if (a === 0) return true;                       // "this network"
    if (a === 10) return true;                      // RFC1918
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true;        // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;          // IETF protocol assignments
    if (a >= 224) return true;                      // multicast + reserved
    return false;
}

/**
 * Reject host forms that are not plain names — decimal, octal and hex IPv4
 * literals resolve to addresses without ever looking like one.
 * `http://2130706433/` is `127.0.0.1`.
 */
export function isSuspiciousHostLiteral(host: string): boolean {
    const h = normalizeHost(host);
    if (!h) return true;
    if (/^\d+$/.test(h)) return true;                      // decimal literal
    if (/^0x[0-9a-f]+$/.test(h)) return true;              // hex literal
    if (/^0\d+$/.test(h)) return true;                     // octal literal
    const parts = h.split(".");
    // Dotted forms with fewer than 4 parts that are all numeric, e.g. `127.1`.
    if (parts.length > 1 && parts.length < 4 && parts.every((p) => /^\d+$/.test(p))) return true;
    // Dotted-octal and dotted-hex: `0177.0.0.1` is 127.0.0.1, and `0x7f.0.0.1`
    // is too. A leading zero (or 0x) on any numeric octet means the value is
    // not what it reads as in decimal.
    if (parts.length === 4 && parts.every((p) => /^(0x[0-9a-f]+|\d+)$/.test(p))) {
        if (parts.some((p) => /^0x/.test(p) || /^0\d/.test(p))) return true;
    }
    return false;
}

// ── The URL decision ─────────────────────────────────────────────

/**
 * May we fetch this URL?
 *
 * Call for the initial URL AND for every redirect hop — an allowed origin
 * redirecting to a disallowed one is the obvious bypass, and the only thing
 * that stops it is re-asking the same question about the new location.
 */
export function checkImportUrl(rawUrl: string, policy: ImportPolicy): UrlDecision {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
        return { allowed: false, reason: "no URL supplied" };
    }
    let url: URL;
    try {
        url = new URL(rawUrl.trim());
    } catch {
        return { allowed: false, reason: `not a valid absolute URL: ${redact(rawUrl)}` };
    }

    if (url.protocol !== "https:") {
        return { allowed: false, reason: `only https is permitted (got ${url.protocol.replace(":", "") || "none"})`, url: url.href };
    }
    // `https://github.com@evil.com/` — the authority is evil.com, but a
    // careless reader (and a careless matcher) sees github.com.
    if (url.username || url.password) {
        return { allowed: false, reason: "credentials in the URL authority are not permitted", url: redact(url.href) };
    }

    const host = normalizeHost(url.hostname);
    if (isSuspiciousHostLiteral(host)) {
        return { allowed: false, reason: `host "${host}" is a numeric literal, not a name`, url: url.href };
    }

    const requestPath = normalizePathForMatch(url.pathname);

    for (const entry of policy.entries) {
        // Host matched EXACTLY, never by suffix: a suffix match would accept
        // `evilgithub.com` for `github.com`, and a prefix match would accept
        // `github.com.evil.com`.
        if (entry.host !== host) continue;
        // Default port only, unless the entry named one.
        const entryPort = entry.port ?? "";
        const urlPort = url.port ?? "";
        if (entryPort !== urlPort) continue;
        if (!pathPrefixMatches(requestPath, entry.pathPrefix)) continue;
        return { allowed: true, url: url.href };
    }

    return {
        allowed: false,
        reason:
            `origin is not on the import allowlist. Add it to the "import.allowlist" array in `
            + `${IMPORT_CONFIG_FILENAME}${policy.configPath ? ` (${policy.configPath})` : ""} to permit it.`,
        url: url.href,
    };
}

/**
 * Prefix match on SEGMENT BOUNDARIES.
 *
 * `/affandar/pilotswarm-evil` must not match the prefix
 * `/affandar/pilotswarm/`. A naive `startsWith` accepts it, which is how
 * allowlists usually get broken.
 */
export function pathPrefixMatches(requestPath: string, prefix: string): boolean {
    const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (p === "" || p === "/") return true;         // whole-host entry
    if (requestPath === p) return true;
    return requestPath.startsWith(`${p}/`);
}

/** Strip credentials from a URL before it appears in an error string. */
function redact(value: string): string {
    try {
        const u = new URL(value);
        u.username = "";
        u.password = "";
        return u.href;
    } catch {
        return String(value).slice(0, 200);
    }
}

// ── Fetch envelope limits ────────────────────────────────────────

/**
 * Caps applied to every import fetch. Values are conservative on purpose:
 * a package is a small tarball, and anything wanting more headroom than this
 * is not the thing this tool exists to fetch.
 */
export const IMPORT_FETCH_LIMITS = Object.freeze({
    /** Matches the documented upload cap so both paths refuse at the same size. */
    maxBytes: 2 * 1024 * 1024,
    maxRedirects: 3,
    timeoutMs: 20_000,
});
