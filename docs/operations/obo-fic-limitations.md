# OBO + Federated Identity Credential Limitations

This page documents AAD-policy limitations that PilotSwarm OBO live-smoke (and any
PilotSwarm-derived consumer that performs `acquireTokenOnBehalfOf`) has hit on
real CORP-tenant deployments. These are **AAD-side** policies, not PilotSwarm
bugs — the PilotSwarm propagation contract (User OBO Propagation, PR #51) is
agnostic to which `client_credential` shape your worker app uses.

---

## TL;DR

> **MSI-as-FIC works for direct downstream resource access from a workload, but
> it does NOT work as a `client_assertion` for an OAuth 2.0 On-Behalf-Of grant
> when the source UAMI is itself federated via AKS workload identity.**

Use one of these client-credential shapes for OBO from an AKS-hosted worker:

| Pattern | Works for OBO `client_assertion`? | SFI alignment | Tenant policy notes |
|---|---|---|---|
| **Client secret** on the worker app | ✅ Yes | Lower (secret on disk/AKV) | Always allowed |
| **Certificate** on the worker app | ✅ Yes | Higher | Always allowed |
| **AKS-direct FIC** (k8s SA → worker app) | ✅ Yes | High | **Often blocked on CORP tenants for 3P apps** |
| **MSI-as-FIC** (UAMI → worker app), UAMI is **not** itself federated | ✅ Yes | High | Works |
| **MSI-as-FIC**, UAMI **is** federated via AKS workload identity | ❌ **No** — AADSTS700231 | n/a | Documented below |

---

## Symptom

Worker tool (or smoke plugin) calls
`ConfidentialClientApplication.acquireTokenOnBehalfOf({ oboAssertion, scopes })`
where the CCA is constructed with a `clientAssertion` callback that returns a
UAMI token acquired via:

```ts
new ManagedIdentityCredential(uamiClientId)
    .getToken("api://AzureADTokenExchange/.default");
```

The OBO grant fails with:

```
AADSTS700231: NoMatchingFederatedIdentityRecordFound
```

Even though the FIC's `issuer`, `subject`, and `audience` exactly match the
UAMI token's `iss`, `sub`, and `aud` claims.

## Root cause

When the worker pod runs with AKS workload identity, the UAMI token returned
by `ManagedIdentityCredential` is **itself acquired via a federated credential
exchange**: the AKS-projected service-account token (issuer = AKS OIDC issuer,
subject = `system:serviceaccount:<ns>:<sa>`) is federated against a FIC on the
UAMI to produce the AAD token.

That UAMI token carries an `xms_ficinfo` claim indicating it originated via FIC
exchange. AAD's FIC validator on the **next** federation (UAMI → worker app)
detects this claim and refuses to accept the assertion as a `client_assertion`
for an OBO grant — chained federation is forbidden in this direction.

The error code is reported as **AADSTS700231** ("no matching record"), not as
an explicit chained-FIC error, but the AAD contract is the same: a
FIC-derived token cannot itself be used as a federated assertion in another
FIC validation. The error is independent of FIC config correctness.

### Diagnostic recipe

To prove this on a stamp:

```bash
# 1. Decode the UAMI token from inside a worker pod and confirm xms_ficinfo
kubectl -n <ns> exec <worker-pod> -- node -e "
  const { ManagedIdentityCredential } = require('/app/node_modules/@azure/identity');
  (async () => {
    const cred = new ManagedIdentityCredential(process.env.WORKLOAD_IDENTITY_CLIENT_ID);
    const t = await cred.getToken('api://AzureADTokenExchange/.default');
    const p = JSON.parse(Buffer.from(t.token.split('.')[1], 'base64').toString('utf8'));
    console.log(JSON.stringify(p, null, 2));
  })();
"
# Look for: "xms_ficinfo": "<base64 blob>" — its presence means the token was FIC-derived.

# 2. Confirm FIC config matches token claims exactly
az ad app federated-credential list --id <worker-app-clientId>
# audiences MUST be ["api://AzureADTokenExchange"] (URI form, not the GUID).
# Swapping to the GUID returns AADSTS700214 demanding the URI form.
```

If `xms_ficinfo` is present and OBO returns AADSTS700231 with a perfectly
matched FIC, you are hitting this AAD policy. No FIC re-registration will fix
it.

## Audience format gotcha (separate, also documented)

The FIC's `audiences` field for MSI-as-FIC **must** be the URI form
`api://AzureADTokenExchange`, even though the actual token's `aud` claim is the
GUID `fb60f99c-7a34-4190-8149-302f77469936`. AAD knows the URI ↔ GUID mapping
internally, but the FIC registration UI/API does not accept the GUID form —
attempting to use it yields **AADSTS700214** ("audience must be
`api://AzureADTokenExchange`"). FICs are also limited to one audience entry.

## Resolutions

For OBO-capable workers on AKS:

1. **Client secret on the worker app** (simplest unblock for non-prod / smoke):
   - Add a secret to the worker app, store in Key Vault, project via CSI driver
     into the worker pod.
   - PilotSwarm OBO smoke plugin (and PilotSwarm-style consumers) typically
     accept either FIC or secret backends; configure the secret env var and
     either remove the FIC or invert backend precedence to prefer secret.

2. **AKS-direct FIC** on the worker app (production-shape, where allowed):
   - Register a FIC on the worker app with `issuer = <AKS OIDC issuer URL>`
     and `subject = system:serviceaccount:<ns>:<sa>`.
   - Worker presents the projected SA token directly as `client_assertion`
     (read `AZURE_FEDERATED_TOKEN_FILE`, no UAMI hop).
   - **CORP tenants frequently block AKS-direct FICs on 3P apps.** Verify
     your tenant policy before standardizing on this.

3. **Certificate** (production-shape, always allowed):
   - Provision a cert on the worker app, mount via Key Vault CSI, configure
     the consumer plugin to use cert-based confidential client.

## Related

- `Setup-OboSmokeWorkerApp.ps1` documents both `-FicPattern msi` and
  `-FicPattern aks-direct` modes. The default is `msi`; per this page, that
  default is appropriate for direct downstream resource access from the
  worker but **not** for OBO grants when the source UAMI is k8s-federated.
- `pilotswarm-obo-smoke-app-reg` skill: see the warning section about FIC
  pattern selection for OBO scenarios.
- `docs/operations/obo-kek-runbook.md`: covers the envelope-encryption KEK
  rotation, distinct from this client-credential concern.
