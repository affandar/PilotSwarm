import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { discoverScenarios, runManifest } from "../src/index.js";
import { defaultAgentInventory } from "../src/engine/agent-inventory.js";

type CliOptions = {
  help?: boolean;
  listAgents?: boolean;
  runName?: string;
  scenariosPath?: string;
  manifestPath?: string;
  configPath?: string;
  driver?: string;
  fake?: boolean;
  runId?: string;
  requires: string[];
  reporters?: string[];
  reportsDir?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { requires: [] };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--list-agents") options.listAgents = true;
    else if (arg.startsWith("--scenarios=")) options.scenariosPath = arg.slice("--scenarios=".length);
    else if (arg.startsWith("--manifest=")) options.manifestPath = arg.slice("--manifest=".length);
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else if (arg.startsWith("--driver=")) options.driver = arg.slice("--driver=".length);
    else if (arg === "--fake") {
      options.fake = true;
      options.driver = "fake";
    }
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
    "  run-eval --run=all",
    "  run-eval --run=all --fake",
    "  run-eval --config=eval/runs/smoke/config.json [--require=eval/eval-plugins.js]",
    "  run-eval --scenarios='eval/scenarios/**/*.scenario.json' --fake",
    "  run-eval --list-agents",
    "",
    "Options:",
    "  --run=<name>              Use runs/<name>/config.json from the current directory, falling back to bundled runs.",
    "  --config=<path>           Run a config JSON file.",
    "  --manifest=<path>         Discover scenarios from a JSONL manifest.",
    "  --scenarios=<glob>        Discover scenario files directly.",
    "  --driver=<name>           Override the driver, usually live, fake, scripted, attach, or chaos.",
    "  --fake                    Fast preflight alias for --driver=fake; required LLMJudge checks still fail closed.",
    "  --reporters=a,b           Override configured reporters, for example console,markdown,jsonl.",
    "  --reports-dir=<path>      Override output.reportsDir.",
    "  --require=<path>          Import a plugin module before discovery. Repeatable.",
    "  --list-agents             Print registered agent inventory.",
    "  --help                    Print this help.",
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
  await loadPlugins(options.requires);

  if (options.listAgents) {
    for (const agent of defaultAgentInventory()) {
      console.log(`${agent.name}\t${agent.tier}\toverridable=${agent.isOverridable}`);
    }
    return 0;
  }

  const cwdConfigPath = options.configPath
    ?? (options.runName ? resolveRunConfig(options.runName) : undefined)
    ?? (options.scenariosPath || options.manifestPath ? undefined : resolveRunConfig("all"));
  const discoverOptions = {
    configPath: cwdConfigPath,
    manifestPath: options.manifestPath,
    scenariosPath: options.scenariosPath,
    driver: options.driver,
    fake: options.fake,
  };
  const scenarios = await discoverScenarios(discoverOptions);
  console.log(`schema validation passed: ${scenarios.length} discovered scenario definition(s)`);
  for (const scenario of scenarios) console.log(`- ${scenario.id}`);

  const result = await runManifest({
    ...discoverOptions,
    runId: options.runId ?? await configRunId(cwdConfigPath) ?? "cli",
    driver: options.driver,
    fake: options.fake,
    reporters: options.reporters,
    reportsDir: options.reportsDir
  });
  console.log(`execution cells: ${result.configuration.executionCellCount}`);
  console.log(`result: ${result.passed} passed, ${result.failed} failed, ${result.infraErrors} infra errors, ${result.skipped} skipped`);
  if (result.infraErrors > 0) return 3;
  if (result.failed > 0) return 1;
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = /schema|config|manifest|scenario|unknown tool|duplicate|unknown (option|argument)/i.test(message) ? 2 : 3;
});

export const __dirname = dirname(fileURLToPath(import.meta.url));
