import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../helpers/run-cli.js";

const FAKE_PLUGIN = join(import.meta.dirname, "..", "helpers", "fake-driver-plugin.ts");

describe("run-eval CLI", () => {
  it("prints command help with usage and exit codes", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PilotSwarm eval harness");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--run=<name>");
    expect(result.stdout).toContain("--require=<path>");
    expect(result.stdout).toContain("Exit codes:");
  });

  it("validates and runs scenarios through a plugin-registered driver", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-cli-"));
    const scenarioPath = join(dir, "cli.scenario.json");
    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "cli.fake",
      description: "CLI fake",
      input: { prompt: "Return ok" },
      checks: [{ type: "response-contains", any: ["ok"] }],
      metadata: { fake: { finalResponse: "ok complete" } }
    }));

    const result = await runCli([`--require=${FAKE_PLUGIN}`, `--scenarios=${scenarioPath}`, "--driver=fake"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("schema validation passed");
    expect(result.stdout).toContain("cli.fake");
  });

  it("rejects bare positional arguments with exit code 2", async () => {
    const result = await runCli(["smoke"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown argument: smoke");
  });

  it("rejects unknown options with exit code 2", async () => {
    const result = await runCli(["--list-agents"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown option: --list-agents");
  });

  it("rejects mixed scenario selectors with exit code 2", async () => {
    const result = await runCli(["--run=live-smoke", "--scenarios=scenarios/**/*.scenario.json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Choose only one scenario selector");
  });

  it("prints discovered v0 scenarios and execution cell count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-cli-cells-"));
    const scenarioPath = join(dir, "single.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");

    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "cli.cells",
      description: "CLI cell count scenario.",
      input: { prompt: "Return ok" },
      checks: [{ type: "response-contains", any: ["ok"] }],
      metadata: { fake: { finalResponse: "ok complete" } }
    }));
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"single.scenario.json"}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "cli.cells",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "fake" },
      reporters: ["console"]
    }));

    const result = await runCli([`--require=${FAKE_PLUGIN}`, `--config=${configPath}`, "--driver=fake"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("schema validation passed: 1 discovered scenario definition(s)");
    expect(result.stdout).toContain("execution cells: 1");
    expect(result.stdout).toContain("result: 1 passed, 0 failed, 0 infra errors, 0 skipped");
  });
});
