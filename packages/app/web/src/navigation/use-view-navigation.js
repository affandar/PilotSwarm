import React from "react";
import { useControllerSelector } from "pilotswarm/ui-react";
import { activeMoaDashboard, normalizeMoa, moaLeaves, updateMoaDashboard } from "pilotswarm/ui-core";
import { cleanView, createViewHistory, navigationShortcut, viewKey } from "./view-history.js";

function capture(controller, moa) {
    const s = controller.getState(), dashboard = activeMoaDashboard(normalizeMoa(s.ui.moa));
    const artifact = s.files.paneOpen ? s.files.selectedArtifactId : null;
    const separator = artifact?.indexOf("/") ?? -1;
    return cleanView({
        mode: moa.active ? "moa" : s.admin.visible ? "admin" : s.ui.budgetOpen ? "budget" : "workspace",
        sessionId: s.sessions.activeSessionId, dashboardId: dashboard.id, panelId: dashboard.focusedPanelId,
        moaZen: moa.zen, canvasOpen: s.ui.canvasOpen, canvasSlot: s.ui.canvasSlot || 1,
        canvasMaximized: s.ui.canvasMaximized, canvasZen: s.ui.canvasZen, diagnosticsOpen: s.ui.diagnosticsOpen,
        artifactSessionId: separator >= 0 ? artifact.slice(0, separator) : null,
        artifactFilename: separator >= 0 ? artifact.slice(separator + 1) : null,
    });
}
function label(view, state) {
    if (!view) return "";
    if (view.mode === "moa") return normalizeMoa(state.ui.moa).dashboards.find(d => d.id === view.dashboardId)?.name || "Unavailable dashboard";
    if (view.mode === "admin") return "Settings";
    if (view.mode === "budget") return "Budget";
    const title = state.sessions.byId[view.sessionId]?.title || "Session";
    return view.artifactFilename ? `${title} · ${view.artifactFilename}` : view.canvasOpen ? `${title} · Canvas ${view.canvasSlot}` : title;
}

