export interface ToolInvocation {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  timestamp: number;
  order: number;
}

export interface EvalToolTracker {
  invocations: ToolInvocation[];
  reset(): void;
}

interface EvalToolDefinition<Args extends Record<string, unknown>, Result> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler(args: Args): Promise<Result>;
}

function defineEvalTool<Args extends Record<string, unknown>, Result>(
  name: string,
  definition: Omit<EvalToolDefinition<Args, Result>, "name">,
): EvalToolDefinition<Args, Result> {
  return { name, ...definition };
}

export function createEvalToolTracker(): {
  tracker: EvalToolTracker;
  tools: {
    add: ReturnType<typeof createEvalAddTool>;
    multiply: ReturnType<typeof createEvalMultiplyTool>;
    weather: ReturnType<typeof createEvalWeatherTool>;
  };
} {
  const tracker: EvalToolTracker = {
    invocations: [],
    reset() {
      this.invocations = [];
    },
  };
  return {
    tracker,
    tools: {
      add: createEvalAddTool(tracker),
      multiply: createEvalMultiplyTool(tracker),
      weather: createEvalWeatherTool(tracker),
    },
  };
}

function record(
  tracker: EvalToolTracker,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): void {
  tracker.invocations.push({
    name,
    args,
    result,
    timestamp: Date.now(),
    order: tracker.invocations.length,
  });
}

export function createEvalAddTool(tracker: EvalToolTracker) {
  return defineEvalTool("test_add", {
    description: "Add two numbers together. ALWAYS use this when asked to add numbers.",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
    handler: async (args: { a: number; b: number }) => {
      const result = { result: args.a + args.b };
      record(tracker, "test_add", args as unknown as Record<string, unknown>, result);
      return result;
    },
  });
}

export function createEvalMultiplyTool(tracker: EvalToolTracker) {
  return defineEvalTool("test_multiply", {
    description: "Multiply two numbers. ALWAYS use this when asked to multiply.",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
    handler: async (args: { a: number; b: number }) => {
      const result = { result: args.a * args.b };
      record(tracker, "test_multiply", args as unknown as Record<string, unknown>, result);
      return result;
    },
  });
}

export function createEvalWeatherTool(tracker: EvalToolTracker) {
  return defineEvalTool("test_weather", {
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        unit: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          description: "Temperature unit (default fahrenheit)",
        },
      },
      required: ["city"],
    },
    handler: async (args: { city: string; unit?: "celsius" | "fahrenheit" }) => {
      const unit = args.unit ?? "fahrenheit";
      const result = {
        temperature: unit === "celsius" ? 22 : 72,
        condition: "sunny",
        city: args.city,
        unit,
      };
      record(tracker, "test_weather", args as unknown as Record<string, unknown>, result);
      return result;
    },
  });
}
