import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import { createHash } from "node:crypto";
import type { EnhancedFactStore, FactStore } from "./facts-store.js";
import type { ArtifactStore } from "./session-store.js";

// ─── Knowledge Pipeline Namespace Access Control ────────────────────────────
const FACTS_MANAGER_AGENT_ID = "facts-manager";
const TUNER_AGENT_ID = "agent-tuner";
const RESERVED_WRITE_PREFIXES = ["skills/", "asks/", "config/facts-manager/"];
const RESERVED_READ_PREFIXES = ["intake/", "config/facts-manager/"];
const RESERVED_DELETE_PREFIXES = ["intake/", "skills/", "asks/", "config/facts-manager/"];

// Keys that belong to TOOLS, reachable only through the invocation-context
// facts accessor (tool-facts-accessor.ts). Unlike the lists above these have
// NO agent exemption: not the Facts Manager, not the tuner, not a crawler.
// `tools/` is built in; a host adds more with the worker option
// `reservedFactPrefixes`. Module-level so the read/search filters see them
// without threading a parameter through every closure; set once per
// createFactTools call (the worker's configuration does not change between
// sessions).
export const TOOL_PRIVATE_FACT_PREFIX = "tools/";
const DEFAULT_TOOL_ONLY_PREFIXES: readonly string[] = Object.freeze([TOOL_PRIVATE_FACT_PREFIX]);

export function normalizeToolOnlyPrefixes(extra?: readonly string[] | null): string[] {
    const out = new Set<string>([TOOL_PRIVATE_FACT_PREFIX]);
    for (const raw of extra ?? []) {
        const text = String(raw ?? "").trim().replace(/^\/+/, "");
        if (!text) continue;
        out.add(text.endsWith("/") ? text : `${text}/`);
    }
    return [...out];
}

function toolOnlyPrefixFor(key: string, toolOnly: readonly string[]): string | null {
    for (const prefix of toolOnly) if (key.startsWith(prefix)) return prefix;
    return null;
}

// PostgreSQL LIKE treats backslash as the escape character and the delete/
// read procs run LIKE without an ESCAPE clause, so `tools\/%` matches every
// key under `tools/` while its raw literal head (`tools\/`) matches no
// prefix check. Drop the escapes before any prefix comparison.
function normalizeLikeForPrefixCheck(pattern: string): string {
    return String(pattern || "").replace(/\\(.)/g, "$1").replace(/\*/g, "%");
}

function toolOnlyPrefixForPattern(pattern: string, toolOnly: readonly string[]): string | null {
    const normalized = normalizeLikeForPrefixCheck(pattern);
    for (const prefix of toolOnly) {
        if (normalized.startsWith(prefix) || normalized.startsWith(prefix.replace("/", "/%"))) return prefix;
        // A pattern whose literal head is a prefix of the reserved prefix
        // (e.g. "t%" or "%") would sweep it up too.
        if (patternTouchesPrefix(pattern, prefix)) return prefix;
    }
    return null;
}

function toolNamespaceError(prefix: string): string {
    return `Error: the '${prefix}' key namespace belongs to tools and is not readable or writable by agents.`;
}

/** True when `key` is under a tool-only prefix — stripped from every agent-facing read. */
export function isToolOnlyFactKey(key: string, toolOnly: readonly string[] = DEFAULT_TOOL_ONLY_PREFIXES): boolean {
    return toolOnlyPrefixFor(String(key || ""), toolOnly) !== null;
}

function boundedPreview(value: unknown, max = 80): string | undefined {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return undefined;
    return text.length > max ? text.slice(0, max) : text;
}

function normalizeNamespace(value: unknown): string | null {
    const text = typeof value === "string" ? value.trim().replace(/\/+$/g, "") : "";
    return text.length > 0 ? text : null;
}

function clampTags(tags: unknown): string[] | undefined {
    if (!Array.isArray(tags)) return undefined;
    const out = tags
        .map((tag) => typeof tag === "string" ? tag.trim() : "")
        .filter(Boolean)
        .slice(0, 20);
    return out.length > 0 ? out : undefined;
}

function checkNamespaceWrite(key: string, agentIdentity?: string, toolOnly: readonly string[] = DEFAULT_TOOL_ONLY_PREFIXES): string | null {
    if (agentIdentity === TUNER_AGENT_ID) {
        return "Error: agent-tuner sessions are read-only and cannot store facts.";
    }
    const toolPrefix = toolOnlyPrefixFor(key, toolOnly);
    if (toolPrefix) return toolNamespaceError(toolPrefix);
    for (const prefix of RESERVED_WRITE_PREFIXES) {
        if (key.startsWith(prefix) && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is reserved for the Facts Manager. ` +
                `Write observations to 'intake/<topic>/<your-session-id>' instead.`;
        }
    }
    return null;
}

// ─── Bulk ingestion (bulk_store_facts) ──────────────────────────────────────
// docs/proposals/bulk-facts-ingestion.md. The tool moves fact bytes from an
// artifact into the store without the model retyping them. NOT atomic: every
// record either commits or lands in the failure artifact with a reason. The
// failure artifact is valid input for a retry call — `_error` is written,
// never read.

const BULK_MAX_BYTES = 32 * 1024 * 1024;
const BULK_MAX_RECORDS = 50_000;
const BULK_CHUNK_SIZE = 500;
const BULK_SAMPLE_LIMIT = 5;

interface BulkRecordFailure {
    /** The original record, untouched (minus any incoming `_error`). */
    record: Record<string, unknown>;
    reason: string;
    message: string;
}

function sha256Utf8(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function boundedMessage(err: unknown, max = 300): string {
    const text = String((err as any)?.message ?? err ?? "unknown error");
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Parse artifact text into candidate records. Throws with a caller-readable
 * message on anything that makes the WHOLE payload unusable (bad JSON, not an
 * array, over caps) — per-record problems are the validator's job.
 */
function parseBulkRecords(text: string, sourceLabel: string): Array<Record<string, unknown>> {
    if (Buffer.byteLength(text, "utf8") > BULK_MAX_BYTES) {
        throw new Error(`${sourceLabel} is larger than the ${Math.floor(BULK_MAX_BYTES / (1024 * 1024))} MB bulk-ingestion cap. Split it into smaller artifacts and ingest each.`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`${sourceLabel} is not valid JSON: ${boundedMessage(err)}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`${sourceLabel} must be a JSON array of {key, value, tags?, shared?} records.`);
    }
    if (parsed.length > BULK_MAX_RECORDS) {
        throw new Error(`${sourceLabel} holds ${parsed.length} records; the bulk-ingestion cap is ${BULK_MAX_RECORDS} per call. Split it into smaller artifacts.`);
    }
    return parsed as Array<Record<string, unknown>>;
}

/**
 * Per-record validation, in check order. Returns a failure reason or null.
 * `_error` on the record is deliberately NOT examined — the failure artifact
 * of a previous call is valid input, and its annotations are ignored.
 */
