import React from "react";
import { createPortal } from "react-dom";
import { ChatPane, CanvasFrame, SessionPane, SessionComposer, SessionDetailBox, ScopedModalLayer as ModalLayer, ControllerContext, createWebPilotSwarmController, useControllerSelector } from "pilotswarm/ui-react";
import { canvasKey, normalizeMoa, emptyMoaPanel, moaLeaves, replaceMoaNode, MOA_MAX_PANELS, MOA_BREAKPOINT, selectSessionRows } from "pilotswarm/ui-core";
import "./moa.css";
import { panelRects, clockwisePanels, canSwipeFrom } from "./geometry.js";

// One icon treatment for MoA actions; names remain available to keyboard and
// screen-reader users and as hover tooltips.
const ICON_PATHS = {
    map: "M3 3h18v18H3z M12 3v18 M12 12h9",
    controls: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
    info: "M12 16v-4 M12 8h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    check: "m4 12 5 5L20 6",
    zen: "M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5",
    restore: "M3 8h5V3 M16 3v5h5 M21 16h-5v5 M8 21v-5H3",
    clear: "m15 3 6 6-10 10H5l-3-3z M8 10l6 6 M11 21h10",
    close: "m6 6 12 12 M6 18 18 6",
    retry: "M20 7v5h-5 M20 12a8 8 0 1 0-2 6",
    replace: "M4 7h16l-4-4 M20 17H4l4 4",
    right: "M3 3h18v18H3z M12 3v18",
    below: "M3 3h18v18H3z M3 12h18",
    open: "M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7",
    remove: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
};
function IconButton({ label, icon, className = "", ...props }) {
    return <button className={`ps-mini-button ps-moa-icon-button ${className}`} aria-label={label} title={label} {...props}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={ICON_PATHS[icon]} /></svg>
    </button>;
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
    const saveStatus = useControllerSelector(controller, s => s.ui.moaSaveStatus);
    const value = React.useMemo(() => normalizeMoa(stored), [stored]);
    const [active, setActive] = React.useState(false), [zen, setZen] = React.useState(false), [returnTo, setReturnTo] = React.useState(false);
    React.useEffect(() => { try { sessionStorage.removeItem("pilotswarm.moa.shared"); } catch {} }, []);
    const drafts = React.useRef(new Map());
    const zenDrafts = React.useRef(new Map());
    const update = React.useCallback(next => controller.dispatch({ type: "ui/moa", value: next }), [controller]);
    const [mobileZen, setMobileZen] = React.useState(false);
    React.useEffect(() => { if (desktop) setMobileZen(false); }, [desktop]);
    const open = () => { if (loaded) { setMobileZen(false); setActive(true); setReturnTo(false); } };
    const leave = () => { setActive(false); setZen(false); };
    const openMobileZen = () => { if (!desktop) { leave(); setMobileZen(true); } };
    return { desktop, loaded, value, update, saveStatus, active, zen: active && zen, setZen, open, leave, returnTo, setReturnTo, drafts, zenDrafts, mobileZen: !desktop && mobileZen, openMobileZen, closeMobileZen: () => setMobileZen(false) };
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

function LivePanel({ node, mobile = false, focused, parent, createTransport, drafts, draftKey, onPanelKey, composerHost, header, controlsHost, onControlAction }) {
    const [ready, setReady] = React.useState(null), [error, setError] = React.useState(""), [retry, setRetry] = React.useState(0);
    const themeId = useControllerSelector(parent, s => s.ui.themeId);
    const [actionsOpen, setActionsOpen] = React.useState(false);
    const focusedRef = React.useRef(focused); focusedRef.current = focused && !actionsOpen;
    React.useEffect(() => {
        let cancelled = false, timer, child, transport, offDraft;
        setReady(null); setError("");
        const stop = async () => { clearInterval(timer); offDraft?.(); await child?.stop().catch(() => {}); await transport?.stop().catch(() => {}); };
        (async () => {
            transport = createTransport();
            child = createWebPilotSwarmController({ transport, branding: parent.getState().branding });
            await transport.start(); if (cancelled) return stop();
            const session = await transport.getSession(node.sessionId); if (cancelled) return stop();
            if (!session || session.sessionId !== node.sessionId) throw new Error("Session unavailable.");
            const auth = transport.getAuthContext();
            child.dispatch({ type: "auth/context", principal: auth?.principal, authorization: auth?.authorization });
            child.dispatch({ type: "connection/ready", statusText: "Connected" });
            child.dispatch({ type: "sessions/merged", session });
            child.dispatch({ type: "sessions/navigationIntent", sessionId: node.sessionId });
            await child.loadSession(node.sessionId); if (cancelled) return stop();
            child.dispatch({ type: "profileSettings/apply", settings: { themeId: parent.getState().ui.themeId } });
            child.setFocus("prompt");
            const draft = drafts.current.get(draftKey);
            if (draft) { child.dispatch({ type: "ui/prompt", prompt: draft.prompt }); child.dispatch({ type: "ui/promptAttachments", attachments: draft.attachments }); }
            offDraft = child.subscribe(s => drafts.current.set(draftKey, { prompt: s.ui.prompt, attachments: s.ui.promptAttachments || [] }));
            // Defense in depth: no hidden composer, stale selection or attachment
            // from another session may redirect a send to a different agent.
            const send = child.sendPrompt.bind(child);
            child.sendPrompt = async () => {
                const state = child.getState();
                if (cancelled || !focusedRef.current || state.ui.modal || state.sessions.activeSessionId !== node.sessionId || child.getPromptAttachments().some(a => a.sessionId && a.sessionId !== node.sessionId)) return;
                return send();
            };
            let polling = false;
            timer = setInterval(async () => {
                if (polling || cancelled) return; polling = true;
                try {
                    const current = await transport.getSession(node.sessionId);
                    if (cancelled) return;
                    if (!current || current.sessionId !== node.sessionId) throw new Error("Session unavailable.");
                    child.dispatch({ type: "sessions/merged", session: current });
                    await child.syncSessionEvents(node.sessionId);
                } catch (e) {
                    if (!cancelled) { setReady(null); setError(e.status === 403 || e.status === 404 ? "Session unavailable or access changed." : "Connection interrupted. Retry to reconnect."); await stop(); }
                } finally { polling = false; }
            }, 4000);
            setReady(child);
        })().catch(async e => { if (!cancelled) setError(e.status === 403 || e.status === 404 ? "Session unavailable or access required." : "Could not open this session. Retry to reconnect."); await stop(); });
        return () => { cancelled = true; stop(); };
    }, [node.sessionId, createTransport, parent, retry, drafts, draftKey]);
    React.useEffect(() => { ready?.dispatch({ type: "profileSettings/apply", settings: { themeId } }); }, [ready, themeId]);
    React.useLayoutEffect(() => { if (ready && focused) ready.setFocus("prompt"); }, [ready, focused]);
    const ref = React.useRef(null);
    const focusReadOnlyPanel = React.useCallback(() => ref.current?.closest("[data-moa-panel]")?.focus({ preventScroll: true }), []);
    React.useEffect(() => {
        if (!ready || !ref.current) return;
        const observer = new ResizeObserver(([entry]) => ready.dispatch({ type: "ui/viewport", width: Math.max(20, Math.floor(entry.contentRect.width / 8)), height: Math.max(10, Math.floor(entry.contentRect.height / 16)) }));
        observer.observe(ref.current); return () => observer.disconnect();
    }, [ready]);
    return <>
        <header>{header.title}{header.actions}</header>
        {ready && <SessionPane controller={ready} actionsOnly actionsHost={controlsHost} onAction={onControlAction} onDialogChange={setActionsOpen} />}
        <div ref={ref} className="ps-moa-live">
            {error ? <div className="ps-moa-empty" role="status"><p>{error}</p><IconButton label="Retry" icon="retry" onClick={() => setRetry(n => n + 1)} /></div> : ready ? <ControllerContext.Provider value={ready}>{node.type === "chat" ? <ChatPane controller={ready} mobile={mobile} fullWidth showComposer={false} /> : <PinnedCanvas controller={ready} node={node} onPanelKey={onPanelKey} />}</ControllerContext.Provider> : <div className="ps-moa-empty" role="status">Connecting…</div>}
        </div>
        {ready && <ModalLayer controller={ready} />}
        {ready && focused && !actionsOpen && composerHost && createPortal(<ControllerContext.Provider value={ready}><SessionComposer controller={ready} mobile={mobile} compact={mobile} onReadOnlyFocus={focusReadOnlyPanel} /></ControllerContext.Provider>, composerHost)}
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

function Split({ node, onResize, children }) {
    const ref = React.useRef(null), ratioRef = React.useRef(node.ratio);
    const [ratio, setRatio] = React.useState(node.ratio);
    React.useEffect(() => { ratioRef.current = node.ratio; setRatio(node.ratio); }, [node.ratio]);
    return <div ref={ref} className={`ps-moa-split ${node.direction}`}>
        <div className="ps-moa-child" style={{ flex: `${ratio} 1 0` }}>{children[0]}</div>
        <div className="ps-moa-divider" role="separator" tabIndex={0} aria-label="Resize MoA panels" aria-orientation={node.direction === "row" ? "vertical" : "horizontal"} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(ratio)}
            onKeyDown={e => { if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); const next = e.key === "Home" ? 10 : e.key === "End" ? 90 : Math.max(10, Math.min(90, ratio + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -2 : 2))); setRatio(next); ratioRef.current = next; onResize(next); }}
            onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const box = ref.current.getBoundingClientRect(); const next = Math.max(10, Math.min(90, 100 * (node.direction === "row" ? (e.clientX - box.left) / box.width : (e.clientY - box.top) / box.height))); ratioRef.current = next; setRatio(next); }}
            onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) { e.currentTarget.releasePointerCapture(e.pointerId); onResize(ratioRef.current); } }}
            onPointerCancel={() => { setRatio(node.ratio); ratioRef.current = node.ratio; }} />
        <div className="ps-moa-child" style={{ flex: `${100 - ratio} 1 0` }}>{children[1]}</div>
    </div>;
}

