import { describe, expect, it } from "vitest";
import { mergeToolCalls, toolCallsFromCmsEvents } from "../src/drivers/observations.js";

describe("observation normalization", () => {
  it("filters internal management tools from CMS-derived tool calls", () => {
    const calls = toolCallsFromCmsEvents([
      { type: "session.turn_started", metadata: { iteration: 0 } },
      { type: "tool.execution_start", metadata: { toolName: "wait", arguments: { seconds: 2 }, toolCallId: "wait-1" } },
      { type: "tool.execution_start", metadata: { toolName: "report_intent", arguments: {}, toolCallId: "intent-1" } },
      { type: "session.turn_started", metadata: { iteration: 1 } },
      { type: "tool.execution_start", metadata: { toolName: "store_fact", arguments: {}, toolCallId: "store-1" } },
      { type: "tool.execution_start", metadata: { toolName: "read_facts", arguments: {}, toolCallId: "read-1" } },
      { type: "tool.execution_start", metadata: { toolName: "update_session_summary", arguments: {}, toolCallId: "summary-1" } },
      { type: "tool.execution_start", metadata: { toolName: "test_add", arguments: { a: 6, b: 8 }, toolCallId: "add-1" } },
    ]);

    expect(calls).toEqual([
      { name: "wait", args: { seconds: 2 }, callId: "wait-1", turnIndex: 0 },
      { name: "test_add", args: { a: 6, b: 8 }, callId: "add-1", turnIndex: 1 },
    ]);
  });

  it("does not merge CMS calls with defined args into handler calls with undefined args", () => {
    expect(mergeToolCalls([
      { name: "test_add", args: { a: 1 }, callId: "cms-1" },
      { name: "test_add", callId: "cms-2" },
    ], [
      { name: "test_add", result: "undefined-args-result" },
      { name: "test_add", args: { a: 1 }, result: "defined-args-result" },
    ])).toEqual([
      { name: "test_add", args: { a: 1 }, callId: "cms-1", result: "defined-args-result" },
      { name: "test_add", callId: "cms-2", result: "undefined-args-result" },
    ]);
  });
});
