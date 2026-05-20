export type BudgetTracker = {
  spentUsd: number;
  limitUsd?: number;
};

export const RUN_BUDGET_STATE = Symbol("pilotswarm.evalHarness.runBudgetState");

export type RunBudgetState = {
  runSpentUsd: number;
  llmJudgeSpentUsd: number;
  runLimitUsd?: number;
  llmJudgeLimitUsd?: number;
};

export type BudgetedRunConfig = {
  budgets?: { maxUsd?: number };
  llmJudge?: { totalBudgetUsd?: number };
  [RUN_BUDGET_STATE]?: RunBudgetState;
};

export function canSpendBudget(tracker: BudgetTracker, amountUsd: number): boolean {
  return tracker.limitUsd == null || tracker.spentUsd + amountUsd <= tracker.limitUsd;
}

export function recordBudgetSpend(tracker: BudgetTracker, amountUsd: number): BudgetTracker {
  return { ...tracker, spentUsd: tracker.spentUsd + amountUsd };
}

export function budgetStateFor(config?: BudgetedRunConfig): RunBudgetState | undefined {
  if (!config) return undefined;
  config[RUN_BUDGET_STATE] ??= {
    runSpentUsd: 0,
    llmJudgeSpentUsd: 0,
    runLimitUsd: config.budgets?.maxUsd,
    llmJudgeLimitUsd: config.llmJudge?.totalBudgetUsd,
  };
  return config[RUN_BUDGET_STATE];
}

export function reserveLlmJudgeBudget(config: BudgetedRunConfig | undefined, amountUsd: number): string | undefined {
  if (amountUsd <= 0) return undefined;
  const state = budgetStateFor(config);
  if (!state) return undefined;
  if (state.runLimitUsd != null && state.runSpentUsd + amountUsd > state.runLimitUsd) {
    return `LLM judge budget request ${formatUsd(amountUsd)} exceeds remaining run budget ${formatUsd(Math.max(0, state.runLimitUsd - state.runSpentUsd))}.`;
  }
  if (state.llmJudgeLimitUsd != null && state.llmJudgeSpentUsd + amountUsd > state.llmJudgeLimitUsd) {
    return `LLM judge budget request ${formatUsd(amountUsd)} exceeds remaining LLM judge budget ${formatUsd(Math.max(0, state.llmJudgeLimitUsd - state.llmJudgeSpentUsd))}.`;
  }
  state.runSpentUsd += amountUsd;
  state.llmJudgeSpentUsd += amountUsd;
  return undefined;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
