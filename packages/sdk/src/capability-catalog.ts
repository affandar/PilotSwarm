import { createHash } from "node:crypto";
import type { Tool } from "@github/copilot-sdk";
import type { FeatureOwner } from "./feature-flags.js";
import type { FactStore, EnhancedFactStore, FactRecord } from "./facts-store.js";

export type CapabilityKind = "skill" | "agent" | "tool" | "mcp";
export interface CapabilityArtifact {
    kind: CapabilityKind; name: string; description: string; body?: string;
    /** Opaque identity within one source revision. Never displayed as a path. */
    id?: string;
    skills?: string[]; tools?: string[]; mcpServers?: string[]; initialPrompt?: string;
}
export interface CapabilitySource {
    id: string; name: string; source: "static" | "published"; revision: string;
    scope: "shared" | "user"; owner?: FeatureOwner | null; packageId?: string;
    artifacts: CapabilityArtifact[]; tools: Map<string, Tool<any>>;
    mcpServers: Record<string, any>;
}
export interface CapabilitySelection { sourceId: string; sourceRef?: string; tools: string[]; mcpServers: string[] }
export interface CapabilityState {
    revision: number; selections: CapabilitySelection[];
    requests?: Array<{ id: string; hash: string }>;
}
export const EMPTY_CAPABILITY_STATE: CapabilityState = { revision: 0, selections: [] };
export function normalizeCapabilityState(value: unknown): CapabilityState {
    const state = value as CapabilityState;
    if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0
        || !Array.isArray(state.selections) || state.selections.length > 32
        || state.requests !== undefined && (!Array.isArray(state.requests) || state.requests.length > 64)) {
        throw new Error("Invalid durable capability state");
    }
    const sourceIds = new Set<string>();
    const selections = state.selections.map(selection => {
        if (!selection || typeof selection.sourceId !== "string" || !selection.sourceId || selection.sourceId.length > 500
            || sourceIds.has(selection.sourceId)
            || selection.sourceRef !== undefined && (typeof selection.sourceRef !== "string" || selection.sourceRef.length > 4096)) {
            throw new Error("Invalid durable capability selection");
        }
        sourceIds.add(selection.sourceId);
        const clean = (names: unknown) => {
            if (!Array.isArray(names) || names.length > 64
                || names.some(name => typeof name !== "string" || !name || name.length > 200)
                || new Set(names).size !== names.length) throw new Error("Invalid durable capability names");
            return [...names].sort();
        };
        return { sourceId: selection.sourceId, ...(selection.sourceRef ? { sourceRef: selection.sourceRef } : {}),
            tools: clean(selection.tools), mcpServers: clean(selection.mcpServers) };
    });
    const requests = state.requests?.map(receipt => {
        if (!receipt || typeof receipt.id !== "string" || !receipt.id || receipt.id.length > 128
            || typeof receipt.hash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.hash)) {
            throw new Error("Invalid durable capability request receipt");
        }
        return { id: receipt.id, hash: receipt.hash };
    });
    return { revision: state.revision, selections, ...(requests ? { requests } : {}) };
}
export function capabilityHash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function visibleCapabilitySource(source: CapabilitySource, owner: FeatureOwner | null): boolean {
    return source.scope === "shared" || Boolean(owner && source.owner?.provider === owner.provider && source.owner.subject === owner.subject);
}
interface Ref { s: string; r: string; k: CapabilityKind | "source"; n: string }
export function capabilityRef(s: string, r: string, k: Ref["k"], n = ""): string {
    return "cap1." + Buffer.from(JSON.stringify({ s, r, k, n })).toString("base64url");
}
export function parseCapabilityRef(ref: unknown): Ref {
    if (typeof ref !== "string" || ref.length > 4096 || !/^cap1\.[A-Za-z0-9_-]+$/.test(ref)) throw new Error("Invalid capability reference");
    let v: any; try { v = JSON.parse(Buffer.from(ref.slice(5), "base64url").toString()); } catch { throw new Error("Invalid capability reference"); }
    if (!v || !["skill", "agent", "tool", "mcp", "source"].includes(v.k) || ![v.s, v.r, v.n].every(x => typeof x === "string")) throw new Error("Invalid capability reference");
    return v;
}
export function resolveCapabilitySource(sources: CapabilitySource[], owner: FeatureOwner | null, ref: string): { source: CapabilitySource; ref: Ref } {
    const parsed = parseCapabilityRef(ref);
    const source = sources.find(s => s.id === parsed.s && visibleCapabilitySource(s, owner));
    if (!source) throw new Error("Capability source unavailable or inaccessible; search again");
    if (source.revision !== parsed.r) throw new Error("Capability source changed; search again for the current revision");
    return { source, ref: parsed };
}
function tokens(text: string) { return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }
function lexicalScore(query: string, name: string, description: string): number {
    const qs = [...new Set(tokens(query))]; if (!qs.length) return 0;
    const names = new Set(tokens(name)); const words = new Set(tokens(description));
    return qs.reduce((sum, t) => sum + (names.has(t) ? 5 : words.has(t) ? 1 : 0), name.toLowerCase() === query.toLowerCase() ? 20 : 0);
}
function artifactId(artifact: CapabilityArtifact, index: number): string {
    return artifact.id ?? `${artifact.kind}:${index}:${artifact.name}`;
}
function factValue(f: FactRecord): any {
    if (typeof f.value !== "string") return f.value;
    try { return JSON.parse(f.value); } catch { return { instructions: f.value }; }
}
function curatedSkill(f: FactRecord) { return f.shared === true && f.key.startsWith("skills/") && Boolean(f.scopeKey) && f.etag != null; }
export class CapabilityCatalog {
    constructor(private readonly getSources: () => CapabilitySource[], private readonly factStore?: FactStore | null, private readonly reservedPrefixes: string[] = []) {}
    private isCurated = (f: FactRecord) => curatedSkill(f) && !f.deletedAt && !this.reservedPrefixes.some(p => f.key.startsWith(p));
    async search(owner: FeatureOwner | null, readerSessionId: string, args: { query: string; limit?: number; kinds?: CapabilityKind[]; sources?: string[] }) {
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 2000) throw new Error("query must contain 1–2000 characters");
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) throw new Error("limit must be a positive integer");
        const limit = Math.max(1, Math.min(30, Math.trunc(args.limit ?? 8)));
        const kinds = args.kinds ?? ["skill", "agent", "tool", "mcp"];
        const origins = args.sources ?? ["static", "published", "curated"];
        if (!kinds.every(k => ["skill", "agent", "tool", "mcp"].includes(k)) || !origins.every(k => ["static", "published", "curated"].includes(k))) throw new Error("Unknown kind or source filter");
        const coverage: Record<string, string> = {};
        const hits: any[] = [];
        for (const origin of ["static", "published"]) {
            if (!origins.includes(origin)) continue;
            coverage[origin] = "available";
            const ranked: any[] = [];
            for (const source of this.getSources().filter(s => s.source === origin && visibleCapabilitySource(s, owner))) {
                for (const [index, a] of source.artifacts.entries()) {
                    if (!kinds.includes(a.kind)) continue;
                    const score = lexicalScore(args.query, a.name, `${source.name} ${a.description} ${(a.tools ?? []).join(" ")}`);
                    if (!score) continue;
                    ranked.push({ kind: a.kind, name: a.name, description: a.description.slice(0, 600), source: origin,
                        ref: capabilityRef(source.id, source.revision, a.kind, artifactId(a, index)),
                        source_ref: capabilityRef(source.id, source.revision, "source"), revision: source.revision, scope: source.scope,
                        tools: a.tools, mcp_servers: a.mcpServers, score });
                }
            }
            ranked.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
            ranked.slice(0, limit).forEach((h, i) => hits.push({ ...h, score: 1 / (60 + i + 1) }));
        }
        if (origins.includes("curated") && kinds.includes("skill")) {
            const store = this.factStore as EnhancedFactStore | undefined;
            if (!store?.capabilities?.search || typeof store.searchFacts !== "function") coverage.curated = "unavailable";
            else try {
                const result = await store.searchFacts(args.query, { mode: "hybrid", namespace: "skills", scope: "shared", limit }, { readerSessionId, unrestricted: false });
                coverage.curated = "available";
                result.facts.filter(this.isCurated).forEach((f, i) => {
                    const v = factValue(f);
                    hits.push({ kind: "skill", name: v?.name ?? f.key, description: String(v?.description ?? "").slice(0, 600),
                        source: "curated", scope: "shared", revision: String(f.etag),
                        ref: capabilityRef(`curated:${f.scopeKey}`, String(f.etag), "skill", f.key),
                        confidence: v?.confidence, expires_at: v?.expires_at, contradiction_count: v?.contradiction_count,
                        score: 1 / (60 + i + 1) });
                });
            } catch { coverage.curated = "unavailable"; }
        }
        hits.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
        return { capabilities: hits.slice(0, limit), coverage };
    }
    async load(owner: FeatureOwner | null, readerSessionId: string, ref: string, kind: "skill" | "agent") {
        const parsed = parseCapabilityRef(ref);
        if (parsed.k !== kind) throw new Error(`Expected a ${kind} reference`);
        if (parsed.s.startsWith("curated:")) {
            if (kind !== "skill" || !parsed.n.startsWith("skills/") || !this.factStore) throw new Error("Invalid curated skill reference");
            const rows = await this.factStore.readFacts({ scopeKeys: [parsed.s.slice(8)], scope: "shared", limit: 1 }, { readerSessionId, unrestricted: false });
            const f = rows.facts.find(f => this.isCurated(f) && f.scopeKey === parsed.s.slice(8) && f.key === parsed.n);
            if (!f) throw new Error("Curated skill unavailable or inaccessible");
            if (String(f.etag) !== parsed.r) throw new Error("Curated skill changed; search again");
            return { ref, source: "curated", revision: parsed.r, skill: factValue(f) };
        }
        const { source } = resolveCapabilitySource(this.getSources(), owner, ref);
        let a = source.artifacts.find((artifact, index) => artifact.kind === kind && artifactId(artifact, index) === parsed.n);
        if (!a) {
            const named = source.artifacts.filter(artifact => artifact.kind === kind && artifact.name === parsed.n);
            if (named.length === 1) a = named[0];
        }
        if (!a) throw new Error("Capability unavailable; search again");
        return { ref, source: source.source, revision: source.revision, mode: "reference", ...a,
            ...(kind === "agent" ? { notice: `Before applying these instructions, tell the user you are using instructions from ${a.name}. State material adaptations. This does not launch the agent, grant its identity/tools, execute initialPrompt, or create schedules.` } : {}) };
    }
}
