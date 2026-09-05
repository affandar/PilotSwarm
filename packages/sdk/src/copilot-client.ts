import { CopilotClient, CopilotRequestHandler, RuntimeConnection } from "@github/copilot-sdk";
import type { CopilotClientOptions, CopilotRequestContext } from "@github/copilot-sdk";

/** Only OpenAI-compatible BYOK clients need the CLI 1.0.83 workaround. */
export function needsByokRequestCompatibility(provider: unknown): boolean {
    if (!provider || typeof provider !== "object") return false;
    const { type, wireApi } = provider as { type?: string; wireApi?: string };
    return (!type || type === "openai" || type === "azure") && (!wireApi || wireApi === "completions");
}

/**
 * CLI 1.0.83 leaks CAPI's `snippy: { enabled: false }` into BYOK chat
 * completions for GPT-5.6 models. Azure rejects the request before inference.
 * Keep this shim at the model HTTP boundary, not in prompts or model aliases.
 *
 * Attach ONLY to a dedicated OpenAI/Azure BYOK client: requestHandler forwards
 * all model traffic through Node, including WebSockets. Never attach it to a
 * GitHub Copilot client (native transport/auth and CAPI parameters must remain
 * intact), or an Anthropic/WIF client. Remove once the provider compatibility
 * tests pass without it. No response buffering, retry, or parameter allowlist.
 */
export class ByokRequestCompatibility extends CopilotRequestHandler {
    protected override async sendRequest(
        request: Request,
        context: CopilotRequestContext,
    ): Promise<Response> {
        if (request.method === "POST" && /\/chat\/completions\/?$/.test(new URL(request.url).pathname)
            && request.headers.get("content-type")?.includes("application/json")) {
            // Invalid/non-object JSON remains the upstream's responsibility.
            const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
            if (body && typeof body === "object" && !Array.isArray(body)
                && Object.prototype.hasOwnProperty.call(body, "snippy")) {
                delete body.snippy;
                const headers = new Headers(request.headers);
                // The serialized body changed; let fetch recompute framing.
                headers.delete("content-length");
                request = new Request(request, { headers, body: JSON.stringify(body) });
            }
        }
        return super.sendRequest(request, context);
    }
}

/** Shared by durable sessions and the short-lived title/distillation clients. */
export function createCopilotClient(options: CopilotClientOptions, provider?: unknown): CopilotClient {
    return new CopilotClient({
        ...options,
        // Do not let ambient COPILOT_SDK_DEFAULT_CONNECTION opt a multi-tenant
        // worker into the experimental process-global in-process transport.
        // Stdio uses the pinned SDK runtime and honors COPILOT_CLI_PATH.
        connection: RuntimeConnection.forStdio(),
        ...(needsByokRequestCompatibility(provider) ? { requestHandler: new ByokRequestCompatibility() } : {}),
    });
}

// A separate pool slot keeps the shim off native GHCP/Anthropic clients.
// NUL cannot occur in a GitHub token; this namespace cannot collide with one.
export const BYOK_CLIENT_PREFIX = "byok-openai\0";
