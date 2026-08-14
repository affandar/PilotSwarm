// ==============================================================================
// WAF policy for Azure Front Door Premium.
//
// Adapted from an internal reference deployment
// frontdoor-waf-policy.bicep. The `wafMode` is parameterized so a single
// template backs both environments:
//   dev  -> Detection  (log only; never block during bring-up)
//   prod -> Prevention (block matched threats)
// ==============================================================================

@description('WAF policy name. Must be unique within the subscription.')
param wafPolicyName string

@description('WAF mode. Detection logs threats; Prevention blocks them.')
@allowed([
  'Detection'
  'Prevention'
])
param wafMode string = 'Prevention'

@description('Location for the WAF policy. Must be `global` for Front Door WAF.')
param location string = 'global'

@description('Operator-supplied custom WAF rules merged into properties.customRules.rules AFTER the always-applied platformCustomRules below. Defaults to []. Populate via --parameters customRules=@<file.json> (e.g. corpnet allow-list rules) without checking values into source. Operator rules must use priority >= 100 — priorities 93-99 are reserved for platform-invariant rules (see platformCustomRules).')
param customRules array = []

@description('Managed rule sets applied to every request. Defaults to Microsoft DefaultRuleSet 2.1 + BotManager 1.1, matching the reference deployment. The DefaultRuleSet exclusions cover request attributes that carry opaque structured payloads (bearer JWTs, MSAL state cookies, portal UI-state cookies) whose base64 / JSON content routinely matches OWASP SQLi/XSS rules and produces false-positive blocks. Token validation (issuer / audience / signature) happens at the portal via JWKS — there is no security benefit to scanning these.')
param managedRuleSets array = [
  {
    ruleSetType: 'Microsoft_DefaultRuleSet'
    ruleSetVersion: '2.1'
    ruleSetAction: 'Block'
    exclusions: [
      {
        matchVariable: 'RequestHeaderNames'
        selectorMatchOperator: 'Equals'
        selector: 'Authorization'
      }
      {
        matchVariable: 'RequestHeaderNames'
        selectorMatchOperator: 'Equals'
        selector: 'Cookie'
      }
      // Per-cookie exclusions. WAF re-parses the Cookie header into individual
      // CookieValue:<name> match variables, so the Cookie header exclusion above
      // is not sufficient — exclusions must also be declared at RequestCookieNames.
      {
        matchVariable: 'RequestCookieNames'
        selectorMatchOperator: 'StartsWith'
        selector: 'msal'
      }
      {
        matchVariable: 'RequestCookieNames'
        selectorMatchOperator: 'Equals'
        selector: 'msal.interaction.status'
      }
      // Portal session-owner-filter cookie carries a JSON object (UI state).
      // TODO: portal should move this to localStorage so the WAF never sees it
      // (see docs/bugreports/portal-cookie-payloads-trigger-waf.md). Until then,
      // this exclusion is required to avoid SQLI-942200 false positives.
      {
        matchVariable: 'RequestCookieNames'
        selectorMatchOperator: 'Equals'
        selector: 'pilotswarm_session_owner_filter'
      }
    ]
  }
  {
    ruleSetType: 'Microsoft_BotManagerRuleSet'
    ruleSetVersion: '1.1'
  }
]

// ==============================================================================
// Platform-invariant custom rules
// ==============================================================================
// Rules every PilotSwarm deployment needs, applied unconditionally BEFORE any
// operator-supplied customRules. These are false-positive workarounds (same
// class as the managed-rule exclusions above), NOT operator/env allow-lists, so
// they live in committed source rather than a per-env WAF_CUSTOM_RULES_FILE —
// that keeps fresh instances self-healing.
//
// Priority band: 93-99 reserved for platform-invariant rules; operator rules
// (via customRules param) use >= 100. Front Door requires unique priorities.
//
//   * AllowMcpMessagesPath (prio 95): the MCP transport POSTs freeform prompt
//     bodies to `/messages`. That text routinely trips OWASP/DRS SQLi/XSS
//     anomaly scoring and produces false-positive blocks. A path-scoped Allow
//     custom rule is evaluated before managed rules and short-circuits, which
//     is the documented remedy for body-scan false positives on a known-safe
//     endpoint. Body inspection still applies to every other path.
//
// HACK / TODO (tracked: docs/bugreports/caller-mcp-url-in-body-triggers-waf.md):
// This is a blunt workaround, not a real fix. A path-scoped Allow disables ALL
// managed-rule inspection for `/messages` — for EVERY caller, authenticated or
// not — which is far broader than "ignore false positives on known-safe prompt
// text". We accept it today only because the endpoint sits behind Entra auth and
// the block is a pure false positive. Replace with proper support when able, e.g.:
//   * tune/exclude only the specific DRS rule IDs that fire on prompt bodies
//     (RequestBodyPostArgNames/Values), instead of allow-listing the whole path;
//   * OR move MCP prompt bodies off a WAF-inspected request body (e.g. size/enc
//     that the platform can attest), so managed rules never score them.
// REVISIT ON OBO: when we move to On-Behalf-Of auth, `/messages` carries
// per-user delegated context and MUST regain real request-body inspection — a
// blanket Allow here would let a compromised/hostile caller bypass the WAF for
// that path entirely. Re-scope this rule (per-identity / rule-ID exclusion) as
// part of the OBO cutover; do not ship OBO with this path-wide Allow in place.
var platformCustomRules = [
  {
    name: 'AllowMcpMessagesPath'
    priority: 95
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    rateLimitDurationInMinutes: 0
    rateLimitThreshold: 0
    action: 'Allow'
    matchConditions: [
      {
        matchVariable: 'RequestUri'
        operator: 'Contains'
        negateCondition: false
        matchValue: [
          '/messages'
        ]
        transforms: []
      }
    ]
  }
]

// ==============================================================================
// WAF Policy
// ==============================================================================

resource wafPolicy 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = {
  name: wafPolicyName
  location: location
  sku: {
    name: 'Premium_AzureFrontDoor'
  }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: wafMode
      requestBodyCheck: 'Enabled'
    }
    managedRules: {
      managedRuleSets: managedRuleSets
    }
    customRules: {
      rules: concat(platformCustomRules, customRules)
    }
  }
  tags: {}
}

// ==============================================================================
// Outputs
// ==============================================================================

@description('WAF policy resource ID (consumed by the Front Door profile securityPolicy binding).')
output wafPolicyId string = wafPolicy.id

@description('WAF policy name.')
output wafPolicyName string = wafPolicy.name

// ==============================================================================
// Diagnostic settings — the AFD WAF policy resource type does not directly
// support Microsoft.Insights/diagnosticSettings (Azure rejects with
// `ResourceTypeNotSupported`). WAF rule matches and blocks ARE emitted by the
// parent Front Door profile under the `FrontDoorWebApplicationFirewallLog`
// category, which is captured by the diagnostic setting on
// `frontdoor-profile.bicep`. No diag setting is configured here.
// ==============================================================================
