import type { Driver } from "../registry.js";
import type { Check, CmsObservedEvent, ObservedResult, ObservedToolCall, Scenario } from "../types.js";

function fakeMetadata(scenario: Scenario): Record<string, unknown> {
  const metadata = scenario.metadata;
  if (metadata && typeof metadata === "object" && "fake" in metadata) {
    return (metadata.fake as Record<string, unknown>) ?? {};
  }
  return {};
}

function promptForScenario(scenario: Scenario): string {
  if ("input" in scenario) return scenario.input.prompt;
  if ("turns" in scenario) return scenario.turns.map((turn) => turn.input.prompt).join("\n");
  return scenario.description;
}

function checksForScenario(scenario: Scenario): Check[] {
  const scenarioChecks = Array.isArray(scenario.checks) ? scenario.checks : [];
  if (!("turns" in scenario)) return scenarioChecks;
  return [
    ...scenarioChecks,
    ...scenario.turns.flatMap((turn) => turn.checks),
  ];
}

function resultForToolCall(name: string, args: unknown): unknown {
  const values = args != null && typeof args === "object" ? args as Record<string, unknown> : {};
  if (name === "test_add") return Number(values.a ?? 0) + Number(values.b ?? 0);
  if (name === "test_multiply") return Number(values.a ?? 1) * Number(values.b ?? 1);
  if (name === "test_weather") return `Weather in ${String(values.city ?? "Paris")}: sunny`;
  if (name === "wait") return "completed";
  if (name === "spawn_agent") return { status: "spawned" };
  if (name === "check_agents") return { status: "completed" };
  return "ok";
}

