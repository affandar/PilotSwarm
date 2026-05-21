# Portal Auth Config Reloader

## Summary

Add a config-reloader pattern to the portal authorization layer so that changes
to `PORTAL_AUTHZ_*` env vars (group allowlists, role-name lists, default role,
allow-unauthenticated, etc.) can take effect without restarting the portal
process or pod. Today every change to these env vars requires a pod restart
because `getProviderBundle()` caches the authorization policy for the process
lifetime with no invalidation path.

## Motivation

The portal's auth bootstrap caches the resolved provider bundle (provider
config + authorization policy) at module level on first call and reuses it
forever:

```js
// packages/portal/auth/index.js
let cachedBundle = null;
export function getProviderBundle(env = process.env) {
  if (cachedBundle) return cachedBundle;
  // ... build provider + policy from env ...
  cachedBundle = { provider, authorizationPolicy };
  return cachedBundle;
}
```

This was acceptable when the only knob was `PORTAL_AUTHZ_ADMIN_GROUPS` /
`PORTAL_AUTHZ_USER_GROUPS` — small, well-known, infrequently changed. With the
**Entra App-Roles Modernization** feature
(`.paw/work/entra-app-roles-modernization/`, `docs/portal-entra-app-roles.md`)
the surface grows:

- `PORTAL_AUTHZ_ENTRA_ADMIN_ROLE_NAMES`
- `PORTAL_AUTHZ_ENTRA_USER_ROLE_NAMES`

Operators tuning role names against a live Entra app registration will hit
this friction more often, and the pod-restart requirement is now an
explicitly-documented operational caveat in the new operator runbook. We
should remove the caveat rather than canonize it.

## Design Sketch

This is a tracking proposal — a full design is deferred. Open questions /
candidate approaches:

1. **In-process re-read on signal.** A `SIGHUP` (or platform-equivalent) handler
   that calls `getProviderBundle({ reload: true })`, atomically swapping the
   cached bundle. Cheap, but requires a process-level signal and isn't
   ergonomic on AKS without a sidecar.

2. **TTL-based re-read.** A short TTL (e.g. 30s) on `cachedBundle` with
   transparent rebuild on access. Simple; trades a tiny per-request cost for
   eventual consistency.

3. **Config file with watcher.** Move `PORTAL_AUTHZ_*` into a mounted
   `ConfigMap` JSON file and watch the file for changes. Plays well with
   Kubernetes' existing ConfigMap update flow (atomic symlink swap).

4. **Management-API endpoint.** A privileged endpoint that triggers reload.
   Mirrors how some other dynamic settings get refreshed today.

Whichever approach is chosen, the public contract should be:

- `authorizePrincipal(principal, explicitPolicy)` continues to work — tests
  already bypass the cache by passing an explicit policy, so this proposal is
  purely about runtime ergonomics.
- The `AuthorizationDecision` shape MUST NOT change.
- The reload must be atomic (no torn reads of a half-built policy).

## Non-Goals

- This is not a request for live reload of provider type (e.g. flipping from
  `entra` to `none` at runtime). Provider type changes can keep the
  restart-required posture.
- This is not a request for per-request policy evaluation (the per-process
  cache is correct; only the lack of *invalidation* is the problem).

## Filed By

Surfaced during the Entra App-Roles Modernization work (see
`docs/proposals/portal-auth-provider-and-authz.md` and
`docs/portal-entra-app-roles.md`). The underlying caching behavior predates
that feature; this proposal exists so the follow-up isn't lost.
