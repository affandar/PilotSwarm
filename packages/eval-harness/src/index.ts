// Types
export type {
  EvalTask,
  EvalSample,
  EvalExpected,
  EvalToolCall,
  Score,
  ObservedToolCall,
  ObservedResult,
  CaseResult,
  RunResult,
} from "./types.js";
export {
  EvalTaskSchema,
  EvalSampleSchema,
  EvalToolCallSchema,
  EvalExpectedSchema,
  EvalContextMessageSchema,
  EvalSampleInputSchema,
  ObservedToolCallSchema,
  ObservedResultSchema,
  ScoreSchema,
  CaseResultSchema,
  RunSummarySchema,
  RunResultSchema,
} from "./types.js";

// Runner
export { EvalRunner } from "./runner.js";
export type { RunnerOptions } from "./runner.js";

// Loader
export {
  loadEvalTask,
  loadEvalTaskFromDir,
  loadTrajectoryTask,
  loadTrajectoryTaskFromDir,
} from "./loader.js";

// Graders
export { gradeEvalCase } from "./graders/index.js";
export { matchArgs, sortKeys } from "./graders/match-args.js";
export type { MatchMode, MatchResult } from "./graders/match-args.js";
export { gradeToolSelection } from "./graders/tool-selection.js";
export { gradeOrdering } from "./graders/ordering.js";
export { gradeResponse } from "./graders/response.js";
export { gradeCmsState } from "./graders/cms-state.js";
export { gradeDurability } from "./graders/durability.js";
export {
  gradeNoSecretLeak,
  findSecretLeaks,
  SecretLeakPatterns,
} from "./graders/secret-leak.js";
export type { SecretLeakOptions, SecretLeakHit } from "./graders/secret-leak.js";

// Drivers
export type { Driver, DriverOptions } from "./drivers/types.js";
export { FakeDriver } from "./drivers/fake-driver.js";
export { LiveDriver } from "./drivers/live-driver.js";
export type { LiveDriverDeps } from "./drivers/live-driver.js";
/**
 * Wraps an inner Driver and injects a fault drawn from
 * {@link DurabilityFaultPoint}/{@link DurabilityFaultMode}. Designed for
 * crash-recovery / handoff / dehydrate-hydrate evals on top of LiveDriver.
 */
export { ChaosDriver } from "./drivers/chaos-driver.js";
export type { ChaosDriverOptions } from "./drivers/chaos-driver.js";
export {
  DurabilityFixtureDriver,
  /** @deprecated Use DurabilityFixtureDriver. */
  ScriptedDriver,
} from "./drivers/scripted-driver.js";
export type {
  DurabilityFixtureScenario,
  DurabilityFixtureStep,
  /** @deprecated Use DurabilityFixtureScenario. */
  ScriptedScenario,
  /** @deprecated Use DurabilityFixtureStep. */
  ScriptedStep,
} from "./drivers/scripted-driver.js";

// Reporters
export type { Reporter } from "./reporters/types.js";
export { ConsoleReporter } from "./reporters/console.js";
export { JsonlReporter } from "./reporters/jsonl.js";

// Fixtures
export {
  createEvalToolTracker,
  createEvalAddTool,
  createEvalMultiplyTool,
  createEvalWeatherTool,
} from "./fixtures/eval-tools.js";

// Observers
export { extractObservedCalls } from "./observers/tool-tracker.js";

// --- V2: Stats ---
export {
  passAtK,
  meanStddev,
  wilsonInterval,
  bootstrapCI,
  mcNemarTest,
  mannWhitneyU,
  standardNormalCdf,
} from "./stats.js";

// --- V2: Multi-Trial ---
export { MultiTrialRunner } from "./multi-trial.js";
export type { MultiTrialRunnerOptions } from "./multi-trial.js";

// --- V2: Matrix ---
export { MatrixRunner } from "./matrix.js";
export type { MatrixRunnerOptions } from "./matrix.js";

