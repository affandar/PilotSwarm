import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { runManifest } from "../src/index.js";
import type { EvalProgressEvent, RunManifestResult } from "../src/index.js";

type CliOptions = {
  help?: boolean;
  runName?: string;
  scenariosPath?: string;
  manifestPath?: string;
  configPath?: string;
  driver?: string;
  runId?: string;
  requires: string[];
  reporters?: string[];
  reportsDir?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { requires: [] };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--scenarios=")) options.scenariosPath = arg.slice("--scenarios=".length);
    else if (arg.startsWith("--manifest=")) options.manifestPath = arg.slice("--manifest=".length);
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else if (arg.startsWith("--driver=")) options.driver = arg.slice("--driver=".length);
    else if (arg.startsWith("--run=")) {
      options.runId = arg.slice("--run=".length);
      options.runName = options.runId;
    } else if (arg.startsWith("--require=")) options.requires.push(arg.slice("--require=".length));
    else if (arg.startsWith("--reporters=")) options.reporters = arg.slice("--reporters=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--reports-dir=")) options.reportsDir = arg.slice("--reports-dir=".length);
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function helpText(): string {
  return [
    "PilotSwarm eval harness",
    "",
    "Usage:",
    "  run-eval --run=live-smoke",
    "  run-eval --config=eval/runs/smoke/config.json [--require=eval/eval-plugins.js]",
    "  run-eval --scenarios='eval/scenarios/**/*.scenario.json'",
    "",
    "Options:",
    "  --run=<name>              Use runs/<name>/config.json from the current directory, falling back to bundled runs.",
    "  --config=<path>           Run a config JSON file.",
    "  --manifest=<path>         Discover scenarios from a JSONL manifest.",
    "  --scenarios=<glob>        Discover scenario files directly.",
    "                             Choose exactly one selector: --run, --config, --manifest, or --scenarios.",
    "  --driver=<name>           Override the driver. The shipped driver is live; plugin drivers may be loaded with --require.",
    "  --reporters=a,b           Override configured reporters, for example console.",
    "  --reports-dir=<path>      Override output.reportsDir.",
    "  --require=<path>          Import a plugin module before discovery. Repeatable.",
    "  --help                    Print this help.",
    "                             Progress updates print to stderr while scenarios run.",
    "",
    "Exit codes:",
    "  0 success, 1 quality failures, 2 config/schema/CLI errors, 3 infra errors.",
  ].join("\n");
}

function packageRoot(): string {
  const binDir = dirname(fileURLToPath(import.meta.url));
  return existsSync(resolve(binDir, "..", "runs"))
    ? resolve(binDir, "..")
    : resolve(binDir, "..", "..");
}

function resolveRunConfig(runName: string): string {
  const cwdConfig = resolve("runs", runName, "config.json");
  if (existsSync(cwdConfig)) return cwdConfig;
  return resolve(packageRoot(), "runs", runName, "config.json");
}

async function loadPlugins(paths: string[]): Promise<void> {
  for (const pluginPath of paths) {
    await import(pathToFileURL(resolve(pluginPath)).href);
  }
}

async function configRunId(configPath?: string): Promise<string | undefined> {
  if (!configPath) return undefined;
  const parsed = JSON.parse(await readFile(resolve(configPath), "utf8")) as { id?: string };
  return parsed.id;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  const selectors = [options.runName, options.configPath, options.manifestPath, options.scenariosPath].filter(Boolean);
  if (selectors.length > 1) throw new Error("Choose only one scenario selector: --run, --config, --manifest, or --scenarios.");
  await loadPlugins(options.requires);

  const cwdConfigPath = options.configPath
    ?? (options.runName ? resolveRunConfig(options.runName) : undefined)
    ?? (options.scenariosPath || options.manifestPath ? undefined : resolveRunConfig("live-all"));
  const discoverOptions = {
    configPath: cwdConfigPath,
    manifestPath: options.manifestPath,
    scenariosPath: options.scenariosPath,
  };

  const progress = createCliProgress();
  let printedDiscoveryHeader = false;
  const result: RunManifestResult = await (async () => {
    try {
      return await runManifest({
        ...discoverOptions,
        runId: options.runId ?? await configRunId(cwdConfigPath) ?? "cli",
        driver: options.driver,
        reporters: options.reporters,
        reportsDir: options.reportsDir,
        onProgress(event) {
          if (event.phase === "discover") {
            if (!printedDiscoveryHeader) {
              console.log(`schema validation passed: ${event.total} discovered scenario definition(s)`);
              printedDiscoveryHeader = true;
            }
            console.log(`- ${event.scenarioId}`);
            return;
          }
          progress.update(event);
        },
      });
    } finally {
      progress.done();
    }
  })();
  if (!printedDiscoveryHeader) console.log("schema validation passed: 0 discovered scenario definition(s)");
  console.log(`execution cells: ${result.configuration.executionCellCount}`);
  console.log(`result: ${result.passed} passed, ${result.failed} failed, ${result.infraErrors} infra errors, ${result.skipped} skipped`);
  if (result.infraErrors > 0) return 3;
  if (result.failed > 0) return 1;
  return 0;
}

function createCliProgress(): {
  update: (event: EvalProgressEvent) => void;
  done: () => void;
} {
  let needsNewline = false;
  const isTty = Boolean(process.stderr.isTTY);
  return {
    update(event) {
      const current = event.phase === "start" ? Math.min(event.completed + 1, event.total) : event.completed;
      const state = event.phase === "start" ? "RUN" : progressStatusLabel(event.status);
      const line = `[eval] ${String(current).padStart(String(event.total).length, " ")}/${event.total} ${state.padEnd(5)} ${event.scenarioId}`;
      if (isTty) {
        process.stderr.write(`\r\x1b[K${line}`);
        needsNewline = true;
        if (event.phase === "finish" && event.completed === event.total) {
          process.stderr.write("\n");
          needsNewline = false;
        }
        return;
      }
      process.stderr.write(`${line}\n`);
    },
    done() {
      if (isTty && needsNewline) process.stderr.write("\n");
      needsNewline = false;
    },
  };
}

function progressStatusLabel(status: EvalProgressEvent["status"]): string {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  if (status === "infra_error") return "ERROR";
  if (status === "skip") return "SKIP";
  return "DONE";
}

main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = /schema|config|manifest|scenario|selector|unknown tool|unknown reporter|duplicate|unknown (option|argument)/i.test(message) ? 2 : 3;
});

export const __dirname = dirname(fileURLToPath(import.meta.url));
