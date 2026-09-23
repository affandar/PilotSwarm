import { selectSessionSignalWait } from "./session-signals.js";
import { WEBHOOK_CAPABILITY_WARNING, WEBHOOK_DRY_RUN_HELP, WEBHOOK_POLICY_HELP, webhookText } from "./webhook-validation.js";

export const WEBHOOK_TABS = Object.freeze([
    { id: "connectors", label: "Connectors" },
    { id: "bindings", label: "Bindings" },
    { id: "templates", label: "Approved templates" },
    { id: "endpoints", label: "Session signals" },
    { id: "receipts", label: "Receipts" },
    { id: "health", label: "Health" },
]);
const listState = () => ({ rows: [], selectedId: null, loading: false, loaded: false, error: null, requestId: 0 });
export function createWebhookState(generation = 0) {
    return {
        generation, tab: "connectors", sessionId: null, detailOffset: 0, detailMaxOffset: null,
        ingressEnabled: null,
        publicOrigin: null,
        connectors: listState(), bindings: listState(), templates: listState(), endpoints: listState(),
        receipts: { ...listState(), query: { limit: 25 }, cursors: [], hasMore: false,
            detail: null, detailLoading: false, detailError: null, detailRequestId: 0 },
        health: { data: null, loading: false, loaded: false, error: null, requestId: 0 },
        signalState: { data: null, loading: false, loaded: false, error: null, requestId: 0 },
        editor: null, pending: null, error: null, notice: null, testResult: null,
        // The capability itself is NEVER in the store, events or selectors.
        capabilityId: null, copyStatus: null,
    };
}

export function webhookIdentityKey(state) {
    const { auth, admin } = state;
    return JSON.stringify([auth?.principal?.provider, auth?.principal?.subject, auth?.authorization,
        admin?.profile?.provider, admin?.profile?.subject, admin?.profile?.isAdmin]);
}
export function webhookViewer(state) {
    const principal = state.auth?.principal || state.admin?.profile || null;
    const profile = state.admin?.profile;
    const role = state.auth?.authorization?.role;
    const sameIdentity = !state.auth?.principal || (profile?.provider === principal.provider && profile?.subject === principal.subject);
    return {
        principal,
        // Auth disabled is not an implicit admin grant. Only the server's
        // profile flag grants the privileged controls, including local mode.
        isAdmin: sameIdentity && profile?.isAdmin === true && (!role || role === "admin" || role === "anonymous"),
    };
}
export function webhookIsOpen(state) {
    return state.admin?.visible === true && state.admin?.section === "webhooks";
}
export function webhookResourceId(kind, resource) {
    return kind === "receipts" ? resource?.receiptId : kind === "endpoints" ? resource?.endpointId : resource?.id;
}
export function webhookCanManage(state, resource) {
    const viewer = webhookViewer(state);
    return viewer.isAdmin || Boolean(viewer.principal?.provider && viewer.principal?.subject
        && viewer.principal.provider === resource?.owner?.provider && viewer.principal.subject === resource?.owner?.subject);
}

function clearTransient(webhooks) {
    const next = { ...webhooks, generation: webhooks.generation + 1, editor: null, capabilityId: null,
        copyStatus: null, pending: null, testResult: null, detailOffset: 0, detailMaxOffset: null };
    for (const name of ["connectors", "bindings", "templates", "endpoints", "receipts", "health", "signalState"]) {
        next[name] = { ...next[name], loading: false, detailLoading: false };
    }
    return next;
}

