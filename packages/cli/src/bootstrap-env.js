import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTuiBranding } from "./plugin-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

function resolvePluginDir(flags) {
    if (flags.plugin) return path.resolve(flags.plugin);
    if (process.env.PLUGIN_DIRS) {
        const dirs = process.env.PLUGIN_DIRS.split(",").map((value) => value.trim()).filter(Boolean);
        return dirs[0] || null;
    }
    const cwdPlugin = path.resolve("plugins");
    if (fs.existsSync(cwdPlugin)) return cwdPlugin;
    const bundledPlugin = path.join(pkgRoot, "plugins");
    if (fs.existsSync(bundledPlugin)) return bundledPlugin;
    return null;
}

function resolveSystemMessage(flags) {
    if (flags.system) {
        if (fs.existsSync(flags.system)) {
            return fs.readFileSync(flags.system, "utf-8").trim();
        }
        return flags.system;
    }

    const pluginDir = resolvePluginDir(flags);
    if (pluginDir) {
        const systemMd = path.join(pluginDir, "system.md");
        if (fs.existsSync(systemMd)) {
            return fs.readFileSync(systemMd, "utf-8").trim();
        }
    }

    if (process.env.SYSTEM_MESSAGE) return process.env.SYSTEM_MESSAGE;
    return undefined;
}

function loadEnvFile(envFile) {
    if (!fs.existsSync(envFile)) return;
    const envContent = fs.readFileSync(envFile, "utf-8");
    for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

function ensureGithubToken() {
    if (process.env.GITHUB_TOKEN) return;
    try {
        const token = execFileSync("gh", ["auth", "token"], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (token) {
            process.env.GITHUB_TOKEN = token;
        }
    } catch {}
}

export function parseCliIntoEnv(argv) {
    const { values: flags, positionals } = parseArgs({
        options: {
            store: { type: "string", short: "s" },
            env: { type: "string", short: "e" },
            plugin: { type: "string", short: "p" },
            worker: { type: "string", short: "w" },
            workers: { type: "string", short: "n" },
            model: { type: "string", short: "m" },
            system: { type: "string" },
            context: { type: "string", short: "c" },
            namespace: { type: "string" },
            label: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
        strict: false,
        args: argv,
    });

    if (flags.help) {
        console.log(`
pilotswarm — PilotSwarm terminal UI

USAGE
  npx pilotswarm [local|remote] [flags]

FLAGS
  -e, --env <file>       Env file
  -p, --plugin <dir>     Plugin directory
  -w, --worker <module>  Worker tools module
  -n, --workers <count>  Embedded worker count
  -m, --model <name>     Initial model
  -c, --context <ctx>    K8s context for remote mode
      --namespace <ns>   K8s namespace
      --label <selector> K8s pod label
  -h, --help             Show help
`.trim());
        process.exit(0);
    }

    const mode = positionals[0] === "remote" ? "remote" : "local";
    const envFile = flags.env || (mode === "remote" ? ".env.remote" : ".env");
    loadEnvFile(envFile);
    ensureGithubToken();

    process.env.DATABASE_URL = flags.store || process.env.DATABASE_URL || "sqlite::memory:";
    process.env.WORKERS = mode === "remote" ? "0" : (flags.workers ?? process.env.WORKERS ?? "4");
    process.env.COPILOT_MODEL = flags.model || process.env.COPILOT_MODEL || "";
    process.env.K8S_CONTEXT = flags.context || process.env.K8S_CONTEXT || "";
    process.env.K8S_NAMESPACE = flags.namespace || process.env.K8S_NAMESPACE || "copilot-runtime";
    process.env.K8S_POD_LABEL = flags.label || process.env.K8S_POD_LABEL || "app.kubernetes.io/component=worker";

    const pluginDir = resolvePluginDir(flags);
    if (pluginDir) {
        process.env.PLUGIN_DIRS = pluginDir;
    }

    const branding = resolveTuiBranding(pluginDir);
    process.env._TUI_TITLE = branding.title;
    process.env._TUI_SPLASH = branding.splash;

    const systemMessage = resolveSystemMessage(flags);
    if (systemMessage) process.env._TUI_SYSTEM_MESSAGE = systemMessage;

    if (mode === "local" && flags.worker) {
        const resolvedWorker = path.resolve(flags.worker);
        if (!fs.existsSync(resolvedWorker)) {
            throw new Error(`Worker module not found: ${resolvedWorker}`);
        }
        process.env._TUI_WORKER_MODULE = resolvedWorker;
    }

    return {
        mode,
        store: process.env.DATABASE_URL,
        branding,
    };
}
