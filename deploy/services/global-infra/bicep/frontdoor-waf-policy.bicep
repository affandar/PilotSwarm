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

@description('Custom WAF rules merged into properties.customRules.rules. Defaults to []. Populate via --parameters customRules=@<file.json> (e.g. corpnet allow-list rules) without checking values into source.')
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
      rules: customRules
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
