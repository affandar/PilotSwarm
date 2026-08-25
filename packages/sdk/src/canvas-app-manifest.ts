/**
 * Canvas app self-description: the CANVAS-APP-MANIFEST comment convention and
 * the response-contract grammar, in one module because they are one grammar —
 * a manifest's embedded contract passes through the SAME normalizer the
 * draw_canvas tool argument does, so no app can smuggle a shape the browser
 * would not enforce.
 *
 * A canvas app is a normal single-file HTML document whose first HTML comment
 * (within the first 4 KB, by convention immediately after <!doctype html>) is:
 *
 *   <!-- CANVAS-APP-MANIFEST
 *   { "manifestVersion": 1, "name": "...", "description": "...",
 *     "responseContract": { "actions": { ... } },
 *     "data": "tick shape notes", "notes": "usage notes" }
 *   -->
 *
 * Everything except responseContract is documentation for the loading LLM;
 * only the contract is enforced (browser-side, default-closed, unchanged).
 */

const CANVAS_CONTRACT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const CANVAS_CONTRACT_FIELD_TYPES = new Set(["string", "number", "boolean", "json"]);
const CANVAS_CONTRACT_MAX_ACTIONS = 16;
const CANVAS_CONTRACT_MAX_FIELDS = 16;
const CANVAS_CONTRACT_MAX_BYTES = 4096;
const CANVAS_CONTRACT_DATA_MAX_BYTES = 1024;

export function normalizeCanvasResponseContract(raw: unknown): { contract?: Record<string, any>; error?: string } {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) return { error: "responseContract must be an object" };
    const actions = (raw as any).actions;
    if (typeof actions !== "object" || actions === null || Array.isArray(actions)) {
        return { error: 'responseContract must be {"actions":{...}}' };
    }
    const names = Object.keys(actions);
    if (names.length === 0) return { error: "responseContract.actions is empty — omit the contract instead" };
    if (names.length > CANVAS_CONTRACT_MAX_ACTIONS) {
        return { error: `responseContract declares ${names.length} actions; the cap is ${CANVAS_CONTRACT_MAX_ACTIONS}` };
    }
    const normalized: Record<string, Record<string, string>> = {};
    for (const name of names) {
        if (!CANVAS_CONTRACT_NAME_RE.test(name)) return { error: `invalid action name ${JSON.stringify(name)}` };
        const fields = actions[name];
        if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
            return { error: `action ${JSON.stringify(name)} must map field names to types` };
        }
        const fieldNames = Object.keys(fields);
        if (fieldNames.length > CANVAS_CONTRACT_MAX_FIELDS) {
            return { error: `action ${JSON.stringify(name)} declares ${fieldNames.length} fields; the cap is ${CANVAS_CONTRACT_MAX_FIELDS}` };
        }
        const normalizedFields: Record<string, string> = {};
        for (const fieldName of fieldNames) {
            if (!CANVAS_CONTRACT_NAME_RE.test(fieldName)) {
                return { error: `invalid field name ${JSON.stringify(fieldName)} on action ${JSON.stringify(name)}` };
            }
            const declared = String(fields[fieldName] ?? "");
            const baseType = declared.endsWith("?") ? declared.slice(0, -1) : declared;
            if (!CANVAS_CONTRACT_FIELD_TYPES.has(baseType)) {
                return { error: `field ${JSON.stringify(fieldName)} on action ${JSON.stringify(name)} has unknown type ${JSON.stringify(declared)}; use string, number, boolean, or json (append ? for optional)` };
            }
            normalizedFields[fieldName] = declared;
        }
        normalized[name] = normalizedFields;
    }
    // The optional data key documents the update_canvas tick shape (e.g.
    // { example: {...} }). It rides the canonical contract into the draw
    // event and back out of read_canvas(manifestOnly), which is what makes
    // "re-read the contract before ticking so your payload never drifts" a
    // real loop instead of doc fiction. Bounded so the card stays cheap.
    let dataDoc: unknown;
    if ((raw as any).data !== undefined) {
        dataDoc = (raw as any).data;
        const dataBytes = Buffer.byteLength(JSON.stringify(dataDoc) ?? "", "utf8");
        if (!Number.isFinite(dataBytes) || dataBytes > CANVAS_CONTRACT_DATA_MAX_BYTES) {
            return { error: `responseContract.data serializes to ${dataBytes} bytes; the cap is ${CANVAS_CONTRACT_DATA_MAX_BYTES} — it is a shape EXAMPLE, not a payload` };
        }
    }
    const canonical: Record<string, any> = { actions: normalized, ...(dataDoc !== undefined ? { data: dataDoc } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(canonical), "utf8");
    if (bytes > CANVAS_CONTRACT_MAX_BYTES) {
        return { error: `responseContract is ${bytes} bytes serialized; the cap is ${CANVAS_CONTRACT_MAX_BYTES}` };
    }
    return { contract: canonical };
}

