#!/usr/bin/env node

/**
 * durable-copilot-runtime-tui — CLI for the durable-copilot-runtime.
 *
 * Modes:
 *   local   Embedded workers + TUI in one process (default)
 *   remote  Client-only TUI, workers run elsewhere (AKS, separate process)
 *
 * Usage:
 *   npx durable-copilot-runtime-tui local --plugin ./plugin
 *   npx durable-copilot-runtime-tui remote --store postgresql://... --namespace my-ns
 *   npx durable-copilot-runtime-tui --env .env --plugin ./my-plugin --workers 4
 *
 * All flags can also be set via environment variables (CLI flags take precedence).
 */

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

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
durable-copilot-runtime-tui — TUI for durable-copilot-runtime apps

USAGE
  npx durable-copilot-runtime-tui [local|remote] [flags]

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

      --namespace <ns>     K8s namespace K8S_NAMESPACE (default: copilot-sdk)
      --label <selector>   Pod label     K8S_POD_LABEL
      --log-level <level>  Trace level   LOG_LEVEL
  -h, --help               Show help

All flags can be set via the corresponding env var (in .env or exported).
CLI flags take precedence over env vars.

EXAMPLES
  # Plugin-only (no code), env from file
  npx durable-copilot-runtime-tui --env .env --plugin ./my-plugin

  # Custom tools via worker module
  npx durable-copilot-runtime-tui --env .env --plugin ./plugin --worker ./tools.js

  # All config in .env (zero flags)
  echo "DATABASE_URL=postgresql://..." >> .env
  echo "GITHUB_TOKEN=ghu_..." >> .env
  echo "PLUGIN_DIRS=./plugin" >> .env
  npx durable-copilot-runtime-tui

  # Client-only, workers on AKS
  npx durable-copilot-runtime-tui remote --store postgresql://... --namespace my-app
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
1. You have a 'wait' tool. You MUST use it whenever you need to wait, pause, sleep, delay, poll, check back later, schedule a future action, or implement any recurring/periodic task.
2. NEVER say you cannot wait or set timers. You CAN — use the 'wait' tool.
3. NEVER use bash sleep, setTimeout, setInterval, cron, or any other timing mechanism.
4. The 'wait' tool enables durable timers that survive process restarts and node migrations.
5. For recurring tasks: use the 'wait' tool in a loop — complete the action, then call wait(seconds), then repeat.`;

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
    // Auto-detect: ./plugin in cwd, then bundled plugin in SDK
    const cwdPlugin = path.resolve("plugin");
    if (fs.existsSync(cwdPlugin)) return cwdPlugin;
    const sdkPlugin = path.join(pkgRoot, "plugin");
    if (fs.existsSync(sdkPlugin)) return sdkPlugin;
    return null;
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

// Model
process.env.COPILOT_MODEL = flags.model || process.env.COPILOT_MODEL || "";

// Log level
process.env.LOG_LEVEL = flags["log-level"] || process.env.LOG_LEVEL || "";

// Namespace and label for remote mode (kubectl log streaming)
process.env.K8S_NAMESPACE = flags.namespace || process.env.K8S_NAMESPACE || "copilot-sdk";
process.env.K8S_POD_LABEL = flags.label || process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker";

// System message
process.env._TUI_SYSTEM_MESSAGE = resolveSystemMessage();

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
