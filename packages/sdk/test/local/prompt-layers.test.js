import { describe, it, expect } from "vitest";
import { renderPromptLayerManifest, buildPromptLayersEventPayload } from "../../src/prompt-layers.ts";

describe("prompt layer manifest", () => {
    const layers = [
        {
            layerKind: "pilotswarm_base",
            layerId: "pilotswarm:default",
            name: "default",
            type: "system",
            schemaVersion: "pilotswarm.agent.v1",
            version: "1.0.0",
        },
        {
            layerKind: "app_base",
            layerId: "fixture:default",
            name: "default",
            type: "app",
            schemaVersion: "pilotswarm.agent.v1",
            version: "2.0.0",
        },
        {
            layerKind: "agent",
            layerId: "fixture:analyst",
            name: "analyst",
            type: "app",
            schemaVersion: "pilotswarm.agent.v1",
            version: "1.2.3",
        },
    ];

    it("renders before authored prompt bodies with layer versions", () => {
        const manifest = renderPromptLayerManifest(layers);
        expect(manifest).toContain("# PilotSwarm Prompt Layer Manifest");
        expect(manifest).toContain("pilotswarm_base: pilotswarm:default");
        expect(manifest).toContain("schema=pilotswarm.agent.v1");
        expect(manifest).toContain("version=1.2.3");
    });

    it("builds session.prompt_layers payloads", () => {
        expect(buildPromptLayersEventPayload(layers)).toEqual({ schemaVersion: 1, layers });
    });
});
