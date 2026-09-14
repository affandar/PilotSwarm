/**
 * Pure parsing and normalization helpers for MCP bearer authentication.
 *
 * These helpers do not perform I/O and do not validate credentials. Their
 * output is suitable for routing a token request, never for authentication or
 * authorization decisions.
 */

export interface AuthenticationChallenge {
    scheme: string;
    parameters: Readonly<Record<string, string>>;
}

export interface BearerChallenge {
    resourceMetadata?: string;
    resource?: string;
    scope?: string;
}

export interface ProtectedResourceMetadata {
    resource?: string;
    scopesSupported: string[];
}

export interface ResourceAudience {
    audience: string;
    normalizedAudience: string;
    scope?: string;
    source: "challenge" | "protected-resource-metadata";
}

export class McpAuthParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "McpAuthParseError";
    }
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function splitOutsideQuotes(value: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let quoted = false;
    let escaped = false;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quoted && char === "\\") {
            escaped = true;
            continue;
        }
        if (char === '"') {
            quoted = !quoted;
            continue;
        }
        if (char === "," && !quoted) {
            parts.push(value.slice(start, i).trim());
            start = i + 1;
        }
    }

    if (quoted || escaped) {
        throw new McpAuthParseError("Malformed WWW-Authenticate header: unterminated quoted string.");
    }
    parts.push(value.slice(start).trim());
    return parts.filter(Boolean);
}

function parseParameter(value: string): [string, string] {
    const equals = value.indexOf("=");
    if (equals <= 0) {
        throw new McpAuthParseError(`Malformed WWW-Authenticate parameter: ${value}`);
    }
    const name = value.slice(0, equals).trim().toLowerCase();
    if (!TOKEN.test(name)) {
        throw new McpAuthParseError(`Invalid WWW-Authenticate parameter name: ${name}`);
    }

    const raw = value.slice(equals + 1).trim();
    if (!raw) return [name, ""];
    if (!raw.startsWith('"')) {
        if (!TOKEN.test(raw)) {
            throw new McpAuthParseError(`Invalid WWW-Authenticate token value for ${name}.`);
        }
        return [name, raw];
    }
    if (!raw.endsWith('"') || raw.length < 2) {
        throw new McpAuthParseError(`Malformed WWW-Authenticate quoted value for ${name}.`);
    }

    let decoded = "";
    for (let i = 1; i < raw.length - 1; i++) {
        const char = raw[i];
        if (char === "\\") {
            i++;
            if (i >= raw.length - 1) {
                throw new McpAuthParseError(`Malformed escape in WWW-Authenticate parameter ${name}.`);
            }
            decoded += raw[i];
        } else {
            decoded += char;
        }
    }
    return [name, decoded];
}

function startsChallenge(part: string): { scheme: string; remainder: string } | null {
    const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:\s+(.+))?$/.exec(part);
    if (!match || part.includes("=") && !match[2]) return null;
    const remainder = match[2]?.trim() ?? "";
    if (remainder && remainder.startsWith("=")) return null;
    return { scheme: match[1], remainder };
}

/**
 * Parse one or more WWW-Authenticate field values into ordered challenges.
 * Commas inside quoted values and multiple authentication schemes are handled.
 * Malformed quoting fails closed instead of producing a partial challenge.
 */
export function parseWwwAuthenticate(headerValues: string | readonly string[]): AuthenticationChallenge[] {
    const values = typeof headerValues === "string" ? [headerValues] : headerValues;
    const challenges: Array<{ scheme: string; parameters: Record<string, string> }> = [];

    for (const headerValue of values) {
        let current: { scheme: string; parameters: Record<string, string> } | null = null;
        for (const part of splitOutsideQuotes(headerValue)) {
            const beginning = startsChallenge(part);
            if (beginning) {
                current = { scheme: beginning.scheme, parameters: {} };
                challenges.push(current);
                if (beginning.remainder) {
                    const [name, value] = parseParameter(beginning.remainder);
                    current.parameters[name] = value;
                }
                continue;
            }
            if (!current) {
                throw new McpAuthParseError("WWW-Authenticate parameters appeared before an authentication scheme.");
            }
            const [name, value] = parseParameter(part);
            current.parameters[name] = value;
        }
    }

    return challenges;
}

