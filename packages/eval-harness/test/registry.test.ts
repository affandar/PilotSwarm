import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  discoverScenarios,
  drivers,
  registerCheckType,
  registerReporter,
  runManifest,
  scenarioKinds,
  tools,
} from "../src/index.js";
import { runChecks } from "../src/engine/check-runner.js";
import type { ObservedResult, Scenario } from "../src/types.js";

describe("extension registry wiring", () => {
  it("registers only the v0 built-in scenario kinds and default fixture tools", () => {
    expect([...scenarioKinds.keys()].sort()).toEqual([
      "durable-trajectory",
      "multi-turn",
      "safety",
      "single-turn",
    ]);
    expect([...tools.keys()].sort()).toEqual(["delete_agent", "test_add", "test_untrusted_status"]);
    expect(drivers.has("live")).toBe(false);
    expect(tools.get("test_add")?.parameters).toMatchObject({
      type: "object",
      required: ["a", "b"],
      additionalProperties: false,
    });
    expect(tools.get("test_untrusted_status")?.parameters).toMatchObject({
      type: "object",
      required: ["city"],
      additionalProperties: false,
    });
  });

  it("evaluates custom registered check types in scenario and turn-local checks", async () => {
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
      checks: [{ type: "custom-final-response-equals", expected: "exact" } as never],
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

    await expect(runChecks({ scenario, observed })).resolves.toMatchObject([{ pass: true }]);
    await expect(runChecks({ scenario, observed, checks: [{ type: "custom-final-response-equals" }] as never }))
      .resolves.toMatchObject([{ pass: false, errored: true }]);

    const dir = await mkdtemp(join(tmpdir(), "eval-harness-custom-check-"));
    const scenarioPath = join(dir, "multi.scenario.json");
    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "multi-turn",
      id: "custom.turn-check",
      description: "Custom turn-local check scenario.",
      turns: [
        {
          input: { prompt: "Say alpha." },
          checks: [{ type: "custom-final-response-equals", expected: "alpha" }],
        },
      ],
      checks: [],
    }));

    const scenarios = await discoverScenarios({ scenarioPaths: [scenarioPath] });
    expect((scenarios[0] as Extract<Scenario, { kind: "multi-turn" }>).turns[0]?.checks).toEqual([
      { type: "custom-final-response-equals", expected: "alpha" },
    ]);
  });

  it("allows shared manifest include DAGs while still detecting cycles", async () => {
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

    await expect(discoverScenarios({ manifestPath: join(dir, "a.jsonl") }))
      .resolves
      .toMatchObject([{ id: "manifest.shared" }]);

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
    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "reporter.single",
      description: "Reporter.",
      input: { prompt: "Say ok." },
      checks: [{ type: "response-contains", any: ["ok"] }],
      metadata: { fake: { finalResponse: "ok" } },
    }));
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"single.scenario.json"}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "reporter-run",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "fake" },
      reporters: ["unit-capture"],
    }));

    await runManifest({ configPath });
    expect(emitted).toEqual(["reporter-run:1"]);
  });
});
