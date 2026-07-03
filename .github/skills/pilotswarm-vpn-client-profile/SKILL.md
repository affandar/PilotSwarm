---
name: pilotswarm-vpn-client-profile
description: "Use after deploying a PilotSwarm stamp with VPN_GATEWAY_ENABLED=true when an operator needs the Azure VPN client profile (azurevpnconfig.xml). Wraps deploy/scripts/auth/Get-VpnClientProfile.ps1 — downloads the gateway-issued profile zip via 'az network vnet-gateway vpn-client generate' and extracts it under the gitignored deploy/envs/local/<env>/vpn-client/ folder. The XML is the same for every user (no per-user credentials), and end users still authenticate with their own Entra ID at connect time."
---

# pilotswarm-vpn-client-profile

Downloads and stages the Azure VPN client profile for a PilotSwarm
VPN-enabled stamp. This is a small operational helper that wraps an
`az network vnet-gateway vpn-client generate` call, downloads the
returned signed zip, and extracts the `AzureVPN/azurevpnconfig.xml`
file that the Azure VPN Client app imports.

## When to use this skill

| User signal | Use this skill? |
|---|---|
| "give me the VPN client profile for <stamp>" | YES |
| "download the VPN config" / "get the VPN file to share" | YES |
| First-time bring-up of a VPN-enabled stamp, end users need profile | YES |
| Re-issued audience or re-deployed gateway, profile needs refresh | YES (with `-Force`) |
| Stamp does NOT have VPN enabled (`VPN_GATEWAY_ENABLED` unset / false) | NO — the script will fail-fast on the missing `VPN_GATEWAY_ID` |
| Stamp deployed but `deploy/.tmp/<env>/bicep-outputs.cache.json` is gone | NO — re-run deploy first to repopulate the cache |

## When the deployer agent should invoke this automatically

For VPN-enabled stamps (`VPN_GATEWAY_ENABLED=true` resolved from the
env file), the `pilotswarm-npm-deployer` flow should offer to run this
skill at the end of the first successful deploy — after `Setup-PortalAuth`
and `Set-PortalAuthAssignments`, before the final operator-handoff
banner. The profile is small (~3 KB), gitignored, and pulling it
proactively saves a round-trip when operators are about to test the
new VPN gateway. Skip silently for non-VPN stamps.

## Underlying tooling

| Script | Path | Purpose |
|---|---|---|
| `Get-VpnClientProfile.ps1` | `deploy/scripts/auth/` | Download + extract the profile zip |

The script reads the gateway resource id from
`deploy/.tmp/<env>/bicep-outputs.cache.json` (`VPN_GATEWAY_ID`),
parses the RG and gateway name, and calls
`az network vnet-gateway vpn-client generate --authentication-method EAPTLS`
to mint a fresh signed SAS URL (typically valid ~1 hour). It then
downloads the zip with `Invoke-WebRequest` and expands it under the
per-stamp gitignored folder. The first generate per gateway can take
~30–60 seconds; subsequent calls are faster.

## Output

```
deploy/envs/local/<EnvName>/vpn-client/
  AzureVPN/
    azurevpnconfig.xml          <-- the file end users import
  Generic/
    VpnServerRoot.cer_0          (server cert)
    VpnSettings.xml              (raw P2S settings — not needed by the client app)
```

The full local env folder (`deploy/envs/local/`) is gitignored via
`deploy/envs/.gitignore`, so the profile never reaches the repo.

## Sensitivity

The `azurevpnconfig.xml` is **semi-sensitive but not credential-bearing**:

- Contains: gateway public hostname (already public via DNS), Entra
  tenant ID, AAD audience GUID, server certificate, OpenVPN protocol
  parameters.
- Does NOT contain: any user credential, secret, token, or pre-shared
  key. End users authenticate with their own Entra ID via the Azure
  VPN Client app at connect time.

You can safely distribute the same XML to every authorized user —
treat it like a configuration file, not a key. Do not commit it to
git (the gitignore already prevents this), do not paste contents
into public chat, and do not include it in screenshots that show
the gateway hostname or audience GUID unless those are already public
for your environment.

## Identifier formats

The script takes one identifier: `-EnvName <stamp-name>`. Examples:

- `chkrawvpn` (matches `deploy/envs/local/chkrawvpn/.env`)
- `pschkrawvpn` (same stamp under a different name)

## Worked examples

### Fresh download for a stamp

```pwsh
pwsh -NoProfile -ExecutionPolicy Bypass `
  -File deploy/scripts/auth/Get-VpnClientProfile.ps1 `
  -EnvName <stamp>
```

Output: profile extracted under `deploy/envs/local/<stamp>/vpn-client/`,
key XML path printed for the operator to import or distribute.

### Re-download after re-deploying the gateway

```pwsh
pwsh -NoProfile -ExecutionPolicy Bypass `
  -File deploy/scripts/auth/Get-VpnClientProfile.ps1 `
  -EnvName <stamp> `
  -Force
```

`-Force` overwrites the existing folder. Use whenever the gateway
audience, address pool, or AAD config changes — old profiles cached
on user laptops will continue working until rotated, but new users
should always get the fresh XML.

### Download and open the folder

```pwsh
pwsh -NoProfile -ExecutionPolicy Bypass `
  -File deploy/scripts/auth/Get-VpnClientProfile.ps1 `
  -EnvName <stamp> `
  -OpenFolder
```

Opens Explorer (Windows) at the extracted folder for quick attach-to-email.

### Custom output directory

```pwsh
pwsh -NoProfile -ExecutionPolicy Bypass `
  -File deploy/scripts/auth/Get-VpnClientProfile.ps1 `
  -EnvName <stamp> `
  -OutDir C:\Users\me\Desktop\vpn-share
```

Useful when staging profiles for several stamps in one shareable
location. The `-OutDir` override is **not** gitignored automatically —
keep it outside the repo.

## End-user instructions to bundle with the profile

When sharing `azurevpnconfig.xml` with an end user, include:

1. Install the **Azure VPN Client**:
   - Windows: Microsoft Store
   - macOS: App Store
2. Open the Azure VPN Client app.
3. Choose **Import** and select the `azurevpnconfig.xml` file.
4. Click **Save** — the new connection appears in the left pane.
5. Click **Connect**. Sign in with your work Entra ID account.

If the user gets `Couldn't load packet length bytes` or
`Server did not respond properly to VPN Control Packets` errors,
their network egress (often a corp managed proxy) is intercepting
TCP 443 and killing the OpenVPN handshake — see PR #53 history and
`docs/developer/deploy/aks.md` for the diagnostic. The profile is fine;
the problem is the network they are on.

## Cross-references

- `deploy/scripts/auth/Get-VpnClientProfile.ps1` — the script
- `deploy/scripts/auth/Setup-PortalAuth.ps1` + skill `pilotswarm-portal-app-reg` — companion portal auth setup
- `deploy/scripts/auth/Set-PortalAuthAssignments.ps1` + skill `pilotswarm-portal-auth-assignments` — companion portal access management
- `docs/developer/deploy/aks.md` (§ "Optional: VPN Gateway P2S") — full VPN ingress documentation
- `docs/proposals/vpn-access-management.md` — future-work proposal to fold VPN access into the deployer-owned per-stamp app model