/** Reconcile even direct store navigation; hosts must not be the secret boundary. */
export function reduceWebhookUi(previous, next, action) {
    const old = previous.admin?.webhooks || createWebhookState();
    let value = next.admin?.webhooks || old;
    if (webhookIdentityKey(previous) !== webhookIdentityKey(next)) {
        value = createWebhookState(old.generation + 1);
        if (next.ui.modal?.action?.startsWith("webhook")) next = { ...next, ui: { ...next.ui, modal: null } };
    } else if (action.type === "admin/webhooks/patch") {
        if (action.generation !== undefined && action.generation !== old.generation) return next;
        value = { ...old, ...action.patch };
    } else if (action.type === "admin/webhooks/navigate") {
        value = clearTransient(old);
        value.error = null; value.notice = null;
        if (WEBHOOK_TABS.some(tab => tab.id === action.tab)) value.tab = action.tab;
        if (action.sessionId !== undefined && action.sessionId !== old.sessionId) {
            value.sessionId = action.sessionId;
            value.endpoints = listState();
            value.signalState = { data: null, loading: false, loaded: false, error: null, requestId: 0 };
        }
    } else if (action.type === "admin/webhooks/closeDialog") {
        value = clearTransient(old);
        if (old.pending) value.notice = "The request may still complete. Refresh to check its result; it will not be retried automatically.";
    } else if ((webhookIsOpen(previous) && !webhookIsOpen(next))
        || previous.sessions?.activeSessionId !== next.sessions?.activeSessionId
        || action.type === "sessions/navigationIntent"
        || action.type === "sessions/selected"
        || action.type === "admin/webhooks/dispose") {
        value = clearTransient(old);
        if (next.ui.modal?.action?.startsWith("webhook")) next = { ...next, ui: { ...next.ui, modal: null } };
    } else if (old.capabilityId && action.type === "ui/modal" && action.modal) {
        value = { ...old, capabilityId: null, copyStatus: null };
    }
    return value === next.admin?.webhooks ? next : { ...next, admin: { ...next.admin, webhooks: value } };
}

const pick = (source, keys) => Object.fromEntries(keys.filter(key => source?.[key] !== undefined).map(key => [key, source[key]]));
const principal = owner => owner ? pick(owner, ["provider", "subject"]) : null;
const prompt = value => value ? pick(value, ["instruction", "fields"]) : undefined;
const source = value => value ? pick(value, ["repositoryId", "projectId", "buildDefinitionId"]) : undefined;
function actionMetadata(value) {
    if (!value) return undefined;
    const result = pick(value, ["type", "templateId", "sessionId", "signalName", "wake"]);
    if (value.prompt) result.prompt = prompt(value.prompt);
    if (value.coalescing) result.coalescing = { key: value.coalescing.key, onMatch: actionMetadata(value.coalescing.onMatch) };
    return result;
}

/** Strict public projections: accidentally returned secrets never reach state. */
export function projectWebhookResource(kind, row) {
    if (!row || typeof row !== "object") throw new Error("The server returned invalid webhook metadata.");
    if (kind === "receipts") {
        const projected = pick(row, ["receiptId", "connectorId", "endpointId", "bindingId", "deliveryId", "status",
            "eventType", "action", "sessionId", "signalId", "attempts", "duplicateCount", "replayCount",
            "lastErrorCode", "receivedAt", "updatedAt", "nextAttemptAt"]);
        projected.timeline = (Array.isArray(row.timeline) ? row.timeline : [])
            .map(entry => pick(entry, ["status", "at", "code"]))
            .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
        return projected;
    }
    if (kind === "endpoints") return { ...pick(row, ["endpointId", "sessionId", "signalName", "label", "wake",
        "hmacConfigured", "expiresAt", "maxUses", "useCount", "revokedAt", "createdAt", "rateLimitPerMinute"]), owner: principal(row.owner) };
    const result = { ...pick(row, ["id", "label", "state", "revision", "createdAt", "updatedAt", "rateLimitPerMinute"]), owner: principal(row.owner) };
    if (kind === "connectors") Object.assign(result, { provider: row.provider, source: source(row.source),
        auth: { mode: row.auth?.mode, configured: row.auth?.configured === true } });
    if (kind === "bindings") Object.assign(result, { connectorId: row.connectorId, filters: row.filters, action: actionMetadata(row.action) });
    if (kind === "templates") Object.assign(result, { source: source(row.source), approvedBy: principal(row.approvedBy),
        config: pick(row.config, ["agentName", "namespace", "model", "reasoningEffort", "contextTier", "visibility"]), prompt: prompt(row.prompt) });
    return result;
}
export function projectWebhookMetrics(value) {
    if (!value || !Array.isArray(value.receipts)) throw new Error("The server returned invalid webhook health metadata.");
    return { ...pick(value, ["pending", "deadLettered", "oldestPendingAgeSeconds", "oldestDeadLetterAgeSeconds"]),
        receipts: value.receipts.map(row => pick(row, ["provider", "status", "count"])) };
}
export function projectWebhookSignalState(value) {
    if (!value || !Array.isArray(value.buffered)) throw new Error("The server returned invalid signal state.");
    return {
        pendingWait: value.pendingWait ? pick(value.pendingWait, ["waitId", "names", "reason", "startedAt", "deadline", "mode"]) : null,
        interrupted: value.interrupted === true,
        buffered: value.buffered.map(row => pick(row, ["signalId", "name", "raisedAt", "wake", "payloadRef", "dataBytes"])),
    };
}
export function projectWebhookTest(value) {
    if (!value || typeof value.matches !== "boolean" || typeof value.authorized !== "boolean") throw new Error("The server returned invalid dry-run metadata.");
    return pick(value, ["matches", "authorized", "authorizationScope", "action"]);
}

