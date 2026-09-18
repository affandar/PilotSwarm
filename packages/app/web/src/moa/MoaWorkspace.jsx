import React from "react";
import { CompactViewNavigation } from "../navigation/CompactViewNavigation.jsx";
import { createPortal } from "react-dom";
import { SessionHeaderStatus, ChatPane, CanvasFrame, SessionPane, SessionComposer, SessionDetailBox, ScopedModalLayer as ModalLayer, ControllerContext, createWebPilotSwarmController, useControllerSelector } from "pilotswarm/ui-react";
import { canvasKey, normalizeMoa, activeMoaDashboard, updateMoaDashboard, moveMoaDashboard, MOA_MAX_DASHBOARDS, emptyMoaPanel, moaLeaves, replaceMoaNode, MOA_MAX_PANELS, MOA_BREAKPOINT, selectSessionRows } from "pilotswarm/ui-core";
import "./moa.css";
import { panelRects, clockwisePanels, canSwipeFrom } from "./geometry.js";
import { paneLayout, boxStyle, emptySessionPanes } from "./pane-layout.js";
import { usePaneDrag } from "./use-pane-drag.js";

// Only an explicit terminal signal clears bindings; catalog absence is not deletion.
function clearSessionPanes(controller, sessionIds) {
    const current = normalizeMoa(controller.getState().ui.moa);
    const next = emptySessionPanes(current, sessionIds);
    if (next !== current) controller.dispatch({ type: "ui/moa", value: next });
}
const sessionUnavailable = error => [403, 404].includes(Number(error?.status)) || ["NOT_FOUND", "FORBIDDEN"].includes(String(error?.code || "").toUpperCase());

const draftListeners = new WeakMap();
const draftSends = new WeakMap();
const retainedOutboxes = new WeakMap();
const outboxListeners = new WeakMap();
const restoringDraft = new WeakSet();
function createRefreshScheduler(limit = 2) {
    const queue = []; let running = 0, queued = false;
    const pump = () => {
        queued = false;
        queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
        while (running < limit && queue.length) {
            const item = queue.shift(); running++;
            Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { running--; pump(); });
        }
    };
    let order = 0;
    return (task, priority = 1) => new Promise((resolve, reject) => {
        queue.push({ task, priority, order: order++, resolve, reject });
        if (!queued) { queued = true; queueMicrotask(pump); }
    });
}
// A composer becoming ready must not steal a keyboard resize in progress.
const canFocusMoaComposer = () => !document.activeElement?.closest?.(".ps-moa-divider, .ps-moa-dashboard-tabs");
const canFocusPaneComposer = () => canFocusMoaComposer() && !document.activeElement?.closest?.(".ps-moa-dialog, .ps-modal-backdrop, [data-moa-panel] button, [data-moa-panel] select, [data-moa-panel] input, [data-moa-panel] iframe, [data-moa-panel] [contenteditable=true]");
const sameDraft = (a, b) => a?.prompt === b?.prompt && (a?.attachments || []).length === (b?.attachments || []).length && (a?.attachments || []).every((item, i) => item === b.attachments[i]);
function publishDraft(store, key, draft) {
    if (sameDraft(store.get(key), draft)) return;
    store.set(key, draft);
    for (const listener of draftListeners.get(store) || []) listener(key, draft);
}
function restoreDraft(controller, draft) {
    if (!draft) return;
    restoringDraft.add(controller);
    try {
        controller.dispatch({ type: "ui/prompt", prompt: draft.prompt });
        controller.dispatch({ type: "ui/promptAttachments", attachments: draft.attachments });
    } finally { restoringDraft.delete(controller); }
}
function retainOutbox(store, key, items) {
    if (!retainedOutboxes.has(store)) retainedOutboxes.set(store, new Map());
    const outboxes = retainedOutboxes.get(store);
    outboxes.set(key, [...new Map([...(outboxes.get(key) || []), ...items].map(item => [item.id, item])).values()]);
    for (const listener of outboxListeners.get(store) || []) listener(key);
}
function restoreOutbox(store, key, controller) {
    const items = retainedOutboxes.get(store)?.get(key);
    if (!items) return;
    retainedOutboxes.get(store).delete(key);
    controller.setSessionOutboxItems(key, [...new Map([...controller.getSessionOutbox(key), ...items].map(item => [item.id, item])).values()]);
    controller.maybeFlushQueuedOutbox(key);
}

// Each panel has its own controller, but queued prompts belong to the session.
// Mirror the parent controller's outbox so the main chat and every panel show
// the same envelopes (and therefore preserve their deduplication IDs).
function linkSessionOutbox(parent, child, sessionId) {
    const setChildItems = child.setSessionOutboxItems.bind(child);
    let parentItems = parent.getState().outbox?.bySessionId?.[sessionId] || null;
    setChildItems(sessionId, parentItems || []);
    const unsubscribe = parent.subscribe(() => {
        const current = parent.getState().outbox?.bySessionId?.[sessionId] || null;
        if (current === parentItems) return;
        parentItems = current;
        setChildItems(sessionId, current || []);
    });
    const mirroredSet = (targetSessionId, items) => {
        if (targetSessionId === sessionId) parent.setSessionOutboxItems(sessionId, items);
        else setChildItems(targetSessionId, items);
    };
    child.setSessionOutboxItems = mirroredSet;
    let linked = true;
    return () => {
        if (!linked) return;
        linked = false;
        unsubscribe();
        if (child.setSessionOutboxItems === mirroredSet) child.setSessionOutboxItems = setChildItems;
    };
}

// One icon treatment for MoA actions; names remain available to keyboard and
// screen-reader users and as hover tooltips.
const ICON_PATHS = {
    add: "M12 4v16 M4 12h16",
    map: "M3 3h18v18H3z M12 3v18 M12 12h9",
    controls: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
    check: "m4 12 5 5L20 6",
    zen: "M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5",
    focus: "M7 17 17 7 M7 7h10v10",
    restore: "M3 8h5V3 M16 3v5h5 M21 16h-5v5 M8 21v-5H3",
    clear: "m15 3 6 6-10 10H5l-3-3z M8 10l6 6 M11 21h10",
    close: "m6 6 12 12 M6 18 18 6",
    closePanel: "M12 3H3v18h18v-9 M16 2l6 6 M22 2l-6 6",
    retry: "M20 7v5h-5 M20 12a8 8 0 1 0-2 6",
    replace: "M4 7h16l-4-4 M20 17H4l4 4",
    right: "M3 3h18v18H3z M12 3v18",
    below: "M3 3h18v18H3z M3 12h18",
    dropdown: "m6 9 6 7 6-7z",
    open: "M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7",
    remove: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
};
function IconButton({ label, icon, className = "", ...props }) {
    return <button className={`ps-mini-button ps-moa-icon-button ${className}`} aria-label={label} title={label} {...props}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={ICON_PATHS[icon]} /></svg>
    </button>;
}

