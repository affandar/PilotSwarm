// ==============================================================================
// WAF policy for Azure Front Door Premium.
//
// Adapted from postgresql-fleet-manager/src/Deploy/GlobalInfra/bicep/
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

@description('Managed rule sets applied to every request. Defaults to Microsoft DefaultRuleSet 2.1 + BotManager 1.1, matching the fleet-manager reference.')
param managedRuleSets array = [
  {
    ruleSetType: 'Microsoft_DefaultRuleSet'
    ruleSetVersion: '2.1'
    ruleSetAction: 'Block'
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
