// Regression tests for deploy/services/common/bicep/approve-private-endpoint.bicep.
// Ported from waldemort c9e946c (PAW Review PR #7, Change Set D).
//
// We don't run `bash -n` here because the bicep file embeds the bash
// inside a `scriptContent: '''...'''` literal, and the test harness
// runs on Windows where bash availability varies. Instead we do
// structural regex checks against the bicep source:
//   1. SF-1 / IMPROVE-1: the `2>/dev/null || echo "[]"` swallow MUST NOT
//      appear anywhere in the executable script body.
//   2. The new `list_pe_connections` retry wrapper must exist (3 attempts).
//   3. MF-3 fail-closed multi-match block must be present.
//   4. `expectedRequesterResourceId` param must exist and be wired
//      through to the EXPECTED_REQUESTER_RESOURCE_ID env var.
//   5. The portal caller (deploy/services/portal/bicep/main.bicep) must
//      pass `expectedRequesterResourceId` to the module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APPROVE_PE = join(
  REPO_ROOT,
  "deploy",
  "services",
  "common",
  "bicep",
  "approve-private-endpoint.bicep",
);
const PORTAL_MAIN = join(
  REPO_ROOT,
  "deploy",
  "services",
  "portal",
  "bicep",
  "main.bicep",
);

const approvePeSrc = readFileSync(APPROVE_PE, "utf8");
const portalMainSrc = readFileSync(PORTAL_MAIN, "utf8");

test("SF-1: approve-private-endpoint.bicep no longer swallows az errors with `2>/dev/null || echo \"[]\"`", () => {
  // Strip bash comment lines (lines whose first non-whitespace char is `#`)
  // so we only flag the swallow when it appears in actual executable code.
  const noComments = approvePeSrc
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.equal(
    noComments.includes(`2>/dev/null || echo "[]"`),
    false,
    "Regression: the swallow pattern resurfaced in executable script; az failures (auth/RBAC/RG) will be misclassified as 'no pending connections'.",
  );
});

test("MF-3: approve-private-endpoint.bicep exposes expectedRequesterResourceId param", () => {
  assert.match(
    approvePeSrc,
    /param expectedRequesterResourceId string = ''/,
    "expectedRequesterResourceId param missing or default changed",
  );
  // Must be wired to a script environmentVariables entry.
  assert.match(
    approvePeSrc,
    /name:\s*'EXPECTED_REQUESTER_RESOURCE_ID'\s*\n\s*value:\s*expectedRequesterResourceId/,
    "EXPECTED_REQUESTER_RESOURCE_ID env var not wired to param",
  );
});

test("Retry wrapper around az list (3 attempts) is in the script body", () => {
  assert.match(approvePeSrc, /list_pe_connections\(\)/);
  assert.match(approvePeSrc, /local attempts=3/);
  assert.match(approvePeSrc, /local backoffs=\(1 2 4\)/);
});

test("MF-3 fail-closed: multi-match refuses bulk approval", () => {
  // Look for the error string the script emits when ≥2 pending PEs
  // match the EXPECTED_REQUESTER_RESOURCE_ID substring.
  assert.match(approvePeSrc, /Refusing to bulk-approve/);
  assert.match(
    approvePeSrc,
    /\$(?:PENDING_COUNT|CONNECTION_COUNT)["\s-]*-gt 1/,
    "missing the >1 multi-match guard for the requester filter",
  );
});

test("Portal main.bicep wires expectedRequesterResourceId to the PE-approval module", () => {
  assert.match(
    portalMainSrc,
    /expectedRequesterResourceId:\s*resourceId\(/,
    "portal/bicep/main.bicep must pass expectedRequesterResourceId to approve-private-endpoint.bicep",
  );
});

test("filter_pending helper preserves legacy 'match all' when EXPECTED_REQUESTER_RESOURCE_ID is empty", () => {
  // We test by structure: the helper has an `if [ -n "$EXPECTED_..." ]`
  // branch and an `else` that returns every Pending.
  assert.match(approvePeSrc, /filter_pending\(\)/);
  assert.match(
    approvePeSrc,
    /if\s*\[\s*-n\s*"\$EXPECTED_REQUESTER_RESOURCE_ID"\s*\]/,
  );
});
