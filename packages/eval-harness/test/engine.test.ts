import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverScenarios, runManifest, runScenario } from "../src/index.js";
import { registerCheckType } from "../src/registry.js";
import { runSummary, scenarioReportEntries } from "../src/reporters/output.js";
import type { Scenario } from "../src/types.js";

registerCheckType("test-prompt-override-applied", {
  evaluate({ scenario, config }) {
    const evalCell = scenario.metadata?.evalCell;
    const variantId = evalCell && typeof evalCell === "object"
      ? (evalCell as Record<string, unknown>).variantId
      : undefined;
    const variants = config && typeof config === "object"
      ? (config as Record<string, unknown>).variants
      : undefined;
    const expected = variantId && variants && typeof variants === "object"
      ? (variants as Record<string, unknown>)[String(variantId)]
      : undefined;

    expect(scenario.promptOverrides ?? {}).toEqual(expected ?? {});
    return { pass: true, message: "prompt overrides applied" };
  },
});

function evalCellMetadata(scenario: { metadata?: Record<string, unknown> }): Record<string, unknown> {
  const evalCell = scenario.metadata?.evalCell;
  expect(evalCell).toBeTruthy();
  return evalCell as Record<string, unknown>;
}

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

describe("engine", () => {
  it("discovers scenarios from direct files and batch files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-discover-"));
    const scenarioPath = join(dir, "single.scenario.json");
    const batchPath = join(dir, "batch.scenarios.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "single.direct",
        description: "Direct scenario.",
        input: { prompt: "Say direct." },
        checks: [{ type: "response-contains", any: ["direct"] }],
      }),
    );
    await writeFile(
      batchPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "batch.math",
        description: "Batch scenario.",
        samples: [
          {
            id: "add.one",
            input: { prompt: "Add 1 and 2 with test_add." },
            checks: [{ type: "tool-call", name: "test_add" }],
          },
        ],
      }),
    );

    const scenarios = await discoverScenarios({ scenarioPaths: [scenarioPath, batchPath] });
    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual(["batch.math.add.one", "single.direct"]);
  });

  it("runs a fake scenario through checks", async () => {
    const result = await runScenario({
      scenario: {
        schemaVersion: 1,
        kind: "single-turn",
        id: "single.add",
        description: "Fake add.",
        tools: ["test_add"],
        input: { prompt: "Add 3 and 4 with test_add. Report 7." },
        checks: [
          { type: "tool-call", name: "test_add", args: { a: 3, b: 4 }, match: "subset" },
          { type: "response-contains", any: ["7"] },
        ],
      },
      config: { schemaVersion: 1, id: "test", defaults: { driver: "fake" } },
    });

    expect(result.passed).toBe(true);
    expect(result.observed.toolCalls[0]?.name).toBe("test_add");
    expect(result.observed.cmsEvents.map((event) => event.type)).toContain("tool.execution_complete");
    expect(result.observed.cmsEvents.map((event) => event.type)).not.toContain("tool.execution_completed");
  });

  it("can apply a run-level LLMJudge check to scenarios without copying checks into JSON", async () => {
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

  it("does not duplicate explicit scenario LLMJudge checks when run-level applyTo is all", async () => {
    const result = await withoutJudgeProvider(() => runScenario({
      scenario: {
        schemaVersion: 1,
        kind: "single-turn",
        id: "single.explicit-judge",
        description: "Explicit judge coverage.",
        input: { prompt: "Confirm incident validation is complete." },
        checks: [
          {
            type: "llm-judge",
            rubric: "Pass if incident validation completed.",
          },
        ],
        metadata: { fake: { finalResponse: "incident validation complete" } },
      } as never,
      config: {
        schemaVersion: 1,
        id: "judge-no-dup",
        defaults: { driver: "fake" },
        llmJudge: {
          enabled: true,
          applyTo: "all",
          onMissingProvider: "skip-with-warning",
        },
      },
    }));

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      pass: true,
      skipped: true,
      message: expect.stringContaining("no judge provider"),
    });
  });

  it("evaluates turn-local checks against the matching turn response", async () => {
    const result = await runScenario({
      scenario: {
        schemaVersion: 1,
        kind: "multi-turn",
        id: "multi.turn-local-checks",
        description: "Turn-local checks should gate each turn independently.",
        turns: [
          {
            input: { prompt: "Record checkout region Tokyo." },
            checks: [{ type: "response-contains", all: ["Tokyo recorded"] }],
          },
          {
            input: { prompt: "Recall the checkout region." },
            checks: [{ type: "response-contains", all: ["Tokyo"] }],
          },
        ],
        checks: [{ type: "response-contains", all: ["Tokyo"] }],
        metadata: {
          fake: {
            turnResponses: ["Wrong first turn.", "Tokyo"],
            finalResponse: "Tokyo",
          },
        },
      } as never,
      config: { schemaVersion: 1, id: "turn-checks", defaults: { driver: "fake" } },
    });

    expect(result.passed).toBe(false);
    expect(result.failureMessage).toContain("response missing required phrase");
    expect(result.checks.some((check) => check.metadata?.scope === "turn" && check.metadata.turnIndex === 0)).toBe(true);
  });

  it("isolates turn-local CMS checks by SDK iteration metadata", async () => {
    const result = await runScenario({
      scenario: {
        schemaVersion: 1,
        kind: "multi-turn",
        id: "multi.turn-local-cms-checks",
        description: "Turn-local CMS checks should not use events from other turns.",
        turns: [
          {
            input: { prompt: "First turn." },
            checks: [{ type: "cms-events-contain", events: ["session.wait_completed"] }],
          },
          {
            input: { prompt: "Second turn." },
            checks: [],
          },
        ],
        checks: [{ type: "response-contains", all: ["done"] }],
        metadata: {
          fake: {
            turnResponses: ["first", "done"],
            finalResponse: "done",
            cmsEvents: [
              { type: "session.turn_started", metadata: { iteration: 0 } },
              { type: "session.turn_completed", metadata: { iteration: 0 } },
              { type: "session.turn_started", metadata: { iteration: 1 } },
              { type: "session.wait_completed", metadata: { iteration: 1 } },
              { type: "session.turn_completed", metadata: { iteration: 1 } },
            ],
          },
        },
      } as never,
      config: { schemaVersion: 1, id: "turn-cms-checks", defaults: { driver: "fake" } },
    });

    expect(result.passed).toBe(false);
    expect(result.failureMessage).toContain("missing cms events: session.wait_completed");
  });

  it("fails clearly when a live-required scenario is run with the fake driver by default", async () => {
    const result = await runScenario({
      scenario: {
        schemaVersion: 1,
        kind: "single-turn",
        id: "single.live-required-fake",
        description: "Live-required scenario.",
        requirements: { live: true },
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      } as never,
      config: { schemaVersion: 1, id: "live-required", defaults: { driver: "fake" } },
    });

    expect(result.passed).toBe(false);
    expect(result.infraError).toBe(false);
    expect(result.failureMessage).toMatch(/requires live/i);
    expect(result.observed.terminalState).toBe("unsupported");
  });

  it("skips live-required scenarios on unsupported fake drivers when configured", async () => {
    const result = await runScenario({
      scenario: {
        schemaVersion: 1,
        kind: "single-turn",
        id: "single.live-required-skip",
        description: "Live-required scenario with skip policy.",
        requirements: { live: true },
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      } as never,
      config: {
        schemaVersion: 1,
        id: "live-required-skip",
        defaults: { driver: "fake" },
        requirements: { onUnsupported: "skip" },
      } as never,
    });

    expect(result.passed).toBe(false);
    expect(result.infraError).toBe(false);
    expect(result.checks).toEqual([]);
    expect(result.observed.terminalState).toBe("skipped");
  });

  it("counts unsupported configured skips without marking them failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-skip-aggregate-"));
    const scenarioPath = join(dir, "live-required.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "single.live-required-aggregate-skip",
        description: "Live-required scenario that should be skipped by policy.",
        requirements: { live: true },
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      }),
    );
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1 })}\n${JSON.stringify({ include: "live-required.scenario.json" })}\n`);
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "skip-aggregate",
        scenarios: "./scenarios.jsonl",
        defaults: { driver: "fake" },
        requirements: { onUnsupported: "skip" },
        reporters: [],
      }),
    );

    const result = await runManifest({ configPath });

    expect(result).toMatchObject({ skipped: 1, failed: 0, passed: 0, infraErrors: 0 });
    expect(result.scenarios[0]?.observed.terminalState).toBe("skipped");
    expect(scenarioReportEntries(result)[0]?.status).toBe("SKIP");
    expect((runSummary(result).scenarios as Array<{ status: string }>)[0]?.status).toBe("SKIP");
  });

  it("runs a manifest config and summarizes results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-manifest-"));
    const scenarioPath = join(dir, "single.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "single.hello",
        description: "Hello.",
        input: { prompt: "Say hello." },
        checks: [{ type: "response-contains", any: ["hello"] }],
      }),
    );
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1 })}\n${JSON.stringify({ include: "single.scenario.json" })}\n`);
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "smoke",
        scenarios: "./scenarios.jsonl",
        defaults: { driver: "fake", trials: 1 },
      }),
    );

    const result = await runManifest({ configPath });
    expect(result.runId).toBe("smoke");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.configuration.effectiveRunConfig.reporters).toEqual(["console"]);
  });

  it("attaches deterministic trajectory summary notes when post-run summaries are enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-post-run-"));
    const scenarioPath = join(dir, "trajectory.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "durable-trajectory",
        id: "postrun.trajectory",
        description: "Post-run trajectory analysis.",
        input: { prompt: "Say complete." },
        checks: [{ type: "response-contains", any: ["complete"] }],
        postRun: {
          trajectorySummary: {
            rubric: "Verify durable evidence was preserved.",
          },
        },
        metadata: {
          fake: {
            finalResponse: "complete",
            cmsEvents: [{ type: "session.turn_started" }, { type: "session.turn_completed" }],
          },
        },
      }),
    );
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1 })}\n${JSON.stringify({ include: "trajectory.scenario.json" })}\n`);
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "postrun",
        scenarios: "./scenarios.jsonl",
        defaults: { driver: "fake" },
        postRun: { trajectorySummaryEnabled: true },
        reporters: [],
      }),
    );

    const result = await runManifest({ configPath });

    expect(result.scenarios[0]?.trajectoryNotes).toContain("Verify durable evidence was preserved.");
    expect(result.scenarios[0]?.metadata?.postRun).toMatchObject({
      trajectorySummary: {
        provider: "deterministic",
        eventCount: 2,
      },
    });
    expect(result.budget.trajectorySummaryCostUsd).toBe(0);
  });

  it("expands ablation model axes into configured execution cells", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-ablation-"));
    const basePath = join(dir, "base.scenario.json");
    const ablationPath = join(dir, "model-sweep.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(
      basePath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "base.model-sweep",
        description: "Base model sweep.",
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      }),
    );
    await writeFile(
      ablationPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "ablation",
        id: "meta.model-sweep",
        description: "Sweep the base scenario across models.",
        baseScenario: "./base.scenario.json",
        axes: { model: ["github-copilot:gpt-5.4", "github-copilot:gpt-5.5"] },
        checks: [],
      }),
    );
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1 })}\n${JSON.stringify({ include: "model-sweep.scenario.json" })}\n`);
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "ablation-models",
        scenarios: "./scenarios.jsonl",
        defaults: { driver: "fake" },
        reporters: [],
      }),
    );

    const result = await runManifest({ configPath });
    expect(result.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "meta.model-sweep::model=github-copilot_gpt-5.4::trial=1",
      "meta.model-sweep::model=github-copilot_gpt-5.5::trial=1",
    ]);
    expect(result.scenarios.map((scenario) => scenario.metadata?.model)).toEqual([
      "github-copilot:gpt-5.4",
      "github-copilot:gpt-5.5",
    ]);
    expect(result).toMatchObject({ passed: 2, failed: 0, infraErrors: 0 });
  });

  it("expands prompt variants into executable cells with prompt overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-prompt-variant-"));
    const basePath = join(dir, "base.scenario.json");
    const promptVariantPath = join(dir, "prompt-variant.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    const concisePromptOverrides: NonNullable<Scenario["promptOverrides"]> = {
      "incident-conductor": { inline: "Triage incidents. Be concise and cite actions." },
    };
    await writeFile(
      basePath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "base.incident",
        description: "Base incident scenario.",
        input: { prompt: "Say ok." },
        checks: [
          { type: "response-contains", any: ["ok"] },
          {
            type: "test-prompt-override-applied",
            variants: {
              baseline: {},
              concise: concisePromptOverrides,
            },
          },
        ],
      }),
    );
    await writeFile(
      promptVariantPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "prompt-variant",
        id: "meta.prompt-variant",
        description: "Expand incident prompt variants.",
        appliesTo: "base.scenario.json",
        variants: [
          { id: "baseline", promptOverrides: {} },
          { id: "concise", promptOverrides: concisePromptOverrides },
        ],
        baselineVariantId: "baseline",
        runs: { maxCells: 2 },
        requirements: { isolation: "fresh-worker" },
      }),
    );
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1 })}\n${JSON.stringify({ include: "prompt-variant.scenario.json" })}\n`);
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "prompt-variant-expansion",
        scenarios: "./scenarios.jsonl",
        defaults: { driver: "fake" },
        reporters: [],
      }),
    );

    const result = await runManifest({ configPath });

    expect(result.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "meta.prompt-variant::scenario=base.incident::variant=baseline::trial=1",
      "meta.prompt-variant::scenario=base.incident::variant=concise::trial=1",
    ]);
    expect(result).toMatchObject({ passed: 2, failed: 0, infraErrors: 0 });
    expect(result.scenarios.map((scenario) => scenario.metadata)).toEqual([
      expect.objectContaining({
        metaScenarioId: "meta.prompt-variant",
        baseScenarioId: "base.incident",
        variantId: "baseline",
        baselineVariantId: "baseline",
        trial: 1,
        evalCell: expect.objectContaining({
          metaScenarioId: "meta.prompt-variant",
          baseScenarioId: "base.incident",
          variantId: "baseline",
          baselineVariantId: "baseline",
          trial: 1,
        }),
      }),
      expect.objectContaining({
        metaScenarioId: "meta.prompt-variant",
        baseScenarioId: "base.incident",
        variantId: "concise",
        baselineVariantId: "baseline",
        trial: 1,
        evalCell: expect.objectContaining({
          metaScenarioId: "meta.prompt-variant",
          baseScenarioId: "base.incident",
          variantId: "concise",
          baselineVariantId: "baseline",
          trial: 1,
        }),
      }),
    ]);
    expect(evalCellMetadata(result.scenarios[0]!).variantId).toBe("baseline");
    expect(evalCellMetadata(result.scenarios[1]!).variantId).toBe("concise");
  });

  it("expands prompt variants across declared models", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-prompt-variant-models-"));
    const basePath = join(dir, "base.scenario.json");
    const promptVariantPath = join(dir, "prompt-variant.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(
      basePath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "base.incident",
        description: "Base incident scenario.",
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      }),
    );
    await writeFile(
      promptVariantPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "prompt-variant",
        id: "meta.prompt-variant",
        description: "Expand incident prompt variants by model.",
        appliesTo: "base.scenario.json",
        models: ["github-copilot:gpt-5.4", "github-copilot:gpt-5.5"],
        variants: [
          { id: "baseline", promptOverrides: {} },
          { id: "concise", promptOverrides: { "incident-conductor": { inline: "Be concise." } } },
        ],
        runs: { maxCells: 4 },
      }),
    );
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1 })}\n${JSON.stringify({ include: "prompt-variant.scenario.json" })}\n`);
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "prompt-variant-model-expansion",
        scenarios: "./scenarios.jsonl",
        defaults: { driver: "fake" },
        reporters: [],
      }),
    );

    const result = await runManifest({ configPath });

    expect(result.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "meta.prompt-variant::scenario=base.incident::variant=baseline::model=github-copilot_gpt-5.4::trial=1",
      "meta.prompt-variant::scenario=base.incident::variant=baseline::model=github-copilot_gpt-5.5::trial=1",
      "meta.prompt-variant::scenario=base.incident::variant=concise::model=github-copilot_gpt-5.4::trial=1",
      "meta.prompt-variant::scenario=base.incident::variant=concise::model=github-copilot_gpt-5.5::trial=1",
    ]);
    expect(result.scenarios.map((scenario) => scenario.metadata?.model)).toEqual([
      "github-copilot:gpt-5.4",
      "github-copilot:gpt-5.5",
      "github-copilot:gpt-5.4",
      "github-copilot:gpt-5.5",
    ]);
    expect(result.scenarios.map((scenario) => evalCellMetadata(scenario).model)).toEqual([
      "github-copilot:gpt-5.4",
      "github-copilot:gpt-5.5",
      "github-copilot:gpt-5.4",
      "github-copilot:gpt-5.5",
    ]);
  });

  it("counts prompt variant model cells against maxCells", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-prompt-variant-model-max-cells-"));
    const basePath = join(dir, "base.scenario.json");
    const promptVariantPath = join(dir, "prompt-variant.scenario.json");
    const manifestPath = join(dir, "scenarios.jsonl");
    const configPath = join(dir, "config.json");
    await writeFile(
      basePath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "single-turn",
        id: "base.incident",
        description: "Base incident scenario.",
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      }),
    );
    await writeFile(
      promptVariantPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "prompt-variant",
        id: "meta.prompt-variant",
        description: "Expand incident prompt variants by model.",
        appliesTo: "base.scenario.json",
        models: ["github-copilot:gpt-5.4", "github-copilot:gpt-5.5"],
        variants: [
          { id: "baseline", promptOverrides: {} },
          { id: "concise", promptOverrides: { "incident-conductor": { inline: "Be concise." } } },
        ],
        runs: { maxCells: 3 },
      }),
    );
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1 })}\n${JSON.stringify({ include: "prompt-variant.scenario.json" })}\n`);
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "prompt-variant-model-max-cells",
        scenarios: "./scenarios.jsonl",
        defaults: { driver: "fake" },
        reporters: [],
      }),
    );

    await expect(runManifest({ configPath })).rejects.toThrow(
      "Scenario meta.prompt-variant: prompt variants expand to 4 cells, exceeding maxCells=3.",
    );
  });
});
