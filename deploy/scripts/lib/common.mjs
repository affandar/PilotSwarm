// Shared helpers for the OSS Node deploy orchestrator (Phase 1).
//
// Stdlib-only. No `shell: true`. Cross-platform (Windows / macOS / Linux).
// See deploy/scripts/README.md for context. Spec: .paw/work/oss-deploy-script/Spec.md.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

// Repo root: this file lives at <repo>/deploy/scripts/lib/common.mjs
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");

// ───────────────────────── Logging ─────────────────────────

const LEVEL_PREFIX = { info: "ℹ", warn: "⚠", err: "❌", ok: "✅", step: "▶" };

export function log(level, msg) {
  const ts = new Date().toISOString();
  const tag = LEVEL_PREFIX[level] ?? "·";
  const stream = level === "err" ? process.stderr : process.stdout;
  stream.write(`[${ts}] ${tag} ${msg}\n`);
}

// ───────────────────────── Env file loading (FR-004) ─────────────────────────

// Parse a flat KEY=VALUE env file. Comments (# ...) and blank lines pass through.
// Values may be optionally double-quoted; quotes are stripped. No interpolation.
export function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  const raw = readFileSync(path, "utf8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ───────────────────────── Env name policy ─────────────────────────
//
// Every deploy targets a personal/local env at
// `deploy/envs/local/<name>/env`. Local env files are STANDALONE: they
// are seeded from `deploy/envs/template.env` at scaffold time
// (deploy/scripts/new-env.mjs) and from that point on are a complete,
// frozen record of the deployment target. There is NO runtime cascade
// onto the template, so future template edits affect only newly-
// scaffolded envs — never existing ones.
//
// `dev` and `prod` are reserved labels (used by the enterprise path for
// ServiceGroup naming via `$config(environment)`); they are NOT valid
// OSS env names.
//
// The 12-char cap on local env names keeps the derived RESOURCE_PREFIX
// (`ps<name>`) short enough to fit the strictest Azure name (storage
// account: 24 alphanum, pattern `${alphaPrefix}sa${unique6}` ⇒ 22 chars
// at envname=12).
export const RESERVED_ENV_NAMES = ["dev", "prod"];
export const LOCAL_ENV_NAME_RE = /^[a-z][a-z0-9]{0,11}$/;

export function validateLocalEnvName(name) {
  if (RESERVED_ENV_NAMES.includes(name)) {
    throw new Error(
      `'${name}' is a reserved env name. Pick a different name (1–12 chars, ` +
        `lowercase, must start with a letter).`,
    );
  }
  if (!LOCAL_ENV_NAME_RE.test(name)) {
    throw new Error(
      `Invalid env name: '${name}'.\n` +
        `Must match /^[a-z][a-z0-9]{0,11}$/ — start with a letter, 1–12 lowercase ` +
        `alphanumeric characters, no separators.`,
    );
  }
}

// Resolve the env file path for an env name. Always
// `deploy/envs/local/<name>/env` — there are no canonical OSS env files
// to deploy from anymore. The template at `deploy/envs/template.env` is
// only consumed by the scaffolder (new-env.mjs).
export function envFilePath(envName) {
  validateLocalEnvName(envName);
  return join(REPO_ROOT, "deploy", "envs", "local", envName, "env");
}

// Path to the scaffolder template. Read by new-env.mjs at scaffold time.
export function templateEnvPath() {
  return join(REPO_ROOT, "deploy", "envs", "template.env");
}

// Load env map for a given local env name. Reads
// `deploy/envs/local/<name>/env` standalone — no cascade onto the
// template (that file is only used at scaffold time).
//
// process.env values override file values key-by-key (so a contributor can
// `SUBSCRIPTION_ID=... node deploy.mjs ...` for ad-hoc tests). We do NOT
// merge the entire process environment.
export function loadEnv(envName) {
  const envFile = envFilePath(envName);

  if (!existsSync(envFile)) {
    throw new Error(
      `Local env '${envName}' not found at ${envFile}.\n` +
        `Create it with: npm run deploy:new-env -- ${envName}`,
    );
  }

  const merged = parseEnvFile(envFile);

  // process.env override for keys already in the merged map.
  for (const k of Object.keys(merged)) {
    if (process.env[k] !== undefined && process.env[k] !== "") {
      merged[k] = process.env[k];
    }
  }

  return {
    env: merged,
    sources: { base: null, local: envFile },
  };
}

// ───────────────────────── Subprocess wrapper (FR-011) ─────────────────────────

// Resolve a CLI to an absolute path-or-name suitable for spawnSync without `shell: true`.
// On Windows, `az` ships as `az.cmd`; `kubectl` and `oras` as `<name>.exe`. We probe PATH
// for the bare name first, then `<name>.cmd`, then `<name>.exe`. Returns the first hit
// or the bare name (letting spawnSync surface ENOENT if truly missing).
const WINDOWS = platform() === "win32";

function whichOnPath(name) {
  const pathVar = process.env.PATH || process.env.Path || "";
  const sep = WINDOWS ? ";" : ":";
  // Windows: prefer executable extensions before the extensionless name (which
  // is often a script wrapper not runnable from non-shell launchers).
  const candidates = WINDOWS
    ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name]
    : [name];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const c of candidates) {
      const full = join(dir, c);
      // Must exist AND be a file, not a directory. Visual Studio ships a
      // directory literally named `git` (no extension) on PATH at
      // `…\Team Explorer\git`, which would otherwise shadow the real git.exe.
      if (!existsSync(full)) continue;
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      return full;
    }
  }
  return null;
}

