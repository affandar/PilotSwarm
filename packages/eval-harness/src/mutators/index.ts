import { minimizePrompt } from "./minimize.js";
import { removeSection } from "./remove-section.js";

export function applyMutation(prompt: string, mutation?: { mutator: "minimize" | "remove-section"; config?: Record<string, unknown> }): string {
  if (!mutation) return prompt;
  if (mutation.mutator === "minimize") return minimizePrompt(prompt, Number(mutation.config?.percent ?? 50));
  return removeSection(prompt, String(mutation.config?.heading ?? ""));
}