function DashboardTabs({ value, onSelect, onPicker, onAdd, onEdit, onReorder }) {
    const track = React.useRef(null), strip = React.useRef(null);
    const [compact, setCompact] = React.useState(true), [drag, setDrag] = React.useState(null);
    const pointerDrag = React.useRef(null), suppressClick = React.useRef(null), suppressTimer = React.useRef(null);
    React.useLayoutEffect(() => {
        const measure = () => setCompact(strip.current.scrollWidth > track.current.clientWidth);
        const observer = new ResizeObserver(measure);
        observer.observe(track.current); observer.observe(strip.current); measure();
        return () => observer.disconnect();
    }, [value.dashboards]);
    React.useEffect(() => {
        const finish = event => {
            const current = pointerDrag.current; pointerDrag.current = null;
            if (!current?.started) { setDrag(null); return; }
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".ps-moa-tab-strip button[data-dashboard-id]");
            const targetId = target?.dataset.dashboardId;
            if (targetId && targetId !== current.id) {
                const from = value.dashboards.findIndex(item => item.id === current.id), targetIndex = value.dashboards.findIndex(item => item.id === targetId);
                const box = target.getBoundingClientRect(), insertion = targetIndex + (event.clientX >= box.left + box.width / 2 ? 1 : 0);
                onReorder(current.id, insertion - (from < insertion ? 1 : 0));
            }
            // A browser may synthesize one click immediately after pointerup.
            // Suppress only that event turn; if no synthesized click arrives,
            // a later deliberate click on the moved tab must still activate it.
            suppressClick.current = current.id;
            clearTimeout(suppressTimer.current);
            suppressTimer.current = setTimeout(() => {
                if (suppressClick.current === current.id) suppressClick.current = null;
            }, 0);
            setDrag(null);
        };
        const move = event => {
            const current = pointerDrag.current;
            if (!current || (current.pointerId != null && event.pointerId !== current.pointerId)) return;
            if (!current.started && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
            current.started = true;
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".ps-moa-tab-strip button[data-dashboard-id]");
            if (!target) { setDrag({ id: current.id }); return; }
            const box = target.getBoundingClientRect();
            setDrag({ id: current.id, targetId: target.dataset.dashboardId, after: event.clientX >= box.left + box.width / 2 });
        };
        const cancel = () => { pointerDrag.current = null; setDrag(null); };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", cancel);
        return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel); };
    }, [value.dashboards, onReorder]);
    React.useEffect(() => () => clearTimeout(suppressTimer.current), []);
    const active = activeMoaDashboard(value);
    return <nav className={`ps-moa-dashboard-tabs ${compact ? "is-compact" : ""}`} aria-label="MoA dashboards">
        <div ref={track} className="ps-moa-tabs-track">
            <div ref={strip} role="tablist" aria-label="MoA dashboards" aria-hidden={compact || undefined} className={`ps-moa-tab-strip ${compact ? "is-collapsed" : ""}`}>
                {value.dashboards.map((d, index) => <button key={d.id} role="tab" data-dashboard-id={d.id} aria-selected={d.id === active.id} tabIndex={d.id === active.id ? 0 : -1} title={`${d.name} · Drag to reorder`} className={`${drag?.id === d.id ? "is-dragging" : ""} ${drag?.targetId === d.id ? `is-drop-${drag.after ? "after" : "before"}` : ""}`}
                    onPointerDown={e => { if (e.button !== 0) return; pointerDrag.current = { id: d.id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, started: false }; }}
                    onClick={e => { if (suppressClick.current === d.id) { clearTimeout(suppressTimer.current); suppressClick.current = null; e.preventDefault(); return; } onSelect(d.id); }}
                    onKeyDown={e => {
                    if (e.altKey && e.shiftKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
                        e.preventDefault(); e.stopPropagation();
                        const next = Math.max(0, Math.min(value.dashboards.length - 1, index + (e.key === "ArrowLeft" ? -1 : 1)));
                        if (next !== index) onReorder(d.id, next);
                        requestAnimationFrame(() => document.querySelector(`.ps-moa-tab-strip button[aria-selected="true"]`)?.focus());
                        return;
                    }
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                    e.preventDefault(); e.stopPropagation();
                    const next = e.key === "Home" ? 0 : e.key === "End" ? value.dashboards.length - 1 : (index + (e.key === "ArrowLeft" ? -1 : 1) + value.dashboards.length) % value.dashboards.length;
                    onSelect(value.dashboards[next].id);
                    // Dashboard views remount; restore keyboard focus in the new tablist.
                    requestAnimationFrame(() => document.querySelector('.ps-moa-tab-strip button[aria-selected="true"]')?.focus());
                }}>{d.name}</button>)}
            </div>
            {compact && <button className="ps-mini-button ps-moa-dashboard-trigger" aria-label="Switch MoA dashboard" title={active.name} onClick={onPicker}><span>{active.name}</span><span aria-hidden="true">⌄</span></button>}
        </div>
        <IconButton label="Add MoA dashboard" icon="add" disabled={value.dashboards.length >= MOA_MAX_DASHBOARDS} onClick={onAdd} />
        <IconButton label="Dashboard options" icon="controls" onClick={onEdit} />
    </nav>;
}

function DashboardPreview({ dashboard }) {
    return <span className="ps-moa-dashboard-preview" aria-hidden="true" style={{ aspectRatio: dashboard.aspectRatio || 16 / 9 }}>
        {panelRects(dashboard.tree).map(({ node, x, y, width, height }) => <span key={node.id} className={node.id === dashboard.focusedPanelId ? "is-selected" : ""} style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }} />)}
    </span>;
}

function useDesktop() {
    const [desktop, setDesktop] = React.useState(() => window.innerWidth > MOA_BREAKPOINT);
    React.useEffect(() => {
        const media = window.matchMedia(`(min-width: ${MOA_BREAKPOINT + 1}px)`);
        const update = () => setDesktop(media.matches); update();
        media.addEventListener("change", update); return () => media.removeEventListener("change", update);
    }, []);
    return desktop;
}
export function useMoa(controller) {
    const desktop = useDesktop();
    const stored = useControllerSelector(controller, s => s.ui.moa);
    const loaded = useControllerSelector(controller, s => s.ui.moaLoaded === true);
    const goneIds = useControllerSelector(controller, s => s.sessions.goneIds);
    React.useEffect(() => {
        if (loaded && goneIds?.length) clearSessionPanes(controller, goneIds);
    }, [controller, loaded, goneIds, stored]);
    const saveStatus = useControllerSelector(controller, s => s.ui.moaSaveStatus);
    const value = React.useMemo(() => normalizeMoa(stored), [stored]);
    const [active, setActive] = React.useState(false), [zen, setZen] = React.useState(false), [returnTo, setReturnTo] = React.useState(false);
    React.useEffect(() => { try { sessionStorage.removeItem("pilotswarm.moa.shared"); } catch {} }, []);
    const drafts = React.useRef(new Map());
    const panels = React.useRef(new Map());
    const zenDrafts = React.useRef(new Map());
    const refreshScheduler = React.useMemo(() => createRefreshScheduler(2), []);
    const update = React.useCallback(next => controller.dispatch({ type: "ui/moa", value: next }), [controller]);
    const [mobileZen, setMobileZen] = React.useState(false);
    React.useEffect(() => { if (desktop) setMobileZen(false); }, [desktop]);
    const open = () => { if (loaded) {
        if (!active) {
            const state = controller.getState(), sessionId = state.sessions.activeSessionId;
            if (sessionId) publishDraft(drafts.current, sessionId, { prompt: state.ui.prompt, attachments: state.ui.promptAttachments || [] });
        }
        controller.navigationGeneration = (controller.navigationGeneration || 0) + 1;
        setMobileZen(false); setActive(true); setReturnTo(false);
    } };
    const leave = () => { setActive(false); setZen(false); };
    const openMobileZen = () => { if (!desktop) { leave(); setMobileZen(true); } };
    return { desktop, loaded, value, update, saveStatus, active, zen: active && zen, setZen, open, leave, returnTo, setReturnTo, drafts, panels, restoreSessionDraft: sessionId => restoreDraft(controller, drafts.current.get(sessionId)), zenDrafts, refreshScheduler, mobileZen: !desktop && mobileZen, openMobileZen, closeMobileZen: () => setMobileZen(false) };
}

function Modal({ title, onClose, children, hideHeader = false, dismissible = true }) {
    const ref = React.useRef(null), closeRef = React.useRef(onClose); closeRef.current = dismissible ? onClose : () => {};
    React.useLayoutEffect(() => {
        const viewport = window.visualViewport;
        const update = () => {
            const backdrop = ref.current?.parentElement;
            if (!backdrop || !viewport) return;
            Object.assign(backdrop.style, { top: `${viewport.offsetTop}px`, left: `${viewport.offsetLeft}px`, width: `${viewport.width}px`, height: `${viewport.height}px`, bottom: "auto", right: "auto" });
            backdrop.style.setProperty("--ps-moa-viewport-height", `${viewport.height}px`);
        };
        update(); viewport?.addEventListener("resize", update); viewport?.addEventListener("scroll", update);
        return () => { viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update); };
    }, []);
    React.useEffect(() => {
        const previous = document.activeElement;
        ((window.innerWidth > MOA_BREAKPOINT && ref.current?.querySelector("input:not(:disabled)")) || ref.current?.querySelector("button:not(:disabled),select:not(:disabled)"))?.focus({ preventScroll: true });
        const key = e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
            if (e.key !== "Tab") return;
            const nodes = [...ref.current.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']")].filter(n => n.getClientRects().length);
            const first = nodes[0], last = nodes.at(-1);
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        };
        const node = ref.current; node.addEventListener("keydown", key);
        return () => { node.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
    }, []);
    return createPortal(<div className="ps-moa-backdrop" onMouseDown={e => { if (dismissible && e.target === e.currentTarget) onClose(); }}>
        <section ref={ref} className="ps-moa-dialog" role="dialog" aria-modal="true" aria-label={title}>
            {!hideHeader && <header><strong>{title}</strong>{dismissible && <button className="ps-mini-button" aria-label="Close dialog" onClick={onClose}>×</button>}</header>}{children}
        </section>
    </div>, document.body);
}

