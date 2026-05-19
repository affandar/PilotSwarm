// Regression tests for deploy/services/common/bicep/approve-private-endpoint.bicep.
//
// Two related hardenings are covered:
//   * SF-1 (silent-failure removal): the prior auto-approval script swallowed
//     `az` errors with `2>/dev/null || echo "[]"`, masking auth / RBAC / RG
//     failures as the legitimate "no pending connections" case. The current
//     script surfaces stderr, keeps the exit code, and retries via a
//     `list_pe_connections` wrapper.
//   * MF-3 (substring-filter) was considered as a second discriminator on
//     `privateEndpoint.id` and then reverted in PR #31 follow-up — the only
//     consumer is the AFD path, and AFD-managed PE ids carry no customer-side
//     identifier that a substring filter could meaningfully pin to. The
//     description filter (`requestMessageFilter`) is sufficient for that
//     single-purpose AppGw PLS.
//
// This file retains the SF-1 + retry-wrapper guards and adds a regression
// guard that ensures MF-3 is not silently re-added.
//
// We don't run `bash -n` here because the bicep file embeds the bash
// inside a `scriptContent: '''...'''` literal, and the test harness
// runs on Windows where bash availability varies. Instead we do
// structural regex checks against the bicep source:
//   1. SF-1 / IMPROVE-1: the `2>/dev/null || echo "[]"` swallow MUST NOT
//      appear anywhere in the executable script body.
//   2. The `list_pe_connections` retry wrapper must exist (3 attempts).
//   3. MF-3 substring-filter must NOT be reintroduced (param absent,
//      env var absent, portal caller does not pass it).

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

test("Retry wrapper around az list (3 attempts) is in the script body", () => {
  assert.match(approvePeSrc, /list_pe_connections\(\)/);
  assert.match(approvePeSrc, /local attempts=3/);
  assert.match(approvePeSrc, /local backoffs=\(1 2 4\)/);
});

test("Reverted MF-3: `expectedRequesterResourceId` param must NOT be present (PR #31 follow-up)", () => {
  // Strip bash comment lines first so a doc reference to the reverted
  // param name doesn't false-positive.
  const noComments = approvePeSrc
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*#/.test(l))
    .join("\n");
  assert.equal(
    /param\s+expectedRequesterResourceId\b/.test(noComments),
    false,
    "Regression: MF-3 substring-filter param was reintroduced. It was reverted in PR #31 follow-up because AFD-managed PE ids carry no customer-side identifier that a substring could meaningfully discriminate on; the description filter is sufficient for the only consumer (AFD).",
  );
  assert.equal(
    /EXPECTED_REQUESTER_RESOURCE_ID/.test(noComments),
    false,
    "Regression: MF-3 env-var wiring was reintroduced.",
  );
});

test("Reverted MF-3: portal/bicep/main.bicep must NOT pass `expectedRequesterResourceId` (PR #31 follow-up)", () => {
  const noComments = portalMainSrc
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert.equal(
    /expectedRequesterResourceId\s*:/.test(noComments),
    false,
    "Regression: portal caller is again wiring MF-3 substring discriminator. AFD-managed PE ids do not contain the customer-side AFD profile resource ID; any substring that would match is Microsoft-internal (e.g. `eafd-Prod-`) and adds no real discrimination over the description filter.",
  );
});
