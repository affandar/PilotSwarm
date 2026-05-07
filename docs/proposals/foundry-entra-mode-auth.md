# Foundry providers via Entra ID (workload identity)

> **Status:** Proposal
> **Date:** 2026-05-04
> **Goal:** Eliminate API keys for Azure AI Foundry (Cognitive Services) providers in the modern AKS deploy path. Use the worker's federated workload identity to mint AAD tokens for the data-plane call instead.

---

## Summary

Phase 1 of the modern AKS deploy path provisions an Azure AI Foundry account in Bicep, has `auto-secrets.bicep` write its `key1` to Key Vault as `azure-oai-key`, and projects that key into the worker pod as the `AZURE_OAI_KEY` env var. The worker's `model_providers.json` then references it as `apiKey: env:AZURE_OAI_KEY` for every Foundry-hosted model.

That works, but it leaves a vendor key sitting in KV — exactly the kind of secret the rest of the modern deploy path has been eliminating. Storage uses workload identity. Postgres uses AAD tokens. Foundry should too.

This proposal covers the SDK + Bicep work to flip Foundry providers from key-mode to **Entra-mode**, where the worker uses `DefaultAzureCredential` to mint a token against `https://cognitiveservices.azure.com/.default` and passes it as `Authorization: Bearer …` instead of `api-key: …`. After this lands, `azure-oai-key` is removed from KV, `auto-secrets.bicep` skips the `listKeys()` write, and the Foundry account flips to `disableLocalAuth: true`.

---

## Why this is its own phase

This is purely SDK + RBAC plumbing — no IaC restructuring beyond one role assignment and one bicep flag. But it touches the `packages/sdk` layer in places Phase 1 does not, and downstream verification of the underlying `@github/copilot` SDK's auth-callback support is its own piece of research. Keeping it separate from the Phase 1 IaC PR means each lands focused and reviewable.

---

## Current state (as of Phase 1)

`packages/sdk/src/model-providers.ts::resolve()` (lines ~227–243) builds the SDK provider config for non-github providers as:

```ts
sdkProvider: {
    type: provider.type,                    // "azure" | "openai" | "anthropic"
    baseUrl: resolvedUrl,
    apiKey: resolveEnvValue(provider.apiKey),
    ...(provider.type === "azure" && {
        azure: { apiVersion: provider.apiVersion || "2024-10-21" },
    }),
}
```

There is **no token-provider branch**. The downstream consumer is `session-manager.ts::_resolveProviderConfig()` (~line 850), which forwards `sdkProvider` to the underlying `@github/copilot` runtime as `{ provider: sdkProvider }`. The exact shape of the underlying provider object is whatever `@github/copilot` accepts.

The SDK already imports `DefaultAzureCredential` from `@azure/identity` for blob (`blob-store.ts:9`) and Postgres (`pg-pool-factory.ts:16`). The credential type and the cluster's federated-credential plumbing are already in place — only the model-provider codepath is missing.

---

## Proposed schema change

Add an `auth` discriminator to `ModelProviderConfig`:

```ts
export interface ModelProviderConfig {
    id: string;
    type: "github" | "azure" | "openai" | "anthropic";
    /** Auth mode for non-github providers. Default "key". */
    auth?: "key" | "entra";
    githubToken?: string;
    baseUrl?: string;
    apiKey?: string;          // required when auth === "key"
    apiVersion?: string;
    models: (string | ModelEntry)[];
}
```

Validation: `auth: "entra"` requires `type` to be `"azure"` (Foundry / Cognitive Services) — direct OpenAI and direct Anthropic don't accept AAD tokens. `apiKey` is forbidden when `auth: "entra"`.

---

## Proposed resolve() change

```ts
const resolved = {
    providerId: provider.id,
    type: provider.type,
    modelName: desc.modelName,
    sdkProvider: {
        type: provider.type,
        baseUrl: resolvedUrl,
        ...(provider.auth === "entra"
            ? { azureADTokenProvider: makeFoundryTokenProvider() }
            : { apiKey: resolveEnvValue(provider.apiKey) }
        ),
        ...(provider.type === "azure" && {
            azure: { apiVersion: provider.apiVersion || "2024-10-21" },
        }),
    },
};
```

Where `makeFoundryTokenProvider()` returns a callable that pulls a fresh token from the cached `DefaultAzureCredential` instance (same pattern used in `pg-pool-factory.ts`):

```ts
const credential = new DefaultAzureCredential();
const FOUNDRY_SCOPE = "https://cognitiveservices.azure.com/.default";

function makeFoundryTokenProvider(): () => Promise<string> {
    return async () => {
        const token = await credential.getToken(FOUNDRY_SCOPE);
        if (!token) throw new Error(
            "Failed to acquire AAD token for Cognitive Services. " +
            "Verify worker pod has azure.workload.identity/use=true and the UAMI " +
            "has Cognitive Services OpenAI User on the Foundry account."
        );
        return token.token;
    };
}
```

