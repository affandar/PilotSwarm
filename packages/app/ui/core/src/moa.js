// Personal dashboards contain references and geometry only, never session data.
export const MOA_MAX_DASHBOARDS = 5;
export const MOA_MAX_PANELS = 16;
export const MOA_BREAKPOINT = 920;
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
    const safeLayout = (layout, dashboardId = "moa-1", name = "MoA 1") => {
        let tree = null;
        try { tree = normalizeMoaLayout(layout).tree; } catch {}
        const leaves = moaLeaves(tree);
        return { id: dashboardId, name: typeof layout?.name === "string" ? layout.name.trim().slice(0, 64) || name : name, tree,
            ...(Number.isFinite(layout?.aspectRatio) && layout.aspectRatio >= .2 && layout.aspectRatio <= 8 ? { aspectRatio: layout.aspectRatio } : {}),
            focusedPanelId: leaves.some(p => p.id === layout?.focusedPanelId) ? layout.focusedPanelId : leaves[0]?.id || null };
    };
    if (value?.version === 3 && Array.isArray(value.dashboards)) {
        const used = new Set();
        const dashboards = value.dashboards.slice(0, MOA_MAX_DASHBOARDS).map((dashboard, index) => {
            let key = id(dashboard?.id) && !used.has(dashboard.id) ? dashboard.id : `moa-${index + 1}`;
            while (used.has(key)) key += "-copy";
            used.add(key);
            return safeLayout(dashboard, key, `MoA ${index + 1}`);
        });
        if (!dashboards.length) dashboards.push(safeLayout(null));
        return { version: 3, activeDashboardId: dashboards.some(d => d.id === value.activeDashboardId) ? value.activeDashboardId : dashboards[0].id, dashboards };
    }
    let source = value;
    if (!(value?.version === 2 || (object(value) && Object.hasOwn(value, "tree")))) {
        // Match the old single-workspace migration; do not resurrect discarded tabs.
        const slots = Array.isArray(value?.slots) ? value.slots.slice(0, 5) : [];
        const active = Number.isInteger(value?.activeSlot) ? Math.max(0, Math.min(4, value.activeSlot)) : 0;
        source = safeLayout(slots[active]).tree ? slots[active] : slots.find(slot => safeLayout(slot).tree);
    }
    return { version: 3, activeDashboardId: "moa-1", dashboards: [safeLayout(source)] };
}
export const activeMoaDashboard = value => value.dashboards.find(d => d.id === value.activeDashboardId) || value.dashboards[0];
export function updateMoaDashboard(value, dashboardId, patch) {
    return normalizeMoa({ ...value, dashboards: value.dashboards.map(d => d.id === dashboardId ? { ...d, ...patch } : d) });
}
export function moveMoaDashboard(value, dashboardId, toIndex) {
    const normalized = normalizeMoa(value);
    const fromIndex = normalized.dashboards.findIndex(d => d.id === dashboardId);
    if (fromIndex < 0 || !Number.isInteger(toIndex)) return normalized;
    const dashboards = [...normalized.dashboards];
    const [dashboard] = dashboards.splice(fromIndex, 1);
    dashboards.splice(Math.max(0, Math.min(dashboards.length, toIndex)), 0, dashboard);
    return { ...normalized, dashboards };
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
