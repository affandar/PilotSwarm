// Management-form validation only. The server remains the authorization and
// delivery-policy boundary. Do not import the SDK (or execute config) in the UI.
export const WEBHOOK_EVENT_FIELDS = Object.freeze([
    "provider", "eventType", "action", "repositoryId", "repository", "projectId",
    "pullRequestNumber", "buildId", "buildDefinitionId", "ref", "status", "conclusion", "title", "url",
]);
export const WEBHOOK_RECEIPT_STATUSES = Object.freeze([
    "received", "authenticated", "normalized", "matched", "routed", "queued", "consumed",
    "rejected", "duplicate", "unmatched", "rate_limited", "disabled", "expired",
    "target_terminal", "routing_failed", "dead_lettered", "dropped",
]);
export const WEBHOOK_RESOURCE_STATES = Object.freeze(["active", "disabled", "quarantined"]);
export const WEBHOOK_AUTH_HELP = "Enter deployment-approved reference names, never secrets or model-provider tokens. References resolve through server configuration; configured does not mean verified authentication.";
export const WEBHOOK_POLICY_HELP = "Source, owner, namespace, model and target are fixed policy, never taken from event data. The server rechecks authorization on every delivery.";
export const WEBHOOK_DRY_RUN_HELP = "Persisted-policy dry run only: no delivery, session creation or signal. A match/authorization result does not guarantee current host placement, model admission or successful delivery.";
export const WEBHOOK_CAPABILITY_WARNING = "One-time bearer capability. Anyone holding this URL or token can send the configured signal. Store it securely; it will not be shown again. Closing or navigating clears this view, not screenshots, terminal scrollback or the clipboard. Revoke the endpoint to invalidate it; the session stays alive.";

export function webhookText(value) {
    // Keep dangerous markup as text. Strip terminal control sequences (including
    // OSC clipboard/title escapes) before they reach either host's text renderer.
    return String(value ?? "")
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/gu, "")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

export function parseWebhookJson(value, label, { optional = false } = {}) {
    if (!String(value ?? "").trim() && optional) return undefined;
    try {
        return JSON.parse(String(value));
    } catch {
        // Do not echo parser snippets: a user might have pasted a secret.
        throw new Error(`${label} must be valid JSON (not JavaScript).`);
    }
}

