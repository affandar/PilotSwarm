import React from "react";
import { selectWebhookConsole, webhookReceiptMeaning, webhookText } from "pilotswarm/ui-core";
import { useControllerSelector } from "./use-controller-state.js";

const h = React.createElement;
const styles = `
.ps-webhooks { min-width:0; display:flex; flex-direction:column; gap:12px; padding:16px; }
.ps-webhooks__bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.ps-webhooks__tabs button[aria-current="page"] { outline:1px solid var(--ps-border); color:var(--ps-accent); }
.ps-webhooks__content { display:grid; grid-template-columns:minmax(180px,1fr) minmax(240px,2fr); gap:12px; min-height:0; }
.ps-webhooks__list { display:flex; flex-direction:column; gap:4px; max-height:60dvh; overflow:auto; }
.ps-webhooks__row { display:flex; justify-content:space-between; gap:12px; text-align:left; white-space:normal; overflow-wrap:anywhere; }
.ps-webhooks__row[aria-pressed="true"] { outline:1px solid var(--ps-border); font-weight:bold; }
.ps-webhooks pre { white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; font-size:12px; }
.ps-webhooks__detail { min-width:0; max-height:65dvh; overflow:auto; }
.ps-webhooks__detail table { width:100%; border-collapse:collapse; }
.ps-webhooks__detail th,.ps-webhooks__detail td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--ps-border); overflow-wrap:anywhere; }
.ps-webhooks__form { display:flex; flex-direction:column; gap:14px; padding:16px; overflow:auto; max-height:65dvh; }
.ps-webhooks__field { display:flex; flex-direction:column; gap:5px; font-weight:600; }
.ps-webhooks__field small { font-weight:normal; color:var(--ps-muted); white-space:pre-wrap; overflow-wrap:anywhere; }
.ps-webhooks__field textarea { min-height:90px; resize:vertical; font:inherit; }
.ps-webhooks__dialog { width:min(780px,95vw); max-height:92dvh; display:flex; flex-direction:column; }
.ps-webhooks__capability { padding:16px; overflow:auto; }
.ps-webhooks__capability pre { padding:8px; border:1px solid var(--ps-border); user-select:text; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-all; }
@media(max-width:920px) { .ps-webhooks__content { grid-template-columns:minmax(0,1fr); } .ps-webhooks__list { max-height:30dvh; } }
`;

function button(label, onClick, disabled = false, extra = {}) {
    return h("button", { type: "button", className: "ps-mini-button", disabled, onClick, ...extra }, label);
}
function alert(text) {
    return text ? h("div", { className: "ps-admin-console__error", role: "alert" }, webhookText(text)) : null;
}
function note(text) {
    return h("p", { className: "ps-admin-console__hint" }, webhookText(text));
}
function jsonText(value) { return webhookText(JSON.stringify(value, null, 2)); }
function writeClipboardText(value) {
    if (!globalThis.navigator?.clipboard?.writeText) throw new Error("Clipboard unavailable");
    return globalThis.navigator.clipboard.writeText(value);
}

function WebhookDialog({ title, close, children }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
        const previous = globalThis.document?.activeElement;
        const first = ref.current?.querySelector("input,textarea,select,button");
        first?.focus();
        return () => previous?.isConnected && previous.focus?.();
    }, []);
    return h("div", { className: "ps-modal-backdrop", onClick: close },
        h("div", {
            className: "ps-modal ps-webhooks__dialog", ref, role: "dialog", "aria-modal": true, "aria-label": title,
            onClick: event => event.stopPropagation(),
            onKeyDown: event => {
                event.stopPropagation();
                if (event.key === "Escape") { event.preventDefault(); close(); }
                if (event.key !== "Tab") return;
                const fields = Array.from(ref.current?.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)") || []);
                if (!fields.length) return;
                const index = fields.indexOf(globalThis.document?.activeElement);
                if (event.shiftKey && index <= 0) { event.preventDefault(); fields.at(-1).focus(); }
                else if (!event.shiftKey && index === fields.length - 1) { event.preventDefault(); fields[0].focus(); }
            },
        },
        h("div", { className: "ps-modal-header" }, h("h3", { className: "ps-modal-title" }, title),
            button("Close", close, false, { "aria-label": "Close webhook dialog" })),
        children));
}

