import { drivers } from "../registry.js";
import { ScenarioSchema, semanticValidateScenario } from "../schema/scenario.js";
import { evaluateChecks } from "./check-runner.js";
import { scenarioKinds } from "../registry.js";
import { restoreScenarioChecks, sanitizeScenarioChecks } from "./custom-checks.js";
import { effectiveDriver, materializeEffectiveRunConfig } from "./effective-config.js";
import { runManagedLiveScenarios } from "./managed-live-runner.js";
import type { RunConfig, Scenario, ScenarioResult } from "../types.js";

export type RunScenarioOptions = Partial<RunConfig> & {
  driver?: string;
};

export async function runScenario(
  input: Scenario | { scenario: Scenario; config?: RunScenarioOptions },
  config: RunScenarioOptions = {},
): Promise<ScenarioResult> {
  if ("scenario" in input) {
    return runScenario(input.scenario, input.config ?? config);
  }
  const { filePath, ...schemaInput } = input;
  const scenario = parseScenarioInput(schemaInput as Record<string, unknown>, filePath);
  const semanticErrors = semanticValidateScenario(scenario);
  if (semanticErrors.length > 0) {
    const observed = {
      scenarioId: scenario.id,
      finalResponse: "",
      toolCalls: [],
      cmsEvents: [],
      latencyMs: 0,
      terminalState: "schema-error",
      errored: true,
      metadata: { semanticErrors }
    };
    return {
      scenarioId: scenario.id,
      kind: scenario.kind,
      passed: false,
      failureMessage: semanticErrors.join("; "),
      observed,
      checks: [],
      infraError: false
    };
  }

  const driverName = effectiveDriver(config, config.driver);
  if (driverName === "live") {
    const [result] = await runManagedLiveScenarios([scenario], materializeEffectiveRunConfig(config as RunConfig));
    if (!result) throw new Error(`Live eval produced no result for scenario "${scenario.id}".`);
    return result;
  }

  const registration = drivers.get(driverName);
  if (!registration) throw new Error(`Unknown eval driver "${driverName}".`);
  const observed = await registration.factory().run(scenario, { config });
  const checks = await evaluateChecks(scenario, observed, config);
  const passed = !observed.errored && checks.every((check) => check.skipped || (check.pass && !check.errored));
  const failureMessage = passed ? undefined : checks.find((check) => !check.pass || check.errored)?.message ?? observed.metadata?.reason as string | undefined ?? "scenario failed";
  return {
    scenarioId: scenario.id,
    kind: scenario.kind,
    passed,
    failureMessage,
    observed,
    checks,
    infraError: Boolean(observed.errored),
    metadata: {
      driver: driverName,
    }
  };
}

function parseScenarioInput(schemaInput: Record<string, unknown>, filePath?: string): Scenario {
  const parsed = ScenarioSchema.safeParse(schemaInput);
  if (parsed.success) return { ...(parsed.data as Scenario), ...(filePath ? { filePath } : {}) };

  const sanitized = sanitizeScenarioChecks(schemaInput);
  if (sanitized) {
    const sanitizedParse = ScenarioSchema.safeParse(sanitized);
    if (sanitizedParse.success) {
      return {
        ...restoreScenarioChecks(sanitizedParse.data as Scenario, schemaInput),
        ...(filePath ? { filePath } : {})
      };
    }
  }

  const kind = typeof schemaInput.kind === "string" ? schemaInput.kind : "";
  const registered = scenarioKinds.get(kind);
  if (!registered) throw new Error(`Unknown scenario kind "${kind || "<missing>"}".`);
  return {
    ...(registered.schema.parse(schemaInput) as Scenario),
    ...(filePath ? { filePath } : {})
  };
}
