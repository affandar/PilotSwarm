// new-env.mjs — scaffolder for personal/local env files.
//
// Usage:
//   npm run deploy:new-env                                       (interactive)
//   npm run deploy:new-env -- <name>                             (interactive, name pre-filled)
//   npm run deploy:new-env -- <name> --subscription <id> --location <loc>
//
// (Equivalent direct invocation: `node deploy/scripts/new-env.mjs ...`)
//
// Creates `deploy/envs/local/<name>/.env` by copying `deploy/envs/template.env`
// and substituting deployment-target keys using the same naming patterns
// The enterprise path uses (the enterprise deployment manifests):
//
//   • resourcePrefix       = ps<name>
//   • azureResourceGroup   = ${resourcePrefix}-${regionShortName}-rg
//   • globalResourcePrefix = ${resourcePrefix}global
//   • globalResourceGroup  = ${globalResourcePrefix}
//   • portalResourceName   = ${resourcePrefix}-${regionShortName}-portal
//
// The local env file is STANDALONE: deploy.mjs reads it directly with no
// runtime cascade onto the template. Future template edits affect only
// newly-scaffolded envs — never existing ones. Re-run `--force` to
// regenerate from the latest template (existing per-stamp secrets are
// preserved through the prompt flow).
//
// ─── Adding a new top-level input ──────────────────────────────────────────
// The CLI surface is schema-driven (see INPUTS below). To add a new input:
//
//   1. Append a new entry to INPUTS with `argKey`, `flag`, `metavar`, `help`,
//      and an `interactive(rl, ctx)` async fn.
//   2. If the input has a non-empty default in non-interactive mode, also
//      add `nonInteractiveDefault(ctx)`.
//   3. Map the resolved value into the rendered .env inside `deriveTargets`
//      (one extra line per env-var key).
//   4. If the input is referenced by template.env, add a `KEY=` placeholder
//      there so overrides land in-place rather than at the end of the file.
//
// parseArgs, usage(), and gatherInputs all iterate INPUTS — no further
// edits required for argv parsing or help text.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { validateLocalEnvName, envFilePath, parseEnvFile, templateEnvPath, log } from "./lib/common.mjs";
import { loadDeployManifest } from "./lib/services-manifest.mjs";
import { SEEDABLE_SECRET_KEYS, SEED_SECRETS_UNSET_SENTINEL } from "./lib/seed-secrets.mjs";
import { PORTAL_CONFIG_KEYS } from "./lib/portal-config.mjs";
import { listAvailableFoundryModels } from "./lib/validate-foundry-deployments.mjs";
import {
  EDGE_MODES as CONTRACT_EDGE_MODES,
  TLS_SOURCES as CONTRACT_TLS_SOURCES,
  DEFAULT_EDGE_MODE as CONTRACT_DEFAULT_EDGE_MODE,
  DEFAULT_TLS_SOURCE as CONTRACT_DEFAULT_TLS_SOURCE,
  validateRequiredEnv,
  validateVpnGatewayCombo,
  applyStubKeys,
} from "./lib/overlay-contracts.mjs";

// Common Azure regions → short name. Sourced from
// deploy/services/deploy-manifest.json `regionShort`. Unknown regions prompt
// the user for a short name.
function regionShortFor(location) {
  const m = loadDeployManifest();
  return m.regionShort[location.toLowerCase()] ?? null;
}

// EDGE_MODES / DEFAULT_EDGE_MODE / TLS_SOURCES / DEFAULT_TLS_SOURCE are
// re-exported from the overlay-contracts single source of truth
// (deploy/scripts/lib/overlay-contracts.mjs). The local aliases below
// keep the existing call sites readable.
const EDGE_MODES = CONTRACT_EDGE_MODES;
const DEFAULT_EDGE_MODE = CONTRACT_DEFAULT_EDGE_MODE;

// CA cert source.
//   letsencrypt    — cert-manager + LE prod ACME (HTTP-01). Only valid with
//                    edgeMode=afd. OSS public default.
//   akv            — AKV-registered issuer (e.g. OneCertV2-PublicCA for afd,
//                    OneCertV2-PrivateCA for private) + bicep cert deployment
//                    script. enterprise / closed-network path.
//   akv-selfsigned — AKV `Self` issuer; bicep auto-creates a self-signed cert
//                    in AKV with SAN=${HOST}.${PRIVATE_DNS_ZONE}. Only valid
//                    with edgeMode=private. OSS private demo path; zero
//                    external dependencies.
const TLS_SOURCES = CONTRACT_TLS_SOURCES;
const DEFAULT_TLS_SOURCE = CONTRACT_DEFAULT_TLS_SOURCE;

// Combos blocked at validation time. Mirrors the Portal bicep `@allowed`
// invariants: letsencrypt requires a public IP for HTTP-01 (afd only);
// akv-selfsigned has no use case under afd (AFD won't trust a self-signed
// chain). Both unsupported combos are reported with a clear remediation.
const UNSUPPORTED_COMBOS = [
  {
    edgeMode: "private",
    tlsSource: "letsencrypt",
    reason:
      "Let's Encrypt HTTP-01 requires a public IP, which private mode does not have. " +
      "Use --tls-source akv (BYO CA via AKV-registered issuer) or akv-selfsigned (AKV Self issuer).",
  },
  {
    edgeMode: "afd",
    tlsSource: "akv-selfsigned",
    reason:
      "Azure Front Door rejects self-signed origin chains. " +
      "Use --tls-source letsencrypt (OSS) or akv (enterprise) with afd.",
  },
];

function unsupportedReason(edgeMode, tlsSource) {
  const hit = UNSUPPORTED_COMBOS.find(
    (c) => c.edgeMode === edgeMode && c.tlsSource === tlsSource,
  );
  return hit ? hit.reason : null;
}

// Normalise a y/n/yes/no/true/false answer to the literal "y" or "n".
// Used by every yes/no INPUT (foundryEnabled, vpnEnabled).
function normaliseYesNo(v) {
  const s = String(v ?? "").toLowerCase();
  if (s === "y" || s === "yes" || s === "true") return "y";
  if (s === "n" || s === "no" || s === "false" || s === "") return "n";
  return s;
}