/** Pure form composition so interaction tests invoke the actual rendered handlers. */
export function WebhookEditorForm({ controller, view }) {
    const editor = view.editor;
    if (!editor) return null;
    return h("form", { onSubmit: event => { event.preventDefault(); void controller.submitWebhookEditor(); }, "aria-label": editor.title },
        h("div", { className: "ps-webhooks__form" },
            note(editor.description),
            editor.fixed.map((text, index) => h("pre", { key: index }, webhookText(text))),
            editor.stale ? alert("Revision changed. Close and reopen this edit after refresh; no automatic retry is permitted.") : null,
            editor.fields.map(field => {
                const props = {
                    id: `webhook-field-${field.id}`, name: field.id, className: "ps-modal-input",
                    value: editor.values[field.id], disabled: view.busy || editor.stale,
                    onChange: event => controller.setWebhookEditorField(field.id, event.target.value),
                    autoComplete: "off", spellCheck: false, "aria-describedby": `webhook-help-${field.id}`,
                    ...(field.suggestions ? { list: `webhook-options-${field.id}` } : {}),
                };
                const input = field.type === "json" ? h("textarea", { ...props, rows: 5 })
                    : field.type === "choice" ? h("select", props, field.options.map(option => h("option", { key: option, value: option }, option || "All statuses")))
                        : h("input", { ...props, type: "text", ...(field.type === "number" ? { inputMode: "numeric" } : {}) });
                return h("label", { key: field.id, className: "ps-webhooks__field", htmlFor: props.id },
                    field.label, input,
                    field.suggestions ? h("datalist", { id: `webhook-options-${field.id}` },
                        field.suggestions.map(row => h("option", { key: row.id, value: row.id }, row.label))) : null,
                    h("small", { id: `webhook-help-${field.id}` }, field.help));
            }),
            alert(editor.error),
            view.busy ? note("Request pending. No automatic retry. Closing may leave an operation completing on the server; refresh before acting again.") : null),
        h("div", { className: "ps-modal-footer" },
            button("Cancel", () => controller.closeWebhookDialog()),
            h("button", { type: "submit", className: "ps-modal-button is-primary", disabled: view.busy || editor.stale }, view.busy ? "Pending…" : editor.submitLabel)));
}

/** Secrets are read only while this one-time dialog is actually mounted. They
 * are never props of the Admin Console selector, resource list, or status bar. */
export function WebhookCapabilityDialog({ controller, view, copyCapability }) {
    const capability = controller.getWebhookCapability();
    if (!capability || !view.capabilityId) return null;
    const copy = copyCapability || writeClipboardText;
    return h(WebhookDialog, { title: "One-time endpoint capability", close: () => controller.closeWebhookDialog() },
        h("div", { className: "ps-webhooks__capability", "data-sensitive": "one-time-capability" },
            note(view.capabilityWarning),
            h("h4", null, "Capability URL (text only; never auto-opened)"), h("pre", null, webhookText(capability.url)),
            h("h4", null, "Bearer token"), h("pre", null, webhookText(capability.token)),
            view.copyStatus ? h("p", { role: "status" }, view.copyStatus) : null),
        h("div", { className: "ps-modal-footer" },
            button("Copy capability URL", () => controller.copyWebhookCapability(copy)),
            button("Close and erase", () => controller.closeWebhookDialog())));
}

function ReceiptDetail({ controller, view }) {
    const receipt = view.selected;
    if (!receipt) return note("Select a receipt to see its redacted chronological timeline.");
    return h("section", { "aria-label": "Receipt detail" },
        h("h4", null, `${webhookText(receipt.status)} — ${webhookReceiptMeaning(receipt.status)}`),
        h("p", null, `Attempts: ${receipt.attempts} · Duplicates: ${receipt.duplicateCount} · Replays: ${receipt.replayCount}`),
        receipt.lastErrorCode ? alert(`Last error: ${receipt.lastErrorCode}`) : null,
        receipt.nextAttemptAt ? note(`Next attempt: ${receipt.nextAttemptAt}`) : null,
        view.receipts.detailLoading ? note("Loading receipt timeline…") : null,
        alert(view.receipts.detailError),
        h("div", { className: "ps-webhooks__bar" },
            button("Replay receipt…", () => controller.requestWebhookReplay(), !view.canReplay),
            receipt.sessionId ? button("Select receipt session", () => controller.openWebhookReceiptSession(),
                Boolean(view.receipts.detailError || view.receipts.detailLoading || view.loading), { title: "Use the existing session navigator; current access is still enforced." }) : null),
        h("pre", null, jsonText(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "timeline")))),
        h("table", { "aria-label": "Receipt timeline" },
            h("thead", null, h("tr", null, ["Time", "Status", "Error code"].map(text => h("th", { key: text }, text)))),
            h("tbody", null, (receipt.timeline || []).map((entry, index) => h("tr", { key: `${index}:${entry.at}` },
                h("td", null, webhookText(entry.at)), h("td", null, webhookText(entry.status)), h("td", null, webhookText(entry.code || "—")))))));
}