export function webhookReceiptMeaning(status) {
    if (status === "consumed") return "Consumed by the session";
    if (status === "queued") return "Queued durably; not yet confirmed consumed";
    if (status === "routed") return "Routing accepted; consumption is not confirmed";
    if (["received", "authenticated", "normalized", "matched"].includes(status)) return "Accepted for processing; not yet queued or consumed";
    if (status === "dead_lettered") return "Dead-lettered; inspect the error and timeline before explicit replay";
    if (status === "duplicate") return "Duplicate delivery; no additional successful consumption implied";
    if (status === "dropped") return "Dropped without consumption";
    return "No successful consumption confirmed; inspect status/error";
}
function safeJson(value) { return webhookText(JSON.stringify(value, null, 2)); }

export function selectWebhookConsole(state) {
    const value = state.admin?.webhooks || createWebhookState();
    const viewer = webhookViewer(state);
    const bucket = value[value.tab] || {};
    const rows = (bucket.rows || []).map(row => ({
        ...row,
        rowId: webhookResourceId(value.tab, row),
        selected: webhookResourceId(value.tab, row) === bucket.selectedId,
        title: webhookText(row.label || row.receiptId || row.endpointId || row.id),
        stateLabel: webhookText(row.status || row.state || (row.revokedAt ? "revoked" : Date.parse(row.expiresAt) <= Date.now() ? "expired" : "active")),
    }));
    const resource = (bucket.rows || []).find(row => webhookResourceId(value.tab, row) === bucket.selectedId) || null;
    const selected = value.tab === "receipts" && bucket.detail?.receiptId === bucket.selectedId ? bucket.detail : resource;
    const revoked = selected?.state === "revoked" || Boolean(selected?.revokedAt);
    const canManage = selected && webhookCanManage(state, selected);
    const sessionRows = Object.values(state.sessions?.byId || {})
        .filter(row => !row.isGroup && !row.isSystem && !row.isService
            && !["completed", "failed", "cancelled", "terminated"].includes(row.status))
        .map(row => ({ id: row.sessionId, label: webhookText(`${row.title || row.sessionId} · ${row.sessionId}`) }));
    const session = state.sessions?.byId?.[value.sessionId];
    const signalData = value.signalState.data;
    const wait = signalData?.pendingWait;
    const waitText = signalData
        ? (wait ? selectSessionSignalWait({ status: signalData.interrupted ? "running" : "waiting",
            signalWait: wait, signalWaitInterrupted: signalData.interrupted })?.text || "No active signal wait" : "No active signal wait")
        : selectSessionSignalWait(session)?.text || "Refresh signal state to inspect the current wait.";
    const detailLines = selected ? safeJson(selected).split("\n") : ["Select a row to inspect its redacted metadata."];
    if (value.tab === "connectors" && selected) detailLines.unshift("Authentication configured is not proof that credentials resolve or deliveries succeed.", "");
    if (value.tab === "templates") detailLines.unshift(WEBHOOK_POLICY_HELP, "");
    if (value.tab === "receipts" && selected) detailLines.unshift(webhookReceiptMeaning(selected.status), "");
    const busy = Boolean(value.pending);
    const editor = value.editor ? {
        ...value.editor,
        // Drafts are user-authored JSON/config only; saved auth refs are never
        // fetched or repopulated. Native text rendering is always plain text.
        activeField: value.editor.fields[value.editor.fieldIndex || 0],
    } : null;
    const connectorPath = value.tab === "connectors" && typeof selected?.id === "string" && selected.id
        ? `/hooks/c/${encodeURIComponent(selected.id)}` : null;
    const connectorDelivery = connectorPath ? {
        url: `${value.publicOrigin || ""}${connectorPath}`,
        relative: !value.publicOrigin,
        label: value.publicOrigin ? "Delivery URL" : "Relative delivery path",
    } : null;
    return {
        visible: webhookIsOpen(state), tab: value.tab, tabs: WEBHOOK_TABS, isAdmin: viewer.isAdmin,
        ingressEnabled: value.ingressEnabled,
        ingressText: value.ingressEnabled === true
            ? "Bootstrap reports webhook ingress enabled on this host. Authentication and delivery are not verified."
            : value.ingressEnabled === false
                ? "Bootstrap reports webhook ingress disabled on this host. Management policies can still be configured, subject to authorization."
                : "Webhook ingress status is unavailable on this connection. Management operations remain subject to server authorization.",
        scopeNote: "Only server-visible resources and bounded viewer-scoped receipt aggregates are shown. Mutations are authorized again by the server.",
        rows, selected, selectedId: bucket.selectedId, loading: bucket.loading === true,
        loaded: bucket.loaded === true, loadError: bucket.error || null,
        connectionError: state.connection?.error ? "Connection is unavailable. Refresh to check the current server state." : null,
        error: value.error, notice: value.notice, busy, pending: value.pending,
        canCreate: !busy && (["bindings"].includes(value.tab)
            || value.tab === "endpoints" && Boolean(value.sessionId)
            || ["connectors", "templates"].includes(value.tab) && viewer.isAdmin),
        canEdit: !busy && !bucket.loading && !bucket.error && canManage && !revoked && ["connectors", "bindings", "templates"].includes(value.tab),
        canRevoke: !busy && !bucket.loading && !bucket.error && canManage && !revoked && value.tab !== "receipts",
        canTest: !busy && !bucket.loading && !bucket.error && canManage && !revoked && value.tab === "bindings",
        canReplay: !busy && !bucket.loading && !bucket.detailLoading && !bucket.detailError && !bucket.error && Boolean(selected) && value.tab === "receipts",
        canRaise: !busy && Boolean(value.sessionId),
        connectorDelivery,
        canCopyConnector: Boolean(connectorDelivery) && !busy && !bucket.loading && !bucket.error && !editor && !value.capabilityId && !state.ui.modal,
        sessionId: value.sessionId, sessionRows, signalState: value.signalState, waitText: webhookText(waitText),
        detailLines, detailOffset: value.detailOffset,
        editor, capabilityId: value.capabilityId, capabilityWarning: WEBHOOK_CAPABILITY_WARNING, copyStatus: value.copyStatus,
        testResult: value.testResult, testHelp: WEBHOOK_DRY_RUN_HELP,
        receipts: value.receipts, health: value.health,
        help: editor ? "Tab/Shift+Tab field · ↑/↓ choice · Enter submit · Ctrl+J JSON newline · Esc cancel"
            : value.capabilityId ? "c copy capability URL · Ctrl+U/D scroll · Esc close and erase"
                : `${value.tab === "connectors" ? "c copy delivery URL/path · " : ""}1–6/Tab page · j/k select · n create · e edit · d revoke · t dry-run · s session · u raise · f filters · p replay · o session · v related receipts · [/] receipts · r refresh · Ctrl+U/D scroll · m providers · Esc close`,
    };
}

