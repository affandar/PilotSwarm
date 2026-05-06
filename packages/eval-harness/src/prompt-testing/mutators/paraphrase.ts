/**
 * Paraphrase mutator: rewrites a single `## section` of the prompt body via an
 * LLM. Requires `OPENAI_API_KEY` — without it the mutator throws on `apply()`
 * (early, with a clear error). It MUST NOT silently no-op, since callers that
 * spec a paraphrase variant rely on the body actually changing.
 *
 * Config:
 *   {
 *     section: string;        // heading text to paraphrase (case-insensitive)
 *     model?: string;         // OpenAI model (default: "gpt-4o-mini")
 *     temperature?: number;   // 0..2 (default: 0.7)
 *     instruction?: string;   // additional steering for the rewrite
 *   }
 *
 * Determinism: NOT guaranteed. Callers should treat this as a stochastic
 * variant — pin temperature=0 for "as-deterministic-as-possible".
 */

import type { Mutator, MutatorContext } from "./mutator.js";
import { assertObjectConfig } from "./mutator.js";
import { splitSections, joinSections } from "./minimize.js";

export interface ParaphraseConfig {
  section: string;
  model?: string;
  temperature?: number;
  instruction?: string;
}

function normalizeHeading(line: string): string {
  return line.replace(/^##\s+/u, "").trim().toLowerCase();
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function callOpenAI(opts: {
  apiKey: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: opts.temperature,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`paraphrase: OpenAI HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as OpenAIChatResponse;
  if (json.error?.message) {
    throw new Error(`paraphrase: OpenAI error: ${json.error.message}`);
  }
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("paraphrase: OpenAI returned an empty response");
  }
  return content;
}

export const paraphraseMutator: Mutator = {
  kind: "paraphrase",
  async apply(ctx: MutatorContext): Promise<string> {
    const config = assertObjectConfig(ctx.config, "paraphrase");
    const sectionName = config.section;
    if (typeof sectionName !== "string" || sectionName.trim().length === 0) {
      throw new Error("paraphrase: config.section must be a non-empty string");
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "paraphrase: OPENAI_API_KEY is required for the paraphrase mutator. " +
          "Set the env var or use minimize/reorder/remove-section instead.",
      );
    }
    const model = typeof config.model === "string" ? config.model : "gpt-4o-mini";
    const temperature =
      typeof config.temperature === "number" && Number.isFinite(config.temperature)
        ? config.temperature
        : 0.7;
    const instruction =
      typeof config.instruction === "string" ? config.instruction : "";

    const target = sectionName.trim().toLowerCase();
    const sections = splitSections(ctx.body);
    const idx = sections.findIndex((s) => s.heading.length > 0 && normalizeHeading(s.heading) === target);
    if (idx === -1) {
      throw new Error(`paraphrase: section "${sectionName}" not found in prompt body`);
    }

    const original = sections[idx]!.bodyLines.join("\n");
    if (original.trim().length === 0) return ctx.body;

    const systemPrompt =
      "You are an expert at rephrasing technical agent prompts WITHOUT changing their meaning, " +
      "constraints, or behavioral guarantees. Preserve all enumerated rules, tool names, code " +
      "fences, and Markdown structure. Output ONLY the rewritten body — no preamble, no fences, " +
      "no commentary. Do not add or remove rules.";
    const userPrompt =
      `Rephrase the following prompt section (heading: "${sectionName}").` +
      (instruction ? `\n\nAdditional steering: ${instruction}` : "") +
      `\n\n--- ORIGINAL ---\n${original}\n--- END ---`;

    const rewritten = await callOpenAI({
      apiKey,
      model,
      temperature,
      systemPrompt,
      userPrompt,
    });

    const updated = sections.map((s, i) =>
      i === idx ? { heading: s.heading, bodyLines: rewritten.split(/\r?\n/) } : s,
    );
    return joinSections(updated);
  },
};

export default paraphraseMutator;
