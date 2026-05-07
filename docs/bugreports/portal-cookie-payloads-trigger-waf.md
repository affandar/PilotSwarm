# Portal cookie payloads trigger WAF SQLi false positives

## Summary

The portal sets at least one cookie whose value is a stringified JSON object
(`pilotswarm_session_owner_filter`). MSAL also sets several state cookies whose
values contain JSON (`msal.interaction.status`, etc.). When a downstream
deployment puts the portal behind Azure Front Door + Application Gateway with
the Microsoft DefaultRuleSet 2.1 / OWASP CRS 3.2 in **Prevention** mode, the
WAF parses every cookie value and the JSON payloads trigger SQLi false
positives:

- `Microsoft_DefaultRuleSet-2.1-SQLI-942200` — "MySQL comment-/space-obfuscated
  injections and backtick termination"
- `Microsoft_DefaultRuleSet-2.1-SQLI-942340` — "basic SQL authentication bypass
  attempts 3/3"
- `Microsoft_DefaultRuleSet-2.1-SQLI-942370` — "classic SQL injection probings
  2/3"

Once the cumulative anomaly score reaches the WAF block threshold, rule
`949110 Inbound Anomaly Score Exceeded` blocks the request. The user sees the
AFD or AppGw "request blocked" page after a successful sign-in (initial GET
works, then `/api/bootstrap` or `/api/rpc` hits the threshold once cookies
are sent).

## Reproduction

1. Deploy the portal behind AFD + AppGw with managed-rule-sets in Prevention
   mode (the default in this repo's bicep).
2. Sign in.
3. Once `pilotswarm_session_owner_filter=...` and `msal.interaction.status=...`
   cookies are present in the browser, refresh the portal.
4. Observe AFD or AppGw `403` block page.

WAF logs (via Log Analytics → `AzureDiagnostics`,
`Category == "FrontDoorWebApplicationFirewallLog"`) show the matched data is
the literal cookie value, e.g.:

```
Matched Data: {"all":false,"includeSystem":true,...,"ownerKeys":[]}
  found within CookieValue:pilotswarm_session_owner_filter
```

## Why this is a portal bug, not a WAF tuning bug

- HTTP cookies should hold small opaque values (session IDs, feature flags,
  short tokens). Embedding stringified JSON objects in cookie values is an
  anti-pattern: every request carries the full JSON to the server, even though
  the server doesn't need it for non-UI-state requests.
- Cookie payloads cross every network device on the request path (CDNs, WAFs,
  reverse proxies, application gateways). Any of them is free to inspect or
  reject the contents. Having the WAF reject them is "working as designed"
  from the WAF's point of view — its job is to detect SQL-like patterns in
  request data, and JSON with quotes / braces / backticks is exactly what
  many OWASP SQLi rules look for.
- The same data fits naturally in `localStorage` (UI state) or as a server-
  side session record keyed by an opaque session ID cookie.

## Current workaround (in repo)

The bicep WAF policies in this repo carry per-cookie exclusions for the known
offenders:

- `deploy/services/global-infra/bicep/frontdoor-waf-policy.bicep`
- `deploy/services/base-infra/bicep/application-gateway.bicep`

Specifically, `RequestCookieNames` exclusions for:

- `pilotswarm_session_owner_filter` (Equals)
- `msal.interaction.status` (Equals)
- `msal*` (StartsWith — covers all MSAL-managed cookies)

These exclusions silence the false positives but keep the rest of the WAF
ruleset active.

## Proposed long-term fix

1. **Portal: move `pilotswarm_session_owner_filter` to `localStorage`.** This
   filter is browser-local UI state. The server never reads it. There is no
   reason to put it in a cookie at all. Once it's in `localStorage`, the WAF
   never sees the JSON and the cookie-name exclusion can be removed from
   bicep.

2. **MSAL: switch `storeAuthStateInCookie: false`.** MSAL writes auth state
   (PKCE verifier, nonce, interaction status) into cookies that grow as
   sessions accumulate. With `cacheLocation: "sessionStorage"` already in
   place, the cookie copy is unnecessary in modern browsers and only adds
   request-header weight. This was already discussed in
   `packages/portal/public/app.js` and `packages/portal/src/auth/providers/entra.js`.

3. **Audit the portal for any other cookie writes whose values are
   JSON / structured.** A small lint or grep for `document.cookie =` and
   `Set-Cookie:` on the server side that surfaces non-opaque values would
   prevent regression.

After (1) + (2) ship, the per-cookie WAF exclusions in bicep can be removed,
which tightens the security posture across all downstream deployments that
adopt this IaC pattern.

## Related WAF mechanics worth remembering

- Excluding the `Cookie` request header (`RequestHeaderNames Equals Cookie`)
  is **not sufficient** to silence per-cookie matches. The WAF re-parses the
  Cookie header into `CookieValue:<name>` match variables, which are
  evaluated independently. Per-cookie exclusions must be declared at
  `RequestCookieNames`.
- The AFD WAF policy resource type does not support
  `Microsoft.Insights/diagnosticSettings` directly. Configure diag settings
  on the parent Front Door profile to capture the
  `FrontDoorWebApplicationFirewallLog` category.
- AFD WAF policy changes can take 5–10 minutes to propagate to all edge POPs
  even after the API call returns success. AppGw WAF propagates in roughly
  30–60 seconds.