const cliCache = new Map();
export function resolveCli(name) {
  if (cliCache.has(name)) return cliCache.get(name);
  const found = whichOnPath(name) ?? name;
  cliCache.set(name, found);
  return found;
}

// run(name, args, opts) — synchronous, no shell, inherits stdio by default.
// Returns { status, stdout, stderr } when capture=true; otherwise throws on non-zero exit.
//
// Windows .cmd / .bat note: per Node CVE-2024-27980, batch files cannot be
// spawned directly with `shell: false`. We invoke them via `cmd.exe /d /s /c
// "<full-path>" args...` with `windowsVerbatimArguments: true`. cmd.exe is a
// real Win32 binary; with /s mode it strips the outer quote pair and passes
// the contents as the command line. We hand-quote each token so paths with
// spaces work. This satisfies FR-011's intent — no shell-string-interpolation
// of caller-controlled data; we control the quoting deterministically.
function quoteForCmd(s) {
  // Wrap if contains whitespace, double-quote, or other cmd-special chars.
  if (/[\s"&|<>^()%!]/.test(s)) {
    // cmd.exe escaping: " inside quoted -> \"
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

export function run(name, args, opts = {}) {
  const { capture = false, cwd, env, allowFail = false } = opts;
  const cli = resolveCli(name);
  const isBatch = WINDOWS && /\.(cmd|bat)$/i.test(cli);

  let spawnCmd, spawnArgs, spawnOpts;
  if (isBatch) {
    // cmd.exe /s mode: if the /c arg starts AND ends with `"`, those outer
    // quotes are stripped and the rest passed verbatim as the command line.
    // We must therefore wrap the inner command in an extra pair of quotes.
    const inner = [cli, ...args].map(quoteForCmd).join(" ");
    const line = `"${inner}"`;
    spawnCmd = "cmd.exe";
    spawnArgs = ["/d", "/s", "/c", line];
    spawnOpts = { windowsVerbatimArguments: true };
  } else {
    spawnCmd = cli;
    spawnArgs = args;
    spawnOpts = {};
  }

  const result = spawnSync(spawnCmd, spawnArgs, {
    shell: false,
    cwd: cwd ?? REPO_ROOT,
    env: env ?? process.env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...spawnOpts,
  });
  if (result.error) {
    throw new Error(`Failed to spawn ${name}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFail) {
    const msg = capture
      ? `${name} ${args.join(" ")} exited ${result.status}\n${result.stderr ?? ""}`
      : `${name} ${args.join(" ")} exited ${result.status}`;
    throw new Error(msg);
  }
  return {
    status: result.status,
    stdout: capture ? result.stdout ?? "" : "",
    stderr: capture ? result.stderr ?? "" : "",
  };
}

// ───────────────────────── Preflight (EC-1, FR-005, FR-018) ─────────────────────────

// Run a CLI capturing stdout, then parse it as JSON. Throws if exit is non-zero
// or the output isn't valid JSON.
export function runJson(name, args) {
  const { stdout } = run(name, args, { capture: true });
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `${name} ${args.join(" ")} produced non-JSON output:\n${stdout.slice(0, 400)}\n` +
        `Parse error: ${e.message}`,
    );
  }
}

// Verify a required CLI is on PATH. Throws with FR-013/EC-1-style hint if missing.
// Most CLIs respond to `--version`; pass `versionArgs` to override (e.g. oras uses `version`).
export function assertCli(name, hint, versionArgs = ["--version"]) {
  try {
    run(name, versionArgs, { capture: true });
  } catch (e) {
    throw new Error(
      `Required CLI not found or not runnable: ${name}\n` +
        `Underlying error: ${e.message.split("\n")[0]}\n` +
        `Install hint: ${hint}\n` +
        `(See deploy/scripts/README.md → Prerequisites.)`,
    );
  }
}

// Confirm `az account show` matches the expected SUBSCRIPTION_ID (FR-005).
// Aborts with a clear message if not.
export function assertSubscription(expected) {
  if (!expected) {
    throw new Error(
      "SUBSCRIPTION_ID is empty in the env map. Set it in your local env file (deploy/envs/local/<env>/env).",
    );
  }
  const r = run("az", ["account", "show", "--query", "id", "-o", "tsv"], { capture: true });
  const actual = r.stdout.trim();
  if (actual !== expected) {
    throw new Error(
      `Active az subscription does not match env file.\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual || "(none — run 'az login' first)"}\n` +
        `Switch with: az account set --subscription ${expected}`,
    );
  }
}

// ───────────────────────── Image tag (FR-017, pulled into P1) ─────────────────────────

// Resolve the image tag for an `--image-tag` argument:
//   - explicit value: returned verbatim
//   - omitted:        `<env>-<short-sha>`, with `-dirty` suffix if working tree is dirty
//
// `git rev-parse --short HEAD` and `git status --porcelain` provide the inputs.
export function resolveImageTag({ envName, explicit }) {
  if (explicit) return explicit;
  const sha = run("git", ["rev-parse", "--short", "HEAD"], { capture: true }).stdout.trim();
  if (!sha) throw new Error("Unable to resolve git short SHA for image tag (is this a git repo?).");
  const status = run("git", ["status", "--porcelain"], { capture: true }).stdout;
  const dirty = status.trim().length > 0;
  return dirty ? `${envName}-${sha}-dirty` : `${envName}-${sha}`;
}

// ───────────────────────── Staging dir (FR-019) ─────────────────────────

// Repo-local staging root. Per FR-019: deterministic, repo-local, gitignored.
//   <repo>/deploy/.tmp/<service>-<env>/
export function stagingDir(service, envName) {
  const dir = join(REPO_ROOT, "deploy", ".tmp", `${service}-${envName}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ───────────────────────── Service & env validation ─────────────────────────

// Virtual aggregate that drives the canonical end-to-end bring-up sequence
// (see service-info.mjs ALL_SEQUENCE). Validated and routed in deploy.mjs.
export const ALL_SERVICE = "all";

// Concrete service list, derived from the deploy manifest so adding a new
// service folder + entry in deploy-manifest.json is enough — no second list
// to keep in sync here. Read directly (not via service-info.mjs) to avoid a
// circular import: service-info → services-manifest → common.
let _services;
function loadServices() {
  if (_services) return _services;
  const manifestPath = join(REPO_ROOT, "deploy", "services", "deploy-manifest.json");
  const root = JSON.parse(readFileSync(manifestPath, "utf8"));
  _services = [...(root.infraOrder ?? []), ...(root.services ?? [])];
  return _services;
}

export const SERVICES = new Proxy([], {
  get(_t, prop) {
    const arr = loadServices();
    const v = arr[prop];
    return typeof v === "function" ? v.bind(arr) : v;
  },
  has(_t, prop) {
    return prop in loadServices();
  },
  ownKeys() {
    return Reflect.ownKeys(loadServices());
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Reflect.getOwnPropertyDescriptor(loadServices(), prop);
  },
});

export function validateService(s) {
  if (s === ALL_SERVICE) return;
  const services = loadServices();
  if (!services.includes(s)) {
    throw new Error(`Unknown service: ${s}\nValid: ${services.join(", ")}, or '${ALL_SERVICE}'`);
  }
}
export function validateEnv(e) {
  validateLocalEnvName(e);
}
