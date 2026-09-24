import {
    WEBHOOK_AUTH_HELP, WEBHOOK_DRY_RUN_HELP, WEBHOOK_EVENT_FIELDS, WEBHOOK_POLICY_HELP,
    WEBHOOK_RECEIPT_STATUSES, WEBHOOK_RESOURCE_STATES,
} from "./webhook-validation.js";

const json = value => value === undefined ? "" : JSON.stringify(value, null, 2);
const field = (id, label, type, value, help, options) => ({ id, label, type, value: value ?? "", help, ...(options ? { options } : {}) });
const promptExample = { instruction: "Review the event using the approved agent policy.", fields: ["eventType", "repositoryId", "pullRequestNumber"] };
const filterHelp = `Equality or inclusion arrays only. Allowed fields: ${WEBHOOK_EVENT_FIELDS.join(", ")}. No JSONPath or executable expressions.`;
const actionHelp = 'Fixed action JSON: {"type":"create_session","templateId":"…"}, {"type":"raise_signal","sessionId":"…","signalName":"ready","wake":false}, or {"type":"enqueue_prompt","sessionId":"…","prompt":{"instruction":"…","fields":["title"]}}. Coalescing is opt-in on create_session: {"key":"repository_pull_request","onMatch":{"type":"noop"}} (also raise_signal or enqueue_prompt).';
const sourceHelp = "Fixed repositoryId; Azure DevOps also requires projectId. Optional buildDefinitionId is an operator-attested repository mapping, never inferred from an event.";
const rateField = value => field("rateLimitPerMinute", "Rate limit per minute", "number", String(value ?? ""), "Whole number 1–600. Blank on create uses the server default of 60.");