function SessionPicker({ controller, onChoose, onClose, onCreate, initial }) {
    const state = useControllerSelector(controller, s => s);
    const [selected, setSelected] = React.useState(initial?.sessionId || null), [query, setQuery] = React.useState("");
    const [kind, setKind] = React.useState(initial?.type === "canvas" ? String(initial.slot) : "chat");
    const [loading, setLoading] = React.useState(false), [error, setError] = React.useState("");
    React.useEffect(() => {
        if (!selected || state.sessions.byId[selected]?.isGroup) return;
        let active = true; setLoading(true); setError("");
        controller.ensureCanvasSnapshot(selected).catch(() => { if (active) setError("Could not load canvases. Select the session again to retry."); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [controller, selected]);
    const session = state.sessions.byId[selected];
    const canvases = [1, 2, 3, 4, 5].map(slot => ({ slot, ...state.canvas?.bySessionId?.[canvasKey(selected, slot)] })).filter(c => c.latestRev > 0 && c.sizeBytes !== 0);
    return <Modal title="Sessions" onClose={onClose} hideHeader>
        <SessionPane controller={controller} structuredRows showDetailBox panelClassName="ps-moa-session-picker" actions={<><button className="ps-mini-button" aria-label="Close dialog" onClick={onClose}>×</button></>} selection={{ onCreate, sessionId: selected, query, onQuery: setQuery, onSelect: id => { setSelected(id); setKind("chat"); } }} />
        <footer className="ps-moa-picker-detail"><div>{session?.title || (selected ? selected : "Select a session")}</div>
            <div className="ps-moa-row"><label htmlFor="moa-content-kind">Show</label><select id="moa-content-kind" value={kind} onChange={e => setKind(e.target.value)} disabled={!selected}>
                <option value="chat">Session chat</option>{canvases.map(c => <option key={c.slot} value={c.slot}>Canvas {c.slot}{c.name ? ` · ${c.name}` : ""}</option>)}
            </select><IconButton label={`Use ${kind === "chat" ? "chat" : "canvas"}`} icon="check" disabled={!session || session.isGroup || (kind !== "chat" && !canvases.some(c => String(c.slot) === kind))} onClick={() => onChoose({ type: kind === "chat" ? "chat" : "canvas", sessionId: selected, ...(kind !== "chat" ? { slot: Number(kind) } : {}) })} /></div>
            {loading ? <small>Loading canvases…</small> : error ? <small role="alert">{error}</small> : selected && !canvases.length ? <small>No canvases in this session yet.</small> : null}
        </footer>
    </Modal>;
}

function LivePanel({ node, panels, panelKey, mobile = false, visible = true, focused, parent, createTransport, drafts, draftKey, refreshScheduler, onPanelKey, composerHost, perChat, onArtifact, header, controlsHost, onControlAction, mobileStatusHost }) {
    const [ready, setReady] = React.useState(null), [error, setError] = React.useState(""), [retry, setRetry] = React.useState(0);
    const resources = React.useRef(null);
    React.useEffect(() => {
        if (!ready || !panels) return;
        panels.current.set(panelKey, ready);
        return () => { if (panels.current.get(panelKey) === ready) panels.current.delete(panelKey); };
    }, [ready, panels, panelKey]);
    const themeId = useControllerSelector(parent, s => s.ui.themeId);
    const [actionsOpen, setActionsOpen] = React.useState(false);
    const focusedRef = React.useRef(focused); focusedRef.current = focused && !actionsOpen;
    React.useEffect(() => {
        if (!ready) return;
        const store = drafts.current;
        if (!draftListeners.has(store)) draftListeners.set(store, new Set());
        if (!outboxListeners.has(store)) outboxListeners.set(store, new Set());
        const listener = (key, draft) => { if (key === draftKey && focusedRef.current && !sameDraft({ prompt: ready.getState().ui.prompt, attachments: ready.getPromptAttachments() }, draft)) restoreDraft(ready, draft); };
        const outboxListener = key => { if (key === draftKey && focusedRef.current) restoreOutbox(store, key, ready); };
        draftListeners.get(store).add(listener);
        outboxListeners.get(store).add(outboxListener);
        listener(draftKey, store.get(draftKey));
        outboxListener(draftKey);
        return () => { draftListeners.get(store).delete(listener); outboxListeners.get(store).delete(outboxListener); };
    }, [ready, drafts, draftKey]);
    React.useEffect(() => () => {
        const cached = resources.current;
        if (!cached) return;
        cached.disposed = true;
        clearInterval(cached.timer);
        cached.child.stop().catch(() => {});
    }, []);
    React.useEffect(() => {
        if (!visible) return;
        let cancelled = false, offDraft, offOutbox, pendingSend, wrappedSend, wrappedSchedule;
        setError("");
        if (!resources.current) {
            const transport = createTransport();
            const child = createWebPilotSwarmController({ transport, branding: parent.getState().branding });
            resources.current = { child, transport, started: false, disposed: false, generation: 0, timer: null, polling: false,
                send: child.sendPrompt.bind(child), scheduleDispatch: child.scheduleOutboxDispatch.bind(child) };
        }
        const cached = resources.current, { child, transport } = cached;
        let reportedGone = false;
        const reportGone = () => {
            if (cancelled || reportedGone) return;
            reportedGone = true;
            clearInterval(cached.timer); cached.timer = null;
            child.detachActiveSession();
            clearSessionPanes(parent, [node.sessionId]);
            parent.handleSessionGone(node.sessionId);
        };
        // Lifecycle actions run in the panel's isolated controller. Forward
        // terminal eviction to every binding, including inactive dashboards.
        const offGone = child.subscribe(s => {
            if (s.sessions.goneIds?.includes(node.sessionId)) reportGone();
        });
        const generation = ++cached.generation;
        cached.activeGeneration = generation;
        const ownsResources = () => cached.activeGeneration === generation && !cached.disposed && !reportedGone;
        const retireIfUnused = () => {
            // loadSession attaches internally after its history request. A
            // request from an older generation may finish after every newer
            // visit has already gone hidden; no active effect then owns that
            // newly attached subscription, so retire it immediately.
            if (cached.disposed) {
                child.detachActiveSession();
                child.stop().catch(() => {});
            } else if (cached.activeGeneration == null) {
                child.detachActiveSession();
            }
        };
        const handoffPendingOutbox = () => {
            // A linked panel already writes every update to the parent. Moving
            // those items into the panel-only retained store would hide them
            // from the main chat until a panel is opened again.
            if (offOutbox) return;
            const items = child?.getPendingOutboxItems(node.sessionId) || [];
            if (!items.length) return;
            const ids = new Set(items.map(item => item.id));
            child.setSessionOutboxItems(node.sessionId, child.getSessionOutbox(node.sessionId).filter(item => !ids.has(item.id)));
            retainOutbox(drafts.current, draftKey, items);
        };
        const suspend = async () => {
            // React runs the outgoing effect cleanup before starting the next
            // visible generation. Cleanup may then await an in-flight send or
            // retry while a rapid A → B → A switch resumes this same cached
            // controller. An obsolete cleanup must never detach that newer
            // generation or clear its polling timer.
            if (cached.generation !== generation) return;
            clearInterval(cached.timer); cached.timer = null; offDraft?.();
            if (child.sendPrompt === wrappedSend) child.sendPrompt = cached.send;
            if (child.scheduleOutboxDispatch === wrappedSchedule) child.scheduleOutboxDispatch = cached.scheduleDispatch;
            for (const timer of child?._outboxDispatchTimers?.values() || []) clearTimeout(timer);
            child?._outboxDispatchTimers?.clear();
            await pendingSend?.catch(() => {});
            // A retry may already be in flight after sendPrompt returned.
            // Settle that exact envelope before handing it to the next view.
            await Promise.allSettled([...(child?.outboxFlushPromises?.values() || [])]);
            if (cached.generation !== generation) return;
            handoffPendingOutbox();
            offOutbox?.(); offOutbox = null;
            child.detachActiveSession();
        };
        refreshScheduler(async () => {
            if (cancelled || !ownsResources()) return;
            if (!cached.started) { await transport.start(); cached.started = true; }
            if (cancelled || !ownsResources()) { retireIfUnused(); return suspend(); }
            const session = await transport.getSession(node.sessionId);
            if (cancelled || !ownsResources()) { retireIfUnused(); return suspend(); }
            if (!session) { reportGone(); return; }
            if (session.sessionId !== node.sessionId) throw new Error("Unexpected session response.");
            const auth = transport.getAuthContext();
            child.dispatch({ type: "auth/context", principal: auth?.principal, authorization: auth?.authorization });
            child.dispatch({ type: "connection/ready", statusText: "Connected" });
            child.dispatch({ type: "sessions/merged", session });
            child.dispatch({ type: "sessions/navigationIntent", sessionId: node.sessionId });
            await child.loadSession(node.sessionId);
            if (cancelled || !ownsResources()) { retireIfUnused(); return suspend(); }
            cached.outboxLink?.();
            const unlink = linkSessionOutbox(parent, child, node.sessionId);
            cached.outboxLink = unlink;
            offOutbox = () => {
                if (cached.outboxLink === unlink) cached.outboxLink = null;
                unlink();
            };
            child.dispatch({ type: "profileSettings/apply", settings: { themeId: parent.getState().ui.themeId } });
            child.setFocus("prompt");
            const draft = drafts.current.get(draftKey);
            if (draft) { child.dispatch({ type: "ui/prompt", prompt: draft.prompt }); child.dispatch({ type: "ui/promptAttachments", attachments: draft.attachments }); }
            offDraft = child.subscribe(s => { if (focusedRef.current && !restoringDraft.has(child)) publishDraft(drafts.current, draftKey, { prompt: s.ui.prompt, attachments: s.ui.promptAttachments || [] }); });
            // Defense in depth: no hidden composer, stale selection or attachment
            // from another session may redirect a send to a different agent.
            wrappedSchedule = sessionId => { if (!cancelled) cached.scheduleDispatch(sessionId); };
            child.scheduleOutboxDispatch = wrappedSchedule;
            wrappedSend = async () => {
                const state = child.getState();
                if (cancelled || !focusedRef.current || state.ui.modal || state.sessions.activeSessionId !== node.sessionId || child.getPromptAttachments().some(a => a.sessionId && a.sessionId !== node.sessionId)) return;
                const store = drafts.current;
                if (!draftSends.has(store)) draftSends.set(store, new Set());
                const sending = draftSends.get(store);
                if (sending.has(draftKey)) return;
                sending.add(draftKey);
                parent.dispatch({ type: "sessions/used", sessionId: node.sessionId });
                const submitted = { prompt: state.ui.prompt, attachments: state.ui.promptAttachments || [] };
                try {
                    pendingSend = cached.send();
                    await pendingSend;
                    // An upload can finish after this view unmounts. Reconcile
                    // only the submitted draft, never text typed in another view.
                    const current = child.getState(), saved = store.get(draftKey);
                    const failedItems = child.getPendingOutboxItems(node.sessionId);
                    // Preserve the original deduplication IDs on ambiguous
                    // failures; never turn an attempted send into a new prompt.
                    if (cancelled && failedItems.length) handoffPendingOutbox();
                    if (sameDraft(saved, submitted) && !current.ui.prompt && !current.ui.promptAttachments?.length) {
                        publishDraft(store, draftKey, { prompt: "", attachments: [] });
                    }
                } finally { pendingSend = null; sending.delete(draftKey); }
            };
            child.sendPrompt = wrappedSend;
            cached.timer = setInterval(() => refreshScheduler(async () => {
                if (cached.polling || cancelled || !ownsResources()) return; cached.polling = true;
                try {
                    const current = await transport.getSession(node.sessionId);
                    if (cancelled || !ownsResources()) return;
                    if (!current) { reportGone(); return; }
                    if (current.sessionId !== node.sessionId) throw new Error("Unexpected session response.");
                    child.dispatch({ type: "sessions/merged", session: current });
                    await child.syncSessionEvents(node.sessionId);
                } catch (e) {
                    if (sessionUnavailable(e)) { reportGone(); return; }
                    if (!cancelled) { setError("Connection interrupted. Retry to reconnect."); clearInterval(cached.timer); cached.timer = null; child.detachActiveSession(); }
                } finally { cached.polling = false; }
            }, focusedRef.current ? 0 : 1).catch(() => {}), 4000);
            if (ownsResources()) setReady(child);
        }, focused ? 0 : 1).catch(async e => {
            if (sessionUnavailable(e)) reportGone();
            else if (!cancelled) setError("Could not open this session. Retry to reconnect.");
            await suspend();
        });
        return () => {
            cancelled = true; offGone();
            if (cached.activeGeneration === generation) cached.activeGeneration = null;
            suspend();
        };
    }, [visible, node.sessionId, createTransport, parent, retry, drafts, draftKey, refreshScheduler]);
    React.useEffect(() => { ready?.dispatch({ type: "profileSettings/apply", settings: { themeId } }); }, [ready, themeId]);
    React.useLayoutEffect(() => {
        if (ready && focused) {
            const draft = drafts.current.get(draftKey);
            restoreDraft(ready, draft);
            restoreOutbox(drafts.current, draftKey, ready);
            ready.setFocus("prompt");
        }
    }, [ready, focused, drafts, draftKey]);
    React.useEffect(() => {
        if (!ready) return;
        ready.openChatArtifact = onArtifact;
        return () => { delete ready.openChatArtifact; };
    }, [ready, onArtifact]);
    const ref = React.useRef(null);
    const focusReadOnlyPanel = React.useCallback(() => ref.current?.closest("[data-moa-panel]")?.focus({ preventScroll: true }), []);
    React.useEffect(() => {
        if (!ready || !ref.current) return;
        const observer = new ResizeObserver(([entry]) => ready.dispatch({ type: "ui/viewport", width: Math.max(20, Math.floor(entry.contentRect.width / 8)), height: Math.max(10, Math.floor(entry.contentRect.height / 16)) }));
        observer.observe(ref.current); return () => observer.disconnect();
    }, [ready]);
    return <>
        <header>{header.title}{ready && !mobile && <SessionHeaderStatus controller={ready} />}{error && ready && <button className="ps-moa-stale" title={error} onClick={() => setRetry(n => n + 1)}>Cached · Retry</button>}{header.actions}</header>
        {ready && <SessionPane controller={ready} actionsOnly actionsHost={controlsHost} onAction={onControlAction} onDialogChange={setActionsOpen} />}
        <div ref={ref} className="ps-moa-live">
            {ready ? <ControllerContext.Provider value={ready}>{node.type === "chat" ? <ChatPane controller={ready} mobile={mobile} fullWidth showComposer={false} activityInHeader /> : <PinnedCanvas controller={ready} node={node} onPanelKey={onPanelKey} />}</ControllerContext.Provider> : error ? <div className="ps-moa-empty" role="status"><p>{error}</p><IconButton label="Retry" icon="retry" onClick={() => setRetry(n => n + 1)} /></div> : <div className="ps-moa-empty" role="status">Connecting…</div>}
        </div>
        {ready && mobile && mobileStatusHost && createPortal(<SessionHeaderStatus controller={ready} />, mobileStatusHost)}
        {ready && visible && <ModalLayer controller={ready} />}
        {ready && visible && perChat && node.type === "chat" && <footer hidden={!focused || actionsOpen} className="ps-moa-pane-composer" aria-label="Session composer" data-session-id={node.sessionId}>
            <ControllerContext.Provider value={ready}><SessionComposer controller={ready} mobile={mobile} compact autoFocus={focused && !actionsOpen ? canFocusPaneComposer : false} onReadOnlyFocus={focusReadOnlyPanel} /></ControllerContext.Provider>
        </footer>}
        {ready && focused && !actionsOpen && !perChat && composerHost && createPortal(<ControllerContext.Provider value={ready}><SessionComposer controller={ready} mobile={mobile} compact={mobile} autoFocus={canFocusMoaComposer} onReadOnlyFocus={focusReadOnlyPanel} /></ControllerContext.Provider>, composerHost)}
    </>;
}

// The standard model → reasoning → agent flow gets a temporary controller so
// creating from MoA never changes the default workspace's selected session.
function CreatePanelSession({ parent, createTransport, onCreated, onClose }) {
    const [child, setChild] = React.useState(null), [phase, setPhase] = React.useState("Opening session dialog…"), [error, setError] = React.useState("");
    const callbacks = React.useRef({ onCreated, onClose }); callbacks.current = { onCreated, onClose };
    React.useEffect(() => {
        let cancelled = false, busy = false, seenModal = false, off, timer;
        const transport = createTransport(), controller = createWebPilotSwarmController({ transport, branding: parent.getState().branding });
        const stop = async () => { clearTimeout(timer); off?.(); await controller.stop().catch(() => {}); };
        for (const method of ["createSession", "createSessionForAgent"]) {
            const original = controller[method].bind(controller);
            controller[method] = async (...args) => {
                busy = true; if (!cancelled) setPhase("Creating session…");
                const created = await original(...args);
                if (!cancelled) {
                    if (created?.sessionId) callbacks.current.onCreated({ ...created, ...controller.getState().sessions.byId[created.sessionId] });
                    else setError(controller.getState().ui.statusText || "Could not create session. Close and try again.");
                }
                return created;
            };
        }
        (async () => {
            await transport.start(); if (cancelled) return stop();
            const auth = transport.getAuthContext();
            controller.dispatch({ type: "auth/context", principal: auth?.principal, authorization: auth?.authorization });
            controller.dispatch({ type: "profileSettings/apply", settings: { themeId: parent.getState().ui.themeId } });
            controller.dispatch({ type: "connection/ready", statusText: "Connected" });
            off = controller.subscribe(state => {
                if (state.ui.modal) seenModal = true;
                if (seenModal && !state.ui.modal) {
                    clearTimeout(timer);
                    timer = setTimeout(() => { if (!cancelled && !busy && !controller.getState().ui.modal) callbacks.current.onClose(); }, 0);
                }
            });
            setChild(controller);
            await controller.openModelPicker();
            if (!cancelled && !controller.getState().ui.modal && !busy) setError("Could not open session creation. Close and try again.");
        })().catch(e => { if (!cancelled) setError(e.message || "Could not open session creation."); });
        return () => { cancelled = true; stop(); };
    }, [parent, createTransport]);
    return child ? <CreationSurface controller={child} phase={phase} error={error} onClose={onClose} /> : <Modal title="Create new session" onClose={onClose}><p className="ps-moa-menu">{error || phase}</p></Modal>;
}
function CreationSurface({ controller, phase, error, onClose }) {
    const modal = useControllerSelector(controller, state => state.ui.modal);
    return <ControllerContext.Provider value={controller}>{modal ? <ModalLayer controller={controller} /> : <Modal title="Create new session" onClose={onClose} dismissible={phase !== "Creating session…" || Boolean(error)}><p className="ps-moa-menu" role={error ? "alert" : "status"}>{error || phase}</p></Modal>}</ControllerContext.Provider>;
}

function PinnedCanvas({ controller, node, onPanelKey }) {
    const entry = useControllerSelector(controller, s => s.canvas?.bySessionId?.[canvasKey(node.sessionId, node.slot)]);
    if (!entry?.latestRev || entry.sizeBytes === 0) return <div className="ps-moa-empty">Canvas {node.slot} is empty or no longer available.</div>;
    return <CanvasFrame onPanelKey={onPanelKey} key={`${node.sessionId}:${node.slot}`} controller={controller} sessionId={node.sessionId} slot={node.slot} latestRev={entry.latestRev} zoom={1} dataRev={entry.latestDataRev || 0} dataPayload={entry.dataPayload || null} dataPatch={entry.dataPatch || null} />;
}

function PaneDivider({ item, stage, onPreview, onResize }) {
    const { node, box, bounds } = item;
    const start = React.useRef(null), ratio = React.useRef(node.ratio);
    const finish = event => {
        if (!start.current || event.pointerId !== start.current.pointerId) return;
        start.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        onResize(ratio.current); onPreview(null);
    };
    const cancel = () => { start.current = null; onPreview(null); };
    return <div style={boxStyle(box)} data-moa-divider={node.id} className="ps-moa-divider" role="separator" tabIndex={0} aria-label="Resize MoA panels" aria-orientation={node.direction === "row" ? "vertical" : "horizontal"} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(node.ratio)}
        onKeyDown={e => { if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); onResize(e.key === "Home" ? 10 : e.key === "End" ? 90 : Math.max(10, Math.min(90, node.ratio + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -2 : 2)))); }}
        onPointerDown={e => { if (e.button !== 0 || e.isPrimary === false) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); start.current = { pointerId: e.pointerId }; ratio.current = node.ratio; }}
        onPointerMove={e => {
            if (!start.current || e.pointerId !== start.current.pointerId) return;
            const rect = stage.current.getBoundingClientRect(), row = node.direction === "row";
            const size = row ? rect.width : rect.height, axis = bounds[row ? "x" : "y"], extent = bounds[row ? "width" : "height"];
            const offset = (row ? e.clientX - rect.left : e.clientY - rect.top) - axis[0] * size - axis[1] - 4;
            ratio.current = Math.max(10, Math.min(90, 100 * offset / Math.max(1, extent[0] * size + extent[1] - 8)));
            onPreview({ id: node.id, ratio: ratio.current });
        }} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={() => { if (start.current) cancel(); }} />;
}

