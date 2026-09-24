import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { validateSignalName } from "./session-signals.js";
import {
    WEBHOOK_CONTRACT_VERSION, WebhookError,
    type WebhookViewer, type CreateSignalEndpointOptions, type CreatedSignalEndpoint, type SignalEndpoint,
    type WebhookConnector, type CreateWebhookConnectorInput, type UpdateWebhookConnectorInput,
    type WebhookBinding, type CreateWebhookBindingInput, type UpdateWebhookBindingInput,
    type WebhookSessionTemplate, type CreateWebhookSessionTemplateInput, type UpdateWebhookSessionTemplateInput,
    type WebhookReceipt, type WebhookReceiptQuery, type WebhookMetrics, type WebhookBindingTest,
    type WebhookEvent, type WebhookSignalDisposition, type WebhookRouteClaim,
    type WebhookConnectorAuth, type WebhookProvider, type WebhookSourceScope,
    type WebhookRetentionPolicy, type UpdateWebhookRetentionPolicyInput, type WebhookRetentionSweep,
} from "./webhook-types.js";
import {
    webhookObject, webhookText, webhookInteger, webhookRevision, webhookRate, webhookSecretRef, webhookHash,
    webhookInvalid, validateWebhookAuth, validateWebhookScope, validateWebhookFilter, validateWebhookAction,
    validateWebhookPrompt, validateWebhookTemplateConfig, validateNormalizedWebhookEvent,
} from "./webhook-validation.js";

type ResourceKind = "connector" | "binding" | "template";
export interface WebhookIngressConfig {
    id: string;
    revision?: number;
    provider?: WebhookProvider;
    source?: WebhookSourceScope;
    auth?: WebhookConnectorAuth;
    hmacSecretRef?: string;
}
const STATUS_CODES: Record<string, number> = {
    WEBHOOK_FORBIDDEN: 403, WEBHOOK_NOT_FOUND: 404, WEBHOOK_CONFLICT: 409, WEBHOOK_DISABLED: 409,
    WEBHOOK_EXPIRED: 410, WEBHOOK_TARGET_TERMINAL: 410, WEBHOOK_LIMIT: 429, WEBHOOK_LEASE_LOST: 409,
    WEBHOOK_PAYLOAD_UNAVAILABLE: 409, WEBHOOK_CONFIRMATION_REQUIRED: 400,
    WEBHOOK_REPLAY_EXPIRED: 410,
};
/** @internal Owned by the CMS provider; feature surfaces must use the management client. */
export class WebhookStore {
    private readonly schema: string;
    private retentionTimer?: ReturnType<typeof setTimeout>;
    private retentionRun?: Promise<void>;
    private retentionStopped = true;
    constructor(private readonly pool: Pool, schema: string) { this.schema = `"${schema.replace(/"/g, '""')}"`; }

