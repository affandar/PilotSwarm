import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BICEP_ROOT = join(REPO_ROOT, "deploy", "services", "base-infra", "bicep");
const MANAGEMENT_ROOT = join(REPO_ROOT, "deploy", "services", "management-hub", "bicep");

function read(name) {
  return readFileSync(join(BICEP_ROOT, name), "utf8");
}

function readManagement(name) {
  return readFileSync(join(MANAGEMENT_ROOT, name), "utf8");
}

function assertHas(source, pattern, message) {
  assert.match(source, pattern, message);
}

function moduleBlock(source, moduleName) {
  const start = source.indexOf(`module ${moduleName} `);
  if (start < 0) return "";
  const next = source.indexOf("\nmodule ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test("strictPrivate is opt-in and pool/backup defaults preserve the legacy profile", () => {
  const main = read("main.bicep");
  const params = read("base-infra.params.template.json");

  assertHas(main, /param strictPrivate bool = false/, "strictPrivate must default false");
  assertHas(main, /param systemPoolCount int = 1/, "system pool initial count must preserve 1");
  assertHas(main, /param systemPoolMinCount int = 1/, "system pool minimum must preserve 1");
  assertHas(main, /param systemPoolMaxCount int = 5/, "system pool maximum must preserve 5");
  assertHas(main, /param userPoolCount int = 2/, "user pool initial count must preserve 2");
  assertHas(main, /param userPoolMinCount int = 1/, "user pool minimum must preserve 1");
  assertHas(main, /param userPoolMaxCount int = 10/, "user pool maximum must preserve 10");
  assertHas(main, /param postgresBackupRetentionDays int = 7/, "backup default must preserve 7 days");

  for (const [name, placeholder] of [
    ["strictPrivate", "\\$\\{STRICT_PRIVATE\\}"],
    ["systemPoolCount", "\\$\\{AKS_SYSTEM_POOL_INITIAL_COUNT\\}"],
    ["systemPoolMinCount", "\\$\\{AKS_SYSTEM_POOL_MIN_COUNT\\}"],
    ["systemPoolMaxCount", "\\$\\{AKS_SYSTEM_POOL_MAX_COUNT\\}"],
    ["userPoolCount", "\\$\\{AKS_USER_POOL_INITIAL_COUNT\\}"],
    ["userPoolMinCount", "\\$\\{AKS_USER_POOL_MIN_COUNT\\}"],
    ["userPoolMaxCount", "\\$\\{AKS_USER_POOL_MAX_COUNT\\}"],
    ["postgresBackupRetentionDays", "\\$\\{POSTGRES_BACKUP_RETENTION_DAYS\\}"],
  ]) {
    assertHas(
      params,
      new RegExp(`"${name}"\\s*:\\s*\\{\\s*"value"\\s*:\\s*${placeholder}\\s*\\}`),
      `${name} template must be environment-driven`,
    );
  }
});

test("strict-private recovery and monitoring inputs are wired into BaseInfra", () => {
  const main = read("main.bicep");
  const params = read("base-infra.params.template.json");
  const alerts = read("monitoring-alerts.bicep");

  assertHas(main, /param storageDeleteRetentionDays int = 7/);
  assertHas(main, /param monitorAlertEmail string = ''/);
  assertHas(main, /blobDeleteRetentionDays:\s*storageDeleteRetentionDays/);
  assertHas(main, /containerDeleteRetentionDays:\s*storageDeleteRetentionDays/);
  assertHas(main, /module MonitoringAlerts[\s\S]*if \(!empty\(monitorAlertEmail\)\)/);
  assertHas(params, /\$\{STORAGE_DELETE_RETENTION_DAYS\}/);
  assertHas(params, /\$\{MONITOR_ALERT_EMAIL\}/);
  assertHas(alerts, /Microsoft\.Insights\/actionGroups@2023-01-01/);
  assertHas(alerts, /Microsoft\.Insights\/scheduledQueryRules@2023-12-01/);
  assertHas(alerts, /ResponsibleAIPolicyViolation/);
  assertHas(alerts, /flux-system/);
  assertHas(alerts, /format\([\s\S]*serviceNamespace\)/);
  assertHas(alerts, /MICROSOFT\.DBFORPOSTGRESQL/);
});

