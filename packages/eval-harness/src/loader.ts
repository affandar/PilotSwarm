import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { EvalTaskSchema, type EvalTask } from "./types.js";

export function loadEvalTask(filePath: string): EvalTask {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return EvalTaskSchema.parse(parsed);
}

export function loadEvalTaskFromDir(dir: string): EvalTask[] {
  const entries = readdirSync(dir);
  const tasks: EvalTask[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    tasks.push(loadEvalTask(full));
  }
  return tasks;
}