// VPN gateway combo refusal at scaffold time. Mirrors the
// validateVpnGatewayCombo() error-code style used by deploy.mjs at
// pre-deploy time (Phase 2). Throws a single named error covering BOTH
// edge-mode and tls-source mismatches in one message — the operator
// shouldn't have to bounce the prompt twice to discover both.
//
// Called from interactive flow (after vpnEnabled is captured) AND from
// the non-interactive --vpn-enabled path so flags-only invocations
// (tests, CI) hit the same hard gate. Refusal is a hard error before any
// .env file is written, matching the Phase 3 plan ("exit without writing
// a partial env file").
function assertVpnGatewayCombo(edgeMode, tlsSource) {
  const em = String(edgeMode ?? "").toLowerCase();
  const ts = String(tlsSource ?? "").toLowerCase();
  const reasons = [];
  if (em !== "afd") {
    reasons.push(
      "EDGE_MODE must be 'afd' (got '" + (edgeMode ?? "") + "')",
    );
  }
  if (ts !== "akv") {
    reasons.push(
      "TLS_SOURCE must be 'akv' (got '" + (tlsSource ?? "") + "')",
    );
  }
  if (reasons.length === 0) return;
  throw new Error(
    "[vpn-incompatible-combo] VPN gateway requires EDGE_MODE=afd + TLS_SOURCE=akv. " +
      reasons.join("; ") + ". " +
      "Re-run scaffolder with --edge-mode afd --tls-source akv, or omit " +
      "--vpn-enabled (defaults to no). See deploy/docs/vpn-p2s.md.",
  );
}

// VPN client-address-pool overlap check. Reuses Phase 2's
// validateVpnGatewayCombo() so the overlap arithmetic stays in one place
// (cidrsOverlap is module-private to overlay-contracts.mjs, so we drive
// the public helper with a stub env that satisfies every other gate and
// only surfaces the pool check). Returns true|<error message string> in
// the shape runDeclarativePrompt's `validate` field expects.
function validateVpnClientAddressPool(pool, vnetCidr) {
  const env = {
    VPN_GATEWAY_ENABLED: "true",
    SSL_CERT_DOMAIN_SUFFIX: "scaffolder.local",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    VPN_CLIENT_ADDRESS_POOL: pool,
  };
  if (vnetCidr) env.VNET_CIDR = vnetCidr;
  // Drive with a known-valid edge/tls so only pool/tenant/etc errors can fire.
  const codes = validateVpnGatewayCombo({
    edgeMode: "afd",
    tlsSource: "akv",
    env,
  });
  if (codes.includes("vpn-pool-overlap")) {
    const vnet = vnetCidr || "10.20.0.0/16";
    return (
      `VPN_CLIENT_ADDRESS_POOL '${pool}' overlaps the stamp VNet CIDR '${vnet}' ` +
      `(or is malformed). Pick a non-overlapping IPv4 CIDR, e.g. 172.16.200.0/24.`
    );
  }
  return true;
}

// ─── Interactive prompt helpers ───────────────────────────────────────────
async function prompt(rl, question, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const ans = (await rl.question(`${question}${suffix}: `)).trim();
  return ans || defaultValue || "";
}

// Numbered single-select menu. Renders each choice on its own line with a
// 1-based index, marks the default with `(default)`, and accepts either
// the numeric index or the literal value. Loops until the user picks a
// valid option. An empty input picks the default.
async function chooseFromList(rl, question, choices, defaultValue, descriptions = {}) {
  console.log(`\n${question}:`);
  choices.forEach((c, i) => {
    const marker = c === defaultValue ? " (default)" : "";
    const desc = descriptions[c] ? ` — ${descriptions[c]}` : "";
    console.log(`  ${i + 1}) ${c}${marker}${desc}`);
  });
  while (true) {
    const ans = (await rl.question(`Select [1-${choices.length}, default ${defaultValue}]: `)).trim();
    if (!ans) return defaultValue;
    const asIndex = Number.parseInt(ans, 10);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= choices.length) {
      return choices[asIndex - 1];
    }
    if (choices.includes(ans)) return ans;
    console.error(`  must be 1-${choices.length} or one of: ${choices.join(", ")}`);
  }
}

// Resolve a possibly-function-form schema field against ctx.
function resolveField(field, ctx) {
  return typeof field === "function" ? field(ctx) : field;
}

// Generic runner for declarative INPUTS entries. Handles type=text and
// type=menu, optional default / promptIf / validate / transform. An entry
// with a custom `interactive` function bypasses this runner entirely.
async function runDeclarativePrompt(rl, ctx, def) {
  if (def.promptIf && !def.promptIf(ctx)) return "";

  const defaultValue = resolveField(def.default, ctx) ?? null;

  if (def.type === "menu") {
    const choices = resolveField(def.choices, ctx);
    const descriptions = resolveField(def.choiceDescriptions, ctx) ?? {};
    const menuDefault = choices.includes(defaultValue) ? defaultValue : choices[0];
    return chooseFromList(rl, def.prompt, choices, menuDefault, descriptions);
  }

  // type=text (default)
  while (true) {
    let v = (await prompt(rl, def.prompt, defaultValue ?? "")).trim();
    if (def.transform === "lowercase") v = v.toLowerCase();
    else if (def.transform === "trim") v = v.trim();
    else if (typeof def.transform === "function") v = def.transform(v);

    if (def.validate) {
      let result;
      if (def.validate instanceof RegExp) {
        result = def.validate.test(v) ? true : (def.validateError ?? "invalid value");
      } else {
        result = def.validate(v);
      }
      if (result !== true) {
        console.error(`  ${result}`);
        continue;
      }
    }
    return v;
  }
}

