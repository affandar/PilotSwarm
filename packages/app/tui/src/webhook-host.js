import { isIP } from "node:net";
import { WebhookError } from "pilotswarm-sdk";

export function webhookHostConfig(env = process.env) {
    const boolean = (name) => {
        const value = env[name];
        if (value == null || value === "") return false;
        if (["true", "1"].includes(value)) return true;
        if (["false", "0"].includes(value)) return false;
        throw new WebhookError("WEBHOOK_CONFIG_INVALID", `${name} must be true or false.`);
    };
    let publicOrigin = env.PILOTSWARM_WEBHOOK_PUBLIC_ORIGIN || undefined;
    if (publicOrigin) {
        let url;
        try { url = new URL(publicOrigin); } catch {
            throw new WebhookError("WEBHOOK_CONFIG_INVALID", "Invalid webhook public origin.");
        }
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
            throw new WebhookError("WEBHOOK_CONFIG_INVALID", "Webhook public origin must be a bare HTTPS origin.");
        }
        publicOrigin = url.origin;
    }
    const trustedProxyIps = (env.PILOTSWARM_WEBHOOK_TRUSTED_PROXY_IPS || "").split(",").map(value => value.trim()).filter(Boolean);
    if (trustedProxyIps.length > 16 || trustedProxyIps.some(value => !isIP(value))) {
        throw new WebhookError("WEBHOOK_CONFIG_INVALID", "Webhook trusted proxy IPs must be at most 16 explicit IP addresses.");
    }
    return {
        enabled: boolean("PILOTSWARM_WEBHOOKS_ENABLED"),
        allowLoopbackHttp: boolean("PILOTSWARM_WEBHOOK_ALLOW_LOOPBACK_HTTP"),
        publicOrigin,
        trustedProxyIps,
    };
}

/** The template's source scope is approved in CMS; agent placement is live host policy. */
export async function authorizeWebhookTemplate(transport, template, owner) {
    if (!owner?.provider || !owner.subject || !template?.source?.repositoryId) return false;
    const { agentName, namespace } = template.config;
    if (!agentName) {
        const policy = transport.getSessionCreationPolicy();
        return namespace === "app" && (policy?.creation?.mode !== "allowlist" || policy.creation.allowGeneric === true);
    }
    const agents = await transport.listCreatableAgents(owner, false);
    const match = agents.find(agent => agent.name === agentName);
    if (!match || match.supportsDirectStart === false) return false;
    const expectedNamespace = match.source === "package" ? match.packageName : (match.namespace || "app");
    if (namespace !== expectedNamespace) return false;
    await transport._authorizePackageAgentCreate(agentName, owner, false);
    return true;
}
