/**
 * The canvas KV chokepoint — interactive-canvas-apps.md Parts C, D, E, H.
 *
 * Every door (signed-in browser, link bearer, the agent) authenticates on
 * its own and hands this module a RESOLVED principal. This module never
 * sees a cookie or a token. It owns every rule:
 *
 *   key grammar and limits        (Part I)
 *   who may write this canvas     (Part D: policy × manifest × relation)
 *   reserved prefixes             cfg/ evt/ ui/<me>/ req/
 *   author-bound overwrites       (H.2, unless the manifest shares the prefix)
 *   the req/* status cap          (Part E: collaborators SUGGEST, owners QUEUE)
 *   the envelope                  { v, by, at } — `by` is stamped here, never accepted
 *
 * It lives in the SDK because two processes need it: the portal serves
 * browsers, the worker serves the agent.
 */

import type { SessionCatalog, SessionAccessSnapshot } from "./cms.js";
import { normalizeCanvasKvManifest } from "./canvas-app-manifest.js";

// ─── Limits (Part I) ─────────────────────────────────────────────

export const CANVAS_KV_KEY_MAX = 200;
export const CANVAS_KV_VALUE_MAX_BYTES = 16 * 1024;
export const CANVAS_KV_MAX_KEYS = 1000;
export const CANVAS_KV_MAX_BYTES = 2 * 1024 * 1024;
export const CANVAS_KV_LIST_PAGE = 200;
const KEY_RE = /^[A-Za-z0-9._/-]+$/;

// ─── Principals ──────────────────────────────────────────────────

export type CanvasKvPrincipal =
    | { kind: "user"; provider: string; subject: string; isAdmin: boolean; label?: string | null }
    | { kind: "agent"; sessionId: string }
    | { kind: "link"; writerId: string; label?: string | null; writeEnabled: boolean };

export type CanvasKvRelation = "owner" | "admin" | "collaborator" | "viewer" | "link" | "agent";

export interface CanvasKvBy { kind: "user" | "link" | "agent"; id: string; label: string | null }

export interface CanvasKvMe extends CanvasKvBy {
    relation: CanvasKvRelation;
    canWrite: boolean;
}

export interface CanvasKvEntry {
    key: string;
    v: unknown;
    by: CanvasKvBy;
    at: string;
    rev: number;
}

export interface CanvasKvViewer {
    me: CanvasKvMe;
    /** owner | readers | link — the owner's policy for this canvas. */
    policy: "owner" | "readers" | "link";
    /** The app's declared switch, or null when the document declares none. */
    manifestKv: { write: "owner" | "viewers"; shared: string[] } | null;
    /** True for owner, admin, agent, and session writers: they may touch any row and queue requests. */
    privileged: boolean;
}

export type CanvasKvWriteOp =
    | { op: "put"; key: string; value: unknown; ifMatch?: number | null }
    | { op: "delete"; key: string; ifMatch?: number | null };

export interface CanvasKvWriteResult {
    key: string;
    ok: boolean;
    rev?: number;
    /** Set when the chokepoint changed what was written (a collaborator's req/* status). */
    capped?: "suggested";
    error?: string;
    code?: "FORBIDDEN" | "CONFLICT" | "INVALID_KEY" | "INVALID_REQUEST" | "TOO_LARGE" | "QUOTA" | "NOT_FOUND";
}

export class CanvasKvError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

// ─── Pure rules ──────────────────────────────────────────────────

export function validateCanvasKvKey(key: unknown): string | null {
    if (typeof key !== "string" || !key) return "key is required";
    if (key.length > CANVAS_KV_KEY_MAX) return `key exceeds ${CANVAS_KV_KEY_MAX} characters`;
    if (!KEY_RE.test(key)) return "key may contain only letters, digits, . _ / -";
    if (key.startsWith("/")) return "key may not start with /";
    if (key.includes("..")) return "key may not contain ..";
    return null;
}

export function validateCanvasKvSlot(slot: unknown): number | null {
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 1 || n > 5) return null;
    return n;
}

/** `app/task/*` matches `app/task/x` and `app/task/x/y`; `*` alone matches everything. */
export function canvasKvGlobMatches(glob: string, key: string): boolean {
    if (glob === "*") return true;
    if (glob.endsWith("/*")) return key.startsWith(glob.slice(0, -1)) || key === glob.slice(0, -2);
    if (glob.endsWith("*")) return key.startsWith(glob.slice(0, -1));
    return glob === key;
}