// ─── Input schema ──────────────────────────────────────────────────────────
// Single source of truth for every top-level scaffolder input. Drives:
//   • parseArgs       (flag → argKey + cliChoices validation)
//   • usage()         (auto-generated --help text)
//   • gatherInputs    (non-interactive defaults + interactive prompts)
//
// Most inputs are fully declarative — describe them with data, the generic
// `runDeclarativePrompt` runner handles the readline interaction. Reach for
// the `interactive` override only when you need genuinely-bespoke behavior
// (filtered choices keyed off another input, lookups against external
// manifests, auto-derived values that don't prompt).
//
// Common (declarative) fields:
//   argKey          — key in the parsed args object (camelCase). Required.
//   flag            — CLI flag, e.g. "--subscription". Omit + set
//                     positional=true for the bare-arg slot.
//   positional      — true for the bare-arg input (only `name`).
//   metavar         — token rendered after the flag in --help, e.g. "<id>".
//   help            — string or string[] of help lines.
//   cliChoices      — restrict --flag values to this list (parseArgs check).
//   type            — "text" (default) | "menu".
//   prompt          — interactive question text.
//   default         — string or (ctx) => string applied as the prompt
//                     default and as the non-interactive fallback. Empty
//                     string ("") is fine; null/undefined means "no default."
//   choices         — array or (ctx) => array. Required for type=menu.
//   choiceDescriptions — object or (ctx) => object keyed by choice value.
//   validate        — RegExp or (value) => true | "error message". Empty
//                     string is passed in; return an error string to reject.
//   validateError   — error text for RegExp `validate` (function form
//                     returns its own).
//   transform       — "lowercase" | "trim" | (v) => v. Applied before validate.
//   promptIf        — (ctx) => bool. False ⇒ skip prompt, value is "".
//
// Escape hatches (only if declarative fields don't fit):
//   interactive           — async (rl, ctx) => value. Bypasses runner.
//   nonInteractiveDefault — (ctx) => value for the non-interactive path
//                           (overrides `default` there). Used when the
//                           non-interactive default is dynamic but you don't
//                           want to set `default` (e.g. region-short lookup).
export const INPUTS = [
  {
    argKey: "name",
    positional: true,
    metavar: "<name>",
    help: "Env name (1–12 chars, lowercase, must start with letter; not 'dev' or 'prod').",
    prompt: "Env name (1–12 chars, lowercase, must start with letter)",
    validate: (v) => {
      try {
        validateLocalEnvName(v);
        return true;
      } catch (e) {
        return e.message;
      }
    },
  },
  {
    argKey: "subscription",
    flag: "--subscription",
    metavar: "<id>",
    help: "Azure subscription id.",
    prompt: "Subscription id (UUID, leave blank to fill in later)",
    default: "",
  },
  {
    argKey: "location",
    flag: "--location",
    metavar: "<loc>",
    help: "Azure region (e.g. westus3).",
    prompt: "Azure location",
    default: "westus3",
  },
  {
    argKey: "regionShort",
    flag: "--region-short",
    metavar: "<s>",
    help: "Short name (e.g. wus3); default derived from --location.",
    // Dynamic default: lookup from deploy-manifest.json. Falls back to a
    // prompt only when the location isn't in the manifest.
    nonInteractiveDefault: (ctx) => regionShortFor(ctx.location),
    interactive: async (rl, ctx) => {
      const known = regionShortFor(ctx.location);
      if (known) return known;
      const rs = await prompt(rl, `Region short name for '${ctx.location}' (e.g. wus3, eus2)`, null);
      if (!rs) throw new Error(`region-short is required for unknown location '${ctx.location}'.`);
      return rs;
    },
  },
  {
    argKey: "edgeMode",
    flag: "--edge-mode",
    metavar: "<m>",
    help: "afd | private (default: afd).",
    cliChoices: EDGE_MODES,
    type: "menu",
    prompt: "Edge mode",
    default: DEFAULT_EDGE_MODE,
    choices: EDGE_MODES,
    choiceDescriptions: {
      afd: "Azure Front Door + AppGw + AGIC (public Internet endpoint, default)",
      private: "Internal LoadBalancer + web-app-routing (NGINX), private DNS zone, no AppGw",
    },
  },
  {
    argKey: "tlsSource",
    flag: "--tls-source",
    metavar: "<s>",
    help: [
      "letsencrypt | akv | akv-selfsigned (default: letsencrypt).",
      "letsencrypt requires --edge-mode afd. akv-selfsigned requires --edge-mode private.",
    ],
    cliChoices: TLS_SOURCES,
    nonInteractiveDefault: () => DEFAULT_TLS_SOURCE,
    type: "menu",
    prompt: "TLS source",
    // Filtered choices + descriptions vary by edge-mode, so use the
    // function forms of each declarative field.
    choices: (ctx) => TLS_SOURCES.filter((t) => unsupportedReason(ctx.edgeMode, t) === null),
    default: (ctx) => {
      const valid = TLS_SOURCES.filter((t) => unsupportedReason(ctx.edgeMode, t) === null);
      return valid.includes(DEFAULT_TLS_SOURCE) ? DEFAULT_TLS_SOURCE : valid[0];
    },
    choiceDescriptions: (ctx) => ({
      letsencrypt: "cert-manager + Let's Encrypt prod (HTTP-01, auto-renew, OSS public default)",
      akv:
        ctx.edgeMode === "afd"
          ? "AKV-registered OneCertV2-PublicCA issuer + bicep cert deploy (enterprise public)"
          : "AKV-registered OneCertV2-PrivateCA issuer + bicep cert deploy (AME / enterprise private)",
      "akv-selfsigned": "AKV `Self` issuer; bicep auto-creates a self-signed cert (OSS private demo)",
    }),
  },
  // VPN gateway prompts are placed immediately after tlsSource so the
  // [vpn-incompatible-combo] gate fires BEFORE any secret prompts —
  // operators don't waste time entering secrets only to be refused. The
  // cross-field combo check runs in gatherInputs() right after the
  // vpnEnabled answer is captured (see Phase 3 review SHOULD-FIX 2).
  // main() repeats the same check as defense-in-depth for fully
  // non-interactive paths where this loop is bypassed.
  {
    argKey: "vpnEnabled",
    flag: "--vpn-enabled",
    metavar: "<y|n>",
    help: [
      "Provision an Azure VPN Gateway P2S (Microsoft Entra ID auth, OpenVPN)",
      "as an additive ingress alongside AFD. Requires --edge-mode afd and",
      "--tls-source akv. Adds ~$140/mo and 45+ min to the first deploy.",
      "Default no.",
    ],
    cliChoices: ["y", "n", "yes", "no", "true", "false"],
    nonInteractiveDefault: () => "n",
    type: "menu",
    prompt: "Enable Azure VPN Gateway P2S (additive VPN ingress)?",
    default: "n",
    choices: ["n", "y"],
    choiceDescriptions: {
      n: "No VPN gateway (default)",
      y: "Provision VPN Gateway P2S (~$140/mo, 45+ min first deploy; requires EDGE_MODE=afd + TLS_SOURCE=akv)",
    },
    transform: (v) => normaliseYesNo(v),
  },
  {
    argKey: "vpnClientAddressPool",
    flag: "--vpn-client-address-pool",
    metavar: "<cidr>",
    help: [
      "VPN client address pool (IPv4 CIDR). Required when --vpn-enabled y.",
      "MUST NOT overlap the stamp VNet CIDR (default 10.20.0.0/16).",
    ],
    prompt: "VPN client address pool (IPv4 CIDR; must not overlap VNet 10.20.0.0/16)",
    default: "172.16.200.0/24",
    promptIf: (ctx) => normaliseYesNo(ctx.vpnEnabled) === "y",
    validate: (v) => validateVpnClientAddressPool(v, null),
  },
  {
    argKey: "host",
    flag: "--host",
    metavar: "<label>",
    help: "DNS label (host prefix). Required for --edge-mode private.",
    prompt: "Host (DNS label, e.g. portal)",
    default: "portal",
    promptIf: (ctx) => ctx.edgeMode === "private",
    validate: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i,
    validateError: "must be a valid DNS label",
    transform: "lowercase",
  },
  {
    argKey: "privateDnsZone",
    flag: "--private-dns-zone",
    metavar: "<z>",
    help: [
      "Azure Private DNS Zone name. Required for --edge-mode private.",
      "Resulting FQDN = <host>.<private-dns-zone>.",
    ],
    prompt: "Private DNS zone (Azure Private DNS Zone name, e.g. pilotswarm.internal)",
    promptIf: (ctx) => ctx.edgeMode === "private",
    validate: (v) =>
      /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(v) && v.includes(".")
        ? true
        : "must be a valid DNS zone name (must contain at least one dot)",
    transform: "lowercase",
  },
  {
    argKey: "portalHostname",
    flag: "--portal-hostname",
    metavar: "<h>",
    help: "[Deprecated alias of <host>.<private-dns-zone>] Override the derived FQDN.",
    // Auto-derived from host+zone for diagnostic display only; deriveTargets()
    // does the same composition for the rendered .env. No actual prompt — the
    // value is computed in private mode and left empty in afd mode.
    interactive: async (_rl, ctx) => {
      if (ctx.edgeMode === "private" && ctx.host && ctx.privateDnsZone) {
        const fqdn = `${ctx.host}.${ctx.privateDnsZone}`;
        console.log(`  → portal FQDN: ${fqdn}`);
        return fqdn;
      }
      return "";
    },
  },
  {
    argKey: "acmeEmail",
    flag: "--acme-email",
    metavar: "<addr>",
    help: "Required for --tls-source letsencrypt (LE registration / renewal notices).",
    prompt: "ACME registration email (LE renewal-failure notices)",
    promptIf: (ctx) => ctx.tlsSource === "letsencrypt",
    validate: (v) => (v && v.includes("@") ? true : "must be a valid email address"),
  },
  {
    argKey: "foundryEnabled",
    flag: "--foundry-enabled",
    metavar: "<y|n>",
    help: [
      "Provision Azure AI Foundry (Cognitive Services AIServices) account.",
      "When 'y', scaffolds deploy/envs/local/<name>/foundry-deployments.json",
      "with a starter set of model deployments the operator can edit.",
    ],
    cliChoices: ["y", "n", "yes", "no", "true", "false"],
    nonInteractiveDefault: () => "n",
    type: "menu",
    prompt: "Provision Azure AI Foundry account?",
    default: "n",
    choices: ["n", "y"],
    choiceDescriptions: {
      n: "No Foundry account (default; uses github-copilot + anthropic providers)",
      y: "Provision Foundry account + write azure-oai-key into KV",
    },
    transform: (v) => normaliseYesNo(v),
  },
];

