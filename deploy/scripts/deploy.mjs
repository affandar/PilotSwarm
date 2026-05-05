#!/usr/bin/env node
// OSS Node deploy orchestrator entry point (Phase 1 skeleton).
//
// Drives the same end-state as deploy/services/ev2-deploy-dev.ps1 (Bicep + image push +
// Flux Storage Bucket manifest delivery + rollout verify) without any EV2 dependency.
//
// Stdlib-only Node, no shell:true, multi-platform (Windows / macOS / Linux).
// Spec: .paw/work/oss-deploy-script/Spec.md
//
// Phase 1 implements env loading, preflight, --steps dispatch, and a `noop` sentinel
// step. Real stages (build/push/bicep/manifests/rollout) are wired in later phases.

import {
  loadEnv,
  log,
  assertCli,
  assertSubscription,
  resolveImageTag,
  stagingDir,
  validateService,
  validateEnv,
} from "./lib/common.mjs";
import { resolveSteps, defaultPipelineFor } from "./lib/stages.mjs";
import { buildImage } from "./lib/build-image.mjs";
import { pushImage } from "./lib/push-image.mjs";
import { deployBicep } from "./lib/deploy-bicep.mjs";
import { loadCache as loadBicepOutputsCache } from "./lib/bicep-outputs-cache.mjs";
import { composeDerivedEnv } from "./lib/compose-env.mjs";
import { stageManifests } from "./lib/stage-manifests.mjs";
import { publishManifests } from "./lib/publish-manifests.mjs";
import { waitRollout } from "./lib/wait-rollout.mjs";
import { seedSecrets } from "./lib/seed-secrets.mjs";
import { SERVICE_IMAGE_INFO, ALL_SEQUENCE, ALL_MODE_MODULES } from "./lib/service-info.mjs";

// ───────────────────────── Arg parsing ─────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {
    steps: null,
    region: null,
    imageTag: null,
    clean: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      flags.help = true;
    } else if (a === "--clean") {
      flags.clean = true;
    } else if (a === "--force") {
      flags.force = true;
    } else if (a.startsWith("--steps=")) {
      flags.steps = a.slice("--steps=".length);
    } else if (a === "--steps") {
      flags.steps = args[++i];
    } else if (a.startsWith("--region=")) {
      flags.region = a.slice("--region=".length);
    } else if (a === "--region") {
      flags.region = args[++i];
    } else if (a.startsWith("--image-tag=")) {
      flags.imageTag = a.slice("--image-tag=".length);
    } else if (a === "--image-tag") {
      flags.imageTag = args[++i];
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (flags.help) return { help: true };

  if (positional.length < 2) {
    throw new Error(
      "Usage: npm run deploy -- <service> <env> [flags]\n" +
        "  <service>    worker | portal | baseinfra | globalinfra | cert-manager | cert-manager-issuers | all\n" +
        "  <env>        local env name created with `npm run deploy:new-env`\n" +
        "Flags: --steps, --region, --image-tag, --clean, --force, --help",
    );
  }

  const [service, envName, ...extra] = positional;
  if (extra.length) throw new Error(`Unexpected positional args: ${extra.join(" ")}`);

  return { service, envName, ...flags };
}

function printHelp() {
  process.stdout.write(
    [
      "OSS Node deploy orchestrator for PilotSwarm (additive to EV2 path).",
      "",
      "Usage:",
      "  npm run deploy -- <service> <env> [flags]",
      "",
      "Services:  worker | portal | baseinfra | globalinfra | cert-manager | cert-manager-issuers | all",
      "           ('all' runs the canonical end-to-end sequence:",
      "            globalinfra → baseinfra → cert-manager → cert-manager-issuers → worker → portal,",
      "            applying --steps to each as appropriate. cert-manager services",
      "            are skipped on the akv (EV2) TLS_SOURCE path.)",
      "Envs:      a local env name created with `npm run deploy:new-env`",
      "",
      "Flags:",
      "  --steps <list>      Comma-separated subset of: build,bicep,seed-secrets,push,manifests,rollout",
      "                      (or just 'noop' for env-load + preflight only).",
      "                      Default: full pipeline for service.",
      "  --region <name>     Override LOCATION from <env>.env (e.g. westus3).",
      "  --image-tag <tag>   Explicit image tag. Default: <env>-<short-sha>[-dirty].",
      "  --clean             Wipe deploy/.tmp/<service>-<env>/ before running.",
      "  --force             Ignore deploy markers; redeploy every Bicep module even if",
      "                      its template + rendered params are unchanged since last success.",
      "  --help, -h          Show this help.",
      "",
      "Spec: .paw/work/oss-deploy-script/Spec.md",
      "",
    ].join("\n"),
  );
}

