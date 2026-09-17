import React from "react";
import { dropEdge, paneDrop, paneExtension } from "./pane-layout.js";

export function usePaneDrag({ enabled, tree, root, onDrop }) {
    const [drag, setDrag] = React.useState(null);
    const pending = React.useRef(null), suppressClick = React.useRef(false), clickTimer = React.useRef(null);
    const latest = React.useRef(null);
    latest.current = { enabled, tree, onDrop };
    const signature = JSON.stringify(tree);
    const cancel = React.useCallback(() => {
        const current = pending.current;
        pending.current = null;
        if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
        setDrag(null);
    }, []);
    React.useEffect(() => { cancel(); }, [enabled, signature, cancel]);
    React.useEffect(() => {
        const targetAt = event => {
            const current = pending.current;
            if (!current || !latest.current.enabled || current.signature !== JSON.stringify(latest.current.tree)) return null;
            const panel = [...(root.current?.querySelectorAll("[data-moa-panel]") || [])].find(element => {
                const box = element.getBoundingClientRect();
                return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
            });
            if (!panel || panel.dataset.moaPanel === current.id) return null;
            const box = panel.getBoundingClientRect();
            const edge = dropEdge(event.clientX - box.left, event.clientY - box.top, box.width, box.height);
            const extension = paneExtension(latest.current.tree, current.id, panel.dataset.moaPanel);
            const canExtend = extension?.edge === edge;
            const result = paneDrop(latest.current.tree, current.id, panel.dataset.moaPanel, canExtend && event.shiftKey ? "extend" : edge);
            return result && { ...result, targetId: panel.dataset.moaPanel, edge, extensionLabel: canExtend ? extension.label : null };
        };
        const move = event => {
            const current = pending.current;
            if (!current || event.pointerId !== current.pointerId) return;
            if (!current.started && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 7) return;
            current.started = true;
            current.position = { clientX: event.clientX, clientY: event.clientY };
            event.preventDefault();
            suppressClick.current = true;
            clearTimeout(clickTimer.current);
            setDrag({ sourceId: current.id, x: event.clientX, y: event.clientY, result: targetAt(event) });
        };
        const finish = event => {
            const current = pending.current;
            if (!current || event.pointerId !== current.pointerId) return;
            const result = current.started ? targetAt(event) : null;
            cancel();
            if (result) latest.current.onDrop(current.id, result, current.signature);
            clickTimer.current = setTimeout(() => { suppressClick.current = false; }, 0);
        };
        const abort = event => { if (event.type === "blur" || event.pointerId === pending.current?.pointerId) {
            cancel(); clickTimer.current = setTimeout(() => { suppressClick.current = false; }, 0);
        } };
        const key = event => {
            const current = pending.current;
            if (event.key === "Shift" && current?.started) {
                event.preventDefault();
                const position = { ...current.position, shiftKey: event.type === "keydown" };
                setDrag({ sourceId: current.id, x: position.clientX, y: position.clientY, result: targetAt(position) });
                return;
            }
            if (event.type !== "keydown") return;
            if (event.key !== "Escape" || !pending.current) return;
            event.preventDefault(); event.stopImmediatePropagation(); cancel();
            clickTimer.current = setTimeout(() => { suppressClick.current = false; }, 0);
        };
        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", abort);
        window.addEventListener("blur", abort);
        window.addEventListener("keydown", key, true);
        window.addEventListener("keyup", key, true);
        return () => {
            window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", abort); window.removeEventListener("blur", abort);
            window.removeEventListener("keydown", key, true);
            window.removeEventListener("keyup", key, true);
            cancel(); clearTimeout(clickTimer.current);
        };
    }, [cancel, root]);
    return { drag,
        onPointerDown(event, id) {
            if (!enabled || event.button !== 0 || event.isPrimary === false || pending.current
                || event.target.closest("header") !== event.currentTarget.querySelector(":scope > header")
                || event.target.closest("button,a,input,select,textarea,[contenteditable=true]")) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            pending.current = { id, signature, pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, started: false };
        },
        onClickCapture(event) {
            if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); }
        },
        onLostPointerCapture(event) { if (event.pointerId === pending.current?.pointerId) cancel(); },
    };
}
