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
(see [`deploy/scripts/auth/`](../deploy/scripts/auth/) and the
[`pilotswarm-portal-app-reg`](../.github/skills/pilotswarm-portal-app-reg/SKILL.md)
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

### 2. Enable `appRoleAssignmentRequired=true` on the Enterprise Application

Open **Enterprise applications → your app → Properties** and set
**Assignment required?** to **Yes**.

This is part of the recommended setup, not a deferred extra. Without it, any
user in your tenant can complete sign-in and be denied at the portal layer
instead of at the identity provider. With it on, unassigned users see an
Entra-side rejection page before they ever reach the portal — quieter logs,
fewer wasted token issuances, and a single source of truth for who has access.

CLI equivalent:

```bash
az ad sp update --id <enterprise-app-object-id> \
  --set appRoleAssignmentRequired=true
```

> **No admin consent required.** The portal app reg declares no API
> permissions and the SPA requests only OIDC standard scopes (`openid`,
> `profile`) at sign-in, so flipping `appRoleAssignmentRequired=true`
> does not block sign-in on a tenant-admin consent grant. Assigned users
> sign in cleanly with zero consent prompt.

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
4. Token present, no allowlists configured → default role

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
    layer. This is the supported staged-rollout posture.
  - **Without any email allowlist**: the portal admits role-less principals
    as the configured `defaultRole` (`user` by default). Staged rollout is
    **not a security posture** in this configuration — any tenant user gets
    `user` access until step 2 (`appRoleAssignmentRequired=true`) is enabled.
    Either configure an allowlist for the rollout window, or close the gap
    immediately by completing step 2.
- Side effect: portal logs will see more denied principals than they
  otherwise would (allowlist case). This is harmless but noisier.
- Side effect: tenant users get a portal-side "you're not allowed" response
  instead of an Entra-side rejection, which is a slightly worse UX.

Close the gap by completing step 2 (enable assignment-required) as soon as
the role-driven path is verified working.

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

- Design rationale: [`docs/proposals/portal-auth-provider-and-authz.md`](./proposals/portal-auth-provider-and-authz.md)
  (Phase 2.5).
- Follow-up tracking: [`docs/proposals/portal-auth-config-reloader.md`](./proposals/portal-auth-config-reloader.md).
- Portal auth quick reference: [`packages/portal/README.md`](../packages/portal/README.md).
- AKS deployment: [`docs/deploying-to-aks.md`](./deploying-to-aks.md).