    /** CMS-owned maintenance also runs when public ingress is disabled. */
    startRetention(): void {
        if (!this.retentionStopped) return;
        this.retentionStopped = false;
        const schedule = (delayMs: number) => {
            if (this.retentionStopped) return;
            this.retentionTimer = setTimeout(() => {
                this.retentionRun = run().finally(() => { this.retentionRun = undefined; });
            }, delayMs);
            this.retentionTimer.unref?.();
        };
        const run = async () => {
            let delayMs = 60_000;
            try {
                const result = await this.sweepRetention();
                const next = Date.parse(result.nextSweepAt);
                if (!Number.isFinite(next)) throw new WebhookError("WEBHOOK_RETENTION_FAILED", "Invalid retention schedule.", 503);
                delayMs = Math.max(1000, Math.min(60_000, next - Date.now()));
            } catch (error) {
                console.error(`[webhooks] retention: ${error instanceof WebhookError ? error.code : "WEBHOOK_RETENTION_FAILED"}`);
            } finally { schedule(delayMs); }
        };
        schedule(0);
    }
    async stopRetention(): Promise<void> {
        this.retentionStopped = true;
        clearTimeout(this.retentionTimer);
        this.retentionTimer = undefined;
        await this.retentionRun;
    }
    sweepRetention(limit = 500): Promise<WebhookRetentionSweep> {
        return this.call("cms_webhook_retention_sweep", [webhookInteger(limit, "limit", 1, 500)]);
    }
    private async call<T>(name: string, args: unknown[] = []): Promise<T> {
        const client = await this.pool.connect().catch(() => {
            throw new WebhookError("WEBHOOK_STORAGE_UNAVAILABLE", "Webhook storage is unavailable.", 503);
        });
        try {
            await client.query("BEGIN; SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '5s'");
            const { rows } = await client.query({
                text: `SELECT ${this.schema}.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) AS result`,
                values: args, query_timeout: 12_000,
            } as any);
            await client.query("COMMIT");
            client.release();
            return rows[0]?.result as T;
        } catch (error: any) {
            client.release(error instanceof Error ? error : new Error("Webhook database operation failed"));
            const match = /^(WEBHOOK_[A-Z_]+):\s*(.*)$/s.exec(error?.message ?? "");
            if (match) throw new WebhookError(match[1], match[2], STATUS_CODES[match[1]] ?? 400);
            throw new WebhookError("WEBHOOK_STORAGE_UNAVAILABLE", "Webhook storage operation failed.", 503);
        }
    }
    private actor(viewer?: WebhookViewer): [string, string, boolean] {
        if (!viewer?.principal) throw new WebhookError("WEBHOOK_FORBIDDEN", "An authenticated webhook viewer is required.", 403);
        const scope = viewer.adminScope ?? process.env.AUTHZ_ADMIN_SCOPE ?? "unrestricted";
        if (scope !== "unrestricted" && scope !== "cluster") webhookInvalid("Invalid administrator scope.");
        return [webhookText(viewer.principal.provider, "provider", 128), webhookText(viewer.principal.subject, "subject", 256),
            viewer.isAdmin === true && scope === "unrestricted"];
    }
    private owner(value: unknown): { provider: string; subject: string } {
        const owner = webhookObject(value, ["provider", "subject", "email", "displayName"]);
        return { provider: webhookText(owner.provider, "provider"), subject: webhookText(owner.subject, "subject", 256) };
    }
    private patch(value: unknown, keys: string[]): Record<string, any> {
        const input = webhookObject(value, ["expectedRevision", "label", "state", ...keys]);
        webhookRevision(input.expectedRevision);
        if (input.label !== undefined) webhookText(input.label, "label", 256);
        if (input.state !== undefined && !["active", "disabled", "quarantined"].includes(input.state)) webhookInvalid("Invalid resource state.");
        if (Object.keys(input).length < 2) webhookInvalid("An update must change a field.");
        return input;
    }
    private mutate<T>(kind: ResourceKind, id: string, operation: string, input: unknown, viewer?: WebhookViewer): Promise<T> {
        return this.call("cms_webhook_mutate", [kind, webhookText(id, "resource ID"), operation, JSON.stringify(input), ...this.actor(viewer), viewer?.isAdmin === true]);
    }
    private list<T>(kind: ResourceKind, viewer?: WebhookViewer): Promise<T[]> {
        return this.call("cms_webhook_list", [kind, ...this.actor(viewer)]);
    }
    async createSignalEndpoint(sessionId: string, signalName: string, options: CreateSignalEndpointOptions = {}, viewer?: WebhookViewer, publicOrigin?: string): Promise<CreatedSignalEndpoint> {
        webhookText(sessionId, "sessionId");
        validateSignalName(signalName);
        const input = webhookObject(options, ["label", "expiresAt", "maxUses", "wake", "hmacSecretRef", "rateLimitPerMinute"]);
        if (input.label !== undefined) webhookText(input.label, "label", 256);
        if (input.maxUses !== undefined) webhookInteger(input.maxUses, "maxUses", 1, 1000000);
        if (input.wake !== undefined && typeof input.wake !== "boolean") webhookInvalid("wake must be boolean.");
        if (input.hmacSecretRef !== undefined) webhookSecretRef(input.hmacSecretRef);
        if (input.expiresAt !== undefined && (typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt)))) webhookInvalid("Invalid expiry timestamp.");
        const origin = publicOrigin ? validateWebhookPublicOrigin(publicOrigin) : "";
        const token = `pswh_${randomBytes(32).toString("base64url")}`;
        const result = await this.call<SignalEndpoint>("cms_webhook_endpoint", ["create", `sgep_${randomUUID()}`, JSON.stringify({
            ...input, sessionId, signalName, tokenHash: webhookHash(token), rateLimitPerMinute: webhookRate(input.rateLimitPerMinute),
        }), ...this.actor(viewer), viewer?.isAdmin === true]);
        return { ...result, token, url: `${origin}/hooks/s/${token}` };
    }
    listSignalEndpoints(sessionId: string, viewer?: WebhookViewer): Promise<SignalEndpoint[]> {
        return this.call("cms_webhook_endpoints", [webhookText(sessionId, "sessionId"), ...this.actor(viewer)]);
    }
    revokeSignalEndpoint(endpointId: string, viewer?: WebhookViewer): Promise<SignalEndpoint> {
        return this.call("cms_webhook_endpoint", ["revoke", webhookText(endpointId, "endpointId"), "{}", ...this.actor(viewer), viewer?.isAdmin === true]);
    }
    createWebhookConnector(value: CreateWebhookConnectorInput, viewer?: WebhookViewer): Promise<WebhookConnector> {
        const input = webhookObject(value, ["label", "provider", "source", "auth", "owner", "rateLimitPerMinute"]);
        if (!["github", "azure-devops"].includes(input.provider)) webhookInvalid("Unsupported webhook provider.");
        const spec = { label: webhookText(input.label, "label", 256), provider: input.provider,
            source: validateWebhookScope(input.source, input.provider), auth: validateWebhookAuth(input.auth, input.provider),
            rateLimitPerMinute: webhookRate(input.rateLimitPerMinute), ...(input.owner !== undefined ? { owner: this.owner(input.owner) } : {}) };
        return this.mutate("connector", `whc_${randomUUID()}`, "create", spec, viewer);
    }
    listWebhookConnectors(viewer?: WebhookViewer): Promise<WebhookConnector[]> { return this.list("connector", viewer); }
    updateWebhookConnector(id: string, value: UpdateWebhookConnectorInput, viewer?: WebhookViewer): Promise<WebhookConnector> {
        const input = this.patch(value, ["auth", "rateLimitPerMinute"]);
        if (input.auth !== undefined) validateWebhookAuth(input.auth);
        if (input.rateLimitPerMinute !== undefined) webhookRate(input.rateLimitPerMinute);
        return this.mutate("connector", id, "update", input, viewer);
    }
    revokeWebhookConnector(id: string, viewer?: WebhookViewer): Promise<WebhookConnector> { return this.mutate("connector", id, "revoke", {}, viewer); }
    createWebhookBinding(value: CreateWebhookBindingInput, viewer?: WebhookViewer): Promise<WebhookBinding> {
        const input = webhookObject(value, ["label", "connectorId", "filters", "action", "rateLimitPerMinute"]);
        return this.mutate("binding", `whb_${randomUUID()}`, "create", {
            label: webhookText(input.label, "label", 256), connectorId: webhookText(input.connectorId, "connectorId"),
            filters: validateWebhookFilter(input.filters), action: validateWebhookAction(input.action), rateLimitPerMinute: webhookRate(input.rateLimitPerMinute),
        }, viewer);
    }
    listWebhookBindings(viewer?: WebhookViewer): Promise<WebhookBinding[]> { return this.list("binding", viewer); }
    updateWebhookBinding(id: string, value: UpdateWebhookBindingInput, viewer?: WebhookViewer): Promise<WebhookBinding> {
        const input = this.patch(value, ["filters", "action", "rateLimitPerMinute"]);
        if (input.filters !== undefined) validateWebhookFilter(input.filters);
        if (input.action !== undefined) validateWebhookAction(input.action);
        if (input.rateLimitPerMinute !== undefined) webhookRate(input.rateLimitPerMinute);
        return this.mutate("binding", id, "update", input, viewer);
    }
    revokeWebhookBinding(id: string, viewer?: WebhookViewer): Promise<WebhookBinding> { return this.mutate("binding", id, "revoke", {}, viewer); }
    createWebhookSessionTemplate(value: CreateWebhookSessionTemplateInput, viewer?: WebhookViewer): Promise<WebhookSessionTemplate> {
        const input = webhookObject(value, ["label", "owner", "source", "config", "prompt"]);
        return this.mutate("template", `wht_${randomUUID()}`, "create", {
            label: webhookText(input.label, "label", 256), source: validateWebhookScope(input.source),
            config: validateWebhookTemplateConfig(input.config), prompt: validateWebhookPrompt(input.prompt),
            ...(input.owner !== undefined ? { owner: this.owner(input.owner) } : {}),
        }, viewer);
    }
    listWebhookSessionTemplates(viewer?: WebhookViewer): Promise<WebhookSessionTemplate[]> { return this.list("template", viewer); }
    updateWebhookSessionTemplate(id: string, value: UpdateWebhookSessionTemplateInput, viewer?: WebhookViewer): Promise<WebhookSessionTemplate> {
        const input = this.patch(value, ["config", "prompt"]);
        if (input.config !== undefined) validateWebhookTemplateConfig(input.config);
        if (input.prompt !== undefined) validateWebhookPrompt(input.prompt);
        return this.mutate("template", id, "update", input, viewer);
    }
    revokeWebhookSessionTemplate(id: string, viewer?: WebhookViewer): Promise<WebhookSessionTemplate> { return this.mutate("template", id, "revoke", {}, viewer); }
    testWebhookBinding(id: string, input: { event: WebhookEvent }, viewer?: WebhookViewer): Promise<WebhookBindingTest> {
        webhookObject(input, ["event"]);
        return this.call("cms_webhook_test", [webhookText(id, "bindingId"), JSON.stringify(validateNormalizedWebhookEvent(input.event)), ...this.actor(viewer)]);
    }
    listWebhookReceipts(value: WebhookReceiptQuery = {}, viewer?: WebhookViewer): Promise<WebhookReceipt[]> {
        const input = webhookObject(value, ["connectorId", "endpointId", "sessionId", "status", "limit", "before"]);
        for (const key of ["connectorId", "endpointId", "sessionId", "status", "before"]) if (input[key] !== undefined) webhookText(input[key], key);
        if (input.limit !== undefined) webhookInteger(input.limit, "limit", 1, 100);
        return this.call("cms_webhook_receipts", [null, JSON.stringify(input), ...this.actor(viewer)]);
    }
    getWebhookReceipt(receiptId: string, viewer?: WebhookViewer): Promise<WebhookReceipt> {
        return this.call("cms_webhook_receipts", [webhookText(receiptId, "receiptId"), "{}", ...this.actor(viewer)]);
    }
    replayWebhookReceipt(receiptId: string, input: { confirmed: true }, viewer?: WebhookViewer): Promise<WebhookReceipt> {
        webhookObject(input, ["confirmed"]);
        if (input.confirmed !== true) throw new WebhookError("WEBHOOK_CONFIRMATION_REQUIRED", "Receipt replay must be explicitly confirmed.");
        return this.call("cms_webhook_replay", [webhookText(receiptId, "receiptId"), true, ...this.actor(viewer)]);
    }
    getWebhookMetrics(viewer?: WebhookViewer): Promise<WebhookMetrics> { return this.call("cms_webhook_metrics", this.actor(viewer)); }
    updateWebhookRetentionPolicy(value: UpdateWebhookRetentionPolicyInput, viewer?: WebhookViewer): Promise<WebhookRetentionPolicy> {
        const input = webhookObject(value, ["expectedRevision", "receiptRetentionDays", "replayRetentionDays"]);
        webhookRevision(input.expectedRevision);
        const receiptDays = webhookInteger(input.receiptRetentionDays, "receiptRetentionDays", 1, 3650);
        webhookInteger(input.replayRetentionDays, "replayRetentionDays", 1, receiptDays);
        const [provider, subject] = this.actor(viewer);
        return this.call("cms_webhook_retention_update", [JSON.stringify(input), provider, subject, viewer?.isAdmin === true]);
    }
    preflight(peerHash: string): Promise<boolean> { return this.call("cms_webhook_preflight", [peerHash]); }
    originRate(origin: string): Promise<boolean> { return this.call("cms_webhook_origin_rate", [origin]); }
    ingressConfig(kind: "endpoint" | "connector", key: string): Promise<WebhookIngressConfig> {
        return this.call("cms_webhook_ingress_config", [kind, key]);
    }
    ingressFailure(origin: string, outcome: "rejected" | "rate_limited" | "disabled" | "expired"): Promise<void> {
        return this.call("cms_webhook_ingress_failure", [origin, outcome]);
    }
    accept(kind: "endpoint" | "connector", origin: string, revision: number | undefined, deliveryId: string, payloadHash: string, data: unknown,
        traceContext?: WebhookRouteClaim["traceContext"]): Promise<{ accepted: boolean; duplicate?: boolean; code?: string }> {
        return this.call("cms_webhook_accept", [kind, origin, revision ?? null, webhookText(deliveryId, "deliveryId"), payloadHash, JSON.stringify(data),
            `whd_${randomUUID()}`, JSON.stringify(traceContext ?? {})]);
    }
    claim(limit = 1): Promise<Array<{ receiptId: string; leaseToken: string }>> {
        return this.call("cms_webhook_claim", [randomUUID(), webhookInteger(limit, "limit", 1, 16), WEBHOOK_CONTRACT_VERSION]);
    }
    routeContext(receiptId: string, leaseToken: string): Promise<WebhookRouteClaim> {
        return this.call("cms_webhook_route_context", [receiptId, leaseToken]);
    }
    finish(receiptId: string, leaseToken: string, status: string, code: string | null, retry: boolean): Promise<boolean> {
        return this.call("cms_webhook_finish", [receiptId, leaseToken, status, code, retry]);
    }
    recordSignalDisposition(input: WebhookSignalDisposition): Promise<boolean> {
        return this.call("cms_webhook_signal_disposition", [input.receiptId, input.sessionId, input.signalId, input.disposition]);
    }
    /** Called only after the public client's ordinary policy/model-owner validation. */
    createSessionOnce(input: { sessionId: string; key: string; owner: { provider: string; subject: string }; agentId?: string; config: Record<string, unknown>; metadata: Record<string, unknown> }): Promise<boolean> {
        return this.call("cms_webhook_create_session_once", [input.sessionId, input.key, JSON.stringify(input.owner), input.agentId ?? null, JSON.stringify(input.config), JSON.stringify(input.metadata)]);
    }
}

export function validateWebhookPublicOrigin(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch { return webhookInvalid("Invalid webhook public origin."); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        return webhookInvalid("Webhook public origin must be an HTTPS origin without credentials, path, query or fragment.");
    }
    return url.origin;
}