// ───────────────────────── Stage runner ─────────────────────────

async function runStage(name, ctx) {
  switch (name) {
    case "noop":
      // Phase 1 sentinel: env load + preflight already done before we got here.
      log("ok", "noop: env loaded, preflight passed.");
      return;
    case "build":
      if (!SERVICE_IMAGE_INFO[ctx.service]) {
        log("info", `No container image for service '${ctx.service}'; skipping build.`);
        return;
      }
      assertCli("docker", "https://docs.docker.com/get-docker/ (must include buildx)");
      await buildImage({
        service: ctx.service,
        envName: ctx.envName,
        imageTag: ctx.imageTag,
        stagingDir: ctx.stagingDir,
      });
      return;
    case "push":
      if (!SERVICE_IMAGE_INFO[ctx.service]) {
        log("info", `No container image for service '${ctx.service}'; skipping push.`);
        return;
      }
      assertCli("oras", "https://oras.land/docs/installation", ["version"]);
      await pushImage({
        service: ctx.service,
        envName: ctx.envName,
        imageTag: ctx.imageTag,
        env: ctx.env,
        stagingDir: ctx.stagingDir,
      });
      return;
    case "bicep":
      await deployBicep({
        service: ctx.service,
        envName: ctx.envName,
        env: ctx.env,
        region: ctx.region,
        stagingDir: ctx.stagingDir,
        moduleListOverride: ctx.moduleListOverride,
        force: ctx.force,
      });
      // Re-run composition: a fresh `all` run starts with an empty outputs
      // cache, so the startup pass at line ~258 had nothing to compose.
      // Now that bicep merged BaseInfra outputs (POSTGRES_FQDN /
      // BLOB_CONTAINER_ENDPOINT / POSTGRES_AAD_ADMIN_PRINCIPAL_NAME) into
      // the in-process env map, derive DATABASE_URL et al. so the
      // subsequent manifests stage finds them.
      composeDerivedEnv(ctx.env);
      return;
    case "seed-secrets":
      await seedSecrets({
        envName: ctx.envName,
        env: ctx.env,
      });
      return;
    case "manifests": {
      // Compose the IMAGE env var (the only image-related key consumed by
      // the overlay `.env`/replacements chain). Derived from build/push
      // contract: the rendered overlay must point at the tag we pushed
      // (or `--image-tag` on a manifests-only run).
      const imageInfo = SERVICE_IMAGE_INFO[ctx.service];
      if (imageInfo && ctx.env.ACR_LOGIN_SERVER) {
        ctx.env.IMAGE = `${ctx.env.ACR_LOGIN_SERVER}/${imageInfo.dockerImageRepo}:${ctx.imageTag}`;
      }
      const stagedServiceRoot = stageManifests({
        service: ctx.service,
        envName: ctx.envName,
        env: ctx.env,
        stagingDir: ctx.stagingDir,
      });
      await publishManifests({
        service: ctx.service,
        envName: ctx.envName,
        env: ctx.env,
        stagedServiceRoot,
      });
      return;
    }
    case "rollout":
      assertCli("kubectl", "https://kubernetes.io/docs/tasks/tools/", ["version", "--client"]);
      assertCli(
        "flux",
        "https://fluxcd.io/flux/installation/#install-the-flux-cli (winget install FluxCD.Flux / brew install fluxcd/tap/flux)",
        ["--version"],
      );
      await waitRollout({
        service: ctx.service,
        envName: ctx.envName,
        env: ctx.env,
        imageTag: ctx.imageTag,
        stagingDir: ctx.stagingDir,
      });
      return;
    default:
      throw new Error(`Unknown stage: ${name}`);
  }
}

