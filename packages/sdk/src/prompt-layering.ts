import type { SerializableSessionConfig } from "./types.js";

export type PromptLayeringKind = NonNullable<SerializableSessionConfig["promptLayering"]>["kind"];

export interface ComposeSystemPromptOptions {
    frameworkBase?: string | null;
    appDefault?: string | null;
    activeAgentPrompt?: string | null;
    runtimeContext?: string | null;
    includeAppDefault?: boolean;
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

export function composeSystemPrompt(options: ComposeSystemPromptOptions): string | undefined {
    const sections: string[] = [];
    const frameworkBase = normalizeSection(options.frameworkBase);
    const appDefault = options.includeAppDefault === false ? undefined : normalizeSection(options.appDefault);
    const activeAgentPrompt = normalizeSection(options.activeAgentPrompt);
    const runtimeContext = normalizeSection(options.runtimeContext);

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
