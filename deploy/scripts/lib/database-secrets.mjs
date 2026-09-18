import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, run } from "./common.mjs";
import { validateDatabaseConfig } from "./database-env.mjs";

function requireVault(env) {
  if (!env.KV_NAME) throw new Error("BYO database secrets require KV_NAME from base-infra.");
}

function versionFromId(id, name) {
  const match = String(id).trim().match(/^https:\/\/[^/]+\/secrets\/([^/]+)\/([a-fA-F0-9]{32})$/);
  if (!match || match[1].toLowerCase() !== name.toLowerCase()) {
    throw new Error("Key Vault returned an invalid database secret version identifier; its value is not logged.");
  }
  return match[2];
}

// Azure CLI diagnostics (including thrown spawn errors) may contain secrets.
// Never attach its output or original error to a deployer error.
function runSecretCommand(args, failureMessage) {
  let result;
  try {
    result = run("az", args, { capture: true, allowFail: true });
  } catch {
    throw new Error(failureMessage);
  }
  if (result.status !== 0) throw new Error(failureMessage);
  return result.stdout;
}

function selectedVersionFromId(id, secret) {
  const version = versionFromId(id, secret.name);
  if (secret.version && version.toLowerCase() !== secret.version.toLowerCase()) {
    throw new Error(`Key Vault returned an unexpected version for ${secret.key}.`);
  }
  return version;
}

export function seedDatabaseSecrets(env) {
  const config = validateDatabaseConfig(env);
  if (!config.byo) return 0;
  requireVault(env);
  const seeded = new Map();
  for (const secret of config.secrets) {
    if (secret.value === undefined) continue; // Explicit, operator-owned reference.
    const key = secret.name.toLowerCase();
    if (!seeded.has(key)) {
      log("info", `[seed-secrets] seeding BYO ${secret.key} into Key Vault (value redacted).`);
      // mkdtemp creates a private directory; exclusive 0600 creation keeps
      // credentials out of argv and the staged/uploaded manifest tree.
      const secretDir = mkdtempSync(join(tmpdir(), "pilotswarm-database-secret-"));
      try {
        const secretFile = join(secretDir, "value");
        writeFileSync(secretFile, secret.value, { encoding: "utf8", mode: 0o600, flag: "wx" });
        const id = runSecretCommand([
          "keyvault", "secret", "set", "--vault-name", env.KV_NAME, "--name", secret.name,
          "--file", secretFile, "--encoding", "utf-8", "--query", "id", "--output", "tsv",
        ], `Cannot seed ${secret.key} into Key Vault; check secret access and retry seed-secrets. CLI output is withheld because it may contain credentials.`);
        seeded.set(key, versionFromId(id, secret.name));
      } finally {
        rmSync(secretDir, { recursive: true, force: true });
      }
    }
  }
  for (const secret of config.secrets) {
    const version = seeded.get(secret.name.toLowerCase());
    if (version) env[`${secret.key}_SECRET_VERSION`] = version;
  }
  return seeded.size;
}

function verifySuppliedUrl(env, secret) {
  const stdout = runSecretCommand([
    "keyvault", "secret", "show", "--vault-name", env.KV_NAME, "--name", secret.name,
    ...(secret.version ? ["--version", secret.version] : []),
    "--query", "{id:id,value:value}", "--output", "json",
  ], `Cannot verify ${secret.key} against Key Vault; check secret access or run --steps seed-secrets first.`);
  // This response can contain credentials. Do not use runJson or include
  // CLI output in errors; both can expose secret values on a failure.
  let stored;
  try {
    stored = JSON.parse(stdout);
  } catch {
    throw new Error(`Key Vault returned an invalid response for ${secret.key}; secret values are not logged.`);
  }
  if (typeof stored?.id !== "string" || typeof stored?.value !== "string") {
    throw new Error(`Key Vault returned incomplete metadata for ${secret.key}; secret values are not logged.`);
  }
  const version = selectedVersionFromId(stored.id, secret);
  if (stored.value !== secret.value) {
    throw new Error(`${secret.key} differs from its Key Vault secret; run --steps seed-secrets before manifests, or remove the raw URL and use an explicit *_SECRET_NAME reference.`);
  }
  return version;
}