/** The manifest comment must START within this many characters. */
const MANIFEST_SCAN_WINDOW = 4096;
/** Cap on each extracted prose field — the card must stay cheap in context. */
const MANIFEST_PROSE_CAP = 400;
const MANIFEST_MARKER = "CANVAS-APP-MANIFEST";

export interface CanvasAppManifest {
    manifestVersion?: number;
    name?: string;
    version?: string;
    description?: string;
    data?: string;
    notes?: string;
    responseContract?: Record<string, any>;
    /**
     * The app's half of the KV write switch (interactive-canvas-apps Part D.3):
     * `write: "viewers"` lets the canvas policy admit collaborators; the
     * default `"owner"` keeps writes to the owner and the agent whatever the
     * policy says. `shared` lists key globs (`app/task/*`) any admitted
     * writer may overwrite; everything else is author-bound.
     */
    kv?: { write?: "owner" | "viewers"; shared?: string[] };
    /**
     * The app's INTERFACE — what an agent needs to drive this app without
     * reading its HTML. This is the catalog card's payload (Part F): the KV
     * keys the page reads and writes, the requests it queues for the agent,
     * and the notes it expects back. Prose fields are clipped; the whole
     * block is capped at CANVAS_INTERFACE_MAX_BYTES.
     */
    interface?: CanvasAppInterface;
    /** Catalog tags, e.g. ["review", "release", "collaborative"]. */
    tags?: string[];
}

export interface CanvasAppInterface {
    /** KV keys the app uses, one entry per prefix or exact key. */
    keys?: Array<{
        /** e.g. "app/item/<id>", "app/vote/<me.id>", "cfg/deadline" */
        key: string;
        /** Who writes it: "page" (viewers), "agent", or "both". */
        writer?: "page" | "agent" | "both";
        /** The value's shape, as an example object or a one-line description. */
        shape?: unknown;
        note?: string;
    }>;
    /** Requests the page queues under req/<id> for the agent to drain. */
    requests?: Array<{
        /** The `op` field of the req/* row, e.g. "expand", "store", "summarize". */
        op: string;
        /** The `args` shape, as an example or a one-line description. */
        args?: unknown;
        /** What the agent writes back into `result` when it lands the row. */
        result?: unknown;
        note?: string;
    }>;
    /** Notes the agent may write under evt/<n> that the page renders. */
    events?: Array<{ key: string; shape?: unknown; note?: string }>;
    /** Anything else an agent must know to operate the app (one paragraph). */
    notes?: string;
}

/** Cap on the serialized `interface` block — it rides every catalog card. */
export const CANVAS_INTERFACE_MAX_BYTES = 6 * 1024;
const INTERFACE_LIST_CAP = 32;
const INTERFACE_SHAPE_MAX_BYTES = 512;

function clipShape(value: unknown): unknown {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") return clampProse(value);
    try {
        const text = JSON.stringify(value);
        if (text.length <= INTERFACE_SHAPE_MAX_BYTES) return value;
        return `${text.slice(0, INTERFACE_SHAPE_MAX_BYTES - 1)}…`;
    } catch {
        return undefined;
    }
}

/**
 * Normalize a manifest's `interface` block: unknown fields dropped, lists
 * capped, prose clipped. Returns null when nothing usable is declared, and
 * `{ error }` when the block is present but over the size cap.
 */