// Boolean flags that don't carry a value (and aren't part of INPUTS).
const FLAGS = [
  { flag: "--force", short: "-f", argKey: "force", help: "Overwrite an existing local env file." },
  { flag: "--help", short: "-h", argKey: "help", help: "Show this message." },
];

function assertSupportedCombo(edgeMode, tlsSource) {
  if (!edgeMode || !tlsSource) return;
  const reason = unsupportedReason(edgeMode, tlsSource);
  if (reason) {
    throw new Error(
      `unsupported combination edge-mode=${edgeMode} + tls-source=${tlsSource}: ${reason}`,
    );
  }
}

function parseArgs(argv) {
  const args = {};
  for (const i of INPUTS) args[i.argKey] = null;
  for (const f of FLAGS) args[f.argKey] = false;

  const flagToInput = new Map(INPUTS.filter((i) => i.flag).map((i) => [i.flag, i]));
  const positional = INPUTS.find((i) => i.positional);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const boolFlag = FLAGS.find((f) => f.flag === a || f.short === a);
    if (boolFlag) {
      args[boolFlag.argKey] = true;
      continue;
    }
    const input = flagToInput.get(a);
    if (input) {
      const v = argv[++i];
      if (input.cliChoices && !input.cliChoices.includes(v)) {
        throw new Error(`${input.flag} must be one of ${input.cliChoices.join(", ")}`);
      }
      args[input.argKey] = v;
      continue;
    }
    if (positional && args[positional.argKey] == null && !a.startsWith("-")) {
      args[positional.argKey] = a;
      continue;
    }
    throw new Error(`Unexpected argument: ${a}`);
  }

  // Cross-input combo validation when both explicitly provided. The
  // interactive flow re-checks defensively; non-interactive runs rely on
  // assertSupportedCombo() in main() after defaults are applied.
  assertSupportedCombo(args.edgeMode, args.tlsSource);
  return args;
}

function usage() {
  const lines = [
    "Usage: npm run deploy:new-env -- [<name>] [options]",
    "",
    "Creates a personal local env at deploy/envs/local/<name>/.env.",
    "<name> must match /^[a-z][a-z0-9]{0,11}$/ and not be a reserved name (dev, prod).",
    "Any flag not provided is prompted for interactively.",
    "",
    "Options:",
  ];
  const PAD = 22;
  const fmt = (left, help) => {
    const helpLines = Array.isArray(help) ? help : [help];
    const head = `  ${left.padEnd(PAD)} ${helpLines[0]}`;
    const rest = helpLines.slice(1).map((l) => " ".repeat(PAD + 3) + l);
    return [head, ...rest];
  };
  for (const i of INPUTS) {
    if (!i.flag) continue;
    lines.push(...fmt(`${i.flag} ${i.metavar ?? ""}`.trimEnd(), i.help));
  }
  for (const f of FLAGS) {
    const left = f.short ? `${f.flag}, ${f.short}` : f.flag;
    lines.push(...fmt(left, f.help));
  }
  return lines.join("\n");
}