export function principalBy(principal: CanvasKvPrincipal): CanvasKvBy {
    switch (principal.kind) {
        case "user":
            return { kind: "user", id: `${principal.provider}/${principal.subject}`, label: principal.label ?? null };
        case "agent":
            return { kind: "agent", id: `agent:${principal.sessionId}`, label: "agent" };
        case "link":
            return { kind: "link", id: principal.writerId, label: principal.label ?? null };
    }
}

/**
 * Who this principal is to this canvas, and whether they may write.
 *
 * Session writers ALWAYS get canvas write (the agent law, D.1). Session
 * readers write only when the owner's policy admits them AND the app
 * declared `kv.write: "viewers"` (D.3 — two switches, neither alone opens
 * the door). A link bearer writes only under policy `link` with a
 * read/write link; that door is not built yet, so `writeEnabled` is false
 * everywhere today.
 */
export function resolveCanvasKvViewer(
    principal: CanvasKvPrincipal,
    snapshot: SessionAccessSnapshot | null,
    settings: { kvAccess: "owner" | "readers" | "link"; kvManifest: unknown } | null,
): CanvasKvViewer {
    const policy = settings?.kvAccess ?? "owner";
    const manifestKv = normalizeCanvasKvManifest(settings?.kvManifest);
    const by = principalBy(principal);
    if (principal.kind === "agent") {
        return { me: { ...by, relation: "agent", canWrite: true }, policy, manifestKv, privileged: true };
    }
    if (principal.kind === "link") {
        const canWrite = policy === "link" && principal.writeEnabled === true && manifestKv?.write === "viewers";
        return { me: { ...by, relation: "link", canWrite }, policy, manifestKv, privileged: false };
    }
    const isOwner = Boolean(snapshot?.viewerIsOwner);
    const isAdmin = principal.isAdmin === true;
    // Effective session access: a targeted share, else what the session's
    // deployment-wide visibility grants every signed-in user.
    const visibility = snapshot?.visibility ?? "private";
    const share = snapshot?.viewerShareAccess
        ?? (visibility === "shared_write" ? "write" : visibility === "shared_read" ? "read" : null);
    const relation: CanvasKvRelation = isOwner ? "owner" : isAdmin ? "admin" : share ? "collaborator" : "viewer";
    const privileged = isOwner || isAdmin || share === "write";
    const admitted = (policy === "readers" || policy === "link") && manifestKv?.write === "viewers";
    const canWrite = privileged || (share === "read" && admitted);
    return { me: { ...by, relation, canWrite }, policy, manifestKv, privileged };
}

/**
 * The per-key rule for one write. Returns the (possibly capped) envelope
 * value to store, or a refusal. Pure: the caller supplies the existing row.
 */
export function decideCanvasKvWrite(
    viewer: CanvasKvViewer,
    op: CanvasKvWriteOp,
    existing: { by: CanvasKvBy | null } | null,
): { ok: true; value?: unknown; capped?: "suggested" } | { ok: false; code: CanvasKvWriteResult["code"]; error: string } {
    const key = op.key;
    if (!viewer.me.canWrite) {
        return { ok: false, code: "FORBIDDEN", error: "you can view this canvas but not write it" };
    }
    // Reserved prefixes.
    if (key === "cfg" || key.startsWith("cfg/")) {
        if (!(viewer.me.relation === "owner" || viewer.me.relation === "admin" || viewer.me.relation === "agent")) {
            return { ok: false, code: "FORBIDDEN", error: "cfg/* is owner-and-agent writable" };
        }
    } else if (key === "evt" || key.startsWith("evt/")) {
        if (!(viewer.me.relation === "owner" || viewer.me.relation === "agent")) {
            return { ok: false, code: "FORBIDDEN", error: "evt/* is written by the session, not by viewers" };
        }
    } else if (key.startsWith("ui/")) {
        // The writer id itself contains a slash (provider/subject), so the
        // owned namespace is `ui/<id>` and everything below it.
        const mine = `ui/${viewer.me.id}`;
        if (key !== mine && !key.startsWith(`${mine}/`) && !viewer.privileged) {
            return { ok: false, code: "FORBIDDEN", error: `ui/* rows belong to their writer; yours are ${mine}` };
        }
    }
    // Author-bound: an unprivileged writer modifies only rows they wrote,
    // unless the app shares that prefix.
    if (!viewer.privileged && existing && existing.by && existing.by.id !== viewer.me.id) {
        const shared = viewer.manifestKv?.shared ?? [];
        if (!shared.some((g) => canvasKvGlobMatches(g, key))) {
            return { ok: false, code: "FORBIDDEN", error: "this row was written by someone else; the app does not share that key" };
        }
    }
    if (op.op === "delete") return { ok: true };
    // The req/* status cap: collaborators suggest, only the owner queues.
    let value = op.value;
    let capped: "suggested" | undefined;
    if (key.startsWith("req/") && !viewer.privileged && value && typeof value === "object" && !Array.isArray(value)) {
        const status = (value as any).status;
        if (status !== "suggested" && status !== "done" && status !== "failed") {
            value = { ...(value as Record<string, unknown>), status: "suggested" };
            capped = "suggested";
        }
        if (status === "done" || status === "failed") {
            // A collaborator may not land a request either.
            value = { ...(value as Record<string, unknown>), status: "suggested" };
            capped = "suggested";
        }
    }
    return { ok: true, value, capped };
}

