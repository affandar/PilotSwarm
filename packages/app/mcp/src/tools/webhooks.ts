import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LOCAL_DEFAULT_USER_PRINCIPAL, type WebhookViewer } from "pilotswarm-sdk";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { sessionIdShape } from "../session-id.js";
import { jsonResult, withToolErrors } from "../util/respond.js";

const id = z.string().min(1).max(200);
const sessionId = sessionIdShape();
const signalName = z.string().regex(/^[a-z0-9_-]{1,64}$/);
const secretRef = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).describe("Server-configured secret reference, never the secret value");
const label = z.string().min(1).max(256);
const fields = z.enum(["provider", "eventType", "action", "repositoryId", "repository", "projectId",
    "pullRequestNumber", "buildId", "buildDefinitionId", "ref", "status", "conclusion", "title", "url"]);
const prompt = z.object({ instruction: z.string().min(1).max(4096), fields: z.array(fields).max(16) }).strict();
const source = z.object({ repositoryId: id, projectId: id.optional(), buildDefinitionId: id.optional() }).strict();
const rate = z.number().int().min(1).max(600).optional();
const state = z.enum(["active", "disabled", "quarantined"]).optional();
const owner = z.object({ provider: id, subject: id }).strict().optional();
const auth = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("github-hmac-sha256"), secretRef }).strict(),
    z.object({ mode: z.literal("ado-basic"), usernameRef: secretRef, passwordRef: secretRef }).strict(),
]);
const onMatch = z.discriminatedUnion("type", [
    z.object({ type: z.literal("noop") }).strict(),
    z.object({ type: z.literal("raise_signal"), signalName, wake: z.boolean().optional() }).strict(),
    z.object({ type: z.literal("enqueue_prompt"), prompt }).strict(),
]);
const action = z.discriminatedUnion("type", [
    z.object({ type: z.literal("create_session"), templateId: id,
        coalescing: z.object({ key: z.literal("repository_pull_request"), onMatch }).strict().optional() }).strict(),
    z.object({ type: z.literal("raise_signal"), sessionId, signalName, wake: z.boolean().optional() }).strict(),
    z.object({ type: z.literal("enqueue_prompt"), sessionId, prompt }).strict(),
]);
const filterValue = z.union([z.string().max(256), z.number().int().nonnegative()]);
const filters = z.partialRecord(fields, z.union([filterValue, z.array(filterValue).min(1).max(16)]));
const config = z.object({
    namespace: id, agentName: id.optional(), model: z.string().max(256).optional(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    contextTier: z.enum(["default", "long_context"]).optional(),
    visibility: z.enum(["private", "shared_read", "shared_write"]).optional(),
}).strict();
const query = z.object({
    connectorId: id.optional(), endpointId: id.optional(), sessionId: sessionId.optional(),
    status: z.enum(["received", "authenticated", "normalized", "matched", "routed", "queued", "consumed", "rejected",
        "duplicate", "unmatched", "rate_limited", "disabled", "expired", "target_terminal", "routing_failed", "dead_lettered", "dropped"]).optional(),
    limit: z.number().int().min(1).max(100).optional(), before: id.optional(),
}).strict();
const event = z.object({
    version: z.literal(1), provider: z.enum(["github", "azure-devops"]), repositoryId: id,
    projectId: id.optional(), buildDefinitionId: id.optional(), repository: z.string().max(256).optional(),
    eventType: z.enum(["workflow.completed", "check.completed", "build.completed", "pull_request.lifecycle", "ping"]),
    action: z.enum(["completed", "opened", "reopened", "closed", "synchronize", "edited", "ready_for_review", "converted_to_draft", "created", "updated", "merge_attempted", "ping"]),
    pullRequestNumber: z.number().int().positive().optional(), buildId: id.optional(), ref: z.string().max(256).optional(),
    status: z.string().max(256).optional(), conclusion: z.string().max(256).optional(),
    title: z.string().max(256).optional(), url: z.string().max(1024).optional(),
}).strict();

export function registerWebhookTools(server: McpServer, ctx: ServerContext) {
    const viewer = async (): Promise<WebhookViewer | undefined> => {
        if (ctx.webMode) return undefined;
        const principal = { ...LOCAL_DEFAULT_USER_PRINCIPAL };
        await ctx.mgmt.recordUserRole(principal, ctx.admin ? "admin" : "user");
        return { principal, isAdmin: ctx.admin, adminScope: ctx.authz?.adminScope === "cluster" ? "cluster" : "unrestricted" };
    };
    server.registerTool("create_signal_endpoint", {
        title: "Create Signal Endpoint",
        description: "Mint a bearer webhook capability bound to one authorized session and signal. The URL/token is shown once: handle it as a secret. No external provider is registered automatically.",
        inputSchema: { session_id: sessionId, signal_name: signalName,
            options: z.object({ label: label.optional(), expiresAt: z.string().optional(), maxUses: z.number().int().min(1).max(1000000).optional(),
                wake: z.boolean().optional(), hmacSecretRef: secretRef.optional(), rateLimitPerMinute: rate }).strict().optional() },
    }, withToolErrors(async ({ session_id, signal_name, options }) =>
        jsonResult(await ctx.mgmt.createSignalEndpoint(session_id, signal_name, options ?? {}, await viewer()))));
    server.registerTool("list_signal_endpoints", {
        title: "List Signal Endpoints", description: "List authorized endpoint metadata; tokens cannot be retrieved again.",
        inputSchema: { session_id: sessionId },
    }, withToolErrors(async ({ session_id }) => jsonResult(await ctx.mgmt.listSignalEndpoints(session_id, await viewer()))));
    server.registerTool("revoke_signal_endpoint", {
        title: "Revoke Signal Endpoint", description: "Revoke an owned capability without deleting its session. Requires explicit user confirmation.",
        inputSchema: { endpoint_id: id, confirmed: z.literal(true) },
    }, withToolErrors(async ({ endpoint_id }) => jsonResult(await ctx.mgmt.revokeSignalEndpoint(endpoint_id, await viewer()))));

    server.registerTool("list_webhook_connectors", { title: "List Webhook Connectors",
        description: "List authorized GitHub/ADO source connectors and redacted authentication configuration. Configured does not mean a delivery has been verified.",
        inputSchema: {} },
    withToolErrors(async () => jsonResult(await ctx.mgmt.listWebhookConnectors(await viewer()))));
    server.registerTool("manage_webhook_connector", { title: "Manage Webhook Connector",
        description: "Create, update or revoke connector policy. Authentication uses server secret REFERENCES, never plaintext. Create and credential changes require admin; no GitHub/ADO API call is made.",
        inputSchema: { operation: z.discriminatedUnion("action", [
            z.object({ action: z.literal("create"), input: z.object({ label, provider: z.enum(["github", "azure-devops"]),
                source, auth, owner, rateLimitPerMinute: rate }).strict() }).strict(),
            z.object({ action: z.literal("update"), connectorId: id, patch: z.object({
                expectedRevision: z.number().int().positive(), label: label.optional(), state, auth: auth.optional(), rateLimitPerMinute: rate,
            }).strict() }).strict(),
            z.object({ action: z.literal("revoke"), connectorId: id, confirmed: z.literal(true) }).strict(),
        ]) } },
    withToolErrors(async ({ operation }) => {
        const actor = await viewer();
        if (operation.action === "create") return jsonResult(await ctx.mgmt.createWebhookConnector(operation.input, actor));
        if (operation.action === "update") return jsonResult(await ctx.mgmt.updateWebhookConnector(operation.connectorId, operation.patch, actor));
        return jsonResult(await ctx.mgmt.revokeWebhookConnector(operation.connectorId, actor));
    }));
    server.registerTool("list_webhook_bindings", { title: "List Webhook Bindings", description: "List authorized filters and fixed routing actions.", inputSchema: {} },
        withToolErrors(async () => jsonResult(await ctx.mgmt.listWebhookBindings(await viewer()))));
    server.registerTool("manage_webhook_binding", { title: "Manage Webhook Binding",
        description: "Bind approved build/PR events to an authorized signal, fixed prompt, or approved session template. Coalescing is opt-in; filters only use documented normalized fields.",
        inputSchema: { operation: z.discriminatedUnion("action", [
            z.object({ action: z.literal("create"), input: z.object({ label, connectorId: id, filters, action, rateLimitPerMinute: rate }).strict() }).strict(),
            z.object({ action: z.literal("update"), bindingId: id, patch: z.object({
                expectedRevision: z.number().int().positive(), label: label.optional(), state, filters: filters.optional(), action: action.optional(), rateLimitPerMinute: rate,
            }).strict() }).strict(),
            z.object({ action: z.literal("revoke"), bindingId: id, confirmed: z.literal(true) }).strict(),
        ]) } },
    withToolErrors(async ({ operation }) => {
        const actor = await viewer();
        if (operation.action === "create") return jsonResult(await ctx.mgmt.createWebhookBinding(operation.input, actor));
        if (operation.action === "update") return jsonResult(await ctx.mgmt.updateWebhookBinding(operation.bindingId, operation.patch, actor));
        return jsonResult(await ctx.mgmt.revokeWebhookBinding(operation.bindingId, actor));
    }));
    server.registerTool("list_webhook_templates", { title: "List Webhook Session Templates",
        description: "List approved source-scoped session templates visible to this caller.", inputSchema: {} },
    withToolErrors(async () => jsonResult(await ctx.mgmt.listWebhookSessionTemplates(await viewer()))));
    server.registerTool("manage_webhook_template", { title: "Manage Webhook Session Template",
        description: "Approve fixed session owner/agent/namespace/model/prompt policy. Event payloads cannot override it. Configuration changes require admin approval; revoke requires explicit confirmation.",
        inputSchema: { operation: z.discriminatedUnion("action", [
            z.object({ action: z.literal("create"), input: z.object({ label, owner, source, config, prompt }).strict() }).strict(),
            z.object({ action: z.literal("update"), templateId: id, patch: z.object({
                expectedRevision: z.number().int().positive(), label: label.optional(), state, config: config.optional(), prompt: prompt.optional(),
            }).strict() }).strict(),
            z.object({ action: z.literal("revoke"), templateId: id, confirmed: z.literal(true) }).strict(),
        ]) } },
    withToolErrors(async ({ operation }) => {
        const actor = await viewer();
        if (operation.action === "create") return jsonResult(await ctx.mgmt.createWebhookSessionTemplate(operation.input, actor));
        if (operation.action === "update") return jsonResult(await ctx.mgmt.updateWebhookSessionTemplate(operation.templateId, operation.patch, actor));
        return jsonResult(await ctx.mgmt.revokeWebhookSessionTemplate(operation.templateId, actor));
    }));
    server.registerTool("test_webhook_binding", { title: "Test Webhook Binding",
        description: "Dry-run a sanitized normalized event against persisted policy. It does not route, create a session or prove model/host placement admission.",
        inputSchema: { binding_id: id, event } },
    withToolErrors(async ({ binding_id, event }) => jsonResult(await ctx.mgmt.testWebhookBinding(binding_id, { event }, await viewer()))));
    server.registerTool("list_webhook_receipts", { title: "List Webhook Receipts",
        description: "Page redacted receipt timelines and delivery states. Queued is not consumed; bodies and credentials are never returned.",
        inputSchema: { query: query.optional() } },
    withToolErrors(async ({ query }) => jsonResult(await ctx.mgmt.listWebhookReceipts(query ?? {}, await viewer()))));
    server.registerTool("get_webhook_receipt", { title: "Get Webhook Receipt",
        description: "Read an authorized receipt and its session correlation, routing attempts and redacted timeline.", inputSchema: { receipt_id: id } },
    withToolErrors(async ({ receipt_id }) => jsonResult(await ctx.mgmt.getWebhookReceipt(receipt_id, await viewer()))));
    server.registerTool("replay_webhook_receipt", { title: "Replay Webhook Receipt",
        description: "Explicitly confirmed replay of a failed delivery under CURRENT authorization. Confirm with the user before calling; never replay automatically.",
        inputSchema: { receipt_id: id, confirmed: z.literal(true) } },
    withToolErrors(async ({ receipt_id }) => jsonResult(await ctx.mgmt.replayWebhookReceipt(receipt_id, { confirmed: true }, await viewer()))));
    server.registerTool("get_webhook_metrics", { title: "Get Webhook Metrics",
        description: "Read viewer-scoped outcome counts, routing backlog and dead-letter ages.", inputSchema: {} },
    withToolErrors(async () => jsonResult(await ctx.mgmt.getWebhookMetrics(await viewer()))));
}
