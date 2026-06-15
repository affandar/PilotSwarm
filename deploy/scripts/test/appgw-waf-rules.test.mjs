// Unit tests for deploy/scripts/lib/appgw-waf-rules.mjs.
//
// Covers (Plan §"Phase 2 / Tests for AppGw WAF custom-rules wiring"):
//   * File path resolution (relative → absolute; missing → named error;
//     unset → null; malformed JSON → named error).
//   * Bicep merged-output shape — four cases:
//       VPN on  + operator rules empty     → exactly the three auto-seeded
//                                            rules at priorities 90/91/92.
//       VPN off + operator rules non-empty → only operator rules (no seed).
//       VPN on  + operator rules non-empty → seed (90/91/92) followed by
//                                            operator rules in array order.
//       VPN off + operator rules empty     → [].
//   * Alias mapping: bicep `frontDoorId` output → `FRONT_DOOR_ID` env key
//     via deploy-bicep.mjs `_internals.aliasFor()`.
//
// The JS helper mirrors the bicep `var` in application-gateway.bicep:82-142
// exactly and is kept in lockstep by code review. The bicep is the runtime
// source of truth; this test guards the JS shadow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAutoSeedRules,
  buildMergedCustomRules,
  resolveAppgwWafCustomRulesFile,
} from "../lib/appgw-waf-rules.mjs";
import { _internals } from "../lib/deploy-bicep.mjs";

const SAMPLE_OPS = [
  { name: "AllowCorpNet", priority: 100, ruleType: "MatchRule", action: "Allow", matchConditions: [] },
  { name: "BlockAnon", priority: 110, ruleType: "MatchRule", action: "Block", matchConditions: [] },
];

const SAMPLE_ARGS = Object.freeze({
  frontDoorId: "00000000-1111-2222-3333-444444444444",
  vpnClientAddressPool: "172.16.200.0/24",
});

// ===========================================================================
// Merged-shape cases
// ===========================================================================

test("buildAutoSeedRules: vpnGatewayEnabled=false → []", () => {
  assert.deepEqual(
    buildAutoSeedRules({ vpnGatewayEnabled: false, ...SAMPLE_ARGS }),
    [],
  );
});

test("buildAutoSeedRules: vpnGatewayEnabled=true → three rules at priorities 90/91/92", () => {
  const rules = buildAutoSeedRules({ vpnGatewayEnabled: true, ...SAMPLE_ARGS });
  assert.equal(rules.length, 3);
  assert.deepEqual(rules.map((r) => r.name), ["AllowAfd", "AllowVpn", "BlockOther"]);
  assert.deepEqual(rules.map((r) => r.priority), [90, 91, 92]);
  assert.deepEqual(rules.map((r) => r.action), ["Allow", "Allow", "Block"]);
});

test("buildAutoSeedRules: AllowAfd matches X-Azure-FDID against frontDoorId", () => {
  const [allowAfd] = buildAutoSeedRules({ vpnGatewayEnabled: true, ...SAMPLE_ARGS });
  const mc = allowAfd.matchConditions[0];
  assert.equal(mc.matchVariables[0].variableName, "RequestHeaders");
  assert.equal(mc.matchVariables[0].selector, "X-Azure-FDID");
  assert.equal(mc.operator, "Equal");
  assert.deepEqual(mc.matchValues, [SAMPLE_ARGS.frontDoorId]);
});

test("buildAutoSeedRules: AllowVpn IPMatches vpnClientAddressPool", () => {
  const [, allowVpn] = buildAutoSeedRules({ vpnGatewayEnabled: true, ...SAMPLE_ARGS });
  const mc = allowVpn.matchConditions[0];
  assert.equal(mc.matchVariables[0].variableName, "RemoteAddr");
  assert.equal(mc.operator, "IPMatch");
  assert.deepEqual(mc.matchValues, [SAMPLE_ARGS.vpnClientAddressPool]);
});

test("buildAutoSeedRules: BlockOther IPMatches 0.0.0.0/0", () => {
  const [, , blockOther] = buildAutoSeedRules({ vpnGatewayEnabled: true, ...SAMPLE_ARGS });
  assert.deepEqual(blockOther.matchConditions[0].matchValues, ["0.0.0.0/0"]);
});

test("buildMergedCustomRules: VPN on + ops empty → seed only (3 rules)", () => {
  const merged = buildMergedCustomRules({
    vpnGatewayEnabled: true,
    ...SAMPLE_ARGS,
    operatorRules: [],
  });
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((r) => r.name), ["AllowAfd", "AllowVpn", "BlockOther"]);
});

test("buildMergedCustomRules: VPN off + ops non-empty → ops only", () => {
  const merged = buildMergedCustomRules({
    vpnGatewayEnabled: false,
    ...SAMPLE_ARGS,
    operatorRules: SAMPLE_OPS,
  });
  assert.deepEqual(merged, SAMPLE_OPS);
});

test("buildMergedCustomRules: VPN on + ops non-empty → seed then ops, in array order", () => {
  const merged = buildMergedCustomRules({
    vpnGatewayEnabled: true,
    ...SAMPLE_ARGS,
    operatorRules: SAMPLE_OPS,
  });
  assert.equal(merged.length, 5);
  assert.deepEqual(
    merged.map((r) => r.name),
    ["AllowAfd", "AllowVpn", "BlockOther", "AllowCorpNet", "BlockAnon"],
  );
});

