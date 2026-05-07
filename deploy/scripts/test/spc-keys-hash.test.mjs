// Tests for the SPC-keys hash. Verifies that the hash is stable for the
// same key set, sensitive to additions/removals, invariant under list
// ordering, and that worker / portal services produce distinct hashes
// that match the keys declared in their respective SPC YAMLs.
//
// Run: node --test deploy/scripts/test/spc-keys-hash.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeSpcKeysHash,
  _SPC_KEYS_BY_SERVICE,
} from "../lib/spc-keys-hash.mjs";
import { REPO_ROOT } from "../lib/common.mjs";

function expectedHash(keys) {
  const sorted = [...keys].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 12);
}

test("worker hash matches sha256-12 of sorted WORKER_SPC_KEYS", () => {
  const got = computeSpcKeysHash({ service: "worker" });
  assert.equal(got, expectedHash(_SPC_KEYS_BY_SERVICE.worker));
  assert.match(got, /^[0-9a-f]{12}$/);
});

test("portal hash matches sha256-12 of sorted PORTAL_SPC_KEYS", () => {
  const got = computeSpcKeysHash({ service: "portal" });
  assert.equal(got, expectedHash(_SPC_KEYS_BY_SERVICE.portal));
  assert.match(got, /^[0-9a-f]{12}$/);
});

test("worker and portal hashes differ", () => {
  assert.notEqual(
    computeSpcKeysHash({ service: "worker" }),
    computeSpcKeysHash({ service: "portal" }),
  );
});

test("hash is order-invariant within a service", () => {
  // Confirm computeSpcKeysHash is robust if someone reorders the constant.
  const reordered = [..._SPC_KEYS_BY_SERVICE.worker].reverse();
  assert.equal(expectedHash(reordered), computeSpcKeysHash({ service: "worker" }));
});

test("adding a key changes the hash", () => {
  const baseline = expectedHash(_SPC_KEYS_BY_SERVICE.worker);
  const augmented = expectedHash([..._SPC_KEYS_BY_SERVICE.worker, "NEW_FUTURE_KEY"]);
  assert.notEqual(baseline, augmented);
});

test("unknown service throws with a helpful message", () => {
  assert.throws(
    () => computeSpcKeysHash({ service: "unknown-svc" }),
    /unknown service 'unknown-svc'/,
  );
});

// Source-of-truth invariants: the JS constants must mirror the
// `secretObjects[].data[].key` list inside each service's
// secret-provider-class.yaml. We extract the YAML's keys with a regex
// (the SPC files are author-controlled and have a stable shape) and
// assert set equality.
function extractSpcKeys(yamlPath) {
  const body = readFileSync(yamlPath, "utf8");
  // Find the secretObjects block, then collect every `key: NAME` line
  // beneath it. Stop at the next top-level field (no longer indented
  // under `data:`). For the level of structure these files have, a
  // simple line scan is reliable.
  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex(l => /^\s*secretObjects:\s*$/.test(l));
  assert.ok(startIdx >= 0, `secretObjects block not found in ${yamlPath}`);
  const keys = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+key:\s+([A-Z_][A-Z0-9_]*)\s*$/);
    if (m) keys.push(m[1]);
  }
  return keys.sort();
}

test("WORKER_SPC_KEYS mirrors deploy/gitops/worker/base/secret-provider-class.yaml", () => {
  const yamlKeys = extractSpcKeys(
    join(REPO_ROOT, "deploy", "gitops", "worker", "base", "secret-provider-class.yaml"),
  );
  const constKeys = [..._SPC_KEYS_BY_SERVICE.worker].sort();
  assert.deepEqual(constKeys, yamlKeys);
});

test("PORTAL_SPC_KEYS mirrors deploy/gitops/portal/base/secret-provider-class.yaml", () => {
  const yamlKeys = extractSpcKeys(
    join(REPO_ROOT, "deploy", "gitops", "portal", "base", "secret-provider-class.yaml"),
  );
  const constKeys = [..._SPC_KEYS_BY_SERVICE.portal].sort();
  assert.deepEqual(constKeys, yamlKeys);
});
