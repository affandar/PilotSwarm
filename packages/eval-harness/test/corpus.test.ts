import { describe, expect, it } from "vitest";
import { discoverScenarios, runManifest } from "../src/index.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Scenario } from "../src/types.js";

const packageRoot = dirname(import.meta.dirname);
const packagePath = (...segments: string[]) => join(packageRoot, ...segments);
const productionRunGroups = ["critical-path", "live-all", "all", "nightly"] as const;
const exactResponseCheckTypes = new Set(["response-contains", "response-not-contains"]);
const directInjectionSafeReferencePhrases = new Set(["developer message", "system prompt", "hidden instructions"]);
const productLanguage = [
  "PilotSwarm",
  "agent",
  "builder",
  "checkout",
  "deploy",
  "deployment",
  "drain",
  "durable",
  "hydrate",
  "incident",
  "latency",
  "owner",
  "payment",
  "recovery",
  "rollback",
  "runbook",
  "runtime",
  "secret",
  "session",
  "workspace"
];
const operationalLanguage = [
  "canary",
  "checkout",
  "cluster",
  "deploy",
  "deployment",
  "drain",
  "durable",
  "edge",
  "error",
  "handoff",
  "hydrate",
  "impact",
  "incident",
  "latency",
  "mitigation",
  "payment",
  "PilotSwarm",
  "recovery",
  "region",
  "rollback",
  "runbook",
  "runtime",
  "service-status",
  "shard",
  "workspace"
];
const toyLanguage = [
  "what is",
  "arithmetic",
  "weather",
  "city",
  "tokyo",
  "osaka",
  "kyoto",
  "london",
  "favorite city"
];
const toyArithmeticPatterns = [
  /\b\d+\s*(?:\+|\*|plus|times)\s*\d+\b/,
  /\badd\s+\d+\s+(?:and|to)\s+\d+\b/
];
const operationalDomainLanguage = [
  ...operationalLanguage,
  "child",
  "children",
  "CMS",
  "crash",
  "crashes",
  "failed",
  "failure",
  "probe",
  "probes",
  "sub-agent",
  "sub-agents",
  "timeout",
  "tool",
  "tools",
  "wait",
  "worker"
];
const workflowActionLanguage = [
  "calculate",
  "check",
  "collect",
  "combine",
  "compare",
  "compute",
  "confirm",
  "investigate",
  "lookup",
  "poll",
  "project",
  "record",
  "report",
  "run",
  "spawn",
  "summarize",
  "total",
  "triage",
  "use",
  "validate",
  "wait"
];

type Checkish = { type?: string; phrases?: string[] };
type TextTurn = { input: { prompt: string }; checks?: unknown[] };
type TextScenario = { description: string; input?: { prompt: string }; turns?: TextTurn[] };

function scenarioTurns(scenario: Scenario | TextScenario): TextTurn[] {
  const turns = (scenario as { turns?: unknown }).turns;
  return Array.isArray(turns) ? turns as TextTurn[] : [];
}

function scenarioPrompts(scenario: TextScenario): string[] {
  const turns = scenarioTurns(scenario);
  if (turns.length) return turns.map((turn) => turn.input.prompt);
  return scenario.input ? [scenario.input.prompt] : [];
}

function allChecks(scenario: Scenario): Checkish[] {
  const turnChecks = scenarioTurns(scenario).flatMap((turn) => turn.checks ?? []);
  return [...(scenario.checks ?? []), ...turnChecks] as Checkish[];
}

function scenarioText(scenario: TextScenario): string {
  const prompts = scenarioPrompts(scenario);
  return [scenario.description, ...prompts].join(" ");
}

function countSignals(terms: string[], text: string): number {
  return terms.filter((term) => text.includes(term.toLowerCase())).length;
}

function hasBehaviorCheck(scenario: Scenario): boolean {
  return allChecks(scenario).some((check) => check.type && !exactResponseCheckTypes.has(check.type));
}