/** The SAME field schema drives the browser form and native field editor. */
export function createWebhookEditor(kind, mode, { resource = null, isAdmin = false, webhooks, session = null } = {}) {
    const creating = mode === "create";
    const fields = [];
    let title = `${creating ? "Create" : "Edit"} ${kind}`;
    let submitLabel = creating ? "Create" : "Save changes";
    let description = WEBHOOK_POLICY_HELP;
    const fixed = [];
    if (["connectors", "bindings", "templates"].includes(kind)) {
        fields.push(field("label", "Label", "text", resource?.label || "", "A descriptive operator label; rendered as plain text."));
        if (!creating) {
            fixed.push(`Resource ID: ${resource.id}`, `Expected revision: ${resource.revision} (captured when this edit opened)`);
            fields.push(field("state", "State", "choice", resource.state, "Revocation is a separate confirmed action. Quarantined resources do not deliver.", WEBHOOK_RESOURCE_STATES));
        }
    }
    if (kind === "connectors") {
        title = creating ? "Create webhook connector" : "Edit webhook connector";
        if (creating) {
            fields.push(field("provider", "Webhook provider", "choice", "github", "Provider authentication is separate from model-provider credentials.", ["github", "azure-devops"]),
                field("source", "Fixed source (JSON)", "json", json({ repositoryId: "" }), sourceHelp));
        } else fixed.push(`Provider: ${resource.provider}`, `Fixed source: ${json(resource.source)}`);
        if (isAdmin) fields.push(field("auth", "Authentication references (JSON)", "json",
            creating ? json({ mode: "github-hmac-sha256", secretRef: "GITHUB_WEBHOOK" }) : "",
            `${WEBHOOK_AUTH_HELP} ${creating ? 'GitHub: {"mode":"github-hmac-sha256","secretRef":"REFERENCE"}. ADO: {"mode":"ado-basic","usernameRef":"REFERENCE","passwordRef":"REFERENCE"}.' : "Blank leaves current references unchanged; reads never return them."}`));
        fields.push(rateField(resource?.rateLimitPerMinute));
        description = `${WEBHOOK_AUTH_HELP} ${WEBHOOK_POLICY_HELP}`;
    } else if (kind === "bindings") {
        title = creating ? "Create trusted binding" : "Edit trusted binding";
        if (creating) fields.push(field("connectorId", "Connector ID", "text", webhooks?.connectors.rows[0]?.id || "", "Use a connector visible to you. Its source cannot be overridden by this binding."));
        else fixed.push(`Fixed connector ID: ${resource.connectorId}`);
        fields.push(
            field("filters", "Event filters (JSON)", "json", json(resource?.filters || {}), filterHelp),
            field("action", "Fixed action (JSON)", "json", json(resource?.action || { type: "create_session", templateId: webhooks?.templates.rows[0]?.id || "" }), actionHelp),
            rateField(resource?.rateLimitPerMinute),
        );
        description = `${WEBHOOK_POLICY_HELP} Coalescing is OFF unless explicitly configured.`;
    } else if (kind === "templates") {
        title = creating ? "Approve session template" : "Edit approved template";
        submitLabel = creating ? "Approve template" : isAdmin ? "Save approved policy" : "Save metadata";
        if (creating) fields.push(field("source", "Approved source (JSON)", "json", json({ repositoryId: "" }), sourceHelp));
        else fixed.push(`Approved source (immutable): ${json(resource.source)}`);
        if (isAdmin) fields.push(
            field("config", "Approved session config (JSON)", "json", json(resource?.config || { namespace: "app" }),
                "namespace is required. Optional agentName, model, reasoningEffort, contextTier and visibility are fixed policy. No tools, credentials, file paths or event-supplied model/owner."),
            field("prompt", "Approved prompt (JSON)", "json", json(resource?.prompt || promptExample),
                `instruction is trusted operator text; fields is an allowlisted array: ${WEBHOOK_EVENT_FIELDS.join(", ")}. Event values are passed separately as untrusted data.`),
        );
        description = `${WEBHOOK_POLICY_HELP} Only administrators approve or change config/prompt; owners can change label/state.`;
    } else if (kind === "endpoints") {
        title = "Mint session signal endpoint";
        submitLabel = "Mint one-time capability";
        description = "The returned URL/token is a bearer capability, shown only once. Anyone holding it can send this signal. Nothing is sent or tested automatically.";
        fields.push(
            field("signalName", "Signal name", "text", webhooks?.signalState.data?.pendingWait?.names?.[0] || session?.signalWait?.names?.[0] || "", "1–64 lowercase letters, digits, underscores or hyphens. Fixed for this endpoint."),
            field("label", "Endpoint label", "text", "", "Optional description."),
            field("expiresAt", "Expiry (ISO timestamp)", "text", "", "Blank defaults to 30 days. Maximum lifetime 90 days."),
            field("maxUses", "Maximum uses", "number", "", "Optional positive whole number. Blank leaves the endpoint uncapped by uses until expiry/revocation."),
            field("wake", "Wake session", "choice", "false", "Explicit wake policy, fixed for this endpoint.", ["false", "true"]),
            rateField(),
        );
        if (isAdmin) fields.push(field("hmacSecretRef", "HMAC secret reference", "text", "", `Optional, administrator only. ${WEBHOOK_AUTH_HELP}`));
    } else if (kind === "signal") {
        title = "Raise signal manually"; submitLabel = "Raise signal";
        description = "Queue a signal for this fixed session. Acceptance/queueing is not consumption. JSON data and payload references are inert; this UI never opens them.";
        fields.push(
            field("name", "Signal name", "text", webhooks?.signalState.data?.pendingWait?.names?.[0] || session?.signalWait?.names?.[0] || "", "1–64 lowercase letters, digits, underscores or hyphens."),
            field("data", "Signal data (JSON)", "json", "", "Optional JSON value, never executed or used to set privileged source/target policy."),
            field("payloadRef", "Payload reference", "text", "", "Optional opaque reference. Never fetched or auto-opened."),
            field("signalId", "Signal ID", "text", "", "Optional explicit deduplication identity; blank lets the server assign it."),
            field("wake", "Wake session", "choice", "false", "Whether this queued signal should wake the session.", ["false", "true"]),
        );
    } else if (kind === "test") {
        title = "Dry-run trusted binding"; submitLabel = "Run policy check"; description = WEBHOOK_DRY_RUN_HELP;
        const connector = webhooks?.connectors.rows.find(row => row.id === resource?.connectorId);
        fixed.push(`Binding ID: ${resource?.id}`);
        fields.push(field("event", "Normalized event (JSON)", "json", json({
            version: 1, provider: connector?.provider || "github", eventType: "pull_request.lifecycle", action: "opened",
            repositoryId: connector?.source?.repositoryId || "", ...(connector?.source?.projectId ? { projectId: connector.source.projectId } : {}),
            pullRequestNumber: 1,
        }), "Use a normalized event, not a raw provider body. No external request is sent. URLs remain plain text."));
    } else if (kind === "retention") {
        title = "Edit webhook retention"; submitLabel = "Save retention policy";
        description = "Applies to future terminal dispositions. Existing replay deadlines are never extended. Cleanup preserves active work and delivery/creation deduplication identities; it runs even when ingress is disabled.";
        fixed.push(`Expected revision: ${resource.revision}`);
        fields.push(
            field("receiptRetentionDays", "Terminal receipt history (days)", "number", String(resource.receiptRetentionDays), "Whole number 1-3650. Default 30 days after a terminal disposition."),
            field("replayRetentionDays", "Replay window (days)", "number", String(resource.replayRetentionDays), "Whole number 1 through the receipt retention period. Default 30 days from the first replayable terminal failure."),
        );
    } else if (kind === "receipts") {
        title = "Filter receipts"; submitLabel = "Apply filters"; description = "Server-scoped metadata only. Newest first, with an exclusive opaque receipt-ID cursor.";
        const query = webhooks?.receipts.query || {};
        for (const [key, label] of [["connectorId", "Connector ID"], ["endpointId", "Endpoint ID"], ["sessionId", "Session ID"]]) {
            fields.push(field(key, label, "text", query[key] || "", "Optional exact match."));
        }
        fields.push(
            field("status", "Receipt status", "choice", query.status || "", "Blank includes every status; queued and consumed are distinct.", ["", ...WEBHOOK_RECEIPT_STATUSES]),
            field("limit", "Page size", "number", String(query.limit || 25), "Whole number 1–100."),
            field("before", "Before receipt cursor", "text", "", "Optional exclusive cursor. Usually use the Older/Newer page buttons."),
        );
    } else if (kind === "session") {
        title = "Select signal-management session"; submitLabel = "Select session";
        description = "Choose an ordinary session visible to you, or enter an exact authorized session ID. System/service sessions are not webhook targets; the server enforces all grants.";
        fields.push(field("sessionId", "Session ID", "text", webhooks?.sessionId || session?.sessionId || "", "Selecting here does not send a signal or navigate away from Settings."));
    }
    if (creating && isAdmin && ["connectors", "templates"].includes(kind)) {
        fields.push(field("owner", "Owner assignment (JSON)", "json", "", 'Administrator only; blank defaults to the authenticated creator. Optional {"provider":"…","subject":"…"}. Never taken from event data.'));
    }
    if (kind === "endpoints" || kind === "signal") fixed.push(`Fixed target session: ${webhooks?.sessionId}`);
    return {
        kind, mode, resourceId: resource?.id || null, provider: resource?.provider,
        expectedRevision: resource?.revision, sessionId: webhooks?.sessionId,
        title, submitLabel, description, fixed, fields: fields.map(({ value, ...meta }) => meta),
        values: Object.fromEntries(fields.map(entry => [entry.id, entry.value])),
        fieldIndex: 0, cursorIndex: fields[0]?.value.length || 0, stale: false, error: null,
    };
}
