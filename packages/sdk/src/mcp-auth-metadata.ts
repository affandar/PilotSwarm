import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
    audienceFromBearerChallenge,
    audienceFromProtectedResourceMetadata,
    bearerChallenges,
    normalizeAudience,
    parseProtectedResourceMetadata,
    type ResourceAudience,
} from "./mcp-auth.js";

export * from "./mcp-auth.js";

export type MetadataBody = string | Uint8Array | AsyncIterable<string | Uint8Array>;

export interface MetadataResponse {
    status: number;
    headers?: Readonly<Record<string, string | undefined>>;
    body: MetadataBody;
}

export interface MetadataNetworkDependencies {
    resolveHostname(hostname: string): Promise<readonly string[]>;
    request(url: URL, pinnedAddress: string, signal: AbortSignal): Promise<MetadataResponse>;
}

export interface MetadataFetchOptions {
    dependencies?: MetadataNetworkDependencies;
    timeoutMs?: number;
    maxResponseBytes?: number;
    maxRedirects?: number;
}

export interface AudienceDiscoveryOptions extends MetadataFetchOptions {
    onEvent?: (event: {
        type: "metadata-fetch" | "metadata-rejected";
        url: string;
    }) => void;
}

export class McpMetadataFetchError extends Error {
    constructor(
        public readonly code:
            | "INVALID_URL"
            | "SSRF_BLOCKED"
            | "TIMEOUT"
            | "TOO_MANY_REDIRECTS"
            | "HTTP_ERROR"
            | "RESPONSE_TOO_LARGE",
        message: string,
    ) {
        super(message);
        this.name = "McpMetadataFetchError";
    }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function header(response: MetadataResponse, name: string): string | undefined {
    const sought = name.toLowerCase();
    for (const [key, value] of Object.entries(response.headers ?? {})) {
        if (key.toLowerCase() === sought) return value;
    }
    return undefined;
}

function discardBody(body: MetadataBody): void {
    if (body && typeof body === "object" && "destroy" in body) {
        const destroy = (body as { destroy?: () => void }).destroy;
        destroy?.call(body);
    }
}

function ipv4Parts(address: string): number[] | null {
    if (isIP(address) !== 4) return null;
    return address.split(".").map(Number);
}

function isPublicIpv4(address: string): boolean {
    const parts = ipv4Parts(address);
    if (!parts) return false;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
}

function isPublicIp(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return isPublicIpv4(address);
    if (family !== 6) return false;
    const normalized = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isPublicIpv4(mapped[1]);
    return !(
        normalized === "::"
        || normalized === "::1"
        || normalized.startsWith("fc")
        || normalized.startsWith("fd")
        || /^fe[89ab]/.test(normalized)
        || normalized.startsWith("ff")
        || normalized.startsWith("::ffff:")
        || normalized.startsWith("2001:db8:")
    );
}

function validateMetadataUrl(value: string | URL): URL {
    let url: URL;
    try {
        url = value instanceof URL ? new URL(value) : new URL(value);
    } catch {
        throw new McpMetadataFetchError("INVALID_URL", "Protected-resource metadata URL is invalid.");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new McpMetadataFetchError(
            "INVALID_URL",
            "Protected-resource metadata must use HTTPS without embedded credentials.",
        );
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
        hostname === "localhost"
        || hostname.endsWith(".localhost")
        || hostname.endsWith(".local")
        || hostname.endsWith(".internal")
        || hostname.endsWith(".home.arpa")
    ) {
        throw new McpMetadataFetchError("SSRF_BLOCKED", "Protected-resource metadata host is not public.");
    }
    return url;
}

async function resolvePublicAddress(
    url: URL,
    dependencies: MetadataNetworkDependencies,
): Promise<string> {
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(literal)
        ? [literal]
        : [...await dependencies.resolveHostname(url.hostname)];
    if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) {
        throw new McpMetadataFetchError("SSRF_BLOCKED", "Protected-resource metadata resolved to a non-public address.");
    }
    return addresses[0];
}

