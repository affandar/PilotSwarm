#!/usr/bin/env node

/**
 * pilotswarm — CLI for the pilotswarm.
 *
 * Modes:
 *   local   Embedded workers + TUI in one process (default)
 *   remote  Client-only TUI, workers run elsewhere (AKS, separate process)
 *
 * Usage:
 *   npx pilotswarm local --plugin ./plugin
 *   npx pilotswarm remote --store postgresql://... --context toygres-aks
 *   npx pilotswarm --env .env --plugin ./my-plugin --workers 4
 *
 * All flags can also be set via environment variables (CLI flags take precedence).
 */

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const defaultTuiSplashPath = path.join(pkgRoot, "cli", "tui-splash.txt");

function readPluginMetadata(pluginDir) {
    if (!pluginDir) return null;
    const pluginJsonPath = path.join(pluginDir, "plugin.json");
    if (!fs.existsSync(pluginJsonPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"));
    } catch (err) {
        console.error(`Failed to parse plugin metadata: ${pluginJsonPath}: ${err.message}`);
        process.exit(1);
    }
}

// ─── Parse CLI args ──────────────────────────────────────────────

const { values: flags, positionals } = parseArgs({
    options: {
        // Connection
        store:     { type: "string", short: "s" },
        env:       { type: "string", short: "e" },

        // Local mode
        plugin:    { type: "string", short: "p" },
        worker:    { type: "string", short: "w" },
        workers:   { type: "string", short: "n" },
        model:     { type: "string", short: "m" },
        system:    { type: "string" },

        // Remote mode
        context:   { type: "string", short: "c" },
        namespace: { type: "string" },
        label:     { type: "string" },

        // General
        "log-level": { type: "string" },
        help:      { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
});

if (flags.help) {
    console.log(`
pilotswarm — TUI for pilotswarm apps

USAGE
  npx pilotswarm [local|remote] [flags]

MODES
  local       Embed workers in the TUI process (default)
  remote      Client-only — connect to remote workers via kubectl logs

FLAGS                                    ENV VAR EQUIVALENT
  -s, --store <url>        Database URL  DATABASE_URL
  -e, --env <file>         Env file      (default: .env / .env.remote)

  -p, --plugin <dir>       Plugin dir    PLUGIN_DIRS
  -w, --worker <module>    Tool module   WORKER_MODULE
  -n, --workers <count>    Worker count  WORKERS (default: 4)
  -m, --model <name>       LLM model     COPILOT_MODEL
      --system <msg|file>  System msg    SYSTEM_MESSAGE (or plugin/system.md)

  -c, --context <ctx>      K8s context   K8S_CONTEXT
      --namespace <ns>     K8s namespace K8S_NAMESPACE (default: copilot-runtime)
      --label <selector>   Pod label     K8S_POD_LABEL
      --log-level <level>  Trace level   LOG_LEVEL
  -h, --help               Show help

All flags can be set via the corresponding env var (in .env or exported).
CLI flags take precedence over env vars.

EXAMPLES
  # Plugin-only (no code), env from file
  npx pilotswarm --env .env --plugin ./my-plugin

  # Custom tools via worker module
  npx pilotswarm --env .env --plugin ./plugin --worker ./tools.js

  # All config in .env (zero flags)
  echo "DATABASE_URL=postgresql://..." >> .env
  echo "GITHUB_TOKEN=ghu_..." >> .env
  echo "PLUGIN_DIRS=./plugin" >> .env
  npx pilotswarm

  # Client-only, workers on AKS
  npx pilotswarm remote --store postgresql://... --namespace my-app
`.trim());
    process.exit(0);
}

// ─── Determine mode ─────────────────────────────────────────────

const mode = positionals[0] === "remote" ? "remote" : "local";

// ─── Load env file ───────────────────────────────────────────────

const envFile = flags.env
    || (mode === "remote" ? ".env.remote" : ".env");
if (fs.existsSync(envFile)) {
    // Parse env file manually (KEY=VALUE lines)
    const envContent = fs.readFileSync(envFile, "utf-8");
    for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        // CLI flags take precedence, env file fills in gaps
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

// ─── Resolve system message ──────────────────────────────────────

const DEFAULT_SYSTEM_MESSAGE = `You are a helpful assistant running in a durable execution environment. Be concise.

CRITICAL RULES:
1. You have 'wait', 'wait_on_worker', and 'cron' tools. Use 'cron' for recurring or periodic schedules, and use 'wait'/'wait_on_worker' for one-shot delays.
2. NEVER say you cannot wait or set timers. You CAN — use the 'wait' tool.
3. NEVER use bash sleep, setTimeout, setInterval, cron, or any other timing mechanism.
4. The 'wait' and 'cron' tools enable durable timers that survive process restarts and node migrations.
5. For recurring tasks, call cron(seconds=<N>, reason="...") once. The orchestration handles future wake-ups automatically.
6. Use wait(seconds=<N>) only for one-shot delays within a turn.
7. Use cron(action="cancel") to stop a recurring schedule.
8. If facts tools are available, use them for durable memory, checkpoints, and resumable task state when helpful.`;

function resolveSystemMessage() {
    // 1. CLI flag (string or file path)
    if (flags.system) {
        if (fs.existsSync(flags.system)) {
            return fs.readFileSync(flags.system, "utf-8").trim();
        }
        return flags.system;
    }

    // 2. plugin/system.md (convention)
    const pluginDir = resolvePluginDir();
    if (pluginDir) {
        const systemMd = path.join(pluginDir, "system.md");
        if (fs.existsSync(systemMd)) {
            return fs.readFileSync(systemMd, "utf-8").trim();
        }
    }

    // 3. SYSTEM_MESSAGE env var
    if (process.env.SYSTEM_MESSAGE) {
        return process.env.SYSTEM_MESSAGE;
    }

    // 4. Default
    return DEFAULT_SYSTEM_MESSAGE;
}

function resolvePluginDir() {
    if (flags.plugin) return path.resolve(flags.plugin);
    if (process.env.PLUGIN_DIRS) {
        const dirs = process.env.PLUGIN_DIRS.split(",").map(d => d.trim()).filter(Boolean);
        return dirs[0] || null;
    }
    // Auto-detect: ./plugins in cwd, then bundled plugins in CLI package
    const cwdPlugin = path.resolve("plugins");
    if (fs.existsSync(cwdPlugin)) return cwdPlugin;
    const bundledPlugin = path.join(pkgRoot, "plugins");
    if (fs.existsSync(bundledPlugin)) return bundledPlugin;
    return null;
}

function resolveTuiBranding(pluginDir) {
    const pluginMeta = readPluginMetadata(pluginDir);
    const tui = pluginMeta?.tui;
    let defaultSplash = "";
    if (fs.existsSync(defaultTuiSplashPath)) {
        defaultSplash = fs.readFileSync(defaultTuiSplashPath, "utf-8").trimEnd();
    }
    if (!tui || typeof tui !== "object") {
        return {
            title: "PilotSwarm",
            splash: defaultSplash,
        };
    }

    const title = typeof tui.title === "string" && tui.title.trim()
        ? tui.title.trim()
        : "PilotSwarm";

    let splash = defaultSplash;
    if (typeof tui.splash === "string" && tui.splash.trim()) {
        splash = tui.splash;
    } else if (typeof tui.splashFile === "string" && tui.splashFile.trim()) {
        const splashPath = path.resolve(pluginDir, tui.splashFile);
        if (!fs.existsSync(splashPath)) {
            console.error(`TUI splash file not found: ${splashPath}`);
            process.exit(1);
        }
        splash = fs.readFileSync(splashPath, "utf-8").trimEnd();
    }

    return { title, splash };
}

// ─── Build TUI config and set env vars ───────────────────────────

// Store
const store = flags.store || process.env.DATABASE_URL || "sqlite::memory:";
process.env.DATABASE_URL = store;

// Workers
if (mode === "remote") {
    process.env.WORKERS = "0";
} else {
    process.env.WORKERS = flags.workers ?? process.env.WORKERS ?? "4";
}

// Plugin dirs
const pluginDir = resolvePluginDir();
if (pluginDir) {
    process.env.PLUGIN_DIRS = pluginDir;
}
const tuiBranding = resolveTuiBranding(pluginDir);

// Model
process.env.COPILOT_MODEL = flags.model || process.env.COPILOT_MODEL || "";

// Log level
process.env.LOG_LEVEL = flags["log-level"] || process.env.LOG_LEVEL || "";

// Context, namespace and label for remote mode (kubectl log streaming)
process.env.K8S_CONTEXT = flags.context || process.env.K8S_CONTEXT || "";
process.env.K8S_NAMESPACE = flags.namespace || process.env.K8S_NAMESPACE || "copilot-runtime";
process.env.K8S_POD_LABEL = flags.label || process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker";

// System message
process.env._TUI_SYSTEM_MESSAGE = resolveSystemMessage();
process.env._TUI_TITLE = tuiBranding.title;
process.env._TUI_SPLASH = tuiBranding.splash;

// ─── Load custom worker module (local mode only) ─────────────────

const workerModulePath = flags.worker || process.env.WORKER_MODULE || "";
if (mode === "local" && workerModulePath) {
    const resolved = path.resolve(workerModulePath);
    if (!fs.existsSync(resolved)) {
        console.error(`Worker module not found: ${resolved}`);
        process.exit(1);
    }
    process.env._TUI_WORKER_MODULE = resolved;
}

// ─── Launch TUI ──────────────────────────────────────────────────

// The TUI is the same file, but now reads config from env vars set above
// instead of relying on the user to set them manually.
const tuiPath = path.join(pkgRoot, "cli", "tui.js");
await import(tuiPath);