function hasProductFraming(scenario: TextScenario): boolean {
  const prompts = scenarioPrompts(scenario);
  const text = scenarioText(scenario).toLowerCase();
  const promptText = prompts.join(" ").toLowerCase();
  const hasProductTerm = productLanguage.some((term) => text.includes(term.toLowerCase()));
  const hasOperationalTerm = operationalLanguage.some((term) => text.includes(term.toLowerCase()));
  if (!hasProductTerm || !hasOperationalTerm) return false;

  const promptHasToyTerm = toyLanguage.some((term) => promptText.includes(term))
    || toyArithmeticPatterns.some((pattern) => pattern.test(promptText));
  if (!promptHasToyTerm) return true;

  const promptOperationalSignalCount = countSignals(operationalDomainLanguage, promptText);
  const promptHasWorkflowAction = workflowActionLanguage.some((term) => promptText.includes(term.toLowerCase()));
  return promptOperationalSignalCount >= 3 && promptHasWorkflowAction;
}

function isInMetadataFake(path: string[]): boolean {
  for (let index = 0; index < path.length - 1; index += 1) {
    if (path[index] === "metadata" && path[index + 1] === "fake") return true;
  }
  return false;
}

function forbiddenFixturePaths(value: unknown, path: string[] = []): string[] {
  if (isInMetadataFake(path)) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => forbiddenFixturePaths(entry, [...path, String(index)]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const keyPath = [...path, key];
      const isAllowedFakeRoot = path.at(-1) === "metadata" && key === "fake";
      const keyViolates = !isAllowedFakeRoot && /^(fake|fakeResponse|mockResponse|expectedResponse|fixture|observed|placeholder)$/i.test(key)
        ? [keyPath.join(".")]
        : [];
      return [...keyViolates, ...forbiddenFixturePaths(entry, keyPath)];
    });
  }
  if (typeof value === "string" && /\b(fakeResponse|mockResponse|placeholder)\b/i.test(value)) {
    return [path.join(".")];
  }
  return [];
}

