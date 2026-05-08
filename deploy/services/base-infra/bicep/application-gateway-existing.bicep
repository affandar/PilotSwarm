// ==============================================================================
// PilotSwarm BaseInfra — AGIC-managed arrays read-back.
//
// AGIC dynamically populates the Application Gateway's pools / listeners /
// rules / probes based on Kubernetes Ingress resources. Without preservation,
// re-deploying `application-gateway.bicep` resets these arrays to their
// seed defaults, briefly breaking ingress and (in some races) wedging the
// AppGw into a Failed provisioning state.
//
// This module exists as a separate file because Bicep doesn't allow an
// `existing` reference to the same resource a sibling module is declaring
// (that would produce a self-dependency). Mirrors reference deployment
// `application-gateway-existing.bicep`.
//
// Consumed by `application-gateway.bicep` via a ternary-with-`!` pattern,
// guarded behind the `appGwExists` flag from `check-appgw-exists.bicep`.
// ==============================================================================

@description('Name of the existing Application Gateway whose AGIC-managed arrays we want to read.')
param applicationGatewayName string

resource existingAppGw 'Microsoft.Network/applicationGateways@2024-01-01' existing = {
  name: applicationGatewayName
}

output sslCertificates array = existingAppGw.properties.sslCertificates
// Preserved separately because trusted root certs are uploaded out-of-band
// by `Common/bicep/appgw-add-trusted-root-cert.bicep` (a deployment script
// invoked by Portal/main.bicep). AGIC's backendHttpSettingsCollection
// references these by ARM resource id once the ingress sets the
// `appgw-trusted-root-certificate` annotation; failing to round-trip them
// here makes BaseInfra rebuilds fail with InvalidResourceReference.
output trustedRootCertificates array = existingAppGw.properties.?trustedRootCertificates ?? []
output frontendPorts array = existingAppGw.properties.frontendPorts
output backendAddressPools array = existingAppGw.properties.backendAddressPools
output backendHttpSettingsCollection array = existingAppGw.properties.backendHttpSettingsCollection
output httpListeners array = existingAppGw.properties.httpListeners
output requestRoutingRules array = existingAppGw.properties.requestRoutingRules
output probes array = existingAppGw.properties.probes
output urlPathMaps array = existingAppGw.properties.urlPathMaps
output redirectConfigurations array = existingAppGw.properties.redirectConfigurations
output rewriteRuleSets array = existingAppGw.properties.rewriteRuleSets
