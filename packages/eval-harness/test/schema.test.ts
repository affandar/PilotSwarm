import { describe, expect, it } from "vitest";
import { BatchScenarioFileSchema, ScenarioSchema } from "../src/schema/scenario.js";
import { CheckSchema } from "../src/schema/check-types.js";
import { ManifestHeaderSchema, ManifestDirectiveSchema } from "../src/schema/manifest.js";
import { RunConfigSchema } from "../src/schema/config.js";

describe("schemas", () => {
  it("validates the six scenario kinds and expands batch sample shape", () => {
    expect(
      ScenarioSchema.parse({
        schemaVersion: 1,
        kind: "durable-trajectory",
        id: "wait.do-wait-do",
        description: "Durable do wait do.",
        tools: ["test_add"],
        input: { prompt: "Add, wait, multiply." },
        checks: [{ type: "tool-sequence", order: "subsequence", calls: ["test_add", "wait"] }],
      }).kind,
    ).toBe("durable-trajectory");

    expect(
      ScenarioSchema.parse({
        schemaVersion: 1,
        kind: "prompt-variant",
        id: "meta.prompt",
        description: "Prompt sweep.",
        variants: [
          { id: "baseline", promptOverrides: {} },
          { id: "brief", promptOverrides: { conductor: { inline: "Be brief." } } }
        ],
        baselineVariantId: "baseline",
        appliesTo: "../single-turn/*.scenario.json",
      }).kind,
    ).toBe("prompt-variant");

    const batch = BatchScenarioFileSchema.parse({
      schemaVersion: 1,
      kind: "single-turn",
      id: "batch.arithmetic",
      description: "Arithmetic batch.",
      tools: ["test_add"],
      samples: [
        {
          id: "add.basic",
          input: { prompt: "Add 1 and 2." },
          checks: [{ type: "response-contains", any: ["3"] }],
        },
      ],
    });
    expect(batch.samples).toHaveLength(1);
  });

  it("validates all built-in check types", () => {
    const checks = [
      { type: "tool-call", name: "test_add", args: { a: 1 }, match: "subset" },
      { type: "tool-sequence", order: "exactSequence", calls: ["test_add"] },
      { type: "forbidden-tools", tools: ["delete_agent"] },
      { type: "tool-call-count", name: "test_add", min: 1, max: 2 },
      { type: "response-contains", any: ["ok"] },
      { type: "response-not-contains", phrases: ["secret"] },
      { type: "cms-state-in", states: ["idle"] },
      { type: "cms-events-contain", events: ["session.turn_completed"] },
      { type: "cms-events-order", before: "a", after: "b" },
      { type: "cms-event-count", event: "a", min: 1 },
      { type: "no-secret-leak" },
      { type: "no-pii-leak" },
      { type: "llm-judge", rubric: "Judge quality categorically.", budgetUsd: 0.01 },
      { type: "latency-under", maxMs: 5000 },
      { type: "cost-under", maxUsd: 0.01 },
      { type: "tokens-under", maxTotal: 1000 },
      { type: "goal-completed" },
    ];

    for (const check of checks) {
      expect(CheckSchema.parse(check).type).toBe(check.type);
    }
  });

  it("validates manifest and config layers", () => {
    expect(ManifestHeaderSchema.parse({ schemaVersion: 1 }).schemaVersion).toBe(1);
    expect(ManifestDirectiveSchema.parse({ include: "scenarios/**/*.scenario.json" }).include).toBeDefined();
    expect(
      RunConfigSchema.parse({
        schemaVersion: 1,
        id: "smoke",
        scenarios: "./scenarios.jsonl",
        defaults: { driver: "fake", trials: 1, isolation: "shared-worker" },
        llmJudge: {
          enabled: true,
          applyTo: "all",
          defaultCheck: {
            rubric: "Judge every scenario in the run.",
            budgetUsd: 0.02,
          },
        },
      }).id,
    ).toBe("smoke");
  });

  it("rejects numeric llm-judge pass thresholds", () => {
    expect(() => CheckSchema.parse({
      type: "llm-judge",
      rubric: "Judge quality categorically.",
      passThreshold: 0.8,
      budgetUsd: 0.01,
    })).toThrow();
  });
});
