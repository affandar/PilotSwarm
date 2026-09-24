import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { trace, metrics, isSpanContextValid, SpanStatusCode, type SpanContext } from "@opentelemetry/api";
import type { JsonValue } from "./session-signals.js";
import { WebhookStore, validateWebhookPublicOrigin } from "./webhook-store.js";
import {
    WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_GENERIC_BYTES, WebhookError,
    type WebhookAcceptance, type WebhookIngressRequest, type WebhookRuntimeOptions,
    type WebhookRouteClaim, type WebhookBindingAction, type WebhookCoalescingAction,
} from "./webhook-types.js";
import {
    authenticateWebhook, defaultWebhookSecretResolver, normalizeProviderWebhook, parseWebhookBody,
    renderWebhookPrompt, requireWebhookTransport, verifyWebhookHmac, webhookHash, webhookHeader, webhookInteger, webhookSecretRef,
} from "./webhook-validation.js";

function errorCode(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : "WEBHOOK_ROUTING_FAILED";
}
const tracer = trace.getTracer("pilotswarm.webhooks");
const meter = metrics.getMeter("pilotswarm.webhooks");
const ingressCount = meter.createCounter("pilotswarm.webhook.ingress");
const ingressDuration = meter.createHistogram("pilotswarm.webhook.ingress.duration", { unit: "ms" });
const routeCount = meter.createCounter("pilotswarm.webhook.routing");
const routeDuration = meter.createHistogram("pilotswarm.webhook.routing.duration", { unit: "ms" });
/** Trusted-process ingress and bounded outbox pump. Not an orchestration or an HTTP server. */
export class WebhookRuntime {
    private controller?: AbortController;
    private loop?: Promise<void>;
    private loopError?: unknown;
    private readonly resolveSecret;
    constructor(private readonly store: WebhookStore, private readonly options: WebhookRuntimeOptions) {
        if (options.publicOrigin) validateWebhookPublicOrigin(options.publicOrigin);
        const resolve = options.secretResolver ?? defaultWebhookSecretResolver;
        this.resolveSecret = async (reference: string): Promise<string> => {
            const secret = await resolve(webhookSecretRef(reference));
            if (typeof secret !== "string" || !secret || Buffer.byteLength(secret) > 8192) {
                throw new WebhookError("WEBHOOK_SECRET_UNAVAILABLE", "Webhook credential is not configured correctly.", 503);
            }
            return secret;
        };
    }
    acceptSignalEndpoint(token: string, request: WebhookIngressRequest): Promise<WebhookAcceptance> {
        return this.accept("endpoint", token, request);
    }
    acceptConnector(connectorId: string, request: WebhookIngressRequest): Promise<WebhookAcceptance> {
        return this.accept("connector", connectorId, request);
    }
    private async accept(kind: "endpoint" | "connector", key: string, request: WebhookIngressRequest): Promise<WebhookAcceptance> {
        const span = tracer.startSpan("webhook.accept", { attributes: { "webhook.origin_kind": kind } });
        const startedAt = Date.now();
        let outcome = "accepted";
        try {
            const spanContext = span.spanContext();
            return await this.acceptDelivery(kind, key, request, isSpanContextValid(spanContext) ? {
                traceId: spanContext.traceId, spanId: spanContext.spanId, traceFlags: spanContext.traceFlags,
            } : undefined);
        } catch (error) {
            outcome = errorCode(error) === "WEBHOOK_RATE_LIMITED" ? "rate_limited" : "rejected";
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute("error.type", errorCode(error));
            throw error;
        } finally {
            ingressCount.add(1, { origin_kind: kind, outcome });
            ingressDuration.record(Math.max(0, Date.now() - startedAt), { origin_kind: kind, outcome });
            span.end();
        }
    }
    private async acceptDelivery(kind: "endpoint" | "connector", key: string, request: WebhookIngressRequest,
        traceContext?: WebhookRouteClaim["traceContext"]): Promise<WebhookAcceptance> {
        let origin: string | undefined;
        try {
            requireWebhookTransport(request, this.options.allowLoopbackHttp);
            if (!await this.store.preflight(webhookHash(request.peerAddress.replace(/^::ffff:/i, "").toLowerCase()))) {
                throw new WebhookError("WEBHOOK_RATE_LIMITED", "Webhook ingress rate limit exceeded.", 429);
            }
            if (kind === "endpoint" && !/^pswh_[A-Za-z0-9_-]{43}$/.test(key)
                || kind === "connector" && !/^whc_[a-zA-Z0-9-]{36}$/.test(key)) {
                throw new WebhookError("WEBHOOK_NOT_FOUND", kind === "endpoint" ? "Endpoint not found" : "Connector not found", 404);
            }
            const limit = kind === "endpoint" ? WEBHOOK_MAX_GENERIC_BYTES : WEBHOOK_MAX_BODY_BYTES;
            if (!(request.rawBody instanceof Uint8Array) || request.rawBody.byteLength > limit) {
                throw new WebhookError("WEBHOOK_TOO_LARGE", `Webhook body exceeds ${limit} bytes.`, 413);
            }
            const config = await this.store.ingressConfig(kind, kind === "endpoint" ? webhookHash(key) : key);
            origin = config.id;
            if (!await this.store.originRate(origin)) {
                throw new WebhookError("WEBHOOK_RATE_LIMITED", "Webhook endpoint rate limit exceeded.", 429);
            }
            if (kind === "connector") {
                if (!config.auth || !config.provider) throw new WebhookError("WEBHOOK_CONFIG_INVALID", "Connector configuration is incomplete.", 503);
                await authenticateWebhook(config.auth, request, this.resolveSecret);
            } else if (config.hmacSecretRef) {
                if (!verifyWebhookHmac(request.rawBody, webhookHeader(request, "x-signature-256"), await this.resolveSecret(config.hmacSecretRef))) {
                    throw new WebhookError("WEBHOOK_AUTH_FAILED", "Invalid authentication.", 401);
                }
            }
            const parsed = parseWebhookBody(request, kind === "endpoint");
            const delivery = kind === "connector"
                ? normalizeProviderWebhook(config.provider!, parsed, request, config.source)
                : { deliveryId: webhookHeader(request, "idempotency-key") ?? randomUUID(), event: parsed };
            const accepted = await this.store.accept(kind, config.id, config.revision, delivery.deliveryId, webhookHash(request.rawBody), delivery.event, traceContext);
            if (!accepted.accepted) {
                const code = accepted.code ?? "WEBHOOK_REJECTED";
                throw new WebhookError(code, "Webhook delivery was not accepted.",
                    code === "WEBHOOK_RATE_LIMITED" ? 429 : code === "WEBHOOK_TARGET_TERMINAL" ? 410 : code === "WEBHOOK_SOURCE_FORBIDDEN" ? 403 : 409);
            }
            return { status: 202, body: { accepted: true } };
        } catch (error) {
            // Counters contain bounded outcomes only: no token, peer, headers, body or credential.
            // Failure to persist diagnostics also fails this request, never a success-shaped reply.
            if (errorCode(error) !== "WEBHOOK_STORAGE_UNAVAILABLE") {
                await this.store.ingressFailure(origin ?? "", errorCode(error) === "WEBHOOK_RATE_LIMITED" ? "rate_limited" : "rejected");
            }
            throw error;
        }
    }
    private async authorizedContext(receiptId: string, leaseToken: string): Promise<WebhookRouteClaim> {
        const claim = await this.store.routeContext(receiptId, leaseToken);
        if (claim.template) {
            if (!this.options.authorizeTemplate) {
                throw new WebhookError("WEBHOOK_TEMPLATE_AUTH_UNAVAILABLE", "The host must provide current template/agent/namespace authorization.", 503);
            }
            if (!await this.options.authorizeTemplate(claim.template, claim.owner)) {
                throw new WebhookError("WEBHOOK_FORBIDDEN", "Template placement is no longer authorized.", 403);
            }
            // The policy callback can do I/O. Recheck persisted revocation and ownership after it.
            return this.store.routeContext(receiptId, leaseToken);
        }
        return claim;
    }
    private async route(receiptId: string, leaseToken: string): Promise<void> {
        let claim = await this.authorizedContext(receiptId, leaseToken);
        const parent = claim.traceContext;
        const link: SpanContext | undefined = parent && typeof parent.traceId === "string" && typeof parent.spanId === "string"
            && (parent.traceFlags === 0 || parent.traceFlags === 1) && isSpanContextValid(parent)
            ? { ...parent, isRemote: true } : undefined;
        const span = tracer.startSpan("webhook.route", {
            links: link ? [{ context: link }] : [],
            attributes: { "webhook.receipt_id": receiptId, "webhook.action": claim.action.type },
        });
        const startedAt = Date.now();
        let outcome = "queued";
        try {
            const action: WebhookBindingAction | WebhookCoalescingAction = claim.coalesced && claim.action.type === "create_session"
                ? claim.action.coalescing!.onMatch : claim.action;
            if (action.type === "noop") {
                await this.store.finish(receiptId, leaseToken, "routed", null, false);
                outcome = "noop";
                return;
            }
            if (action.type === "raise_signal") {
                await this.options.client._raiseSignal(claim.sessionId, action.signalName, {
                    data: (claim.event ?? claim.data) as JsonValue, signalId: claim.signalId, wake: action.wake ?? false,
                }, undefined, { kind: "webhook", receiptId, actorId: `owner:${webhookHash(JSON.stringify(claim.owner))}` });
            } else {
                if (action.type === "create_session") {
                    if (!claim.template || !claim.event) throw new WebhookError("WEBHOOK_CONFIG_INVALID", "Approved template data is missing.", 409);
                    const { agentName, namespace: _namespace, ...config } = claim.template.config;
                    const options = { ...config, owner: claim.owner, sessionId: claim.sessionId, idempotencyKey: `webhook:${receiptId}` };
                    if (agentName) await this.options.client.createSessionForAgent(agentName, options);
                    else await this.options.client.createSession(options);
                    claim = await this.authorizedContext(receiptId, leaseToken);
                }
                const prompt = action.type === "create_session" ? claim.template!.prompt : action.prompt;
                if (!claim.event) throw new WebhookError("WEBHOOK_CONFIG_INVALID", "Normalized event is missing.", 409);
                await this.options.client._enqueueWebhookPrompt(
                    claim.sessionId, renderWebhookPrompt(prompt, claim.event), `webhook:${receiptId}`, action.type === "create_session",
                );
            }
            await this.store.finish(receiptId, leaseToken, "queued", null, false);
        } catch (error) {
            outcome = "failed";
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute("error.type", errorCode(error));
            throw error;
        } finally {
            const provider = claim.event?.provider ?? "generic";
            routeCount.add(1, { provider, action: claim.action.type, outcome });
            routeDuration.record(Math.max(0, Date.now() - startedAt), { provider, action: claim.action.type, outcome });
            span.end();
        }
    }
    /** Claim one at a time so slow work never consumes another receipt's lease. */
    async runOnce(limit = 8): Promise<number> {
        webhookInteger(limit, "limit", 1, 16);
        let processed = 0;
        for (; processed < limit; processed++) {
            if (this.controller?.signal.aborted) break;
            const [claim] = await this.store.claim(1);
            if (!claim) break;
            try { await this.route(claim.receiptId, claim.leaseToken); }
            catch (error) {
                const code = errorCode(error);
                if (code === "WEBHOOK_LEASE_LOST") continue;
                const terminal: Record<string, string> = {
                    WEBHOOK_DISABLED: "disabled", WEBHOOK_EXPIRED: "expired", WEBHOOK_TARGET_TERMINAL: "target_terminal",
                    SESSION_NOT_ACTIVE: "target_terminal", WEBHOOK_FORBIDDEN: "rejected",
                    WEBHOOK_COALESCING_KEY: "dead_lettered", WEBHOOK_CONFIG_INVALID: "dead_lettered",
                    WEBHOOK_CONFLICT: "dead_lettered", WEBHOOK_PAYLOAD_UNAVAILABLE: "dead_lettered",
                };
                await this.store.finish(claim.receiptId, claim.leaseToken, terminal[code] ?? "routing_failed", code, !terminal[code]);
            }
        }
        return processed;
    }
    /** Start one owned pump. Hosts must await stop() before closing their management client. */
    start(pollIntervalMs = 1000): void {
        if (this.controller) return;
        webhookInteger(pollIntervalMs, "pollIntervalMs", 100, 60_000);
        if (!this.options.onError) throw new WebhookError("WEBHOOK_CONFIG_INVALID", "A pump error observer is required.");
        const controller = this.controller = new AbortController();
        this.loopError = undefined;
        this.loop = (async () => {
            while (!controller.signal.aborted) {
                try { await this.runOnce(); }
                catch (error) { this.options.onError!(errorCode(error)); }
                try { await delay(pollIntervalMs, undefined, { signal: controller.signal, ref: false }); }
                catch (error) { if (!controller.signal.aborted) throw error; }
            }
        })();
        this.loop.catch(error => { this.loopError = error; controller.abort(); });
    }
    async stop(): Promise<void> {
        this.controller?.abort();
        try {
            await this.loop;
            if (this.loopError) throw this.loopError;
        } finally {
            this.controller = undefined;
            this.loop = undefined;
        }
    }
}
