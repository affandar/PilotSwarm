import { describe, expect, it } from "vitest";
import { listRegisteredAgentsDedup, listRegisteredAgentsShim } from "../../src/engine/agent-inventory.js";

describe("agent inventory shim", () => {
  it("walks private worker fields and marks only app-creatable entries overridable", () => {
    const worker = {
      _frameworkBasePrompt: "framework",
      _appDefaultPrompt: "app",
      _loadedSystemAgents: [
        { name: "sweeper", namespace: "pilotswarm", description: "Sweep", tools: ["x"], splash: "S", system: true }
      ],
      _rawLoadedAgents: [
        { name: "incident-conductor", namespace: "app", description: "Old", prompt: "a", tools: ["test_weather"] },
        { name: "incident-conductor", namespace: "app", description: "New", prompt: "b", tools: ["test_weather", "slow_tool"] }
      ]
    };

    expect(listRegisteredAgentsShim(worker).map((a) => [a.name, a.tier, a.isOverridable])).toEqual([
      ["default", "framework-base", false],
      ["default", "app-default", false],
      ["sweeper", "system-managed", false],
      ["incident-conductor", "app-creatable", true],
      ["incident-conductor", "app-creatable", true]
    ]);

    expect(listRegisteredAgentsDedup(worker)).toMatchObject([
      { name: "default", tier: "app-default", isOverridable: false },
      { name: "sweeper", tier: "system-managed", isOverridable: false },
      { name: "incident-conductor", tier: "app-creatable", description: "New", isOverridable: true }
    ]);
  });
});