// --- V2: Aggregate Reporters ---
export type { AggregateReporter } from "./reporters/aggregate-types.js";
export { ConsoleAggregateReporter } from "./reporters/console-aggregate.js";
export { MarkdownReporter } from "./reporters/markdown.js";

// --- V2: Types ---
export type {
  SampleTrialResult,
  MultiTrialSummary,
  MultiTrialResult,
  MatrixConfigOverrides,
  MatrixConfig,
  MatrixCell,
  MatrixSummary,
  MatrixResult,
} from "./types.js";
export {
  SampleTrialResultSchema,
  MultiTrialSummarySchema,
  MultiTrialResultSchema,
  MatrixConfigOverridesSchema,
  MatrixConfigSchema,
  MatrixCellSchema,
  MatrixSummarySchema,
  MatrixResultSchema,
  WilsonCISchema,
  TrialScoreAggregateSchema,
  MatrixPassRateRefSchema,
} from "./types.js";

// --- V3: Durability ---
export type {
  DurabilityFaultPoint,
  DurabilityFaultMode,
  DurabilityObservation,
  DurabilityExpected,
} from "./types.js";
export {
  DurabilityFaultPointSchema,
  DurabilityFaultModeSchema,
  DurabilityObservationSchema,
  DurabilityExpectedSchema,
} from "./types.js";

// --- V4: Multi-turn / Trajectory ---
export type {
  TurnExpected,
  TurnInput,
  TrajectoryTurn,
  TrajectorySample,
  TrajectoryTask,
  ObservedTurn,
  ObservedTrajectory,
  TrajectoryScore,
  TrajectoryCaseResult,
  TrajectoryRunResult,
} from "./types.js";
export {
  TurnExpectedSchema,
  TurnInputSchema,
  TrajectoryTurnSchema,
  TrajectorySampleSchema,
  TrajectoryTaskSchema,
  ObservedTurnSchema,
  ObservedTrajectorySchema,
  TrajectoryScoreSchema,
  TrajectoryCaseResultSchema,
  TrajectoryRunResultSchema,
} from "./types.js";
export type { MultiTurnDriver } from "./drivers/multi-turn-types.js";
export {
  FakeMultiTurnDriver,
} from "./drivers/fake-multi-turn-driver.js";
export type { FakeTrajectoryScenario } from "./drivers/fake-multi-turn-driver.js";
export { gradeTrajectory } from "./graders/trajectory.js";
export { TrajectoryRunner } from "./trajectory-runner.js";
export type {
  TrajectoryRunnerOptions,
  TrajectoryReporter,
} from "./trajectory-runner.js";

// --- V5a: LLM-as-Judge ---
export type {
  RubricCriterion,
  Rubric,
  JudgeResult,
  JudgeCost,
} from "./types.js";
export {
  RubricCriterionSchema,
  RubricSchema,
  JudgeResultSchema,
  JudgeCostSchema,
} from "./types.js";
export type {
  JudgeRequest,
  JudgeOptions,
  JudgeResponse,
  JudgeClient,
  JudgeCache,
} from "./graders/judge-types.js";
export { JudgeOutputFormatError } from "./graders/judge-types.js";
export {
  FakeJudgeClient,
} from "./graders/fake-judge-client.js";
export { OpenAIJudgeClient } from "./graders/openai-judge-client.js";
export type { OpenAIJudgeClientOptions, OpenAIJudgeCostRates } from "./graders/openai-judge-client.js";
export { PilotSwarmJudgeClient } from "./graders/pilotswarm-judge-client.js";
export type {
  PilotSwarmJudgeClientOptions,
  PilotSwarmJudgeCostRates,
} from "./graders/pilotswarm-judge-client.js";
export type { FakeJudgeScenario } from "./graders/fake-judge-client.js";
export { InMemoryJudgeCache } from "./graders/judge-cache.js";
export { LLMJudgeGrader } from "./graders/llm-judge.js";
export type {
  LLMJudgeGraderOptions,
  LLMJudgeGradeResult,
} from "./graders/llm-judge.js";

