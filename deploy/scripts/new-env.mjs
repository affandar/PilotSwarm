// new-env.mjs — scaffolder for personal/local env files.
//
// Usage:
//   npm run deploy:new-env                                       (interactive)
//   npm run deploy:new-env -- <name>                             (interactive, name pre-filled)
//   npm run deploy:new-env -- <name> --subscription <id> --location <loc>
//
// (Equivalent direct invocation: `node deploy/scripts/new-env.mjs ...`)
//
// Creates `deploy/envs/local/<name>/env` by copying `deploy/envs/template.env`
// and substituting deployment-target keys using the same naming patterns
// EV2 uses (deploy/services/<svc>/Ev2*Deployment/serviceModel.json):
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
import { SEEDABLE_SECRET_KEYS } from "./lib/seed-secrets.mjs";

// Common Azure regions → short name. Sourced from
// deploy/services/deploy-manifest.json `regionShort`. Unknown regions prompt
// the user for a short name.
function regionShortFor(location) {
  const m = loadDeployManifest();
  return m.regionShort[location.toLowerCase()] ?? null;
}

const EDGE_MODES = ["afd", "private"];
const DEFAULT_EDGE_MODE = "afd";

// CA cert source.
//   letsencrypt    — cert-manager + LE prod ACME (HTTP-01). Only valid with
//                    edgeMode=afd. OSS public default.
//   akv            — AKV-registered issuer (e.g. OneCertV2-PublicCA for afd,
//                    OneCertV2-PrivateCA for private) + bicep cert deployment
//                    script. EV2 / enterprise / AME path.
//   akv-selfsigned — AKV `Self` issuer; bicep auto-creates a self-signed cert
//                    in AKV with SAN=${HOST}.${PRIVATE_DNS_ZONE}. Only valid
//                    with edgeMode=private. OSS private demo path; zero
//                    external dependencies.
const TLS_SOURCES = ["letsencrypt", "akv", "akv-selfsigned"];
const DEFAULT_TLS_SOURCE = "letsencrypt";

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
          ? "AKV-registered OneCertV2-PublicCA issuer + bicep cert deploy (EV2 / enterprise public)"
          : "AKV-registered OneCertV2-PrivateCA issuer + bicep cert deploy (AME / enterprise private)",
      "akv-selfsigned": "AKV `Self` issuer; bicep auto-creates a self-signed cert (OSS private demo)",
    }),
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
    transform: (v) => {
      const s = String(v ?? "").toLowerCase();
      if (s === "y" || s === "yes" || s === "true") return "y";
      if (s === "n" || s === "no" || s === "false" || s === "") return "n";
      return s;
    },
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
    "Creates a personal local env at deploy/envs/local/<name>/env.",
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

// Derive deployment-target values from a small set of inputs, matching EV2
// serviceModel.json naming patterns. Pure function — no I/O.
export function deriveTargets({ name, subscription, location, regionShort, edgeMode, host, privateDnsZone, portalHostname, tlsSource, acmeEmail, foundryEnabled }) {
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
  const foundryOn = foundryEnabled === "y" || foundryEnabled === true;
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

export function renderLocalEnv({ name, targets, secrets, templateText }) {
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

  return header + substituted.replace(/\s*$/, "") + "\n" + secretsBlock.join("\n");
}

async function gatherInputs(args, existingSecrets) {
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
    return { ...ctx, secrets: { ...(existingSecrets ?? {}) } };
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
        continue;
      }
      // Custom imperative override wins; otherwise drive the declarative runner.
      ctx[i.argKey] = i.interactive
        ? await i.interactive(rl, ctx)
        : await runDeclarativePrompt(rl, ctx, i);
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

    return { ...ctx, secrets };
  } finally {
    rl.close();
  }
}