export function MoaWorkspace(props) {
    const { moa } = props, active = activeMoaDashboard(moa.value);
    return <div hidden={!props.visible} data-dashboard-id={active.id} className={`ps-moa-workspace ${!moa.desktop ? "is-mobile" : ""} ${moa.zen ? "is-zen" : ""}`}>
        {moa.value.dashboards.map(layout => <MoaDashboard key={layout.id} {...props} layout={layout} visible={Boolean(props.visible && layout.id === active.id)} />)}
    </div>;
}
function MoaDashboard({ controller, moa, viewNavigation, createTransport, layout, visible }) {
    const { value, update } = moa, mobile = !moa.desktop;
    const [mapOpen, setMapOpen] = React.useState(false);
    const [dashboardPicker, setDashboardPicker] = React.useState(false), [dashboardEdit, setDashboardEdit] = React.useState(null);
    const swipeStart = React.useRef(null), suppressDashboardClickUntil = React.useRef(0);
    const state = useControllerSelector(controller, s => s);
    const focus = layout.focusedPanelId;
    const setFocus = id => { const current = normalizeMoa(controller.getState().ui.moa); if (id !== current.dashboards.find(d => d.id === layout.id)?.focusedPanelId) update(updateMoaDashboard(current, layout.id, { focusedPanelId: id })); };
    const [picker, setPicker] = React.useState(null), [menu, setMenu] = React.useState(null), [error, setError] = React.useState("");
    const closePicker = React.useCallback(() => setPicker(null), []), closeMenu = React.useCallback(() => setMenu(null), []);
    const [clearing, setClearing] = React.useState(false);
    const layoutRef = React.useRef(null), stageRef = React.useRef(null);
    const [resizeDraft, setResizeDraft] = React.useState(null), [undo, setUndo] = React.useState(null);
    const [beforeHistoryHost, setBeforeHistoryHost] = React.useState(null), [afterHistoryHost, setAfterHistoryHost] = React.useState(null), [statusHost, setStatusHost] = React.useState(null);
    React.useLayoutEffect(() => {
        setBeforeHistoryHost(document.getElementById("ps-toolbar-before-history"));
        setAfterHistoryHost(document.getElementById("ps-toolbar-after-history"));
        setStatusHost(document.getElementById("ps-moa-status-slot"));
    });
    const [controlsHost, setControlsHost] = React.useState(null);
    const [mobileStatusHost, setMobileStatusHost] = React.useState(null);
    const [composerHost, setComposerHost] = React.useState(null), [creating, setCreating] = React.useState(null);
    const nodes = moaLeaves(layout.tree), selected = nodes.some(n => n.id === focus) ? focus : nodes[0]?.id;
    const focusedSessionId = nodes.find(node => node.id === selected)?.sessionId;
    React.useEffect(() => {
        if (menu?.sessionId && !moaLeaves(layout.tree).some(n => n.id === menu.id && n.sessionId === menu.sessionId)) setMenu(null);
    }, [layout.tree, menu]);
    React.useEffect(() => {
        if (visible && focusedSessionId) controller.dispatch({ type: "sessions/used", sessionId: focusedSessionId });
    }, [controller, visible, focusedSessionId]);
    const menuRow = menu?.sessionId ? selectSessionRows(state).find(row => row.sessionId === menu.sessionId) : null;
    React.useEffect(() => {
        if (visible && !layout.tree) layoutRef.current?.querySelector(".ps-moa-add")?.focus({ preventScroll: true });
    }, [visible, layout.id, Boolean(layout.tree)]);
    const geometryRef = React.useRef({ value, update, layout }); geometryRef.current = { value, update, layout };
    React.useEffect(() => {
        if (!visible || mobile || !layoutRef.current) return;
        let timer;
        const observer = new ResizeObserver(([entry]) => {
            clearTimeout(timer);
            const { width, height } = entry.contentRect;
            if (width <= 0 || height <= 0) return;
            const aspectRatio = Math.max(.2, Math.min(8, Math.round(width / height * 1000) / 1000));
            timer = setTimeout(() => { const current = geometryRef.current; if (current.layout.aspectRatio !== aspectRatio) current.update(updateMoaDashboard(normalizeMoa(controller.getState().ui.moa), current.layout.id, { aspectRatio })); }, 350);
        });
        observer.observe(layoutRef.current);
        return () => { clearTimeout(timer); observer.disconnect(); };
    }, [visible, mobile]);
    const saveLayout = next => { const current = normalizeMoa(controller.getState().ui.moa); update(updateMoaDashboard(current, layout.id, next)); };
    const replace = (id, next, focusedPanelId) => {
        const current = normalizeMoa(controller.getState().ui.moa).dashboards.find(d => d.id === layout.id);
        if (current) saveLayout({ tree: id ? replaceMoaNode(current.tree, id, next) : next, focusedPanelId: focusedPanelId ?? current.focusedPanelId });
    };
    const treeSignature = JSON.stringify(layout.tree);
    React.useEffect(() => { setResizeDraft(null); }, [mobile, visible, treeSignature]);
    const applyDrop = (sourceId, result, expectedSignature = treeSignature) => {
        const current = normalizeMoa(controller.getState().ui.moa).dashboards.find(d => d.id === layout.id);
        if (!current || JSON.stringify(current.tree) !== expectedSignature) return;
        setUndo({ tree: current.tree, focusedPanelId: current.focusedPanelId, after: JSON.stringify(result.tree), label: result.label });
        saveLayout({ tree: result.tree, focusedPanelId: sourceId });
    };
    const dragging = usePaneDrag({ enabled: visible && !mobile && nodes.length > 1 && !resizeDraft && !picker && !menu && !dashboardPicker && !dashboardEdit && !creating && !clearing && !state.ui.modal,
        tree: layout.tree, root: stageRef, onDrop: applyDrop });
    React.useEffect(() => {
        if (!undo) return;
        if (undo.after !== treeSignature) { setUndo(null); return; }
        const timer = setTimeout(() => setUndo(null), 12000);
        return () => clearTimeout(timer);
    }, [undo, treeSignature]);
    let displayTree = layout.tree;
    if (resizeDraft) {
        const visit = node => node?.id === resizeDraft.id ? { ...node, ratio: resizeDraft.ratio } : node?.type === "split" ? { ...node, first: visit(node.first), second: visit(node.second) } : node;
        displayTree = visit(displayTree);
    }
    const geometry = paneLayout(displayTree);
    const titleFor = node => `${node?.type === "canvas" ? `Canvas ${node.slot} · ` : ""}${node?.type === "empty" ? "Empty panel" : state.sessions.byId[node?.sessionId]?.title || "Session"}`;
    const split = (node, direction) => {
        if (nodes.length >= MOA_MAX_PANELS) { setError(`A MoA supports up to ${MOA_MAX_PANELS} panels.`); return; }
        const empty = emptyMoaPanel();
        replace(node.id, { id: crypto.randomUUID(), type: "split", direction, ratio: 50, first: node.id ? node : emptyMoaPanel(), second: empty }, empty.id); setMenu(null);
    };
    const zoom = (node, artifact = null) => {
        setError("");
        const source = moa.panels.current.get(`${layout.id}:${node.id}`)?.getState();
        const cached = source?.history.bySessionId.get(node.sessionId);
        const existing = controller.getState().history.bySessionId.get(node.sessionId);
        // Reuse the panel window when it covers the main window. Never throw
        // away older pages already loaded in the main conversation.
        if (cached && (!existing || ((cached.lastSeq || 0) > (existing.lastSeq || 0)
            && (cached.events?.[0]?.seq ?? Infinity) <= (existing.events?.[0]?.seq ?? Infinity)))) {
            controller.dispatch({ type: "history/set", sessionId: node.sessionId, history: cached });
        }
        if (source?.sessions.byId[node.sessionId]) controller.dispatch({ type: "sessions/merged", session: source.sessions.byId[node.sessionId] });
        controller.openWorkspace();
        controller.dispatch({ type: "files/pane", open: false });
        const loading = controller.loadSession(node.sessionId);
        controller.dispatch({ type: "sessions/navigationIntent", sessionId: node.sessionId });
        const generation = controller.navigationGeneration;
        restoreDraft(controller, moa.drafts.current.get(node.sessionId));
        if (source && node.type === "chat") {
            controller.dispatch({ type: "ui/followBottom", pane: "chat", followBottom: source.ui.followBottom?.chat !== false });
            controller.dispatch({ type: "ui/scroll", pane: "chat", offset: source.ui.scroll?.chat || 0 });
        }
        controller.dispatch({ type: "ui/canvasMaximized", on: node.type === "canvas" && !artifact });
        if (node.type === "canvas" && !artifact) {
            const cachedCanvas = source?.canvas.bySessionId[canvasKey(node.sessionId, node.slot)];
            if (cachedCanvas) controller.dispatch({ type: "canvas/snapshot", sessionId: node.sessionId, slot: node.slot, rev: cachedCanvas.latestRev, ...cachedCanvas });
            controller.dispatch({ type: "canvas/flip", sessionId: node.sessionId, slot: node.slot });
        }
        // The view is ready now. Network completion must not decide when to
        // leave MoA, restore a draft, select a canvas or steal focus back.
        moa.leave(); moa.setReturnTo(true);
        if (artifact) Promise.resolve(controller.openChatArtifact?.(artifact.sessionId, artifact.filename)).catch(() => {
            if (controller.navigationGeneration === generation && controller.getState().sessions.activeSessionId === node.sessionId)
                controller.setStatus("Could not load this artifact. Retry, or use Back to return to MoA.");
        });
        loading.catch(() => {
            if (controller.navigationGeneration === generation && controller.getState().sessions.activeSessionId === node.sessionId)
                controller.setStatus("Could not refresh this session. Retry, or use Back to return to MoA.");
        });
    };
    React.useEffect(() => {
        if (!visible) return;
        const key = e => { if (e.key === "Escape" && !document.querySelector(".ps-moa-dialog, .ps-modal-backdrop, .ps-share-overlay")) moa.setZen(false); };
        window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
    }, [visible, moa.setZen]);
    const cyclePanels = (backwards = false) => {
        const order = clockwisePanels(layout.tree, layout.aspectRatio || 16 / 9);
        if (!order.length) return;
        const index = order.findIndex(node => node.id === selected);
        const next = order[(index + (backwards ? -1 : 1) + order.length) % order.length];
        setFocus(next.id);
        if (!mobile) {
            const panel = layoutRef.current?.querySelector(`[data-moa-panel="${next.id}"]`);
            if (value.composerMode !== "shared") {
                panel?.focus({ preventScroll: true });
                // Focus changes reveal the pane composer on the next render.
                requestAnimationFrame(() => {
                    if (panel?.isConnected && panel.classList.contains("is-focused") && document.activeElement === panel) panel.querySelector(".ps-moa-pane-composer:not([hidden]) textarea")?.focus({ preventScroll: true });
                });
            } else (next.id === selected ? composerHost?.querySelector("textarea") || panel : panel)?.focus({ preventScroll: true });
        }

    };
    const onPanelKey = (key, backwards = false) => {
        if (dashboardPicker || dashboardEdit || mapOpen || picker || menu || clearing || creating || document.querySelector(".ps-modal-backdrop, .ps-share-overlay") || controller.getState().ui.modal) return;
        if (key === "Escape") moa.setZen(false);
        if (key === "Tab") cyclePanels(backwards);
    };
    React.useEffect(() => {
        if (!visible) return;
        const key = e => {
            if (!nodes.length || e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey || dashboardPicker || dashboardEdit || mapOpen || picker || menu || clearing || creating || document.querySelector(".ps-modal-backdrop, .ps-share-overlay") || controller.getState().ui.modal) return;
            if (!e.target.closest?.("[data-moa-panel], .ps-moa-composer-strip") && e.target !== document.body) return;
            e.preventDefault(); e.stopPropagation(); cyclePanels(e.shiftKey);
        };
        window.addEventListener("keydown", key, true);
        return () => window.removeEventListener("keydown", key, true);
    }, [visible, nodes.length, dashboardPicker, dashboardEdit, mapOpen, picker, menu, clearing, creating, selected, value.composerMode, composerHost]);
    // Sandboxed canvases consume pointer events; parent focus is detected when
    // the browser focuses their iframe, without reading the iframe contents.
    React.useEffect(() => {
        if (!visible) return;
        let timer; const blur = () => { timer = setTimeout(() => { const panel = document.activeElement?.closest?.("[data-moa-panel]"); if (panel) setFocus(panel.dataset.moaPanel); }, 0); };
        window.addEventListener("blur", blur); return () => { clearTimeout(timer); window.removeEventListener("blur", blur); };
    }, [visible]);
    const splitButtons = node => <>
        <IconButton className="ps-moa-split-action" label="Split right" icon="right" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(node, "row")} />
        <IconButton className="ps-moa-split-action" label="Split below" icon="below" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(node, "column")} />
    </>;
    function draw(node, style) {
        const session = state.sessions.byId[node.sessionId], title = node.type === "empty" ? "Empty panel" : session?.title || "Session";
        const active = selected === node.id;
        return <section key={node.id} style={mobile ? undefined : style} hidden={mobile && !active} className={`ps-moa-panel ${active ? "is-focused" : ""} ${dragging.drag?.sourceId === node.id ? "is-drag-source" : ""}`} tabIndex={-1} data-moa-panel={visible ? node.id : undefined} data-session-id={visible ? node.sessionId : undefined} aria-label={`${node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}${title}`} onPointerDown={e => dragging.onPointerDown(e, node.id)} onLostPointerCapture={dragging.onLostPointerCapture} onPointerDownCapture={e => { if (e.target.closest?.(".ps-moa-pane-composer")) setFocus(node.id); }} onClickCapture={e => { dragging.onClickCapture(e); if (!e.isPropagationStopped()) setFocus(node.id); }} onFocusCapture={e => { if (e.target.matches?.(":focus-visible") || e.target.closest?.(".ps-moa-pane-composer")) setFocus(node.id); }} onContextMenu={e => { e.preventDefault(); if (dragging.drag) return; setFocus(node.id); node.type === "empty" ? setPicker(node) : setMenu(node); }}>
            {node.type === "empty" ? <><header><span className="ps-moa-panel-title">{title}</span>{splitButtons(node)}<IconButton label="Session control panel" icon="controls" onClick={() => setMenu(node)} /></header><div className="ps-moa-empty"><button className="ps-moa-add" aria-label="Choose session or canvas" onClick={() => setPicker(node)}>+</button></div></> : <LivePanel key={`${node.id}:${node.sessionId}`} panels={moa.panels} panelKey={`${layout.id}:${node.id}`} node={node} mobile={mobile} visible={visible} mobileStatusHost={active ? mobileStatusHost : null} onPanelKey={onPanelKey} focused={visible && active && !dashboardPicker && !dashboardEdit && !picker && !menu && !clearing && !creating && !state.ui.modal} parent={controller} createTransport={createTransport} drafts={moa.drafts} draftKey={node.sessionId} refreshScheduler={moa.refreshScheduler} composerHost={composerHost} perChat={value.composerMode !== "shared"} onArtifact={(sessionId, filename) => zoom(node, { sessionId, filename })} controlsHost={menu?.id === node.id ? controlsHost : null} onControlAction={closeMenu} header={{ title: <><span className="ps-moa-panel-title">{node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}{title}</span></>, actions: <>{splitButtons(node)}<IconButton label="Focus panel" icon="focus" onClick={() => zoom(node)} /><IconButton label="Session control panel" icon="controls" onClick={() => setMenu(node)} /></> }} />}

        </section>;
    }
    const saveStatus = moa.saveStatus === "error" ? <span className="ps-moa-save" role="status"><IconButton label="Save failed · Retry" icon="retry" onClick={() => update(value)} /></span> : null;
    const clearButton = <IconButton label="Clear MoA layout" icon="clear" disabled={!layout.tree} onClick={() => setClearing(true)} />;
    const zenButton = <IconButton label="Enter zen" icon="zen" onClick={() => moa.setZen(true)} />;
    const toolbar = beforeHistoryHost && afterHistoryHost
        ? <>{createPortal(clearButton, beforeHistoryHost)}{createPortal(zenButton, afterHistoryHost)}</>
        : <nav className="ps-moa-toolbar" aria-label="Master of Agents">{clearButton}{zenButton}</nav>;
    const swipe = {
        onTouchStart: e => { swipeStart.current = e.touches.length === 1 && canSwipeFrom(e.target, e.currentTarget) ? { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() } : null; },
        onTouchEnd: e => {
            const start = swipeStart.current; swipeStart.current = null;
            if (!start || e.changedTouches.length !== 1 || !canSwipeFrom(e.target, e.currentTarget)) return;
            const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y;
            if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 2 && Date.now() - start.time < 800) {
                suppressDashboardClickUntil.current = Date.now() + 500;
                cyclePanels(dx > 0);
            }
        },
        onTouchCancel: () => { swipeStart.current = null; },
    };
    const selectedNode = nodes.find(node => node.id === selected);
    const orderedNodes = clockwisePanels(layout.tree, layout.aspectRatio || 16 / 9);
    const panelNumber = node => orderedNodes.findIndex(item => item.id === node.id) + 1;
    const dashboardNav = <DashboardTabs value={value} onSelect={id => update({ ...value, activeDashboardId: id })} onPicker={() => setDashboardPicker(true)} onAdd={addDashboard} onEdit={() => setDashboardEdit({ name: layout.name })} onReorder={(id, index) => update(moveMoaDashboard(value, id, index))} />;
    function addDashboard() {
        if (value.dashboards.length >= MOA_MAX_DASHBOARDS) return;
        const id = crypto.randomUUID();
        const names = new Set(value.dashboards.map(d => d.name)); let n = 1; while (names.has(`MoA ${n}`)) n++;
        update({ ...value, activeDashboardId: id, dashboards: [...value.dashboards, { id, name: `MoA ${n}`, tree: null }] });
    }
    return <div hidden={!visible} data-dashboard-view-id={layout.id} className="ps-moa-dashboard-view">
        {visible && !mobile && !moa.zen && statusHost && createPortal(dashboardNav, statusHost)}
        {mobile && visible && <header className="ps-mobile-focus-header" {...swipe}>
            <IconButton label="Back to normal view" icon="restore" onClick={moa.leave} />
            <div className="ps-mobile-session-heading">
                <span className="ps-moa-panel-title ps-mobile-session-name">{state.sessions.byId[selectedNode?.sessionId]?.title || selectedNode?.sessionId || (selectedNode?.type === "empty" ? "Empty panel" : "Master of Agents")}</span>
                <div ref={setMobileStatusHost} />
            </div>
            <IconButton label="Session control panel" icon="controls" onClick={() => setMenu(selectedNode || { id: null, type: "empty" })} />
            <IconButton label="Open panel map" icon="map" onClick={() => setMapOpen(true)} />
            <IconButton label="Switch MoA dashboard" icon="dropdown" aria-haspopup="dialog" aria-expanded={dashboardPicker} onClick={event => { if (Date.now() < suppressDashboardClickUntil.current) { suppressDashboardClickUntil.current = 0; event.preventDefault(); return; } setDashboardPicker(true); }} />
        </header>}
        {!moa.zen && saveStatus}
        {visible && !mobile && (moa.zen ? <div className="ps-moa-zen-controls">
            <CompactViewNavigation navigation={viewNavigation} />
            <IconButton className="ps-moa-zen-exit" label="Exit zen" icon="restore" onClick={() => moa.setZen(false)} />
        </div> : toolbar)}
        {error && <div role="alert" className="ps-moa-error">{error}<IconButton label="Dismiss" icon="close" onClick={() => setError("")} /></div>}
        <div {...(mobile ? swipe : {})} ref={layoutRef} id="moa-layout" role="region" aria-label="MoA panels" className="ps-moa-layout">{layout.tree ? <div ref={stageRef} className={`ps-moa-stage ${dragging.drag ? "is-dragging" : ""}`}>
            {geometry.panels.slice().sort((a, b) => a.node.id.localeCompare(b.node.id)).map(({ node, box }) => draw(node, boxStyle(box)))}
            {!mobile && geometry.dividers.map(item => <PaneDivider key={item.node.id} item={item} stage={stageRef} onPreview={setResizeDraft} onResize={ratio => replace(item.node.id, { ...item.node, ratio })} />)}
            {dragging.drag && <div className="ps-moa-drop-preview" aria-label="Pane drop preview" data-drop-kind={dragging.drag.result?.kind || "none"}>
                {dragging.drag.result && paneLayout(dragging.drag.result.tree).panels.filter(({ node, box }) => JSON.stringify(box) !== JSON.stringify(geometry.panels.find(p => p.node.id === node.id)?.box)).map(({ node, box }) => <div key={node.id} style={boxStyle(box)} className={`ps-moa-preview-pane ${node.id === dragging.drag.sourceId ? "is-source" : ""}`}><span>{titleFor(node)}</span></div>)}
                <div className="ps-moa-drag-label" style={{ left: Math.min(dragging.drag.x + 16, window.innerWidth - 240), top: Math.min(dragging.drag.y + 16, window.innerHeight - 50) }}>{titleFor(nodes.find(n => n.id === dragging.drag.sourceId))}</div>
                <div className="ps-moa-drag-hint" role="status"><strong>{dragging.drag.result?.label || "Drag onto another pane"}</strong><span>Centre: swap · Side: split 50/50 · Esc: cancel</span>{dragging.drag.result?.extensionLabel && <span>{dragging.drag.result.kind === "extend" ? "Release Shift to split the target in half" : `Hold Shift to ${dragging.drag.result.extensionLabel.toLowerCase()}`}</span>}</div>
            </div>}
            {visible && undo && <div className="ps-moa-layout-undo" role="status">{undo.label}<button className="ps-mini-button" onClick={() => { if (undo.after === JSON.stringify(normalizeMoa(controller.getState().ui.moa).dashboards.find(d => d.id === layout.id)?.tree)) saveLayout({ tree: undo.tree, focusedPanelId: undo.focusedPanelId }); setUndo(null); }}>Undo</button><IconButton label="Dismiss layout undo" icon="close" onClick={() => setUndo(null)} /></div>}
        </div> : <section className="ps-moa-panel ps-moa-initial-panel"><header><span className="ps-moa-panel-title">Empty panel</span>{splitButtons({ id: null, type: "empty" })}</header><div className="ps-moa-empty" onContextMenu={e => { e.preventDefault(); setPicker({ id: null }); }}><button className="ps-moa-add" aria-label="Add first MoA panel" onClick={() => setPicker({ id: null })}>+</button></div></section>}</div>
        {value.composerMode === "shared" && <footer tabIndex={-1} className="ps-moa-composer-strip" aria-label="Selected session composer" data-session-id={nodes.find(n => n.id === selected)?.sessionId || ""}>
            <span className="ps-moa-composer-target">{nodes.find(n => n.id === selected)?.sessionId ? state.sessions.byId[nodes.find(n => n.id === selected).sessionId]?.title || "Selected session" : "Select a session to write a message"}</span>
            <div ref={setComposerHost} className="ps-moa-composer-host" />
        </footer>}
        {visible && mapOpen && <Modal title="Panel map" onClose={() => setMapOpen(false)}>
            <div className="ps-moa-map-body">
                <div className="ps-moa-map" style={{ "--ps-moa-map-ratio": layout.aspectRatio || 16 / 9 }} aria-label="Desktop panel layout">
                    {panelRects(layout.tree).map(({ node, x, y, width, height }, index) => <button key={node.id} className={node.id === selected ? "is-selected" : ""} style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }} aria-label={`Panel ${panelNumber(node)}: ${state.sessions.byId[node.sessionId]?.title || "Empty panel"}`} aria-pressed={node.id === selected} onClick={() => { setFocus(node.id); setMapOpen(false); }}><b>{panelNumber(node)}</b><span>{node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}{state.sessions.byId[node.sessionId]?.title || "Empty panel"}</span></button>)}
                </div>
                <div className="ps-moa-map-list" aria-label="All panels">
                    {orderedNodes.map((node, index) => <button key={node.id} aria-current={node.id === selected ? "true" : undefined} onClick={() => { setFocus(node.id); setMapOpen(false); }}>{index + 1} · {node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}{state.sessions.byId[node.sessionId]?.title || "Empty panel"}</button>)}
                </div>
                <small>Swipe left for the next panel, right for the previous. Canvas: swipe the title bar.</small>
            </div>
        </Modal>}
        {visible && creating && <CreatePanelSession parent={controller} createTransport={createTransport} onClose={() => { setPicker(creating); setCreating(null); }} onCreated={created => { const target = creating; controller.dispatch({ type: "sessions/merged", session: created }); controller.refreshSessions().catch(() => {}); const next = { id: target.id || crypto.randomUUID(), type: "chat", sessionId: created.sessionId }; replace(target.id, next, next.id); setCreating(null); }} />}
        {visible && dashboardPicker && <Modal title="MoA dashboards" onClose={() => setDashboardPicker(false)}><div className="ps-moa-dashboard-picker">
            {value.dashboards.map(d => <div className="ps-moa-dashboard-item" key={d.id}><button className="ps-moa-dashboard-choice" aria-current={d.id === layout.id ? "true" : undefined} onClick={() => { setDashboardPicker(false); update({ ...value, activeDashboardId: d.id }); }}><DashboardPreview dashboard={d} /><span>{d.name}<small>{moaLeaves(d.tree).length} panels{d.id === layout.id ? " · Active" : ""}</small></span></button><IconButton label={`Edit dashboard ${d.name}`} icon="controls" onClick={() => { setDashboardPicker(false); setDashboardEdit({ id: d.id, name: d.name }); }} /></div>)}
            <IconButton label="Add MoA dashboard" icon="add" disabled={value.dashboards.length >= MOA_MAX_DASHBOARDS} onClick={addDashboard} />
        </div></Modal>}
        {visible && dashboardEdit && <Modal title="Dashboard options" onClose={() => setDashboardEdit(null)}><div className="ps-moa-menu">
            <label>Message boxes<select aria-label="Message boxes" value={value.composerMode} onChange={e => update({ ...value, composerMode: e.target.value })}>
                <option value="per-chat">Per chat</option><option value="shared">Shared below all panes</option>
            </select></label>
            <label>Dashboard name<input aria-label="Dashboard name" maxLength={64} value={dashboardEdit.name} onChange={e => setDashboardEdit({ ...dashboardEdit, name: e.target.value })} /></label>
            {dashboardEdit.deleting ? <p role="alert">Delete this dashboard and its layout? Sessions and canvases remain available.</p> : null}
            <div className="ps-moa-row"><IconButton label="Save dashboard name" icon="check" disabled={!dashboardEdit.name.trim()} onClick={() => { update(updateMoaDashboard(value, dashboardEdit.id || layout.id, { name: dashboardEdit.name })); setDashboardEdit(null); }} />
            <IconButton label={dashboardEdit.deleting ? "Confirm delete dashboard" : "Delete dashboard"} icon="remove" disabled={value.dashboards.length === 1} onClick={() => { if (!dashboardEdit.deleting) { setDashboardEdit({ ...dashboardEdit, deleting: true }); return; } const id = dashboardEdit.id || layout.id; const dashboards = value.dashboards.filter(d => d.id !== id); update({ ...value, dashboards, activeDashboardId: value.activeDashboardId === id ? dashboards[0].id : value.activeDashboardId }); setDashboardEdit(null); }} /></div>
        </div></Modal>}
        {visible && clearing && <Modal title="Clear MoA layout" onClose={() => setClearing(false)}><div className="ps-moa-menu">
            <p>Clear “{layout.name}”? This removes the panels from this dashboard. Your sessions and canvases stay intact.</p>
            <div className="ps-moa-row"><IconButton label="Cancel clear" icon="close" onClick={() => setClearing(false)} /><IconButton label="Confirm clear layout" icon="clear" onClick={() => { saveLayout({ tree: null, focusedPanelId: null }); setClearing(false); setError(""); }} /></div>
        </div></Modal>}
        {visible && picker && <SessionPicker controller={controller} initial={picker} onCreate={() => { setCreating(picker); setPicker(null); }} onClose={closePicker} onChoose={binding => { const next = { id: picker.id || crypto.randomUUID(), ...binding }; replace(picker.id, next, next.id); setPicker(null); }} />}
        {visible && menu && <Modal title="Session control panel" onClose={closeMenu}><div className="ps-moa-control-panel">
            <p className="ps-moa-control-title">{state.sessions.byId[menu.sessionId]?.title || "Empty panel"}</p>
            {menu.type !== "empty" && <section aria-label="Session actions"><h3>Session</h3><div className="ps-moa-control-actions">
                <div ref={setControlsHost} className="ps-moa-control-actions" />
            </div></section>}
            <section aria-label="Panel layout"><h3>Panel layout</h3><div className="ps-moa-control-actions">
                <IconButton label={`${menu.type === "empty" ? "Choose" : "Replace"} session or canvas…`} icon="replace" onClick={() => { setPicker(menu); setMenu(null); }} />
                <IconButton label="Split right" icon="right" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(menu, "row")} />
                <IconButton label="Split below" icon="below" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(menu, "column")} />
                <IconButton label="Close panel" icon="closePanel" title={menu.sessionId ? "Close this panel. The session stays available." : "Close this panel."} onClick={() => { replace(menu.id, null); setMenu(null); }} />
            </div></section>
            {menu.type !== "empty" && <section aria-label="Session details"><h3>Session details</h3>
                <SessionDetailBox session={state.sessions.byId[menu.sessionId]} childCount={menuRow?.childCount || 0} pause={menuRow?.pause || null} controller={controller} onOpenBudget={options => { closeMenu(); moa.leave(); return controller.openBudget(options); }} />
            </section>}
        </div></Modal>}
    </div>;
}

