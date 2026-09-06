import React from "react";
import { createPortal } from "react-dom";
import { ChatPane, CanvasFrame, SessionRowContent, ControllerContext, createWebPilotSwarmController, useControllerSelector } from "pilotswarm/ui-react";
import { canvasKey, getTheme, selectSessionRows, normalizeMoa, normalizeMoaLayout, emptyMoaPanel, moaLeaves, replaceMoaNode, encodeMoaShare, decodeMoaShare, MOA_MAX_PANELS, MOA_BREAKPOINT } from "pilotswarm/ui-core";
import "./moa.css";

const SHARE_STASH = "pilotswarm.moa.shared";
export function stashMoaLink() {
    const raw = new URLSearchParams(window.location.hash.slice(1)).get("moa");
    if (!raw) return;
    try { decodeMoaShare(raw); sessionStorage.setItem(SHARE_STASH, raw); } catch { /* Invalid links are reported after sign-in. */ }
}
function readShare() {
    let raw = new URLSearchParams(window.location.hash.slice(1)).get("moa");
    try { raw ||= sessionStorage.getItem(SHARE_STASH); } catch { /* URL is sufficient. */ }
    if (!raw) return null;
    try { return { layout: decodeMoaShare(raw) }; } catch (error) { return { error: error.message }; }
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
    const [shared, setShared] = React.useState(readShare);
    const drafts = React.useRef(new Map());
    const update = React.useCallback(next => controller.dispatch({ type: "ui/moa", value: next }), [controller]);
    // A resize suspends MoA, including all panel subscriptions. Restore only on
    // an explicit desktop action; a phone must never accidentally enter it.
    React.useEffect(() => { if (!desktop) { setActive(false); setZen(false); } }, [desktop]);
    const open = () => { if (desktop && loaded) { setActive(true); setReturnTo(false); } };
    const leave = () => { setActive(false); setZen(false); };
    return { desktop, loaded, value, update, saveStatus, active: desktop && active, zen: desktop && active && zen, setZen, open, leave, returnTo, setReturnTo, shared, setShared, drafts };
}

function Modal({ title, onClose, children }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
        const previous = document.activeElement;
        ref.current?.querySelector("input,button,select")?.focus();
        const key = e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
            if (e.key !== "Tab") return;
            const nodes = [...ref.current.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']")].filter(n => n.getClientRects().length);
            const first = nodes[0], last = nodes.at(-1);
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        };
        const node = ref.current; node.addEventListener("keydown", key);
        return () => { node.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
    }, [onClose]);
    return createPortal(<div className="ps-moa-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
        <section ref={ref} className="ps-moa-dialog" role="dialog" aria-modal="true" aria-label={title}>
            <header><strong>{title}</strong><button className="ps-mini-button" aria-label="Close dialog" onClick={onClose}>×</button></header>{children}
        </section>
    </div>, document.body);
}

