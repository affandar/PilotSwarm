import { CheckSchema } from "../schema/check-types.js";
import { checkTypes } from "../registry.js";
import type { Check, CheckEvaluator, CheckResult, ObservedResult, RunConfig, Scenario } from "../types.js";

type CheckLike = Check | (Record<string, unknown> & { type: string });
type LlmJudgeCheck = Extract<Check, { type: "llm-judge" }>;

export async function evaluateCheck(args: {
  scenario: Scenario;
  observed: ObservedResult;
  config: CheckLike;
  runConfig?: Partial<RunConfig>;
}): Promise<CheckResult> {
  const type = typeof args.config.type === "string" ? args.config.type : "";
  const registration = checkTypes.get(type) as { schema?: { parse: (value: unknown) => unknown }; evaluate: CheckEvaluator<any> } | undefined;
  if (!registration) {
    return { pass: false, errored: true, message: `No evaluator registered for check type ${type}` };
  }
  const config = registration.schema
    ? registration.schema.parse(args.config)
    : CheckSchema.safeParse(args.config).success
      ? CheckSchema.parse(args.config)
      : args.config;
  try {
    return await registration.evaluate({ scenario: args.scenario, observed: args.observed, config, runConfig: args.runConfig });
  } catch (error) {
    return {
      pass: false,
      errored: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function evaluateChecks(
  scenario: Scenario,
  observed: ObservedResult,
  runConfig?: Partial<RunConfig>,
): Promise<CheckResult[]> {
  const scenarioChecks = await runChecks({
    scenario,
    observed,
    checks: scenarioLevelChecks(scenario, runConfig),
    runConfig,
  });
  if (!("turns" in scenario)) return scenarioChecks;

  const turnChecks = await Promise.all(scenario.turns.flatMap((turn, turnIndex) => (
    turn.checks.map(async (config) => {
      const result = await evaluateCheck({
        scenario,
        observed: observedForTurn(observed, turnIndex),
        config,
        runConfig,
      });
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          scope: "turn",
          turnIndex,
        },
      };
    })
  )));
  return [...scenarioChecks, ...turnChecks];
}

function scenarioLevelChecks(scenario: Scenario, runConfig?: Partial<RunConfig>): CheckLike[] {
  const defaultCheck = defaultLlmJudgeCheck(scenario, runConfig);
  return defaultCheck ? [...scenario.checks, defaultCheck] : scenario.checks;
}

function defaultLlmJudgeCheck(scenario: Scenario, runConfig?: Partial<RunConfig>): LlmJudgeCheck | undefined {
  if (runConfig?.llmJudge?.enabled !== true) return undefined;
  if (runConfig.llmJudge.applyTo !== "all") return undefined;
  if (scenarioHasLlmJudge(scenario)) return undefined;

  const defaultCheck = runConfig.llmJudge.defaultCheck ?? {};
  return {
    type: "llm-judge",
    rubric: defaultCheck.rubric ?? defaultLlmJudgeRubric(scenario),
    ...(typeof defaultCheck.budgetUsd === "number" ? { budgetUsd: defaultCheck.budgetUsd } : {}),
    ...(typeof defaultCheck.judgeModel === "string" ? { judgeModel: defaultCheck.judgeModel } : {}),
    ...(typeof defaultCheck.maxOutputTokens === "number" ? { maxOutputTokens: defaultCheck.maxOutputTokens } : {}),
  };
}

function scenarioHasLlmJudge(scenario: Scenario): boolean {
  if (scenario.checks.some((check) => check.type === "llm-judge")) return true;
  if (!("turns" in scenario)) return false;
  return scenario.turns.some((turn) => turn.checks.some((check) => check.type === "llm-judge"));
}

function defaultLlmJudgeRubric(scenario: Scenario): string {
  return [
    "Evaluate whether the observed PilotSwarm execution satisfies the scenario description, prompts, deterministic checks, tool calls, CMS/session evidence, and terminal state.",
    "Mark PASSED only when the user-visible response and durable runtime evidence satisfy the scenario without contradictions.",
    "Mark PARTIAL when the outcome is materially incomplete or evidence is ambiguous.",
    "Mark FAILED when the response, tool behavior, safety behavior, or runtime evidence violates the scenario.",
    `Scenario under review: ${scenario.id} - ${scenario.description}`,
  ].join(" ");
}

export async function runChecks(args: {
  scenario: Scenario;
  observed: ObservedResult;
  checks?: CheckLike[];
  runConfig?: Partial<RunConfig>;
}): Promise<CheckResult[]> {
  return Promise.all((args.checks ?? args.scenario.checks).map((config) => (
    evaluateCheck({ scenario: args.scenario, observed: args.observed, config, runConfig: args.runConfig })
  )));
}

function observedForTurn(observed: ObservedResult, turnIndex: number): ObservedResult {
  const turnResponses = Array.isArray(observed.metadata?.turnResponses)
    ? observed.metadata.turnResponses
    : [];
  const turnResponse = typeof turnResponses[turnIndex] === "string"
    ? turnResponses[turnIndex]
    : turnIndex === turnResponses.length - 1
      ? observed.finalResponse
      : "";
  return {
    ...observed,
    finalResponse: turnResponse,
    toolCalls: observed.toolCalls.filter((call) => (call.turnIndex ?? 0) === turnIndex),
    cmsEvents: observed.cmsEvents.filter((event) => {
      const eventTurnIndex = eventTurnIndexFromMetadata(event.metadata);
      return typeof eventTurnIndex === "number" ? eventTurnIndex === turnIndex : true;
    }),
    metadata: {
      ...(observed.metadata ?? {}),
      scope: "turn",
      turnIndex,
    },
  };
}

function eventTurnIndexFromMetadata(metadata: Record<string, unknown> | undefined): number | undefined {
  const turnIndex = metadata?.turnIndex;
  if (typeof turnIndex === "number") return turnIndex;
  const iteration = metadata?.iteration;
  return typeof iteration === "number" ? iteration : undefined;
}