// Derive deployment-target values from a small set of inputs, matching the enterprise path
// serviceModel.json naming patterns. Pure function — no I/O.
export function deriveTargets({ name, subscription, location, regionShort, edgeMode, host, privateDnsZone, portalHostname, tlsSource, acmeEmail, foundryEnabled, vpnEnabled, vpnClientAddressPool }) {
  const prefix = `ps${name}`;
  const globalPrefix = `${prefix}global`;
  const resolvedEdgeMode = edgeMode ?? DEFAULT_EDGE_MODE;
  // In private mode the FQDN is composed from HOST + PRIVATE_DNS_ZONE
  // (deploy-time derived; the same FQDN feeds the cert SAN, the Private DNS
  // Zone A record, and PORTAL_HOSTNAME). Caller may override with
  // --portal-hostname for legacy / non-Azure-DNS scenarios. In afd mode
  // PORTAL_HOSTNAME is derived by bicep from the AppGw DNS label and left
  // empty here.
  let derivedPortalHostname = portalHostname ?? "";
  if (!derivedPortalHostname && resolvedEdgeMode === "private" && host && privateDnsZone) {
    derivedPortalHostname = `${host}.${privateDnsZone}`;
  }
  // Normalise yes/no inputs the same way main() does (normaliseYesNo).
  // The CLI accepts y|n|yes|no|true|false (and JS boolean true from
  // programmatic callers), so a plain `=== "y"` check would silently
  // disable the feature on `--foundry-enabled yes` / `--vpn-enabled true`
  // and friends. Boolean `true` is normalised via String(v).
  const foundryOn = normaliseYesNo(foundryEnabled) === "y";
  // VPN_GATEWAY_SKU and VPN_AAD_AUDIENCE flow through from template.env
  // defaults (VpnGw1 and the Microsoft-registered Azure VPN Client app id
  // c632b3df-... respectively); we don't prompt for them and don't
  // override here. When VPN is disabled the template's
  // VPN_GATEWAY_ENABLED=false default flows through unchanged — we still
  // emit it explicitly to keep the rendered .env deterministic.
  const vpnOn = normaliseYesNo(vpnEnabled) === "y";
  return {
    SUBSCRIPTION_ID: subscription ?? "",
    LOCATION: location,
    RESOURCE_PREFIX: prefix,
    RESOURCE_GROUP: `${prefix}-${regionShort}-rg`,
    GLOBAL_RESOURCE_PREFIX: globalPrefix,
    GLOBAL_RESOURCE_GROUP: globalPrefix,
    PORTAL_RESOURCE_NAME: `${prefix}-${regionShort}-portal`,
    EDGE_MODE: resolvedEdgeMode,
    // DNS label (host prefix) used to compose the portal FQDN in private
    // mode. Empty in afd mode.
    HOST: host ?? "",
    // Azure Private DNS Zone name. Bicep provisions the zone, links it to
    // the AKS VNet, and writes an A record `${HOST}` → ILB private IP.
    // Required in private mode; empty in afd mode.
    PRIVATE_DNS_ZONE: privateDnsZone ?? "",
    // Resolved portal FQDN. In private mode = `${HOST}.${PRIVATE_DNS_ZONE}`
    // (or a caller override); in afd mode this is left empty and bicep
    // derives it from the AppGw DNS label and surfaces it via the
    // backendHostName output.
    PORTAL_HOSTNAME: derivedPortalHostname,
    TLS_SOURCE: tlsSource ?? DEFAULT_TLS_SOURCE,
    // ACME registration email for Let's Encrypt — used by the cert-manager
    // ClusterIssuer. Required when TLS_SOURCE=letsencrypt; ignored for akv*.
    ACME_EMAIL: acmeEmail ?? "",
    // Azure AI Foundry — see deploy/services/base-infra/bicep/foundry.bicep.
    // FOUNDRY_DEPLOYMENTS_FILE points at a per-stamp JSON file the
    // scaffolder writes into deploy/envs/local/<name>/foundry-deployments.json
    // when foundryEnabled is selected. When disabled, both keys flow
    // through as their disabled values.
    FOUNDRY_ENABLED: foundryOn ? "true" : "false",
    FOUNDRY_DEPLOYMENTS_FILE: foundryOn ? `deploy/envs/local/${name}/foundry-deployments.json` : "",
    // VPN gateway (Phase 3). Only the two prompted keys are threaded;
    // VPN_GATEWAY_SKU and VPN_AAD_AUDIENCE remain at their template
    // defaults (VpnGw1 / c632b3df-... respectively) and the operator
    // overrides them by hand-editing the .env if needed (e.g. legacy
    // 41b23e61-... audience, larger SKU). When VPN is disabled the pool
    // override is omitted so the template's documented default
    // (172.16.200.0/24) flows through unchanged.
    VPN_GATEWAY_ENABLED: vpnOn ? "true" : "false",
    ...(vpnOn && vpnClientAddressPool ? { VPN_CLIENT_ADDRESS_POOL: vpnClientAddressPool } : {}),
  };
}

// Replace KEY=value lines in `templateText` for any key in `overrides`,
// preserving comments and ordering. Keys not present in the template
// are appended at the end (with no comment) so the local file remains a
// complete, standalone deployment record.
export function applyOverridesToTemplate(templateText, overrides) {
  const seen = new Set();
  const lines = templateText.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      out.push(line);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      out.push(line);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      seen.add(key);
      out.push(`${key}=${overrides[key] ?? ""}`);
    } else {
      out.push(line);
    }
  }
  // Append any override keys the template didn't already declare.
  const trailing = [];
  for (const [k, v] of Object.entries(overrides)) {
    if (!seen.has(k)) trailing.push(`${k}=${v ?? ""}`);
  }
  if (trailing.length) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(...trailing);
  }
  return out.join("\n");
}