export function bearerChallenges(
    headerValues: string | readonly string[],
): BearerChallenge[] {
    return parseWwwAuthenticate(headerValues)
        .filter((challenge) => challenge.scheme.toLowerCase() === "bearer")
        .map(({ parameters }) => ({
            resourceMetadata: parameters.resource_metadata,
            resource: parameters.resource ?? parameters.resource_id,
            scope: parameters.scope,
        }));
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Parse the RFC 9728 fields used for resource-audience discovery.
 * Unknown fields are deliberately discarded.
 */
export function parseProtectedResourceMetadata(body: string): ProtectedResourceMetadata {
    let value: unknown;
    try {
        value = JSON.parse(body);
    } catch {
        throw new McpAuthParseError("Protected-resource metadata is not valid JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new McpAuthParseError("Protected-resource metadata must be a JSON object.");
    }
    const record = value as Record<string, unknown>;
    const resource = nonEmptyString(record.resource);
    const scopes = record.scopes_supported;
    if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((scope) => !nonEmptyString(scope)))) {
        throw new McpAuthParseError("Protected-resource metadata scopes_supported must contain only strings.");
    }
    return {
        resource,
        scopesSupported: Array.isArray(scopes)
            ? scopes.map((scope) => String(scope).trim())
            : [],
    };
}

function firstScope(scope: string | undefined): string | undefined {
    return scope?.trim().split(/\s+/, 1)[0] || undefined;
}

export function audienceFromScope(scope: string): string {
    const value = firstScope(scope);
    if (!value) throw new McpAuthParseError("OAuth scope is empty.");
    if (value.toLowerCase().endsWith("/.default")) {
        return value.slice(0, -"/.default".length);
    }
    const scheme = value.indexOf("://");
    const slash = scheme >= 0 ? value.lastIndexOf("/") : value.indexOf("/");
    return slash > scheme + 2 ? value.slice(0, slash) : value;
}

/**
 * Canonicalize an audience for routing comparisons. This does not prove that
 * a token was issued for the audience; credential validation remains the
 * responsibility of the protected resource.
 */
export function normalizeAudience(audience: string): string {
    let value = audience.trim();
    if (!value) throw new McpAuthParseError("Audience is empty.");
    if (value.toLowerCase().endsWith("/.default")) {
        value = value.slice(0, -"/.default".length);
    }
    value = value.replace(/\/+$/, "");
    if (/^api:\/\//i.test(value) && GUID.test(value.slice("api://".length))) {
        return value.slice("api://".length).toLowerCase();
    }
    try {
        const url = new URL(value);
        url.protocol = url.protocol.toLowerCase();
        url.hostname = url.hostname.toLowerCase();
        url.hash = "";
        url.search = "";
        return url.toString().replace(/\/+$/, "").toLowerCase();
    } catch {
        return value.toLowerCase();
    }
}

export function audienceFromBearerChallenge(challenge: BearerChallenge): ResourceAudience | null {
    const scope = firstScope(challenge.scope);
    const audience = nonEmptyString(challenge.resource)
        ?? (scope ? audienceFromScope(scope) : undefined);
    return audience
        ? {
            audience,
            normalizedAudience: normalizeAudience(audience),
            ...(scope ? { scope } : {}),
            source: "challenge",
        }
        : null;
}

export function audienceFromProtectedResourceMetadata(
    metadata: ProtectedResourceMetadata,
    challengeScope?: string,
): ResourceAudience | null {
    const scope = firstScope(challengeScope) ?? firstScope(metadata.scopesSupported[0]);
    const audience = metadata.resource ?? (scope ? audienceFromScope(scope) : undefined);
    return audience
        ? {
            audience,
            normalizedAudience: normalizeAudience(audience),
            ...(scope ? { scope } : {}),
            source: "protected-resource-metadata",
        }
        : null;
}
