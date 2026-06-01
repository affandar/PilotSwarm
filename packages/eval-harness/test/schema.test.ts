import { describe, expect, it } from "vitest";
import { CheckSchema, parseManifestJsonl, RunConfigSchema, ScenarioSchema, semanticValidateScenario } from "../src/index.js";

describe("v0 schemas", () => {
  it("accepts the kept v0 run config and scenario shapes", () => {
    expect(RunConfigSchema.parse({
      schemaVersion: 1,
      id: "live-smoke",
      scenarios: "./scenarios.jsonl",
      defaults: {
        driver: "live",
        isolation: "fresh-worker",
        concurrent: 1,
        timeoutMs: 180000,
      },
      reporters: ["console"],
      output: { reportsDir: ".eval-results/live-smoke" },
    })).toMatchObject({
      id: "live-smoke",
      defaults: { driver: "live", isolation: "fresh-worker" },
      reporters: ["console"],
    });

    expect(ScenarioSchema.parse({
      schemaVersion: 1,
      kind: "single-turn",
      id: "single.kept",
      description: "Kept single-turn scenario.",
      input: { prompt: "Say ok." },
      tools: ["test_add"],
      checks: [{ type: "tool-call", name: "test_add", args: { a: 1, b: 2 } }],
    }).kind).toBe("single-turn");

    expect(ScenarioSchema.parse({
      schemaVersion: 1,
      kind: "multi-turn",
      id: "multi.kept",
      description: "Kept multi-turn scenario.",
      turns: [{ input: { prompt: "Remember ok." }, checks: [] }],
      checks: [],
    }).kind).toBe("multi-turn");

    expect(ScenarioSchema.parse({
      schemaVersion: 1,
      kind: "durable-trajectory",
      id: "durable.kept",
      description: "Kept durable scenario.",
      input: { prompt: "Wait, then say ok." },
      chaos: { injectAt: "during-wait", type: "worker-restart", onTargetMissing: "best-effort" },
      checks: [],
    }).kind).toBe("durable-trajectory");

    expect(ScenarioSchema.parse({
      schemaVersion: 1,
      kind: "safety",
      id: "safety.kept",
      description: "Kept safety scenario.",
      input: { prompt: "Do not leak secrets." },
      checks: [{ type: "no-secret-leak" }],
    }).kind).toBe("safety");
  });

  it("rejects removed run config knobs and scenario kinds", () => {
    expect(() => RunConfigSchema.parse({
      schemaVersion: 1,
      id: "removed-models",
      defaults: { driver: "live", models: ["gpt-5.4"] },
    })).toThrow(/models/);

    expect(() => RunConfigSchema.parse({
      schemaVersion: 1,
      id: "removed-trials",
      defaults: { driver: "live", trials: 2 },
    })).toThrow(/trials/);

    expect(() => RunConfigSchema.parse({
      schemaVersion: 1,
      id: "removed-max-cells",
      runs: { maxCells: 2 },
    })).toThrow(/runs/);

    expect(() => RunConfigSchema.parse({
      schemaVersion: 1,
      id: "removed-requirements",
      requirements: { onUnsupported: "skip" },
    })).toThrow(/requirements/);

    for (const kind of ["prompt-variant", "ablation", "batch"]) {
      expect(() => ScenarioSchema.parse({
        schemaVersion: 1,
        kind,
        id: `removed.${kind}`,
        description: "Removed scenario kind.",
        input: { prompt: "Noop." },
        checks: [],
      })).toThrow(/Invalid discriminator value/);
    }

    expect(() => ScenarioSchema.parse({
      schemaVersion: 1,
      kind: "single-turn",
      id: "removed.samples",
      description: "Batch samples are removed.",
      input: { prompt: "Noop." },
      samples: [{ id: "one", input: { prompt: "Noop." } }],
      checks: [],
    })).toThrow(/samples/);

    expect(() => ScenarioSchema.parse({
      schemaVersion: 1,
      kind: "single-turn",
      id: "removed.live-requirement",
      description: "Live requirement flag is removed.",
      input: { prompt: "Noop." },
      requirements: { live: true },
      checks: [],
    })).toThrow(/live/);
  });

  it("validates deterministic checks and rejects removed modifiers", () => {
    const checks = [
      { type: "tool-call", name: "test_add", args: { a: 1 }, match: "subset" },
      { type: "tool-sequence", order: "exactSequence", calls: ["wait", "test_add"] },
      { type: "forbidden-tools", tools: ["dangerous_tool"] },
      { type: "tool-call-count", min: 1, max: 2 },
      { type: "response-contains", all: ["ok"] },
      { type: "response-not-contains", phrases: ["secret"] },
      { type: "cms-state-in", states: ["completed"] },
      { type: "cms-events-contain", events: ["session.turn_completed"] },
      { type: "cms-events-order", before: "session.wait_started", after: "session.wait_completed" },
      { type: "cms-event-count", event: "session.hydrated", min: 1 },
      { type: "no-secret-leak" },
      { type: "no-pii-leak" },
      { type: "llm-judge", rubric: "Judge the evidence." },
      { type: "latency-under", maxMs: 1000 },
    ];

    expect(checks.map((check) => CheckSchema.parse(check).type)).toHaveLength(checks.length);
    expect(() => CheckSchema.parse({ type: "response-contains", any: ["ok"], fuzzy: true })).toThrow(/fuzzy/);
    expect(() => CheckSchema.parse({ type: "response-contains" })).toThrow(/response-contains requires/);
    expect(() => CheckSchema.parse({ type: "response-contains", any: [""] })).toThrow();
    expect(() => CheckSchema.parse({ type: "tool-call-count" })).toThrow(/tool-call-count requires/);
    expect(() => CheckSchema.parse({ type: "cms-event-count", event: "session.turn_completed" })).toThrow(/cms-event-count requires/);
    expect(() => CheckSchema.parse({ type: "latency-under", maxMs: 1000, percentile: "p95" })).toThrow(/percentile/);
    expect(() => CheckSchema.parse({ type: "cost-under", maxUsd: 1 })).toThrow();
    expect(() => CheckSchema.parse({ type: "tokens-under", maxTotal: 1000 })).toThrow();
  });

  it("parses v0 manifest directives and enforces tag-only overrides", () => {
    expect(parseManifestJsonl([
      '{"schemaVersion":1}',
      '{"include":"scenarios/**/*.scenario.json"}',
      '{"path":"one.scenario.json","overrides":{"tags":["smoke"]}}',
      '{"exclude":"scenarios/experimental/**"}',
      '{"include-manifest":"nested.jsonl"}',
    ].join("\n"))).toHaveLength(5);

    expect(() => parseManifestJsonl('{"schemaVersion":1}\n{"path":"one.scenario.json","overrides":{"driver":"fake"}}'))
      .toThrow(/overrides may only set tags/);
  });

  it("keeps semantic guards for v0 chaos constraints", () => {
    const scenario = ScenarioSchema.parse({
      schemaVersion: 1,
      kind: "single-turn",
      id: "chaos.invalid",
      description: "Chaos on non-durable scenarios is invalid.",
      input: { prompt: "Noop." },
      chaos: { injectAt: "during-wait", type: "worker-restart" },
      checks: [],
    });

    expect(semanticValidateScenario(scenario)).toContain("Scenario chaos.invalid: chaos block is only valid for durable-trajectory in v1.");
  });
});
