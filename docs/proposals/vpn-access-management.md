# Proposal: VPN access management via per-stamp custom audience app

**Status:** Proposed (follow-up to PR #53 "VPN P2S Ingress")
**Author:** chkraw
**Date:** 2026-06-18
**Related:** [`docs/deploying-to-aks.md`](../developer/deploy/aks.md) → "Optional: VPN Gateway P2S", [`docs/portal-entra-app-roles.md`](../developer/deploy/entra-app-roles.md), `.github/skills/pilotswarm-portal-auth-assignments/`, `deploy/scripts/auth/Set-PortalAuthAssignments.ps1`

## Problem

The VPN P2S ingress shipped in PR #53 uses the **Microsoft-registered Azure VPN Client app** (`c632b3df-fb67-4d84-bdcf-b95ad541b5c8`) as the audience. Access control is therefore delegated entirely to a tenant-level **Conditional Access policy** that targets that app and restricts assignment to a named group + requires MFA.

This works, but creates two operational gaps:

1. **Resource owners (deployers) cannot manage who has VPN access without a tenant admin.** Creating or modifying CA policies requires `Conditional Access Administrator` / `Security Administrator` / `Global Administrator`. In locked-down corporate tenants (e.g. Microsoft), deployers do not have these roles. Every "add a new VPN user" request has to round-trip through central IT.
2. **Portal and VPN access drift apart.** The portal is gated by per-stamp Entra app-role assignments (`admin`/`user`), managed by the deployer via `Set-PortalAuthAssignments.ps1`. VPN access is gated by a tenant-admin-owned CA-targeted group. Granting a user "access to PilotSwarm" therefore requires two separate workflows owned by two different actors. There is no symmetry, no mirroring, and no obvious place for an agent or skill to "grant access" atomically.

The user's exact phrasing: *"doesn't make sense to have either in isolation."*

## Goal

Bring VPN access management under the same model and tooling shape as portal access management:

- **Per-stamp Entra app**, owned by the deployer.
- **Direct user/group assignments** on the service principal, gated by `appRoleAssignmentRequired=true`.
- **No tenant admin required** for ongoing add/remove operations.
- **CA policy becomes truly optional** — tenant admins can still layer MFA / device compliance / location on top, but it is no longer a *gating prerequisite* for the deployment to function.
- **Mirror semantics:** granting portal access also grants VPN access by default (configurable opt-out).

## Background — verified Microsoft Learn pattern

Azure VPN Gateway officially supports a **custom audience app** as a first-class alternative to the Microsoft-registered or manually-registered audience values. Source:

| Doc | What it confirms |
|---|---|
| [Configure P2S VPN gateway for Microsoft Entra ID authentication: Microsoft-registered client](https://learn.microsoft.com/en-us/azure/vpn-gateway/point-to-site-entra-gateway) | Three supported audience types: Microsoft-registered, Manually-registered, **Custom (`<custom-app-id>`)**. The Audience field on the gateway explicitly accepts a custom value. |
| [Scenario: Configure P2S access based on users and groups](https://learn.microsoft.com/en-us/azure/vpn-gateway/point-to-site-entra-users-access) | Documents the exact workflow: register custom app per gateway → expose API + scope → authorize the Azure VPN Client as a known client → `Assignment required = Yes` on the SP → assign users/groups directly. |
| [Create custom app ID for P2S VPN](https://learn.microsoft.com/en-us/azure/vpn-gateway/point-to-site-entra-register-custom-app) | Exact app config: single-tenant, "Expose an API" with a scope, "Add a client application" pointing at `c632b3df-fb67-4d84-bdcf-b95ad541b5c8` as the authorized client. The custom app's Application (client) ID becomes the gateway audience. |

### Key facts from the docs

- The Microsoft-registered Azure VPN Client app (`c632b3df-…`) has **global tenant consent** — no per-tenant admin consent is needed to use it as a client of the custom audience app.
- The custom app does **not** itself authenticate users — the Azure VPN Client desktop app is still the OIDC client. The custom app just provides the audience + scope + assignment gate.
- Each VPN gateway can support **exactly one** audience value at a time.
- **Nested groups are not supported** for assignments. Direct user or direct group only. (Same constraint as portal app-role assignments — uniform.)
- Initial app registration requires the **Cloud Application Administrator** role (or higher). This is the same prerequisite as `Setup-PortalAuth.ps1` — deployers who can register the portal app can register the VPN audience app.

## Design

### New scripts

**`deploy/scripts/auth/Setup-VpnAuth.ps1`** — one-shot, per-stamp custom audience app registration. Companion to `Setup-PortalAuth.ps1`.

Responsibilities:
- Register single-tenant Entra app (`PilotSwarm VPN - <EnvName>`).
- Add an exposed API scope (e.g. `p2s-vpn`).
- Add the Microsoft-registered Azure VPN Client (`c632b3df-…`, or the per-cloud equivalent) as an authorized client application against that scope.
- Create the service principal and set `appRoleAssignmentRequired=true`.
- Set the deploying user as owner.
- Write a per-stamp summary to `deploy/envs/local/<EnvName>/vpn-app.json` (mirrors `entra-app.json`).

Output the custom app's `clientId` so it can be threaded into `VPN_AAD_AUDIENCE` for the bicep layer.

**`deploy/scripts/auth/Set-VpnAccess.ps1`** — ongoing add/remove/list. Companion to `Set-PortalAuthAssignments.ps1`.

Responsibilities (identical shape to the portal-assignments script):
- `-EnvName <stamp>` auto-discovers the app from `deploy/envs/local/<EnvName>/vpn-app.json`.
- `-AppId / -ObjectId` explicit override.
- `-VpnUsers <ids…>` to add (UPN, object id, or group display name).
- `-Remove` to remove the same identifiers.
- `-List` to show current assignments.
- Idempotent — already-assigned principals are no-ops.

### Modified scripts

**`deploy/scripts/auth/Set-PortalAuthAssignments.ps1`** — gains `-MirrorToVpn` flag.

- **Default ON** when `VPN_GATEWAY_ENABLED=true` and a `vpn-app.json` exists for the stamp.
- On add: after adding to `admin` / `user` on portal, also adds the principal to the VPN custom app's assignments.
- On remove: removes from VPN assignments **only if** the principal has no remaining portal role (so demoting `admin → user` does not strip VPN).
- Opt-out via `-NoMirror`.

### Modified bicep / orchestrator

**`deploy/services/base-infra/bicep/vpn-gateway.bicep`** — already accepts `vpnAadAudience` as a parameter. No bicep change needed beyond what is already shipped.

**`deploy/scripts/deploy.mjs` / `new-env.mjs` / env templates:**
- New env var `VPN_AAD_CLIENT_ID` (the custom app's `appId`) feeds `VPN_AAD_AUDIENCE` when set.
- When `VPN_AAD_CLIENT_ID` is unset, the deploy keeps the Microsoft-registered audience and the CA-required model (backwards compatible).
- `new-env.mjs` post-scaffold reminder block adapts: when custom audience is configured, the CA-policy guidance becomes "optional MFA layering" instead of "REQUIRED before first connect."

### New skill

**`.github/skills/pilotswarm-vpn-access/SKILL.md`** — parallel to `pilotswarm-portal-auth-assignments`. Documents:
- When to use (initial bring-up, ongoing add/remove, listing access).
- When NOT to use (legacy CA-policy-driven stamps, VPN disabled).
- Identifier formats (UPN, object id, group display name).
- Mirror behavior and how it interacts with portal access.
- Worked examples for common workflows.

### Modified skill

**`.github/skills/pilotswarm-portal-auth-assignments/SKILL.md`** — adds a "VPN mirror" section, cross-links to `pilotswarm-vpn-access`, documents the `-MirrorToVpn` / `-NoMirror` knobs.

### Modified agent

**`.github/agents/pilotswarm-npm-deployer.agent.md`** — gains a step:
- After `Setup-PortalAuth.ps1` (when present), if `VPN_GATEWAY_ENABLED=true` and no `vpn-app.json` exists, run `Setup-VpnAuth.ps1`.
- After `Set-PortalAuthAssignments.ps1`, the `-MirrorToVpn` default-ON behavior ensures VPN access is provisioned in lockstep.
- The existing CA-policy guidance is re-cast as **optional** when a custom audience is configured.

## Mirror semantics — explicit rules

| Portal op | VPN-app effect (default `-MirrorToVpn`) |
|---|---|
| Add user to `user` (no existing portal role) | Add user to VPN app |
| Add user to `admin` (no existing portal role) | Add user to VPN app |
| Add user to `admin` (already in `user`) | No change to VPN (already assigned) |
| Remove user from `user` (still in `admin`) | No change to VPN (still has portal role → still gets VPN) |
| Remove user from `admin` (still in `user`) | No change to VPN |
| Remove user from last portal role | Remove user from VPN app |
| `-List` on portal | Also lists VPN assignments (for parity visibility) |

VPN-only access (someone needs VPN but no portal access) is fully supported — call `Set-VpnAccess.ps1` directly. Mirroring is one-directional (portal → VPN), not the reverse, to keep the rules simple and to preserve the "VPN-only contractor" use case.

## Backwards compatibility

| Stamp state | Behavior |
|---|---|
| `VPN_GATEWAY_ENABLED` unset / false | No change. Scripts and agent ignore VPN concerns. |
| `VPN_GATEWAY_ENABLED=true`, `VPN_AAD_CLIENT_ID` unset | No change. Deploy uses Microsoft-registered audience + CA-required model (current PR #53 behavior). |
| `VPN_GATEWAY_ENABLED=true`, `VPN_AAD_CLIENT_ID` set | New path. Custom audience app gates access. CA is optional. |
| Existing CA-required stamp wants to migrate | Run `Setup-VpnAuth.ps1` → re-run `deploy.mjs` to flip the gateway audience → re-issue VPN client profiles → users re-import. Document the migration. |

## Out of scope

- **Authoring Conditional Access policies programmatically.** Still tenant-admin only. The proposal explicitly does not try to bypass that — it sidesteps the CA-as-gating-mechanism dependency entirely.
- **Nested group support.** Microsoft does not support it for this scenario; do not pretend to.
- **Cross-cloud (Azure Government, Azure China) audience swap automation.** Document the per-cloud client IDs but do not auto-detect cloud in v1 — operators can pass the right value explicitly.
- **Multiple audiences per gateway.** Not supported by Azure. If a stamp needs distinct access groups (e.g. "admin-only VPN" + "user VPN"), the answer is multiple gateways, not multiple audiences on one gateway — out of scope for v1.

## Open questions

1. **Default for `-MirrorToVpn`** when both surfaces exist but the operator did not explicitly opt in. Current proposal: ON. Counter-arg: surprising side-effects. Recommend: ON with a one-line `Write-Host` notice on each mirror action so the operator sees what happened.
2. **What about portal-only contractors?** Today they get portal access via `Set-PortalAuthAssignments` and no VPN. Under default-ON mirror, they would also get VPN. Fix: a `-PortalOnly` flag on the portal-assignments script that suppresses mirroring for this specific call.
3. **Should `Setup-VpnAuth.ps1` be folded into `Setup-PortalAuth.ps1`** as a `-IncludeVpn` flag, instead of being a separate script? Pro: one entry point. Con: cohesion of two distinct app registrations, harder to migrate independently. Recommend: keep separate.
4. **Migration UX for existing PR #53 stamps.** Should `deploy.mjs` detect a stamp that was deployed with the 1P audience and offer to migrate, or should this be a manual operator step documented in the skill? Recommend: manual + documented in v1, automated migration as a v2 enhancement.

## Implementation phases (preview for follow-up PAW)

| Phase | Scope |
|---|---|
| 1 | `Setup-VpnAuth.ps1` + `Set-VpnAccess.ps1` + `vpn-app.json` schema |
| 2 | `Set-PortalAuthAssignments.ps1` `-MirrorToVpn` flag + tests |
| 3 | `deploy.mjs` / `new-env.mjs` env threading + scaffolder UX + tests |
| 4 | New skill, modified skill, modified agent — docs |
| 5 | Migration documentation for existing CA-required stamps |
| 6 | **iOS support via dual-auth (certificate)** — see next section |

---

## iOS support requires certificate-based authentication (additive Phase 6)

**Status:** Confirmed via web research 2026-06-18 — **there is no Azure VPN Client app on the iOS App Store**. Microsoft ships Azure VPN Client for Windows, macOS, and Android only. AAD-interactive authentication from iOS to Azure VPN Gateway is therefore **not possible at all** — not a CA policy issue, not a tenant issue, just absent product.

This is not a single-user convenience; it is a platform limitation that affects every iOS user who needs P2S access to a PilotSwarm stamp. Any organization with an iPad/iPhone user population that needs portal access from outside corp/SAW will hit this immediately.

### iOS-supported auth options on Azure VPN P2S

| Path | iOS-native? | Works with our AAD-gated gateway? |
|---|---|---|
| Native iOS VPN with IKEv2 + **certificate auth** | YES (no app install) | Only if gateway has cert auth enabled alongside AAD |
| Third-party OpenVPN client + cert auth | App Store apps available (e.g. Passepartout) | Same — requires cert auth on gateway |
| Azure VPN Client (AAD) | **Not available on iOS** | N/A |

### Dual-auth gateway pattern

Azure VPN Gateway supports **multiple authentication methods simultaneously** in a single `vpnClientConfiguration` block — AAD config and `vpnClientRootCertificates[]` can coexist. Each end user picks which auth method to use when they import the profile. AAD users (Windows/macOS/Android) are completely unaffected; iOS users get a separate cert-auth profile.

### Scope additions for Phase 6

| Piece | Notes |
|---|---|
| `vpn-gateway.bicep` — optional `vpnClientRootCertificates[]` block | Conditional on new `VPN_CERT_AUTH_ENABLED` flag. ~30 lines of bicep. |
| New env vars: `VPN_CERT_AUTH_ENABLED`, `VPN_ROOT_CERT_NAME` (AKV cert) or `VPN_ROOT_CERT_DATA` (raw base64) | Prefer AKV — we already have one for the AppGw cert. |
| `New-VpnRootCertificate.ps1` | Generates self-signed root, uploads to AKV, exports the public cert in the bicep-expected base64 form. Operators with a corp PKI root skip this. |
| `New-VpnClientCertificate.ps1 -UserName <upn>` | Per-user client cert signed by the root, exported as password-protected PFX into `deploy/envs/local/<env>/vpn-client/clients/<upn>.pfx`. |
| `Get-VpnClientProfile.ps1 -AuthMethod cert -UserName <upn>` | Extends the existing helper. Bundles the cert-auth profile zip + the per-user PFX in one drop. |
| **iOS sugar: `New-VpnIosMobileconfig.ps1 -UserName <upn>`** | Generates a signed Apple Configuration Profile (`.mobileconfig`) bundling the IKEv2 VPN config + client cert + CA root. End user taps once on the iPhone — VPN installed and ready. Without this, iOS cert VPN setup is a 15-step manual process and not appropriate for non-technical users. |
| `pilotswarm-vpn-client-profile` skill update | Document `-AuthMethod cert` and the iOS `.mobileconfig` path. |
| Cost | $0 additional Azure cost; PKI is operational overhead only. |

### Critical access-control implications

**Certificate-auth users completely bypass Entra ID.** This must be flagged loudly in every operator-facing surface:

- No MFA challenge
- No Conditional Access enforcement
- No tenant audit trail of who connected when
- No revocation if the device is lost without re-issuing PKI (or maintaining a revocation list)

This is by design and unavoidable for cert-based VPN — but it inverts the access-control story we built in Phase 1. **Cert auth should be the exception, not the default.**

Required mitigations bundled with Phase 6:

- **Short cert validity**: 30–90 day default, never indefinite
- **Per-device certificates**, not per-user — so loss of one device does not invalidate everyone with the same identity
- **Revocation list maintained in bicep** via `vpnClientRevokedCertificates`, with a `Revoke-VpnClientCertificate.ps1` helper to add a cert thumbprint and trigger a `deploy.mjs base-infra` step
- **AKV-stored root with HSM-protected private key** — losing the root would compromise every issued client cert
- **`pilotswarm-vpn-client-profile` skill warning block** rendered prominently whenever `-AuthMethod cert` is used

### Phase 6 backwards compatibility

| Stamp state | Behavior |
|---|---|
| `VPN_CERT_AUTH_ENABLED` unset / false | No change. AAD-only behavior from current PR + custom-audience proposal. |
| `VPN_CERT_AUTH_ENABLED=true`, `VPN_CERT_AUTH_ENABLED` env added | Bicep emits dual-auth gateway. Existing AAD profiles continue working untouched. |
| Add cert auth to a stamp deployed AAD-only | One `deploy.mjs base-infra` re-run (~minutes against an existing gateway, not 45+) flips the gateway into dual-auth mode. |

### Why this is Phase 6 (last) and not Phase 1

- Phases 1–5 deliver the deployer-owned access-control story for the majority case (Windows/macOS/Android) which is what most PilotSwarm deployments hit.
- Phase 6 is genuinely additive — no changes to anything in Phases 1–5.
- The PKI operational story (cert issuance, rotation, revocation) is meaningful additional surface area that deserves its own focused PR with its own tests, rather than being bundled.
- The iOS mobileconfig polish in particular needs care — a malformed mobileconfig is a security incident, not a UX bug.


## Acceptance criteria

- A deployer with **no tenant admin role** (only the same permissions they currently use for `Setup-PortalAuth.ps1`) can:
  1. Bring up a fresh VPN-enabled stamp with custom audience access control.
  2. Add and remove VPN users on demand without filing a tenant-admin ticket.
- Granting a user `admin` or `user` portal access by default also grants them VPN access (single command).
- An operator can explicitly grant VPN-only access via the dedicated script.
- Existing PR #53 stamps continue to work unchanged.
- CA-policy guidance is correctly re-cast as optional when custom audience is in play.

## References

- [Configure P2S VPN gateway for Microsoft Entra ID authentication: Microsoft-registered client](https://learn.microsoft.com/en-us/azure/vpn-gateway/point-to-site-entra-gateway)
- [Scenario: Configure P2S access based on users and groups](https://learn.microsoft.com/en-us/azure/vpn-gateway/point-to-site-entra-users-access)
- [Create custom app ID for P2S VPN Microsoft Entra ID authentication](https://learn.microsoft.com/en-us/azure/vpn-gateway/point-to-site-entra-register-custom-app)
- PR #53 — VPN P2S Ingress (Phases 1–4)
- `deploy/scripts/auth/Setup-PortalAuth.ps1`
- `deploy/scripts/auth/Set-PortalAuthAssignments.ps1`
- `.github/skills/pilotswarm-portal-app-reg/SKILL.md`
- `.github/skills/pilotswarm-portal-auth-assignments/SKILL.md`
