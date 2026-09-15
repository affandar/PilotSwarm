/**
 * Workload-identity auth for Azure AI Foundry (Cognitive Services) providers —
 * no API key anywhere.
 *
 * A provider declared `type: "foundry-wif"` carries no credential. The worker
 * mints a short-lived Microsoft Entra (AAD) access token for the Cognitive
 * Services data plane from the workload identity its platform already issues
 * (the same `DefaultAzureCredential` chain the blob store and Postgres pools
 * use), and the Copilot SDK sends it as `Authorization: Bearer` against the
 * Foundry `/openai/v1` endpoint. The Foundry account runs `disableLocalAuth:
 * true`, so the key path is off and only this token path is accepted.
 *
 * WHY A CALLBACK RATHER THAN A STORED KEY. The AAD token expires (~1h) while a
 * PilotSwarm session outlives that and may resume on another worker days later.
 * So the token is never put in the session config; the SDK takes a
 * `bearerTokenProvider` callback and asks for a token before each request.
 * `DefaultAzureCredential` caches tokens (~5 min before expiry) and refreshes
 * transparently, so the per-call overhead after warm-up is trivial.
 *
 * @module
 */

import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

/**
 * AAD scope for the Azure Cognitive Services data plane (Foundry / Azure
 * OpenAI). Constant across all Azure regions / clouds where the resource is
 * offered.
 */
export const FOUNDRY_AAD_SCOPE = "https://cognitiveservices.azure.com/.default";

/**
 * Cache the AAD credential at module scope. `DefaultAzureCredential` itself
 * caches tokens (~5 min before expiry); a single shared instance keeps the
 * actual `getToken` rate low across every Foundry session on the worker.
 */
let cachedCredential: TokenCredential | null = null;
function getCredential(): TokenCredential {
    if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
    return cachedCredential;
}

/**
 * Replace the cached credential with a custom one. Tests pass a stub here;
 * production code should never call this.
 *
 * @internal
 */
export function _setFoundryAadCredentialForTests(cred: TokenCredential | null): void {
    cachedCredential = cred;
}

/**
 * A bearer-token callback that mints a fresh Cognitive Services AAD token on
 * demand. Handed to the Copilot SDK as `bearerTokenProvider`. Throws with an
 * actionable message when no token can be acquired (missing workload identity
 * or missing role assignment) rather than surfacing as an opaque 401 on the
 * first turn.
 */
export function foundryBearerTokenProvider(
    deps: { credential?: TokenCredential } = {},
): () => Promise<string> {
    return async () => {
        const credential = deps.credential ?? getCredential();
        const token = await credential.getToken(FOUNDRY_AAD_SCOPE);
        if (!token || !token.token) {
            throw new Error(
                "Failed to acquire an AAD token for Azure Cognitive Services "
                + `(scope ${FOUNDRY_AAD_SCOPE}). Verify the worker pod has `
                + "azure.workload.identity/use=true and the federated UAMI has the "
                + "'Cognitive Services OpenAI User' role on the Foundry account.",
            );
        }
        return token.token;
    };
}
