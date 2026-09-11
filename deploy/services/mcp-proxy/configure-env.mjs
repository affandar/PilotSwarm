const IMAGE_REFERENCE_PATTERN =
  /^[^\s/]+(?:\/[^\s/]+)+(?:@sha256:[a-f0-9]{64}|:[^/:\s]+)$/i;
const RESOURCE_NAME_PATTERN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_NAME_PATTERN =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|CONNECTION_STRING)(?:_|$)/i;

function requireValue(env, key) {
  const value = String(env[key] ?? "").trim();
  if (!value) throw new Error(`Missing required ${key}.`);
  env[key] = value;
  return value;
}

function validateResourceName(value) {
  if (value.length > 63 || !RESOURCE_NAME_PATTERN.test(value)) {
    throw new Error(
      "MCP_PROXY_RESOURCE_NAME must be a lowercase DNS label with at most 63 characters.",
    );
  }
}

function validateReplicas(value) {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 100) {
    throw new Error("MCP_PROXY_REPLICAS must be an integer from 1 through 100.");
  }
}

function validateExtraEnv(value) {
  const names = new Set();
  for (const rawEntry of value.split(";")) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const separator = entry.indexOf("=");
    const name = separator < 0 ? entry : entry.slice(0, separator).trim();
    if (separator < 0 || !ENV_NAME_PATTERN.test(name)) {
      throw new Error(
        "MCP_PROXY_EXTRA_ENV must be a semicolon-delimited list of NAME=value entries.",
      );
    }
    if (name === "PORT") {
      throw new Error("MCP_PROXY_EXTRA_ENV cannot override the platform-owned PORT value.");
    }
    if (CREDENTIAL_NAME_PATTERN.test(name)) {
      throw new Error(
        `MCP_PROXY_EXTRA_ENV cannot contain credential-bearing setting '${name}'.`,
      );
    }
    if (names.has(name)) {
      throw new Error(`MCP_PROXY_EXTRA_ENV contains duplicate setting '${name}'.`);
    }
    names.add(name);
  }
}

export function configureEnv(env, { phase = "initial" } = {}) {
  const instance = requireValue(env, "DEPLOY_INSTANCE");

  env.MCP_PROXY_RESOURCE_NAME ||=
    `mcp-proxy-${instance}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  validateResourceName(env.MCP_PROXY_RESOURCE_NAME);

  env.MCP_PROXY_REPLICAS ||= "2";
  validateReplicas(env.MCP_PROXY_REPLICAS);

  env.PORT = "8080";
  env.MCP_PROXY_EXTRA_ENV ||= "";
  validateExtraEnv(env.MCP_PROXY_EXTRA_ENV);

  if (phase === "manifests") {
    if (env.MCP_PROXY_IMAGE) env.IMAGE = env.MCP_PROXY_IMAGE;
    const image = requireValue(env, "IMAGE");
    if (!IMAGE_REFERENCE_PATTERN.test(image)) {
      throw new Error(
        `IMAGE must be a complete tagged or digest image reference; got '${image}'.`,
      );
    }
  }

  return env;
}
