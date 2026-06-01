export const RUN_BUDGET_STATE = Symbol("pilotswarm.evalHarness.runBudgetState");

export type RunBudgetState = {
  runSpentUsd: number;
  llmJudgeReservedUsd: number;
  runLimitUsd?: number;
  llmJudgeLimitUsd?: number;
};

export type BudgetedRunConfig = {
  budgets?: { maxUsd?: number };
  llmJudge?: { totalBudgetUsd?: number };
  [RUN_BUDGET_STATE]?: RunBudgetState;
};

export function budgetStateFor(config?: BudgetedRunConfig): RunBudgetState | undefined {
  if (!config) return undefined;
  config[RUN_BUDGET_STATE] ??= {
    runSpentUsd: 0,
    llmJudgeReservedUsd: 0,
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
  if (state.llmJudgeLimitUsd != null && state.llmJudgeReservedUsd + amountUsd > state.llmJudgeLimitUsd) {
    return `LLM judge budget request ${formatUsd(amountUsd)} exceeds remaining LLM judge budget ${formatUsd(Math.max(0, state.llmJudgeLimitUsd - state.llmJudgeReservedUsd))}.`;
  }
  state.runSpentUsd += amountUsd;
  state.llmJudgeReservedUsd += amountUsd;
  return undefined;
}

export function refundLlmJudgeBudget(config: BudgetedRunConfig | undefined, amountUsd: number): void {
  if (!config || amountUsd <= 0) return;
  const state = config[RUN_BUDGET_STATE];
  if (!state) return;
  state.runSpentUsd = Math.max(0, state.runSpentUsd - amountUsd);
  state.llmJudgeReservedUsd = Math.max(0, state.llmJudgeReservedUsd - amountUsd);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