function SessionPicker({ controller, onChoose, onClose, initial }) {
    const state = useControllerSelector(controller, s => s);
    const [selected, setSelected] = React.useState(initial?.sessionId || null), [query, setQuery] = React.useState("");
    const [kind, setKind] = React.useState(initial?.type === "canvas" ? String(initial.slot) : "chat");
    const [loading, setLoading] = React.useState(false), [error, setError] = React.useState("");
    const rows = selectSessionRows({ ...state, sessions: { ...state.sessions, activeSessionId: selected, filterQuery: query, selectedIds: [] } });
    React.useEffect(() => {
        if (!selected) return;
        let active = true; setLoading(true); setError("");
        controller.ensureCanvasSnapshot(selected).catch(() => { if (active) setError("Could not load canvases. Select the session again to retry."); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [controller, selected]);
    const session = state.sessions.byId[selected];
    const canvases = [1, 2, 3, 4, 5].map(slot => ({ slot, ...state.canvas?.bySessionId?.[canvasKey(selected, slot)] })).filter(c => c.latestRev > 0 && c.sizeBytes !== 0);
    return <Modal title="Sessions" onClose={onClose}>
        <div className="ps-moa-search"><input aria-label="Find a session" placeholder="Find a session…" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="ps-moa-session-list">
            {rows.map(row => <button key={row.sessionId} className={`ps-session-row ps-moa-session-row ${selected === row.sessionId ? "is-active" : ""}`} aria-pressed={selected === row.sessionId} onClick={() => {
                if (row.isGroup) controller.dispatch({ type: row.collapsed ? "sessions/expand" : "sessions/collapse", sessionId: row.sessionId });
                else { setSelected(row.sessionId); setKind("chat"); }
            }}><div className="ps-line ps-session-row-content" style={{ paddingLeft: Math.min(80, (row.depth || 0) * 16) }}><SessionRowContent row={row} theme={getTheme(state.ui.themeId)} structured /></div></button>)}
            {!rows.length && <p>No matching sessions.</p>}
        </div>
        <footer className="ps-moa-picker-detail"><div>{session?.title || (selected ? selected : "Select a session")}</div>
            <div className="ps-moa-row"><label htmlFor="moa-content-kind">Show</label><select id="moa-content-kind" value={kind} onChange={e => setKind(e.target.value)} disabled={!selected}>
                <option value="chat">Session chat</option>{canvases.map(c => <option key={c.slot} value={c.slot}>Canvas {c.slot}{c.name ? ` · ${c.name}` : ""}</option>)}
            </select><button className="ps-mini-button" disabled={!session || (kind !== "chat" && !canvases.some(c => String(c.slot) === kind))} onClick={() => onChoose({ type: kind === "chat" ? "chat" : "canvas", sessionId: selected, ...(kind !== "chat" ? { slot: Number(kind) } : {}) })}>Use {kind === "chat" ? "chat" : "canvas"}</button></div>
            {loading ? <small>Loading canvases…</small> : error ? <small role="alert">{error}</small> : selected && !canvases.length ? <small>No canvases in this session yet.</small> : null}
        </footer>
    </Modal>;
}

function LivePanel({ node, focused, parent, createTransport, drafts, draftKey }) {
    const [ready, setReady] = React.useState(null), [error, setError] = React.useState(""), [retry, setRetry] = React.useState(0);
    const themeId = useControllerSelector(parent, s => s.ui.themeId);
    const focusedRef = React.useRef(focused); focusedRef.current = focused;
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
            child.setFocus("chat");
            const draft = drafts.current.get(draftKey);
            if (draft) { child.dispatch({ type: "ui/prompt", prompt: draft.prompt }); child.dispatch({ type: "ui/promptAttachments", attachments: draft.attachments }); }
            offDraft = child.subscribe(s => drafts.current.set(draftKey, { prompt: s.ui.prompt, attachments: s.ui.promptAttachments || [] }));
            // Defense in depth: no hidden composer, stale selection or attachment
            // from another session may redirect a send to a different agent.
            const send = child.sendPrompt.bind(child);
            child.sendPrompt = async () => {
                const state = child.getState();
                if (cancelled || !focusedRef.current || state.sessions.activeSessionId !== node.sessionId || child.getPromptAttachments().some(a => a.sessionId && a.sessionId !== node.sessionId)) return;
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
    const ref = React.useRef(null);
    React.useEffect(() => {
        if (!ready || !ref.current) return;
        const observer = new ResizeObserver(([entry]) => ready.dispatch({ type: "ui/viewport", width: Math.max(20, Math.floor(entry.contentRect.width / 8)), height: Math.max(10, Math.floor(entry.contentRect.height / 16)) }));
        observer.observe(ref.current); return () => observer.disconnect();
    }, [ready]);
    return <div ref={ref} className="ps-moa-live">
        {error ? <div className="ps-moa-empty" role="status"><p>{error}</p><button className="ps-mini-button" onClick={() => setRetry(n => n + 1)}>Retry</button></div> : ready ? <ControllerContext.Provider value={ready}>{node.type === "chat" ? <ChatPane controller={ready} fullWidth showComposer={focused} /> : <PinnedCanvas controller={ready} node={node} />}</ControllerContext.Provider> : <div className="ps-moa-empty" role="status">Connecting…</div>}
    </div>;
}
function PinnedCanvas({ controller, node }) {
    const entry = useControllerSelector(controller, s => s.canvas?.bySessionId?.[canvasKey(node.sessionId, node.slot)]);
    if (!entry?.latestRev || entry.sizeBytes === 0) return <div className="ps-moa-empty">Canvas {node.slot} is empty or no longer available.</div>;
    return <CanvasFrame key={`${node.sessionId}:${node.slot}`} controller={controller} sessionId={node.sessionId} slot={node.slot} latestRev={entry.latestRev} zoom={1} dataRev={entry.latestDataRev || 0} dataPayload={entry.dataPayload || null} dataPatch={entry.dataPatch || null} />;
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
    const { value, update } = moa, layout = value.slots[value.activeSlot];
    const state = useControllerSelector(controller, s => s);
    const [focus, setFocus] = React.useState(null), [picker, setPicker] = React.useState(null), [menu, setMenu] = React.useState(null), [share, setShare] = React.useState(null), [error, setError] = React.useState(""), [copied, setCopied] = React.useState(false);
    const closePicker = React.useCallback(() => setPicker(null), []), closeMenu = React.useCallback(() => setMenu(null), []), closeShare = React.useCallback(() => setShare(null), []);
    const [name, setName] = React.useState(layout.name);
    React.useEffect(() => setName(layout.name), [layout.name, value.activeSlot]);
    const nodes = moaLeaves(layout.tree), selected = nodes.some(n => n.id === focus) ? focus : nodes[0]?.id;
    const saveLayout = next => update({ ...value, slots: value.slots.map((slot, i) => i === value.activeSlot ? next : slot) });
    const replace = (id, next) => saveLayout({ ...layout, tree: id ? replaceMoaNode(layout.tree, id, next) : next });
    const split = (node, direction) => {
        if (nodes.length >= MOA_MAX_PANELS) { setError(`A MoA supports up to ${MOA_MAX_PANELS} panels.`); return; }
        const empty = emptyMoaPanel();
        replace(node.id, { id: crypto.randomUUID(), type: "split", direction, ratio: 50, first: node, second: empty }); setFocus(empty.id); setMenu(null);
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
        const key = e => { if (e.key === "Escape" && !document.querySelector(".ps-moa-dialog")) moa.setZen(false); };
        window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
    }, [moa.setZen]);
    // Sandboxed canvases consume pointer events; parent focus is detected when
    // the browser focuses their iframe, without reading the iframe contents.
    React.useEffect(() => {
        let timer; const blur = () => { timer = setTimeout(() => { const panel = document.activeElement?.closest?.("[data-moa-panel]"); if (panel) setFocus(panel.dataset.moaPanel); }, 0); };
        window.addEventListener("blur", blur); return () => { clearTimeout(timer); window.removeEventListener("blur", blur); };
    }, []);
    function draw(node) {
        if (node.type === "split") return <Split key={node.id} node={node} onResize={ratio => replace(node.id, { ...node, ratio })}>{[draw(node.first), draw(node.second)]}</Split>;
        const session = state.sessions.byId[node.sessionId], title = node.type === "empty" ? "Empty panel" : session?.title || "Session";
        const active = selected === node.id;
        return <section key={node.id} className={`ps-moa-panel ${active ? "is-focused" : ""}`} data-moa-panel={node.id} data-session-id={node.sessionId} aria-label={`${node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}${title}`} onPointerDownCapture={() => setFocus(node.id)} onFocusCapture={() => setFocus(node.id)} onContextMenu={e => { e.preventDefault(); setFocus(node.id); node.type === "empty" ? setPicker(node) : setMenu(node); }}>
            <header><span className="ps-moa-panel-title">{node.type === "canvas" ? `Canvas ${node.slot} · ` : ""}{title}</span>{active && <span className="ps-moa-focus-label">Focused</span>}{node.type !== "empty" && <button className="ps-mini-button" aria-label="Open panel in main view" onClick={() => zoom(node)}>↗</button>}<button className="ps-mini-button" aria-label="Panel options" onClick={() => setMenu(node)}>⋯</button></header>
            {node.type === "empty" ? <div className="ps-moa-empty"><button className="ps-moa-add" aria-label="Choose session or canvas" onClick={() => setPicker(node)}>+</button></div> : <LivePanel key={`${node.id}:${node.sessionId}`} node={node} focused={active && !picker && !menu && !share} parent={controller} createTransport={createTransport} drafts={moa.drafts} draftKey={`${value.activeSlot}:${node.id}:${node.sessionId}`} />}
        </section>;
    }
    return <div className={`ps-moa-workspace ${moa.zen ? "is-zen" : ""}`}>
        {moa.zen ? <button className="ps-moa-zen-exit ps-mini-button" onClick={() => moa.setZen(false)}>MoA · Exit zen ↙</button> : <nav className="ps-moa-toolbar" aria-label="Master of Agents">
            <button className="ps-mini-button" onClick={moa.leave}>← Default</button><div className="ps-moa-slots">{value.slots.map((s, i) => <button className="ps-mini-button" key={i} aria-label={`MoA ${i + 1}: ${s.name}`} aria-pressed={value.activeSlot === i} onClick={() => { update({ ...value, activeSlot: i }); setFocus(null); }}>{i + 1}</button>)}</div>
            <input className="ps-moa-name" aria-label="MoA name" maxLength={64} value={name} onChange={e => setName(e.target.value)} onBlur={() => { if (name !== layout.name) saveLayout({ ...layout, name }); }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            <span className="ps-moa-save" role="status">{moa.saveStatus === "error" ? <button className="ps-mini-button" onClick={() => update(value)}>Save failed · Retry</button> : moa.saveStatus === "saving" ? "Saving…" : "Saved to profile"}</span>
            <button className="ps-mini-button" onClick={() => { if (!layout.tree) setPicker({ id: null }); else split(nodes.find(n => n.id === selected) || nodes[0], "row"); }}>+ Panel</button>
            <button className="ps-mini-button" onClick={() => { const url = new URL(window.location.href); url.search = ""; url.hash = `moa=${encodeMoaShare(layout)}`; setCopied(false); setShare(url.href); }}>Share</button><button className="ps-mini-button" onClick={() => moa.setZen(true)}>Zen ↗</button>
        </nav>}
        {error && <div role="alert" className="ps-moa-error">{error}<button className="ps-mini-button" onClick={() => setError("")}>Dismiss</button></div>}
        <div className="ps-moa-layout" key={value.activeSlot}>{layout.tree ? draw(layout.tree) : <div className="ps-moa-empty" onContextMenu={e => { e.preventDefault(); setPicker({ id: null }); }}><button className="ps-moa-add" aria-label="Add first MoA panel" onClick={() => setPicker({ id: null })}>+</button></div>}</div>
        {picker && <SessionPicker controller={controller} initial={picker} onClose={closePicker} onChoose={binding => { const next = { id: picker.id || crypto.randomUUID(), ...binding }; replace(picker.id, next); setFocus(next.id); setPicker(null); }} />}
        {menu && <Modal title="Panel options" onClose={closeMenu}><div className="ps-moa-menu"><button className="ps-mini-button" onClick={() => { setPicker(menu); setMenu(null); }}>{menu.type === "empty" ? "Choose" : "Replace"} session or canvas…</button><button className="ps-mini-button" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(menu, "row")}>Split right</button><button className="ps-mini-button" disabled={nodes.length >= MOA_MAX_PANELS} onClick={() => split(menu, "column")}>Split below</button>{menu.type !== "empty" && <button className="ps-mini-button" onClick={() => { zoom(menu); setMenu(null); }}>Open in main view</button>}<button className="ps-mini-button" onClick={() => { replace(menu.id, null); setMenu(null); }}>Remove panel</button></div></Modal>}
        {share && <Modal title="Share MoA" onClose={closeShare}><div className="ps-moa-menu"><p>This link copies the arrangement. Session access still applies.</p><input aria-label="MoA share link" readOnly value={share} onFocus={e => e.target.select()} /><button className="ps-mini-button" onClick={async () => { try { await navigator.clipboard.writeText(share); setCopied(true); } catch { setError("Select and copy the link manually."); } }}>{copied ? "Copied" : "Copy link"}</button></div></Modal>}
    </div>;
}

export function MoaImport({ moa, controller }) {
    const [destination, setDestination] = React.useState(() => Math.max(0, moa.value.slots.findIndex(s => !s.tree))), [confirm, setConfirm] = React.useState(false);
    const close = React.useCallback(() => { moa.setShared(null); try { sessionStorage.removeItem(SHARE_STASH); } catch {} const url = new URL(location.href); url.hash = ""; history.replaceState(null, "", url); }, [moa.setShared]);
    React.useEffect(() => { if (moa.loaded) setDestination(Math.max(0, moa.value.slots.findIndex(s => !s.tree))); }, [moa.loaded]);
    const state = useControllerSelector(controller, s => s);
    if (!moa.shared) return null;
    if (!moa.desktop) return <div className="ps-moa-mobile-notice" role="status">MoA layouts are available on desktop screens.<button className="ps-mini-button" onClick={close}>Dismiss</button></div>;
    const shared = moa.shared;
    return <Modal title={shared.error ? "Invalid MoA link" : `Shared MoA · ${shared.layout.name}`} onClose={close}>
        <div className="ps-moa-menu">{shared.error ? <p role="alert">{shared.error}</p> : <>
            <div className="ps-moa-import-preview">{moaLeaves(shared.layout.tree).map(n => <div key={n.id}>{n.type === "empty" ? "Empty panel" : state.sessions.byId[n.sessionId]?.title || "Session · access checked when opened"}<small>{n.type === "canvas" ? `Canvas ${n.slot}` : n.type}</small></div>)}</div>
            <p>Copy this arrangement into your profile. It does not grant access to sessions.</p><label>Copy into <select aria-label="Destination MoA slot" value={destination} onChange={e => { setDestination(Number(e.target.value)); setConfirm(false); }}>{moa.value.slots.map((s, i) => <option key={i} value={i}>{i + 1} · {s.name}{s.tree ? " (occupied)" : " (empty)"}</option>)}</select></label>
            {confirm && <p role="alert">Replace “{moa.value.slots[destination].name}”? Its current arrangement will be overwritten.</p>}
            <button className="ps-mini-button" disabled={!moa.loaded} onClick={() => { if (moa.value.slots[destination].tree && !confirm) { setConfirm(true); return; } const slots = moa.value.slots.map((s, i) => i === destination ? normalizeMoaLayout(shared.layout) : s); moa.update({ ...moa.value, activeSlot: destination, slots }); close(); moa.open(); }}>{confirm ? "Replace arrangement" : "Copy to my slot"}</button>
        </>}</div>
    </Modal>;
}