export function renderLocalEnv({ name, targets, secrets, portalConfig, templateText }) {
  const tpl = templateText ?? readFileSync(templateEnvPath(), "utf8");

  const header = [
    `# Personal local env '${name}' — gitignored.`,
    `# Generated by deploy/scripts/new-env.mjs from deploy/envs/template.env.`,
    `#`,
    `# This file is STANDALONE: deploy.mjs reads it directly with no cascade`,
    `# onto the template. Future edits to deploy/envs/template.env will not`,
    `# retroactively change this env. Re-run \`npm run deploy:new-env --`,
    `# ${name} --force\` to regenerate from the latest template.`,
    `#`,
    `# Resource *names* inside Azure (storage account, KV, ACR, AKS, etc.) are`,
    `# derived from RESOURCE_PREFIX inside Bicep — do not hand-list them.`,
    ``,
  ].join("\n");

  // Strip the template's own header comment (lines up to the first
  // non-comment, non-blank line) so we don't accumulate two banners.
  const tplLines = tpl.split(/\r?\n/);
  let firstReal = 0;
  for (; firstReal < tplLines.length; firstReal++) {
    const t = tplLines[firstReal].trim();
    if (t && !t.startsWith("#")) break;
  }
  // Walk back to the most recent section divider (a `# ─── … ───` heading)
  // or blank line so the first body section keeps its own comment block.
  let bodyStart = firstReal;
  while (bodyStart > 0) {
    const t = tplLines[bodyStart - 1].trim();
    if (t.startsWith("# ─") || t === "") break;
    bodyStart--;
  }
  const tplBody = tplLines.slice(bodyStart).join("\n");

  // Apply deployment-target overrides into the template body.
  const substituted = applyOverridesToTemplate(tplBody, targets);

  const secretsBlock = [
    ``,
    `# ─── Per-stamp secrets ────────────────────────────────────────────────────`,
    `# Read by the seed-secrets pipeline step (deploy/scripts/lib/seed-secrets.mjs)`,
    `# and written into the per-stamp Key Vault. Keep this file out of source`,
    `# control — the parent deploy/envs/.gitignore already excludes local/.`,
    ``,
  ];
  for (const { env: key, required } of SEEDABLE_SECRET_KEYS) {
    const value = secrets?.[key] ?? "";
    const tag = required ? "required" : "optional";
    secretsBlock.push(`# ${key} (${tag})`);
    secretsBlock.push(`${key}=${value}`);
    secretsBlock.push(``);
  }

  // ─── Portal config (non-credential) ──────────────────────────────────────
  // Auth/authz settings consumed by the portal at runtime. NOT seeded into
  // Key Vault — they flow through the overlay .env → portal-env ConfigMap
  // path. Empty values get rendered as the seed-secrets sentinel so
  // substitute-env's fail-closed gate is satisfied; the portal runtime
  // strips the sentinel from process.env at startup.
  const portalConfigBlock = [
    ``,
    `# ─── Portal config (non-credential) ──────────────────────────────────────`,
    `# Read by deploy/scripts/lib/portal-config.mjs and substituted into the`,
    `# portal overlay .env. These are NOT secrets; they are projected via the`,
    `# portal-env ConfigMap (envFrom configMapRef in deployment.yaml). Leave`,
    `# blank to render the ${SEED_SECRETS_UNSET_SENTINEL} sentinel — the portal`,
    `# strips sentinel values at startup so the key appears truly unset.`,
    ``,
  ];
  for (const { env: key } of PORTAL_CONFIG_KEYS) {
    const value = portalConfig?.[key] ?? "";
    portalConfigBlock.push(`${key}=${value || SEED_SECRETS_UNSET_SENTINEL}`);
  }

  return header + substituted.replace(/\s*$/, "") + "\n" + secretsBlock.join("\n") + portalConfigBlock.join("\n") + "\n";
}

async function gatherInputs(args, existingSecrets, existingPortalConfig) {
  const interactive = !args.name || !args.subscription || !args.location;

  // Resolve a single input's value for the non-interactive path: explicit
  // arg → nonInteractiveDefault → declarative `default` → "".
  const nonInteractiveValue = (i, ctx) => {
    const fromArgs = args[i.argKey];
    if (fromArgs != null && fromArgs !== "") return fromArgs;
    if (i.nonInteractiveDefault) return i.nonInteractiveDefault(ctx) ?? "";
    if (i.default !== undefined) return resolveField(i.default, ctx) ?? "";
    return "";
  };

  if (!interactive) {
    // Fully non-interactive: tests / CI / scripted invocations. We don't
    // touch readline at all, so secrets just get whatever was already in
    // the env file (or empty for first run). Users can fill them in by
    // re-running new-env with --force to be re-prompted, or by editing
    // the file directly.
    const ctx = {};
    for (const i of INPUTS) ctx[i.argKey] = nonInteractiveValue(i, ctx);
    return {
      ...ctx,
      secrets: { ...(existingSecrets ?? {}) },
      portalConfig: { ...(existingPortalConfig ?? {}) },
    };
  }

  const rl = createInterface({ input, output });
  try {
    // Walk INPUTS in declaration order. Each entry receives a `ctx` object
    // populated with previously-resolved values, so later prompts can branch
    // on earlier ones (e.g. tlsSource filters choices by edgeMode; host /
    // privateDnsZone only prompt in private mode).
    const ctx = {};
    for (const i of INPUTS) {
      if (args[i.argKey] != null) {
        ctx[i.argKey] = args[i.argKey];
      } else {
        // Custom imperative override wins; otherwise drive the declarative runner.
        ctx[i.argKey] = i.interactive
          ? await i.interactive(rl, ctx)
          : await runDeclarativePrompt(rl, ctx, i);
      }

      // Early VPN combo gate — fires immediately after the vpnEnabled
      // value is resolved (whether from --vpn-enabled flag or from the
      // interactive prompt) so the operator sees the
      // [vpn-incompatible-combo] error BEFORE being asked for
      // vpnClientAddressPool, secrets, or portal config. main() repeats
      // this check (and the pool-overlap check) for fully
      // non-interactive invocations where this loop is bypassed
      // entirely. See Phase 3 review SHOULD-FIX 2.
      if (i.argKey === "vpnEnabled" && normaliseYesNo(ctx.vpnEnabled) === "y") {
        assertVpnGatewayCombo(ctx.edgeMode, ctx.tlsSource);
      }
      // Pool-overlap re-check immediately after the pool input is
      // resolved. The declarative `validate` hook already loops on bad
      // input in the interactive path; this catches the case where
      // --vpn-client-address-pool was supplied via flag (runDeclarativePrompt
      // is skipped when args[argKey] != null).
      if (i.argKey === "vpnClientAddressPool" && normaliseYesNo(ctx.vpnEnabled) === "y") {
        const pool = ctx.vpnClientAddressPool || "172.16.200.0/24";
        const r = validateVpnClientAddressPool(pool, null);
        if (r !== true) throw new Error("[vpn-pool-overlap] " + r);
      }
    }

    // Defensive cross-field check — covers the case where the user passed
    // --edge-mode and --tls-source separately and parseArgs already cleared
    // them, plus the case where one was prompted and one came from --flag.
    assertSupportedCombo(ctx.edgeMode, ctx.tlsSource);

    // Per-stamp secrets — required ones loop until non-empty (or preserved
    // from existing); optional ones default to empty / preserved value.
    const secrets = { ...(existingSecrets ?? {}) };
    console.log("");
    console.log("Per-stamp secrets — press Enter to keep existing or skip optional keys:");
    for (const { env: key, required } of SEEDABLE_SECRET_KEYS) {
      const existing = secrets[key] ?? "";
      const masked = existing ? `<keep existing, ${existing.length} chars>` : "";
      const tag = required ? "required" : "optional";
      while (true) {
        const answer = (await prompt(rl, `  ${key} (${tag})`, masked)).trim();
        if (!answer || answer === masked) {
          // Empty input or user accepted the masked default.
          if (existing) {
            secrets[key] = existing;
            break;
          }
          if (!required) break; // skip optional with no existing value
          console.error(`    ${key} is required.`);
          continue;
        }
        secrets[key] = answer;
        break;
      }
    }

    // Portal config (non-credentials). Same prompt UX as secrets but every
    // key is optional — blank input renders the sentinel and the portal
    // strips it at startup. Existing values are masked-default-preserved.
    const portalConfig = { ...(existingPortalConfig ?? {}) };
    console.log("");
    console.log("Portal config (non-credentials) — press Enter to keep existing or leave unset:");
    for (const { env: key } of PORTAL_CONFIG_KEYS) {
      const existing = portalConfig[key] ?? "";
      const masked = existing ? `<keep existing: ${existing}>` : "";
      const answer = (await prompt(rl, `  ${key}`, masked)).trim();
      if (!answer || answer === masked) {
        if (existing) portalConfig[key] = existing;
        continue;
      }
      portalConfig[key] = answer;
    }

    return { ...ctx, secrets, portalConfig };
  } finally {
    rl.close();
  }
}

