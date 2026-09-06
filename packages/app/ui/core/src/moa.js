// Saved desktop layouts contain references only. Never serialize session titles,
// transcripts, credentials, canvas HTML or access grants into a shared link.
export const MOA_SLOTS = 5;
export const MOA_MAX_PANELS = 16;
export const MOA_BREAKPOINT = 920;
export const MOA_SHARE_LIMIT = 24000;
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const id = (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export const emptyMoaPanel = () => ({ id: crypto.randomUUID(), type: "empty" });
export const moaLeaves = (n) => !n ? [] : n.type === "split" ? [...moaLeaves(n.first), ...moaLeaves(n.second)] : [n];
export function normalizeMoaLayout(value) {
    if (!object(value)) throw new Error("Invalid MoA layout.");
    const seen = new Set(); let panels = 0; let nodes = 0;
    function walk(n, depth = 0) {
        if (!object(n) || depth > 15 || ++nodes > 31 || !id(n.id) || seen.has(n.id)) throw new Error("Invalid MoA panel tree.");
        seen.add(n.id);
        if (n.type === "split") {
            if (!["row", "column"].includes(n.direction) || !Number.isFinite(n.ratio)) throw new Error("Invalid MoA split.");
            return { id: n.id, type: "split", direction: n.direction, ratio: Math.min(90, Math.max(10, n.ratio)), first: walk(n.first, depth + 1), second: walk(n.second, depth + 1) };
        }
        if (++panels > MOA_MAX_PANELS) throw new Error(`A MoA supports up to ${MOA_MAX_PANELS} panels.`);
        if (n.type === "empty") return { id: n.id, type: "empty" };
        if (!["chat", "canvas"].includes(n.type) || !id(n.sessionId)) throw new Error("Invalid MoA session reference.");
        if (n.type === "canvas" && (!Number.isInteger(n.slot) || n.slot < 1 || n.slot > 5)) throw new Error("Invalid canvas slot.");
        return { id: n.id, type: n.type, sessionId: n.sessionId, ...(n.type === "canvas" ? { slot: n.slot } : {}) };
    }
    return { name: typeof value.name === "string" ? value.name.trim().slice(0, 64) || "Untitled MoA" : "Untitled MoA", tree: value.tree == null ? null : walk(value.tree) };
}
export function normalizeMoa(value) {
    const slots = Array.from({ length: MOA_SLOTS }, (_, i) => {
        try { return normalizeMoaLayout(value?.slots?.[i]); } catch { return { name: `MoA ${i + 1}`, tree: null }; }
    });
    return { version: 1, activeSlot: Number.isInteger(value?.activeSlot) ? Math.max(0, Math.min(4, value.activeSlot)) : 0, slots };
}
export function replaceMoaNode(tree, nodeId, next) {
    if (!tree) return null;
    if (tree.id === nodeId) return next;
    if (tree.type !== "split") return tree;
    const first = replaceMoaNode(tree.first, nodeId, next), second = replaceMoaNode(tree.second, nodeId, next);
    if (!first) return second;
    if (!second) return first;
    return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}
export function encodeMoaShare(layout) {
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, ...normalizeMoaLayout(layout) }));
    const encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (encoded.length > MOA_SHARE_LIMIT) throw new Error("This MoA link is too large.");
    return encoded;
}
export function decodeMoaShare(encoded) {
    if (typeof encoded !== "string" || !encoded || encoded.length > MOA_SHARE_LIMIT || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid MoA link.");
    try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
        const data = JSON.parse(json);
        if (data.version !== 1) throw new Error("version");
        return normalizeMoaLayout(data);
    } catch { throw new Error("Invalid or unsupported MoA link."); }
}
