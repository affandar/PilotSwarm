/**
 * The guarded fetch behind `import_agent_package`.
 *
 * Separated from the policy so the DECISIONS stay unit-testable without a
 * network, and the I/O stays small enough to audit by eye.
 *
 * Three properties this file exists to guarantee, all from §15 A1:
 *
 *  1. **Every hop is re-checked.** An allowlisted origin that redirects to a
 *     disallowed one is the obvious bypass. `fetch()` follows redirects
 *     silently by default, so redirect following is done MANUALLY here with
 *     `redirect: "manual"` — automatic following would check only the first
 *     URL and fetch the last.
 *
 *  2. **DNS is not trusted.** The resolved address is checked against the
 *     private/metadata denylist on every hop, because an allowlisted NAME may
 *     still answer with `169.254.169.254`.
 *
 *  3. **Response bodies never reach an error, a log line or the transcript.**
 *     The agent reading this is the same agent an attacker may be talking to;
 *     echoing a body back is the exfiltration channel the allowlist exists to
 *     close.
 *
 * @module
 */

import * as dns from "node:dns/promises";
import {
    IMPORT_FETCH_LIMITS,
    checkImportUrl,
    isBlockedAddress,
    type ImportPolicy,
} from "./agent-package-import-policy.js";

export interface ImportFetchResult {
    bytes: Buffer;
    /** The final URL after any permitted redirects. */
    finalUrl: string;
    /** Each URL visited, in order — useful in an audit record. */
    hops: string[];
}

export class ImportRefusedError extends Error {
    readonly code = "AGENT_PACKAGE_IMPORT_REFUSED";
    /** The URL that was refused, credentials already stripped. */
    readonly url: string | undefined;
    constructor(message: string, url?: string) {
        super(message);
        this.name = "ImportRefusedError";
        this.url = url;
    }
}

/**
 * Resolve a hostname and refuse if ANY answer is in blocked space.
 *
 * "Any" rather than "the one we will use" on purpose: a name that resolves to
 * both a public and a private address is a DNS-rebinding setup, and we have no
 * way to pin which record the socket will actually take.
 */
export async function assertHostResolvesPublicly(
    hostname: string,
    resolver: { lookup: (h: string, opts: any) => Promise<Array<{ address: string }>> } = dns as any,
): Promise<string[]> {
    let answers: Array<{ address: string }>;
    try {
        answers = await resolver.lookup(hostname, { all: true, verbatim: true });
    } catch (error: any) {
        // A name that will not resolve cannot be fetched anyway; refusing here
        // keeps the failure legible instead of surfacing a socket error later.
        throw new ImportRefusedError(`could not resolve host "${hostname}": ${error?.code ?? "lookup failed"}`);
    }
    if (!answers?.length) {
        throw new ImportRefusedError(`host "${hostname}" resolved to no addresses`);
    }
    const addresses = answers.map((a) => a.address);
    for (const address of addresses) {
        if (isBlockedAddress(address)) {
            throw new ImportRefusedError(
                `host "${hostname}" resolves to a non-public address (${address}); refusing to connect`,
            );
        }
    }
    return addresses;
}

/**
 * Fetch a package from an allowlisted origin, or refuse.
 *
 * `fetchImpl` and `resolver` are injectable so the guard logic can be tested
 * against redirect chains and hostile DNS without a network.
 */
export async function guardedImportFetch(
    rawUrl: string,
    policy: ImportPolicy,
    opts: {
        fetchImpl?: typeof fetch;
        resolver?: { lookup: (h: string, o: any) => Promise<Array<{ address: string }>> };
        limits?: typeof IMPORT_FETCH_LIMITS;
        signal?: AbortSignal;
    } = {},
): Promise<ImportFetchResult> {
    const limits = opts.limits ?? IMPORT_FETCH_LIMITS;
    const doFetch = opts.fetchImpl ?? fetch;
    const hops: string[] = [];

    let current = rawUrl;
    for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
        // The SAME check for the initial URL and every redirect. Sharing one
        // function is the point: a redirect path with its own weaker check is
        // how this gets broken.
        const decision = checkImportUrl(current, policy);
        if (!decision.allowed) {
            throw new ImportRefusedError(
                hop === 0
                    ? `import refused: ${decision.reason}`
                    : `import refused after ${hop} redirect(s): ${decision.reason}`,
                decision.url,
            );
        }
        const url = new URL(decision.url!);
        await assertHostResolvesPublicly(url.hostname, opts.resolver as any);
        hops.push(url.href);

        const timeout = AbortSignal.timeout(limits.timeoutMs);
        const signal = opts.signal
            ? (AbortSignal as any).any?.([timeout, opts.signal]) ?? timeout
            : timeout;

        const response = await doFetch(url.href, {
            // MANUAL: automatic following would validate only the first URL
            // and fetch whatever the last one turned out to be.
            redirect: "manual",
            signal,
            headers: { accept: "application/octet-stream, application/gzip, */*" },
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) {
                throw new ImportRefusedError(`redirect with no Location header (HTTP ${response.status})`, url.href);
            }
            // Relative Locations are legal; resolve against the current URL so
            // the next iteration re-checks a fully-qualified target.
            current = new URL(location, url.href).href;
            continue;
        }

        if (!response.ok) {
            // Status only. The body may be attacker-authored, and this string
            // reaches an agent transcript.
            throw new ImportRefusedError(`fetch failed with HTTP ${response.status}`, url.href);
        }

        const declared = Number(response.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > limits.maxBytes) {
            throw new ImportRefusedError(
                `package is ${declared} bytes, over the ${limits.maxBytes}-byte import cap`, url.href,
            );
        }

        const bytes = await readCapped(response, limits.maxBytes, url.href);
        return { bytes, finalUrl: url.href, hops };
    }

    throw new ImportRefusedError(`too many redirects (limit ${limits.maxRedirects})`, hops[hops.length - 1]);
}

/**
 * Read a body, stopping the moment it exceeds the cap.
 *
 * Streamed rather than buffered-then-measured: a declared Content-Length is
 * the server's claim, and an unbounded `arrayBuffer()` on a lying server is a
 * worker OOM.
 */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<Buffer> {
    const body = response.body;
    if (!body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = (body as any).getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
            try { await reader.cancel(); } catch { /* already closing */ }
            throw new ImportRefusedError(`package exceeds the ${maxBytes}-byte import cap`, url);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