// Preferred Foundry deployments to scaffold when the operator says 'y' to
// `--foundry-enabled`. The scaffolder queries the live Azure model catalog
// for the target region and emits an entry for each preferred model that is
// actually offered there, using the latest available version. This avoids
// hard-coding stale `format/name/version` triples that drift every few
// months.
//
// `capacity` is in 1K-tokens-per-minute units (50 = 50K TPM) and is just a
// reasonable starting point — the operator is expected to tune per quota.
const PREFERRED_FOUNDRY_DEPLOYMENTS = [
  { format: "OpenAI", name: "gpt-5-mini", capacity: 50 },
  { format: "OpenAI", name: "gpt-5", capacity: 100 },
  { format: "OpenAI", name: "gpt-5-nano", capacity: 250 },
];

// Pick the latest offered version of `(format, name)` from the catalog
// returned by `az cognitiveservices model list`. Versions are date-shaped
// strings (YYYY-MM-DD), so a lexical sort is the same as a chronological
// sort. Returns null if the model is not offered in the catalog.
function pickLatestVersion(availableModels, format, name) {
  const versions = availableModels
    .map((m) => m && m.model)
    .filter((m) => m && m.format === format && m.name === name)
    .map((m) => m.version)
    .filter(Boolean)
    .sort();
  return versions.length ? versions[versions.length - 1] : null;
}

// Build foundry-deployments.json contents from the live catalog.
//
// `availableModels` is the parsed array from `az cognitiveservices model
// list -o json`. When it is null (lookup failed — operator not logged in,
// no network, etc.) the scaffolder emits an empty array so base-infra still
// deploys (Foundry just provisions zero deployments) and the operator can
// fill it in by hand.
//
// Pure function: the live `az` call is done by the caller.
export function scaffoldFoundryDeploymentsJson({ availableModels = null } = {}) {
  if (!Array.isArray(availableModels)) {
    return JSON.stringify([], null, 2) + "\n";
  }
  const entries = [];
  for (const pref of PREFERRED_FOUNDRY_DEPLOYMENTS) {
    const version = pickLatestVersion(availableModels, pref.format, pref.name);
    if (!version) continue;
    entries.push({
      name: pref.name,
      model: { format: pref.format, name: pref.name, version },
      sku: { name: "GlobalStandard", capacity: pref.capacity },
    });
  }
  return JSON.stringify(entries, null, 2) + "\n";
}

