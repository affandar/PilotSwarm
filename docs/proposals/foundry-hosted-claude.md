# Migrate Claude from direct-Anthropic to Foundry-hosted Claude

> **Status:** Proposal
> **Date:** 2026-05-04
> **Goal:** Move Anthropic Claude consumption from `api.anthropic.com` (direct vendor BYOK) to the Microsoft AI Foundry-hosted Claude surface (`services.ai.azure.com/anthropic`). Eliminate the last LLM API key in the system. Single Azure billing channel, single auth surface.

---

## Summary

Microsoft AI Foundry now hosts Claude models directly: Opus 4.7, 4.6, 4.5, 4.1; Sonnet 4.6, 4.5; Haiku 4.5. ([Microsoft Learn doc](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)). They run on the same `Microsoft.CognitiveServices/accounts` resource type Phase 1 already provisions for the GPT-5.x family — same Bicep module, same RBAC surface, same workload-identity story.

The historical reason PilotSwarm has a direct-Anthropic provider is that Claude wasn't on Azure when the SDK was first wired. That's no longer true. After this proposal lands:

- No `api.anthropic.com` traffic from production AKS workers.
- No `ANTHROPIC_API_KEY` env var, no `anthropic-api-key` KV secret, no `__PS_UNSET__` sentinel codepath needed for it.
- One billing channel (Azure invoice). One auth surface (Entra, assuming [Foundry Entra-mode proposal](./foundry-entra-mode-auth.md) has shipped).
- Catalog `model_providers.json` has zero `type: "anthropic"` entries — Claude is just another `type: "azure"` provider.

---

## Why this is a separate proposal

Foundry-hosted Claude has **a different URL surface** from openai-compatible Foundry models:

```
openai-compatible: https://<resource>.openai.azure.com/openai/v1/{deployment}/chat/completions
Foundry-hosted Claude:   https://<resource>.services.ai.azure.com/anthropic/v1/messages
```

Different host (`openai.azure.com` vs `services.ai.azure.com`), different path prefix (`/openai` vs `/anthropic`), different API spec (OpenAI Chat Completions vs Anthropic Messages). The PilotSwarm SDK's `type: "anthropic"` provider currently targets `https://api.anthropic.com` and speaks the Anthropic Messages API. Foundry-hosted Claude **also** speaks the Anthropic Messages API — but at a different host. Whether pointing the existing `type: "anthropic"` provider at the new host works out of the box, or requires a new `type` discriminator (e.g. `"azure-anthropic"`), is the central piece of verification work this proposal owns.

That verification, plus region-handling and Marketplace-subscription gating, is enough new surface that bundling it into Phase 1 (which is pure IaC) or Phase 2 (which is generic Foundry SDK auth plumbing) would muddy both. This is its own focused effort.

---

## What Foundry-hosted Claude requires

**Subscription:** paid Azure subscription with active billing method. Excluded: student, free trial, sponsored-credit-only, CSP, Enterprise Accounts in South Korea.

**Marketplace:** the Foundry Claude offering is a Marketplace SaaS subscription. The Azure subscription must have Marketplace access enabled and the deployer must hold the [permissions required to subscribe to model offerings](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-marketplace).

**Region:** East US 2 or Sweden Central only (as of 2026-05). Stamps in other regions either consume cross-region or fall back to direct-Anthropic.

**RBAC:** same `Cognitive Services OpenAI User` role used by the openai-compatible Foundry providers (proposal: [Foundry Entra-mode auth](./foundry-entra-mode-auth.md)).

---

## Verification work

Before any code change, settle these questions on a throwaway Foundry account in East US 2:

1. **SDK URL handling.** Does PilotSwarm's existing `type: "anthropic"` provider, with `baseUrl: "https://<resource>.services.ai.azure.com/anthropic"`, successfully send a `POST /v1/messages` and parse the response? Or does the underlying SDK assume `api.anthropic.com` somewhere (e.g. retry logic, header injection, OAuth flows specific to console.anthropic.com)?
2. **Auth header shape.** Foundry-hosted Claude in key-mode wants `api-key: <key>` (Cognitive Services convention), not Anthropic's `x-api-key: <key>` (vendor convention). Confirm or fix the SDK's header emission for the new host.
3. **Anthropic version header.** Direct-Anthropic requires `anthropic-version: 2023-06-01`. Does the Foundry surface preserve that, change it, or ignore it?
4. **Streaming.** Verify SSE streaming works at the Foundry host with the same wire format the SDK expects.
5. **Token-mode (when [Entra-mode proposal](./foundry-entra-mode-auth.md) ships).** Does `Authorization: Bearer <token>` against `services.ai.azure.com/.default` work the same as for openai-compatible Foundry? Or does Foundry-Claude need a different audience scope?

If any of those produce a "no" or "different from direct-Anthropic," introduce a `type: "azure-anthropic"` discriminator that does the right thing for the Foundry host while leaving `type: "anthropic"` untouched (so direct-Anthropic continues to work for stamps that need it during the migration).

---

## Bicep changes

`foundry.bicep` is parameterized over `foundryDeployments`; adding Claude is just adding entries to that array. Each Claude deployment is `{ name: "claude-sonnet-4-6", model: { format: "Anthropic", name: "claude-sonnet-4-6", version: "<version>" }, sku: { name: "GlobalStandard", capacity: <tpm> } }` (exact `format` value to confirm against ARM schema during verification).

If verification reveals Claude needs a separate Foundry account (different SKU, different region, different Marketplace subscription), introduce a second `foundry-claude.bicep` module, with its own outputs (`foundryClaudeEndpoint`). Stamps in unsupported regions either skip Claude entirely or point at a remote-region account they share.

