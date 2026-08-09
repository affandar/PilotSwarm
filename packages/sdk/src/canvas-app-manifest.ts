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
    return { manifest };
}

/** The compact "app card" fields returned to the drawing agent — never the html. */
export function canvasAppCard(manifest: CanvasAppManifest | null): Record<string, string | number> | undefined {
    if (!manifest) return undefined;
    const card: Record<string, string | number> = {};
    if (manifest.name) card.name = manifest.name;
    if (manifest.version) card.version = manifest.version;
    if (manifest.description) card.description = manifest.description;
    if (manifest.data) card.data = manifest.data;
    if (manifest.notes) card.notes = manifest.notes;
    return Object.keys(card).length > 0 ? card : undefined;
}
