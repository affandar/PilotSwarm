// Mirror of the AppGw WAF custom-rules merge logic in
// `deploy/services/base-infra/bicep/application-gateway.bicep:82-142`.
//
// The bicep file remains the source of truth for the runtime WAF policy;
// this JS helper exists so the merge shape can be unit-tested without
// shelling out to `az`. The two implementations are kept in lockstep by
// code review — any change to the bicep `autoSeedRules` / `mergedCustomRules`
// vars MUST be reflected here, and vice versa.
//
// Phase 2 of vpn-p2s-ingress (Plan §"Phase 2 / Tests for AppGw WAF custom-
// rules wiring"): bicep `var` shape is mirrored exactly so the four merged-
// shape cases (VPN on/off × operator rules present/absent) can assert the
// exact rule objects rather than just lengths.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { REPO_ROOT } from "./common.mjs";

// Build the auto-seeded AppGw WAF guard rules. Returns [] when
// vpnGatewayEnabled is false, mirroring the bicep ternary.
//
// frontDoorId / vpnClientAddressPool are inlined verbatim into the
// matchValues arrays, matching the bicep — passing empty strings produces
// rules with empty matchValues which Azure will reject at deploy time,
// but the validator gate (validateVpnGatewayCombo + the FRONT_DOOR_ID
// alias being non-empty when VPN is enabled) guards against that case
// before we get here.
export function buildAutoSeedRules({ vpnGatewayEnabled, frontDoorId, vpnClientAddressPool }) {
  if (!vpnGatewayEnabled) return [];
  return [
    {
      name: "AllowAfd",
      priority: 90,
      ruleType: "MatchRule",
      action: "Allow",
      matchConditions: [
        {
          matchVariables: [
            { variableName: "RequestHeaders", selector: "X-Azure-FDID" },
          ],
          operator: "Equal",
          matchValues: [frontDoorId],
        },
      ],
    },
    {
      name: "AllowVpn",
      priority: 91,
      ruleType: "MatchRule",
      action: "Allow",
      matchConditions: [
        {
          matchVariables: [{ variableName: "RemoteAddr" }],
          operator: "IPMatch",
          matchValues: [vpnClientAddressPool],
        },
      ],
    },
    {
      name: "BlockOther",
      priority: 92,
      ruleType: "MatchRule",
      action: "Block",
      matchConditions: [
        {
          matchVariables: [{ variableName: "RemoteAddr" }],
          operator: "IPMatch",
          matchValues: ["0.0.0.0/0"],
        },
      ],
    },
  ];
}

// Mirror of bicep `var mergedCustomRules = concat(autoSeedRules, appgwWafCustomRules)`.
export function buildMergedCustomRules({ vpnGatewayEnabled, frontDoorId, vpnClientAddressPool, operatorRules }) {
  const seed = buildAutoSeedRules({ vpnGatewayEnabled, frontDoorId, vpnClientAddressPool });
  const ops = Array.isArray(operatorRules) ? operatorRules : [];
  return [...seed, ...ops];
}

// Resolve APPGW_WAF_CUSTOM_RULES_FILE to an absolute path, parse its JSON
// contents, and return `{ absPath, rules }`. Mirrors the AFD-side
// WAF_CUSTOM_RULES_FILE machinery in deploy-bicep.mjs:226-243.
//
// Throws with the same error shape as the AFD path when the file is
// missing or malformed (so the operator sees one diagnostic shape across
// both edges).
export function resolveAppgwWafCustomRulesFile(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null; // unset = no file = no operator rules
  }
  const abs = isAbsolute(raw) ? raw : join(REPO_ROOT, raw);
  if (!existsSync(abs)) {
    throw new Error(
      `APPGW_WAF_CUSTOM_RULES_FILE points to a missing file: ${abs}. ` +
        `Either unset it or create the JSON array file (gitignored under deploy/envs/local/).`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(
      `APPGW_WAF_CUSTOM_RULES_FILE is not valid JSON (${abs}): ${e.message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `APPGW_WAF_CUSTOM_RULES_FILE must contain a JSON array of WAF custom rules (${abs}).`,
    );
  }
  return { absPath: abs, rules: parsed };
}