// Starter content for deploy/envs/local/<env>/foundry-deployments.json.
// Must be VALID JSON — `az deployment group create --parameters
// foundryDeployments=@<file>` parses it. Bicep tolerates extra fields
// like `_comment` on each entry.
//
// One known-stable deployment as a starting point. Operator edits this
// file before running `npm run deploy -- base-infra <env>`. Foundry's
// available model `format/name/version` triples change frequently;
// `az cognitiveservices model list --location <region>` lists what is
// currently offered in a given region. The scaffolder also prints a
// block of common deployment shapes to stdout for convenience.
export function scaffoldFoundryDeploymentsJson() {
  const obj = [
    {
      _comment: "Starter Foundry deployment. Edit name/model/version/capacity to match your subscription's region+quota. Capacity is in 1K-tokens-per-minute units (50 = 50K TPM). Run `az cognitiveservices model list --location <region>` to see what's offered.",
      name: "gpt-5-mini",
      model: { format: "OpenAI", name: "gpt-5-mini", version: "2025-08-07" },
      sku: { name: "GlobalStandard", capacity: 50 },
    },
  ];
  return JSON.stringify(obj, null, 2) + "\n";
}

// Common deployment shapes printed to stdout when the scaffolder writes
// foundry-deployments.json. Operator copy-pastes the entries they want
// into the JSON file.
const FOUNDRY_DEPLOYMENT_EXAMPLES = `
Common deployment entries (copy into foundry-deployments.json as needed):

  { "name": "gpt-5",
    "model": { "format": "OpenAI", "name": "gpt-5", "version": "2025-08-07" },
    "sku":   { "name": "GlobalStandard", "capacity": 100 } }

  { "name": "gpt-5-nano",
    "model": { "format": "OpenAI", "name": "gpt-5-nano", "version": "2025-08-07" },
    "sku":   { "name": "GlobalStandard", "capacity": 250 } }

  { "name": "model-router",
    "model": { "format": "OpenAI", "name": "model-router", "version": "2025-05-19" },
    "sku":   { "name": "GlobalStandard", "capacity": 100 } }

Note: model versions vary by region. If the deploy fails with
"DeploymentModelNotSupported", run
  az cognitiveservices model list --location <region>
to see what's currently offered.
`;

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
  if (args.name) {
    const existing = envFilePath(args.name);
    if (existsSync(existing)) {
      const parsed = parseEnvFile(existing);
      existingSecrets = {};
      for (const { env: key } of SEEDABLE_SECRET_KEYS) {
        if (parsed[key]) existingSecrets[key] = parsed[key];
      }
    }
  }

  const inputs = await gatherInputs(args, existingSecrets);
  validateLocalEnvName(inputs.name);

  if (!inputs.location) throw new Error("location is required.");
  if (!inputs.regionShort) throw new Error("region-short is required.");
  // Final combo gate — covers the non-interactive path where one of
  // edge-mode / tls-source was defaulted rather than provided.
  assertSupportedCombo(inputs.edgeMode, inputs.tlsSource);

  const targets = deriveTargets(inputs);

  const dst = envFilePath(inputs.name);
  if (existsSync(dst) && !args.force) {
    console.error(`Refusing to overwrite ${dst} (pass --force to overwrite).`);
    process.exit(1);
  }

  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(
    dst,
    renderLocalEnv({ name: inputs.name, targets, secrets: inputs.secrets }),
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
      writeFileSync(foundryFile, scaffoldFoundryDeploymentsJson(), "utf8");
      log("ok", `Scaffolded Foundry deployments file at ${foundryFile}`);
      console.log(FOUNDRY_DEPLOYMENT_EXAMPLES);
    }
  }

  console.log("");
  console.log(`Generated deployment targets (EV2 naming pattern):`);
  for (const [k, v] of Object.entries(targets)) console.log(`  ${k}=${v}`);
  console.log("");
  console.log(`Next steps:`);
  let stepNum = 1;
  if (!targets.SUBSCRIPTION_ID) console.log(`  ${stepNum++}. Set SUBSCRIPTION_ID in ${dst}`);
  const subForCmd = targets.SUBSCRIPTION_ID || "<id>";
  console.log(`  ${stepNum++}. az login && az account set --subscription ${subForCmd}`);
  console.log(`  ${stepNum}. npm run deploy -- all ${inputs.name}`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