// A deliberately small phone surface. Restoring returns to the normal workspace.
export function MobileZen({ controller, onClose, drafts, createTransport }) {
    const state = useControllerSelector(controller, s => s);
    const [loading, setLoading] = React.useState(false), [error, setError] = React.useState("");
    const [picker, setPicker] = React.useState(false), [creating, setCreating] = React.useState(false);
    const active = state.sessions.activeSessionId;
    const changeSession = async (id, binding) => {
        if (!id || loading) return;
        drafts.current.set(active, { prompt: state.ui.prompt, attachments: state.ui.promptAttachments || [] });
        setLoading(true); setError("");
        // Clear the outgoing draft before starting asynchronous navigation.
        controller.setPrompt("");
        controller.dispatch({ type: "ui/promptAttachments", attachments: [] });
        try {
            const session = await controller.transport.getSession(id);
            if (!session || session.sessionId !== id) throw new Error("Session unavailable");
            await controller.loadSession(id);
            const actual = controller.getState().sessions.activeSessionId;
            const draft = drafts.current.get(actual);
            controller.setPrompt(draft?.prompt || "");
            controller.dispatch({ type: "ui/promptAttachments", attachments: draft?.attachments || [] });
            if (actual !== id) throw new Error("Could not open that session.");
            if (binding?.type === "canvas") {
                await controller.ensureCanvasSnapshot(id);
                controller.dispatch({ type: "canvas/flip", sessionId: id, slot: binding.slot });
                controller.dispatch({ type: "ui/canvasMaximized", on: true });
                onClose();
            }
        } catch {
            // A history failure can happen after loadSession selected the target.
            // Restore the source before restoring its draft; never send it to the failed target.
            if (controller.getState().sessions.activeSessionId !== active) await controller.loadSession(active).catch(() => {});
            const draft = drafts.current.get(active);
            controller.setPrompt(draft?.prompt || "");
            controller.dispatch({ type: "ui/promptAttachments", attachments: draft?.attachments || [] });
            setError("Could not open that session.");
        } finally { setLoading(false); }
    };
    return <ControllerContext.Provider value={controller}><div className="ps-mobile-zen">
        <header className="ps-mobile-focus-header">
            <IconButton label="Exit mobile zen" icon="restore" disabled={loading} onClick={() => { drafts.current.set(active, { prompt: state.ui.prompt, attachments: state.ui.promptAttachments || [] }); onClose(); }} />
            <div className="ps-mobile-session-heading has-selector">
            <span className="ps-mobile-session-name">{state.sessions.byId[active]?.title || active || "Select session"}<span className="ps-mobile-select-chevron" aria-hidden="true">⌄</span></span>
            <SessionHeaderStatus controller={controller} />
            <button className="ps-mobile-session-trigger" aria-label="Select session" aria-haspopup="dialog" disabled={loading} onClick={() => setPicker(true)} />
            </div>
        </header>
        {error && <div role="alert">{error}</div>}
        <div className="ps-mobile-zen-chat"><ChatPane controller={controller} mobile fullWidth showComposer={false} activityInHeader /></div>
        <footer className="ps-mobile-zen-composer">{loading ? <span role="status">Opening session…</span> : <SessionComposer controller={controller} mobile compact />}</footer>
        {picker && <SessionPicker controller={controller} initial={{ type: "chat", sessionId: active }} onClose={() => setPicker(false)} onCreate={() => { setPicker(false); setCreating(true); }} onChoose={binding => { setPicker(false); changeSession(binding.sessionId, binding); }} />}
        {creating && <CreatePanelSession parent={controller} createTransport={createTransport} onClose={() => { setCreating(false); setPicker(true); }} onCreated={created => { controller.dispatch({ type: "sessions/merged", session: created }); controller.refreshSessions().catch(() => {}); setCreating(false); changeSession(created.sessionId); }} />}
        <ModalLayer controller={controller} />
    </div></ControllerContext.Provider>;
}
