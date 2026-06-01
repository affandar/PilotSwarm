import type { CmsObservedEvent, ObservedToolCall, Scenario } from "../types.js";

export function promptsForScenario(scenario: Scenario): string[] {
  if ("turns" in scenario) return scenario.turns.map((turn) => turn.input.prompt);
  return [scenario.input.prompt];
}

export function normalizeCmsEvents(events: unknown): CmsObservedEvent[] {
  if (!Array.isArray(events)) return [];
  return events.map((event) => {
    const record = event && typeof event === "object" ? event as Record<string, unknown> : {};
    const rawMetadata = typeof record.data === "object" && record.data != null ? record.data as Record<string, unknown> : undefined;
    const metadata = normalizeEventMetadata(rawMetadata);
    return {
      type: String(record.type ?? record.eventType ?? "unknown"),
      timestamp: typeof record.createdAt === "string" ? record.createdAt : undefined,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
      metadata,
    };
  });
}

function normalizeEventMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  if (typeof metadata.turnIndex === "number") return metadata;
  if (typeof metadata.iteration === "number") {
    return { ...metadata, turnIndex: metadata.iteration };
  }
  if (typeof metadata.turn === "number") {
    return { ...metadata, turnIndex: metadata.turn };
  }
  const nested = metadata.metadata;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedMetadata = nested as Record<string, unknown>;
    if (typeof nestedMetadata.turnIndex === "number") {
      return { ...metadata, ...nestedMetadata, metadata: nestedMetadata, turnIndex: nestedMetadata.turnIndex };
    }
    if (typeof nestedMetadata.iteration === "number") {
      return { ...metadata, ...nestedMetadata, metadata: nestedMetadata, turnIndex: nestedMetadata.iteration };
    }
    if (typeof nestedMetadata.turn === "number") {
      return { ...metadata, ...nestedMetadata, metadata: nestedMetadata, turnIndex: nestedMetadata.turn };
    }
  }
  return metadata;
}

export function toolCallsFromCmsEvents(events: CmsObservedEvent[]): ObservedToolCall[] {
  return events
    .filter((event) => event.type === "tool.execution_start")
    .map((event, index) => {
      const metadata = event.metadata ?? {};
      return {
        name: String(metadata.toolName ?? metadata.name ?? "unknown"),
        args: metadata.arguments,
        callId: typeof metadata.toolCallId === "string" ? metadata.toolCallId : undefined,
        turnIndex: turnIndexBeforeEvent(events, event, index),
      };
    })
    .filter((call) => !INTERNAL_TOOL_CALLS.has(call.name));
}

const INTERNAL_TOOL_CALLS = new Set(["read_facts", "report_intent", "store_fact", "update_session_summary"]);

export function mergeToolCalls(cmsCalls: ObservedToolCall[], handlerCalls: ObservedToolCall[]): ObservedToolCall[] {
  const remaining = [...handlerCalls];
  const merged = cmsCalls.map((call) => {
    const matchIndex = remaining.findIndex((candidate) => candidate.name === call.name && sameArgs(candidate.args, call.args));
    if (matchIndex < 0) return call;
    const [handlerCall] = remaining.splice(matchIndex, 1);
    return {
      ...call,
      args: handlerCall?.args ?? call.args,
      result: handlerCall?.result,
      turnIndex: call.turnIndex ?? handlerCall?.turnIndex,
    };
  });
  return [...merged, ...remaining];
}

function sameArgs(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function turnIndexBeforeEvent(events: CmsObservedEvent[], target: CmsObservedEvent, fallback: number): number {
  const eventIndex = events.indexOf(target);
  if (eventIndex < 0) return fallback;
  return Math.max(0, events.slice(0, eventIndex).filter((event) => event.type === "session.turn_started").length - 1);
}