function record(value, label, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
    if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains an unsupported field. Allowed: ${keys.join(", ")}.`);
    return value;
}
function text(value, label, required = true) {
    if (typeof value !== "string" || (required && !value.trim())) throw new Error(`${label} must be ${required ? "a nonempty" : "a"} string.`);
    return value;
}
function oneOf(value, choices, label) {
    if (!choices.includes(value)) throw new Error(`${label} must be one of: ${choices.join(", ")}.`);
    return value;
}
function integer(value, label, min, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    return value;
}
function optionalBoolean(value, label) {
    if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
}
export function validateWebhookSignalName(value) {
    if (typeof value !== "string" || !/^[a-z0-9_-]{1,64}$/u.test(value)) throw new Error("Signal name must be 1–64 lowercase letters, digits, underscores or hyphens.");
    return value;
}
export function validateWebhookReference(value, label = "Secret reference") {
    if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) throw new Error(`${label} must match [A-Z][A-Z0-9_]{0,63}. Do not paste a secret.`);
    return value;
}
export function validateWebhookSource(value) {
    record(value, "Source", ["repositoryId", "projectId", "buildDefinitionId"]);
    text(value.repositoryId, "Source repositoryId");
    for (const key of ["projectId", "buildDefinitionId"]) if (value[key] !== undefined) text(value[key], `Source ${key}`);
    return value;
}
export function validateWebhookOwner(value) {
    if (value === undefined) return undefined;
    record(value, "Owner", ["provider", "subject"]);
    text(value.provider, "Owner provider"); text(value.subject, "Owner subject");
    return value;
}
export function validateWebhookAuth(value, provider) {
    if (provider === "github") {
        record(value, "Authentication references", ["mode", "secretRef"]);
        oneOf(value.mode, ["github-hmac-sha256"], "Authentication mode");
        validateWebhookReference(value.secretRef);
    } else {
        record(value, "Authentication references", ["mode", "usernameRef", "passwordRef"]);
        oneOf(value.mode, ["ado-basic"], "Authentication mode");
        validateWebhookReference(value.usernameRef, "Username reference");
        validateWebhookReference(value.passwordRef, "Password reference");
    }
    return value;
}
export function validateWebhookFilters(value) {
    record(value, "Filters", WEBHOOK_EVENT_FIELDS);
    for (const match of Object.values(value)) {
        const choices = Array.isArray(match) ? match : [match];
        if (!choices.length || choices.some(choice => typeof choice !== "string" && !(typeof choice === "number" && Number.isFinite(choice)))) {
            throw new Error("Filters support equality or nonempty inclusion arrays of strings/numbers only; no operators or JSONPath.");
        }
    }
    return value;
}
export function validateWebhookPrompt(value) {
    record(value, "Prompt", ["instruction", "fields"]);
    text(value.instruction, "Prompt instruction");
    if (!Array.isArray(value.fields) || value.fields.some(field => !WEBHOOK_EVENT_FIELDS.includes(field))) {
        throw new Error(`Prompt fields must be an array from: ${WEBHOOK_EVENT_FIELDS.join(", ")}.`);
    }
    return value;
}
export function validateWebhookAction(value, coalesced = false) {
    const types = coalesced ? ["noop", "raise_signal", "enqueue_prompt"] : ["create_session", "raise_signal", "enqueue_prompt"];
    oneOf(value?.type, types, coalesced ? "Coalescing onMatch type" : "Action type");
    const keys = value.type === "create_session" ? ["type", "templateId", "coalescing"]
        : value.type === "raise_signal" ? ["type", "signalName", "wake", ...(!coalesced ? ["sessionId"] : [])]
            : value.type === "enqueue_prompt" ? ["type", "prompt", ...(!coalesced ? ["sessionId"] : [])] : ["type"];
    record(value, coalesced ? "Coalescing onMatch" : "Action", keys);
    if (value.type === "create_session") {
        text(value.templateId, "Approved template ID");
        if (value.coalescing !== undefined) {
            record(value.coalescing, "Coalescing", ["key", "onMatch"]);
            oneOf(value.coalescing.key, ["repository_pull_request"], "Coalescing key");
            validateWebhookAction(value.coalescing.onMatch, true);
        }
    } else if (value.type !== "noop") {
        if (!coalesced) text(value.sessionId, "Fixed target session ID");
        if (value.type === "raise_signal") {
            validateWebhookSignalName(value.signalName);
            optionalBoolean(value.wake, "Action wake");
        } else validateWebhookPrompt(value.prompt);
    }
    return value;
}
export function validateWebhookTemplateConfig(value) {
    record(value, "Template config", ["agentName", "namespace", "model", "reasoningEffort", "contextTier", "visibility"]);
    text(value.namespace, "Template namespace");
    for (const key of ["agentName", "model"]) if (value[key] !== undefined) text(value[key], `Template ${key}`);
    if (value.reasoningEffort !== undefined) oneOf(value.reasoningEffort, ["none", "minimal", "low", "medium", "high", "xhigh", "max"], "Reasoning effort");
    if (value.contextTier !== undefined) oneOf(value.contextTier, ["default", "long_context"], "Context tier");
    if (value.visibility !== undefined) oneOf(value.visibility, ["private", "shared_read", "shared_write"], "Visibility");
    return value;
}
export function validateWebhookEvent(value) {
    record(value, "Normalized event", ["version", ...WEBHOOK_EVENT_FIELDS]);
    if (value.version !== 1) throw new Error("Normalized event version must be 1.");
    oneOf(value.provider, ["github", "azure-devops"], "Event provider");
    oneOf(value.eventType, ["workflow.completed", "check.completed", "build.completed", "pull_request.lifecycle"], "Event type");
    oneOf(value.action, ["completed", "opened", "reopened", "closed", "synchronize", "edited", "ready_for_review",
        "converted_to_draft", "created", "updated", "merge_attempted"], "Event action");
    text(value.repositoryId, "Event repositoryId");
    for (const [key, entry] of Object.entries(value)) {
        if (key === "version") continue;
        if (key === "pullRequestNumber") integer(entry, "Pull request number", 1);
        else text(entry, `Event ${key}`);
    }
    return value;
}
export function validateWebhookReceiptQuery(value) {
    record(value, "Receipt query", ["connectorId", "endpointId", "sessionId", "status", "limit", "before"]);
    for (const key of ["connectorId", "endpointId", "sessionId", "before"]) if (value[key] !== undefined) text(value[key], key);
    if (value.status !== undefined) oneOf(value.status, WEBHOOK_RECEIPT_STATUSES, "Receipt status");
    if (value.limit !== undefined) integer(value.limit, "Page size", 1, 100);
    return value;
}

export function webhookFormInput(editor, { isAdmin = false, now = Date.now() } = {}) {
    const fields = editor.values;
    const input = {};
    const json = (key, label, optional = false) => parseWebhookJson(fields[key], label, { optional });
    const optionalText = key => {
        if (fields[key]?.trim()) input[key] = fields[key].trim();
    };
    const optionalNumber = (key, label, max = Number.MAX_SAFE_INTEGER) => {
        if (fields[key]?.trim()) input[key] = integer(Number(fields[key]), label, 1, max);
    };
    if (["connectors", "bindings", "templates"].includes(editor.kind)) {
        input.label = text(fields.label?.trim(), "Label");
        if (editor.mode === "edit") {
            input.expectedRevision = integer(editor.expectedRevision, "Selected revision", 1, 2147483647);
            input.state = oneOf(fields.state, WEBHOOK_RESOURCE_STATES, "State");
        }
        if (editor.kind !== "templates") optionalNumber("rateLimitPerMinute", "Rate limit per minute", 600);
        if (editor.mode === "create" && isAdmin && editor.kind !== "bindings") {
            const owner = validateWebhookOwner(json("owner", "Owner", true));
            if (owner !== undefined) input.owner = owner;
        }
    }
    switch (editor.kind) {
        case "connectors": {
            const provider = editor.mode === "create" ? oneOf(fields.provider, ["github", "azure-devops"], "Provider") : editor.provider;
            if (editor.mode === "create") {
                if (!isAdmin) throw new Error("Only an administrator can create connectors.");
                input.provider = provider;
                input.source = validateWebhookSource(json("source", "Source"));
                if (provider === "azure-devops" && !input.source.projectId) throw new Error("Azure DevOps source requires a projectId.");
            }
            if (isAdmin) {
                const auth = json("auth", "Authentication references", editor.mode === "edit");
                if (auth !== undefined) input.auth = validateWebhookAuth(auth, provider);
            }
            break;
        }
        case "bindings":
            if (editor.mode === "create") input.connectorId = text(fields.connectorId?.trim(), "Connector ID");
            input.filters = validateWebhookFilters(json("filters", "Filters"));
            input.action = validateWebhookAction(json("action", "Action"));
            break;
        case "templates":
            if (editor.mode === "create") {
                if (!isAdmin) throw new Error("Only an administrator can approve session templates.");
                input.source = validateWebhookSource(json("source", "Source"));
            }
            if (isAdmin) {
                input.config = validateWebhookTemplateConfig(json("config", "Template config"));
                input.prompt = validateWebhookPrompt(json("prompt", "Prompt"));
            }
            break;
        case "endpoints":
            input.signalName = validateWebhookSignalName(fields.signalName);
            optionalText("label");
            if (fields.expiresAt?.trim()) {
                const at = Date.parse(fields.expiresAt);
                if (!Number.isFinite(at) || at <= now || at > now + 90 * 86400_000) throw new Error("Expiry must be a future timestamp within 90 days. Leave blank for 30 days.");
                input.expiresAt = new Date(at).toISOString();
            }
            optionalNumber("maxUses", "Maximum uses");
            optionalNumber("rateLimitPerMinute", "Rate limit per minute", 600);
            input.wake = oneOf(fields.wake, ["true", "false"], "Wake session") === "true";
            if (isAdmin && fields.hmacSecretRef?.trim()) input.hmacSecretRef = validateWebhookReference(fields.hmacSecretRef.trim(), "HMAC secret reference");
            break;
        case "signal":
            input.name = validateWebhookSignalName(fields.name);
            if (fields.data?.trim()) input.data = json("data", "Signal data");
            optionalText("payloadRef"); optionalText("signalId");
            input.wake = oneOf(fields.wake, ["true", "false"], "Wake session") === "true";
            break;
        case "test":
            input.event = validateWebhookEvent(json("event", "Normalized event"));
            break;
        case "retention":
            if (!isAdmin) throw new Error("Only an administrator can update retention policy.");
            input.expectedRevision = integer(editor.expectedRevision, "Selected revision", 1, 2147483647);
            input.receiptRetentionDays = integer(Number(fields.receiptRetentionDays), "Receipt retention days", 1, 3650);
            input.replayRetentionDays = integer(Number(fields.replayRetentionDays), "Replay retention days", 1, input.receiptRetentionDays);
            break;
        case "receipts":
            for (const key of ["connectorId", "endpointId", "sessionId", "status", "before"]) optionalText(key);
            optionalNumber("limit", "Page size", 100);
            validateWebhookReceiptQuery(input);
            break;
        case "session":
            input.sessionId = text(fields.sessionId?.trim(), "Session ID");
            break;
        default: throw new Error("Unknown webhook form.");
    }
    return input;
}
