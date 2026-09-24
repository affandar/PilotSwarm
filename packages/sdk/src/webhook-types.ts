import type { JsonValue } from "./session-signals.js";
import type { UserPrincipal, SessionVisibility } from "./cms.js";
import type { ReasoningEffort, ContextTier } from "./model-providers.js";
import type { PilotSwarmClient } from "./client.js";

export const WEBHOOK_CONTRACT_VERSION = 1;
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const WEBHOOK_MAX_GENERIC_BYTES = 32 * 1024;
export const WEBHOOK_MAX_BINDINGS = 16;
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_LEASE_SECONDS = 60;
export const WEBHOOK_EVENT_FIELDS = [
    "provider", "eventType", "action", "repositoryId", "repository", "projectId",
    "pullRequestNumber", "buildId", "buildDefinitionId", "ref", "status", "conclusion", "title", "url",
] as const;
export type WebhookEventField = typeof WEBHOOK_EVENT_FIELDS[number];
export type WebhookProvider = "github" | "azure-devops";
export type WebhookEventType = "workflow.completed" | "check.completed" | "build.completed" | "pull_request.lifecycle" | "ping";
export type WebhookEventAction =
    | "completed" | "opened" | "reopened" | "closed" | "synchronize" | "edited"
    | "ready_for_review" | "converted_to_draft" | "created" | "updated" | "merge_attempted" | "ping";
export type WebhookResourceState = "active" | "disabled" | "quarantined" | "revoked";
/** Resolved by a trusted host, never accepted from the management request body. */
export interface WebhookViewer {
    principal: UserPrincipal | null;
    isAdmin: boolean;
    /** Trusted host policy; cluster administrators do not inherit other owners' resources. */
    adminScope?: "unrestricted" | "cluster";
}
export interface WebhookSourceScope {
    repositoryId: string;
    projectId?: string;
    /** Operator-attested repository mapping for ADO build payload versions without repository.id. */
    buildDefinitionId?: string;
}
export interface WebhookEvent extends WebhookSourceScope {
    version: 1;
    provider: WebhookProvider;
    eventType: WebhookEventType;
    action: WebhookEventAction;
    repository?: string;
    pullRequestNumber?: number;
    buildId?: string;
    ref?: string;
    status?: string;
    conclusion?: string;
    title?: string;
    url?: string;
}
export type WebhookFilter = Partial<Record<WebhookEventField, string | number | Array<string | number>>>;
/** Variables are rendered as JSON data in a separate, untrusted-data block. */
export interface WebhookPromptTemplate { instruction: string; fields: WebhookEventField[] }
export type WebhookConnectorAuth =
    | { mode: "github-hmac-sha256"; secretRef: string }
    | { mode: "ado-basic"; usernameRef: string; passwordRef: string };
export interface CreateWebhookConnectorInput {
    label: string;
    provider: WebhookProvider;
    source: WebhookSourceScope;
    auth: WebhookConnectorAuth;
    /** Admin-only assignment; defaults to the authenticated creator. */
    owner?: UserPrincipal;
    rateLimitPerMinute?: number;
}
export interface UpdateWebhookConnectorInput {
    expectedRevision: number;
    label?: string;
    state?: Exclude<WebhookResourceState, "revoked">;
    auth?: WebhookConnectorAuth;
    rateLimitPerMinute?: number;
}
export interface WebhookResource {
    id: string;
    label: string;
    owner: UserPrincipal;
    state: WebhookResourceState;
    revision: number;
    createdAt: string;
    updatedAt: string;
}
export interface WebhookConnector extends WebhookResource {
    provider: WebhookProvider;
    source: WebhookSourceScope;
    /** Approved references are configured; this does not claim successful secret resolution or delivery. */
    auth: { mode: WebhookConnectorAuth["mode"]; configured: boolean };
    rateLimitPerMinute: number;
}
export interface CreateSignalEndpointOptions {
    label?: string;
    expiresAt?: string;
    maxUses?: number;
    wake?: boolean;
    /** Setting/changing secret references requires an administrator. */
    hmacSecretRef?: string;
    rateLimitPerMinute?: number;
}
export interface SignalEndpoint {
    endpointId: string;
    sessionId: string;
    signalName: string;
    label: string;
    owner: UserPrincipal;
    wake: boolean;
    hmacConfigured: boolean;
    expiresAt: string;
    maxUses: number | null;
    useCount: number;
    revokedAt: string | null;
    createdAt: string;
    rateLimitPerMinute: number;
}
export interface CreatedSignalEndpoint extends SignalEndpoint {
    /** High-entropy bearer capability. Returned once; endpoint storage keeps only its digest. */
    token: string;
    /** Relative unless the trusted host configured a publicOrigin. */
    url: string;
}
export type WebhookCoalescingAction =
    | { type: "noop" }
    | { type: "raise_signal"; signalName: string; wake?: boolean }
    | { type: "enqueue_prompt"; prompt: WebhookPromptTemplate };