// ───────────────────────── Main ─────────────────────────

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  const { service, envName, steps, region, imageTag, clean, force } = parsed;

  // 1) Validate inputs (accepts the virtual `all` aggregate)
  validateService(service);
  validateEnv(envName);

  // 2) Load env (FR-004) — single shared map so Bicep outputs cascade across
  // services in `all` mode (e.g. BaseInfra → Worker/Portal).
  const { env, sources } = loadEnv(envName);
  if (region) env.LOCATION = region; // CLI override
  log("info", `Loaded env: ${sources.local}`);

  // 3a) Load any cached Bicep outputs from previous runs in this env. This lets
  // single-service runs (e.g. `worker chkrawtestps`) re-use upstream
  // GlobalInfra/BaseInfra outputs without re-deploying the whole chain
  // in-process. Cached values do NOT override env-file or CLI values.
  // `--clean` (or deleting deploy/.tmp/<env>/bicep-outputs.cache.json) busts it.
  loadBicepOutputsCache(envName, env);

  // 3b) Compose derived env values (DATABASE_URL, AZURE_STORAGE_ACCOUNT_URL,
  // PILOTSWARM_CMS_FACTS_DATABASE_URL, PILOTSWARM_DB_AAD_USER) from
  // BaseInfra Bicep outputs already in env. This handles single-service
  // re-runs that load values from the outputs cache. For first-time `all`
  // runs the cache starts empty; composeDerivedEnv is invoked again after
  // each successful bicep stage in runStage() so manifests-stage env
  // substitution sees the composed values.
  composeDerivedEnv(env);

  // 4) Preflight CLIs (EC-1)
  assertCli("az", "https://aka.ms/azcli (winget install Microsoft.AzureCLI / brew install azure-cli)");

  // 4a) Edge-mode + TLS-source validation + globalinfra skip.
  // EDGE_MODE drives whether AFD is provisioned. `afd` (default) provisions
  // Front Door + Private Link to the AppGw private FE. `private` skips AFD
  // entirely — the GlobalInfra service is a no-op and we drop it from the
  // sequence. Single-service `deploy globalinfra` invocations short-circuit
  // with an explanatory message.
  //
  // TLS_SOURCE drives where the portal TLS cert comes from. `letsencrypt`
  // (default) uses cert-manager + LE prod ACME; `akv` uses a registered AKV
  // issuer + the bicep cert deployment script. cert-manager / LE always
  // produces a publicly-trusted cert, which is what AFD+PL requires.
  const edgeMode = (env.EDGE_MODE || "afd").toLowerCase();
  const VALID_EDGE_MODES = ["afd", "private"];
  if (!VALID_EDGE_MODES.includes(edgeMode)) {
    log("err", `EDGE_MODE='${env.EDGE_MODE}' is not one of ${VALID_EDGE_MODES.join(", ")}. Set it in deploy/envs/${envName}.env or local override.`);
    process.exit(1);
  }
  env.EDGE_MODE = edgeMode;

  const tlsSource = (env.TLS_SOURCE || "letsencrypt").toLowerCase();
  const VALID_TLS_SOURCES = ["letsencrypt", "akv", "akv-selfsigned"];
  if (!VALID_TLS_SOURCES.includes(tlsSource)) {
    log("err", `TLS_SOURCE='${env.TLS_SOURCE}' is not one of ${VALID_TLS_SOURCES.join(", ")}. Set it in deploy/envs/${envName}.env or local override.`);
    process.exit(1);
  }
  env.TLS_SOURCE = tlsSource;

  // Defense-in-depth: mirror the unsupported-combination matrix from
  // new-env.mjs. private+letsencrypt has no public IP for HTTP-01 (DNS-01
  // would require an Azure Public DNS zone we don't provision); afd+akv-
  // selfsigned won't be trusted by AFD's origin TLS validation.
  const UNSUPPORTED_COMBOS = [
    {
      edgeMode: "private",
      tlsSource: "letsencrypt",
      reason: "Let's Encrypt HTTP-01 requires a public IP for ACME validation; private-mode AKS has none. DNS-01 against an Azure Public DNS zone is not in scope.",
    },
    {
      edgeMode: "afd",
      tlsSource: "akv-selfsigned",
      reason: "Azure Front Door rejects self-signed origin certs. Use TLS_SOURCE=letsencrypt or TLS_SOURCE=akv with a public CA.",
    },
  ];
  const blocked = UNSUPPORTED_COMBOS.find(
    (c) => c.edgeMode === edgeMode && c.tlsSource === tlsSource,
  );
  if (blocked) {
    log(
      "err",
      `Unsupported combination EDGE_MODE='${edgeMode}' + TLS_SOURCE='${tlsSource}': ${blocked.reason}`,
    );
    process.exit(1);
  }

  if (service === "global-infra" && edgeMode !== "afd") {
    log(
      "ok",
      `EDGE_MODE='${edgeMode}' — GlobalInfra (Front Door) is not provisioned in this mode. Nothing to do.`,
    );
    return;
  }

  // cert-manager + cert-manager-issuers ship the OSS Let's Encrypt path.
  // Skip them entirely when TLS_SOURCE != letsencrypt (EV2 / akv path).
  if (
    (service === "cert-manager" || service === "cert-manager-issuers") &&
    tlsSource !== "letsencrypt"
  ) {
    log(
      "ok",
      `TLS_SOURCE='${tlsSource}' — '${service}' is not provisioned in this mode (only on the OSS letsencrypt path). Nothing to do.`,
    );
    return;
  }

  // 4b) Mode-specific pre-deploy validation.
  if (edgeMode === "private") {
    if (!env.HOST || env.HOST.trim() === "") {
      log(
        "err",
        `EDGE_MODE='private' requires HOST to be set (DNS label inside the private zone, e.g. 'portal'). ` +
          `Re-run \`npm run deploy:new-env -- ${envName} --force\` and supply the host when prompted.`,
      );
      process.exit(1);
    }
    if (!env.PRIVATE_DNS_ZONE || env.PRIVATE_DNS_ZONE.trim() === "") {
      log(
        "err",
        `EDGE_MODE='private' requires PRIVATE_DNS_ZONE to be set (Azure Private DNS Zone name, e.g. 'pilotswarm.internal'). ` +
          `Re-run \`npm run deploy:new-env -- ${envName} --force\` and supply the zone when prompted.`,
      );
      process.exit(1);
    }
    if (!env.PORTAL_HOSTNAME || env.PORTAL_HOSTNAME.trim() === "") {
      log(
        "err",
        `EDGE_MODE='private' requires PORTAL_HOSTNAME to be set (typically '\${HOST}.\${PRIVATE_DNS_ZONE}'; new-env composes this for you). ` +
          `Re-run \`npm run deploy:new-env -- ${envName} --force\`.`,
      );
      process.exit(1);
    }
  }
  if (tlsSource === "letsencrypt") {
    if (!env.ACME_EMAIL || env.ACME_EMAIL.trim() === "" || !env.ACME_EMAIL.includes("@")) {
      log(
        "err",
        `TLS_SOURCE='letsencrypt' requires ACME_EMAIL to be set (Let's Encrypt registration / renewal-failure notices). ` +
          `Re-run \`npm run deploy:new-env -- ${envName} --force\` and supply a valid email when prompted.`,
      );
      process.exit(1);
    }
  }
  // TLS_SOURCE=akv no longer requires a pre-set PORTAL_TLS_ISSUER_NAME —
  // Portal bicep now defaults it to OneCertV2-PublicCA (afd) or
  // OneCertV2-PrivateCA (private) per the postgresql-fleet-manager pattern
  // and registers the issuer on the AKV automatically. Operators can still
  // override via env if they want a different registered CA.
  // TLS_SOURCE=akv-selfsigned uses the AKV built-in `Self` issuer; no
  // CA registration required.

  // 4c) Stub FRONT_DOOR_* + PORTAL_HOSTNAME for non-afd modes so render-params
  // doesn't fail-closed on placeholders that the bicep simply ignores when
  // edgeMode != 'afd'. Bicep declares these params with default '' and the
  // afd-only modules are guarded with `if (edgeMode == 'afd')`.
  if (edgeMode !== "afd") {
    if (!env.FRONT_DOOR_PROFILE_NAME) env.FRONT_DOOR_PROFILE_NAME = "unused";
    if (!env.FRONT_DOOR_PROFILE_RESOURCE_GROUP) env.FRONT_DOOR_PROFILE_RESOURCE_GROUP = "unused";
    if (!env.FRONT_DOOR_ENDPOINT_NAME) env.FRONT_DOOR_ENDPOINT_NAME = "unused";
    // BaseInfra outputs APPLICATION_GATEWAY_NAME / PRIVATE_LINK_CONFIGURATION_NAME
    // as '' in private mode; render-params is fail-closed on empty strings,
    // so stub them so the Portal params template renders without error.
    // The Portal bicep ignores both inputs when edgeMode != 'afd' (the
    // applicationGateway 'existing' reference is itself afd-conditional).
    if (!env.APPLICATION_GATEWAY_NAME) env.APPLICATION_GATEWAY_NAME = "unused";
    if (!env.PRIVATE_LINK_CONFIGURATION_NAME) env.PRIVATE_LINK_CONFIGURATION_NAME = "unused";
  }
  // PORTAL_HOSTNAME is required in `private` (validated above) and unused in
  // `afd` / `public` (bicep derives it). Stub when blank so render succeeds.
  if (!env.PORTAL_HOSTNAME) env.PORTAL_HOSTNAME = "unused";

  // Private DNS Zone params are only consumed by Portal bicep in private
  // mode (resources are conditional on edgeMode=='private'). In afd mode
  // both fields are unused — stub so render-params doesn't fail-closed.
  if (edgeMode !== "private") {
    if (!env.PRIVATE_DNS_ZONE) env.PRIVATE_DNS_ZONE = "unused";
    if (!env.AKS_VNET_ID) env.AKS_VNET_ID = "unused";
  }

  assertCli("git", "https://git-scm.com/downloads");
  // docker / kubectl / oras checked lazily by the stages that need them.

  // 5) Subscription pin (FR-005)
  assertSubscription(env.SUBSCRIPTION_ID);

  // 6) Resolve image tag (FR-017) — shared across services in `all` mode so
  // worker and portal end up tagged consistently in one bring-up invocation.
  const resolvedTag = resolveImageTag({ envName, explicit: imageTag });
  log("info", `Image tag: ${resolvedTag}`);

  // 7) Branch: `all` aggregates over the canonical sequence; otherwise single service.
  if (service === "all") {
    await runAll({ envName, env, steps, imageTag: resolvedTag, clean, force, edgeMode });
  } else {
    await runOneService({
      service,
      envName,
      env,
      steps,
      imageTag: resolvedTag,
      clean,
      force,
      moduleListOverride: null,
    });
  }

  log("ok", "Deploy script completed successfully.");
}

