import React from "react";
import { buildWebhookConsoleLines, selectWebhookConsole, webhookText } from "pilotswarm/ui-core";
import { useUiPlatform } from "./platform.js";
import { useControllerSelector } from "./use-controller-state.js";

const h = React.createElement;
const line = (text, color = "white") => [{ text: webhookText(text), color }];

export function WebhookTuiPanel({ controller, width, height, frame }) {
    const platform = useUiPlatform();
    const view = useControllerSelector(controller, selectWebhookConsole);
    const capability = view.capabilityId ? controller.getWebhookCapability() : null;
    const lines = capability
        ? [line(view.capabilityWarning, "yellow"), line(""), line("Capability URL (plain text):", "cyan"),
            line(capability.url), line(""), line("Bearer token:", "cyan"), line(capability.token), line(""),
            line(view.help, "yellow"), ...(view.copyStatus ? [line(view.copyStatus)] : [])]
        : view.editor ? [] : buildWebhookConsoleLines(view);
    // The host measures wrapping; core only stores the numeric limit. Even
    // one-time text is neither cached by the host nor dispatched to the store.
    const scrollLimit = platform.getPanelScrollLimit?.({ lines, width, height });
    React.useEffect(() => {
        if (scrollLimit != null) controller.setWebhookScrollLimit(scrollLimit);
    }, [controller, scrollLimit]);
    if (capability) {
        // No selectable-pane registration: capability text cannot remain in
        // the terminal platform's pane cache. Copy is an explicit c gesture.
        return h(platform.Panel, {
            title: "One-time endpoint capability — Esc closes and erases",
            width, height, color: "yellow", focused: true, scrollMode: "top", scrollOffset: view.detailOffset, fillColor: "surface", lines,
        });
    }
    if (view.editor) {
        const editor = view.editor;
        const field = editor.activeField;
        const inputRows = field.type === "json" ? Math.min(6, Math.max(2, height - 20)) : 1;
        const footerHeight = Math.min(7, Math.max(4, height - inputRows - 10));
        return h(platform.Column, { width },
            h(platform.Panel, {
                title: editor.title, width, height: Math.max(6, height - inputRows - footerHeight),
                color: "cyan", focused: true, scrollMode: "top", scrollOffset: 0, fillColor: "surface",
                lines: [
                    line(`Field ${editor.fieldIndex + 1}/${editor.fields.length}: ${field.label}`, "cyan"),
                    line(field.help, "yellow"), line(""),
                    ...editor.fixed.map(text => line(text, "gray")),
                    line(editor.description, "gray"),
                    ...(field.options ? [line(`Choices: ${field.options.map(value => value || "(all)").join(" · ")}`)] : []),
                    ...(field.suggestions ? [line(`Visible sessions: ${field.suggestions.map(row => row.label).join(" · ")}`, "gray")] : []),
                ],
            }),
            h(platform.Input, {
                label: field.label, value: webhookText(editor.values[field.id]), cursorIndex: editor.cursorIndex,
                focused: !view.busy && !editor.stale, readOnly: view.busy || editor.stale, rows: inputRows,
                placeholder: field.type === "json" ? "JSON only; not JavaScript" : "Optional fields may be left blank",
            }),
            h(platform.Panel, {
                title: view.busy ? "Request pending" : editor.stale ? "Revision changed" : editor.submitLabel,
                width, height: footerHeight, color: editor.error ? "red" : "cyan", focused: false,
                scrollMode: "top", scrollOffset: 0, fillColor: "surface",
                lines: [
                    ...(editor.error ? [line(editor.error, "red")] : []),
                    ...(view.busy ? [line("Pending; no automatic retry. Esc cancels this view, not an accepted server request.", "yellow")] : []),
                    line(view.help, "cyan"),
                ],
            }));
    }
    return h(platform.Panel, {
        title: `Admin Console · Webhooks · ${view.tabs.find(tab => tab.id === view.tab)?.label || ""}`,
        color: "cyan", focused: true, width, height, frame, fillColor: "surface",
        paneId: "adminWebhooks", paneLabel: "Webhook metadata",
        lines, scrollMode: "top", scrollOffset: view.detailOffset,
    });
}
