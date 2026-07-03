# Portal Entra App Roles

PilotSwarm's portal authorization can now consume the `roles` claim that Entra
ID (Azure AD) ships in access tokens when an app registration defines app roles
and assigns them. This is the recommended setup for IT-managed tenants because
it moves admission control out of a hand-edited email allowlist and into the
same directory tooling teams already use for everything else.

The existing email-allowlist mechanism (`PORTAL_AUTHZ_ADMIN_GROUPS` /
`PORTAL_AUTHZ_USER_GROUPS`) still works for principals whose token does **not**
carry a `roles` claim. App roles and email allowlists are not mutually
exclusive — they cover different populations.

## Recommended End State

The recommended configuration is a single coherent setup, not a sequence of
optional toggles. Do all four steps.

### 1. Define `admin` and `user` app roles

In the Entra portal, open **App registrations → your app → App roles** and
create:

| Display name | Value   | Allowed member types |
| ------------ | ------- | -------------------- |
| Admin        | `admin` | Users/Groups         |
| User         | `user`  | Users/Groups         |

`Setup-PortalAuth.ps1 -CreateAppRoles` creates exactly these roles for you
(see [`deploy/scripts/auth/`](../../../deploy/scripts/auth) and the
[`pilotswarm-portal-app-reg`](../../../.github/skills/pilotswarm-portal-app-reg/SKILL.md)
skill). If you're configuring an app reg by hand, the equivalent CLI sketch is:

```bash
az ad app update --id <client-id> --app-roles '[
  {
    "displayName": "Admin",
    "value": "admin",
    "description": "Portal administrators",
    "id": "<new-guid>",
    "isEnabled": true,
    "allowedMemberTypes": ["User"]
  },
  {
    "displayName": "User",
    "value": "user",
    "description": "Portal users",
    "id": "<new-guid>",
    "isEnabled": true,
    "allowedMemberTypes": ["User"]
  }
]'
```

The portal matches the JWT `roles` claim by case-insensitive equality
against the canonical values `admin` and `user`. These are the prescriptive
role values — the portal does not accept aliases (no `Portal.Admin`,
`pilotswarm.admin`, etc.). If you need additional gate-keeping beyond
admin/user, define a new app role (e.g. `auditor`) and check it
explicitly in code against the JWT `roles` claim — don't try to alias
custom names onto the built-in admin/user buckets.

### 2. Enable lockdown (the recommended path)

The portal's authorization engine is **deny-by-default** (since
v0.1.33): a signed-in principal that carries no `admin`/`user` role
claim is denied at the portal layer rather than silently granted
`user`. This is the secure baseline and requires no env-var
configuration.

For production stamps, that is the entire lockdown setup:

1. **Define app roles** (Step 1 above).
2. **Assign principals to the roles** (Step 3 below) — the role
   assignment in Entra **is** the allowlist for the Roles posture.
   Assigned principals get a `roles` claim and are admitted as `admin`
   or `user`; unassigned signed-in users are denied by the engine's
   deny-by-default behavior.

Do **not** also populate `PORTAL_AUTHZ_ADMIN_GROUPS` /
`PORTAL_AUTHZ_USER_GROUPS` in the stamp's `.env` when using Roles
posture. The engine's role-authoritative branch (item 2 in
*Precedence Semantics* below) ignores those allowlists entirely when
`roles[]` is present in the JWT — populating them creates a second,
silently-bypassed source of truth.

The legacy email allowlist (`PORTAL_AUTHZ_ADMIN_GROUPS` /
`PORTAL_AUTHZ_USER_GROUPS`) is an **alternative** posture for stamps
that don't want to do per-stamp Entra role assignments. In that
posture you skip `-CreateAppRoles`, leave
`PORTAL_AUTHZ_DEFAULT_ROLE=none`, and populate the email allowlists.
The engine consults them since no role claim is present.

For the legacy "any tenant user gets `user`" open posture (sandbox
stamps only), explicitly set `PORTAL_AUTHZ_DEFAULT_ROLE=user` in the
stamp's `.env`. Without that, the engine denies all non-matched
principals.

### 2b. Advanced: also enable `appRoleAssignmentRequired=true` (optional)