function validateBulkRecord(
    record: unknown,
    opts: { toolOnlyPrefixes?: readonly string[]; agentIdentity?: string; keyPrefix?: string | null; sessionId?: string | null; seenScopeKeys: Set<string> },
): { reason: string; message: string } | null {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        return { reason: "invalid_shape", message: "record is not an object" };
    }
    const rec = record as Record<string, unknown>;
    if (typeof rec.key !== "string" || rec.key.length === 0) {
        return { reason: "invalid_shape", message: "key is missing or not a non-empty string" };
    }
    if (!("value" in rec)) {
        return { reason: "invalid_shape", message: "value is missing" };
    }
    if ("tags" in rec && rec.tags !== undefined && !Array.isArray(rec.tags)) {
        return { reason: "invalid_shape", message: "tags is present but not an array" };
    }
    const key = rec.key;
    if (key.startsWith("intake/")) {
        // intake/ is one observation per write BY DESIGN: each shared intake
        // wakes the Facts Manager for one curator turn, and the key schema
        // (intake/<topic>/<session-id>) self-overwrites in bulk anyway.
        // Applies to every intake/ key, shared or not — no edge cases.
        return {
            reason: "intake_requires_single_write",
            message: "intake/ observations are written one at a time with store_fact, never in bulk",
        };
    }
    const nsError = checkNamespaceWrite(key, opts.agentIdentity, opts.toolOnlyPrefixes);
    if (nsError) {
        return { reason: "namespace_denied", message: nsError };
    }
    if (opts.keyPrefix && !key.startsWith(opts.keyPrefix)) {
        return { reason: "prefix_violation", message: `key does not start with the required prefix "${opts.keyPrefix}"` };
    }
    const shared = rec.shared === true;
    if (!shared && !opts.sessionId) {
        return { reason: "missing_session", message: "session-scoped fact with no session id (set shared: true or call from a session)" };
    }
    const scopeKey = shared ? `shared:${key}` : `session:${opts.sessionId}:${key}`;
    if (opts.seenScopeKeys.has(scopeKey)) {
        // First occurrence wins; later ones fail. Order must never silently
        // pick a winner, and one PG statement cannot update a row twice.
        return { reason: "duplicate_key", message: "this scope key already appeared earlier in the input; the first occurrence was kept" };
    }
    opts.seenScopeKeys.add(scopeKey);
    return null;
}

/**
 * Write valid records in chunks through the ordinary storeFact path. A chunk
 * that throws is re-run one record at a time so the error lands on the record
 * that caused it. Observably identical to writing one at a time; a clean
 * payload costs records/BULK_CHUNK_SIZE round trips instead of records.
 */
async function writeBulkRecords(
    factStore: FactStore,
    entries: Array<{ record: Record<string, unknown>; index: number }>,
    ctx: { sessionId?: string | null; agentId?: string | null },
): Promise<{ committed: number; failures: Array<BulkRecordFailure & { index: number }> }> {
    const toInput = (record: Record<string, unknown>) => ({
        key: record.key as string,
        value: record.value,
        tags: (record.tags as string[] | undefined) ?? undefined,
        shared: record.shared === true,
        sessionId: ctx.sessionId ?? null,
        agentId: ctx.agentId ?? null,
    });
    let committed = 0;
    const failures: Array<BulkRecordFailure & { index: number }> = [];
    for (let start = 0; start < entries.length; start += BULK_CHUNK_SIZE) {
        const chunk = entries.slice(start, start + BULK_CHUNK_SIZE);
        try {
            const result = await factStore.storeFact(chunk.map((entry) => toInput(entry.record)));
            committed += result.stored;
        } catch {
            // Attribute the failure precisely: one record at a time.
            for (const entry of chunk) {
                try {
                    const single = await factStore.storeFact([toInput(entry.record)]);
                    committed += single.stored;
                } catch (err) {
                    failures.push({ record: entry.record, index: entry.index, reason: "db_error", message: boundedMessage(err) });
                }
            }
        }
    }
    return { committed, failures };
}

// A read pattern whose literal head is SHORTER than the reserved prefix
// ("%", "t%") sweeps the whole store; it is allowed and its results are
// stripped row by row. A pattern whose head reaches INTO the prefix
// ("tools/%", "tools/x/%") targets the namespace and is refused.
function patternIsBroaderThan(pattern: string, prefix: string): boolean {
    const normalized = normalizeLikeForPrefixCheck(pattern);
    const wildcardIndex = normalized.search(/[%_]/);
    const literalPrefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
    return literalPrefix.length < prefix.length && prefix.startsWith(literalPrefix);
}

function patternTouchesPrefix(pattern: string, prefix: string): boolean {
    const normalized = normalizeLikeForPrefixCheck(pattern);
    const wildcardIndex = normalized.search(/[%_]/);
    const literalPrefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
    return prefix.startsWith(literalPrefix) || literalPrefix.startsWith(prefix);
}

function checkNamespaceRead(keyPattern: string | undefined, agentIdentity?: string, toolOnly: readonly string[] = DEFAULT_TOOL_ONLY_PREFIXES): string | null {
    if (!keyPattern) return null;
    const toolPrefix = toolOnlyPrefixForPattern(keyPattern, toolOnly);
    if (toolPrefix && !patternIsBroaderThan(keyPattern, toolPrefix)) return toolNamespaceError(toolPrefix);
    // Normalize glob wildcards (and LIKE escapes) to SQL pattern for prefix check
    const normalized = normalizeLikeForPrefixCheck(keyPattern);
    for (const prefix of RESERVED_READ_PREFIXES) {
        if ((normalized.startsWith(prefix) || normalized.startsWith(prefix.replace("/", "/%"))) &&
            agentIdentity !== FACTS_MANAGER_AGENT_ID && agentIdentity !== TUNER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is not readable by task agents. ` +
                `Read curated skills from 'skills/' or open asks from 'asks/' instead.`;
        }
    }
    return null;
}

function checkNamespaceDelete(key: string, agentIdentity?: string, toolOnly: readonly string[] = DEFAULT_TOOL_ONLY_PREFIXES): string | null {
    if (agentIdentity === TUNER_AGENT_ID) {
        return "Error: agent-tuner sessions are read-only and cannot delete facts.";
    }
    const toolPrefix = toolOnlyPrefixFor(key, toolOnly);
    if (toolPrefix) return toolNamespaceError(toolPrefix);
    for (const prefix of RESERVED_DELETE_PREFIXES) {
        if (key.startsWith(prefix) && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is reserved. Only the Facts Manager can delete from it.`;
        }
    }
    return null;
}