test("AKS strict-private API and all node-pool counts are parameterized", () => {
  const aks = read("aks.bicep");

  for (const token of [
    "count: systemPoolCount",
    "minCount: systemPoolMinCount",
    "maxCount: systemPoolMaxCount",
    "count: userPoolCount",
    "minCount: userPoolMinCount",
    "maxCount: userPoolMaxCount",
  ]) {
    assert.ok(aks.includes(token), `AKS module missing ${token}`);
  }
  assertHas(aks, /enablePrivateCluster:\s*strictPrivate/);
  assertHas(aks, /strictPrivate \? \{\s*enablePrivateClusterPublicFQDN:\s*false/s);

  const main = read("main.bicep");
  for (const name of [
    "systemPoolCount",
    "systemPoolMinCount",
    "systemPoolMaxCount",
    "userPoolCount",
    "userPoolMinCount",
    "userPoolMaxCount",
  ]) {
    assertHas(main, new RegExp(`${name}:\\s*${name}`), `main must thread ${name}`);
  }
});

test("service modules fail closed only when strictPrivate is enabled", () => {
  const acr = read("acr.bicep");
  assertHas(acr, /name:\s*strictPrivate \? 'Premium' : skuName/);
  assertHas(acr, /publicNetworkAccess:\s*strictPrivate \? 'Disabled' : 'Enabled'/);

  const storage = read("storage.bicep");
  assertHas(storage, /allowSharedKeyAccess:\s*!strictPrivate/);
  assertHas(storage, /defaultToOAuthAuthentication:\s*strictPrivate/);
  assertHas(storage, /publicNetworkAccess:\s*strictPrivate \? 'Disabled' : 'Enabled'/);
  assertHas(storage, /isVersioningEnabled:\s*true/);
  assertHas(storage, /deleteRetentionPolicy:\s*\{\s*enabled:\s*true/s);
  assertHas(storage, /containerDeleteRetentionPolicy:\s*\{\s*enabled:\s*true/s);

  const keyVault = read("keyvault.bicep");
  assertHas(keyVault, /publicNetworkAccess:\s*strictPrivate \? 'Disabled' : 'Enabled'/);
  assertHas(keyVault, /bypass:\s*strictPrivate \? 'None' : 'AzureServices'/);
  assertHas(keyVault, /defaultAction:\s*strictPrivate \? 'Deny' : 'Allow'/);

  const foundry = read("foundry.bicep");
  assertHas(foundry, /publicNetworkAccess:\s*strictPrivate \? 'Disabled' : 'Enabled'/);
  assertHas(foundry, /defaultAction:\s*strictPrivate \? 'Deny' : 'Allow'/);
  assertHas(foundry, /disableLocalAuth:\s*false/, "Foundry API-key behavior must remain enabled");
});

test("PostgreSQL strict-private mode is AAD-only without public firewall bootstrap", () => {
  const postgres = read("postgres.bicep");

  assertHas(postgres, /passwordAuth:\s*strictPrivate \? 'Disabled' : 'Enabled'/);
  assertHas(postgres, /publicNetworkAccess:\s*strictPrivate \? 'Disabled' : 'Enabled'/);
  assertHas(postgres, /backupRetentionDays:\s*backupRetentionDays/);
  assertHas(postgres, /strictPrivate \? \{\} : \{\s*administratorLogin:\s*administratorLogin\s*administratorLoginPassword:\s*administratorPassword/s);
  assertHas(postgres, /resource allowAzureServices[\s\S]*= if \(!strictPrivate\)/);
  assertHas(postgres, /resource aadPrimaryAdmin[\s\S]*= if \(!strictPrivate && !empty\(aadAdminPrincipalId\)\)/);

  const main = read("main.bicep");
  assertHas(main, /module PostgresStrictPrivateAadAdmin[\s\S]*if \(strictPrivate && deployPostgres\)/);
  assertHas(main, /dependsOn:\s*\[\s*PostgresPrivateEndpoint\s*\]/s);

  const aadAdmin = read("postgres-aad-admin.bicep");
  assertHas(aadAdmin, /flexibleServers\/administrators@2023-12-01-preview/);
  assertHas(aadAdmin, /name:\s*primaryPrincipalId/);
});

test("strict-private VNet and service Private Link DNS contract is complete", () => {
  const vnet = read("vnet.bicep");
  assertHas(vnet, /name:\s*privateEndpointSubnetName[\s\S]*privateEndpointNetworkPolicies:\s*'Disabled'/);
  assertHas(vnet, /var privateSubnets = strictPrivate \? concat\(baseSubnets, privateEndpointSubnetEntry\) : baseSubnets/);

  const pe = read("private-endpoint.bicep");
  assertHas(pe, /Microsoft\.Network\/privateEndpoints@2024-01-01/);
  assertHas(pe, /Microsoft\.Network\/privateDnsZones@2020-06-01/);
  assertHas(pe, /Microsoft\.Network\/privateEndpoints\/privateDnsZoneGroups@2024-01-01/);
  assertHas(pe, /groupIds:\s*\[\s*groupId\s*\]/s);
  assertHas(pe, /privateDnsZoneId:\s*privateDnsZone\.id/);
  assertHas(pe, /virtualNetwork:\s*\{\s*id:\s*vnetId/s);

  const main = read("main.bicep");
  const contracts = [
    ["AcrPrivateEndpoint", "registry", "privatelink.azurecr.io"],
    ["StoragePrivateEndpoint", "blob", "blobPrivateDnsZoneName"],
    ["KeyVaultPrivateEndpoint", "vault", "privatelink.vaultcore.azure.net"],
    ["PostgresPrivateEndpoint", "postgresqlServer", "privatelink.postgres.database.azure.com"],
    ["FoundryPrivateEndpoint", "account", "privatelink.cognitiveservices.azure.com"],
  ];
  for (const [moduleName, groupId, zone] of contracts) {
    const block = moduleBlock(main, moduleName);
    assert.ok(block, `${moduleName} must exist`);
    assert.ok(block.includes(`groupId: '${groupId}'`), `${moduleName} must use group ${groupId}`);
    assert.ok(block.includes(zone), `${moduleName} must use zone ${zone}`);
    assert.ok(block.includes("strictPrivate"), `${moduleName} must be gated by strictPrivate`);
  }
  assertHas(main, /var blobPrivateDnsZoneName = 'privatelink\.blob\.\$\{environment\(\)\.suffixes\.storage\}'/);
});

test("management hub exposes only Bastion publicly and prevents spoke transit", () => {
  const main = readManagement("main.bicep");
  assertHas(main, /Microsoft\.Network\/bastionHosts@2024-05-01/);
  assertHas(main, /name:\s*'Standard'/);
  assertHas(main, /enableTunneling:\s*true/);
  assertHas(main, /AADSSHLoginForLinux/);
  assertHas(main, /disablePasswordAuthentication:\s*true/);
  assertHas(main, /allowForwardedTraffic:\s*false/g);
  assertHas(main, /allowGatewayTransit:\s*false/g);
  assertHas(main, /useRemoteGateways:\s*false/g);
  assertHas(main, /Microsoft\.Insights\/diagnosticSettings@2021-05-01-preview/);
  assert.doesNotMatch(moduleBlock(main, "spokeToHub"), /publicIP/i);
  assert.doesNotMatch(main.match(/resource nic[\s\S]*?resource vm /)?.[0] ?? "", /publicIPAddress/);
});