// Single-service execution path. Used directly for explicit `<service> <env>`
// invocations and as the per-service step inside `runAll`.
async function runOneService({ service, envName, env, steps, imageTag, clean, force, moduleListOverride }) {
  if (clean) {
    const { rmSync } = await import("node:fs");
    const dir = stagingDir(service, envName);
    rmSync(dir, { recursive: true, force: true });
    log("info", `Cleaned staging dir: ${dir}`);
  }
  const stage = stagingDir(service, envName);

  const resolvedSteps = resolveSteps(steps, service);
  // In `all` mode, intersect requested steps with this service's default
  // pipeline so e.g. `--steps manifests,rollout` skips infra services rather
  // than failing on missing overlays.
  const effectiveSteps = moduleListOverride
    ? resolvedSteps.filter((s) => defaultPipelineFor(service).includes(s))
    : resolvedSteps;

  if (effectiveSteps.length === 0) {
    log("info", `[${service}] no applicable steps for this service; skipping.`);
    return;
  }

  log(
    "info",
    `Service=${service} Env=${envName} Region=${env.LOCATION} Steps=${effectiveSteps.join(",")}`,
  );

  const ctx = {
    service,
    envName,
    env,
    region: env.LOCATION,
    imageTag,
    stagingDir: stage,
    moduleListOverride,
    force,
  };

  for (const step of effectiveSteps) {
    log("step", `=== [${service}] ${step} ===`);
    try {
      await runStage(step, ctx);
    } catch (e) {
      log("err", `Failed: ${service} ${step}`);
      process.stderr.write(`${e.message}\n`);
      process.stderr.write(
        `\nRe-run with: npm run deploy -- ${service} ${envName} --steps ${step}\n`,
      );
      process.exit(1);
    }
  }
}