// --- V5b: CI Gates / Regression / Baseline ---
export type {
  CIGateConfig,
  CIGateResult,
  RegressionDetectionResult,
  RegressionResult,
  Baseline,
  BaselineSample,
} from "./types.js";
export {
  CIGateConfigSchema,
  CIGateResultSchema,
  RegressionDetectionResultSchema,
  RegressionResultSchema,
  BaselineSchema,
  BaselineSchemaAllowEmpty,
  BaselineSampleSchema,
} from "./types.js";
export { CIGate } from "./ci-gate.js";
export { RegressionDetector } from "./regression.js";
export type {
  MultipleTestingCorrection,
  RegressionDetectorConfig,
  RegressionDetectorOptions,
} from "./regression.js";
export {
  saveBaseline,
  loadBaseline,
  baselineFromMultiTrialResult,
} from "./baseline.js";
export type { SaveBaselineOptions, LoadBaselineOptions } from "./baseline.js";
export { PRCommentReporter } from "./reporters/pr-comment.js";

// --- iter18: Validation layer (trust-boundary, normalizers, registry) ---
export {
  parseAtBoundary,
  parseAtBoundaryOrInfraError,
} from "./validation/trust-boundary.js";
export type {
  ParseResult,
  ParseSuccess,
  ParseFailure,
  ParseOptions,
} from "./validation/trust-boundary.js";
export {
  normalizeObservedResult,
  normalizeRunResult,
  normalizeMultiTrialResult,
  normalizeMatrixConfig,
  normalizeMatrixResult,
  normalizeBaseline,
} from "./validation/normalize-result.js";
export {
  STRICT_SCHEMA_REGISTRY,
  REGISTRY_CARVE_OUTS,
  assertRegistryComplete,
} from "./validation/registry.js";

// Performance / cost trackers (suite 5)
export { LatencyTracker, CostTracker } from "./perf/latency-tracker.js";
export type { LatencyPercentiles, CostBreakdown } from "./perf/latency-tracker.js";

// Performance evals — DB calls, durability, resource, concurrency, budgets, reporter.
export {
  DbTracker,
  PgStatStatementsRequiredError,
  categorizeQuery,
  diffSnapshots,
  emptySnapshot,
  PgActivityPoller,
  DurabilityTracker,
  percentilesOf,
  ResourceTracker,
  ConcurrencyProfiler,
  computeScalingFactor,
  BudgetChecker,
  BaselineComparator,
  PerfReporter,
  renderMarkdown as renderPerfMarkdown,
  renderJson as renderPerfJson,
} from "./perf/index.js";
export type {
  DbCategory,
  DbStatementRow,
  DbStatementSnapshot,
  DbCallDelta,
  DbTrackerOptions,
  PgLikeClient,
  PgStatStatementsCheck,
  ActivitySample,
  PgActivityResult,
  PgActivityPollerOptions,
  TrackerPercentiles,
  DurabilityRecord,
  DurabilityPercentiles,
  CmsLikeEvent,
  CmsPairingResult,
  MemorySnapshot,
  MemoryWatchResult,
  ResourceTrackerOptions,
  ConcurrencyLevelStat,
  ConcurrencyProfile,
  ConcurrencyProfilerOptions,
  CapacityGuardOptions,
  PerfBudget,
  PerfReport,
  PerfBaseline,
  BaselineComparisonOptions,
  LatencyBudgetShape,
  CostBudgetShape,
  DbBudget,
  DurabilityBudget,
  ResourceBudget,
  ConcurrencyBudgetShape,
  BudgetCheckResult,
  OptionalDim,
  RenderOptions as PerfRenderOptions,
} from "./perf/index.js";