export function MoaWorkspace({ controller, moa, createTransport }) {
    const { value, update } = moa, layout = value, mobile = !moa.desktop;
    const [mapOpen, setMapOpen] = React.useState(false);
    const swipeStart = React.useRef(null);
    const state = useControllerSelector(controller, s => s);
    const [focus, setFocus] = React.useState(null), [picker, setPicker] = React.useState(null), [menu, setMenu] = React.useState(null), [error, setError] = React.useState("");
    const closePicker = React.useCallback(() => setPicker(null), []), closeMenu = React.useCallback(() => setMenu(null), []);
    const [clearing, setClearing] = React.useState(false);
    const layoutRef = React.useRef(null);
    const [headerHost, setHeaderHost] = React.useState(null), [statusHost, setStatusHost] = React.useState(null);
    React.useLayoutEffect(() => { setHeaderHost(document.getElementById("ps-moa-header-slot")); setStatusHost(document.getElementById("ps-moa-status-slot")); });
    const [controlsHost, setControlsHost] = React.useState(null);
    const [composerHost, setComposerHost] = React.useState(null), [info, setInfo] = React.useState(null), [creating, setCreating] = React.useState(null);
    const nodes = moaLeaves(layout.tree), selected = nodes.some(n => n.id === focus) ? focus : nodes[0]?.id;
    const geometryRef = React.useRef({ value, update }); geometryRef.current = { value, update };
    React.useEffect(() => {
        if (mobile || !layoutRef.current) return;
        let timer;
        const observer = new ResizeObserver(([entry]) => {
            clearTimeout(timer);
            const { width, height } = entry.contentRect;
            if (width <= 0 || height <= 0) return;
            const aspectRatio = Math.max(.2, Math.min(8, Math.round(width / height * 1000) / 1000));
            timer = setTimeout(() => { const current = geometryRef.current; if (current.value.aspectRatio !== aspectRatio) current.update({ ...current.value, aspectRatio }); }, 350);
        });
        observer.observe(layoutRef.current);
        return () => { clearTimeout(timer); observer.disconnect(); };
    }, [mobile]);
    const saveLayout = next => update(next);
    const replace = (id, next) => saveLayout({ ...layout, tree: id ? replaceMoaNode(layout.tree, id, next) : next });
    const split = (node, direction) => {
        if (nodes.length >= MOA_MAX_PANELS) { setError(`A MoA supports up to ${MOA_MAX_PANELS} panels.`); return; }
        const empty = emptyMoaPanel();
        replace(node.id, { id: crypto.randomUUID(), type: "split", direction, ratio: 50, first: node.id ? node : emptyMoaPanel(), second: empty }); setFocus(empty.id); setMenu(null);
    };
    const zoom = async node => {
        setError("");
        try {
            const session = await controller.transport.getSession(node.sessionId);
            if (!session || session.sessionId !== node.sessionId) throw new Error("Session unavailable.");
            controller.dispatch({ type: "sessions/merged", session });
            controller.dispatch({ type: "sessions/navigationIntent", sessionId: node.sessionId });
            await controller.loadSession(node.sessionId);
            if (node.type === "canvas") {
                await controller.ensureCanvasSnapshot(node.sessionId);
                controller.dispatch({ type: "canvas/flip", sessionId: node.sessionId, slot: node.slot });
                controller.dispatch({ type: "ui/canvasMaximized", on: true });
            }
            moa.leave(); moa.setReturnTo(true);
        } catch { setError("Could not open this session. It may be unavailable."); }
    };
    React.useEffect(() => {
        const key = e => { if (e.key === "Escape" && !document.querySelector(".ps-moa-dialog, .ps-modal-backdrop, .ps-share-overlay")) moa.setZen(false); };
        window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
    }, [moa.setZen]);
    const cyclePanels = (backwards = false) => {
        const order = clockwisePanels(layout.tree, layout.aspectRatio || 16 / 9);
        if (!order.length) return;
        const index = order.findIndex(node => node.id === selected);
        const next = order[(index + (backwards ? -1 : 1) + order.length) % order.length];
        setFocus(next.id);
        if (!mobile) {
            const panel = layoutRef.current?.querySelector(`[data-moa-panel="${next.id}"]`);
            (next.id === selected ? composerHost?.querySelector("textarea") || panel : panel)?.focus({ preventScroll: true });
        }

    };
    const onPanelKey = (key, backwards = false) => {
        if (mapOpen || picker || menu || clearing || info || creating || document.querySelector(".ps-modal-backdrop, .ps-share-overlay") || controller.getState().ui.modal) return;
        if (key === "Escape") moa.setZen(false);
        if (key === "Tab") cyclePanels(backwards);
    };
    React.useEffect(() => {
        const key = e => {
            if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey || mapOpen || picker || menu || clearing || info || creating || document.querySelector(".ps-modal-backdrop, .ps-share-overlay") || controller.getState().ui.modal) return;
            if (!e.target.closest?.("[data-moa-panel], .ps-moa-composer-strip") && e.target !== document.body) return;
            e.preventDefault(); e.stopPropagation(); cyclePanels(e.shiftKey);
        };
        window.addEventListener("keydown", key, true);
        return () => window.removeEventListener("keydown", key, true);
    });
    // Sandboxed canvases consume pointer events; parent focus is detected when
    // the browser focuses their iframe, without reading the iframe contents.
    React.useEffect(() => {
        let timer; const blur = () => { timer = setTimeout(() => { const panel = document.activeElement?.closest?.("[data-moa-panel]"); if (panel) setFocus(panel.dataset.moaPanel); }, 0); };
        window.addEventListener("blur", blur); return () => { clearTimeout(timer); window.removeEventListener("blur", blur); };
    }, []);
    const splitButtons = node => <>
        <IconButton label="Split right" icon="right" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(node, "row")} />
        <IconButton label="Split below" icon="below" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(node, "column")} />
    </>;
    function draw(node) {
        if (node.type === "split") return <Split key={node.id} node={node} onResize={ratio => replace(node.id, { ...node, ratio })}>{[draw(node.first), draw(node.second)]}</Split>;
        const session = state.sessions.byId[node.sessionId], title = node.type === "empty" ? "Empty panel" : session?.title || "Session";
        const active = selected === node.id;
        return <section key={node.id} hidden={mobile && !active} className={`ps-moa-panel ${active ? "is-focused" : ""}`} tabIndex={-1} data-moa-panel={node.id} data-session-id={node.sessionId} aria-label={`${node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}${title}`} onClickCapture={() => setFocus(node.id)} onFocusCapture={e => { if (e.target.matches?.(":focus-visible")) setFocus(node.id); }} onContextMenu={e => { e.preventDefault(); setFocus(node.id); node.type === "empty" ? setPicker(node) : setMenu(node); }}>
            {node.type === "empty" ? <><header><span className="ps-moa-panel-title">{title}</span>{active && <span className="ps-moa-focus-label">Focused</span>}{splitButtons(node)}<IconButton label="Session control panel" icon="controls" onClick={() => setMenu(node)} /></header><div className="ps-moa-empty"><button className="ps-moa-add" aria-label="Choose session or canvas" onClick={() => setPicker(node)}>+</button></div></> : <LivePanel key={`${node.id}:${node.sessionId}`} node={node} mobile={mobile} onPanelKey={onPanelKey} focused={active && !picker && !menu && !clearing && !info && !creating && !state.ui.modal} parent={controller} createTransport={createTransport} drafts={moa.drafts} draftKey={`${node.id}:${node.sessionId}`} composerHost={composerHost} controlsHost={menu?.id === node.id ? controlsHost : null} onControlAction={closeMenu} header={{ title: <><span className="ps-moa-panel-title">{node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}{title}</span>{active && <span className="ps-moa-focus-label">Focused</span>}</>, actions: <>{splitButtons(node)}<IconButton label="Open panel in main view" icon="zen" onClick={() => zoom(node)} /><IconButton label="Session control panel" icon="controls" onClick={() => setMenu(node)} /></> }} />}

        </section>;
    }
    const saveStatus = moa.saveStatus === "error" ? <span className="ps-moa-save" role="status"><IconButton label="Save failed · Retry" icon="retry" onClick={() => update(value)} /></span> : null;
    const toolbar = <nav className="ps-moa-toolbar" aria-label="Master of Agents">
            <IconButton label="Clear MoA layout" icon="clear" disabled={!layout.tree} onClick={() => setClearing(true)} />
            <IconButton label="Enter zen" icon="zen" onClick={() => moa.setZen(true)} />
        </nav>;
    const swipe = {
        onTouchStart: e => { swipeStart.current = e.touches.length === 1 && canSwipeFrom(e.target, e.currentTarget) ? { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() } : null; },
        onTouchEnd: e => {
            const start = swipeStart.current; swipeStart.current = null;
            if (!start || e.changedTouches.length !== 1 || !canSwipeFrom(e.target, e.currentTarget)) return;
            const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y;
            if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 2 && Date.now() - start.time < 800) cyclePanels(dx > 0);
        },
        onTouchCancel: () => { swipeStart.current = null; },
    };
    const selectedNode = nodes.find(node => node.id === selected);
    const orderedNodes = clockwisePanels(layout.tree, layout.aspectRatio || 16 / 9);
    const panelNumber = node => orderedNodes.findIndex(item => item.id === node.id) + 1;
    return <div className={`ps-moa-workspace ${mobile ? "is-mobile" : ""} ${moa.zen ? "is-zen" : ""}`}>
        {mobile && <header className="ps-mobile-focus-header" {...swipe}>
            <IconButton label="Back to normal view" icon="restore" onClick={moa.leave} />
            <span className="ps-moa-panel-title">{state.sessions.byId[selectedNode?.sessionId]?.title || "Master of Agents"}</span>
            <IconButton label="Session control panel" icon="controls" onClick={() => setMenu(selectedNode || { id: null, type: "empty" })} />
            <IconButton label="Open panel map" icon="map" onClick={() => setMapOpen(true)} />
        </header>}
        {!moa.zen && statusHost && createPortal(saveStatus, statusHost)}
        {!mobile && (moa.zen ? <IconButton className="ps-moa-zen-exit" label="Exit zen" icon="restore" onClick={() => moa.setZen(false)} /> : (headerHost ? createPortal(toolbar, headerHost) : toolbar))}
        {error && <div role="alert" className="ps-moa-error">{error}<IconButton label="Dismiss" icon="close" onClick={() => setError("")} /></div>}
        <div {...(mobile ? swipe : {})} ref={layoutRef} id="moa-layout" role="region" aria-label="MoA panels" className="ps-moa-layout">{layout.tree ? (mobile ? nodes.map(draw) : draw(layout.tree)) : <section className="ps-moa-panel ps-moa-initial-panel"><header><span className="ps-moa-panel-title">Empty panel</span>{splitButtons({ id: null, type: "empty" })}</header><div className="ps-moa-empty" onContextMenu={e => { e.preventDefault(); setPicker({ id: null }); }}><button className="ps-moa-add" aria-label="Add first MoA panel" onClick={() => setPicker({ id: null })}>+</button></div></section>}</div>
        <footer tabIndex={-1} className="ps-moa-composer-strip" aria-label="Selected session composer" data-session-id={nodes.find(n => n.id === selected)?.sessionId || ""}>
            <span className="ps-moa-composer-target">{nodes.find(n => n.id === selected)?.sessionId ? state.sessions.byId[nodes.find(n => n.id === selected).sessionId]?.title || "Selected session" : "Select a session to write a message"}</span>
            <div ref={setComposerHost} className="ps-moa-composer-host" />
        </footer>
        {mapOpen && <Modal title="Panel map" onClose={() => setMapOpen(false)}>
            <div className="ps-moa-map-body">
                <div className="ps-moa-map" style={{ aspectRatio: layout.aspectRatio || 16 / 9 }} aria-label="Desktop panel layout">
                    {panelRects(layout.tree).map(({ node, x, y, width, height }, index) => <button key={node.id} className={node.id === selected ? "is-selected" : ""} style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }} aria-label={`Panel ${panelNumber(node)}: ${state.sessions.byId[node.sessionId]?.title || "Empty panel"}`} aria-pressed={node.id === selected} onClick={() => { setFocus(node.id); setMapOpen(false); }}><b>{panelNumber(node)}</b><span>{node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}{state.sessions.byId[node.sessionId]?.title || "Empty panel"}</span></button>)}
                </div>
                <div className="ps-moa-map-list" aria-label="All panels">
                    {orderedNodes.map((node, index) => <button key={node.id} aria-current={node.id === selected ? "true" : undefined} onClick={() => { setFocus(node.id); setMapOpen(false); }}>{index + 1} · {node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}{state.sessions.byId[node.sessionId]?.title || "Empty panel"}</button>)}
                </div>
                <small>Swipe left for the next panel, right for the previous. Canvas: swipe the title bar.</small>
            </div>
        </Modal>}
        {info && <Modal title="Session information" onClose={() => setInfo(null)}><SessionDetailBox session={state.sessions.byId[info]} childCount={selectSessionRows(state).find(row => row.sessionId === info)?.childCount || 0} pause={selectSessionRows(state).find(row => row.sessionId === info)?.pause || null} controller={controller} /></Modal>}
        {creating && <CreatePanelSession parent={controller} createTransport={createTransport} onClose={() => { setPicker(creating); setCreating(null); }} onCreated={created => { const target = creating; controller.dispatch({ type: "sessions/merged", session: created }); controller.refreshSessions().catch(() => {}); const next = { id: target.id || crypto.randomUUID(), type: "chat", sessionId: created.sessionId }; replace(target.id, next); setFocus(next.id); setCreating(null); }} />}
        {clearing && <Modal title="Clear MoA layout" onClose={() => setClearing(false)}><div className="ps-moa-menu">
            <p>Clear your MoA workspace? This removes the panels from this view. Your sessions and canvases stay intact.</p>
            <div className="ps-moa-row"><IconButton label="Cancel clear" icon="close" onClick={() => setClearing(false)} /><IconButton label="Confirm clear layout" icon="clear" onClick={() => { saveLayout({ ...layout, tree: null }); setFocus(null); setClearing(false); setError(""); }} /></div>
        </div></Modal>}
        {picker && <SessionPicker controller={controller} initial={picker} onCreate={() => { setCreating(picker); setPicker(null); }} onClose={closePicker} onChoose={binding => { const next = { id: picker.id || crypto.randomUUID(), ...binding }; replace(picker.id, next); setFocus(next.id); setPicker(null); }} />}
        {menu && <Modal title="Session control panel" onClose={closeMenu}><div className="ps-moa-control-panel">
            <p className="ps-moa-control-title">{state.sessions.byId[menu.sessionId]?.title || "Empty panel"}</p>
            {menu.type !== "empty" && <section aria-label="Session actions"><h3>Session</h3><div className="ps-moa-control-actions">
                <div ref={setControlsHost} className="ps-moa-control-actions" />
                <IconButton label="Session information" icon="info" onClick={() => { setInfo(menu.sessionId); setMenu(null); }} />
            </div></section>}
            <section aria-label="Panel layout"><h3>Panel layout</h3><div className="ps-moa-control-actions">
                <IconButton label={`${menu.type === "empty" ? "Choose" : "Replace"} session or canvas…`} icon="replace" onClick={() => { setPicker(menu); setMenu(null); }} />
                <IconButton label="Split right" icon="right" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(menu, "row")} />
                <IconButton label="Split below" icon="below" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(menu, "column")} />
                <IconButton label="Remove panel" icon="remove" onClick={() => { replace(menu.id, null); setMenu(null); }} />
            </div></section>
        </div></Modal>}
    </div>;
}

