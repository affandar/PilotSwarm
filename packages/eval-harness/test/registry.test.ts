import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  discoverScenarios,
  registerCheckType,
  registerReporter,
  runManifest,
  scenarioKinds,
} from "../src/index.js";
import { runChecks } from "../src/engine/check-runner.js";
import type { ObservedResult, Scenario } from "../src/types.js";

describe("extension registry wiring", () => {
  it("registers built-in scenario kinds including batch file support", () => {
    expect([...scenarioKinds.keys()].sort()).toEqual([
      "ablation",
      "batch",
      "durable-trajectory",
      "multi-turn",
      "prompt-variant",
      "safety",
      "single-turn",
    ]);
  });

  it("evaluates custom registered check types", async () => {
    registerCheckType("custom-final-response-equals", {
      schema: z.object({
        type: z.literal("custom-final-response-equals"),
        expected: z.string(),
      }),
      evaluate: ({ observed, config }) => ({
        pass: observed.finalResponse === config.expected,
        message: `expected final response ${config.expected}`,
      }),
    });

    const scenario = {
      schemaVersion: 1,
      kind: "single-turn",
      id: "custom.check",
      description: "Custom check.",
      input: { prompt: "Return exact." },
      checks: [],
    } satisfies Scenario;
    const observed: ObservedResult = {
      scenarioId: scenario.id,
      finalResponse: "exact",
      toolCalls: [],
      cmsEvents: [],
      latencyMs: 1,
      costUsd: 0,
      tokensIn: 1,
      tokensOut: 1,
      terminalState: "completed",
    };

    await expect(runChecks({
      scenario,
      observed,
      checks: [{ type: "custom-final-response-equals", expected: "exact" } as never],
    })).resolves.toMatchObject([{ pass: true }]);
  });

  it("discovers custom checks in turn-local checks", async () => {
    registerCheckType("custom-turn-final-response-equals", {
      schema: z.object({
        type: z.literal("custom-turn-final-response-equals"),
        expected: z.string(),
      }),
      evaluate: ({ observed, config }) => ({
        pass: observed.finalResponse === config.expected,
        message: `expected turn response ${config.expected}`,
      }),
    });

    const dir = await mkdtemp(join(tmpdir(), "eval-harness-turn-custom-check-"));
    const scenarioPath = join(dir, "multi.scenario.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "multi-turn",
        id: "custom.turn-check",
        description: "Custom turn-local check scenario.",
        turns: [
          {
            input: { prompt: "Say alpha." },
            checks: [{ type: "custom-turn-final-response-equals", expected: "alpha" }],
          },
        ],
        checks: [],
      }),
    );

    const scenarios = await discoverScenarios({ scenarioPaths: [scenarioPath] });
    expect((scenarios[0] as Extract<Scenario, { kind: "multi-turn" }>).turns[0]?.checks).toEqual([
      { type: "custom-turn-final-response-equals", expected: "alpha" },
    ]);
  });

  it("discovers custom checks in batch file defaults and samples", async () => {
    registerCheckType("custom-batch-final-response-equals", {
      schema: z.object({
        type: z.literal("custom-batch-final-response-equals"),
        expected: z.string(),
      }),
      evaluate: ({ observed, config }) => ({
        pass: observed.finalResponse === config.expected,
        message: `expected batch response ${config.expected}`,
      }),
    });

    const dir = await mkdtemp(join(tmpdir(), "eval-harness-batch-custom-check-"));
    const batchPath = join(dir, "batch.scenarios.json");
    await writeFile(
      batchPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "custom.batch",
        description: "Custom batch check scenario.",
        checks: [{ type: "custom-batch-final-response-equals", expected: "base" }],
        samples: [
          {
            id: "sample",
            input: { prompt: "Say sample." },
            checks: [{ type: "custom-batch-final-response-equals", expected: "sample" }],
          },
        ],
      }),
    );

    const scenarios = await discoverScenarios({ scenarioPaths: [batchPath] });
    expect(scenarios[0]?.checks).toEqual([
      { type: "custom-batch-final-response-equals", expected: "base" },
      { type: "custom-batch-final-response-equals", expected: "sample" },
    ]);
  });

  it("allows shared manifest include DAGs while still detecting real cycles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-manifest-dag-"));
    await writeFile(join(dir, "scenario.scenario.json"), JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "manifest.shared",
      description: "Shared manifest scenario.",
      input: { prompt: "Say shared." },
      checks: [{ type: "response-contains", any: ["shared"] }],
    }));
    await writeFile(join(dir, "b.jsonl"), '{"schemaVersion":1}\n{"path":"scenario.scenario.json"}\n');
    await writeFile(join(dir, "c.jsonl"), '{"schemaVersion":1}\n{"include-manifest":"b.jsonl"}\n');
    await writeFile(join(dir, "a.jsonl"), '{"schemaVersion":1}\n{"include-manifest":"b.jsonl"}\n{"include-manifest":"c.jsonl"}\n');

    const scenarios = await discoverScenarios({ manifestPath: join(dir, "a.jsonl") });
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["manifest.shared"]);

    await writeFile(join(dir, "cycle-a.jsonl"), '{"schemaVersion":1}\n{"include-manifest":"cycle-b.jsonl"}\n');
    await writeFile(join(dir, "cycle-b.jsonl"), '{"schemaVersion":1}\n{"include-manifest":"cycle-a.jsonl"}\n');
    await expect(discoverScenarios({ manifestPath: join(dir, "cycle-a.jsonl") }))
      .rejects
      .toThrow(/Manifest include cycle detected/);
  });

  it("emits reporters declared in config", async () => {
    const emitted: string[] = [];
    registerReporter("unit-capture", {
      emit: (result) => {
        emitted.push(`${result.runId}:${result.passed}`);
      },
    });

    const dir = await mkdtemp(join(tmpdir(), "eval-harness-reporter-"));
    const scenarioPath = join(dir, "single.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "reporter.single",
        description: "Reporter.",
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      }),
    );
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"single.scenario.json"}\n');
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "reporter-run",
        scenarios: "./scenarios.jsonl",
        defaults: { driver: "fake" },
        reporters: ["unit-capture"],
      }),
    );

    await runManifest({ configPath });
    expect(emitted).toEqual(["reporter-run:1"]);
  });
});
