/**
 * Authored prompt layer descriptors and manifest composition.
 *
 * Implements the v1 surface from the "Agent Layer Versioning" proposal:
 *
 *   - typed descriptor for each authored prompt layer
 *     (PilotSwarm base, app base, active agent)
 *   - compact in-prompt manifest text rendered above the framework header
 *   - JSON-serializable payload for the `session.prompt_layers` event
 *
 * Runtime context (sub-agent injection, rehydration overlays) is NOT a
 * versioned agent layer in v1. Its behavior is governed by the orchestration
 * version and session/runtime metadata.
 *
 * @module
 */

export type PromptLayerKind = "pilotswarm_base" | "app_base" | "agent";
export type PromptLayerType = "system" | "app";

export interface PromptLayerDescriptor {
    /** Authored role of the layer in the precedence stack. */
    layerKind: PromptLayerKind;
    /** Stable identifier suitable for log/event correlation. */
    layerId: string;
    /** Author-facing name (matches `.agent.md` frontmatter `name`). */
    name: string;
    /** Schema family the frontmatter was authored against. */
    schemaVersion: string;
    /** Author-supplied version string (recommended SemVer for system layers). */
    version: string;
    /** Whether this layer was authored by PilotSwarm/system or by an app/user. */
    type: PromptLayerType;
    /** Optional source path or namespace for diagnostics. */
    source?: string;
}

const SCHEMA_PREFIX = "pilotswarm.agent.v";

/** Build the canonical schema identifier (`pilotswarm.agent.v{n}`). */
export function buildSchemaIdentifier(schemaVersion: number | string | undefined | null): string {
    if (schemaVersion === "inline" || schemaVersion === "legacy") return schemaVersion;
    const n = typeof schemaVersion === "number" && Number.isFinite(schemaVersion) && schemaVersion > 0
        ? Math.floor(schemaVersion)
        : 1;
    return `${SCHEMA_PREFIX}${n}`;
}

/** Compose the human-readable prompt-layer manifest text. */
export function renderPromptLayerManifest(layers: ReadonlyArray<PromptLayerDescriptor>): string | undefined {
    if (!layers || layers.length === 0) return undefined;
    const lines: string[] = [
        "# PilotSwarm Prompt Layer Manifest",
        "This session is composed from the following instruction layers. Higher-priority layers appear first. Use this manifest for debugging and compatibility awareness; follow the instruction precedence rules in the layer headers.",
        "",
    ];
    for (const layer of layers) {
        lines.push(
            `- ${layer.layerKind}: ${layer.layerId} name=${layer.name} type=${layer.type} schema=${layer.schemaVersion} version=${layer.version}`,
        );
    }
    return lines.join("\n");
}

/** Stable, JSON-serializable payload for the `session.prompt_layers` event. */
export interface PromptLayersEventPayload {
    schemaVersion: 1;
    layers: PromptLayerDescriptor[];
}

export function buildPromptLayersEventPayload(layers: ReadonlyArray<PromptLayerDescriptor>): PromptLayersEventPayload {
    return { schemaVersion: 1, layers: layers.map(l => ({ ...l })) };
}