// ─── The store-facing surface ────────────────────────────────────

export interface CanvasKvStore {
    getSessionAccess(sessionId: string, viewer: { provider: string; subject: string }): Promise<SessionAccessSnapshot | null>;
    getCanvasKvSettings(sessionId: string, slot: number): Promise<{ kvAccess: "owner" | "readers" | "link"; kvManifest: unknown; latestRev: number } | null>;
    canvasKvGet(sessionId: string, slot: number, key: string): Promise<{ key: string; value: any; rev: number; updatedAt: string } | null>;
    canvasKvList(sessionId: string, slot: number, prefix: string | null, limit: number, afterKey: string | null): Promise<Array<{ key: string; value: any; rev: number; updatedAt: string }>>;
    canvasKvWrite(sessionId: string, slot: number, key: string, value: unknown | null, ifMatch: number | null, limits: { maxKeys: number; maxBytes: number; maxValueBytes: number }): Promise<{ status: string; rev: number; sizeBytes: number | null }>;
}

function rowToEntry(row: { key: string; value: any; rev: number }): CanvasKvEntry {
    const env = row.value && typeof row.value === "object" ? row.value : {};
    const by = env.by && typeof env.by === "object"
        ? { kind: env.by.kind === "link" ? "link" : env.by.kind === "agent" ? "agent" : "user", id: String(env.by.id ?? ""), label: env.by.label ?? null } as CanvasKvBy
        : { kind: "user", id: "", label: null } as CanvasKvBy;
    return { key: row.key, v: env.v, by, at: String(env.at ?? ""), rev: Number(row.rev) || 0 };
}

async function viewerFor(store: CanvasKvStore, sessionId: string, slot: number, principal: CanvasKvPrincipal): Promise<CanvasKvViewer> {
    if (validateCanvasKvSlot(slot) === null) throw new CanvasKvError("INVALID_REQUEST", "slot must be an integer 1-5");
    let snapshot: SessionAccessSnapshot | null = null;
    if (principal.kind === "user") {
        snapshot = await store.getSessionAccess(sessionId, { provider: principal.provider, subject: principal.subject });
        if (!snapshot) throw new CanvasKvError("NOT_FOUND", "session not found");
        // Read access is the floor. Doors gate this too (session:read), but
        // the chokepoint must not depend on it.
        const visible = snapshot.viewerIsOwner || principal.isAdmin || snapshot.viewerShareAccess != null
            || snapshot.visibility === "shared_read" || snapshot.visibility === "shared_write";
        if (!visible) throw new CanvasKvError("FORBIDDEN", "not visible");
    }
    const settings = await store.getCanvasKvSettings(sessionId, slot);
    return resolveCanvasKvViewer(principal, snapshot, settings ? { kvAccess: settings.kvAccess, kvManifest: settings.kvManifest } : null);
}

export interface CanvasKvReadResult {
    entries: CanvasKvEntry[];
    nextAfter: string | null;
    me: CanvasKvMe;
    policy: "owner" | "readers" | "link";
    manifestKv: CanvasKvViewer["manifestKv"];
}

/** Door-agnostic read: the page's `canvas-kv-ready` payload and every list/get. */
export async function readCanvasKv(
    store: CanvasKvStore,
    sessionId: string,
    slot: number,
    principal: CanvasKvPrincipal,
    query: { prefix?: string | null; limit?: number | null; after?: string | null; key?: string | null } = {},
): Promise<CanvasKvReadResult> {
    const viewer = await viewerFor(store, sessionId, slot, principal);
    if (query.key) {
        const bad = validateCanvasKvKey(query.key);
        if (bad) throw new CanvasKvError("INVALID_KEY", bad);
        const row = await store.canvasKvGet(sessionId, slot, query.key);
        return { entries: row ? [rowToEntry(row)] : [], nextAfter: null, me: viewer.me, policy: viewer.policy, manifestKv: viewer.manifestKv };
    }
    const prefix = typeof query.prefix === "string" ? query.prefix : null;
    if (prefix && (prefix.length > CANVAS_KV_KEY_MAX || !/^[A-Za-z0-9._/-]*$/.test(prefix))) {
        throw new CanvasKvError("INVALID_KEY", "prefix may contain only letters, digits, . _ / -");
    }
    const limit = Math.max(1, Math.min(CANVAS_KV_LIST_PAGE, Math.floor(Number(query.limit) || CANVAS_KV_LIST_PAGE)));
    const after = typeof query.after === "string" && query.after ? query.after : null;
    const rows = await store.canvasKvList(sessionId, slot, prefix, limit, after);
    const entries = rows.map(rowToEntry);
    return {
        entries,
        nextAfter: rows.length === limit ? rows[rows.length - 1].key : null,
        me: viewer.me,
        policy: viewer.policy,
        manifestKv: viewer.manifestKv,
    };
}

