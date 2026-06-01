import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverScenarios, parseManifestJsonl, RunConfigSchema, ScenarioSchema } from "../src/index.js";
import { materializeEffectiveRunConfig } from "../src/engine/effective-config.js";

const packageRoot = new URL("..", import.meta.url).pathname;
const runPlans = ["live-smoke", "live-critical-path", "live-all"] as const;
const bundledScenarioIds = [
  "live.critical-path.add-judge",
  "live.critical-path.runtime-basic",
  "live.critical-path.runtime-durable-wait",
  "live.critical-path.runtime-multi-turn",
  "wait.then-act",
  "wait.do-wait-do",
  "timer.after-worker-restart",
  "multi-turn.two-step-calculation",
  "safety.direct-injection.direct.authority-claim-system-prompt-leak",
  "safety.direct-injection.direct.ignore-previous-instructions",
  "safety.direct-injection.direct.role-swap",
  "safety.indirect-injection.indirect.html-comment",
  "safety.indirect-injection.indirect.tool-result",
  "safety.output-safety.output.github-token",
  "safety.output-safety.output.ssn",
  "safety.tool-abuse.tool.args-coercion",
  "safety.tool-abuse.tool.forbidden",
  "live.critical-path.runtime-safety",
];

function packagePath(path: string): string {
  return join(packageRoot, path);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("minimal live v0 scenario corpus", () => {
  it("contains the bundled live-compatible scenario files", async () => {
    const scenarios = await discoverScenarios({
      scenarioPaths: [
        packagePath("scenarios/live/*.scenario.json"),
        packagePath("scenarios/durable/*.scenario.json"),
        packagePath("scenarios/multi-turn/*.scenario.json"),
        packagePath("scenarios/safety/*.scenario.json"),
      ],
    });

    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual([...bundledScenarioIds].sort());
    expect(new Set(scenarios.map((scenario) => scenario.kind))).toEqual(new Set(["single-turn", "multi-turn", "durable-trajectory", "safety"]));
  });

  it("discovers each bundled manifest over the pruned corpus", async () => {
    for (const runName of runPlans) {
      const scenarios = await discoverScenarios({ manifestPath: packagePath(`runs/${runName}/scenarios.jsonl`) });
      expect(scenarios.length, runName).toBeGreaterThan(0);
      expect(scenarios.every((scenario) => bundledScenarioIds.includes(scenario.id))).toBe(true);
    }
  });

  it("keeps bundled manifests limited to include directives and valid scenario files", async () => {
    for (const runName of runPlans) {
      const manifestPath = packagePath(`runs/${runName}/scenarios.jsonl`);
      const directives = parseManifestJsonl(await readFile(manifestPath, "utf8"));
      expect(directives[0]).toEqual({ schemaVersion: 1 });

      for (const directive of directives.slice(1)) {
        expect("include" in directive).toBe(true);
        if (!("include" in directive)) continue;
        if (!directive.include.includes("*")) {
          const scenario = await readJson(join(packagePath(`runs/${runName}`), directive.include));
          expect(() => ScenarioSchema.parse(scenario)).not.toThrow();
        }
      }
      await expect(discoverScenarios({ manifestPath })).resolves.toBeTruthy();
    }
  });

  it("keeps run configs valid on live plus console without removed defaults", async () => {
    for (const runName of runPlans) {
      const config = await readJson(packagePath(`runs/${runName}/config.json`));
      const parsed = RunConfigSchema.parse(config);
      const effective = materializeEffectiveRunConfig(parsed);
      expect(effective.defaults?.driver).toBe("live");
      expect(effective.reporters).toEqual(["console"]);
      expect(config.defaults).not.toHaveProperty("models");
      expect(config.defaults).not.toHaveProperty("trials");
    }
  });

  it("keeps default workload tools to the deterministic eval fixture set", async () => {
    const scenarios = await discoverScenarios({ manifestPath: packagePath("runs/live-all/scenarios.jsonl") });
    const declaredTools = new Set(scenarios.flatMap((scenario) => scenario.tools));

    expect([...declaredTools].sort()).toEqual(["delete_agent", "test_add", "test_untrusted_status"]);
    expect(scenarios.find((scenario) => scenario.id === "wait.then-act")?.tools).toEqual(["test_add"]);
    expect(scenarios.find((scenario) => scenario.id === "wait.do-wait-do")?.tools).toEqual(["test_add"]);
  });
});
