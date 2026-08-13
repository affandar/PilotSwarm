// ==============================================================================
// WAF policy for Azure Front Door Premium.
//
// Ported from PilotSwarm PR #15 (deploy/services/global-infra/bicep/
// frontdoor-waf-policy.bicep, commit c759b7a). The `wafMode` is parameterized
// so a single template backs both environments:
//   dev  -> Detection  (log only; never block during bring-up)
//   prod -> Prevention (block matched threats)
//
// The DefaultRuleSet exclusions cover request attributes that carry opaque
// structured payloads (bearer JWTs, MSAL state cookies, portal UI-state
// cookies) whose base64 / JSON content routinely matches OWASP SQLi/XSS rules
// and produces false-positive blocks. Token validation (issuer / audience /
// signature) happens at the portal via JWKS — there is no security benefit to
// scanning these. The `pilotswarm_session_owner_filter` cookie originates from
// the PilotSwarm portal (consumed by waldemort via the `pilotswarm` npm
// package); the exclusion is retained verbatim.
//
// They also cover the PilotSwarm Web API's free-text chat fields (JSON body)
// and JSON-encoded query params — see the inline comments on the
// RequestBodyJsonArgNames / QueryStringArgNames entries below.
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

// Per-rule overrides for the DefaultRuleSet, OPT-IN PER POLICY INSTANCE.
// Deliberately a parameter (default []) and not part of the managedRuleSets
// default below: this template is instantiated twice by main.bicep — the main
// portal policy (gated by the corpnet custom Block rule) and the PUBLIC
// phone-redemption policy (customRules: [], no corp gate). A relaxation baked
// into the shared default would silently apply to the public endpoint too.
//
// Live incident (2026-08-10..13): DRS General-200002 "Failed to parse request
// body" blocked POST /api/v1/agent-packages/upload via anomaly rule 949110.
// The agent-package upload sends files base64-inline in one JSON body; AFD WAF
// inspects only the first 128KB of a body (not configurable on Front Door),
// so bodies past that truncate mid-JSON, fail to parse, and 200002 scores
// critical (+5 = threshold). Exclusions cannot fix a parse failure — there are
// no parsed fields to exclude. The main policy therefore overrides 200002 to
// action Log (visible in FrontDoorWebApplicationFirewallLog, contributes no
// anomaly score); the corp allowlist still gates who reaches managed rules at
// all, and every field-level DRS rule still evaluates parseable bodies.
@description('ruleGroupOverrides for the Microsoft_DefaultRuleSet entry (e.g. the 200002->Log override on the corp-gated main policy). Defaults to [] — no overrides.')
param drsRuleGroupOverrides array = []

@description('Managed rule sets applied to every request. Defaults to Microsoft DefaultRuleSet 2.1 + BotManager 1.1, matching the reference deployment.')
param managedRuleSets array = [
  {
    ruleSetType: 'Microsoft_DefaultRuleSet'
    ruleSetVersion: '2.1'
    ruleSetAction: 'Block'
    ruleGroupOverrides: drsRuleGroupOverrides
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
      // PilotSwarm portal session-owner-filter cookie carries a JSON object
      // (UI state). Cookie originates from the `pilotswarm` web server (consumed via npm
      // by waldemort), so the name is kept verbatim. Exclusion is required to
      // avoid SQLI-942200 false positives until upstream moves it to
      // localStorage.
      {
        matchVariable: 'RequestCookieNames'
        selectorMatchOperator: 'Equals'
        selector: 'pilotswarm_session_owner_filter'
      }
      // Free-text natural-language chat fields in the PilotSwarm Web API JSON
      // bodies (prompts, chat messages, splash art, session titles, answers).
      // Conversational prose routinely matches OWASP SQLi/XSS signatures; auth
      // gates every request (Bearer JWT validated at the portal via JWKS) and
      // there is no security value in SQL-scanning conversational prose.
      // Live incident: DRS SQLI-942380 blocked `initialPrompt` on
      // POST /api/v1/sessions/for-agent — named-agent create broken for
      // Dev Box users (2026-07-22).
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'initialPrompt'
      }
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'prompt'
      }
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'message'
      }
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'splash'
      }
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'splashMobile'
      }
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'title'
      }
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'answer'
      }
      // Additional free-text body fields from the same API protocol
      // (pilotswarm-sdk api/src/protocol.js), same failure class:
      //   reason  — completeSession / cancelSessionGroup / stopFactsEmbedder
      //             human-supplied reason strings.
      //   content — uploadArtifact arbitrary artifact text (base64 for binary).
      //   query   — searchFacts natural-language retrieval query (lexical |
      //             semantic | hybrid); also names structured graph queries,
      //             which are harmless to skip.
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'reason'
      }
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'content'
      }
      {
        matchVariable: 'RequestBodyJsonArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'query'
      }
      // JSON-encoded query params (declared query("json") in the API protocol).
      // Their JSON punctuation (quotes/braces/colons) trips SQLi signatures.
      // Live incident: SQLI-942200 + 942340 blocked the keyset-pagination
      // `cursor` param on GET /api/v1/management/sessions — portal startup 403
      // for accounts with enough sessions to paginate (2026-07-22).
      // eventTypes (session event paging), scopeKeys and tags (readFacts) are
      // the same JSON-in-query-string class, excluded pre-emptively.
      {
        matchVariable: 'QueryStringArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'cursor'
      }
      {
        matchVariable: 'QueryStringArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'eventTypes'
      }
      {
        matchVariable: 'QueryStringArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'scopeKeys'
      }
      {
        matchVariable: 'QueryStringArgNames'
        selectorMatchOperator: 'Equals'
        selector: 'tags'
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
