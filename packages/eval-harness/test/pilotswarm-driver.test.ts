import { describe, expect, it } from "vitest";
import { createPilotSwarmDriver } from "../src/drivers/pilotswarm.js";
import type { Scenario } from "../src/types.js";

describe("attach driver", () => {
  it("uses an already-running worker through the client and derives observations from CMS events", async () => {
    const prompts: string[] = [];
    const sessionConfigs: Array<Record<string, unknown> | undefined> = [];

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(config?: Record<string, unknown>): Promise<{
        sessionId: string;
        sendAndWait: (prompt: string) => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<Array<{ eventType: string; createdAt: string; data?: Record<string, unknown> }>>;
      }> {
        sessionConfigs.push(config);
        return {
          sessionId: "session-existing-worker",
          async sendAndWait(prompt: string) {
            prompts.push(prompt);
            return prompt.includes("weather") ? "Osaka weather is sunny" : "remembered Osaka";
          },
          async getInfo() {
            return { status: "idle" };
          },
          async getMessages() {
            return [
              { eventType: "session.turn_started", createdAt: "2026-05-18T00:00:00.000Z" },
              { eventType: "session.turn_completed", createdAt: "2026-05-18T00:00:01.000Z" },
              { eventType: "session.turn_started", createdAt: "2026-05-18T00:00:02.000Z" },
              {
                eventType: "tool.execution_start",
                createdAt: "2026-05-18T00:00:03.000Z",
                data: {
                  toolName: "wait",
                  arguments: { seconds: 2 },
                  toolCallId: "call_wait",
                },
              },
              {
                eventType: "tool.execution_start",
                createdAt: "2026-05-18T00:00:04.000Z",
                data: {
                  toolName: "report_intent",
                  arguments: { intent: "test" },
                  toolCallId: "call_intent",
                },
              },
              { eventType: "session.turn_completed", createdAt: "2026-05-18T00:00:05.000Z" },
            ];
          },
        };
      }
    }

    const scenario: Scenario = {
      schemaVersion: 1,
      kind: "multi-turn",
      id: "pilotswarm.existing-worker",
      description: "Use an existing worker.",
      tools: ["incident_lookup"],
      turns: [
        { input: { prompt: "Remember Osaka." }, checks: [] },
        { input: { prompt: "Use wait for 2 seconds, then tell me the weather." }, checks: [] },
      ],
      checks: [],
    };

    const driver = createPilotSwarmDriver({ ClientCtor: FakeClient });
    const observed = await driver.run(scenario, { config: { defaults: { driver: "pilotswarm" } } });

    expect(prompts).toEqual(["Remember Osaka.", "Use wait for 2 seconds, then tell me the weather."]);
    expect(sessionConfigs[0]).toMatchObject({ toolNames: ["incident_lookup"] });
    expect(observed.finalResponse).toBe("Osaka weather is sunny");
    expect(observed.terminalState).toBe("idle");
    expect(observed.metadata).toMatchObject({ driver: "attach", legacyDriver: "pilotswarm", sessionId: "session-existing-worker" });
    expect(observed.cmsEvents.map((event) => event.type)).toContain("tool.execution_start");
    expect(observed.toolCalls).toEqual([
      { name: "wait", args: { seconds: 2 }, callId: "call_wait", turnIndex: 1 },
    ]);
  });
});