function checkNamespaceDeletePattern(keyPattern: string, agentIdentity?: string, toolOnly: readonly string[] = DEFAULT_TOOL_ONLY_PREFIXES): string | null {
    if (agentIdentity === TUNER_AGENT_ID) {
        return "Error: agent-tuner sessions are read-only and cannot delete facts.";
    }
    // Any pattern that could touch a tool-only key is refused outright: a
    // pattern delete has no per-row filter to strip them afterwards.
    for (const prefix of toolOnly) {
        if (patternTouchesPrefix(keyPattern, prefix)) return toolNamespaceError(prefix);
    }
    for (const prefix of RESERVED_DELETE_PREFIXES) {
        if (patternTouchesPrefix(keyPattern, prefix) && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is reserved. Only the Facts Manager can delete from it.`;
        }
    }
    return null;
}

export function createFactTools(opts: {
    factStore: FactStore;
    getDescendantSessionIds?: (sessionId: string) => Promise<string[]>;
    getLineageSessionIds?: (sessionId: string) => Promise<string[]>;
    agentIdentity?: string;
    /** Internal: app-assigned crawler role, derived from bound agent metadata. */
    isCrawler?: boolean;
    /** @deprecated Use `isCrawler`; accepted as a compatibility alias. */
    isHarvester?: boolean;
    /**
     * Optional fire-and-forget hook invoked from inside tool handlers when
     * a `read_facts` call touches the `skills/` knowledge namespace. Used
     * by SessionManager to record `learned_skill.read` CMS events for
     * skill-usage stats. Errors are swallowed; tool behavior is unaffected.
     */
    recordEvent?: (sessionId: string, eventType: string, data: unknown) => Promise<void>;
    /** Optional hook invoked after a successful shared intake/* write. */
    onSharedIntakeFactStored?: (input: { key: string; sourceSessionId: string | null; agentId: string | null }) => Promise<void>;
    /**
     * Artifact store for bulk_store_facts (artifact-sourced ingestion and the
     * failure artifact). Absent ⇒ the tool still registers, but only inline
     * `facts` work and `to_file` is refused with a clear message.
     */
    artifactStore?: ArtifactStore | null;
    /**
     * When the store is an EnhancedFactStore (search capability), the search
     * tools (`facts_search`, `facts_similar`) and the skills-scoped
     * `search_skills` pull tool are appended (enhancedfactstore 07 P4/§1.6).
     * `search_skills` is omitted for the facts-manager (it owns the namespace).
     */
    enhancedFactStore?: EnhancedFactStore;
    /**
     * Host-reserved key prefixes, kept from every agent like `tools/` is
     * (worker option `reservedFactPrefixes`). Reachable only through the
     * invocation-context facts accessor.
     */
    reservedFactPrefixes?: readonly string[] | null;
}): Tool<any>[] {
    const { factStore, getDescendantSessionIds, getLineageSessionIds, agentIdentity, recordEvent, onSharedIntakeFactStored, enhancedFactStore, artifactStore } = opts;
    // Per call, never module-level: two workers in one process, or a later
    // createFactTools call without the option, must not change this set.
    const toolOnly = normalizeToolOnlyPrefixes(opts.reservedFactPrefixes);
    const isCrawler = opts.isCrawler === true || opts.isHarvester === true;
    const isFactsManager = agentIdentity === FACTS_MANAGER_AGENT_ID;
    const isTuner = agentIdentity === TUNER_AGENT_ID;
    const canReadAllFacts = isCrawler || isFactsManager || isTuner;

    const recordRetrievalEvent = (sessionId: string | undefined, eventType: string, data: Record<string, unknown>) => {
        if (!recordEvent || !sessionId) return;
        recordEvent(sessionId, eventType, {
            ...data,
            callerAgentId: agentIdentity ?? null,
        }).catch(() => { /* swallow — best-effort telemetry */ });
    };

    const filterReservedReadFacts = (result: any) => {
        if (!result || !Array.isArray(result.facts)) return result;
        const exempt = isFactsManager || isTuner;
        const facts = result.facts.filter((fact: any) => {
            const key = String(fact?.key || "");
            if (isToolOnlyFactKey(key, toolOnly)) return false;   // no exemption
            if (exempt) return true;
            return !RESERVED_READ_PREFIXES.some((prefix) => key.startsWith(prefix));
        });
        return {
            ...result,
            facts,
            count: facts.length,
        };
    };

    const storeTool = defineTool("store_fact", {
        description:
            "Store one fact or a batch of facts in the facts table for durable structured memory. " +
            "Facts are session-scoped by default, visible to every session in the same spawn tree (ancestors, descendants, siblings, cousins — anything spawned from a common root), and are deleted when the session is deleted. " +
            "Set shared=true to create shared durable memory visible across all sessions globally; shared facts persist until explicitly deleted. " +
            "A small batch may be passed as facts=[{key,value,tags?,shared?}, ...] (all-or-nothing). " +
            "For LARGE ingestion — hundreds of facts or more, or facts already sitting in an artifact — use bulk_store_facts instead: it reads the records from the artifact so their bytes never pass through your context.",
        parameters: {
            type: "object" as const,
            properties: {
                key: {
                    type: "string",
                    description: "Fact key, for example 'baseline/tps' or 'infra/server/fqdn'.",
                },
                value: {
                    description: "JSON-serializable fact value.",
                },
                tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional tags for querying related facts later.",
                },
                shared: {
                    type: "boolean",
                    description: "If true, store as shared global knowledge visible across sessions. Default: false.",
                },
                facts: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            key: { type: "string" },
                            value: {},
                            tags: { type: "array", items: { type: "string" } },
                            shared: { type: "boolean" },
                        },
                        required: ["key", "value"],
                    },
                    description: "Optional batch of facts to store. When provided, top-level key/value are ignored.",
                },
            },
        },
        handler: async (
            args: { key?: string; value?: unknown; tags?: string[]; shared?: boolean; facts?: Array<{ key: string; value: unknown; tags?: string[]; shared?: boolean }> },
            ctx?: { sessionId?: string; agentId?: string },
        ) => {
            const factInputs = Array.isArray(args.facts) && args.facts.length > 0
                ? args.facts
                : (typeof args.key === "string" && "value" in args ? [{ key: args.key, value: args.value, tags: args.tags, shared: args.shared }] : []);
            if (factInputs.length === 0) return { error: "Error: store_fact requires either { key, value } or facts=[{ key, value }, ...]." };
            for (const fact of factInputs) {
                const nsError = checkNamespaceWrite(fact.key, agentIdentity, toolOnly);
                if (nsError) return { error: nsError };
            }

            const result = await factStore.storeFact(factInputs.map((fact) => ({
                key: fact.key,
                value: fact.value,
                tags: fact.tags,
                shared: fact.shared,
                sessionId: ctx?.sessionId ?? null,
                agentId: ctx?.agentId ?? null,
            })));
            for (const fact of result.facts) {
                if (fact.shared && fact.key.startsWith("intake/") && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
                    await onSharedIntakeFactStored?.({
                        key: fact.key,
                        sourceSessionId: ctx?.sessionId ?? null,
                        agentId: ctx?.agentId ?? null,
                    }).catch(() => {});
                }
            }
            if (result.facts.length === 1) {
                const fact = result.facts[0];
                return { ...fact, scope: fact.shared ? "shared" : "session" };
            }
            return {
                stored: result.stored,
                facts: result.facts.map((fact) => ({ ...fact, scope: fact.shared ? "shared" : "session" })),
            };
        },
    });

    const bulkStoreTool = defineTool("bulk_store_facts", {
        description:
            "Bulk-ingest facts from an artifact (or an inline array) with per-record failure accounting. " +
            "NOT atomic: every record either commits or is written to the failure artifact with a reason — " +
            "no record is left unexplained. The failure artifact is VALID INPUT for a retry call (its _error " +
            "annotations are ignored on read), so the retry loop is: ingest apply.json → failures land in " +
            "to_file → feed that file back → repeat until failed_count stops dropping. Records already " +
            "committed re-ingest harmlessly (idempotent upsert by key). " +
            "Records are [{key, value, tags?, shared?}]. intake/* keys are refused per record — observations " +
            "are written one at a time with store_fact, never in bulk. " +
            `Caps: ${Math.floor(BULK_MAX_BYTES / (1024 * 1024))} MB / ${BULK_MAX_RECORDS} records per call.`,
        parameters: {
            type: "object" as const,
            properties: {
                facts: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            key: { type: "string" },
                            value: {},
                            tags: { type: "array", items: { type: "string" } },
                            shared: { type: "boolean" },
                        },
                        required: ["key", "value"],
                    },
                    description: "Inline records. Use `from` instead whenever the records already live in an artifact.",
                },
                from: {
                    type: "object",
                    properties: {
                        filename: { type: "string", description: "Artifact holding the JSON array of records." },
                        session_id: { type: "string", description: "Session owning the artifact. Defaults to this session." },
                        expected_sha256: { type: "string", description: "Refuse the whole call (nothing written) if the artifact bytes hash differently. Pass the sha256 write_artifact returned." },
                    },
                    required: ["filename"],
                    description: "Read records from an artifact instead of inline. Exactly one of `facts`/`from`.",
                },
                to_file: {
                    type: "string",
                    description: "Artifact filename (this session) to write failed records to. Always overwritten — [] when nothing failed. The file is valid input for a retry call.",
                },
                key_prefix: {
                    type: "string",
                    description: "Every key must start with this prefix; records that do not fail with prefix_violation.",
                },
                expected_count: {
                    type: "number",
                    description: "Refuse the whole call (nothing written) unless the parsed record count equals this.",
                },
            },
        },
        handler: async (
            args: {
                facts?: Array<Record<string, unknown>>;
                from?: { filename: string; session_id?: string; expected_sha256?: string };
                to_file?: string;
                key_prefix?: string;
                expected_count?: number;
            },
            ctx?: { sessionId?: string; agentId?: string },
        ) => {
            // Identity prohibitions are call-level: the tuner may not write
            // facts at all, and thousands of identical per-record failures
            // would be noise, not accounting.
            if (agentIdentity === TUNER_AGENT_ID) {
                return { error: "Error: agent-tuner sessions are read-only and cannot store facts." };
            }
            const hasInline = Array.isArray(args.facts);
            const hasFrom = args.from != null && typeof args.from === "object";
            if (hasInline === hasFrom) {
                return { error: "Error: bulk_store_facts requires exactly one source — inline `facts` or `from: {filename}`." };
            }
            if ((hasFrom || args.to_file) && !artifactStore) {
                return { error: "Error: this deployment has no artifact store; bulk_store_facts can only take inline `facts` without `to_file` here." };
            }
            if (args.to_file && !ctx?.sessionId) {
                return { error: "Error: to_file requires a session context to own the failure artifact." };
            }

            // ── Acquire the records ─────────────────────────────────
            let records: Array<Record<string, unknown>>;
            let source: string;
            let sha256: string;
            if (hasFrom) {
                const from = args.from!;
                const filename = String(from.filename || "").trim();
                if (!filename) return { error: "Error: from.filename is required." };
                // Store-side cross-session read — the same worker-trusted
                // stance as draw_canvas fromArtifact and read_artifact.
                const sourceSessionId = String(from.session_id || ctx?.sessionId || "").trim();
                if (!sourceSessionId) return { error: "Error: from.session_id is required when there is no session context." };
                let text: string;
                try {
                    // Raw bytes, not downloadArtifactText: large apply
                    // artifacts are legitimately uploaded under a binary
                    // content type (the text-artifact cap is 1 MB; binary is
                    // 10 MB, env-tunable) and the text reader refuses those.
                    // JSON is JSON either way — decode utf8 ourselves.
                    const result = await artifactStore!.downloadArtifact(sourceSessionId, filename);
                    const body = Buffer.isBuffer((result as any).body) ? (result as any).body : Buffer.from((result as any).body ?? "");
                    // Cap on the RAW bytes, before decode and hashing: the
                    // artifact store admits files far larger than the bulk cap,
                    // and decoding one to a JS string first would triple the
                    // peak memory of a call that is about to be refused anyway.
                    if (body.length > BULK_MAX_BYTES) {
                        return { error: `Error: artifact ${filename} is ${body.length} bytes, over the ${Math.floor(BULK_MAX_BYTES / (1024 * 1024))} MB bulk-ingestion cap; nothing was written. Split it into smaller artifacts and ingest each.` };
                    }
                    text = body.toString("utf8");
                } catch (err) {
                    return { error: `Error: could not read artifact ${filename} from session ${sourceSessionId}: ${boundedMessage(err)}` };
                }
                sha256 = sha256Utf8(text);
                if (from.expected_sha256 && sha256 !== from.expected_sha256) {
                    return { error: `SHA_MISMATCH: artifact ${filename} hashes ${sha256}, expected ${from.expected_sha256}; nothing was written.` };
                }
                try {
                    records = parseBulkRecords(text, `artifact ${filename}`);
                } catch (err) {
                    return { error: `Error: ${boundedMessage(err, 500)}` };
                }
                source = filename;
            } else {
                const inlineText = JSON.stringify(args.facts);
                sha256 = sha256Utf8(inlineText);
                try {
                    records = parseBulkRecords(inlineText, "inline facts");
                } catch (err) {
                    return { error: `Error: ${boundedMessage(err, 500)}` };
                }
                source = "inline";
            }
            if (typeof args.expected_count === "number" && records.length !== args.expected_count) {
                return { error: `Error: expected_count is ${args.expected_count} but the input holds ${records.length} records; nothing was written.` };
            }

            // ── Validate per record ─────────────────────────────────
            const keyPrefix = typeof args.key_prefix === "string" && args.key_prefix.length > 0 ? args.key_prefix : null;
            const seenScopeKeys = new Set<string>();
            const valid: Array<{ record: Record<string, unknown>; index: number }> = [];
            const failures: Array<BulkRecordFailure & { index: number }> = [];
            records.forEach((record, index) => {
                const failure = validateBulkRecord(record, {
                    agentIdentity,
                    toolOnlyPrefixes: toolOnly,
                    keyPrefix,
                    sessionId: ctx?.sessionId ?? null,
                    seenScopeKeys,
                });
                if (failure) {
                    // The failure artifact must be valid input: keep the record
                    // as written, minus any stale annotation from a prior run.
                    const { _error: _stale, ...original } = (record && typeof record === "object" && !Array.isArray(record) ? record : { value: record }) as Record<string, unknown>;
                    failures.push({ record: original, index, reason: failure.reason, message: failure.message });
                } else {
                    valid.push({ record, index });
                }
            });

            // ── Write ───────────────────────────────────────────────
            const written = await writeBulkRecords(factStore, valid, {
                sessionId: ctx?.sessionId ?? null,
                agentId: ctx?.agentId ?? null,
            });
            for (const failure of written.failures) {
                const { _error: _stale, ...original } = failure.record;
                failures.push({ ...failure, record: original });
            }
            failures.sort((a, b) => a.index - b.index);

            // ── Failure artifact ────────────────────────────────────
            let failedArtifact: string | null = null;
            let failedArtifactError: string | undefined;
            if (args.to_file) {
                // Compact, and under a BINARY content type: the artifact
                // store caps text artifacts at 1 MB, while failure sets
                // legitimately mirror multi-megabyte apply artifacts. The
                // retry read path above decodes raw bytes itself, so the
                // loop keeps working at the same sizes it accepts as input.
                const body = JSON.stringify(
                    failures.map(({ record, reason, message }) => ({ ...record, _error: { reason, message } })),
                );
                try {
                    await artifactStore!.uploadArtifact(ctx!.sessionId!, args.to_file, body, "application/octet-stream");
                    failedArtifact = args.to_file;
                } catch (err) {
                    // Commits already happened; the receipt must still be
                    // truthful. Surface the sink failure without failing the call.
                    failedArtifactError = boundedMessage(err);
                }
            }

            return {
                accepted_count: records.length,
                committed_count: written.committed,
                failed_count: failures.length,
                failed_artifact: failedArtifact,
                ...(failedArtifactError ? { failed_artifact_error: failedArtifactError } : {}),
                ...(failures.length > 0
                    ? {
                        failed_sample: failures.slice(0, BULK_SAMPLE_LIMIT).map(({ record, reason, message }) => ({
                            key: typeof record.key === "string" ? record.key : null,
                            reason,
                            message,
                        })),
                    }
                    : {}),
                source,
                sha256,
            };
        },
    });

    const readTool = defineTool("read_facts", {
        description:
            "Read durable facts. By default this returns facts accessible to you now: your current session's facts, plus all session-scoped facts from any other session in the same spawn tree (ancestors, descendants, siblings, cousins), plus globally-shared facts. " +
            "Use scope='shared' to read only globally-shared facts. " +
            "Use scope='descendants' as an explicit family-tree view of spawn-tree facts (same visibility as the default).",
        parameters: {
            type: "object" as const,
            properties: {
                key_pattern: {
                    type: "string",
                    description:
                        "Optional key pattern. Supports SQL '%' wildcards or '*' globs, for example 'baseline/%' or 'infra/*'.",
                },
                tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional tags filter. All listed tags must be present.",
                },
                session_id: {
                    type: "string",
                    description:
                        "Filter by source session. When targeting any session in your spawn tree (ancestor, descendant, sibling, cousin), its session-scoped facts become visible automatically.",
                },
                agent_id: {
                    type: "string",
                    description: "Optional provenance filter for the agent that stored the fact.",
                },
                limit: {
                    type: "number",
                    description: "Maximum number of rows to return. Default: 50.",
                },
                scope: {
                    type: "string",
                    enum: ["accessible", "shared", "session", "descendants", "all"],
                    description:
                        "accessible = current session facts + spawn-tree facts (ancestors, descendants, siblings, cousins) + globally-shared facts (default). " +
                        "shared = globally-shared facts only. " +
                        "session = current session facts only. " +
                        "descendants = same spawn-tree visibility as accessible, kept as an explicit family-tree view. " +
                        "all = privileged broad read across shared and non-shared facts for crawler/facts-manager/tuner sessions only; curation namespaces remain excluded for crawlers.",
                },
            },
        },
        handler: async (
            args: {
                key_pattern?: string;
                tags?: string[];
                session_id?: string;
                agent_id?: string;
                limit?: number;
                scope?: "accessible" | "shared" | "session" | "descendants" | "all";
            },
            ctx?: { sessionId?: string },
        ) => {
            if (args.scope === "all" && !canReadAllFacts) {
                return { error: "Error: read_facts scope='all' is reserved for crawler, facts-manager, and agent-tuner sessions." };
            }
            const nsError = checkNamespaceRead(args.key_pattern, agentIdentity, toolOnly);
            if (nsError) return { error: nsError };

            // Normalize session_id: LLM may pass orchId format "session-<uuid>"
            // but facts and CMS store raw UUIDs.
            const targetSessionId = args.session_id?.startsWith("session-")
                ? args.session_id.slice("session-".length)
                : args.session_id;

            // Tuner is read-only at the namespace level (write/delete gates
            // already block it) but its job is to investigate ANY session,
            // not just its own lineage. Bypass the visibility filter for it
            // — optional filters (key_pattern, session_id, agent_id, tags)
            // still apply so queries remain targeted.
            const unrestrictedRead = isTuner || args.scope === "all";

            let lineageSessionIds: string[] = [];
            let grantedSessionIds: string[] = [];

            if (!unrestrictedRead && ctx?.sessionId) {
                const rawLineageSessionIds = getLineageSessionIds
                    ? await getLineageSessionIds(ctx.sessionId)
                    : getDescendantSessionIds
                        ? await getDescendantSessionIds(ctx.sessionId)
                        : [];
                lineageSessionIds = [...new Set((rawLineageSessionIds || []).filter((sessionId) => (
                    Boolean(sessionId) && sessionId !== ctx.sessionId
                )))];

                if (args.scope === "accessible" || args.scope === "descendants" || !args.scope) {
                    grantedSessionIds = lineageSessionIds;
                }

                if (targetSessionId && targetSessionId !== ctx.sessionId) {
                    grantedSessionIds = lineageSessionIds.includes(targetSessionId)
                        ? [targetSessionId]
                        : [];
                }
            }

            // Determine effective scope: if we've granted lineage access,
            // force "accessible" so the visibility clause includes granted IDs.
            let effectiveScope: "accessible" | "shared" | "session" | "descendants" | undefined = args.scope === "all" ? "accessible" : args.scope;
            if (effectiveScope === "descendants" || grantedSessionIds.length > 0) {
                effectiveScope = "accessible";
            }

            return factStore.readFacts({
                keyPattern: args.key_pattern,
                tags: args.tags,
                sessionId: targetSessionId,
                agentId: args.agent_id,
                limit: args.limit,
                scope: effectiveScope,
            }, {
                readerSessionId: ctx?.sessionId ?? null,
                grantedSessionIds,
                unrestricted: unrestrictedRead,
            }).then((result) => {
                // Emit a learned_skill.read event when the call touched the
                // `skills/` knowledge namespace. Single event per call — we
                // log the request shape, not the per-fact fan-out. Best-effort.
                if (recordEvent && ctx?.sessionId) {
                    const pattern = args.key_pattern ?? "";
                    const normalizedPattern = pattern.replace(/\*/g, "%");
                    if (normalizedPattern.startsWith("skills/")) {
                        recordEvent(ctx.sessionId, "learned_skill.read", {
                            name: pattern,
                            scope: effectiveScope ?? args.scope ?? "accessible",
                            matchCount: result.count,
                            limit: args.limit ?? 50,
                            callerSessionId: ctx.sessionId,
                            callerAgentId: agentIdentity ?? null,
                        }).catch(() => { /* swallow — best-effort */ });
                    }
                }
                return filterReservedReadFacts(result);
            });
        },
    });

    const deleteTool = defineTool("delete_fact", {
        description:
            "Delete facts. By default this deletes the current session's fact for the given exact key. " +
            "Set shared=true to delete the shared durable fact with that key instead. " +
            "For pattern deletes, set pattern=true and pass a key glob such as 'a/b/*'. Pattern deletes are explicit and never enabled by accident.",
        parameters: {
            type: "object" as const,
            properties: {
                key: {
                    type: "string",
                    description: "Fact key to delete.",
                },
                shared: {
                    type: "boolean",
                    description: "If true, delete the shared fact. Otherwise delete the current session's fact.",
                },
                pattern: {
                    type: "boolean",
                    description: "Required true to treat key as a pattern. Supports '*' globs or SQL '%' wildcards.",
                },
                scope: {
                    type: "string",
                    enum: ["session", "shared", "all"],
                    description: "Pattern-delete scope. session=current session only, shared=shared facts only, all=crawler/facts-manager unrestricted cleanup (reserved namespaces still protected for crawlers).",
                },
            },
            required: ["key"] as const,
        },
        handler: async (
            args: { key: string; shared?: boolean; pattern?: boolean; scope?: "session" | "shared" | "all" },
            ctx?: { sessionId?: string },
        ) => {
            const nsError = args.pattern
                ? checkNamespaceDeletePattern(args.key, agentIdentity, toolOnly)
                : checkNamespaceDelete(args.key, agentIdentity, toolOnly);
            if (nsError) return { error: nsError };

            if (args.pattern) {
                const scope = args.scope ?? (args.shared === true ? "shared" : "session");
                if (scope === "all" && !(isFactsManager || isCrawler)) {
                    return { error: "Error: delete_fact scope='all' is reserved for crawler and facts-manager sessions." };
                }
                return factStore.deleteFact({
                    key: args.key,
                    pattern: true,
                    scope,
                    sessionId: ctx?.sessionId ?? null,
                    unrestricted: scope === "all" && (isFactsManager || isCrawler),
                });
            }

            return factStore.deleteFact({
                key: args.key,
                shared: args.shared,
                sessionId: ctx?.sessionId ?? null,
            });
        },
    });

    const managerTools: Tool<any>[] = [];
    if (agentIdentity === FACTS_MANAGER_AGENT_ID) {
        managerTools.push(defineTool("facts_tombstone_stats", {
            description:
                "Read soft-deleted fact tombstone backlog stats. Use during Facts Manager maintenance to monitor " +
                "whether graph reconciliation is keeping up before the TTL backstop purges unresolved tombstones.",
            parameters: {
                type: "object" as const,
                properties: {
                    ttlSeconds: { type: "number", description: "Tombstone TTL in seconds. Default 21600 (6h)." },
                },
            },
            handler: async (a: { ttlSeconds?: number }) => factStore.getFactsTombstoneStats(a.ttlSeconds),
        }));

        managerTools.push(defineTool("facts_purge_tombstones", {
            description:
                "Hard-delete soft-deleted facts that are either already reconciled (last_crawled_at set) or older than the TTL. " +
                "Use during the Facts Manager maintenance pass. ttlSeconds=0 purges all tombstones on this pass.",
            parameters: {
                type: "object" as const,
                properties: {
                    ttlSeconds: { type: "number", description: "Tombstone TTL in seconds. Default 21600 (6h). Use 0 only when no crawler is running." },
                    limit: { type: "number", description: "Maximum rows to purge in this call. Default 1000." },
                },
            },
            handler: async (a: { ttlSeconds?: number; limit?: number }) => ({
                purged: await factStore.purgeExpiredFacts(a.ttlSeconds ?? 21_600, a.limit),
            }),
        }));

        managerTools.push(defineTool("facts_force_purge", {
            description:
                "Dangerous operator-directed cleanup: hard-delete soft-deleted facts older than a cutoff, regardless of TTL or graph reconciliation. " +
                "This can strand graph evidence for unreconciled tombstones. Requires confirm=true and never deletes live facts.",
            parameters: {
                type: "object" as const,
                properties: {
                    cutoff: { type: "string", description: "ISO timestamp. Tombstones older than this are eligible." },
                    onlyUnreconciled: { type: "boolean", description: "If true, purge only tombstones with last_crawled_at IS NULL." },
                    keyPrefix: { type: "string", description: "Optional literal fact-key prefix to bound the purge." },
                    limit: { type: "number", description: "Maximum rows to purge in this call. Default 1000." },
                    confirm: { type: "boolean", description: "Must be true to execute this destructive bypass." },
                },
                required: ["cutoff", "confirm"] as const,
            },
            handler: async (a: { cutoff: string; onlyUnreconciled?: boolean; keyPrefix?: string; limit?: number; confirm?: boolean }) => {
                if (a.confirm !== true) {
                    return { error: "facts_force_purge requires confirm=true because it can strand graph evidence." };
                }
                const cutoff = new Date(a.cutoff);
                if (!Number.isFinite(cutoff.getTime())) {
                    return { error: "facts_force_purge cutoff must be a valid ISO timestamp." };
                }
                return {
                    purged: await factStore.forcePurgeFacts({
                        cutoff,
                        onlyUnreconciled: a.onlyUnreconciled,
                        keyPrefix: a.keyPrefix,
                        limit: a.limit,
                    }),
                };
            },
        }));
    }

    const enhancedTools: Tool<any>[] = [];
    if (enhancedFactStore && enhancedFactStore.capabilities.search) {
        const isPrivilegedSearchReader = isTuner || isCrawler || isFactsManager;
        // Resolve the SAME lineage visibility read_facts uses: the tuner is an
        // unrestricted investigator; everyone else sees their own session plus
        // granted lineage sessions (ancestors/descendants). FAIL CLOSED — with
        // no lineage resolver, a non-tuner sees only its own session.
        const resolveSearchAccess = async (ctx?: { sessionId?: string }) => {
            if (isPrivilegedSearchReader) return { readerSessionId: ctx?.sessionId ?? null, grantedSessionIds: [] as string[], unrestricted: true };
            let granted: string[] = [];
            if (ctx?.sessionId && getLineageSessionIds) {
                const raw = await getLineageSessionIds(ctx.sessionId);
                granted = [...new Set((raw || []).filter((sid) => Boolean(sid) && sid !== ctx.sessionId))];
            } else if (ctx?.sessionId && getDescendantSessionIds) {
                const raw = await getDescendantSessionIds(ctx.sessionId);
                granted = [...new Set((raw || []).filter((sid) => Boolean(sid) && sid !== ctx.sessionId))];
            }
            return { readerSessionId: ctx?.sessionId ?? null, grantedSessionIds: granted, unrestricted: false };
        };

        // Reserved-namespace gate for SEARCH — the same rule read_facts enforces.
        // Without this, facts_search/facts_similar would be a hole around the
        // intake/* (and skills/asks-write) ACL: a task agent could query
        // namespace:"intake" or a broad term and receive reserved values.
        // Note: the `namespace` arg is a bare key PREFIX (e.g. "intake", not
        // "intake/*"), so match it against the reserved prefixes' leading
        // segment as well as the slash form checkNamespaceRead expects.
        const blockReservedSearch = (namespace?: string) => {
            if (!namespace) return null;
            const ns = namespace.replace(/\/+$/, "");
            for (const p of toolOnly) {
                const seg = p.replace(/\/+$/, "");
                if (ns === seg || ns.startsWith(seg + "/")) return toolNamespaceError(p);
            }
            if (isFactsManager || isTuner) return null;
            const hitsReserved = RESERVED_READ_PREFIXES.some((p) => {
                const seg = p.replace(/\/+$/, "");
                return ns === seg || ns.startsWith(seg + "/") || seg.startsWith(ns + "/");
            });
            if (hitsReserved) {
                return `Error: the '${ns}' key namespace is not readable by task agents. ` +
                    `Search curated skills (namespace 'skills') or open asks (namespace 'asks') instead.`;
            }
            // Fall back to the shared slash-form check for any other shape.
            return checkNamespaceRead(namespace, agentIdentity, toolOnly);
        };
        const stripReserved = (result: any) => {
            if (!result || !Array.isArray(result.facts)) return result;
            const exempt = isFactsManager || isTuner;
            const facts = result.facts.filter((f: any) => {
                const key = String(f?.key || "");
                if (isToolOnlyFactKey(key, toolOnly)) return false;   // no exemption
                return exempt || !RESERVED_READ_PREFIXES.some((p) => key.startsWith(p));
            });
            return { ...result, count: facts.length, facts };
        };

        enhancedTools.push(defineTool("facts_search", {
            description:
                "Search your durable facts/memory by relevance (lexical / semantic / hybrid) — often more effective " +
                "than read_facts, which only matches literal keys. Mode selection is independent of graph namespace " +
                "discovery: semantic = natural-language questions; hybrid = a one-shot recheck when semantic hits " +
                "are weak; lexical = exact identifiers, error codes, proper nouns, quoted phrases, or single exact terms. " +
                "If a namespace is already known, pass it here. Returned scopeKey values can seed graph_search_nodes.",
            parameters: {
                type: "object" as const,
                properties: {
                    query: { type: "string", description: "Keywords for lexical, natural language for semantic, keyword-rich phrase for hybrid." },
                    mode: { type: "string", enum: ["lexical", "semantic", "hybrid"], description: "Default semantic when semantic search is available; use hybrid as a weak-semantic recheck and lexical for exact tokens." },
                    namespace: { type: "string", description: "Key-prefix filter over fact keys, matched as '<prefix>/%'. Accepts ANY number of '/'-delimited segments: a reserved namespace ('skills', 'asks') or a domain root ('acme', 'acme/services') to scope a multi-domain corpus to one domain/sub-domain before lexical/semantic/hybrid ranking." },
                    tags: { type: "array", items: { type: "string" } },
                    limit: { type: "number", description: "Max results (default 20)." },
                },
                required: ["query"] as const,
            },
            handler: async (a: { query: string; mode?: any; namespace?: string; tags?: string[]; limit?: number }, ctx?: { sessionId?: string }) => {
                const nsError = blockReservedSearch(a.namespace);
                if (nsError) return { error: nsError };
                const startedAt = Date.now();
                const access = await resolveSearchAccess(ctx);
                const result = stripReserved(await enhancedFactStore.searchFacts(a.query, { mode: a.mode, namespace: a.namespace, tags: a.tags, limit: a.limit }, access));
                recordRetrievalEvent(ctx?.sessionId, "facts.searched", {
                    operation: "facts_search",
                    queryPreview: boundedPreview(a.query),
                    mode: a.mode ?? null,
                    namespace: normalizeNamespace(a.namespace),
                    tags: clampTags(a.tags),
                    limit: a.limit ?? 20,
                    resultCount: Number(result?.count ?? result?.facts?.length ?? 0),
                    durationMs: Date.now() - startedAt,
                });
                return result;
            },
        }));

        enhancedTools.push(defineTool("facts_similar", {
            description:
                "Given a fact you already have, return the semantically nearest other facts (vector kNN over the " +
                "fact's stored embedding — no query text, no re-embedding). Use for clustering, dedup hunting, or " +
                "expanding context around a known fact. Pass namespace to restrict candidates to a fact key-prefix " +
                "subtree before nearest-neighbour ranking, using the same semantics as facts_search.",
            parameters: {
                type: "object" as const,
                properties: {
                    scopeKey: { type: "string", description: "The anchor fact's scopeKey." },
                    namespace: {
                        type: "string",
                        description:
                            "Optional key-prefix filter over candidate fact keys, matched as '<prefix>/%'. Accepts any number of '/'-delimited segments, e.g. 'skills' or 'corpus/acme/services'.",
                    },
                    k: { type: "number", description: "Top-k neighbours (default 8)." },
                    minScore: { type: "number", description: "Drop neighbours below this cosine score (0..1)." },
                },
                required: ["scopeKey"] as const,
            },
            handler: async (a: { scopeKey: string; namespace?: string; k?: number; minScore?: number }, ctx?: { sessionId?: string }) => {
                const nsError = blockReservedSearch(a.namespace);
                if (nsError) return { error: nsError };
                const startedAt = Date.now();
                const access = await resolveSearchAccess(ctx);
                const result = await enhancedFactStore.similarFacts(a.scopeKey, { k: a.k, minScore: a.minScore, namespace: a.namespace }, access);
                // Post-filter reserved keys — similarFacts has no namespace arg, so
                // a kNN from an accessible anchor could still surface reserved
                // near-neighbours for a task agent when namespace is broad/omitted.
                const filtered = stripReserved(result);
                recordRetrievalEvent(ctx?.sessionId, "facts.similar", {
                    operation: "facts_similar",
                    scopeKey: a.scopeKey,
                    namespace: normalizeNamespace(a.namespace),
                    k: a.k ?? 8,
                    minScore: a.minScore ?? null,
                    resultCount: Number(filtered?.count ?? filtered?.facts?.length ?? 0),
                    durationMs: Date.now() - startedAt,
                });
                return filtered;
            },
        }));

        // search_skills — skills-scoped pull (07 §1.6). The facts-manager owns the
        // skills namespace and curates it directly, so it does not get this tool.
        if (agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            enhancedTools.push(defineTool("search_skills", {
                description:
                    "Find the curated skills most relevant to your current task (ranked semantic + lexical search " +
                    "over the shared 'skills' namespace). Call this at the start of a turn with a task-derived query " +
                    "(e.g. 'azure deployments', 'horizondb connection errors', 'terraform s3 backend') — as many times " +
                    "as needed for different facets. Returns ranked skill hints; load a skill's full instructions with " +
                    "read_facts(key_pattern=\"<key>\", scope=\"shared\") before applying it.",
                parameters: {
                    type: "object" as const,
                    properties: {
                        query: { type: "string", description: "What the task is about (natural language or keywords)." },
                        limit: { type: "number", description: "Max skill hints (default 8)." },
                    },
                    required: ["query"] as const,
                },
                handler: async (a: { query: string; limit?: number }, ctx?: { sessionId?: string }) => {
                    const startedAt = Date.now();
                    // Skills are SHARED + curated; access is the shared scope (no
                    // private-session leakage possible — namespace is pinned to
                    // 'skills' and scope to 'shared').
                    const access = await resolveSearchAccess(ctx);
                    const res = await enhancedFactStore.searchFacts(
                        a.query,
                        { mode: "hybrid", namespace: "skills", scope: "shared", limit: a.limit ?? 8 },
                        access,
                    );
                    // Hint shape only — the agent loads full content via read_facts.
                    const out = {
                        count: res.count,
                        skills: res.facts.map((f: any) => {
                            const v = typeof f.value === "string" ? safeParse(f.value) : f.value;
                            return { key: f.key, name: v?.name ?? f.key, description: v?.description ?? "", score: f.score };
                        }),
                    };
                    recordRetrievalEvent(ctx?.sessionId, "skills.searched", {
                        operation: "search_skills",
                        queryPreview: boundedPreview(a.query),
                        mode: "hybrid",
                        namespace: "skills",
                        limit: a.limit ?? 8,
                        resultCount: Number(out.count ?? 0),
                        durationMs: Date.now() - startedAt,
                    });
                    return out;
                },
            }));
        }
    }

    // ── manage_embedder — durable embedder lifecycle (CONTROL PLANE) ─────────
    //   The embedder is the single eternal in-DB batch loop that fills the
    //   `embedding` column so semantic/hybrid search and facts_similar work.
    //   It is a SHARED, durable, fleet-wide resource (one loop per facts schema,
    //   advisory-locked across workers), so its lifecycle is an OPERATOR action,
    //   not a per-task tool. Restrict it to the Facts Manager — the singleton
    //   curator that already owns the knowledge-base control surface. Gate on
    //   `capabilities.embedder` (NOT `.search`): a store can have search without
    //   an embedder (lexical-only), and vice versa.
    if (
        enhancedFactStore &&
        enhancedFactStore.capabilities.embedder &&
        agentIdentity === FACTS_MANAGER_AGENT_ID
    ) {
        enhancedTools.push(defineTool("manage_embedder", {
            description:
                "Inspect and control the durable embedding loop that powers semantic/hybrid facts_search and " +
                "facts_similar. This is a SHARED, fleet-wide resource (one loop per facts schema) — changes affect " +
                "all agents and all sessions, so use it deliberately. Actions: 'status' (current running state — " +
                "always safe), 'start' (idempotently ensure the loop is running; optionally tune batch size / poll " +
                "interval), 'stop' (halt embedding fleet-wide — semantic search degrades to lexical until restarted), " +
                "'configure' (replace the embedding endpoint; rejects a model whose vector dimension differs from the " +
                "column, since that needs a schema migration + full re-embed). Prefer 'status' first; only 'stop' when " +
                "an operator explicitly asks, because new and updated facts stop getting embeddings while it is stopped.",
            parameters: {
                type: "object" as const,
                properties: {
                    action: {
                        type: "string",
                        enum: ["status", "start", "stop", "configure"],
                        description: "status = read-only; start/stop = lifecycle; configure = replace endpoint.",
                    },
                    intervalSeconds: {
                        type: "number",
                        description: "start only: seconds between embed passes (loop poll interval).",
                    },
                    batch: {
                        type: "number",
                        description: "start only: rows embedded per pass.",
                    },
                    reason: {
                        type: "string",
                        description: "stop only: human-readable reason recorded for the cancellation.",
                    },
                    endpoint: {
                        type: "object",
                        description:
                            "configure only: OpenAI/Azure-compatible embeddings endpoint. `dim` MUST match the " +
                            "column dimension fixed at migration time.",
                        properties: {
                            url: { type: "string", description: "Embeddings endpoint URL." },
                            model: { type: "string", description: "Model / deployment name." },
                            dim: { type: "number", description: "Vector dimension (must match the column)." },
                            apiKey: { type: "string", description: "API key (optional)." },
                            apiKeyHeader: { type: "string", description: "Auth header name (default 'api-key')." },
                            bearer: { type: "boolean", description: "Send the key as 'Bearer <key>' (default false)." },
                        },
                        required: ["url", "model", "dim"] as const,
                    },
                },
                required: ["action"] as const,
            },
            handler: async (a: {
                action: "status" | "start" | "stop" | "configure";
                intervalSeconds?: number;
                batch?: number;
                reason?: string;
                endpoint?: { url: string; model: string; dim: number; apiKey?: string; apiKeyHeader?: string; bearer?: boolean };
            }) => {
                try {
                    switch (a.action) {
                        case "status":
                            return { action: "status", ...(await enhancedFactStore.embedderStatus()) };
                        case "start":
                            return {
                                action: "start",
                                ...(await enhancedFactStore.startEmbedder({
                                    intervalSeconds: a.intervalSeconds,
                                    batch: a.batch,
                                })),
                            };
                        case "stop":
                            return { action: "stop", ...(await enhancedFactStore.stopEmbedder(a.reason)) };
                        case "configure": {
                            if (!a.endpoint) {
                                return { error: "configure requires an 'endpoint' object with url, model, and dim." };
                            }
                            return {
                                action: "configure",
                                ...(await enhancedFactStore.configureEmbedder(a.endpoint, { restartIfRunning: true })),
                            };
                        }
                        default:
                            return { error: `Unknown action '${a.action}'. Use status, start, stop, or configure.` };
                    }
                } catch (err) {
                    // Surface the provider's error to the agent (e.g. dim mismatch on
                    // configure) rather than throwing out of the tool call.
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        }));
    }

    // bulkStoreTool sits AFTER the original trio: callers (tests included)
    // destructure this array positionally as [store, read, delete, ...].
    return [storeTool, readTool, deleteTool, bulkStoreTool, ...managerTools, ...enhancedTools];
}

function safeParse(s: string): any {
    try { return JSON.parse(s); } catch { return undefined; }
}
