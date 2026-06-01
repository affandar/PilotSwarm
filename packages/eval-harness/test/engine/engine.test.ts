import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { discoverScenarios, runManifest, runScenario } from "../../src/index.js";
import { scenarioReportEntries } from "../../src/reporters/output.js";

async function withoutJudgeProvider<T>(fn: () => Promise<T>): Promise<T> {
  const env = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    PILOTSWARM_EVAL_LLM_JUDGE_PROVIDER: process.env.PILOTSWARM_EVAL_LLM_JUDGE_PROVIDER,
  };
  delete process.env.GITHUB_TOKEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.PILOTSWARM_EVAL_LLM_JUDGE_PROVIDER;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") process.env[key] = value;
      else delete process.env[key];
    }
  }
}

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
      ],
      metadata: {
        fake: {
          finalResponse: "The answer is 12. Completed.",
          toolCalls: [{ name: "test_add", args: { a: 5, b: 7 }, result: 12 }]
        }
      }
    }));
    await writeFile(manifestPath, `{"schemaVersion":1}\n{"path":"${scenarioPath}"}\n`);

    const scenarios = await discoverScenarios({ manifestPath });
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["single.add"]);

    const scenarioResult = await runScenario(scenarios[0]!, { defaults: { driver: "fake" } });
    expect(scenarioResult.passed).toBe(true);
    expect(scenarioResult.checks).toHaveLength(3);
    expect(scenarioResult.checks.every((check) => check.pass)).toBe(true);

    const progress: string[] = [];
    const manifestResult = await runManifest({
      manifestPath,
      driver: "fake",
      runId: "unit",
      onProgress: (event) => {
        progress.push(`${event.phase}:${event.completed}/${event.total}:${event.scenarioId}:${event.status ?? "running"}`);
      },
    });
    expect(manifestResult).toMatchObject({ runId: "unit", passed: 1, failed: 0, infraErrors: 0 });
    expect(progress).toEqual([
      "discover:1/1:single.add:running",
      "start:0/1:single.add:running",
      "finish:1/1:single.add:pass",
    ]);
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

  it("discovers direct scenario files and tag-filtered manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-discover-"));
    const smokePath = join(dir, "smoke.scenario.json");
    const slowPath = join(dir, "slow.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");

    await writeFile(smokePath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "single.smoke",
      description: "Smoke scenario.",
      tags: ["smoke"],
      input: { prompt: "Say ok." },
      checks: [{ type: "response-contains", any: ["ok"] }],
    }));
    await writeFile(slowPath, JSON.stringify({
      schemaVersion: 1,
      kind: "safety",
      id: "single.slow",
      description: "Slow scenario.",
      tags: ["slow"],
      input: { prompt: "Say safe." },
      checks: [{ type: "no-secret-leak" }],
    }));
    await writeFile(manifestPath, [
      '{"schemaVersion":1}',
      '{"include":"*.scenario.json"}',
    ].join("\n"));

    await expect(discoverScenarios({ scenarioPaths: [smokePath] }))
      .resolves
      .toMatchObject([{ id: "single.smoke" }]);
    await expect(discoverScenarios({ manifestPath, includeTags: ["smoke"] }))
      .resolves
      .toMatchObject([{ id: "single.smoke" }]);
  });

  it("runs a scenario through a test-only plugin driver registered by public API", async () => {
    const result = await runScenario({
      scenario: {
        schemaVersion: 1,
        kind: "single-turn",
        id: "single.fake",
        description: "Fake driver scenario.",
        tools: ["test_add"],
        input: { prompt: "Add 3 and 4 with test_add." },
        checks: [
          { type: "tool-call", name: "test_add", args: { a: 3, b: 4 }, match: "subset" },
          { type: "response-contains", any: ["7"] },
        ],
        metadata: {
          fake: {
            finalResponse: "7",
            toolCalls: [{ name: "test_add", args: { a: 3, b: 4 }, result: 7 }],
          },
        },
      },
      config: { schemaVersion: 1, id: "unit", defaults: { driver: "fake" } },
    });

    expect(result.passed).toBe(true);
    expect(result.metadata?.driver).toBe("fake");
    expect(result.observed.toolCalls).toEqual([{ name: "test_add", args: { a: 3, b: 4 }, result: 7 }]);
  });

  it("summarizes manifest runs without removed cell expansion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-manifest-"));
    const scenarioPath = join(dir, "single.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");

    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: 1,
      kind: "single-turn",
      id: "manifest.single",
      description: "Manifest scenario.",
      input: { prompt: "Say ok." },
      checks: [{ type: "response-contains", any: ["ok"] }],
      metadata: { fake: { finalResponse: "ok" } },
    }));
    await writeFile(manifestPath, '{"schemaVersion":1}\n{"include":"single.scenario.json"}\n');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      id: "manifest-run",
      scenarios: "./scenarios.jsonl",
      defaults: { driver: "fake" },
      reporters: [],
    }));

    const result = await runManifest({ configPath });

    expect(result).toMatchObject({ runId: "manifest-run", passed: 1, failed: 0, infraErrors: 0, skipped: 0 });
    expect(result.configuration).toMatchObject({ discoveredScenarioCount: 1, executionCellCount: 1 });
    expect(scenarioReportEntries(result)[0]?.status).toBe("PASS");
  });

  it("evaluates turn-local checks against the matching turn response and CMS iteration", async () => {
    const result = await runScenario({
      scenario: {
        schemaVersion: 1,
        kind: "multi-turn",
        id: "multi.turn-local",
        description: "Turn-local checks are scoped by turn.",
        turns: [
          {
            input: { prompt: "Record Tokyo." },
            checks: [{ type: "response-contains", all: ["Tokyo recorded"] }],
          },
          {
            input: { prompt: "Recall Tokyo." },
            checks: [{ type: "cms-events-contain", events: ["session.wait_completed"] }],
          },
        ],
        checks: [{ type: "response-contains", all: ["Tokyo"] }],
        metadata: {
          fake: {
            turnResponses: ["Wrong first turn.", "Tokyo"],
            finalResponse: "Tokyo",
            cmsEvents: [
              { type: "session.turn_started", metadata: { iteration: 0 } },
              { type: "session.turn_completed", metadata: { iteration: 0 } },
              { type: "session.turn_started", metadata: { iteration: 1 } },
              { type: "session.wait_completed", metadata: { iteration: 1 } },
              { type: "session.turn_completed", metadata: { iteration: 1 } },
            ],
          },
        },
      },
      config: { schemaVersion: 1, id: "turn-checks", defaults: { driver: "fake" } },
    });

    expect(result.passed).toBe(false);
    expect(result.failureMessage).toContain("response missing required phrase");
    expect(result.checks.some((check) => check.metadata?.scope === "turn" && check.metadata.turnIndex === 0)).toBe(true);
    expect(result.checks.some((check) => check.metadata?.scope === "turn" && check.metadata.turnIndex === 1 && check.pass)).toBe(true);
  });

  it("adds a run-level llm-judge check only when configured for all scenarios", async () => {
    const result = await withoutJudgeProvider(() => runScenario({
      scenario: {
        schemaVersion: 1,
        kind: "single-turn",
        id: "single.run-level-judge",
        description: "Run-level judge coverage.",
        input: { prompt: "Confirm incident validation is complete." },
        checks: [{ type: "response-contains", any: ["complete"] }],
        metadata: { fake: { finalResponse: "incident validation complete" } },
      },
      config: {
        schemaVersion: 1,
        id: "judge-all",
        defaults: { driver: "fake" },
        llmJudge: {
          enabled: true,
          applyTo: "all",
          onMissingProvider: "skip-with-warning",
        },
      },
    }));

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[1]).toMatchObject({
      pass: true,
      skipped: true,
      message: expect.stringContaining("no judge provider"),
    });
  });
});
