// Static-shape regression guards for
// deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1.
//
// This script auto-provisions the per-stamp Entra worker app used by the
// OBO live-smoke harness (see docs/operations/live-smoke.md and
// .github/skills/pilotswarm-obo-smoke-app-reg/). The tests here are
// regex-on-source guards rather than full-mocked-az integration tests
// because the existing deploy/scripts/test/ suite is Node-mjs throughout
// and has no pwsh-mock harness precedent; we keep the cost-to-value ratio
// sensible by guarding the invariants most likely to silently regress.
//
// Invariants guarded:
//   1. NEVER edits .env (single-actor invariant). Inverted assertion: the
//      script body contains zero write operations targeting any `.env`
//      file, anywhere — even via redirection operators or [IO.File]
//      methods. This is the central locked-decision from planning-docs-
//      review; a regression here would re-introduce the multi-actor-on-
//      .env pattern.
//   2. Declares Microsoft Graph User.Read delegated permission with the
//      correct well-known constants. Without this the runtime OBO
//      exchange returns AADSTS65001.
//   3. preAuthorizedApplications is OVERWRITTEN (single-element array),
//      not merged. Per planning-docs-review consensus: each stamp has a
//      strict 1:1 portal-worker relationship; merging would leave
//      orphaned trust for rotated portal apps.
//   4. Stdout paste-block prints exactly five KEY=value lines in the
//      documented order (PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE,
//      OBO_SMOKE_WORKER_APP_TENANT_ID/_CLIENT_ID/_GRAPH_SCOPE, PLUGIN_DIRS).
//   5. Graph scope default is the Graph User.Read resource scope, NOT
//      the worker-app audience scope (a critical cycle-1 review fix —
//      these are two different hops in the OBO chain).
//   6. Required parameters match the documented contract.
//
// Run: node --test deploy/scripts/test/setup-obo-smoke-worker-app.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT_PATH = join(
  REPO_ROOT,
  "deploy",
  "scripts",
  "auth",
  "Setup-OboSmokeWorkerApp.ps1",
);

const src = readFileSync(SCRIPT_PATH, "utf8");

