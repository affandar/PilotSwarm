import type { z } from "zod";
import type { CheckSchema } from "./schema/check-types.js";
import type { RunConfigSchema } from "./schema/config.js";
import type { ScenarioSchema } from "./schema/scenario.js";

export type Scenario = z.infer<typeof ScenarioSchema> & { filePath?: string };
export type Check = z.infer<typeof CheckSchema>;
export type RunConfig = z.infer<typeof RunConfigSchema> & { configPath?: string };

export type ObservedToolCall = {
  name: string;
  args?: unknown;
  result?: unknown;
  callId?: string;
  turnIndex?: number;
};

export type CmsObservedEvent = {
  type: string;
  timestamp?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
};

export type ObservedResult = {
  scenarioId: string;
  finalResponse: string;
  toolCalls: ObservedToolCall[];
  cmsEvents: CmsObservedEvent[];
  latencyMs: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  terminalState?: string;
  errored?: boolean;
  metadata?: Record<string, unknown>;
};

export type CheckResult = {
  pass: boolean;
  message: string;
  verdict?: "PASSED" | "PARTIAL" | "FAILED";
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  errored?: boolean;
  skipped?: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type ScenarioResult = {
  scenarioId: string;
  kind: Scenario["kind"];
  passed: boolean;
  failureMessage?: string;
  observed: ObservedResult;
  checks: CheckResult[];
  infraError?: boolean;
  metadata?: Record<string, unknown>;
};

export type RunConfigurationSummary = {
  configPath?: string;
  cliOverrides: Record<string, unknown>;
  effectiveRunConfig: Record<string, unknown>;
  discoveredScenarioCount: number;
  executionCellCount: number;
};

export type RunManifestResult = {
  runId: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  passed: number;
  failed: number;
  infraErrors: number;
  skipped: number;
  scenarios: ScenarioResult[];
  configuration: RunConfigurationSummary;
  budget: {
    llmJudgeReservedUsd: number;
  };
};

export type CheckEvaluator<TConfig = Check> = (args: {
  scenario: Scenario;
  observed: ObservedResult;
  config: TConfig;
  runConfig?: Partial<RunConfig>;
}) => CheckResult | Promise<CheckResult>;
