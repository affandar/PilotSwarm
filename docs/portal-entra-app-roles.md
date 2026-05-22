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

### 1. Define `Portal.Admin` and `Portal.User` app roles

In the Entra portal, open **App registrations → your app → App roles** and
create:

| Display name | Value         | Allowed member types |
| ------------ | ------------- | -------------------- |
| Portal Admin | `Portal.Admin` | Users/Groups         |
| Portal User  | `Portal.User`  | Users/Groups         |

Equivalent CLI sketch:

```bash
az ad app update --id <client-id> --app-roles '[
  {
    "displayName": "Portal Admin",
    "value": "Portal.Admin",
    "description": "Portal administrators",
    "id": "<new-guid>",
    "isEnabled": true,
    "allowedMemberTypes": ["User"]
  },
  {
    "displayName": "Portal User",
    "value": "Portal.User",
    "description": "Portal users",
    "id": "<new-guid>",
    "isEnabled": true,
    "allowedMemberTypes": ["User"]
  }
]'
```

Role values are operator-chosen. The portal accepts any value whose
suffix-after-last-dot is `admin` or `user` (case-insensitive) — so
`Portal.Admin`, `pilotswarm.admin`, and a bare `admin` all map to the
engine-level `admin` role. See [Explicit-list override](#explicit-list-override)
below if you want a stricter mapping.

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

Assign `Portal.Admin` and `Portal.User` either to individual users or to
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
should not silently be re-classified through an email allowlist.

## Explicit-List Override

By default the engine uses **suffix-strip** matching: the substring after the
last `.` in each role value is lowercased and compared to `admin`/`user`. This
covers the common naming styles (`Portal.Admin`, `pilotswarm.admin`, plain
`admin`).

If you want stricter control, set explicit role-name lists:

```bash
PORTAL_AUTHZ_ENTRA_ADMIN_ROLE_NAMES=Portal.Admin
PORTAL_AUTHZ_ENTRA_USER_ROLE_NAMES=Portal.User
```

When an explicit list is configured for an engine role, it **replaces** (does
not augment) the suffix-strip default for that role. Matching is
case-insensitive exact-match against the listed values. The two env vars are
independent — you can pin admin while leaving user on the default, or vice
versa.

Admin-before-user precedence is preserved regardless of which matcher path is
in use: if a principal's token carries both an admin role and a user role,
the engine resolves to `admin`.

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
Entra-issued tokens that carry app-role claims (i.e. your app already defines
roles even though the portal previously ignored them as anything other than a
last-resort fallback), the new precedence applies on upgrade:

- Tokens that carry `roles` are decided from those roles, **not** from your
  email allowlist.
- Tokens that don't carry `roles` are unaffected.

Two ways to opt out of the new precedence if it doesn't fit your deployment:

1. **Pin role-name lists to a non-matching sentinel.** Set
   `PORTAL_AUTHZ_ENTRA_ADMIN_ROLE_NAMES=__none__` and
   `PORTAL_AUTHZ_ENTRA_USER_ROLE_NAMES=__none__`. The role-authoritative
   branch will see no match and deny — at which point you should plan a real
   migration rather than holding the new behavior off forever.
2. **Strip the `roles` claim from token issuance.** Remove the app-role
   assignments (or the app-role definitions) so issued tokens no longer
   include a `roles` claim. The engine then falls through to the
   email-allowlist branch as before.

The recommended path is to embrace the new behavior and migrate your
allowlist into app-role assignments.

## A Note on Variable Names

Despite the existing variable names `PORTAL_AUTHZ_ADMIN_GROUPS` /
`PORTAL_AUTHZ_USER_GROUPS`, the legacy email-allowlist path matches against
`principal.email`, **not** against the JWT `groups` claim. The variable
names predate the current implementation. The two new variables introduced
by this feature —
`PORTAL_AUTHZ_ENTRA_ADMIN_ROLE_NAMES` /
`PORTAL_AUTHZ_ENTRA_USER_ROLE_NAMES` — act on the JWT `roles` claim, which
is a separate signal.

## Operational Note: Pod Restart Required for Env Changes

The portal caches the resolved authorization policy at process startup. Changes
to `PORTAL_AUTHZ_ENTRA_ADMIN_ROLE_NAMES`, `PORTAL_AUTHZ_ENTRA_USER_ROLE_NAMES`,
or any other `PORTAL_AUTHZ_*` env var only take effect after the portal
process (or pod, on AKS) is restarted. This is the same behavior the existing
`PORTAL_AUTHZ_ADMIN_GROUPS` / `PORTAL_AUTHZ_USER_GROUPS` vars have today.

The friction is tracked in
[`docs/proposals/portal-auth-config-reloader.md`](./proposals/portal-auth-config-reloader.md);
a future change should make these knobs hot-reloadable.

## See Also

- Design rationale: [`docs/proposals/portal-auth-provider-and-authz.md`](./proposals/portal-auth-provider-and-authz.md)
  (Phase 2.5).
- Follow-up tracking: [`docs/proposals/portal-auth-config-reloader.md`](./proposals/portal-auth-config-reloader.md).
- Portal auth quick reference: [`packages/portal/README.md`](../packages/portal/README.md).
- AKS deployment: [`docs/deploying-to-aks.md`](./deploying-to-aks.md).