Tokens are cached by `DefaultAzureCredential` and reused until expiry (~1h), so the per-call overhead after warm-up is trivial.

---

## Bicep RBAC changes

In `foundry.bicep` (or `auto-secrets.bicep` extension), add a role assignment when `foundryAuthMode == 'entra'`:

```bicep
resource foundryRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, workloadIdentityPrincipalId, 'cognitive-services-openai-user')
  properties: {
    // "Cognitive Services OpenAI User" — data-plane access without key access
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
    principalId: workloadIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
```

When `foundryAuthMode == 'entra'`:

- `disableLocalAuth: true` on the Foundry account (forces token-based access; rejects `api-key:` headers).
- `auto-secrets.bicep` skips the `listKeys()` write — no `azure-oai-key` in KV.
- Worker SPC drops the `azure-oai-key` row.
- Worker `seed-secrets` flow is unchanged (Foundry was never operator-prompted; auto-secrets owned it).

When `foundryAuthMode == 'key'` (default until Phase 2 ships): everything stays as Phase 1.

---

## Verification needed before implementing

1. **`@github/copilot` SDK token-provider surface.** The minified bundle in `node_modules/@github/copilot/app.js` ships `@azure/identity` (workload-identity error strings are visible) but the public TypeScript surface area for the Azure provider config wasn't fully traced. Need to confirm the property name (`azureADTokenProvider`? `getToken`? something else?) and the call signature it expects. If the SDK doesn't accept a token callback, this proposal needs an adapter layer that wraps the SDK's HTTP client.
2. **Bearer-vs-api-key header swap.** Confirm the SDK sends `Authorization: Bearer <token>` (Cognitive Services data-plane convention) when given a token provider, not `api-key: <token>`.
3. **Token cache invalidation on 401.** Verify the SDK refreshes the token on a 401 response — i.e. doesn't permanently cache an expired token. `DefaultAzureCredential` handles refresh, but the SDK has to call back into the provider on retry.

---

## Migration path per stamp

A stamp migrates from key to Entra by:

1. Setting `FOUNDRY_AUTH_MODE=entra` in its env file.
2. Re-running `--steps bicep`. This grants the role assignment and flips `disableLocalAuth`.
3. Re-running `--steps manifests,rollout`. The new catalog has `auth: "entra"` per Foundry provider; the SPC drops `azure-oai-key`; the new worker pods authenticate via token.
4. Optionally: `az keyvault secret delete --vault-name <kv> --name azure-oai-key`. (Bicep `auto-secrets` won't recreate it once `foundryAuthMode == 'entra'`.)

No data loss, no downtime — the rollout swaps the deployment generation. Old pods (key-mode) finish their in-flight requests against the still-valid keys; new pods (token-mode) start under the new role assignment.

---

## What lives in the runtime after this proposal lands

- KV: `github-token`, `anthropic-api-key` (still direct-Anthropic until [Foundry-hosted Claude proposal](./foundry-hosted-claude.md) lands), portal auth secrets. **No `azure-oai-key`.**
- Worker pod env: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, portal env. **No `AZURE_OAI_KEY`.**
- Foundry account: `disableLocalAuth: true`. Marketplace + portal-key-blade access disabled.
- Worker pod identity: workload identity (federated UAMI) → `Cognitive Services OpenAI User` on the Foundry account.

Combined with [Foundry-hosted Claude](./foundry-hosted-claude.md), the end state is **zero LLM API keys** in the system.

---

## Open questions

- **Per-provider auth-mode override.** Should `auth` be settable per-provider in `model_providers.json`, or one global stamp-level switch (`FOUNDRY_AUTH_MODE`)? Per-provider is more flexible (some stamps may want to mix), but adds catalog substitution complexity. Recommendation: stamp-level switch via env var, applied uniformly to all `type: "azure"` providers in the catalog at substitution time.
- **Audience scope.** `https://cognitiveservices.azure.com/.default` is the standard Cognitive Services audience. Foundry's newer surfaces (e.g. `services.ai.azure.com` for Claude) may need a different audience. Re-verify when the [Foundry-hosted Claude proposal](./foundry-hosted-claude.md) lands.
- **Test coverage.** The integration tests today exercise key-mode against a real Foundry account. Adding a token-mode integration test requires an AKS-resident test runner (workload identity needs the federated cred). Phase 2 should ship with at least a unit test for `makeFoundryTokenProvider` and a manual verification checklist for the live-validate step.