// Wrapper around `listAvailableFoundryModels` that swallows az failures and
// returns null. The scaffolder must not hard-fail just because the operator
// hasn't `az login`-ed yet; an empty Foundry array still produces a valid
// deploy config.
function tryFetchFoundryCatalog(region) {
  try {
    const models = listAvailableFoundryModels(region);
    return Array.isArray(models) ? models : null;
  } catch (err) {
    log("warn", `Could not query Foundry model catalog for ${region}: ${err.message}`);
    log("warn", `Scaffolding an empty foundry-deployments.json — edit it before running base-infra deploy.`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  if (args.name) validateLocalEnvName(args.name);

  // If we're regenerating an existing local env (--force), preserve any
  // secret values the user already entered so they don't have to re-paste
  // tokens. Anything that isn't a SEEDABLE_SECRET_KEYS env var is
  // recomputed fresh from the new inputs.
  let existingSecrets = null;
  let existingPortalConfig = null;
  if (args.name) {
    const existing = envFilePath(args.name);
    if (existsSync(existing)) {
      const parsed = parseEnvFile(existing);
      existingSecrets = {};
      for (const { env: key } of SEEDABLE_SECRET_KEYS) {
        if (parsed[key]) existingSecrets[key] = parsed[key];
      }
      existingPortalConfig = {};
      for (const { env: key } of PORTAL_CONFIG_KEYS) {
        const v = parsed[key];
        // Skip the unset sentinel — treat as "no existing value" so the
        // user sees an empty default rather than `<keep existing: __PS_UNSET__>`.
        if (v && v !== SEED_SECRETS_UNSET_SENTINEL) existingPortalConfig[key] = v;
      }
    }
  }

  const inputs = await gatherInputs(args, existingSecrets, existingPortalConfig);
  validateLocalEnvName(inputs.name);

  if (!inputs.location) throw new Error("location is required.");
  if (!inputs.regionShort) throw new Error("region-short is required.");
  // Final combo gate — covers the non-interactive path where one of
  // edge-mode / tls-source was defaulted rather than provided.
  assertSupportedCombo(inputs.edgeMode, inputs.tlsSource);
  // VPN combo gate — refuse with a named error before any .env is
  // written when --vpn-enabled y is paired with an incompatible
  // edge/tls combo (Phase 3). Mirrors validateVpnGatewayCombo's error
  // style so the scaffolder and deploy.mjs speak the same language.
  if (normaliseYesNo(inputs.vpnEnabled) === "y") {
    assertVpnGatewayCombo(inputs.edgeMode, inputs.tlsSource);
    // Pool-overlap gate — declarative `validate` hook only runs in the
    // interactive path, so we re-check here so flags-only invocations
    // (tests, CI, scripted runs) hit the same hard refusal.
    const pool = inputs.vpnClientAddressPool || "172.16.200.0/24";
    const poolResult = validateVpnClientAddressPool(pool, null);
    if (poolResult !== true) {
      throw new Error("[vpn-pool-overlap] " + poolResult);
    }
  }

  const targets = deriveTargets(inputs);

  // Contract-driven scaffold-time validation (warn-and-continue). The
  // .env is meant to be hand-edited after scaffold, so we warn here
  // rather than throw — deploy.mjs validateRequiredEnv is the authoritative
  // hard gate. See deploy/scripts/lib/overlay-contracts.mjs for the
  // per-overlay roster of required keys. We also apply stubKeys so the
  // scaffolded .env carries valid `unused` sentinels for off-path keys,
  // matching what deploy.mjs would seed.
  applyStubKeys({ edgeMode: targets.EDGE_MODE, tlsSource: targets.TLS_SOURCE, env: targets });
  const { missing: missingRequired, combo: comboErrors } = validateRequiredEnv({
    edgeMode: targets.EDGE_MODE,
    tlsSource: targets.TLS_SOURCE,
    env: targets,
  });
  if (missingRequired.length > 0) {
    log(
      "warn",
      `Overlay '${targets.EDGE_MODE}-${targets.TLS_SOURCE}' has empty required keys: ${missingRequired.join(", ")}. ` +
        `Hand-edit deploy/envs/local/${inputs.name}/.env to fill them in before running deploy. ` +
        `See deploy/scripts/lib/overlay-contracts.mjs for the per-overlay roster.`,
    );
  }
  for (const e of comboErrors) {
    log("warn", `[${e.code}] ${e.message} ${e.hint}`);
  }

  const dst = envFilePath(inputs.name);
  if (existsSync(dst) && !args.force) {
    console.error(`Refusing to overwrite ${dst} (pass --force to overwrite).`);
    process.exit(1);
  }

  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(
    dst,
    renderLocalEnv({ name: inputs.name, targets, secrets: inputs.secrets, portalConfig: inputs.portalConfig }),
    "utf8",
  );

  log("ok", `Created local env '${inputs.name}' at ${dst}`);

  // Scaffold the per-stamp Foundry deployments file when enabled. This is
  // a starter set with one safe deployment; operator edits it before
  // running `npm run deploy -- base-infra <env>`. The file is gitignored
  // (whole `deploy/envs/local/` tree is excluded) so per-stamp tweaks
  // never leak.
  if (targets.FOUNDRY_ENABLED === "true") {
    const foundryFile = resolve(dirname(dst), "foundry-deployments.json");
    if (existsSync(foundryFile) && !args.force) {
      log("info", `Foundry deployments file already exists; leaving it alone: ${foundryFile}`);
    } else {
      log("info", `Querying Foundry model catalog for ${targets.LOCATION}...`);
      const availableModels = tryFetchFoundryCatalog(targets.LOCATION);
      const body = scaffoldFoundryDeploymentsJson({ availableModels });
      writeFileSync(foundryFile, body, "utf8");
      const parsed = JSON.parse(body);
      if (parsed.length === 0) {
        log("warn", `Scaffolded empty foundry-deployments.json at ${foundryFile}`);
        log("warn", `Add deployment entries before running 'npm run deploy -- base-infra ${inputs.name}'.`);
      } else {
        log("ok", `Scaffolded foundry-deployments.json at ${foundryFile} with ${parsed.length} deployment(s):`);
        for (const e of parsed) {
          console.log(`    - ${e.name} (${e.model.format}/${e.model.name}@${e.model.version}, capacity=${e.sku.capacity})`);
        }
        console.log(`  Tune capacities / add more models by editing the file directly.`);
        console.log(`  See \`az cognitiveservices model list --location ${targets.LOCATION}\` for the full catalog.`);
      }
    }
  }

  console.log("");
  console.log(`Generated deployment targets (enterprise naming pattern):`);
  for (const [k, v] of Object.entries(targets)) console.log(`  ${k}=${v}`);
  console.log("");
  console.log(`Next steps:`);
  let stepNum = 1;
  if (!targets.SUBSCRIPTION_ID) console.log(`  ${stepNum++}. Set SUBSCRIPTION_ID in ${dst}`);
  const subForCmd = targets.SUBSCRIPTION_ID || "<id>";
  console.log(`  ${stepNum++}. az login && az account set --subscription ${subForCmd}`);
  console.log(`  ${stepNum}. npm run deploy -- all ${inputs.name}`);

  // Post-scaffold VPN reminder block (Phase 3). Surfaces the
  // out-of-band requirements deploy.mjs cannot enforce: tenant Conditional
  // Access policy, audience override, cost / first-deploy-time disclosure,
  // and a docs pointer. Skipped silently when VPN is disabled — keeps the
  // VPN=no path's stdout unchanged so existing tests (and operators in
  // private mode) see no surprises.
  if (targets.VPN_GATEWAY_ENABLED === "true") {
    console.log("");
    console.log("─── VPN Gateway P2S — required out-of-band setup ─────────────────────");
    console.log("⚠  Conditional Access policy (tenant admin, REQUIRED before first connect):");
    console.log("     • Target app:           c632b3df-fb67-4d84-bdcf-b95ad541b5c8 (Azure VPN Client, Microsoft-registered)");
    console.log("     • Assignment:           a NAMED users group — do NOT target 'all users'");
    console.log("     • Grant:                require MFA");
    console.log("     • Grant:                do NOT require device compliance");
    console.log("     • Legacy override:      set VPN_AAD_AUDIENCE=41b23e61-6c1e-4545-b367-cd054e0ed4b4");
    console.log("                             in .env for tenants on older Azure VPN client builds");
    console.log("                             (audience override is documented in template.env).");
    console.log("");
    console.log("💰  Cost:                    ~$140/month (VpnGw1 SKU + Public IP + gateway hours)");
    console.log("⏱  First-deploy time:        45+ minutes (VPN gateway provisioning is the long pole)");
    console.log("");
    console.log("⬇  VPN client profile (after first deploy completes):");
    console.log(`     • Azure portal:        Resource group → ${targets.RESOURCE_GROUP}`);
    console.log("                             → <vpn-gateway-name> → Point-to-site configuration");
    console.log("                             → Download VPN client");
    console.log(`     • Or via az CLI:       az network vnet-gateway vpn-client generate-url \\`);
    console.log(`                               --resource-group ${targets.RESOURCE_GROUP} \\`);
    console.log("                               --name <vpn-gateway-name>");
    console.log("                             Then import the .zip into the Azure VPN Client app.");
    console.log("");
    console.log("📖  Full guidance:           docs/deploying-to-aks.md → 'Optional: VPN Gateway P2S' section");
    console.log("                             (also: pilotswarm-new-env-deploy skill VPN matrix entry).");
    console.log("──────────────────────────────────────────────────────────────────────");
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
