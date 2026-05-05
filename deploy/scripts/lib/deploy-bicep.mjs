// Bicep deploy stage (Phase 3, FR-008 + FR-022).
//
// For each module in SERVICE_TO_MODULES[<service>]:
//   1. Render its params template against the env map.
//   2. Run `az deployment <scope> create` with the rendered file.
//   3. Capture `properties.outputs` and merge into env map under the FR-022
//      alias map (with default camelCase → UPPER_SNAKE for unaliased keys).
//
// Subsequent stages (manifests, rollout) see the merged env map in-process.

import { existsSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { run, runJson, log, REPO_ROOT } from "./common.mjs";
import { renderParams } from "./render-params.mjs";
import { SERVICE_TO_MODULES, MODULE_SCOPE } from "./service-info.mjs";
import { saveCache } from "./bicep-outputs-cache.mjs";
import {
  computeTemplateHash,
  computeParamsHash,
  shouldSkipDeploy,
  saveMarker,
} from "./deploy-marker.mjs";

// Bicep main.bicep paths and params templates are derived by convention from
// the module name: deploy/services/<Module>/bicep/{main.bicep,<Module>.params.template.json}.
// This pairs naturally with the manifest-driven service layout — adding a new
// module is a single folder drop with no script changes here.
function moduleBicepPath(moduleName) {
  return `deploy/services/${moduleName}/bicep/main.bicep`;
}
function moduleParamsTemplate(moduleName) {
  return `deploy/services/${moduleName}/bicep/${moduleName}.params.template.json`;
}

// FR-022 alias map: Bicep camelCase output → UPPER_SNAKE env key.
// Keys not in this table fall back to the default camelCase → UPPER_SNAKE rule
// in `aliasFor()` so new outputs flow through automatically.
const OUTPUT_ALIAS = {
  acrLoginServer: "ACR_LOGIN_SERVER",
  acrName: "ACR_NAME",
  keyVaultName: "KV_NAME",
  aksClusterName: "AKS_CLUSTER_NAME",
  blobContainerEndpoint: "BLOB_CONTAINER_ENDPOINT",
  deploymentStorageAccountName: "DEPLOYMENT_STORAGE_ACCOUNT_NAME",
  // Shared `csiIdentity` UAMI (worker + portal federate against the same
  // identity per uami-federation.bicep) → cascades into both services'
  // overlay `.env` substitution in `all` mode.
  csiIdentityClientId: "WORKLOAD_IDENTITY_CLIENT_ID",
  // Worker/Portal bicep each emit their own manifest container as
  // `manifestsContainerName`; since worker and portal are deployed via
  // separate `deploy.mjs` invocations, the env-key DEPLOYMENT_STORAGE_CONTAINER_NAME
  // is unambiguous per-invocation and resolves to the correct service container.
  manifestsContainerName: "DEPLOYMENT_STORAGE_CONTAINER_NAME",
  // BaseInfra-created UAMI consumed by Portal's `approve-private-endpoint.bicep`
  // deployment script. Cascades into Portal.params.template.json.
  approverIdentityResourceId: "APPROVAL_MANAGED_IDENTITY_ID",
  // Portal bicep emits the canonical AFD/AppGw/Ingress hostname as
  // `BackendHostName` (Pascal-case for EV2 scope-binding parity). Aliased
  // into `PORTAL_HOSTNAME` so the manifests step's overlay `.env`
  // substitution picks up the bicep-computed value (matching FM's
  // playgroundservice pattern where the same string is the cert subject,
  // AppGw listener host, and AFD origin host). When this entry is present,
  // it overrides any value seeded from the local env file.
  // ARM serializes output keys as camelCase regardless of bicep declaration casing.
  backendHostName: "PORTAL_HOSTNAME",
  // Foundry endpoint emitted by base-infra when foundryEnabled. Empty
  // when the stamp does not opt into Foundry. Substituted into the worker
  // base `model_providers.json` (`__FOUNDRY_ENDPOINT__` placeholder) at
  // manifest-staging time. See deploy/services/base-infra/bicep/foundry.bicep.
  foundryEndpoint: "FOUNDRY_ENDPOINT",
  foundryAccountName: "FOUNDRY_ACCOUNT_NAME",
};

export async function deployBicep({ service, envName, env, region, stagingDir, moduleListOverride, force }) {
  const modules = moduleListOverride ?? SERVICE_TO_MODULES[service];
  if (!modules || modules.length === 0) {
    log("info", `No Bicep modules for service '${service}'; skipping.`);
    return env;
  }

  if (!existsSync(stagingDir)) mkdirSync(stagingDir, { recursive: true });

  for (const moduleName of modules) {
    await deployOne({ moduleName, service, envName, env, region, stagingDir, force });
  }
  return env;
}

async function deployOne({ moduleName, service, envName, env, region, stagingDir, force }) {
  const scope = MODULE_SCOPE[moduleName];
  if (!scope) throw new Error(`Unknown Bicep scope for module '${moduleName}'`);
  const paramsRel = moduleParamsTemplate(moduleName);
  const bicepRel = moduleBicepPath(moduleName);
  const templateAbs = join(REPO_ROOT, paramsRel);
  const bicepAbs = join(REPO_ROOT, bicepRel);
  if (!existsSync(templateAbs)) throw new Error(`Params template missing: ${templateAbs}`);
  if (!existsSync(bicepAbs)) throw new Error(`Bicep main missing: ${bicepAbs}`);

  // 1) Render params.
  log("info", `[${moduleName}] render params (${paramsRel})`);
  const { renderedPath, substituted } = renderParams({
    module: moduleName,
    templatePath: templateAbs,
    envMap: env,
    outDir: stagingDir,
  });
  log("info", `[${moduleName}] substituted ${substituted.length} placeholders → ${renderedPath}`);

  // 1b) Skip-deploy check. We hash the bicep tree + the rendered params; on
  // an unchanged hash for this env, reuse the prior outputs (already loaded
  // into env from the bicep-outputs cache at orchestrator startup) and
  // bypass `az deployment create` entirely. Bypass with `--force`.
  const templateHash = computeTemplateHash(moduleName);
  const paramsHash = computeParamsHash(renderedPath);
  const decision = shouldSkipDeploy({ envName, moduleName, templateHash, paramsHash, force });
  if (decision.skip) {
    log(
      "info",
      `[${moduleName}] ✔ skipping deploy (${decision.reason}; pass --force to redeploy)`,
    );
    return;
  }
  if (decision.reason !== "no marker") {
    log("info", `[${moduleName}] redeploying (${decision.reason})`);
  }

  // 2) Run az deployment <scope> create.
  const deploymentName = `${moduleName}-${envName}-${(region || "global").replace(/[^a-zA-Z0-9-]/g, "")}`;
  const baseArgs = [
    "deployment",
    scope,
    "create",
    "--name",
    deploymentName,
    "--template-file",
    bicepAbs,
    "--parameters",
    `@${renderedPath}`,
  ];

  // BaseInfra optionally accepts a `localDeploymentPrincipalId` so the storage
  // module can grant Storage Blob Data Contributor to the running user at
  // create time (avoids the post-hoc role-assignment + RBAC propagation race
  // that every fresh stamp would otherwise hit on the manifests upload).
  // EV2 doesn't pass this — its principal already has the role via the
  // ev2-deploy UAMI assignment, and the Bicep param defaults to empty.
  if (moduleName === "base-infra") {
    const localPrincipal = resolveLocalDeploymentPrincipal();
    if (localPrincipal) {
      baseArgs.push(
        "--parameters",
        `localDeploymentPrincipalId=${localPrincipal.id}`,
        "--parameters",
        `localDeploymentPrincipalType=${localPrincipal.type}`,
      );
      log("info", `[${moduleName}] granting Storage Blob Data Contributor to ${localPrincipal.label} via Bicep`);
    }
    // Foundry deployments: when FOUNDRY_ENABLED=true the orchestrator
    // threads the per-stamp deployments JSON file in via
    // `--parameters foundryDeployments=@<file>`. The file lives under
    // deploy/envs/local/<env>/foundry-deployments.json (gitignored).
    // When FOUNDRY_ENABLED=false the bicep param defaults to [] and no
    // file is required. Mirrors the WAF_CUSTOM_RULES_FILE pattern in
    // global-infra below.
    if ((env.FOUNDRY_ENABLED || "").toLowerCase() === "true") {
      const raw = env.FOUNDRY_DEPLOYMENTS_FILE;
      if (!raw) {
        throw new Error(
          `FOUNDRY_ENABLED=true but FOUNDRY_DEPLOYMENTS_FILE is not set. ` +
            `Run \`npm run deploy:new-env -- ${envName} --force\` to scaffold ` +
            `deploy/envs/local/${envName}/foundry-deployments.json, or set the ` +
            `key directly to a JSON array file (gitignored under deploy/envs/local/).`,
        );
      }
      const abs = isAbsolute(raw) ? raw : join(REPO_ROOT, raw);
      if (!existsSync(abs)) {
        throw new Error(
          `FOUNDRY_DEPLOYMENTS_FILE points to a missing file: ${abs}. ` +
            `Either disable Foundry (FOUNDRY_ENABLED=false) or create the JSON ` +
            `array file. See deploy/services/base-infra/bicep/foundry.bicep ` +
            `for the expected entry shape.`,
        );
      }
      baseArgs.push("--parameters", `foundryDeployments=@${abs}`);
      log("info", `[${moduleName}] applying Foundry deployments from ${abs}`);
    }
  }

  // global-infra optionally accepts a custom-rules JSON file via env var
  // WAF_CUSTOM_RULES_FILE — passed straight through to az as
  // `--parameters customRules=@<file>`. The file is gitignored (recommended
  // location: deploy/envs/local/<env>/waf-custom-rules.json) so site-specific
  // rules (e.g. corpnet allow-lists) never need to be checked in. The bicep
  // param defaults to [] when unset so this is purely additive.
  if (moduleName === "global-infra" && env.WAF_CUSTOM_RULES_FILE) {
    const raw = env.WAF_CUSTOM_RULES_FILE;
    const abs = isAbsolute(raw) ? raw : join(REPO_ROOT, raw);
    if (!existsSync(abs)) {
      throw new Error(
        `WAF_CUSTOM_RULES_FILE points to a missing file: ${abs}. ` +
          `Either unset it or create the JSON array file (gitignored under deploy/envs/local/).`,
      );
    }
    baseArgs.push("--parameters", `customRules=@${abs}`);
    log("info", `[${moduleName}] applying custom WAF rules from ${abs}`);
  }

  if (scope === "group") {
    const rg = moduleName === "global-infra" ? env.GLOBAL_RESOURCE_GROUP : env.RESOURCE_GROUP;
    if (!rg) {
      throw new Error(
        `Resource group not set for module ${moduleName} (need RESOURCE_GROUP or GLOBAL_RESOURCE_GROUP).`,
      );
    }
    ensureResourceGroup(rg, region || env.LOCATION);
    baseArgs.push("--resource-group", rg);
  } else if (scope === "sub") {
    baseArgs.push("--location", region || env.LOCATION);
  }

  log("info", `[${moduleName}] az ${baseArgs.join(" ")}`);
  run("az", baseArgs);

  // 3) Capture outputs and merge into env map.
  const showArgs = ["deployment", scope, "show", "--name", deploymentName, "--query", "properties.outputs", "-o", "json"];
  if (scope === "group") {
    const rg = moduleName === "global-infra" ? env.GLOBAL_RESOURCE_GROUP : env.RESOURCE_GROUP;
    showArgs.push("--resource-group", rg);
  }
  const outputs = runJson("az", showArgs);
  if (!outputs || typeof outputs !== "object") {
    log("info", `[${moduleName}] no outputs reported`);
    return;
  }

  let merged = 0;
  const addedKeys = [];
  for (const [outKey, payload] of Object.entries(outputs)) {
    const envKey = OUTPUT_ALIAS[outKey] || aliasFor(outKey);
    const value = payload && typeof payload === "object" && "value" in payload ? payload.value : payload;
    if (value === undefined || value === null) continue;
    env[envKey] = typeof value === "string" ? value : JSON.stringify(value);
    addedKeys.push(envKey);
    merged++;
  }
  log("ok", `[${moduleName}] merged ${merged} outputs into env map`);
  saveCache(envName, addedKeys, env);

  // Persist the success marker so a subsequent invocation can skip this
  // deploy when neither the bicep tree nor the rendered params have
  // changed. Includes the deployment name + region for diagnostics.
  saveMarker(envName, moduleName, {
    deploymentName,
    region: region || env.LOCATION || "",
    templateHash,
    paramsHash,
    deployedAt: new Date().toISOString(),
    outputKeys: addedKeys,
  });
}

// Look up the AAD principal currently signed in to the Azure CLI and return
// `{ id, type, label }` describing it, or `null` if we're not running as an
// AAD user (e.g. service-principal logins like the EV2 deploy MID, which
// already has the role via Bicep — no extra grant needed).
function resolveLocalDeploymentPrincipal() {
  // `az ad signed-in-user show` only succeeds for User-type logins; SPs
  // intentionally fail this with `Insufficient privileges` so it's a clean
  // signal that we shouldn't override the param.
  const probe = run(
    "az",
    ["ad", "signed-in-user", "show", "--query", "{id:id, upn:userPrincipalName}", "-o", "json"],
    { capture: true, allowFail: true },
  );
  if (probe.status !== 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    return null;
  }
  if (!parsed?.id) return null;
  return { id: parsed.id, type: "User", label: parsed.upn || parsed.id };
}

// Ensure the resource group exists before an RG-scoped deployment. Idempotent
// (`az group create` is upsert semantics). EV2 normally provisions RGs via
// rollout infrastructure; in the OSS path we make sure they exist here so
// `az deployment group create` doesn't fail with ResourceGroupNotFound on a
// fresh subscription.
function ensureResourceGroup(name, location) {
  if (!name) throw new Error("ensureResourceGroup: name is required");
  if (!location) throw new Error(`ensureResourceGroup(${name}): location is required`);
  // `az group show` exits non-zero if the RG doesn't exist. allowFail lets us
  // distinguish "missing" (status != 0) from "exists" (status 0) without piping
  // through cmd.exe-hostile JMESPath expressions.
  const probe = run("az", ["group", "show", "--name", name, "-o", "none"], {
    capture: true,
    allowFail: true,
  });
  if (probe.status === 0) {
    log("info", `[rg] ${name} already exists`);
    return;
  }
  log("info", `[rg] creating ${name} in ${location}`);
  run("az", ["group", "create", "--name", name, "--location", location, "-o", "none"]);
}


//   "frontDoorProfileName" → "FRONT_DOOR_PROFILE_NAME"
function aliasFor(camelKey) {
  return camelKey
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

// Exported for unit tests / future consumers that need to inspect the alias rule.
export const _internals = { OUTPUT_ALIAS, aliasFor };