export function normalizeCanvasAppInterface(raw: unknown): { interface: CanvasAppInterface | null; error?: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { interface: null };
    const r = raw as Record<string, unknown>;
    const out: CanvasAppInterface = {};
    if (Array.isArray(r.keys)) {
        out.keys = r.keys
            .filter((k: any) => k && typeof k === "object" && typeof k.key === "string" && k.key.trim())
            .slice(0, INTERFACE_LIST_CAP)
            .map((k: any) => ({
                key: String(k.key).trim().slice(0, 200),
                ...(k.writer === "page" || k.writer === "agent" || k.writer === "both" ? { writer: k.writer } : {}),
                ...(clipShape(k.shape) !== undefined ? { shape: clipShape(k.shape) } : {}),
                ...(clampProse(k.note) ? { note: clampProse(k.note) } : {}),
            }));
    }
    if (Array.isArray(r.requests)) {
        out.requests = r.requests
            .filter((q: any) => q && typeof q === "object" && typeof q.op === "string" && q.op.trim())
            .slice(0, INTERFACE_LIST_CAP)
            .map((q: any) => ({
                op: String(q.op).trim().slice(0, 64),
                ...(clipShape(q.args) !== undefined ? { args: clipShape(q.args) } : {}),
                ...(clipShape(q.result) !== undefined ? { result: clipShape(q.result) } : {}),
                ...(clampProse(q.note) ? { note: clampProse(q.note) } : {}),
            }));
    }
    if (Array.isArray(r.events)) {
        out.events = r.events
            .filter((e: any) => e && typeof e === "object" && typeof e.key === "string" && e.key.trim())
            .slice(0, INTERFACE_LIST_CAP)
            .map((e: any) => ({
                key: String(e.key).trim().slice(0, 200),
                ...(clipShape(e.shape) !== undefined ? { shape: clipShape(e.shape) } : {}),
                ...(clampProse(e.note) ? { note: clampProse(e.note) } : {}),
            }));
    }
    const notes = clampProse(r.notes);
    if (notes) out.notes = notes;
    if (!out.keys?.length && !out.requests?.length && !out.events?.length && !out.notes) return { interface: null };
    const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
    if (bytes > CANVAS_INTERFACE_MAX_BYTES) {
        return { interface: null, error: `interface block is ${bytes} bytes serialized; the cap is ${CANVAS_INTERFACE_MAX_BYTES}` };
    }
    return { interface: out };
}

function normalizeTags(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const tags = raw
        .filter((t) => typeof t === "string")
        .map((t: string) => t.trim().toLowerCase().slice(0, 40))
        .filter(Boolean)
        .slice(0, 16);
    return tags.length ? [...new Set(tags)] : undefined;
}

/** Normalize a manifest's `kv` block: unknown fields dropped, bad shapes ignored. */
export function normalizeCanvasKvManifest(raw: unknown): { write: "owner" | "viewers"; shared: string[] } | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const write = (raw as any).write === "viewers" ? "viewers" : "owner";
    const shared = Array.isArray((raw as any).shared)
        ? (raw as any).shared
            .filter((g: unknown) => typeof g === "string" && g.trim() && g.length <= 200)
            .map((g: string) => g.trim())
            .slice(0, 32)
        : [];
    return { write, shared };
}

function clampProse(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.length <= MANIFEST_PROSE_CAP) return trimmed;
    let cut = trimmed.slice(0, MANIFEST_PROSE_CAP - 1);
    // Never split a surrogate pair: a lone high surrogate is not well-formed
    // JSON text and PG rejects it, which can silently drop the transcript
    // event carrying the card.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return `${cut}…`;
}

/**
 * Extract the embedded CANVAS-APP-MANIFEST from an HTML document.
 *
 * Distinguishes three outcomes on purpose:
 *   { manifest }              — present and parseable
 *   { manifest: null }        — no manifest (an ordinary canvas document)
 *   { manifest: null, error } — a manifest was ATTEMPTED and is broken; the
 *                               draw path treats this as fail-closed when no
 *                               explicit contract argument saves the draw.
 */