export interface WebhookCoalescing {
    key: "repository_pull_request";
    onMatch: WebhookCoalescingAction;
}
export type WebhookBindingAction =
    | { type: "create_session"; templateId: string; coalescing?: WebhookCoalescing }
    | { type: "raise_signal"; sessionId: string; signalName: string; wake?: boolean }
    | { type: "enqueue_prompt"; sessionId: string; prompt: WebhookPromptTemplate };
export interface CreateWebhookBindingInput {
    label: string;
    connectorId: string;
    filters: WebhookFilter;
    action: WebhookBindingAction;
    rateLimitPerMinute?: number;
}
export interface UpdateWebhookBindingInput {
    expectedRevision: number;
    label?: string;
    state?: Exclude<WebhookResourceState, "revoked">;
    filters?: WebhookFilter;
    action?: WebhookBindingAction;
    rateLimitPerMinute?: number;
}
export interface WebhookBinding extends WebhookResource {
    connectorId: string;
    filters: WebhookFilter;
    action: WebhookBindingAction;
    rateLimitPerMinute: number;
}
/** No arbitrary system prompt, credentials, file paths, or tool configuration. */
export interface WebhookSessionTemplateConfig {
    agentName?: string;
    /** Package namespace for a package agent, or "app" for a deployed app agent. */
    namespace: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    contextTier?: ContextTier;
    visibility?: SessionVisibility;
}
export interface CreateWebhookSessionTemplateInput {
    label: string;
    owner?: UserPrincipal;
    source: WebhookSourceScope;
    config: WebhookSessionTemplateConfig;
    prompt: WebhookPromptTemplate;
}
export interface UpdateWebhookSessionTemplateInput {
    expectedRevision: number;
    label?: string;
    state?: Exclude<WebhookResourceState, "revoked">;
    config?: WebhookSessionTemplateConfig;
    prompt?: WebhookPromptTemplate;
}
export interface WebhookSessionTemplate extends WebhookResource {
    source: WebhookSourceScope;
    config: WebhookSessionTemplateConfig;
    prompt: WebhookPromptTemplate;
    approvedBy: UserPrincipal;
}
export type WebhookReceiptStatus =
    | "received" | "authenticated" | "normalized" | "matched" | "routed" | "queued" | "consumed"
    | "rejected" | "duplicate" | "unmatched" | "rate_limited" | "disabled" | "expired"
    | "target_terminal" | "routing_failed" | "dead_lettered" | "dropped";
