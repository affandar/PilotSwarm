import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageManifests } from "../lib/stage-manifests.mjs";
import { manifestContainerName } from "../lib/publish-manifests.mjs";
import { resolveRolloutSpec } from "../lib/wait-rollout.mjs";
import { configureEnv } from "../../services/mcp-proxy/configure-env.mjs";
import { resolveSteps } from "../lib/stages.mjs";

function proxyEnv(extra = {}) {
  return {
    DEPLOY_INSTANCE: "kusto",
    IMAGE: "example.azurecr.io/pilotswarm-mcp-proxy:test",
    MCP_PROXY_RESOURCE_NAME: "kusto-mcp",
    MCP_PROXY_REPLICAS: "2",
    MCP_PROXY_EXTRA_ENV:
      "KUSTO_DEFAULT_CLUSTER=https://example.kusto.windows.net;" +
      "KUSTO_DEFAULT_DATABASE=sample;" +
      "ALLOW_APP_TOKENS=false",
    ...extra,
  };
}

test("mcp-proxy stages an isolated adapter instance with consumer configuration", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-mcp-proxy-"));
  const env = proxyEnv();
  configureEnv(env, { phase: "manifests" });
  const stagedRoot = stageManifests({
    service: "mcp-proxy",
    envName: "dev",
    env,
    stagingDir,
  });

  const deployment = readFileSync(join(stagedRoot, "base", "deployment.yaml"), "utf8");
  const service = readFileSync(join(stagedRoot, "base", "service.yaml"), "utf8");
  const networkPolicy = readFileSync(
    join(stagedRoot, "base", "networkpolicy.yaml"),
    "utf8",
  );
  const overlayEnv = readFileSync(
    join(stagedRoot, "overlays", "default", ".env"),
    "utf8",
  );

  assert.match(deployment, /name: kusto-mcp/);
  assert.match(deployment, /replicas: 2/);
  assert.match(deployment, /app\.kubernetes\.io\/instance: kusto/);
  assert.match(service, /name: kusto-mcp/);
  assert.match(networkPolicy, /app\.kubernetes\.io\/component: worker/);
  assert.match(networkPolicy, /app\.kubernetes\.io\/component: git-repo-worker/);
  assert.match(overlayEnv, /IMAGE=example\.azurecr\.io\/pilotswarm-mcp-proxy:test/);
  assert.match(
    overlayEnv,
    /KUSTO_DEFAULT_CLUSTER=https:\/\/example\.kusto\.windows\.net/,
  );
  assert.match(overlayEnv, /KUSTO_DEFAULT_DATABASE=sample/);
  assert.match(overlayEnv, /ALLOW_APP_TOKENS=false/);
  assert.ok(!deployment.includes("__MCP_PROXY_"));
  assert.ok(!service.includes("__MCP_PROXY_"));
});

test("mcp-proxy supports a complete externally built adapter image", () => {
  const env = proxyEnv({
    IMAGE: "example.azurecr.io/platform-default:ignored",
    MCP_PROXY_IMAGE: "example.azurecr.io/consumer-owned-adapter:published",
  });
  configureEnv(env, { phase: "manifests" });
  assert.equal(
    env.IMAGE,
    "example.azurecr.io/consumer-owned-adapter:published",
  );
});

test("mcp-proxy rejects credential-bearing and malformed environment entries", () => {
  assert.throws(
    () => configureEnv(proxyEnv({ MCP_PROXY_EXTRA_ENV: "API_TOKEN=secret" })),
    /credential-bearing setting/,
  );
  assert.throws(
    () => configureEnv(proxyEnv({ MCP_PROXY_EXTRA_ENV: "not-a-pair" })),
    /NAME=value/,
  );
  assert.throws(
    () =>
      configureEnv(
        proxyEnv({ MCP_PROXY_EXTRA_ENV: "KUSTO_DATABASE=a;KUSTO_DATABASE=b" }),
      ),
    /duplicate setting/,
  );
  assert.throws(
    () => configureEnv(proxyEnv({ MCP_PROXY_RESOURCE_NAME: "Invalid_Name" })),
    /lowercase DNS label/,
  );
});

test("mcp-proxy uses isolated manifests and exact rollout image verification", () => {
  const env = proxyEnv();
  configureEnv(env, { phase: "manifests" });
  assert.equal(
    manifestContainerName("mcp-proxy", env),
    "mcp-proxy-kusto-manifests",
  );
  assert.deepEqual(resolveRolloutSpec({ service: "mcp-proxy", env }), {
    resourceName: "kusto-mcp",
    resourceKind: "deployment",
    namespace: "pilotswarm",
    kustomizationName: "mcp-proxy-kusto-proxy",
    verifyImage: true,
    expectedImage: "example.azurecr.io/pilotswarm-mcp-proxy:test",
    prerequisites: [],
    timeout: "10m",
  });
});

test("mcp-proxy resource and storage names fit platform limits", () => {
  const instance = "a".repeat(40);
  const env = proxyEnv({
    DEPLOY_INSTANCE: instance,
    MCP_PROXY_RESOURCE_NAME: `mcp-proxy-${instance}`,
  });
  configureEnv(env);
  assert.ok(env.MCP_PROXY_RESOURCE_NAME.length <= 63);
  assert.ok(manifestContainerName("mcp-proxy", env).length <= 63);
});

test("mcp-proxy supports a render-only deployment step", () => {
  assert.deepEqual(resolveSteps("render", "mcp-proxy"), ["render"]);
});