// Reference-only runs resolve identifiers without exporting values. Supplied
// raw URLs must match the selected immutable version; compare only in memory.
export function resolveDatabaseSecretVersions(env) {
  const config = validateDatabaseConfig(env);
  if (!config.byo) return;
  requireVault(env);
  for (const secret of config.secrets) {
    if (secret.value !== undefined) {
      env[`${secret.key}_SECRET_VERSION`] = verifySuppliedUrl(env, secret);
      continue;
    }
    // An operator-supplied (or previously resolved) version is a selection,
    // not evidence that the version still exists and is accessible.
    const id = runSecretCommand([
      "keyvault", "secret", "show", "--vault-name", env.KV_NAME, "--name", secret.name,
      ...(secret.version ? ["--version", secret.version] : []),
      "--query", "id", "--output", "tsv",
    ], `Cannot resolve ${secret.key} from Key Vault; check secret access and the selected secret name/version before publishing manifests.`);
    env[`${secret.key}_SECRET_VERSION`] = selectedVersionFromId(id, secret);
  }
}

// Generate a component from non-secret identifiers only. JSON is valid YAML;
// serializing objects avoids interpolating operator data into YAML syntax.
export function stageDatabaseSecrets({ service, env, stagedServiceRoot, overlayName }) {
  const config = validateDatabaseConfig(env, { requireVersions: true });
  if (!config.byo) return;
  requireVault(env);
  if (!["worker", "portal"].includes(service)) throw new Error(`No database projection for service '${service}'.`);
  for (const key of ["WORKLOAD_IDENTITY_CLIENT_ID", "AZURE_TENANT_ID"]) {
    if (!env[key]) throw new Error(`BYO database projection requires ${key}.`);
  }
  const refs = config.secrets.map(({ key, name, version }) => ({ key, name, version }));
  const hash = createHash("sha256")
    .update(JSON.stringify([env.KV_NAME, env.WORKLOAD_IDENTITY_CLIENT_ID, env.AZURE_TENANT_ID, refs]))
    .digest("hex").slice(0, 12);
  // Versioned Secret names prevent a new pod from starting with the previous
  // CSI-synced Secret while the driver is still refreshing the new values.
  const name = `pilotswarm-${service}-database-${hash}`;
  const deployment = service === "worker" ? "copilot-runtime-worker" : "pilotswarm-portal";
  const componentDir = join(stagedServiceRoot, "components", "database-secrets");
  mkdirSync(componentDir, { recursive: true });
  const spc = {
    apiVersion: "secrets-store.csi.x-k8s.io/v1",
    kind: "SecretProviderClass",
    metadata: { name },
    spec: {
      provider: "azure",
      parameters: {
        usePodIdentity: "false",
        clientID: env.WORKLOAD_IDENTITY_CLIENT_ID,
        keyvaultName: env.KV_NAME,
        tenantId: env.AZURE_TENANT_ID,
        objects: "array:\n" + refs.map((ref) =>
          `  - |\n    objectName: ${ref.name}\n    objectAlias: ${ref.key}\n` +
          `    objectType: secret\n    objectVersion: ${ref.version}\n`).join(""),
      },
      secretObjects: [{
        secretName: name,
        type: "Opaque",
        data: refs.map(({ key }) => ({ objectName: key, key })),
      }],
    },
  };
  const patch = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: deployment },
    spec: { template: { spec: {
      containers: [{
        name: service,
        env: refs.map(({ key }) => ({
          name: key,
          valueFrom: { secretKeyRef: { name, key } },
        })),
        volumeMounts: [{ name: "database-secrets", mountPath: "/mnt/database-secrets", readOnly: true }],
      }],
      volumes: [{
        name: "database-secrets",
        csi: {
          driver: "secrets-store.csi.k8s.io",
          readOnly: true,
          volumeAttributes: { secretProviderClass: name },
        },
      }],
    } } },
  };
  const component = {
    apiVersion: "kustomize.config.k8s.io/v1alpha1",
    kind: "Component",
    resources: ["secret-provider-class.yaml"],
    patches: [{ target: { kind: "Deployment", name: deployment }, patch: JSON.stringify(patch) }],
  };
  writeFileSync(join(componentDir, "secret-provider-class.yaml"), JSON.stringify(spc, null, 2) + "\n");
  writeFileSync(join(componentDir, "kustomization.yaml"), JSON.stringify(component, null, 2) + "\n");
  const overlayPath = join(stagedServiceRoot, "overlays", overlayName, "kustomization.yaml");
  const overlay = readFileSync(overlayPath, "utf8");
  const marker = /^components:[ \t]*$/gm;
  if ([...overlay.matchAll(marker)].length !== 1) {
    throw new Error(`Expected exactly one components list in ${overlayPath}.`);
  }
  writeFileSync(overlayPath, overlay.replace(marker, "components:\n  - ../../components/database-secrets"));
}
