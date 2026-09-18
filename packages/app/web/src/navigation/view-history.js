// Only navigation references are persisted: never drafts, transcripts or file contents.
export const VIEW_HISTORY_LIMIT = 10;
const text = value => typeof value === "string" && value.length <= 1024 ? value : null;
export function cleanView(value) {
    if (!value || !["workspace", "moa", "admin", "budget"].includes(value.mode)) return null;
    return {
        mode: value.mode, sessionId: text(value.sessionId),
        dashboardId: text(value.dashboardId), panelId: text(value.panelId),
        moaZen: value.moaZen === true,
        canvasOpen: value.canvasOpen === true, canvasMaximized: value.canvasMaximized === true,
        canvasZen: value.canvasZen === true,
        canvasSlot: Number.isInteger(value.canvasSlot) && value.canvasSlot >= 1 && value.canvasSlot <= 5 ? value.canvasSlot : 1,
        diagnosticsOpen: value.diagnosticsOpen === true,
        artifactSessionId: text(value.artifactSessionId), artifactFilename: text(value.artifactFilename),
    };
}
export function viewKey(view) {
    if (view.mode === "moa") return JSON.stringify([view.mode, view.dashboardId, view.moaZen]);
    if (view.mode !== "workspace") return view.mode;
    return JSON.stringify([view.mode, view.sessionId, view.canvasOpen,
        view.canvasOpen ? view.canvasSlot : null, view.canvasMaximized, view.canvasZen,
        view.diagnosticsOpen, view.artifactSessionId, view.artifactFilename]);
}
export function createViewHistory(saved) {
    let entries = [], index = -1;
    try {
        const parsed = JSON.parse(saved);
        if (parsed?.version === 1 && Array.isArray(parsed.entries) && parsed.entries.length <= VIEW_HISTORY_LIMIT
            && Number.isInteger(parsed.index) && parsed.index >= 0 && parsed.index < parsed.entries.length) {
            const cleaned = parsed.entries.map(cleanView);
            if (cleaned.every(Boolean)) { entries = cleaned; index = parsed.index; }
        }
    } catch { /* Bad or unavailable storage starts with an empty history. */ }
    return {
        get entries() { return entries; }, get index() { return index; },
        get current() { return entries[index]; },
        destination(delta) { return entries[index + delta] || null; },
        replace(view) { if (index >= 0) entries[index] = cleanView(view); },
        visit(view) {
            const next = cleanView(view); if (!next) return false;
            if (entries[index] && viewKey(entries[index]) === viewKey(next)) { entries[index] = next; return false; }
            entries = [...entries.slice(0, index + 1), next].slice(-VIEW_HISTORY_LIMIT);
            index = entries.length - 1; return true;
        },
        move(delta) { if (![-1, 1].includes(delta) || !entries[index + delta]) return null; index += delta; return entries[index]; },
        serialize() { return JSON.stringify({ version: 1, entries, index }); },
    };
}

export function navigationShortcut(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing
        || event.getModifierState?.("AltGraph")) return 0;
    const target = event.target;
    // The composer keeps a draft per session, so navigation is safe while it
    // is focused. Other editors (search, settings, etc.) retain native input.
    if (!target?.matches?.('textarea.ps-prompt-input')
        && (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'))) return 0;
    // Option changes event.key on macOS; code keeps the physical +/- keys
    // usable. Accept the unshifted = key as well as Shift+= and the numpad.
    if (["Minus", "NumpadSubtract"].includes(event.code) || event.key === "-") return -1;
    if (["Equal", "NumpadAdd"].includes(event.code) || event.key === "+" || event.key === "=") return 1;
    return 0;
}