// Strip PowerShell line and block comments + here-strings + double-quoted
// strings + single-quoted strings before running write-operation regexes.
// We keep this conservative: false negatives are acceptable (the test is
// belt-and-suspenders) but false positives (flagging a write inside a
// comment block) would create churn.
function stripCommentsAndStrings(input) {
  let s = input;
  // Block comments <# ... #>
  s = s.replace(/<#[\s\S]*?#>/g, "");
  // Here-strings @" ... "@ and @' ... '@
  s = s.replace(/@"[\s\S]*?"@/g, "");
  s = s.replace(/@'[\s\S]*?'@/g, "");
  // Double-quoted strings (no escape handling — PS uses backtick, rare here)
  s = s.replace(/"[^"\n]*"/g, "");
  // Single-quoted strings
  s = s.replace(/'[^'\n]*'/g, "");
  // Line comments
  s = s
    .split("\n")
    .map((l) => l.replace(/(^|[^`])#.*$/, "$1"))
    .join("\n");
  return s;
}

const srcStripped = stripCommentsAndStrings(src);

// --------------------------------------------------------------------------
// Invariant 1: No .env writes anywhere (single-actor invariant).
// --------------------------------------------------------------------------

test("INV-1: script body contains no write op targeting a .env file", () => {
  // Pattern alphabet (each phrased as a regex against the stripped source).
  // We look for any `.env` reference on the same line as a write verb /
  // redirection / .NET file-write method. `.env.example` and
  // `.env.template` are excluded — they are read-only templates and would
  // never be mutated by an auth script.
  const writePatterns = [
    /Set-Content[^;\n]*\.env(?!\.example|\.template)\b/i,
    /Add-Content[^;\n]*\.env(?!\.example|\.template)\b/i,
    /Out-File[^;\n]*\.env(?!\.example|\.template)\b/i,
    /Tee-Object[^;\n]*\.env(?!\.example|\.template)\b/i,
    /\[System\.IO\.File\]::Write[A-Za-z]+[^;\n]*\.env(?!\.example|\.template)\b/i,
    /\[System\.IO\.File\]::Append[A-Za-z]+[^;\n]*\.env(?!\.example|\.template)\b/i,
    /\[IO\.File\]::Write[A-Za-z]+[^;\n]*\.env(?!\.example|\.template)\b/i,
    /\[IO\.File\]::Append[A-Za-z]+[^;\n]*\.env(?!\.example|\.template)\b/i,
    /New-Item[^;\n]+-Path[^;\n]+\.env(?!\.example|\.template)\b/i,
    /Copy-Item[^;\n]+\.env(?!\.example|\.template)\b/i,
    /Move-Item[^;\n]+\.env(?!\.example|\.template)\b/i,
    // Redirection operators with .env as target (both > and >>)
    />>?\s*\S*\.env(?!\.example|\.template)\b/,
  ];
  const offenders = [];
  for (const pat of writePatterns) {
    const m = srcStripped.match(pat);
    if (m) {
      offenders.push({ pattern: pat.toString(), match: m[0] });
    }
  }
  assert.equal(
    offenders.length,
    0,
    `Script contains a .env write operation (single-actor invariant violated). ` +
      `The npm-deployer agent / operator is the sole .env mutator. ` +
      `Offenders: ${JSON.stringify(offenders, null, 2)}`,
  );
});

// --------------------------------------------------------------------------
// Invariant 2: Microsoft Graph User.Read delegated permission constants.
// --------------------------------------------------------------------------

test("INV-2: declares Microsoft Graph resource app id (well-known constant)", () => {
  assert.match(
    src,
    /00000003-0000-0000-c000-000000000000/,
    "Graph resource appId constant missing — Graph requiredResourceAccess block " +
      "will not target Microsoft Graph",
  );
});

test("INV-2: declares Graph User.Read delegated permission id (well-known constant)", () => {
  assert.match(
    src,
    /e1fe6dd8-ba31-4d61-89e7-88639da4683d/,
    "Graph User.Read delegated permission id missing. Without it the runtime " +
      "acquireTokenOnBehalfOf({ scopes: ['https://graph.microsoft.com/User.Read'] }) " +
      "call returns AADSTS65001 even with pre-authorization.",
  );
});

test("INV-2: Graph User.Read is declared as a Scope (delegated), not Role (app-only)", () => {
  // The JSON template interpolates the constant ($MS_GRAPH_USER_READ_DELEGATED_ID)
  // rather than the literal GUID; assert the template wires { "id": "<constant>",
  // "type": "Scope" } adjacently, in either order.
  const adjA = /"id"\s*:\s*"\$MS_GRAPH_USER_READ_DELEGATED_ID"\s*,\s*"type"\s*:\s*"Scope"/;
  const adjB = /"type"\s*:\s*"Scope"\s*,\s*"id"\s*:\s*"\$MS_GRAPH_USER_READ_DELEGATED_ID"/;
  assert.ok(
    adjA.test(src) || adjB.test(src),
    "Graph User.Read must be declared with type=Scope (delegated). OBO requires " +
      "delegated permissions; type=Role would issue app-only tokens which cannot " +
      "be obtained via acquireTokenOnBehalfOf.",
  );
});

// --------------------------------------------------------------------------
// Invariant 3: preAuthorizedApplications overwrite (not merge).
// --------------------------------------------------------------------------

test("INV-3: preAuthorizedApplications PATCH body is overwrite-shaped (single-element array literal)", () => {
  // Locate the api{} patch body builder and assert it contains a single-element
  // preAuthorizedApplications literal that interpolates the portal appId.
  const m = src.match(
    /"preAuthorizedApplications"\s*:\s*\[\s*\{\s*"appId"\s*:\s*"\$portalEscaped"/,
  );
  assert.ok(
    m,
    "preAuthorizedApplications must be emitted as a single-element array " +
      "containing the current portal clientId (overwrite), NOT merged with any " +
      "prior list. Per planning-docs-review: each stamp has a 1:1 portal-worker " +
      "relationship; merging risks orphaned trust to rotated portal apps.",
  );
});

test("INV-3: no merge-style read-modify-write of preAuthorizedApplications", () => {
  // A merge implementation would have to read existing preAuthorizedApplications
  // before patching. Assert no such read shape exists.
  assert.ok(
    !/\$existing[A-Za-z]*\.api\.preAuthorizedApplications/i.test(src),
    "Script appears to read existing preAuthorizedApplications before " +
      "PATCH — this is the merge anti-pattern we explicitly rejected. " +
      "Overwrite-only is the locked decision.",
  );
});

// --------------------------------------------------------------------------
// Invariant 4: Stdout paste-block — exactly five KEY=value lines.
// --------------------------------------------------------------------------

test("INV-4: stdout paste-block declares 'Paste into' banner referencing per-stamp .env", () => {
  assert.match(
    src,
    /# Paste into deploy\/envs\/local\/\$EnvName\/\.env/,
    "Paste-banner missing or path drifted from per-stamp convention",
  );
});

test("INV-4: emits PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE line with worker-app audience + offline_access", () => {
  assert.match(
    src,
    /Write-Host\s+"PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE=\$scope offline_access"/,
    "PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE line missing or shape changed. " +
      "It must be `api://<appId>/.default offline_access` so the portal MSAL " +
      "flow acquires a worker-audienced refreshable token.",
  );
});

test("INV-4: emits the three OBO_SMOKE_WORKER_APP_* lines", () => {
  assert.match(
    src,
    /Write-Host\s+"OBO_SMOKE_WORKER_APP_TENANT_ID=\$tenantId"/,
    "OBO_SMOKE_WORKER_APP_TENANT_ID line missing",
  );
  assert.match(
    src,
    /Write-Host\s+"OBO_SMOKE_WORKER_APP_CLIENT_ID=\$clientId"/,
    "OBO_SMOKE_WORKER_APP_CLIENT_ID line missing",
  );
  assert.match(
    src,
    /Write-Host\s+"OBO_SMOKE_WORKER_APP_GRAPH_SCOPE=\$GraphScope"/,
    "OBO_SMOKE_WORKER_APP_GRAPH_SCOPE line missing",
  );
});

test("INV-4: emits PLUGIN_DIRS line pointing at the in-image OBO smoke plugin path", () => {
  // The smoke plugin loads via the worker's pluginDirs/PLUGIN_DIRS contract.
  // The in-image path /app/packages/obo-smoke-plugin is a cross-cutting
  // invariant: the Dockerfile places the plugin there, and this paste-block
  // wires PLUGIN_DIRS to match. If either side drifts the smoke plugin
  // silently fails to load.
  assert.match(
    src,
    /Write-Host\s+"PLUGIN_DIRS=\/app\/packages\/obo-smoke-plugin"/,
    "PLUGIN_DIRS line missing or path drifted from the in-image plugin location " +
      "(/app/packages/obo-smoke-plugin). The Dockerfile worker stage that places " +
      "the smoke plugin and this paste-block must agree on the path.",
  );
});

test("INV-4: paste-block is exactly five KEY=value lines, no more no less", () => {
  // Count Write-Host lines that look like `KEY=...` directly (uppercase, _).
  const matches = src.match(/Write-Host\s+"[A-Z][A-Z0-9_]+=/g) ?? [];
  assert.equal(
    matches.length,
    5,
    `Expected exactly 5 KEY=value Write-Host lines in the paste-block; found ${matches.length}. ` +
      "Lines should be (in order): PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE, " +
      "OBO_SMOKE_WORKER_APP_TENANT_ID, OBO_SMOKE_WORKER_APP_CLIENT_ID, " +
      "OBO_SMOKE_WORKER_APP_GRAPH_SCOPE, PLUGIN_DIRS.",
  );
});

// --------------------------------------------------------------------------
// Invariant 5: GraphScope default is the Graph User.Read resource scope.
// --------------------------------------------------------------------------

test("INV-5: -GraphScope default is the Graph User.Read resource scope, NOT api://<appId>/.default", () => {
  // The default must be the downstream resource scope. The api://<appId>/.default
  // is the *upstream* audience selector (used by the portal acquireToken call),
  // a DIFFERENT key entirely (PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE). Conflating
  // the two was the most consequential cycle-1 plan-review finding.
  assert.match(
    src,
    /\[string\]\$GraphScope\s*=\s*"https:\/\/graph\.microsoft\.com\/User\.Read"/,
    "GraphScope default must be 'https://graph.microsoft.com/User.Read' — the " +
      "downstream resource scope the worker OBO-exchanges to. Do NOT default it " +
      "to api://<appId>/.default; that's the upstream audience, a different hop.",
  );
});

// --------------------------------------------------------------------------
// Invariant 6: Required parameter contract.
// --------------------------------------------------------------------------

test("INV-6: -ServiceTreeId is mandatory", () => {
  assert.match(
    src,
    /\[Parameter\(Mandatory=\$true\)\]\[string\]\$ServiceTreeId/,
    "-ServiceTreeId must be mandatory (matches Setup-PortalAuth.ps1 / tenant policy)",
  );
});

test("INV-6: -EnvName is mandatory", () => {
  assert.match(
    src,
    /\[Parameter\(Mandatory=\$true\)\]\[string\]\$EnvName/,
    "-EnvName must be mandatory — it derives display name, sidecar path, " +
      "OIDC cache path, and portal-clientid sidecar path.",
  );
});

test("INV-6: all documented optional parameters are present", () => {
  const optionalParams = [
    "DisplayName",
    "ExistingAppId",
    "PortalClientId",
    "GraphScope",
    "ServiceAccountNamespace",
    "ServiceAccountName",
    "GrantAdminConsent",
    "Owner",
    "OutputFile",
  ];
  for (const p of optionalParams) {
    assert.match(
      src,
      new RegExp(`\\[Parameter\\(Mandatory=\\$false\\)\\]\\[(?:string|switch)\\]\\$${p}\\b`),
      `Optional parameter -${p} is missing from the script contract`,
    );
  }
});

// --------------------------------------------------------------------------
// Invariant 7: AKS workload-identity FIC subject + audience are canonical.
// --------------------------------------------------------------------------

test("INV-7: FIC audience constant matches AKS workload-identity canonical value", () => {
  assert.match(
    src,
    /api:\/\/AzureADTokenExchange/,
    "AKS workload-identity FIC audience must be api://AzureADTokenExchange. " +
      "Any other value will make Entra reject the worker pod's projected " +
      "service-account token at the OBO-assertion exchange.",
  );
});

test("INV-7: FIC subject defaults align with worker pod's service-account manifest", () => {
  assert.match(
    src,
    /\$ServiceAccountNamespace\s*=\s*"pilotswarm"/,
    "Default service-account namespace must be 'pilotswarm' (matches main.bicep)",
  );
  assert.match(
    src,
    /\$ServiceAccountName\s*=\s*"copilot-runtime-worker"/,
    "Default service-account name must be 'copilot-runtime-worker' " +
      "(matches deploy/gitops/worker/base/service-account.yaml)",
  );
});

// --------------------------------------------------------------------------
// Invariant 8: Header comment documents the single-actor-on-.env invariant.
// --------------------------------------------------------------------------

test("INV-8: header comment block explicitly states the script never modifies .env", () => {
  // Look in the leading <# ... #> SYNOPSIS / DESCRIPTION block only.
  const headerMatch = src.match(/^<#[\s\S]*?#>/);
  assert.ok(headerMatch, "Leading <# ... #> comment-based help block missing");
  const header = headerMatch[0];
  assert.match(
    header,
    /never modifies?\s+\.env|NEVER MODIFIES \.env|does not modify \.env|never edits \.env|never touch \.env/i,
    "Header comment must explicitly document the single-actor-on-.env invariant " +
      "so future authors can't accidentally re-introduce a write path.",
  );
});

// -----------------------------------------------------------------------------
// INV-9: cross-file contract — main.bicep emits oidcIssuerUrl as a TOP-LEVEL
// output. This is what the wrapper reads (via the bicep-outputs cache) to wire
// the AKS workload-identity FIC. ARM does not propagate nested-module outputs
// through `az deployment ... show --query properties.outputs`, so a submodule-
// only output is invisible to the cache writer (deploy-bicep.mjs:271). If this
// regresses, the wrapper fails at Resolve-OidcIssuerFromEnv on every fresh
// stamp and the "one-line opt-in" guarantee silently breaks.
//
// `aliasFor("oidcIssuerUrl")` in deploy-bicep.mjs:357 produces
// `OIDC_ISSUER_URL` — the first candidate key the wrapper checks. Pinning the
// camelCase output name here therefore also pins the env-key the wrapper
// resolves against.
// -----------------------------------------------------------------------------
test("INV-9: deploy/services/base-infra/bicep/main.bicep declares a top-level `output oidcIssuerUrl`", () => {
  const bicepPath = join(REPO_ROOT, "deploy/services/base-infra/bicep/main.bicep");
  const bicepSrc = readFileSync(bicepPath, "utf8");
  // Top-level `output <name> string = ...` lines start at column 0; nested
  // submodule param lines start with whitespace. Anchor on ^ to exclude the
  // `oidcIssuerUrl: Aks.outputs.oidcIssuerUrl` pass-through param at line ~314.
  assert.match(
    bicepSrc,
    /^output\s+oidcIssuerUrl\s+string\s*=/m,
    "main.bicep must emit `output oidcIssuerUrl string = Aks.outputs.oidcIssuerUrl` " +
      "as a TOP-LEVEL output. Submodule outputs do not propagate through " +
      "`az deployment ... show --query properties.outputs` (see " +
      "deploy/scripts/lib/deploy-bicep.mjs:271), so without this top-level " +
      "declaration the bicep-outputs cache contains no OIDC issuer URL and " +
      "Setup-OboSmokeWorkerApp.ps1's Resolve-OidcIssuerFromEnv throws on every " +
      "fresh stamp.",
  );
});