function Health({ view }) {
    const data = view.health.data;
    return h("section", { className: "ps-webhooks__detail", "aria-label": "Webhook health" },
        note("Viewer-scoped, bounded aggregates of receipt/error facts. Authentication configured is not proof of successful resolution or verified delivery."),
        data ? h(React.Fragment, null,
            h("p", null, `Pending: ${data.pending} · Oldest pending age: ${data.oldestPendingAgeSeconds}s`),
            h("p", null, `Dead-lettered: ${data.deadLettered} · Oldest dead-letter age: ${data.oldestDeadLetterAgeSeconds}s`),
            h("table", null,
                h("thead", null, h("tr", null, ["Provider", "Receipt status", "Count"].map(label => h("th", { key: label }, label)))),
                h("tbody", null, data.receipts.map((row, index) => h("tr", { key: index },
                    h("td", null, webhookText(row.provider)), h("td", null, webhookText(row.status)), h("td", null, String(row.count)))))))
            : !view.loading && !view.loadError ? note("No health snapshot loaded.") : null);
}

/** Real browser controls; all semantics and mutations go through ui-core. */
export function WebhookPanel({ controller, view, copyCapability }) {
    const locked = view.busy || Boolean(view.editor || view.capabilityId);
    return h("section", { className: "ps-webhooks", "aria-label": "Webhook management" },
        h("style", null, styles),
        h("h3", null, "Webhooks"),
        h("p", { className: "ps-admin-console__hint", role: "status" }, view.ingressText),
        note(view.scopeNote),
        h("nav", { className: "ps-webhooks__bar ps-webhooks__tabs", "aria-label": "Webhook pages" },
            view.tabs.map(tab => button(tab.label, () => controller.setWebhookTab(tab.id), locked,
                { key: tab.id, "aria-current": view.tab === tab.id ? "page" : undefined }))),
        h("div", { className: "ps-webhooks__bar" },
            button("Refresh", () => controller.refreshAdminWebhooks(), view.loading || locked),
            ["connectors", "bindings", "templates", "endpoints"].includes(view.tab)
                ? button(view.tab === "endpoints" ? "Mint endpoint…" : view.tab === "templates" ? "Approve template…" : "Create…",
                    () => controller.openWebhookEditor(), !view.canCreate || locked) : null,
            ["connectors", "bindings", "templates"].includes(view.tab)
                ? button("Edit…", () => controller.openWebhookEditor(view.tab, "edit"), !view.canEdit || locked) : null,
            ["connectors", "bindings", "templates", "endpoints"].includes(view.tab)
                ? button("Revoke…", () => controller.requestWebhookRevoke(), !view.canRevoke || locked) : null,
            view.tab === "bindings" ? button("Dry run…", () => controller.openWebhookEditor("test"), !view.canTest || locked) : null,
            ["connectors", "endpoints"].includes(view.tab)
                ? button("Related receipts", () => controller.showWebhookResourceReceipts(), (!view.selected && !(view.tab === "endpoints" && view.sessionId)) || locked) : null,
            view.tab === "receipts" ? button("Filter receipts…", () => controller.openWebhookEditor("receipts"), locked) : null),
        ["connectors", "templates"].includes(view.tab) && !view.isAdmin
            ? note("Administrators create connectors and approve template config/prompt. Owners can manage their visible resource metadata; the server decides every request.") : null,
        view.tab === "endpoints" ? h("div", null,
            h("div", { className: "ps-webhooks__bar" },
                h("label", null, "Target session ",
                    h("select", { className: "ps-modal-input", "aria-label": "Target session", value: view.sessionId || "", disabled: locked,
                        onChange: event => controller.setWebhookSession(event.target.value) },
                    h("option", { value: "" }, "Choose a session"),
                    view.sessionId && !view.sessionRows.some(row => row.id === view.sessionId) ? h("option", { value: view.sessionId }, webhookText(view.sessionId)) : null,
                    view.sessionRows.map(row => h("option", { key: row.id, value: row.id }, row.label)))),
                button("Enter session ID…", () => controller.openWebhookEditor("session"), locked),
                button("Raise signal…", () => controller.openWebhookEditor("signal"), !view.canRaise || locked)),
            note(view.waitText),
            view.signalState.loading ? note("Loading signal state…") : null,
            alert(view.signalState.error),
            view.signalState.data ? h("details", null, h("summary", null, `Buffered signals: ${view.signalState.data.buffered.length} — metadata only`),
                h("pre", null, jsonText(view.signalState.data))) : null) : null,
        view.loading ? h("p", { role: "status" }, "Loading…") : null,
        view.pending ? h("p", { role: "status" }, "Request pending; no automatic retries.") : null,
        alert(view.connectionError), alert(view.loadError),
        !view.editor ? alert(view.error) : null,
        view.notice ? h("p", { role: "status" }, view.notice) : null,
        view.testResult ? h("section", { "aria-label": "Binding dry-run result" },
            h("p", null, `Matches: ${view.testResult.matches ? "yes" : "no"} · Authorized: ${view.testResult.authorized ? "yes" : "no"} · Scope: ${view.testResult.authorizationScope}`),
            note(view.testHelp)) : null,
        view.tab === "receipts" ? h("div", null,
            note(`Current query: ${JSON.stringify(view.receipts.query)}`),
            h("div", { className: "ps-webhooks__bar" },
                button("Newest", () => controller.pageWebhookReceipts(0), locked || view.loading || !view.receipts.query.before),
                button("Newer", () => controller.pageWebhookReceipts(-1), locked || view.loading || !view.receipts.cursors.length),
                button("Older", () => controller.pageWebhookReceipts(1), locked || view.loading || !view.receipts.hasMore))) : null,
        view.tab === "health" ? h(Health, { view })
            : h("div", { className: "ps-webhooks__content" },
                h("div", { className: "ps-webhooks__list", "aria-label": `${view.tab} resources` },
                    view.rows.map(row => button(`${row.title} · ${row.stateLabel}`, () => controller.selectWebhookResource(row.rowId), locked || view.loading,
                        { key: row.rowId, className: "ps-mini-button ps-webhooks__row", "aria-pressed": row.selected })),
                    !view.rows.length && view.loaded && !view.loading && !view.loadError ? note("No visible resources match this view.") : null),
                h("div", { className: "ps-webhooks__detail" },
                    view.connectorDelivery ? h("section", { "aria-label": "Connector delivery address" },
                        h("div", { className: "ps-webhooks__bar" },
                            h("strong", null, view.connectorDelivery.label),
                            button(view.connectorDelivery.relative ? "Copy relative path" : "Copy delivery URL",
                                () => controller.copyWebhookConnectorUrl(writeClipboardText), !view.canCopyConnector || locked)),
                        h("pre", null, webhookText(view.connectorDelivery.url)),
                        note(`${view.connectorDelivery.relative ? "No public origin supplied. " : ""}Public connector ID, not a capability; provider authentication is still required. No request is sent.`),
                        view.copyStatus ? h("p", { role: "status" }, view.copyStatus) : null) : null,
                    view.tab === "receipts" ? h(ReceiptDetail, { controller, view })
                        : h("pre", null, view.detailLines.join("\n")))),
        view.editor ? h(WebhookDialog, { title: view.editor.title, close: () => controller.closeWebhookDialog() },
            h(WebhookEditorForm, { controller, view })) : null,
        view.capabilityId ? h(WebhookCapabilityDialog, { controller, view, copyCapability }) : null);
}

export function AdminWebhooksSection({ controller }) {
    const view = useControllerSelector(controller, selectWebhookConsole);
    React.useEffect(() => () => controller.closeWebhookDialog(), [controller]);
    return h(WebhookPanel, { controller, view });
}
