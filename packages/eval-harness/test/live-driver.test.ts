import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z4 } from "zod/v4";
import { createLiveDriver, resolveCreateEnv } from "../src/drivers/live.js";
import { registerTool } from "../src/registry.js";
import type { Scenario } from "../src/types.js";

describe("live driver", () => {
  it("ships a packaged default live environment factory", async () => {
    const createEnv = await resolveCreateEnv();
    const env = createEnv("packaged_default_live");

    expect(env.store).toContain("postgresql://");
    expect(env.duroxideSchema).toMatch(/^ps_eval_duroxide_packaged_default_live_/);
    expect(env.cmsSchema).toMatch(/^ps_eval_cms_packaged_default_live_/);
    expect(env.factsSchema).toMatch(/^ps_eval_facts_packaged_default_live_/);
    expect(env.sessionStateDir).toContain("session-state");
    await env.cleanup?.();
  });

  it("runs through a PilotSwarm worker/client pair and records tool observations", async () => {
    let registeredTools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> | unknown }> = [];

    class FakeWorker {
      registerTools(tools: typeof registeredTools): void {
        registeredTools = tools;
      }
      setSessionConfig(): void {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: (prompt: string) => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<Array<{ eventType: string; createdAt: string }>>;
      }> {
        return {
          sessionId: "session-live-unit",
          async sendAndWait() {
            const add = registeredTools.find((tool) => tool.name === "test_add");
            const result = await add?.handler({ a: 17, b: 25 });
            return String(result);
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [
              { eventType: "session.turn_started", createdAt: "2026-05-18T00:00:00.000Z" },
              { eventType: "session.turn_completed", createdAt: "2026-05-18T00:00:01.000Z" },
            ];
          },
        };
      }
    }

    const driver = createLiveDriver({
      createEnv: () => ({
        store: "postgresql://unit",
        duroxideSchema: "duro",
        cmsSchema: "cms",
        factsSchema: "facts",
        sessionStateDir: "/tmp/eval-live-unit",
        cleanup: async () => {},
      }),
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });
    const scenario: Scenario = {
      schemaVersion: 1,
      kind: "single-turn",
      id: "live.add",
      description: "Live add.",
      tools: ["test_add"],
      input: { prompt: "Add 17 and 25 with test_add. Report the result." },
      checks: [{ type: "tool-call", name: "test_add", args: { a: 17, b: 25 }, match: "subset" }]
    };

    const observed = await driver.run(scenario, { config: { defaults: { driver: "live" } } });

    expect(observed.errored).toBe(false);
    expect(observed.finalResponse).toContain("42");
    expect(observed.toolCalls).toEqual([
      { name: "test_add", args: { a: 17, b: 25 }, result: 42, turnIndex: 0 }
    ]);
    expect(observed.cmsEvents.map((event) => event.type)).toEqual(["session.turn_started", "session.turn_completed"]);
  });

  it("passes registered tool schemas to live SDK tool definitions", async () => {
    registerTool({
      name: "unit_incident_lookup",
      description: "Look up an incident",
      schema: z.object({
        incidentId: z.string(),
        includeTimeline: z.boolean().default(false),
      }),
      handler: () => ({ owner: "checkout" }),
    });

    let registeredTools: Array<{
      name: string;
      parameters?: Record<string, unknown>;
      handler: (args: unknown) => Promise<unknown> | unknown;
    }> = [];

    class FakeWorker {
      registerTools(tools: typeof registeredTools): void {
        registeredTools = tools;
      }
      setSessionConfig(): void {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: () => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<[]>;
      }> {
        return {
          sessionId: "session-schema-unit",
          async sendAndWait() {
            const lookup = registeredTools.find((tool) => tool.name === "unit_incident_lookup");
            await lookup?.handler({ incidentId: "INC-42", includeTimeline: true });
            return "checkout";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [];
          },
        };
      }
    }

    const driver = createLiveDriver({
      createEnv: () => ({
        store: "postgresql://unit",
        duroxideSchema: "duro",
        cmsSchema: "cms",
        factsSchema: "facts",
        sessionStateDir: "/tmp/eval-live-schema-unit",
        cleanup: async () => {},
      }),
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });
    const scenario: Scenario = {
      schemaVersion: 1,
      kind: "single-turn",
      id: "live.schema",
      description: "Live schema.",
      tools: ["unit_incident_lookup"],
      input: { prompt: "Look up INC-42." },
      checks: [{ type: "tool-call", name: "unit_incident_lookup" }],
    };

    const observed = await driver.run(scenario, { config: { defaults: { driver: "live" } } });

    expect(observed.errored).toBe(false);
    expect(registeredTools[0]?.parameters).toMatchObject({
      type: "object",
      properties: {
        incidentId: { type: "string" },
        includeTimeline: { type: "boolean" },
      },
      required: ["incidentId"],
      additionalProperties: false,
    });
  });

  it("passes Zod v4-style registered tool schemas to live SDK tool definitions", async () => {
    registerTool({
      name: "unit_v4_incident_update",
      description: "Update an incident",
      schema: z4.object({
        incidentId: z4.string(),
        retries: z4.number().int().default(1),
        notify: z4.boolean().optional(),
        priority: z4.enum(["sev1", "sev2"]),
        source: z4.literal("pager"),
        tags: z4.array(z4.string()).optional(),
        note: z4.string().nullable(),
        normalized: z4.string().transform((value) => value.trim()),
      }),
      handler: () => ({ ok: true }),
    });

    let registeredTools: Array<{
      name: string;
      parameters?: Record<string, unknown>;
      handler: (args: unknown) => Promise<unknown> | unknown;
    }> = [];

    class FakeWorker {
      registerTools(tools: typeof registeredTools): void {
        registeredTools = tools;
      }
      setSessionConfig(): void {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: () => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<[]>;
      }> {
        return {
          sessionId: "session-v4-schema-unit",
          async sendAndWait() {
            const update = registeredTools.find((tool) => tool.name === "unit_v4_incident_update");
            await update?.handler({
              incidentId: "INC-42",
              priority: "sev1",
              source: "pager",
              note: null,
              normalized: "trim me",
            });
            return "updated";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [];
          },
        };
      }
    }

    const driver = createLiveDriver({
      createEnv: () => ({
        store: "postgresql://unit",
        duroxideSchema: "duro",
        cmsSchema: "cms",
        factsSchema: "facts",
        sessionStateDir: "/tmp/eval-live-v4-schema-unit",
        cleanup: async () => {},
      }),
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });
    const scenario: Scenario = {
      schemaVersion: 1,
      kind: "single-turn",
      id: "live.v4-schema",
      description: "Live Zod v4 schema.",
      tools: ["unit_v4_incident_update"],
      input: { prompt: "Update INC-42." },
      checks: [{ type: "tool-call", name: "unit_v4_incident_update" }],
    };

    const observed = await driver.run(scenario, { config: { defaults: { driver: "live" } } });

    expect(observed.errored).toBe(false);
    expect(registeredTools[0]?.parameters).toMatchObject({
      type: "object",
      properties: {
        incidentId: { type: "string" },
        retries: { type: "integer" },
        notify: { type: "boolean" },
        priority: { type: "string", enum: ["sev1", "sev2"] },
        source: { const: "pager" },
        tags: { type: "array", items: { type: "string" } },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        normalized: { type: "string" },
      },
      required: ["incidentId", "priority", "source", "note", "normalized"],
      additionalProperties: false,
    });
  });

  it("runs public live multi-turn scenarios one turn at a time", async () => {
    const prompts: string[] = [];

    class FakeWorker {
      registerTools(): void {}
      setSessionConfig(): void {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: (prompt: string) => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<Array<{ eventType: string; createdAt: string; data?: Record<string, unknown> }>>;
      }> {
        return {
          sessionId: "session-multi-turn",
          async sendAndWait(prompt) {
            prompts.push(prompt);
            return prompts.length === 1 ? "Stored riverglass-42." : "CODE PHRASE: riverglass-42";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return prompts.flatMap((prompt, index) => [
              {
                eventType: "session.turn_started",
                createdAt: `2026-05-18T00:00:0${index}.000Z`,
                data: { prompt, metadata: { iteration: index } },
              },
              {
                eventType: "session.turn_completed",
                createdAt: `2026-05-18T00:00:0${index}.500Z`,
                data: { metadata: { iteration: index } },
              },
            ]);
          },
        };
      }
    }

    const driver = createLiveDriver({
      createEnv: () => ({
        store: "postgresql://unit",
        duroxideSchema: "duro",
        cmsSchema: "cms",
        factsSchema: "facts",
        sessionStateDir: "/tmp/eval-live-multi-turn-unit",
        cleanup: async () => {},
      }),
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });
    const scenario: Scenario = {
      schemaVersion: 1,
      kind: "multi-turn",
      id: "live.multi-turn",
      description: "Live multi-turn.",
      turns: [
        { input: { prompt: "Remember riverglass-42." }, checks: [{ type: "response-contains", all: ["Stored"] }] },
        { input: { prompt: "Recall it." }, checks: [{ type: "response-contains", all: ["riverglass-42"] }] },
      ],
      checks: [{ type: "response-contains", all: ["riverglass-42"] }],
    };

    const observed = await driver.run(scenario, { config: { defaults: { driver: "live" } } });

    expect(prompts).toEqual(["Remember riverglass-42.", "Recall it."]);
    expect(observed.finalResponse).toBe("CODE PHRASE: riverglass-42");
    expect(observed.metadata?.turnResponses).toEqual(["Stored riverglass-42.", "CODE PHRASE: riverglass-42"]);
    expect(observed.cmsEvents.map((event) => event.metadata?.turnIndex)).toEqual([0, 0, 1, 1]);
    expect(observed.cmsEvents.map((event) => event.metadata?.iteration)).toEqual([0, 0, 1, 1]);
  });
});
