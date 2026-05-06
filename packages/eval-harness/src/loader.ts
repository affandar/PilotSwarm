import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { EvalTaskSchema, TrajectoryTaskSchema, type EvalTask, type TrajectoryTask } from "./types.js";

export interface LoadEvalTaskOptions {
  mode?: "fixture" | "live";
  onSkip?: (filePathOrMessage: string, reason?: string) => void;
}

export function loadEvalTask(filePath: string): EvalTask;
export function loadEvalTask(filePath: string, options: LoadEvalTaskOptions): EvalTask | undefined;
export function loadEvalTask(filePath: string, options: LoadEvalTaskOptions = {}): EvalTask | undefined {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const task = EvalTaskSchema.parse(parsed);
  if (options.mode === "live" && task.runnable === false) {
    const message = `skipping non-runnable dataset "${task.id}" in live mode`;
    if (options.onSkip) options.onSkip(message);
    else console.warn(`[eval-harness] ${message}`);
    return undefined;
  }
  return task;
}

export function loadEvalTaskFromDir(dir: string, options: LoadEvalTaskOptions = {}): EvalTask[] {
  const entries = readdirSync(dir);
  const tasks: EvalTask[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    const raw = readFileSync(full, "utf8");
    const parsed = JSON.parse(raw);
    const evalParse = EvalTaskSchema.safeParse(parsed);
    if (!evalParse.success) {
      const trajParse = TrajectoryTaskSchema.safeParse(parsed);
      if (trajParse.success) {
        const reason = `file is a TrajectoryTask, not EvalTask`;
        if (options.onSkip) options.onSkip(full, reason);
        continue;
      }
      throw evalParse.error;
    }
    const task = evalParse.data;
    if (options.mode === "live" && task.runnable === false) {
      const message = `skipping non-runnable dataset "${task.id}" in live mode`;
      if (options.onSkip) options.onSkip(message);
      else console.warn(`[eval-harness] ${message}`);
      continue;
    }
    tasks.push(task);
  }
  return tasks;
}

export function loadTrajectoryTask(filePath: string): TrajectoryTask;
export function loadTrajectoryTask(filePath: string, options: LoadEvalTaskOptions): TrajectoryTask | undefined;
export function loadTrajectoryTask(filePath: string, options: LoadEvalTaskOptions = {}): TrajectoryTask | undefined {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const task = TrajectoryTaskSchema.parse(parsed);
  if (options.mode === "live" && task.runnable === false) {
    const message = `skipping non-runnable dataset "${task.id}" in live mode`;
    if (options.onSkip) options.onSkip(message);
    else console.warn(`[eval-harness] ${message}`);
    return undefined;
  }
  return task;
}

export function loadTrajectoryTaskFromDir(dir: string, options: LoadEvalTaskOptions = {}): TrajectoryTask[] {
  const entries = readdirSync(dir);
  const tasks: TrajectoryTask[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    const raw = readFileSync(full, "utf8");
    const parsed = JSON.parse(raw);
    const trajParse = TrajectoryTaskSchema.safeParse(parsed);
    if (!trajParse.success) {
      const evalParse = EvalTaskSchema.safeParse(parsed);
      if (evalParse.success) {
        const reason = `file is an EvalTask, not TrajectoryTask`;
        if (options.onSkip) options.onSkip(full, reason);
        continue;
      }
      throw trajParse.error;
    }
    const task = trajParse.data;
    if (options.mode === "live" && task.runnable === false) {
      const message = `skipping non-runnable dataset "${task.id}" in live mode`;
      if (options.onSkip) options.onSkip(message);
      else console.warn(`[eval-harness] ${message}`);
      continue;
    }
    tasks.push(task);
  }
  return tasks;
}
