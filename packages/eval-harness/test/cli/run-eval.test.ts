import { execFile } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("run-eval CLI", () => {
  it("prints frictionless command help", async () => {
    const { stdout } = await execFileAsync("bash", ["bin/run-eval.sh", "--help"], {
      cwd: join(import.meta.dirname, "../..")
    });
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--run=<name>");
    expect(stdout).toContain("--fake");
    expect(stdout).toContain("Exit codes:");
  });

  it("resolves package bin symlinks like npm exec does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-cli-bin-symlink-"));
    const linkPath = join(dir, "run-eval");
    await symlink(join(import.meta.dirname, "../../bin/run-eval.sh"), linkPath);

    const { stdout } = await execFileAsync("bash", [linkPath, "--help"], {
      cwd: join(import.meta.dirname, "../..")
    });

    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--run=<name>");
  });

  it("prints available agent inventory", async () => {
    const { stdout } = await execFileAsync("bash", ["bin/run-eval.sh", "--list-agents"], {
      cwd: join(import.meta.dirname, "../..")
    });
    expect(stdout).toContain("default");
    expect(stdout).toContain("framework-base");
  });

  it("validates and runs fake scenarios", async () => {
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

    const { stdout } = await execFileAsync("bash", ["bin/run-eval.sh", `--scenarios=${scenarioPath}`, "--driver=fake"], {
      cwd: join(import.meta.dirname, "../..")
    });
    expect(stdout).toContain("schema validation passed");
    expect(stdout).toContain("cli.fake");
  });

  it("rejects bare positional arguments instead of defaulting to the all run", async () => {
    await expect(execFileAsync("bash", ["bin/run-eval.sh", "smoke", "--fake", "--reporters=console"], {
      cwd: join(import.meta.dirname, "../..")
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Unknown argument: smoke"),
    });
  });

  it("prints discovered scenario definitions separately from execution cells", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-cli-cells-"));
    const basePath = join(dir, "base.scenario.json");
    const variantPath = join(dir, "variant.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");

    await writeFile(basePath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "cli.base",
      description: "Base scenario.",
      input: { prompt: "Return ok" },
      checks: [{ type: "response-contains", any: ["ok"] }],
      metadata: { fake: { finalResponse: "ok complete" } }
    }));
    await writeFile(variantPath, JSON.stringify({
      schemaVersion: 1,
      kind: "prompt-variant",
      id: "cli.prompt-variant",
      description: "Prompt variant meta scenario.",
      appliesTo: "base.scenario.json",
      variants: [
        {
          id: "baseline",
          promptOverrides: {
            default: { inline: "Use the default style." }
          }
        },
        {
          id: "concise",
          promptOverrides: {
            default: { inline: "Use a concise style." }
          }
        }
      ],
      checks: []
    }));
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"variant.scenario.json"}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "cli.cells",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "fake" },
      reporters: ["console"]
    }));

    const { stdout } = await execFileAsync("node", [
      "--no-warnings",
      "--experimental-strip-types",
      "--loader",
      "./bin/ts-loader.mjs",
      "./bin/run-eval.ts",
      `--config=${configPath}`,
      "--fake"
    ], {
      cwd: join(import.meta.dirname, "../..")
    });
    expect(stdout).toContain("schema validation passed: 1 discovered scenario definition(s)");
    expect(stdout).toContain("execution cells: 2");
    expect(stdout).toContain("result: 2 passed, 0 failed, 0 infra errors");
  });

  it("runs bundled run plans from the repository root", async () => {
    const { stdout } = await execFileAsync("bash", ["packages/eval-harness/bin/run-eval.sh", "--run=smoke", "--fake", "--reporters=console"], {
      cwd: join(import.meta.dirname, "../../../..")
    });
    expect(stdout).toContain("schema validation passed: 13 discovered scenario definition(s)");
    expect(stdout).toContain("execution cells: 13");
    expect(stdout).toContain("result: 13 passed, 0 failed, 0 infra errors");
  });

  it("prints skipped count and exits successfully when all scenarios are skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-cli-skipped-"));
    const scenarioPath = join(dir, "live-required.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");

    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "cli.skip.live-required",
      description: "Live-required scenario skipped by fake preflight.",
      requirements: { live: true },
      input: { prompt: "This should not run with fake." },
      checks: [{ type: "response-contains", any: ["unreachable"] }]
    }));
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"live-required.scenario.json"}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "cli.skip",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "fake" },
      requirements: { onUnsupported: "skip" },
      reporters: ["console"]
    }));

    const { stdout } = await execFileAsync("node", [
      "--no-warnings",
      "--experimental-strip-types",
      "--loader",
      "./bin/ts-loader.mjs",
      "./bin/run-eval.ts",
      `--config=${configPath}`,
      "--fake"
    ], {
      cwd: join(import.meta.dirname, "../..")
    });
    expect(stdout).toContain("schema validation passed: 1 discovered scenario definition(s)");
    expect(stdout).toContain("execution cells: 1");
    expect(stdout).toContain("result: 0 passed, 0 failed, 0 infra errors, 1 skipped");
  });
});