Some operators want Entra itself to block unassigned users before any
token is issued, so denied users see an Entra-side rejection page
instead of the portal's "not authorized" page. To do that, flip
`appRoleAssignmentRequired=true` on the Enterprise Application:

```bash
az ad sp update --id <enterprise-app-object-id> \
  --set appRoleAssignmentRequired=true
```

…or pass `-AssignmentRequired` to `Setup-PortalAuth.ps1` at create time.

> ⚠️ **Caveat — tenants with restricted user-consent.** In tenants
> where user-consent is restricted to verified-publisher apps (e.g.
> the Microsoft corporate tenant), flipping
> `appRoleAssignmentRequired=true` causes the first sign-in by every
> assigned principal to trip an `AADSTS90094` admin-consent prompt for
> the OIDC scopes (`openid profile offline_access`) against Microsoft
> Graph — even though this app declares no API permissions. The flag
> blocks the implicit user-consent grant from being created on the
> user's behalf until they've already signed in once with the flag off.
>
> If you hit this, either:
> - Have a tenant admin pre-grant the OIDC scopes for the app
>   (`oauth2PermissionGrant` for `00000003-0000-0000-c000-000000000000`,
>   scope `openid profile offline_access`, consentType `AllPrincipals`), or
> - Do the one-time per-user dance: flip the flag off, have the user
>   sign in once to accept user-consent, then flip the flag back on, or
> - Skip this step entirely and rely on Step 2 (engine deny-by-default
>   + role assignments) for lockdown. This is the recommended path for
>   most stamps.

### 3. Assign roles

Assign `admin` and `user` either to individual users or to
security groups. Entra flattens security-group membership into the `roles`
claim at token issuance, so assigning a role to a security group and then
managing membership of that group is fine and is how most teams should run.

In the Entra portal: **Enterprise applications → your app → Users and
groups → Add user/group**.

### 4. Align Conditional Access

If your tenant uses Conditional Access policies, target the policy at the app
role rather than at the user list, so the gate moves with the role assignment
without policy edits. The exact policy is your call — this doc just flags it
as the right place to enforce additional posture checks (MFA, device
compliance, etc.).

## Precedence Semantics

Once the steps above are in place, every access token PilotSwarm sees will
carry a non-empty `roles` claim. The portal authorization engine then makes
its decision **from the role claim alone** — the email allowlist is not
consulted for that principal.

For a principal whose token carries **no** `roles` claim (e.g. providers other
than the configured Entra app, or sessions that predate app-role rollout), the
engine falls back to the existing email-allowlist behavior. Nothing changed
for those principals.

Concretely, the engine evaluation order is:

1. Token absent → unauthenticated branch (`PORTAL_AUTH_ALLOW_UNAUTHENTICATED`)
2. Token present **with** `roles` → role-authoritative branch (see below)
3. Token present **without** `roles` → email-allowlist branch (unchanged)
4. Token present, no allowlists configured → driven by
   `PORTAL_AUTHZ_DEFAULT_ROLE`: `none` (the default since v0.1.33)
   denies; `user` or `admin` admits with that role.

When the role-authoritative branch runs and no role matches `admin`/`user`,
the principal is denied with a stable reason string
(`"Roles present but no admin/user role matched"`). This is a deliberate
behavior — a token that explicitly says "this user has role `Whatever`"
should not silently be re-classified through an email allowlist.## Explicit Role Values

The portal matches the JWT `roles` claim by case-insensitive equality
against exactly two values: `admin` and `user`. There is no aliasing,
suffix-strip, or override env var — these are the prescriptive canonical
role values, and the setup script creates exactly these two roles on the
app registration.

Admin-before-user precedence is preserved: if a principal's token carries
both an `admin` role and a `user` role, the engine resolves to `admin`.

If you need additional gate-keeping beyond admin/user (e.g. an auditor
role), define a new app role and check the JWT `roles` claim for it
explicitly in code. Do **not** try to repurpose the built-in admin/user
buckets for finer-grained roles — extra granularity belongs in new app
roles checked explicitly, not aliased onto admin/user.

## Staged Rollout (Fallback Path)

Some operators may want to enable role-driven engine behavior **before**
flipping `appRoleAssignmentRequired=true` — for example, while doing a
phased migration off an email allowlist. This works, but you should
understand the gap.

