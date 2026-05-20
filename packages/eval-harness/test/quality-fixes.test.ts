import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  discoverScenarios,
  registerCheckType,
  registerReporter,
  runManifest,
  runScenario,
} from "../src/index.js";
import { runChecks } from "../src/engine/check-runner.js";
import type { ObservedResult, Scenario } from "../src/types.js";

const execFileAsync = promisify(execFile);

const baseScenario = {
  schemaVersion: 1,
  kind: "single-turn",
  id: "quality.base",
  description: "Quality base.",
  input: { prompt: "Say ok." },
  checks: [],
} satisfies Scenario;

const observed: ObservedResult = {
  scenarioId: baseScenario.id,
  finalResponse: "ok complete",
  toolCalls: [{ name: "nested", args: { payload: { b: 1 } } }],
  cmsEvents: [],
  latencyMs: 1,
  costUsd: 0,
  tokensIn: 1,
  tokensOut: 1,
  terminalState: "completed",
};

describe("quality review fixes", () => {
  it("fails scenarios when a check evaluator errors", async () => {
    registerCheckType("quality-error-check", {
      evaluate: () => ({ pass: false, errored: true, message: "provider failed" }),
    });

    const result = await runScenario({
      ...baseScenario,
      checks: [{ type: "quality-error-check" } as never],
    }, { defaults: { driver: "fake" } });

    expect(result.passed).toBe(false);
    expect(result.failureMessage).toContain("provider failed");
  });

  it("converts thrown check evaluator errors into failed scenario results", async () => {
    registerCheckType("quality-throw-check", {
      evaluate: () => {
        throw new Error("judge exploded");
      },
    });

    const result = await runScenario({
      ...baseScenario,
      checks: [{ type: "quality-throw-check" } as never],
    }, { defaults: { driver: "fake" } });

    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({
      pass: false,
      errored: true,
      message: "judge exploded",
    });
  });

  it("matches exact nested tool args without false positives", async () => {
    await expect(runChecks({
      scenario: baseScenario,
      observed,
      checks: [{ type: "tool-call", name: "nested", args: { payload: { c: 2 } }, match: "exact" }],
    })).resolves.toMatchObject([{ pass: false }]);
  });

  it("discovers recursive glob includes and adds manifest selection tags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-glob-"));
    const scenarioDir = join(dir, "scenarios", "deep");
    await mkdir(scenarioDir, { recursive: true });
    await writeFile(join(scenarioDir, "sample.scenario.json"), JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "glob.sample",
      description: "Glob sample.",
      input: { prompt: "Say ok." },
      checks: [{ type: "response-contains", any: ["ok"] }],
      tags: ["base"],
    }));
    const manifestPath = join(dir, "scenarios.jsonl");
    await writeFile(
      manifestPath,
      '{"schemaVersion":1}\n' +
        '{"include":"scenarios/**/*.scenario.json"}\n' +
        '{"path":"scenarios/deep/sample.scenario.json","overrides":{"tags":["manifest"]}}\n',
    );

    const scenarios = await discoverScenarios({ manifestPath });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]?.tags).toEqual(["base", "manifest"]);
    expect(scenarios[0]?.metadata?.selectionTags).toEqual(["manifest"]);
  });

  it("rejects manifest overrides that try to change scenario behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-manifest-override-"));
    const scenarioPath = join(dir, "sample.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "manifest.override-behavior",
      description: "Manifest behavior override.",
      input: { prompt: "Say ok." },
      checks: [{ type: "response-contains", any: ["ok"] }],
    }));
    await writeFile(
      manifestPath,
      '{"schemaVersion":1}\n' +
        '{"path":"sample.scenario.json","overrides":{"tags":["manifest"],"driver":"fake"}}\n',
    );

    await expect(discoverScenarios({ manifestPath }))
      .rejects
      .toThrow(/manifest overrides may only set tags/i);
  });

  it("rejects native PilotSwarm tool names as scenario-owned tool registrations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-native-tools-"));
    const scenarioPath = join(dir, "native-tool.scenario.json");
    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "native.tool.registration",
      description: "Native tool registration misuse.",
      tools: ["wait"],
      input: { prompt: "Wait durably, then report completion." },
      checks: [{ type: "tool-sequence", order: "subsequence", calls: ["wait"] }],
    }));

    await expect(discoverScenarios({ scenarioPaths: [scenarioPath] }))
      .rejects
      .toThrow(/references unknown tool "wait"/i);
  });

  it("rejects reserved meta-scenario gates and meta-level checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-meta-reserved-"));
    const basePath = join(dir, "base.scenario.json");
    const checkedMetaPath = join(dir, "checked-meta.scenario.json");
    const gatedMetaPath = join(dir, "gated-meta.scenario.json");
    await writeFile(basePath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "base.meta",
      description: "Base meta target.",
      input: { prompt: "Say ok." },
      checks: [{ type: "response-contains", any: ["ok"] }],
    }));
    await writeFile(checkedMetaPath, JSON.stringify({
      schemaVersion: 1,
      kind: "ablation",
      id: "meta.checked",
      description: "Checked meta scenario.",
      baseScenario: "./base.scenario.json",
      axes: { model: ["github-copilot:gpt-5.4"] },
      checks: [{ type: "goal-completed" }],
    }));
    await writeFile(gatedMetaPath, JSON.stringify({
      schemaVersion: 1,
      kind: "prompt-variant",
      id: "meta.gated",
      description: "Gated meta scenario.",
      appliesTo: "./base.scenario.json",
      variants: [
        { id: "baseline", promptOverrides: {} },
        { id: "concise", promptOverrides: { "incident-conductor": { inline: "Be concise." } } },
      ],
      gate: "all-cells-pass",
    }));

    await expect(discoverScenarios({ scenarioPaths: [checkedMetaPath] }))
      .rejects
      .toThrow(/meta-scenario checks are reserved/i);
    await expect(discoverScenarios({ scenarioPaths: [gatedMetaPath] }))
      .rejects
      .toThrow(/meta-scenario gate "all-cells-pass" is reserved/i);
  });

  it("matches globstar files in the root directory and nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-root-glob-"));
    await mkdir(join(dir, "nested"), { recursive: true });
    for (const [relative, id] of [["root.scenario.json", "glob.root"], ["nested/deep.scenario.json", "glob.deep"]] as const) {
      await writeFile(join(dir, relative), JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id,
        description: id,
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      }));
    }

    const scenarios = await discoverScenarios({ scenariosPath: join(dir, "**/*.scenario.json") });
    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual(["glob.deep", "glob.root"]);
  });

  it("fails fast on unknown reporters and passes config report dirs to reporters", async () => {
    const dirs: unknown[] = [];
    registerReporter("quality-report-dir", {
      emit: (_result, options) => dirs.push(options?.reportsDir),
    });

    const dir = await mkdtemp(join(tmpdir(), "eval-harness-reporters-"));
    const scenarioPath = join(dir, "sample.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "report-dir.sample",
      description: "Report dir.",
      input: { prompt: "Say ok." },
      checks: [{ type: "response-contains", any: ["ok"] }],
    }));
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"sample.scenario.json"}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "report-dir",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "fake" },
      reporters: ["quality-report-dir"],
      output: { reportsDir: "from-config" },
    }));

    await runManifest({ configPath });
    expect(dirs).toEqual(["from-config"]);

    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "bad-reporter",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "fake" },
      reporters: ["missing-reporter"],
    }));
    await expect(runManifest({ configPath })).rejects.toThrow(/Unknown reporter/);
  });

  it("validates reporter names before running scenarios", async () => {
    registerCheckType("quality-should-not-run", {
      evaluate: () => {
        throw new Error("scenario ran before reporter validation");
      },
    });

    const dir = await mkdtemp(join(tmpdir(), "eval-harness-reporter-fast-"));
    const scenarioPath = join(dir, "sample.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "reporter-fast.sample",
      description: "Reporter fast fail.",
      input: { prompt: "Say ok." },
      checks: [{ type: "quality-should-not-run" }],
    }));
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"sample.scenario.json"}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "reporter-fast",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "fake" },
      reporters: ["missing-reporter-fast"],
    }));

    await expect(runManifest({ configPath })).rejects.toThrow(/Unknown reporter "missing-reporter-fast"/);
  });

  it("rejects unknown CLI flags", async () => {
    await expect(execFileAsync("bash", ["bin/run-eval.sh", "--wat"], {
      cwd: join(import.meta.dirname, ".."),
    })).rejects.toMatchObject({ code: 2 });
  });
});