export function extractCanvasAppManifest(html: string): { manifest: CanvasAppManifest | null; error?: string } {
    const head = String(html ?? "").slice(0, MANIFEST_SCAN_WINDOW + 65_536);
    // A manifest is a comment that OPENS with the marker: "<!--" followed by
    // optional whitespace and CANVAS-APP-MANIFEST. Scanning comment OPENS
    // (not marker occurrences) means neither prose, nor script strings, nor a
    // header comment that merely MENTIONS the convention can shadow or
    // impersonate the real manifest — both misreads used to fail perfectly
    // valid fromArtifact draws closed.
    let commentStart = -1;
    let markerAt = -1;
    let searchFrom = 0;
    while (searchFrom <= MANIFEST_SCAN_WINDOW) {
        const open = head.indexOf("<!--", searchFrom);
        if (open < 0 || open > MANIFEST_SCAN_WINDOW) break;
        const afterOpen = open + 4;
        const tokenMatch = /^[\s]*/.exec(head.slice(afterOpen, afterOpen + 64));
        const tokenAt = afterOpen + (tokenMatch ? tokenMatch[0].length : 0);
        if (head.startsWith(MANIFEST_MARKER, tokenAt)) {
            commentStart = open;
            markerAt = tokenAt;
            break;
        }
        const close = head.indexOf("-->", afterOpen);
        if (close < 0) break;
        searchFrom = close + 3;
    }
    if (commentStart < 0) return { manifest: null };
    const commentEnd = head.indexOf("-->", markerAt);
    if (commentEnd < 0) {
        return { manifest: null, error: "CANVAS-APP-MANIFEST comment is never closed (missing -->)" };
    }
    const jsonText = head.slice(markerAt + MANIFEST_MARKER.length, commentEnd).trim();
    if (!jsonText) return { manifest: null, error: "CANVAS-APP-MANIFEST comment contains no JSON" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err: any) {
        return { manifest: null, error: `CANVAS-APP-MANIFEST is not valid JSON: ${err?.message || String(err)}` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { manifest: null, error: "CANVAS-APP-MANIFEST must be a JSON object" };
    }
    const raw = parsed as Record<string, unknown>;
    const manifest: CanvasAppManifest = {};
    if (Number.isFinite(Number(raw.manifestVersion))) manifest.manifestVersion = Number(raw.manifestVersion);
    const name = clampProse(raw.name);
    if (name) manifest.name = name;
    const version = clampProse(raw.version);
    if (version) manifest.version = version;
    const description = clampProse(raw.description);
    if (description) manifest.description = description;
    const data = clampProse(raw.data);
    if (data) manifest.data = data;
    const notes = clampProse(raw.notes);
    if (notes) manifest.notes = notes;
    if (raw.responseContract !== undefined) {
        manifest.responseContract = raw.responseContract as Record<string, any>;
    }
    const kv = normalizeCanvasKvManifest(raw.kv);
    if (kv) manifest.kv = kv;
    const iface = normalizeCanvasAppInterface(raw.interface);
    if (iface.error) return { manifest: null, error: `CANVAS-APP-MANIFEST interface: ${iface.error}` };
    if (iface.interface) manifest.interface = iface.interface;
    const tags = normalizeTags(raw.tags);
    if (tags) manifest.tags = tags;
    return { manifest };
}

/**
 * The compact "app card" fields returned to the drawing agent — never the
 * html. Carries the INTERFACE (keys, requests, events) and the kv switch, so
 * an agent that did not write the app can still drive it from this card.
 */
export function canvasAppCard(manifest: CanvasAppManifest | null): Record<string, unknown> | undefined {
    if (!manifest) return undefined;
    const card: Record<string, unknown> = {};
    if (manifest.name) card.name = manifest.name;
    if (manifest.version) card.version = manifest.version;
    if (manifest.description) card.description = manifest.description;
    if (manifest.data) card.data = manifest.data;
    if (manifest.notes) card.notes = manifest.notes;
    if (manifest.kv) card.kv = manifest.kv;
    if (manifest.interface) card.interface = manifest.interface;
    if (manifest.tags) card.tags = manifest.tags;
    return Object.keys(card).length > 0 ? card : undefined;
}

/** Catalog app names: a DNS-label-ish slug, so keys and filenames stay clean. */
export const CANVAS_APP_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * The catalog record for a published app (interactive-canvas-apps Part F.2):
 * the shared fact `apps/<name>`. Derived from the DOCUMENT's manifest, never
 * from a model's memory of it; the description is the text search ranks on.
 */
export function buildCanvasAppCatalogRecord(input: {
    name: string;
    description: string;
    manifest: CanvasAppManifest | null;
    responseContract?: Record<string, any> | null;
    source: { sessionId: string; filename: string; sha256: string };
    publishedBy: string | null;
    publishedAt: string;
    tags?: string[];
}): Record<string, unknown> {
    const card = canvasAppCard(input.manifest) ?? {};
    const tags = normalizeTags([...(input.tags ?? []), ...(input.manifest?.tags ?? [])]) ?? [];
    return {
        name: input.name,
        description: input.description,
        version: input.manifest?.version ?? null,
        card,
        ...(input.responseContract ? { responseContract: input.responseContract } : {}),
        kv: input.manifest?.kv ?? { write: "owner", shared: [] },
        source: { kind: "artifact", ...input.source },
        publishedBy: input.publishedBy,
        publishedAt: input.publishedAt,
        tags,
    };
}