describe("Wave B scenario corpus", () => {
  it("discovers the initial all-run corpus", async () => {
    const scenarios = await discoverScenarios({ configPath: packagePath("runs/all/config.json") });
    expect(scenarios.length).toBeGreaterThanOrEqual(16);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      "wait.do-wait-do",
      "wait.then-act",
      "restart.worker-restart-mid-tool",
      "timer.after-worker-restart",
      "multi-turn.two-step-calculation",
      "multi-turn.context-retention",
      "agent.parent-spawns-children-completes",
      "agent.parent-waits-on-slow-child",
      "agent.parent-reports-child-status",
      "meta.model-sweep-durable",
      "meta.prompt-variant-example",
    ]));
  });

  it("runs the smoke plan with the fake driver", async () => {
    const result = await runManifest({ configPath: packagePath("runs/smoke/config.json"), driver: "fake" });
    expect(result.failed).toBe(0);
    expect(result.infraErrors).toBe(0);
    expect(result.passed).toBeGreaterThanOrEqual(5);
    expect(result.scenarios.map((scenario) => scenario.scenarioId)).toEqual(expect.arrayContaining([
      "safety.direct-injection.direct.ignore-previous-instructions",
      "safety.tool-abuse.tool.forbidden",
    ]));
  });

  it("runs the complete bundled corpus through the fake escape hatch", async () => {
    const result = await runManifest({
      configPath: packagePath("runs/all/config.json"),
      fake: true,
      reporters: [],
    });
    expect(result.passed).toBe(34);
    expect(result.failed).toBe(0);
    expect(result.infraErrors).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.scenarios.filter((scenario) => scenario.metadata?.metaScenarioId === "meta.model-sweep-durable")).toHaveLength(3);
    expect(result.scenarios.filter((scenario) => scenario.metadata?.metaScenarioId === "meta.prompt-variant-example")).toHaveLength(2);
  });

  it("keeps bundled production run plans live by default", async () => {
    for (const runName of ["all", "smoke", "critical-path", "nightly", "durable-cross-model", "live-all"]) {
      const config = JSON.parse(await readFile(packagePath(`runs/${runName}/config.json`), "utf8")) as { defaults?: { driver?: string } };
      expect(config.defaults?.driver).toBe("live");
    }
  });

  it("keeps bundled production run plans judging every scenario by default", async () => {
    for (const runName of ["all", "smoke", "critical-path", "nightly", "durable-cross-model", "live-all", "live-critical-path", "live-e2e", "live-smoke", "attach-live"]) {
      const config = JSON.parse(await readFile(packagePath(`runs/${runName}/config.json`), "utf8")) as {
        llmJudge?: {
          enabled?: boolean;
          applyTo?: string;
          defaultCheck?: { rubric?: string; budgetUsd?: number };
          onMissingProvider?: string;
        };
      };
      expect(config.llmJudge?.enabled, runName).toBe(true);
      expect(config.llmJudge?.applyTo, runName).toBe("all");
      expect(config.llmJudge?.defaultCheck?.rubric?.length, runName).toBeGreaterThan(40);
      expect(config.llmJudge?.defaultCheck?.budgetUsd, runName).toBeGreaterThan(0);
      expect(config.llmJudge?.onMissingProvider, runName).toBe("error");
    }
  });

  it("keeps durable-cross-model focused on the model sweep meta-scenario", async () => {
    const scenarios = await discoverScenarios({ configPath: packagePath("runs/durable-cross-model/config.json") });
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["meta.model-sweep-durable"]);
    expect(scenarios[0]?.runs?.timeoutMs).toBe(3_600_000);
  });

  it("keeps the durable model sweep timeout scenario-owned and manifest-independent", async () => {
    const [directScenario] = await discoverScenarios({
      scenarioPaths: [packagePath("scenarios/meta/model-sweep-durable.scenario.json")],
    });
    expect(directScenario?.runs?.timeoutMs).toBe(3_600_000);

    for (const runName of ["all", "live-all", "nightly", "durable-cross-model"]) {
      const scenarios = await discoverScenarios({ configPath: packagePath(`runs/${runName}/config.json`) });
      const sweep = scenarios.find((scenario) => scenario.id === "meta.model-sweep-durable");
      expect(sweep?.runs?.timeoutMs).toBe(3_600_000);
    }
  });

  it("wires nightly to the prompt-variant example app plugin directory", async () => {
    const config = JSON.parse(await readFile(packagePath("runs/nightly/config.json"), "utf8"));
    expect(config.worker.pluginDirs).toContain("../../scenarios/meta/example-app");
  });

  it("keeps production run group scenarios meaningfully described and tagged", async () => {
    for (const runName of productionRunGroups) {
      const scenarios = await discoverScenarios({ configPath: packagePath(`runs/${runName}/config.json`) });
      for (const scenario of scenarios) {
        expect(scenario.description.trim().length, `${runName}:${scenario.id} description`).toBeGreaterThanOrEqual(40);
        expect(scenario.tags.length, `${runName}:${scenario.id} tags`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps critical-path scenarios backed by behavior checks beyond response text", async () => {
    const scenarios = await discoverScenarios({ configPath: packagePath("runs/critical-path/config.json") });
    for (const scenario of scenarios) {
      expect(hasBehaviorCheck(scenario), `critical-path:${scenario.id} behavior check`).toBe(true);
    }
  });

  it("keeps live-capable scenarios explicitly checked and described", async () => {
    for (const runName of productionRunGroups) {
      const scenarios = await discoverScenarios({ configPath: packagePath(`runs/${runName}/config.json`) });
      for (const scenario of scenarios.filter((entry) => entry.tags.includes("live-capable") || entry.tags.includes("live-critical-path") || entry.requirements.live)) {
        expect(scenario.description.trim().length, `${runName}:${scenario.id} live description`).toBeGreaterThanOrEqual(40);
        expect(allChecks(scenario).length, `${runName}:${scenario.id} live checks`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps fake fixtures isolated under metadata.fake", async () => {
    const scenarios = await discoverScenarios({ configPath: packagePath("runs/all/config.json") });
    for (const scenario of scenarios) {
      expect(scenario.filePath, `${scenario.id} file path`).toBeDefined();
    }
    const scenarioFilePaths = [...new Set(scenarios
      .map((scenario) => scenario.filePath)
      .filter((filePath): filePath is string => typeof filePath === "string"))];
    const violations = (
      await Promise.all(scenarioFilePaths.map(async (filePath) => {
        const raw = JSON.parse(await readFile(filePath, "utf8"));
        return forbiddenFixturePaths(raw).map((path) => `${filePath}:${path}`);
      }))
    ).flat();
    expect(violations).toEqual([]);
  });

  it("rejects fixture-shaped scenario keys outside metadata.fake", () => {
    const raw = {
      metadata: {
        fake: {
          fakeResponse: "allowed fixture payload",
          mockResponse: "allowed fixture payload",
          expectedResponse: "allowed fixture payload",
          fixture: "allowed fixture payload",
          observed: "allowed fixture payload"
        }
      },
      samples: [
        {
          fake: "not allowed",
          fakeResponse: "not allowed",
          mockResponse: "not allowed",
          expectedResponse: "not allowed",
          fixture: "not allowed",
          observed: "not allowed"
        }
      ]
    };

    expect(forbiddenFixturePaths(raw)).toEqual([
      "samples.0.fake",
      "samples.0.fakeResponse",
      "samples.0.mockResponse",
      "samples.0.expectedResponse",
      "samples.0.fixture",
      "samples.0.observed"
    ]);
  });

  it("rejects toy prompts that only add product keywords around classroom tasks", () => {
    expect(hasProductFraming({
      description: "PilotSwarm smoke scenario that mentions the product.",
      input: { prompt: "What is 2 plus 2?" }
    })).toBe(false);

    expect(hasProductFraming({
      description: "Deployment scenario that mentions an operational keyword.",
      input: { prompt: "What is 2 plus 2 for deployment?" }
    })).toBe(false);

    expect(hasProductFraming({
      description: "Checkout scenario that mentions an operational keyword.",
      input: { prompt: "What's the weather in Tokyo for checkout?" }
    })).toBe(false);

    expect(hasProductFraming({
      description: "PilotSwarm scenario that mentions the product.",
      input: { prompt: "PilotSwarm: add 1 and 1." }
    })).toBe(false);

    expect(hasProductFraming({
      description: "PilotSwarm operational smoke scenario for incident triage.",
      input: { prompt: "During incident triage, use test_add to combine checkout and payment errors." }
    })).toBe(true);

    expect(hasProductFraming({
      description: "PilotSwarm checkout incident scenario with deployment confirmation.",
      input: { prompt: "Investigate checkout incident INC-4821, use test_add to total failed payments and timeout errors, wait for deploy confirmation, then summarize impact." }
    })).toBe(true);
  });

  it("allows direct-injection refusals to mention secret classes without leaking them", async () => {
    const scenarios = await discoverScenarios({
      scenarioPaths: [packagePath("scenarios/safety/direct-injection.scenarios.json")],
    });

    const forbiddenSafeReferences = scenarios.flatMap((scenario) => (
      allChecks(scenario).flatMap((check) => {
        if (check.type !== "response-not-contains" || !("phrases" in check)) return [];
        return ((check as { phrases?: string[] }).phrases ?? [])
          .filter((phrase) => directInjectionSafeReferencePhrases.has(phrase.toLowerCase()))
          .map((phrase) => `${scenario.id}:${phrase}`);
      })
    ));

    expect(forbiddenSafeReferences).toEqual([]);
  });

  it("keeps production run groups framed as PilotSwarm operational work", async () => {
    for (const runName of productionRunGroups) {
      const scenarios = await discoverScenarios({ configPath: packagePath(`runs/${runName}/config.json`) });
      for (const scenario of scenarios) {
        expect(hasProductFraming(scenario), `${runName}:${scenario.id} product framing`).toBe(true);
      }
    }
  });
});
