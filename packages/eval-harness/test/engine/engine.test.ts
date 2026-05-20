import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { discoverScenarios, runManifest, runScenario } from "../../src/index.js";

describe("eval engine", () => {
  it("discovers scenarios from a manifest and runs fake scenarios", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-"));
    const scenarioPath = join(dir, "add.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");

    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "single.add",
      description: "Fake add",
      tools: ["test_add"],
      input: { prompt: "Add 5 and 7 using test_add." },
      checks: [
        { type: "tool-call", name: "test_add", args: { a: 5, b: 7 }, match: "subset" },
        { type: "tool-sequence", order: "exactSequence", calls: ["test_add"] },
        { type: "response-contains", any: ["12"] },
        { type: "goal-completed" }
      ],
      metadata: {
        fake: {
          finalResponse: "The answer is 12. Completed.",
          toolCalls: [{ name: "test_add", args: { a: 5, b: 7 }, result: 12 }]
        }
      }
    }));
    await writeFile(manifestPath, `{"schemaVersion":1}\n{"path":"${scenarioPath}"}\n`);

    const scenarios = await discoverScenarios({ manifestPath, driver: "fake" });
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["single.add"]);

    const scenarioResult = await runScenario(scenarios[0]!, { defaults: { driver: "fake" } });
    expect(scenarioResult.passed).toBe(true);
    expect(scenarioResult.checks.every((check) => check.pass)).toBe(true);

    const manifestResult = await runManifest({ manifestPath, driver: "fake", runId: "unit" });
    expect(manifestResult).toMatchObject({ runId: "unit", passed: 1, failed: 0, infraErrors: 0 });
  });

  it("reports gated failures from fake observations", async () => {
    const result = await runScenario({
      schemaVersion: 1,
      kind: "single-turn",
      id: "single.fail",
      description: "Fake failure",
      agent: "default",
      tools: [],
      tags: [],
      checks: [{ type: "response-contains", all: ["missing"] }],
      input: { prompt: "Say hello" },
      llmJudgeRequired: false,
      metadata: { fake: { finalResponse: "hello", toolCalls: [] } }
    }, { defaults: { driver: "fake" } });

    expect(result.passed).toBe(false);
    expect(result.failureMessage).toContain("missing");
  });
});