export function buildWebhookConsoleLines(view) {
    const line = (text, color = "white") => [{ text: webhookText(text), color }];
    const lines = [
        line(view.tabs.map((tab, index) => `${index + 1} ${tab.label}${tab.id === view.tab ? " *" : ""}`).join(" · "), "cyan"),
        line(view.ingressText, view.ingressEnabled === false ? "yellow" : "gray"),
        line(view.scopeNote, "gray"),
    ];
    if (view.loading) lines.push(line("Loading…", "yellow"));
    if (view.connectionError) lines.push(line(view.connectionError, "red"));
    if (view.loadError) lines.push(line(`Read failed: ${view.loadError}`, "red"));
    if (view.pending) lines.push(line(`Pending: ${view.pending}. No automatic retries.`, "yellow"));
    if (view.error) lines.push(line(view.error, "red"));
    if (view.notice) lines.push(line(view.notice, "green"));
    if (view.tab === "health") {
        if (view.health.data) {
            lines.push(line(`Pending: ${view.health.data.pending} · oldest ${view.health.data.oldestPendingAgeSeconds}s`));
            lines.push(line(`Dead-lettered: ${view.health.data.deadLettered} · oldest ${view.health.data.oldestDeadLetterAgeSeconds}s`, "yellow"));
            for (const row of view.health.data.receipts) lines.push(line(`${row.provider} · ${row.status}: ${row.count}`));
        } else if (!view.loading && !view.loadError) lines.push(line("No health snapshot loaded.", "gray"));
        lines.push(line("Receipt/error facts only. Configured authentication is not verified health.", "gray"));
    } else {
        if (view.tab === "endpoints") {
            lines.push(line(`Session: ${view.sessionId || "choose with s"}`, "cyan"), line(view.waitText, "yellow"));
            if (view.signalState.loading) lines.push(line("Loading signal state…", "gray"));
            if (view.signalState.error) lines.push(line(`Signal state: ${view.signalState.error}`, "red"));
            if (view.signalState.data) lines.push(line(`Buffered signals: ${view.signalState.data.buffered.length}`));
        }
        const index = Math.max(0, view.rows.findIndex(row => row.selected));
        const start = Math.max(0, index - 2);
        if (start) lines.push(line(`… ${start} earlier rows`, "gray"));
        for (const row of view.rows.slice(start, start + 6)) lines.push(line(`${row.selected ? "›" : " "} ${row.title} · ${row.stateLabel}`, row.selected ? "cyan" : "white"));
        if (view.rows.length > start + 6) lines.push(line(`… ${view.rows.length - start - 6} later rows`, "gray"));
        if (!view.rows.length && view.loaded && !view.loading && !view.loadError) lines.push(line("No visible resources match this view.", "gray"));
        if (view.connectorDelivery) {
            lines.push(line(`${view.connectorDelivery.label}: ${view.connectorDelivery.url}`, "cyan"),
                line(`${view.connectorDelivery.relative ? "No public origin supplied. " : ""}Public connector ID, not a capability; provider authentication is still required. c copies; no request is sent.`, "gray"));
            if (view.copyStatus) lines.push(line(view.copyStatus));
        }
        if (view.tab === "receipts") {
            lines.push(line(`Filter: ${JSON.stringify(view.receipts.query)}`, "gray"));
            if (view.receipts.detailLoading) lines.push(line("Loading receipt timeline…", "yellow"));
            if (view.receipts.detailError) lines.push(line(view.receipts.detailError, "red"));
        }
        if (view.testResult) lines.push(line(`Dry run: matches=${view.testResult.matches}, authorized=${view.testResult.authorized}, scope=${view.testResult.authorizationScope}`), line(view.testHelp, "yellow"));
        lines.push(line(""), ...view.detailLines.map(text => line(text)));
        if (view.tab === "endpoints" && view.signalState.data) {
            lines.push(line("Buffered signal metadata (payloads are not opened):", "cyan"),
                ...safeJson(view.signalState.data).split("\n").map(text => line(text)));
        }
    }
    return lines;
}
