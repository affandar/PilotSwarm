import type { MultiTrialResult, MatrixResult } from "../types.js";

export interface AggregateReporter {
  onMultiTrialComplete(result: MultiTrialResult): void | Promise<void>;
  onMatrixComplete(result: MatrixResult): void | Promise<void>;
}