export interface WebhookReceipt {
    receiptId: string;
    connectorId?: string;
    endpointId?: string;
    bindingId?: string;
    deliveryId: string;
    status: WebhookReceiptStatus;
    eventType?: string;
    action?: string;
    sessionId?: string;
    signalId?: string;
    attempts: number;
    duplicateCount: number;
    replayCount: number;
    lastErrorCode?: string;
    receivedAt: string;
    updatedAt: string;
    nextAttemptAt?: string;
    settledAt?: string;
    receiptExpiresAt?: string;
    replayExpiresAt?: string;
    payloadRetained: boolean;
    /** Retained data/status/window only. Replay still reauthorizes current policy. */
    replayAvailable: boolean;
    timeline: Array<{ status: WebhookReceiptStatus; at: string; code?: string }>;
}
export interface WebhookReceiptQuery {
    connectorId?: string;
    endpointId?: string;
    sessionId?: string;
    status?: WebhookReceiptStatus;
    limit?: number;
    /** Exclusive opaque receipt ID cursor; newest first. */
    before?: string;
}
export interface WebhookMetrics {
    receipts: Array<{ provider: WebhookProvider | "generic"; status: WebhookReceiptStatus; count: number }>;
    pending: number;
    deadLettered: number;
    oldestPendingAgeSeconds: number;
    oldestDeadLetterAgeSeconds: number;
    retention: {
        policy: WebhookRetentionPolicy;
        lastSweepAt: string | null;
        nextSweepAt: string | null;
        receiptsDeleted: number;
        payloadsDeleted: number;
    };
}
export interface WebhookRetentionPolicy {
    revision: number;
    receiptRetentionDays: number;
    replayRetentionDays: number;
    updatedAt: string;
}
export interface UpdateWebhookRetentionPolicyInput {
    expectedRevision: number;
    receiptRetentionDays: number;
    replayRetentionDays: number;
}
/** @internal Bounded maintenance result, with a database-coordinated schedule. */
export interface WebhookRetentionSweep {
    processed: number;
    receiptsDeleted: number;
    payloadsDeleted: number;
    nextSweepAt: string;
}
export interface WebhookBindingTest {
    matches: boolean;
    authorized: boolean;
    /** Dry runs do not execute the host's current placement callback or create a session. */
    authorizationScope: "persisted_policy";
    action: WebhookBindingAction["type"];
    /** Bounded normalized data, never a raw provider body. */
    event: WebhookEvent;
}
/** Implementations must resolve only deployment-approved references. Never cache credentials. */
export type WebhookSecretResolver = (reference: string) => Promise<string>;
export interface WebhookIngressRequest {
    rawBody: Uint8Array;
    headers: Readonly<Record<string, string | undefined>>;
    /** The socket peer, unless a trusted host explicitly applied its own proxy allowlist. */
    peerAddress: string;
    /** Socket TLS or a host-verified trusted TLS termination context; NOT a request header. */
    secure: boolean;
}
export interface WebhookAcceptance {
    status: 202;
    body: { accepted: true };
}
export interface WebhookRuntimeOptions {
    /** Fully configured trusted SDK client with current agent allowlist/session policy. */
    client: PilotSwarmClient;
    secretResolver?: WebhookSecretResolver;
    publicOrigin?: string;
    /** Explicit local development only, in conjunction with an actual loopback peer. */
    allowLoopbackHttp?: boolean;
    /** Revalidate deployed app-agent/source/namespace policy immediately before each route. */
    authorizeTemplate?: (template: WebhookSessionTemplate, owner: UserPrincipal) => Promise<boolean>;
    /** Required error observer if start() is used; receives bounded error codes, never bodies/secrets. */
    onError?: (code: string) => void;
}
export interface WebhookSignalDisposition {
    receiptId: string;
    sessionId: string;
    signalId: string;
    disposition: "consumed" | "dropped";
}
export class WebhookError extends Error {
    constructor(readonly code: string, message: string, readonly status = 400) {
        super(message);
        this.name = "WebhookError";
    }
}

/** @internal Never return routing data or authentication references through a management read. */
export interface WebhookRouteClaim {
    receiptId: string;
    leaseToken: string;
    owner: UserPrincipal;
    action: WebhookBindingAction;
    template?: WebhookSessionTemplate;
    event?: WebhookEvent;
    data?: JsonValue;
    sessionId: string;
    signalId: string;
    coalesced: boolean;
    traceContext?: { traceId: string; spanId: string; traceFlags: number };
}