- Without `appRoleAssignmentRequired=true`, any user in your tenant can
  obtain a token. Their token will not carry a `roles` claim (because no role
  was assigned to them), so they fall through to the email-allowlist branch.
  What happens next depends on whether you have an allowlist configured:
  - **With an email allowlist** (`PORTAL_AUTHZ_ADMIN_GROUPS` or
    `PORTAL_AUTHZ_USER_GROUPS` set): unmatched users are denied at the portal
    layer. This is the supported staged-rollout posture and the recommended
    production posture in restricted tenants.
  - **Without any email allowlist AND with `PORTAL_AUTHZ_DEFAULT_ROLE`
    unset or `=none`** (the default since v0.1.33): the portal engine
    denies role-less principals at the portal layer. Functionally
    equivalent to flipping `appRoleAssignmentRequired=true`, just
    enforced one hop later (portal instead of Entra).
  - **Without any email allowlist AND with
    `PORTAL_AUTHZ_DEFAULT_ROLE=user`** (legacy open posture, explicit
    opt-in): the portal admits role-less principals as `user`. Use this
    only for sandbox stamps — it is **not a security posture** for
    production.
- Side effect: portal logs will see more denied principals than they
  otherwise would (allowlist / deny-by-default case). This is harmless
  but noisier than the Entra-side rejection path.
- Side effect: tenant users get a portal-side "you're not allowed" response
  instead of an Entra-side rejection, which is a slightly worse UX.

For most stamps the engine deny-by-default + Entra role assignments
combo is the **preferred** lockdown posture — it avoids the
AADSTS90094 admin-consent caveat documented in Step 2b. Flip
`appRoleAssignmentRequired=true` only when you have tenant-admin
support to pre-grant OIDC scopes.

## User-Visible Impact

When `appRoleAssignmentRequired=true` is on and a user is not assigned a
role, they see an **Entra-side** rejection page — the standard
"AADSTS50105: The signed in user … is not assigned to a role" message — not
a portal-side error. That's expected. The portal is never reached for those
users.

## Compatibility and Upgrade Notes

If you are running PilotSwarm today with **both** an email allowlist **and**
Entra-issued tokens that carry app-role claims, the new precedence applies
on upgrade:

- Tokens that carry `roles` matching `admin` / `user` are decided from
  those roles, **not** from your email allowlist.
- Tokens that carry only non-matching role values (anything other than
  `admin` / `user`) are denied with a stable reason string — they will
  **not** fall through to the allowlist. If you previously relied on
  irrelevant role claims being ignored, you must either:
  1. Remove the app-role assignments (or the app-role definitions) so the
     `roles` claim is absent again and the allowlist branch runs, or
  2. Migrate your allowlist entries into `admin` / `user` role
     assignments on the app registration.
- Tokens that don't carry `roles` at all are unaffected — the allowlist
  branch still runs.

The recommended path is to embrace the new behavior and migrate your
allowlist into `admin` / `user` role assignments.

## A Note on Variable Names

Despite the existing variable names `PORTAL_AUTHZ_ADMIN_GROUPS` /
`PORTAL_AUTHZ_USER_GROUPS`, the legacy email-allowlist path matches against
`principal.email`, **not** against the JWT `groups` claim. The variable
names predate the current implementation. The roles-mode path acts on the
JWT `roles` claim, which is a separate signal and has no env-var knobs of
its own.

## Operational Note: Pod Restart Required for Env Changes

The portal caches the resolved authorization policy at process startup.
Changes to any `PORTAL_AUTHZ_*` env var only take effect after the portal
process (or pod, on AKS) is restarted.

## See Also

- Design rationale: [`docs/proposals/portal-auth-provider-and-authz.md`](../../proposals/portal-auth-provider-and-authz.md)
  (Phase 2.5).
- Follow-up tracking: [`docs/proposals/portal-auth-config-reloader.md`](../../proposals/portal-auth-config-reloader.md).
- Portal auth quick reference: [`packages/app/web/README.md`](../../../packages/app/web/README.md).
- AKS deployment: [`docs/deploying-to-aks.md`](./aks.md).
