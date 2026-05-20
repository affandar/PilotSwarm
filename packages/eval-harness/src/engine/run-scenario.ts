import { drivers } from "../registry.js";
import { ScenarioSchema, semanticValidateScenario } from "../schema/scenario.js";
import { evaluateChecks } from "./check-runner.js";
import { scenarioKinds } from "../registry.js";
import { restoreScenarioChecks, sanitizeScenarioChecks } from "./custom-checks.js";
import { effectiveDriver, unsupportedRequirementPolicy } from "./effective-config.js";
import type { ObservedResult, RunConfig, Scenario, ScenarioResult } from "../types.js";

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
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      terminalState: "schema-error",
      errored: true,
      metadata: { semanticErrors }
    };
    return {
      scenarioId: scenario.id,
      kind: scenario.kind,
      passed: false,
      gated: true,
      failureMessage: semanticErrors.join("; "),
      observed,
      checks: [],
      infraError: false
    };
  }

  const driverName = effectiveDriver(config, config.driver);
  if (scenario.requirements?.live && driverName === "fake") {
    return unsupportedLiveRequirementResult(scenario, driverName, unsupportedRequirementPolicy(config));
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
    gated: true,
    failureMessage,
    observed,
    checks,
    infraError: observed.errored && driverName !== "fake",
    metadata: {
      driver: driverName,
      ...scenarioResultMetadata(scenario),
    }
  };
}

function unsupportedLiveRequirementResult(
  scenario: Scenario,
  driverName: string,
  policy: "error" | "skip",
): ScenarioResult {
  const terminalState = policy === "skip" ? "skipped" : "unsupported";
  const reason = `Scenario ${scenario.id} requires live execution and cannot run with the fake driver.`;
  const observed: ObservedResult = {
    scenarioId: scenario.id,
    finalResponse: "",
    toolCalls: [],
    cmsEvents: [],
    latencyMs: 0,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    terminalState,
    errored: false,
    metadata: {
      driver: driverName,
      reason,
    },
  };
  return {
    scenarioId: scenario.id,
    kind: scenario.kind,
    passed: false,
    gated: true,
    failureMessage: policy === "skip" ? undefined : reason,
    observed,
    checks: [],
    infraError: false,
    metadata: {
      driver: driverName,
      ...scenarioResultMetadata(scenario),
    },
  };
}

function scenarioResultMetadata(scenario: Scenario): Record<string, unknown> {
  const evalCell = scenario.metadata?.evalCell;
  return evalCell && typeof evalCell === "object"
    ? { ...(evalCell as Record<string, unknown>), evalCell }
    : {};
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
  const scenario = {
    ...(
      scenarioKinds.get(kind)?.schema.parse(schemaInput) as Scenario
    ),
    ...(filePath ? { filePath } : {})
  };
  return scenario;
}
