import { z } from "zod";
import type { ToolRegistration } from "../registry.js";

export const defaultTools: ToolRegistration[] = [
  {
    name: "test_add",
    description: "Add two numbers",
    schema: z.object({ a: z.number(), b: z.number() }),
    handler: (args) => {
      const { a, b } = args as { a: number; b: number };
      return a + b;
    }
  },
  {
    name: "test_multiply",
    description: "Multiply two numbers",
    schema: z.object({ a: z.number(), b: z.number() }),
    handler: (args) => {
      const { a, b } = args as { a: number; b: number };
      return a * b;
    }
  },
  {
    name: "test_weather",
    description: "Return deterministic fake weather",
    schema: z.object({ city: z.string() }),
    handler: (args) => `Weather in ${(args as { city: string }).city}: sunny`
  },
  {
    name: "slow_tool",
    description: "Resolve after a delay",
    schema: z.object({ delayMs: z.number().int().nonnegative().default(100) }),
    handler: async (args) => {
      const delayMs = (args as { delayMs?: number }).delayMs ?? 100;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { ok: true, delayMs };
    }
  },
  {
    name: "flaky_tool",
    description: "Deterministic alternating fake flaky tool",
    schema: z.object({ seed: z.number().optional() }).optional(),
    handler: (args) => ((args as { seed?: number } | undefined)?.seed ?? 0) % 2 === 0 ? { ok: true } : (() => { throw new Error("flaky_tool failed"); })()
  },
  {
    name: "large_response_tool",
    description: "Return a large string",
    schema: z.object({ sizeKB: z.number().int().positive().default(1) }),
    handler: (args) => "x".repeat(((args as { sizeKB?: number }).sizeKB ?? 1) * 1024)
  },
  {
    name: "error_tool",
    description: "Always throw",
    schema: z.object({}).optional(),
    handler: () => {
      throw new Error("error_tool failed");
    }
  }
];
