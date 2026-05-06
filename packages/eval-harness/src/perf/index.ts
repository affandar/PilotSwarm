/**
 * Barrel export for the perf module. Existing latency-tracker exports are
 * preserved for back-compat (already exported from the package index).
 */

export { LatencyTracker, CostTracker } from "./latency-tracker.js";
export type { LatencyPercentiles, CostBreakdown } from "./latency-tracker.js";

export {
  DbTracker,
  PgStatStatementsRequiredError,
  categorizeQuery,
  diffSnapshots,
  emptySnapshot,
} from "./db-tracker.js";
export type {
  DbCategory,
  DbStatementRow,
  DbStatementSnapshot,
  DbCallDelta,
  DbTrackerOptions,
  PgLikeClient,
  PgStatStatementsCheck,
} from "./db-tracker.js";

export { PgActivityPoller } from "./pg-activity-poller.js";
export type {
  ActivitySample,
  PgActivityResult,
  PgActivityPollerOptions,
} from "./pg-activity-poller.js";

export {
  DurabilityTracker,
  percentilesOf,
} from "./durability-tracker.js";
export type {
  TrackerPercentiles,
  TrackerSource,
  DurabilityBucket,
  DurabilityRecord,
  DurabilityPercentiles,
  CmsLikeEvent,
  CmsPairingResult,
  RecordFromCmsEventsOptions,
} from "./durability-tracker.js";

export { ResourceTracker } from "./resource-tracker.js";
export type {
  MemorySnapshot,
  MemoryWatchResult,
  ResourceTrackerOptions,
} from "./resource-tracker.js";

export {
  ConcurrencyProfiler,
  computeScalingFactor,
} from "./concurrency-profiler.js";
export type {
  ConcurrencyLevelStat,
  ConcurrencyProfile,
  ConcurrencyProfilerOptions,
  CapacityGuardOptions,
} from "./concurrency-profiler.js";

export { BudgetChecker, BaselineComparator } from "./perf-budget.js";
export type {
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
} from "./perf-budget.js";

export { PerfReporter, renderMarkdown, renderJson } from "./reporter.js";
export type { RenderOptions } from "./reporter.js";
