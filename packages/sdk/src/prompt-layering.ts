import type {
    SectionOverride,
    SystemMessageConfig,
    SystemMessageCustomizeConfig,
    SystemMessageSection,
} from "@github/copilot-sdk";
import type { SerializableSessionConfig } from "./types.js";
import type { PromptLayerDescriptor } from "./prompt-layers.js";
import { renderPromptLayerManifest } from "./prompt-layers.js";

export type PromptLayeringKind = NonNullable<SerializableSessionConfig["promptLayering"]>["kind"];

export interface ComposeSystemPromptOptions {
    frameworkBase?: string | null;
    appDefault?: string | null;
    activeAgentPrompt?: string | null;
    runtimeContext?: string | null;
    includeAppDefault?: boolean;
    /** Optional authored layer descriptors. When present, a layer manifest is rendered above the framework header. */
    layerManifest?: ReadonlyArray<PromptLayerDescriptor> | null;
}

export interface ComposeStructuredSystemMessageOptions extends ComposeSystemPromptOptions {
    additionalSections?: Partial<Record<SystemMessageSection, SectionOverride>>;
    additionalContent?: string | null;
}

const FRAMEWORK_HEADER = [
    "# PilotSwarm Framework Instructions",
    "These instructions are authoritative and highest priority.",
    "If any later section conflicts with this section, follow this section.",
].join("\n");

const APP_HEADER = [
    "# Application Default Instructions",
    "The following section contains additional application-level instructions.",
    "Follow them unless they conflict with the PilotSwarm Framework Instructions above.",
].join("\n");

const ACTIVE_AGENT_HEADER = [
    "# Active Agent Instructions",
    "The following section defines the role-specific behavior for this session.",
    "Follow it unless it conflicts with any section above.",
].join("\n");

const RUNTIME_HEADER = [
    "# Runtime Context",
    "This section contains session-specific operational context.",
    "Use it unless it conflicts with any section above.",
].join("\n");

function normalizeSection(content?: string | null): string | undefined {
    const value = (content ?? "").trim();
    return value || undefined;
}

export function mergePromptSections(parts: Array<string | null | undefined>): string | undefined {
    const normalized = parts
        .map(part => normalizeSection(part))
        .filter((part): part is string => Boolean(part));
    if (normalized.length === 0) return undefined;
    return normalized.join("\n\n");
}

export function extractPromptContent(
    message?: string | { mode: "append" | "replace"; content: string } | null,
): string | undefined {
    if (!message) return undefined;
    if (typeof message === "string") return normalizeSection(message);
    return normalizeSection(message.content);
}

export function buildPromptLayerSections(
    options: ComposeSystemPromptOptions,
): Partial<Record<SystemMessageSection, SectionOverride>> {
    const sections: Partial<Record<SystemMessageSection, SectionOverride>> = {};
    const frameworkBase = normalizeSection(options.frameworkBase);
    const appDefault = options.includeAppDefault === false ? undefined : normalizeSection(options.appDefault);
    const activeAgentPrompt = normalizeSection(options.activeAgentPrompt);
    const runtimeContext = normalizeSection(options.runtimeContext);
    const lastInstructions = mergePromptSections([activeAgentPrompt, runtimeContext]);
    const manifest = options.layerManifest && options.layerManifest.length > 0
        ? renderPromptLayerManifest(options.layerManifest)
        : undefined;

    if (frameworkBase) {
        // Prepend the manifest above the framework base so the model sees the
        // authored layer stack at the top of the highest-priority section.
        const content = manifest ? `${manifest}\n\n${frameworkBase}` : frameworkBase;
        sections.custom_instructions = { action: "replace", content };
    } else if (manifest) {
        sections.custom_instructions = { action: "replace", content: manifest };
    }
    if (appDefault) {
        sections.guidelines = { action: "append", content: appDefault };
    }
    if (lastInstructions) {
        sections.last_instructions = { action: "replace", content: lastInstructions };
    }

    return sections;
}

export function composeStructuredSystemMessage(
    options: ComposeStructuredSystemMessageOptions,
): SystemMessageConfig | undefined {
    const sections = {
        ...buildPromptLayerSections(options),
        ...(options.additionalSections ?? {}),
    };
    const hasSections = Object.keys(sections).length > 0;
    const additionalContent = normalizeSection(options.additionalContent);

    if (!hasSections && !additionalContent) return undefined;

    const message: SystemMessageCustomizeConfig = {
        mode: "customize",
        ...(hasSections ? { sections } : {}),
        ...(additionalContent ? { content: additionalContent } : {}),
    };
    return message;
}

export function composeSystemPrompt(options: ComposeSystemPromptOptions): string | undefined {
    const sections: string[] = [];
    const frameworkBase = normalizeSection(options.frameworkBase);
    const appDefault = options.includeAppDefault === false ? undefined : normalizeSection(options.appDefault);
    const activeAgentPrompt = normalizeSection(options.activeAgentPrompt);
    const runtimeContext = normalizeSection(options.runtimeContext);
    const manifest = options.layerManifest && options.layerManifest.length > 0
        ? renderPromptLayerManifest(options.layerManifest)
        : undefined;

    if (manifest) {
        sections.push(manifest);
    }
    if (frameworkBase) {
        sections.push(`${FRAMEWORK_HEADER}\n\n${frameworkBase}`);
    }
    if (appDefault) {
        sections.push(`${APP_HEADER}\n\n<APPLICATION_DEFAULT>\n${appDefault}\n</APPLICATION_DEFAULT>`);
    }
    if (activeAgentPrompt) {
        sections.push(`${ACTIVE_AGENT_HEADER}\n\n<ACTIVE_AGENT>\n${activeAgentPrompt}\n</ACTIVE_AGENT>`);
    }
    if (runtimeContext) {
        sections.push(`${RUNTIME_HEADER}\n\n<RUNTIME_CONTEXT>\n${runtimeContext}\n</RUNTIME_CONTEXT>`);
    }

    return sections.length > 0 ? sections.join("\n\n") : undefined;
}
