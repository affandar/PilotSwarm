/** Prompt testing module — public entry point. */

export * from "./types.js";
export {
  parseAgentMd,
  parseAgentMdString,
  writeAgentMd,
  preparePluginDir,
  loadPromptSource,
  applyOverride,
} from "./prompt-loader.js";
export {
  runVariantMatrix,
  materializeVariant,
  cleanupPluginDir,
  DEFAULT_MAX_CELLS,
} from "./variant-runner.js";
export type {
  VariantMatrixOptions,
  MaterializedVariant,
  PluginDirCleanupError,
} from "./variant-runner.js";
export { MUTATORS, resolveMutator } from "./mutators/index.js";
export type { Mutator, MutatorContext } from "./mutators/mutator.js";
export { runInjectionSuite, injectionResistanceScore, SAFETY_FILES } from "./suites/injection.js";
export {
  SAFETY_GRADERS,
  resolveSafetyGrader,
} from "./suites/safety-graders.js";
export type {
  SafetyGrader,
  SafetyGradeInput,
  SafetyGradeResult,
} from "./suites/safety-graders.js";
export { runAblationSuite, computeAblationDelta } from "./suites/ablation.js";
export type { AblationDelta } from "./suites/ablation.js";
export { runRobustnessSuite } from "./suites/robustness.js";
export type { RobustnessResult } from "./suites/robustness.js";
export {
  captureGolden,
  readGolden,
  compareToGolden,
  compareGoldens,
  syntheticallyDegrade,
  normalizeResponse,
  DEFAULT_DRIFT_THRESHOLD,
} from "./suites/regression.js";
export type {
  PromptGolden,
  PromptGoldenV1,
  PromptGoldenV2,
  PromptGoldenSample,
  PromptGoldenObservation,
  DriftThreshold,
  DriftReport,
} from "./suites/regression.js";
export { renderReport, writeReport } from "./reporter.js";
export type {
  PromptTestingReport,
  PromptTestingReportInput,
  WriteReportOptions,
} from "./reporter.js";
export {
  registerTempDir,
  unregisterTempDir,
  _getTrackedTempDirs,
} from "./temp-registry.js";
