/** Shared release path for management and in-session budget mutations. */
import type { SessionCatalog } from "./cms.js";
import { PROVIDER_BUDGET_WAKE_PROMPT } from "./provider-budgets.js";

export interface ProviderWakeClient {
    enqueueEvent(instanceId: string, queue: string, payload: string): Promise<unknown>;
}

/**
 * Call only after the store has authorized and committed the mutation.
 * The internal message asks the normal admission gate to recheck; it never
 * admits a model turn or discards the durable budget backstop itself.
 * No speculative CMS state writes: queuing a recheck is not proof of running.
 */
export async function wakeProviderPausedSessions(
    catalog: SessionCatalog | null | undefined,
    client: ProviderWakeClient | null | undefined,
    providerName: string,
): Promise<void> {
    if (!catalog?.providers || !client) return;
    try {
        const sessionIds = await catalog.providers.pausedFor(providerName);
        for (const sessionId of new Set(sessionIds)) {
            try {
                await client.enqueueEvent(`session-${sessionId}`, "messages", JSON.stringify({
                    prompt: PROVIDER_BUDGET_WAKE_PROMPT,
                }));
            } catch {
                // One unreachable session must not prevent other sessions waking.
                // Its durable timer remains the fallback.
            }
        }
    } catch {
        // A failed lookup also leaves every durable timer intact.
    }
}