// A deliberately small phone surface. Restoring returns to the normal workspace.
export function MobileZen({ controller, onClose, drafts }) {
    const state = useControllerSelector(controller, s => s);
    const [loading, setLoading] = React.useState(false), [error, setError] = React.useState("");
    const rows = selectSessionRows(state).filter(row => !row.isGroup);
    const active = state.sessions.activeSessionId;
    const changeSession = async id => {
        if (!id || id === active || loading) return;
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
            if (actual !== id) setError("Could not open that session.");
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
            <select aria-label="Select session" value={active || ""} disabled={loading} onChange={e => changeSession(e.target.value)}>
                {!active && <option value="">Select session</option>}
                {active && !rows.some(row => row.sessionId === active) && <option value={active}>{state.sessions.byId[active]?.title || "Current session"}</option>}
                {rows.map(row => <option key={row.sessionId} value={row.sessionId}>{state.sessions.byId[row.sessionId]?.title || row.sessionId}</option>)}
            </select>
        </header>
        {error && <div role="alert">{error}</div>}
        <div className="ps-mobile-zen-chat"><ChatPane controller={controller} mobile fullWidth showComposer={false} /></div>
        <footer className="ps-mobile-zen-composer">{loading ? <span role="status">Opening session…</span> : <SessionComposer controller={controller} mobile compact />}</footer>
        <ModalLayer controller={controller} />
    </div></ControllerContext.Provider>;
}