// Canonical end-to-end bring-up: iterate ALL_SEQUENCE, sharing the same env
// map across services so Bicep outputs from earlier services (e.g. ACR login
// server, deployment storage account) cascade forward. Each service deploys
// only its own Bicep module (ALL_MODE_MODULES) — dependencies were deployed
// by an earlier item in the same invocation.
async function runAll({ envName, env, steps, imageTag, clean, force, edgeMode }) {
  // Drop globalinfra from the sequence when AFD is disabled — the service is
  // entirely AFD provisioning and would otherwise create an empty RG with no
  // resources. Mirrors the single-service short-circuit above. cert-manager
  // + cert-manager-issuers are dropped on the akv (EV2) path for the same
  // reason — those services exist only to serve the OSS Let's Encrypt path.
  const tlsSource = (env.TLS_SOURCE || "letsencrypt").toLowerCase();
  const sequence = ALL_SEQUENCE.filter(
    (svc) => !(svc === "global-infra" && edgeMode !== "afd"),
  ).filter(
    (svc) =>
      !((svc === "cert-manager" || svc === "cert-manager-issuers") && tlsSource !== "letsencrypt"),
  );
  log("info", `=== Bring-up sequence: ${sequence.join(" → ")} ===`);
  for (const svc of sequence) {
    await runOneService({
      service: svc,
      envName,
      env,
      steps,
      imageTag,
      clean,
      force,
      moduleListOverride: ALL_MODE_MODULES[svc],
    });
  }
}

main().catch((e) => {
  process.stderr.write(`${e.stack ?? e.message}\n`);
  process.exit(1);
});
