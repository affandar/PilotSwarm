/**
 * Canvas response actions — the browser half of the interactive-canvas
 * contract.
 *
 * The agent draws the canvas AND declares, per draw, exactly which structured
 * responses that page may send back (`responseContract` on `draw_canvas`,
 * carried in `session.canvas_updated` event data). A page control posts
 * `{type: "canvas-action", action, data}` to the parent; the CanvasFrame
 * hands it here. This module is the whole decision:
 *
 *   - NO contract on the current canvas → nothing is accepted. Interactivity
 *     is opt-in per revision, default-closed.
 *   - The action must be declared, every field must match its declared
 *     primitive type, no undeclared fields, hard size caps.
 *
 * A conforming action is formatted as a canonical `[canvas-action] {...}`
 * user message. The transcript records it (provenance: it is a real message
 * from the authenticated viewer), the agent reads the JSON, and the portal
 * chat HIDES it — the canvas redraw is the user-visible half of the loop.
 *
 * Provenance (that the message came from the canvas iframe and not some other
 * artifact preview) is enforced by the caller: the CanvasFrame accepts
 * postMessage events only from its own live iframe's contentWindow. This
 * module assumes that check already happened.
 */

export const CANVAS_ACTION_PREFIX = "[canvas-action] ";

const ACTION_MAX_STRING_CHARS = 2048;
const ACTION_MAX_SERIALIZED_BYTES = 8192;

/** Serialized-size guard that tolerates hosts without TextEncoder. */
function serializedByteLength(value) {
    // Cyclic objects and BigInts cross postMessage (structured clone) but
    // make JSON.stringify THROW — and this module's contract is that garbage
    // is refused, never thrown, because the throw would escape the sync
    // submit path as an uncaught error. Infinity fails the size check.
    let json;
    try {
        json = JSON.stringify(value) || "";
    } catch {
        return Infinity;
    }
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(json).length;
    return json.length;
}

/**
 * Validate one posted message against the current canvas contract.
 * Returns `{ok: true, action, data}` or `{ok: false, reason}`; never throws
 * on garbage — a hostile page must not be able to crash the portal shell.
 */
export function validateCanvasAction(contract, message) {
    const actions = contract?.actions;
    if (!actions || typeof actions !== "object") {
        return { ok: false, reason: "the current canvas declares no response contract" };
    }
    if (!message || typeof message !== "object" || message.type !== "canvas-action") {
        return { ok: false, reason: "not a canvas-action message" };
    }
    const action = typeof message.action === "string" ? message.action : "";
    const declaredFields = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null;
    if (!declaredFields || typeof declaredFields !== "object") {
        return { ok: false, reason: `action ${JSON.stringify(action)} is not declared by the contract` };
    }
    const data = message.data === undefined ? {} : message.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: false, reason: "data must be an object" };
    }
    for (const key of Object.keys(data)) {
        if (!Object.prototype.hasOwnProperty.call(declaredFields, key)) {
            return { ok: false, reason: `field ${JSON.stringify(key)} is not declared for action ${JSON.stringify(action)}` };
        }
    }
    const clean = {};
    for (const [field, declaredRaw] of Object.entries(declaredFields)) {
        const declared = String(declaredRaw || "");
        const optional = declared.endsWith("?");
        const type = optional ? declared.slice(0, -1) : declared;
        const value = data[field];
        if (value === undefined || value === null) {
            if (optional) continue;
            return { ok: false, reason: `required field ${JSON.stringify(field)} is missing` };
        }
        if (type === "json") {
            // One structured value for batched forms — a 23-item sign-off
            // submits as a single object, not 23 round trips. Internal shape
            // is the agent's contract with itself (it authored both sides);
            // the serialized-size cap below is the only bound that matters.
            if (typeof value !== "object") {
                return { ok: false, reason: `field ${JSON.stringify(field)} must be a JSON object or array` };
            }
            clean[field] = value;
            continue;
        }
        if (typeof value !== type) {
            return { ok: false, reason: `field ${JSON.stringify(field)} must be a ${type}` };
        }
        if (type === "string" && value.length > ACTION_MAX_STRING_CHARS) {
            return { ok: false, reason: `field ${JSON.stringify(field)} exceeds ${ACTION_MAX_STRING_CHARS} characters` };
        }
        if (type === "number" && !Number.isFinite(value)) {
            return { ok: false, reason: `field ${JSON.stringify(field)} must be a finite number` };
        }
        clean[field] = value;
    }
    if (serializedByteLength(clean) > ACTION_MAX_SERIALIZED_BYTES) {
        return { ok: false, reason: `action payload exceeds ${ACTION_MAX_SERIALIZED_BYTES} bytes` };
    }
    return { ok: true, action, data: clean };
}

/** The canonical wire text — what the agent reads and history flags on. */
export function formatCanvasActionPrompt(action, data) {
    return `${CANVAS_ACTION_PREFIX}${JSON.stringify({ action, data })}`;
}

/** Detector for the history pipelines: is this user message a canvas action? */
export function isCanvasActionContent(content) {
    return typeof content === "string" && content.startsWith(CANVAS_ACTION_PREFIX);
}

/** Parse the canonical text back to {action, data}; null when malformed. */
export function parseCanvasActionContent(content) {
    if (!isCanvasActionContent(content)) return null;
    try {
        const parsed = JSON.parse(content.slice(CANVAS_ACTION_PREFIX.length));
        if (!parsed || typeof parsed !== "object" || typeof parsed.action !== "string") return null;
        return { action: parsed.action, data: parsed.data && typeof parsed.data === "object" ? parsed.data : {} };
    } catch {
        return null;
    }
}

/**
 * A small sliding-window rate limiter: at most `burst` accepted actions per
 * `windowMs`. The page is agent-authored JS speaking AS the viewer, so this
 * is the bound on a buggy page auto-posting in a loop.
 */
export function createCanvasActionLimiter({ burst = 3, windowMs = 3000 } = {}) {
    const stamps = [];
    return function tryAcquire(now = Date.now()) {
        while (stamps.length && now - stamps[0] > windowMs) stamps.shift();
        if (stamps.length >= burst) return false;
        stamps.push(now);
        return true;
    };
}