test("buildMergedCustomRules: VPN off + ops empty → []", () => {
  assert.deepEqual(
    buildMergedCustomRules({
      vpnGatewayEnabled: false,
      ...SAMPLE_ARGS,
      operatorRules: [],
    }),
    [],
  );
});

test("buildMergedCustomRules: tolerates undefined operatorRules", () => {
  const merged = buildMergedCustomRules({
    vpnGatewayEnabled: true,
    ...SAMPLE_ARGS,
    operatorRules: undefined,
  });
  assert.equal(merged.length, 3);
});

// ===========================================================================
// Bicep ↔ JS shape parity (lightweight string-shape guard)
//
// Asserts the bicep file still contains the three rule names + priorities
// in the expected order. Catches a divergent edit to either side that
// doesn't update both. Not a substitute for a full snapshot harness, but
// it makes the lockstep requirement testable.
// ===========================================================================
test("bicep application-gateway.bicep autoSeed rules match JS helper names + priorities", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const bicepPath = join(REPO_ROOT, "deploy", "services", "base-infra", "bicep", "application-gateway.bicep");
  const raw = readFileSync(bicepPath, "utf8");
  // Extract the autoSeedRules block (between `var autoSeedRules = vpnGatewayEnabled ? [` and `] : []`).
  const m = raw.match(/var autoSeedRules = vpnGatewayEnabled \? \[([\s\S]*?)\] : \[\]/);
  assert.ok(m, "could not locate autoSeedRules block in application-gateway.bicep");
  const block = m[1];
  // Names appear in order.
  const namesInOrder = ["AllowAfd", "AllowVpn", "BlockOther"];
  let lastIdx = -1;
  for (const name of namesInOrder) {
    const idx = block.indexOf(`name: '${name}'`);
    assert.ok(idx > lastIdx, `bicep autoSeedRules block missing or out-of-order: ${name}`);
    lastIdx = idx;
  }
  // Priorities 90/91/92 appear in order.
  const prios = [...block.matchAll(/priority:\s+(\d+)/g)].map((mm) => Number(mm[1]));
  assert.deepEqual(prios, [90, 91, 92], "bicep autoSeedRules priorities drifted from JS helper");
});

// ===========================================================================
// File path resolution
// ===========================================================================

test("resolveAppgwWafCustomRulesFile: unset → null", () => {
  assert.equal(resolveAppgwWafCustomRulesFile(undefined), null);
  assert.equal(resolveAppgwWafCustomRulesFile(""), null);
  assert.equal(resolveAppgwWafCustomRulesFile("   "), null);
});

test("resolveAppgwWafCustomRulesFile: missing file → named error mirroring AFD shape", () => {
  assert.throws(
    () => resolveAppgwWafCustomRulesFile("deploy/envs/local/__does_not_exist__/appgw.json"),
    /APPGW_WAF_CUSTOM_RULES_FILE points to a missing file:.*Either unset it or create the JSON array file/s,
  );
});

test("resolveAppgwWafCustomRulesFile: absolute path is used verbatim", () => {
  const dir = mkdtempSync(join(tmpdir(), "appgw-waf-"));
  try {
    const file = join(dir, "rules.json");
    writeFileSync(file, JSON.stringify(SAMPLE_OPS));
    const out = resolveAppgwWafCustomRulesFile(file);
    assert.equal(out.absPath, file);
    assert.deepEqual(out.rules, SAMPLE_OPS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppgwWafCustomRulesFile: malformed JSON → named error", () => {
  const dir = mkdtempSync(join(tmpdir(), "appgw-waf-"));
  try {
    const file = join(dir, "rules.json");
    writeFileSync(file, "{not json");
    assert.throws(
      () => resolveAppgwWafCustomRulesFile(file),
      /APPGW_WAF_CUSTOM_RULES_FILE is not valid JSON/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppgwWafCustomRulesFile: non-array JSON → named error", () => {
  const dir = mkdtempSync(join(tmpdir(), "appgw-waf-"));
  try {
    const file = join(dir, "rules.json");
    writeFileSync(file, JSON.stringify({ not: "an array" }));
    assert.throws(
      () => resolveAppgwWafCustomRulesFile(file),
      /must contain a JSON array of WAF custom rules/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Alias mapping: frontDoorId → FRONT_DOOR_ID via deploy-bicep.mjs aliasFor()
// (covers the global-infra → base-infra flow added in Phase 1).
// ===========================================================================

test("aliasFor: frontDoorId → FRONT_DOOR_ID (auto-derived, no explicit OUTPUT_ALIAS needed)", () => {
  const { OUTPUT_ALIAS, aliasFor } = _internals;
  // Not in the explicit override map …
  assert.ok(!("frontDoorId" in OUTPUT_ALIAS), "frontDoorId should rely on the default camelCase rule");
  // … so it flows via the default camelCase → UPPER_SNAKE rule.
  assert.equal(aliasFor("frontDoorId"), "FRONT_DOOR_ID");
});