---

## Catalog changes

Replace the direct-Anthropic provider in the base `model_providers.json`:

```diff
-{
-    "id": "anthropic",
-    "type": "anthropic",
-    "baseUrl": "https://api.anthropic.com",
-    "apiKey": "env:ANTHROPIC_API_KEY",
-    "models": [...]
-}
+{
+    "id": "foundry-claude",
+    "type": "anthropic",            // or "azure-anthropic" pending verification
+    "auth": "entra",                // assumes Entra-mode proposal has shipped
+    "baseUrl": "__FOUNDRY_CLAUDE_ENDPOINT__/anthropic",
+    "models": [
+        { "name": "claude-opus-4-7", "cost": "high", "description": "..." },
+        { "name": "claude-sonnet-4-6", "cost": "medium", "description": "..." },
+        { "name": "claude-haiku-4-5", "cost": "low", "description": "..." }
+    ]
+}
```

Substitution at manifests stage resolves `__FOUNDRY_CLAUDE_ENDPOINT__` from a Bicep output (same FR-022 alias pattern Phase 1 introduces for `__FOUNDRY_ENDPOINT__`). When a stamp doesn't enable Foundry-Claude (region/marketplace ineligibility), the placeholder either resolves to empty (provider doesn't load) or falls back to direct-Anthropic if the operator's `.env` still has `ANTHROPIC_API_KEY`.

---

## Region-fallback strategy

Three options for stamps outside East US 2 / Sweden Central:

**A — Cross-region Foundry account.** Stamp in West US 3 has a workload-identity grant to a centrally-hosted Foundry account in East US 2. Pro: single Foundry resource for the org, cleanest Marketplace footprint. Con: cross-region latency (≈70ms RTT), data-residency consideration.

**B — Per-stamp regional fallback to direct-Anthropic.** Stamp in West US 3 keeps `type: "anthropic" + api.anthropic.com` for Claude until Foundry expands. Pro: zero latency penalty. Con: keeps the direct-vendor codepath alive longer; uneven story across stamps.

**C — Refuse Claude in unsupported regions.** Stamp in West US 3 has no Claude provider in its catalog at all. Operator has to use a different model. Pro: forcing function for org-wide consolidation. Con: regression for stamps that today have Claude.

Recommendation: **A** for stamps where the latency hit is acceptable, **B** as a transitional fallback for latency-sensitive stamps. Avoid **C** — it's a hard regression.

---

## Migration path per stamp

1. Verify subscription is Marketplace-enabled and not on the excluded list (CSP / sponsored / etc.).
2. Add Claude deployments to `foundry-deployments.json` (or whatever Phase 1 lands as the deployment-list shape).
3. Run `--steps bicep`. New deployments provision; Marketplace subscription gets created on first apply (one-time interactive accept may be needed depending on tenant policy).
4. Run `--steps manifests,rollout`. Catalog substitution swaps the direct-Anthropic provider for the Foundry-Claude provider. Worker pods restart and start sending Claude traffic to `services.ai.azure.com`.
5. Smoke-test: `claude-sonnet-4-6` chat through the runtime, verify response and AAD audit log entry.
6. Once confidence is high across stamps: delete `anthropic-api-key` from KV; remove `ANTHROPIC_API_KEY` from `SEEDABLE_SECRET_KEYS`, the `new-env` prompt list, and the SPC; remove the `__PS_UNSET__` sentinel-strip codepath from `packages/sdk/examples/worker.js` (it has no remaining consumers).

The retire-direct-Anthropic step is reversible up to (6); after (6) it's a fresh PR to add Anthropic back.

---

## End state

- LLM keys in KV: **none.** (`GITHUB_TOKEN` is OAuth-style, separate concern.)
- Foundry providers: all Entra-authenticated.
- Direct-vendor LLM API calls from production: **none.**
- Catalog provider count drops by one (`anthropic` direct gone), provider type variety drops by one (`type: "anthropic"` may stay if Foundry-Claude reuses it, otherwise gone).
- Worker pod identity: workload identity, member of `Cognitive Services OpenAI User` on N Foundry accounts (one per region/SKU bucket).
- `seed-secrets.mjs` flow shrinks: only operator-supplied secrets that genuinely have no Azure-resident equivalent (GitHub OAuth, portal auth client IDs).

---

## Dependencies

- **Phase 1** (Bicep-provisioned Foundry + auto-keys + base catalog substitution) is a hard prerequisite. This proposal adds Claude deployments to the same module and reuses the same substitution mechanism.
- **[Foundry Entra-mode proposal](./foundry-entra-mode-auth.md)** is a soft prerequisite. This proposal can ship first (in key-mode), but the strategic win — zero keys — only materializes when both ship.

---

## Open questions

- **Marketplace subscription automation.** Marketplace SaaS subscriptions today often require an interactive accept-terms step in the Azure portal before Bicep `accounts/deployments` for a partner-model can succeed. Investigate `Microsoft.SaaS/resources` programmatic acceptance to keep the deploy fully non-interactive.
- **Capacity unit accounting.** Foundry-Claude `capacity` (tokens/min) is per-deployment. A stamp running multiple Claude deployments needs explicit capacity numbers per `foundry-deployments.json` entry. Document the default and the failure mode when the requested capacity exceeds the subscription quota.
- **Cost visibility.** Foundry-Claude bills through Marketplace, which lands in a separate cost-center surface from native Azure resources. Make sure `azure-cost` skill / cost-tracking docs note this.