function inferArgsFromPrompt(name: string, prompt: string): unknown {
  const numbers = [...prompt.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (name === "test_add") return { a: numbers[0] ?? 1, b: numbers[1] ?? 1 };
  if (name === "test_multiply") return { a: numbers[0] ?? 2, b: numbers.at(-1) ?? 2 };
  if (name === "test_weather") return { city: /in\s+([A-Z][A-Za-z-]+)/.exec(prompt)?.[1] ?? "Paris" };
  if (name === "wait") return { seconds: numbers[0] ?? 1 };
  return {};
}

function inferToolCallsFromChecks(scenario: Scenario): ObservedToolCall[] {
  const prompt = promptForScenario(scenario);
  const calls: ObservedToolCall[] = [];
  addToolCallsForChecks(calls, Array.isArray(scenario.checks) ? scenario.checks : [], prompt, 0);
  if ("turns" in scenario) {
    scenario.turns.forEach((turn, turnIndex) => {
      addToolCallsForChecks(calls, turn.checks, turn.input.prompt, turnIndex);
    });
  }
  return calls;
}

function addToolCallsForChecks(
  calls: ObservedToolCall[],
  checks: Check[],
  prompt: string,
  turnIndex: number,
): void {
  const usedToolChecks = new Set<number>();
  const sequences = checks.filter((check) => check.type === "tool-sequence");
  const primarySequence = sequences.find((check) => check.order !== "unordered") ?? sequences[0];

  if (primarySequence) {
    for (const name of primarySequence.calls) {
      const checkIndex = checks.findIndex((check, index) => (
        !usedToolChecks.has(index)
        && check.type === "tool-call"
        && check.name === name
      ));
      const args = checkIndex >= 0 ? (checks[checkIndex] as Extract<Check, { type: "tool-call" }>).args : inferArgsFromPrompt(name, prompt);
      if (checkIndex >= 0) usedToolChecks.add(checkIndex);
      calls.push({ name, args, result: resultForToolCall(name, args), turnIndex });
    }
  }

  for (const [index, check] of checks.entries()) {
    if (check.type !== "tool-call" || usedToolChecks.has(index)) continue;
    const args = check.args ?? inferArgsFromPrompt(check.name, prompt);
    const call = { name: check.name, args, result: resultForToolCall(check.name, args), turnIndex };
    if (typeof check.order === "number") calls.splice(Math.min(check.order, calls.length), 0, call);
    else calls.push(call);
  }
}

function inferToolCalls(scenario: Scenario): ObservedToolCall[] {
  const checkedCalls = inferToolCallsFromChecks(scenario);
  if (checkedCalls.length > 0) return checkedCalls;
  const prompt = promptForScenario(scenario);
  const calls: ObservedToolCall[] = [];
  if (scenario.tools.includes("test_add") || /add/i.test(prompt)) {
    const numbers = [...prompt.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const a = numbers[0] ?? 1;
    const b = numbers[1] ?? 1;
    calls.push({ name: "test_add", args: { a, b }, result: a + b, turnIndex: 0 });
  }
  if (scenario.tools.includes("test_multiply") || /multiply/i.test(prompt)) {
    const numbers = [...prompt.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const a = calls[0]?.result as number | undefined ?? numbers[0] ?? 2;
    const b = numbers.at(-1) ?? 2;
    calls.push({ name: "test_multiply", args: { a, b }, result: a * b, turnIndex: 0 });
  }
  if (scenario.tools.includes("test_weather") || /weather/i.test(prompt)) {
    const city = /in\s+([A-Z][A-Za-z-]+)/.exec(prompt)?.[1] ?? "Paris";
    calls.push({ name: "test_weather", args: { city }, result: `Weather in ${city}: sunny`, turnIndex: 0 });
  }
  return calls;
}

function turnCountForScenario(scenario: Scenario): number {
  return "turns" in scenario ? scenario.turns.length : 1;
}

function eventCount(events: CmsObservedEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function addEvent(events: CmsObservedEvent[], type: string, metadata?: Record<string, unknown>): void {
  events.push(metadata ? { type, metadata } : { type });
}

function addMissingEvent(events: CmsObservedEvent[], type: string, metadata?: Record<string, unknown>): void {
  if (eventCount(events, type) === 0) addEvent(events, type, metadata);
}

function synthesizeDefaultCmsEvents(scenario: Scenario, toolCalls: ObservedToolCall[]): CmsObservedEvent[] {
  const events: CmsObservedEvent[] = [];
  const turnCount = turnCountForScenario(scenario);
  for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
    addEvent(events, "user.message", { turnIndex });
    addEvent(events, "session.turn_started", { turnIndex });
    for (const call of toolCalls.filter((entry) => (entry.turnIndex ?? 0) === turnIndex)) {
      addEvent(events, "tool.execution_start", { toolName: call.name, arguments: call.args, turnIndex });
      if (call.name === "wait") {
        addEvent(events, "session.wait_started", { toolName: call.name, arguments: call.args, turnIndex });
        addEvent(events, "session.dehydrated", { turnIndex });
        addEvent(events, "session.hydrated", { turnIndex });
        addEvent(events, "session.wait_completed", { toolName: call.name, result: call.result, turnIndex });
      }
      if (call.name === "spawn_agent") addEvent(events, "session.agent_spawned", { arguments: call.args, turnIndex });
      addEvent(events, "tool.execution_complete", { toolName: call.name, result: call.result, turnIndex });
    }
    addEvent(events, "assistant.message", { turnIndex });
    addEvent(events, "session.turn_completed", { turnIndex });
  }
  return events;
}

function synthesizeCmsEvents(
  scenario: Scenario,
  toolCalls: ObservedToolCall[],
  provided?: CmsObservedEvent[],
): CmsObservedEvent[] {
  const hasProvidedEvents = Boolean(provided?.length);
  const events = hasProvidedEvents ? [...provided!] : synthesizeDefaultCmsEvents(scenario, toolCalls);
  const checks = checksForScenario(scenario);

  for (const check of checks) {
    if (check.type === "cms-events-contain") {
      for (const type of check.events) addMissingEvent(events, type);
    }
    if (check.type === "cms-events-order") {
      addMissingEvent(events, check.before);
      addMissingEvent(events, check.after);
    }
    if (check.type === "cms-event-count" && check.min != null) {
      while (eventCount(events, check.event) < check.min) addEvent(events, check.event);
    }
  }

  if (!hasProvidedEvents) {
    for (let turnIndex = eventCount(events, "user.message"); turnIndex < turnCountForScenario(scenario); turnIndex += 1) {
      addEvent(events, "user.message", { turnIndex });
    }
    for (let turnIndex = eventCount(events, "session.turn_started"); turnIndex < turnCountForScenario(scenario); turnIndex += 1) {
      addEvent(events, "session.turn_started", { turnIndex });
    }
  }

  return events;
}

function responseFromChecks(scenario: Scenario): string | undefined {
  const phrases = checksForScenario(scenario)
    .filter((check) => check.type === "response-contains")
    .flatMap((check) => [...(check.all ?? []), ...(check.any?.slice(0, 1) ?? [])])
    .filter(Boolean);
  if (phrases.length === 0) return undefined;
  return `Completed. ${phrases.join(" ")}`;
}

function turnResponsesFromChecks(scenario: Scenario): string[] | undefined {
  if (!("turns" in scenario)) return undefined;
  return scenario.turns.map((turn) => {
    const phrases = turn.checks
      .filter((check) => check.type === "response-contains")
      .flatMap((check) => [...(check.all ?? []), ...(check.any?.slice(0, 1) ?? [])])
      .filter(Boolean);
    return phrases.length > 0 ? `Completed. ${phrases.join(" ")}` : `Completed. ${turn.input.prompt}`;
  });
}

export function fakeObservedResult(scenario: Scenario): ObservedResult {
  const fake = fakeMetadata(scenario);
  const toolCalls = (fake.toolCalls as ObservedToolCall[] | undefined) ?? inferToolCalls(scenario);
  const prompt = promptForScenario(scenario);
  const turnResponses = (fake.turnResponses as string[] | undefined) ?? turnResponsesFromChecks(scenario);
  const finalResponse = (fake.finalResponse as string | undefined)
    ?? turnResponses?.at(-1)
    ?? responseFromChecks(scenario)
    ?? (toolCalls.length ? `Completed. Final answer: ${toolCalls.at(-1)?.result ?? "ok"}` : `Completed. ${prompt}`);
  return {
    scenarioId: scenario.id,
    finalResponse,
    toolCalls,
    cmsEvents: synthesizeCmsEvents(scenario, toolCalls, fake.cmsEvents as ObservedResult["cmsEvents"] | undefined),
    latencyMs: (fake.latencyMs as number | undefined) ?? 1,
    costUsd: (fake.costUsd as number | undefined) ?? 0,
    tokensIn: (fake.tokensIn as number | undefined) ?? prompt.split(/\s+/).filter(Boolean).length,
    tokensOut: (fake.tokensOut as number | undefined) ?? finalResponse.split(/\s+/).filter(Boolean).length,
    terminalState: (fake.terminalState as string | undefined) ?? "completed",
    errored: (fake.errored as boolean | undefined) ?? false,
    metadata: { driver: "fake", ...(turnResponses ? { turnResponses } : {}) }
  };
}

export function fakeDriverFactory(): Driver {
  return {
    async run(scenario) {
      return fakeObservedResult(scenario);
    }
  };
}
