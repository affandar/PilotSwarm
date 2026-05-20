import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { applyMutation } from "../mutators/index.js";
import type { Scenario } from "../types.js";

function stripFrontmatter(source: string): string {
  if (!source.startsWith("---\n")) return source;
  const end = source.indexOf("\n---", 4);
  return end >= 0 ? source.slice(end + 4).trim() : source;
}

export async function loadPromptOverride(entry: NonNullable<Scenario["promptOverrides"]>[string], scenarioFilePath?: string): Promise<string> {
  const baseDir = scenarioFilePath ? dirname(scenarioFilePath) : process.cwd();
  const prompt = entry.inline ?? stripFrontmatter(await readFile(isAbsolute(entry.source ?? "") ? entry.source! : resolve(baseDir, entry.source!), "utf8"));
  return applyMutation(prompt, entry.mutation);
}