/** Door-agnostic write: one or more ops, each answered individually. */
export async function writeCanvasKv(
    store: CanvasKvStore,
    sessionId: string,
    slot: number,
    principal: CanvasKvPrincipal,
    ops: CanvasKvWriteOp[],
): Promise<{ results: CanvasKvWriteResult[]; me: CanvasKvMe }> {
    const viewer = await viewerFor(store, sessionId, slot, principal);
    const results: CanvasKvWriteResult[] = [];
    const by = viewer.me;
    for (const op of ops.slice(0, 50)) {
        const bad = validateCanvasKvKey(op?.key);
        if (bad) { results.push({ key: String(op?.key ?? ""), ok: false, code: "INVALID_KEY", error: bad }); continue; }
        // Only the two documented ops. Anything else is refused, never
        // executed as a put — a misspelled "DELETE" must not overwrite a row.
        if (op.op !== "put" && op.op !== "delete") {
            const bad = op as unknown as { key?: unknown; op?: unknown };
            results.push({ key: String(bad.key ?? ""), ok: false, code: "INVALID_REQUEST", error: `op must be put or delete (got ${JSON.stringify(bad.op)})` });
            continue;
        }
        // ifMatch is a non-negative integer or absent. A malformed value is
        // refused rather than coerced to 0, which would silently become a claim.
        let ifMatch: number | null = null;
        if (op.ifMatch !== undefined && op.ifMatch !== null) {
            const n = Number(op.ifMatch);
            if (!Number.isInteger(n) || n < 0) {
                results.push({ key: op.key, ok: false, code: "INVALID_REQUEST", error: "ifMatch must be a non-negative integer (0 = the key must not exist)" });
                continue;
            }
            ifMatch = n;
        }
        const existingRow = await store.canvasKvGet(sessionId, slot, op.key);
        const existing = existingRow ? { by: rowToEntry(existingRow).by } : null;
        const decision = decideCanvasKvWrite(viewer, op, existing);
        if (!decision.ok) { results.push({ key: op.key, ok: false, code: decision.code, error: decision.error }); continue; }
        const envelope = op.op === "delete"
            ? null
            : { v: decision.value === undefined ? null : decision.value, by: { kind: by.kind, id: by.id, label: by.label }, at: new Date().toISOString() };
        const outcome = await store.canvasKvWrite(sessionId, slot, op.key, envelope, ifMatch, {
            maxKeys: CANVAS_KV_MAX_KEYS, maxBytes: CANVAS_KV_MAX_BYTES, maxValueBytes: CANVAS_KV_VALUE_MAX_BYTES,
        });
        switch (outcome.status) {
            case "written":
            case "deleted":
                results.push({ key: op.key, ok: true, rev: outcome.rev, ...(decision.capped ? { capped: decision.capped } : {}) });
                break;
            case "not_found":
                results.push({ key: op.key, ok: true, rev: outcome.rev });
                break;
            case "conflict":
                results.push({ key: op.key, ok: false, code: "CONFLICT", rev: outcome.rev, error: `rev mismatch (current ${outcome.rev})` });
                break;
            case "too_large":
                results.push({ key: op.key, ok: false, code: "TOO_LARGE", error: `value is ${outcome.sizeBytes} bytes; the cap is ${CANVAS_KV_VALUE_MAX_BYTES}` });
                break;
            case "quota_keys":
                results.push({ key: op.key, ok: false, code: "QUOTA", error: `this canvas already holds ${CANVAS_KV_MAX_KEYS} keys` });
                break;
            case "quota_bytes":
                results.push({ key: op.key, ok: false, code: "QUOTA", error: `this canvas is at its ${CANVAS_KV_MAX_BYTES}-byte budget` });
                break;
            default:
                results.push({ key: op.key, ok: false, code: "CONFLICT", error: `unexpected store status ${outcome.status}` });
        }
    }
    return { results, me: viewer.me };
}