async function bodyText(body: MetadataBody, maxBytes: number): Promise<string> {
    if (typeof body === "string") {
        if (Buffer.byteLength(body) > maxBytes) {
            throw new McpMetadataFetchError("RESPONSE_TOO_LARGE", "Protected-resource metadata response is too large.");
        }
        return body;
    }
    if (body instanceof Uint8Array) {
        if (body.byteLength > maxBytes) {
            throw new McpMetadataFetchError("RESPONSE_TOO_LARGE", "Protected-resource metadata response is too large.");
        }
        return Buffer.from(body).toString("utf8");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > maxBytes) {
            throw new McpMetadataFetchError("RESPONSE_TOO_LARGE", "Protected-resource metadata response is too large.");
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            controller.abort();
            reject(new McpMetadataFetchError("TIMEOUT", "Protected-resource metadata request timed out."));
        }, timeoutMs);
        timer.unref?.();
        operation(controller.signal).then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function defaultDependencies(): MetadataNetworkDependencies {
    return {
        async resolveHostname(hostname) {
            return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
        },
        request(url, pinnedAddress, signal) {
            return new Promise((resolve, reject) => {
                const req = httpsRequest(url, {
                    method: "GET",
                    headers: {
                        accept: "application/json",
                        "user-agent": "pilotswarm-sdk-mcp-auth-discovery",
                    },
                    lookup: (_hostname, _options, callback) => callback(null, pinnedAddress, isIP(pinnedAddress)),
                    signal,
                }, (response) => {
                    const headers: Record<string, string | undefined> = {};
                    for (const [name, value] of Object.entries(response.headers)) {
                        headers[name] = Array.isArray(value) ? value.join(", ") : value;
                    }
                    resolve({ status: response.statusCode ?? 0, headers, body: response });
                });
                req.on("error", reject);
                req.end();
            });
        },
    };
}

/**
 * Fetch protected-resource metadata with a pinned public DNS result, bounded
 * redirects, a deadline, and a streaming response-size limit.
 */
export async function fetchProtectedResourceMetadata(
    metadataUrl: string,
    options: MetadataFetchOptions = {},
): Promise<string> {
    const dependencies = options.dependencies ?? defaultDependencies();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError("timeoutMs must be a positive finite number.");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError("maxResponseBytes must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
        throw new TypeError("maxRedirects must be a non-negative safe integer.");
    }
    let url = validateMetadataUrl(metadataUrl);
    const deadline = Date.now() + timeoutMs;

    for (let redirect = 0; ; redirect++) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            throw new McpMetadataFetchError("TIMEOUT", "Protected-resource metadata request timed out.");
        }
        const { response, text } = await withTimeout(
            async (signal) => {
                const address = await resolvePublicAddress(url, dependencies);
                const response = await dependencies.request(url, address, signal);
                const text = response.status >= 200 && response.status < 300
                    ? await bodyText(response.body, maxBytes)
                    : undefined;
                return { response, text };
            },
            remainingMs,
        );
        if (REDIRECT_STATUSES.has(response.status)) {
            discardBody(response.body);
            if (redirect >= maxRedirects) {
                throw new McpMetadataFetchError("TOO_MANY_REDIRECTS", "Protected-resource metadata redirected too many times.");
            }
            const location = header(response, "location");
            if (!location) {
                throw new McpMetadataFetchError("HTTP_ERROR", "Protected-resource metadata redirect omitted Location.");
            }
            url = validateMetadataUrl(new URL(location, url));
            continue;
        }
        if (response.status < 200 || response.status >= 300) {
            discardBody(response.body);
            throw new McpMetadataFetchError("HTTP_ERROR", `Protected-resource metadata returned HTTP ${response.status}.`);
        }
        return text!;
    }
}

/**
 * Discover every unique resource audience advertised by Bearer challenges.
 * Inline resource/scope values remain pure; RFC 9728 URLs are fetched through
 * the hardened metadata path above. No credential is accepted or transmitted.
 */
export async function discoverMcpResourceAudiences(
    headerValues: string | readonly string[],
    options: AudienceDiscoveryOptions = {},
): Promise<ResourceAudience[]> {
    const discovered = new Map<string, ResourceAudience>();
    for (const challenge of bearerChallenges(headerValues)) {
        if (challenge.resourceMetadata) {
            options.onEvent?.({ type: "metadata-fetch", url: challenge.resourceMetadata });
            try {
                const body = await fetchProtectedResourceMetadata(challenge.resourceMetadata, options);
                const metadata = parseProtectedResourceMetadata(body);
                const audience = audienceFromProtectedResourceMetadata(metadata, challenge.scope);
                if (audience) discovered.set(normalizeAudience(audience.audience), audience);
            } catch (error) {
                options.onEvent?.({ type: "metadata-rejected", url: challenge.resourceMetadata });
                throw error;
            }
            continue;
        }
        const audience = audienceFromBearerChallenge(challenge);
        if (audience) discovered.set(normalizeAudience(audience.audience), audience);
    }
    return [...discovered.values()];
}