export function useViewNavigation(controller, moa) {
    const latest = React.useRef(moa); latest.current = moa;
    const scope = useControllerSelector(controller, s => {
        const p = s.auth?.principal;
        return p && (p.subject || p.email) && s.ui.moaLoaded ? JSON.stringify([p.provider || "", p.subject || p.email]) : null;
    });
    const data = React.useRef(null), generation = React.useRef(0), gesture = React.useRef(null);
    const [, redraw] = React.useReducer(n => n + 1, 0);
    const createdSessionId = useControllerSelector(controller, s => s.ui.revealedCreatedSessionId);
    const publish = React.useCallback(() => {
        const current = data.current;
        if (!current) return;
        try { sessionStorage.setItem(current.key, current.history.serialize()); } catch { /* In-memory navigation still works. */ }
        redraw();
    }, []);
    React.useEffect(() => {
        if (!scope) { data.current = null; return; }
        const key = `pilotswarm.view-history.v1:${scope}`;
        let saved; try { saved = sessionStorage.getItem(key); } catch {}
        const history = createViewHistory(saved);
        history.visit(capture(controller, latest.current));
        data.current = { key, history }; publish();
        return () => { generation.current++; data.current = null; };
    }, [controller, scope, publish]);

    React.useEffect(() => {
        if (!createdSessionId || !moa.desktop) return;
        // Session creation is an explicit navigation whose completion can
        // arrive after the initiating click (and after leaving its dialog).
        const timer = setTimeout(() => {
            if (!data.current || controller.getState().sessions.activeSessionId !== createdSessionId) return;
            data.current.history.visit(capture(controller, latest.current)); publish();
        }, 0);
        return () => clearTimeout(timer);
    }, [createdSessionId, controller, moa.desktop, publish]);

    const restore = React.useCallback(view => {
        const request = ++generation.current, currentMoa = latest.current;
        const ownsView = () => request === generation.current;
        const unavailable = () => { if (ownsView()) controller.setStatus("This view is unavailable or access has changed. Use Back or Forward to return."); };
        if (view.mode === "moa") {
            const value = normalizeMoa(controller.getState().ui.moa);
            const dashboard = value.dashboards.find(d => d.id === view.dashboardId);
            if (!dashboard) { unavailable(); return; }
            const panelExists = moaLeaves(dashboard.tree).some(n => n.id === view.panelId);
            currentMoa.update({ ...updateMoaDashboard(value, dashboard.id, panelExists ? { focusedPanelId: view.panelId } : {}), activeDashboardId: dashboard.id });
            controller.openWorkspace();
            controller.dispatch({ type: "ui/canvasMaximized", on: false });
            currentMoa.open(); currentMoa.setZen(view.moaZen);
            return;
        }
        const wasMoa = currentMoa.active;
        currentMoa.leave();
        if (wasMoa) currentMoa.setReturnTo(true);
        if (view.mode === "admin") { controller.openAdminConsole().catch(unavailable); return; }
        if (view.mode === "budget") { controller.openBudget().catch(unavailable); return; }
        controller.openWorkspace();
        controller.dispatch({ type: "files/pane", open: false });
        controller.dispatch({ type: "files/fullscreen", fullscreen: false });
        if (view.sessionId) {
            controller.loadSession(view.sessionId).catch(unavailable);
            controller.dispatch({ type: "sessions/navigationIntent", sessionId: view.sessionId });
            if (wasMoa) currentMoa.restoreSessionDraft(view.sessionId);
        }
        controller.dispatch({ type: "ui/canvasOpen", open: view.canvasOpen, manual: true });
        controller.dispatch({ type: "ui/canvasSlot", slot: view.canvasSlot });
        controller.dispatch({ type: "ui/canvasMaximized", on: view.canvasMaximized });
        controller.dispatch({ type: "ui/canvasZen", on: view.canvasZen });
        controller.dispatch({ type: "ui/diagnosticsOpen", open: view.diagnosticsOpen });
        if (view.artifactFilename && view.artifactSessionId) {
            // Selection happens before the fetch; a late response only warms
            // the cache and can never open a pane over a newer destination.
            controller.dispatch({ type: "files/select", sessionId: view.artifactSessionId, filename: view.artifactFilename });
            controller.dispatch({ type: "files/pane", open: true });
            Promise.all([controller.ensureFilesForSession(view.artifactSessionId, { force: true }),
                controller.ensureFilePreview(view.artifactSessionId, view.artifactFilename, { force: true })]).catch(unavailable);
        }
    }, [controller]);
    React.useEffect(() => {
        const previous = controller.openChatArtifact;
        controller.openChatArtifact = (sessionId, filename) => {
            if (!latest.current.desktop) return controller.revealArtifact(sessionId, filename, { fullscreen: true, preserveSession: true });
            const name = String(filename || "").trim();
            if (!sessionId || !name) return Promise.resolve(false);
            const state = controller.getState();
            controller.dispatch({ type: "files/previewOrigin", origin: "chat", restoreArtifactId: state.files.selectedArtifactId });
            if (state.sessions.activeSessionId !== sessionId) controller.loadSession(sessionId).catch(() => {});
            const wasHidden = Boolean(controller.getCurrentLayout()?.rightHidden);
            if (wasHidden) controller.expandRightColumn();
            controller.dispatch({ type: "files/select", sessionId, filename: name });
            controller.dispatch({ type: "files/pane", open: true, restoresToHidden: wasHidden });
            return Promise.all([controller.ensureFilesForSession(sessionId, { force: true }),
                controller.ensureFilePreview(sessionId, name, { force: true })]);
        };
        return () => { if (previous) controller.openChatArtifact = previous; else delete controller.openChatArtifact; };
    }, [controller]);

    const move = React.useCallback(delta => {
        const history = data.current?.history;
        if (!latest.current.desktop || !history?.destination(delta)) return;
        gesture.current = null;
        history.replace(capture(controller, latest.current));
        const destination = history.move(delta); publish(); restore(destination);
    }, [controller, publish, restore]);

    React.useEffect(() => {
        if (!moa.desktop) return;
        let timer;
        // Observe user gestures, not store subscriptions: polling, streamed
        // messages, agent canvas presentations and resize never add entries.
        // Wait for React's event batch so entering/leaving MoA is one visit.
        const begin = event => {
            if (!data.current || event.repeat || event.isComposing) return;
            if (event.type === "keydown") {
                const direction = navigationShortcut(event);
                if (direction && !document.querySelector('.ps-modal-backdrop, .ps-moa-dialog, .ps-share-overlay')) {
                    event.preventDefault(); event.stopPropagation(); move(direction); return;
                }
                if (!["Enter", " ", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Tab", "j", "k"].includes(event.key)) return;
            }
            clearTimeout(timer);
            const before = capture(controller, latest.current);
            const token = {}; gesture.current = token;
            timer = setTimeout(() => {
                if (gesture.current !== token || !data.current) return;
                gesture.current = null;
                const after = capture(controller, latest.current), history = data.current.history;
                // Remember the focused MoA panel without turning panel clicks
                // into visits. Background state becomes the current view only.
                history.replace(before);
                if (viewKey(before) !== viewKey(after)) generation.current++;
                history.visit(after); publish();
            }, 0);
        };
        document.addEventListener("click", begin, true);
        window.addEventListener("keydown", begin, true);
        return () => { clearTimeout(timer); gesture.current = null; document.removeEventListener("click", begin, true); window.removeEventListener("keydown", begin, true); };
    }, [controller, moa.desktop, move, publish]);

    const state = controller.getState(), history = data.current?.history;
    const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "Option" : "Alt";
    return {
        back: () => move(-1), forward: () => move(1),
        canBack: Boolean(history?.destination(-1)), canForward: Boolean(history?.destination(1)),
        backLabel: `Back${history?.destination(-1) ? ` to ${label(history.destination(-1), state)}` : ""} (${modifier}+−)`,
        forwardLabel: `Forward${history?.destination(1) ? ` to ${label(history.destination(1), state)}` : ""} (${modifier}++)`,
    };
}
