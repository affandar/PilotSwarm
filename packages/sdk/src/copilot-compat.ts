/**
 * Copilot CLI compatibility profile — Layer A (SDK side).
 *
 * Design: d:/git/waldemort/myplans/copilot-cli-compat/copilot-cli-compat-design.md
 *
 * Everything here is opt-in. With the profile disabled the module contributes no
 * serialized config keys, no diagnostics, and no changes to tool resolution.
 *
 * @module
 */

// ─── Profile ────────────────────────────────────────────────────

export type CompatibilityProfileName = "copilot-cli";

export const COPILOT_CLI_PROFILE: CompatibilityProfileName = "copilot-cli";

/** Schema version for the serialized compatibility fields. */
export const COMPATIBILITY_SCHEMA_VERSION = 1 as const;

// ─── Serializable compat state ──────────────────────────────────

export type WorkspaceBindingStatus = "uncreated" | "ready" | "lost";

export interface WorkspaceBinding {
    provider: "waldemort-work-pod";
    workspaceId: string;
    ownerSessionId: string;
    ownerAgentId?: string;
    rootPath: "/workspace";
    namespace: string;
    podName?: string;
    generation: number;
    status: WorkspaceBindingStatus;
    activeDeadlineSeconds: 86400;
    createdAt?: string;
    lastVerifiedAt?: string;
    lastLossDiagnostic?: string;
}

export type TodoItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
    id: string;
    title: string;
    status: TodoItemStatus;
    note?: string;
}

export interface TodoState {
    items: TodoItem[];
    updatedAt?: string;
}

export type CompatDiagnosticSeverity = "INFO" | "WARN" | "FAIL";

export interface CompatDiagnostic {
    severity: CompatDiagnosticSeverity;
    code: string;
    toolName?: string;
    action: string;
    detail: string;
    /** Rendered `[copilot-compat][...]` line, the form agents and logs see. */
    text: string;
}

/** The constant workspace root. Not model-configurable, not per-agent configurable. */
export const COMPAT_WORKSPACE_ROOT = "/workspace" as const;

export const COMPAT_WORKSPACE_ACTIVE_DEADLINE_SECONDS = 86400 as const;

// ─── Diagnostics ────────────────────────────────────────────────

export function formatCompatDiagnostic(
    severity: CompatDiagnosticSeverity,
    code: string,
    fields: Record<string, string | number | undefined>,
    detail: string,
): string {
    const rendered = Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
    const middle = rendered ? `${rendered} ` : "";
    return `[copilot-compat][${severity}][${code}] ${middle}detail=${detail}`;
}

function makeDiagnostic(
    severity: CompatDiagnosticSeverity,
    code: string,
    fields: Record<string, string | number | undefined>,
    detail: string,
): CompatDiagnostic {
    return {
        severity,
        code,
        toolName: typeof fields.tool === "string" ? fields.tool : undefined,
        action: String(fields.action ?? ""),
        detail,
        text: formatCompatDiagnostic(severity, code, fields, detail),
    };
}

// ─── Desktop-only classification table ──────────────────────────

export type DesktopOnlyCategory =
    | "extension-management"
    | "terminal-selection"
    | "notebook-editing"
    | "vscode-ui"
    | "browser-ui-automation";

interface DesktopOnlyRow {
    category: DesktopOnlyCategory;
    patterns: string[];
}

/**
 * Ordered top to bottom; first match wins. Order is load-bearing: row 1 must beat
 * `vscode/*` so `vscode/installExtension` reports `extension-management`.
 */
const DESKTOP_ONLY_ROWS: DesktopOnlyRow[] = [
    {
        category: "extension-management",
        patterns: ["vscode/installExtension", "vscode/uninstallExtension", "vscode/listExtensions", "extension/*"],
    },
    {
        category: "terminal-selection",
        patterns: ["terminal/selection", "terminal/getSelection", "terminal/activeSelection"],
    },
    { category: "notebook-editing", patterns: ["notebook/*", "jupyter/*"] },
    { category: "vscode-ui", patterns: ["vscode/*", "workbench/*"] },
    { category: "browser-ui-automation", patterns: ["browser/*", "playwright/*", "desktop/browser/*"] },
];

/**
 * Case-sensitive whole-name match. `*` matches exactly one `/`-delimited segment;
 * `**` matches zero or more segments.
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
    const nameSegments = toolName.split("/");
    const patternSegments = pattern.split("/");

    const matchFrom = (nameIndex: number, patternIndex: number): boolean => {
        if (patternIndex === patternSegments.length) return nameIndex === nameSegments.length;
        const patternSegment = patternSegments[patternIndex];
        if (patternSegment === "**") {
            for (let candidate = nameIndex; candidate <= nameSegments.length; candidate++) {
                if (matchFrom(candidate, patternIndex + 1)) return true;
            }
            return false;
        }
        if (nameIndex >= nameSegments.length) return false;
        if (patternSegment !== "*" && patternSegment !== nameSegments[nameIndex]) return false;
        return matchFrom(nameIndex + 1, patternIndex + 1);
    };

    return matchFrom(0, 0);
}

export function classifyDesktopOnlyTool(toolName: string): DesktopOnlyCategory | null {
    for (const row of DESKTOP_ONLY_ROWS) {
        for (const pattern of row.patterns) {
            if (matchesToolPattern(toolName, pattern)) return row.category;
        }
    }
    return null;
}

// ─── Declared-tool classification ───────────────────────────────

export type CompatToolCategory =
    | "native_supported"
    | "adapter_registered"
    | "mcp_conditional"
    | "optional_unsupported_desktop"
    | "verified_unsupported"
    | "unverified_unsupported";

export interface ToolClassificationEnvironment {
    /** Names resolvable today: per-session tools, worker registry tools, configured MCP tools. */
    resolvableToolNames?: Iterable<string>;
    /** Compatibility adapters registered for the profile. */
    adapterToolNames?: Iterable<string>;
    /**
     * Tool name → MCP provider for providers this deployment knows about but has not
     * configured. Environment state, so these WARN and never abort.
     */
    unconfiguredMcpToolProviders?: Record<string, string>;
    /** Names the SDK profile has verified as unsupported. Only these may hard-abort. */
    verifiedUnsupportedToolNames?: Iterable<string>;
}

export interface ClassifiedTool {
    toolName: string;
    category: CompatToolCategory;
    severity: CompatDiagnosticSeverity;
    desktopCategory?: DesktopOnlyCategory;
    mcpProvider?: string;
    diagnostic: CompatDiagnostic;
}

export interface ClassificationResult {
    classifications: ClassifiedTool[];
    diagnostics: CompatDiagnostic[];
    /** Names that must abort session creation. Only verified-unsupported names land here. */
    fatalToolNames: string[];
}

/**
 * Classify declared tool names before PilotSwarm's resolver silently drops the
 * unresolvable ones (session-manager.ts `_resolveTools`). This turns invisible
 * capability loss into a diagnostic; it never materializes a fake tool.
 */
export function classifyDeclaredTools(
    declaredToolNames: readonly string[],
    environment: ToolClassificationEnvironment = {},
): ClassificationResult {
    const resolvable = new Set(environment.resolvableToolNames ?? []);
    const adapters = new Set(environment.adapterToolNames ?? []);
    const verifiedUnsupported = new Set(environment.verifiedUnsupportedToolNames ?? []);
    const unconfiguredMcp = environment.unconfiguredMcpToolProviders ?? {};

    const classifications: ClassifiedTool[] = [];

    for (const toolName of declaredToolNames) {
        if (resolvable.has(toolName)) {
            classifications.push({
                toolName,
                category: "native_supported",
                severity: "INFO",
                diagnostic: makeDiagnostic("INFO", "native_supported", { tool: toolName, action: "native" },
                    "Declared tool resolves to a real tool in this deployment."),
            });
            continue;
        }

        if (adapters.has(toolName)) {
            classifications.push({
                toolName,
                category: "adapter_registered",
                severity: "INFO",
                diagnostic: makeDiagnostic("INFO", "adapter_registered",
                    { tool: toolName, adapter: toolName, action: "materialized" },
                    "Declared tool is provided by a registered Copilot CLI compatibility adapter."),
            });
            continue;
        }

        const mcpProvider = unconfiguredMcp[toolName];
        if (mcpProvider) {
            classifications.push({
                toolName,
                category: "mcp_conditional",
                severity: "WARN",
                mcpProvider,
                diagnostic: makeDiagnostic("WARN", "mcp_conditional",
                    { tool: toolName, provider: mcpProvider, action: "ignored" },
                    "MCP provider is not configured in this environment; this is deployment state, not an authoring defect."),
            });
            continue;
        }

        const desktopCategory = classifyDesktopOnlyTool(toolName);
        if (desktopCategory) {
            classifications.push({
                toolName,
                category: "optional_unsupported_desktop",
                severity: "WARN",
                desktopCategory,
                diagnostic: makeDiagnostic("WARN", "optional_unsupported_desktop",
                    { tool: toolName, category: desktopCategory, action: "ignored" },
                    "Desktop-only Copilot CLI tool is unavailable in Waldemort remote sessions."),
            });
            continue;
        }

        if (verifiedUnsupported.has(toolName)) {
            classifications.push({
                toolName,
                category: "verified_unsupported",
                severity: "FAIL",
                diagnostic: makeDiagnostic("FAIL", "verified_unsupported", { tool: toolName, action: "abort" },
                    "Declared tool is on the verified unsupported list and cannot be provided."),
            });
            continue;
        }

        classifications.push({
            toolName,
            category: "unverified_unsupported",
            severity: "WARN",
            diagnostic: makeDiagnostic("WARN", "unverified_unsupported", { tool: toolName, action: "ignored" },
                "Declared tool did not resolve and is not a verified unsupported name; no tool was materialized."),
        });
    }

    return {
        classifications,
        diagnostics: classifications.map((entry) => entry.diagnostic),
        fatalToolNames: classifications
            .filter((entry) => entry.category === "verified_unsupported")
            .map((entry) => entry.toolName),
    };
}

// ─── Adapter registry ───────────────────────────────────────────

/**
 * Compatibility adapters live in their own registry so `registerTools()` keeps its
 * exact meaning: a native tool never loses to an adapter of the same name.
 */
export class CompatibilityAdapterRegistry {
    private readonly byProfile = new Map<CompatibilityProfileName, Map<string, unknown>>();

    register(profile: CompatibilityProfileName, adapters: readonly unknown[]): void {
        let profileMap = this.byProfile.get(profile);
        if (!profileMap) {
            profileMap = new Map<string, unknown>();
            this.byProfile.set(profile, profileMap);
        }
        for (const adapter of adapters) {
            const name = (adapter as { name?: unknown })?.name;
            if (typeof name !== "string" || name.length === 0) {
                throw new Error("[copilot-compat] Compatibility adapter is missing a string 'name'.");
            }
            profileMap.set(name, adapter);
        }
    }

    get(profile: CompatibilityProfileName, name: string): unknown | undefined {
        return this.byProfile.get(profile)?.get(name);
    }

    names(profile: CompatibilityProfileName): string[] {
        return [...(this.byProfile.get(profile)?.keys() ?? [])];
    }

    has(profile: CompatibilityProfileName): boolean {
        return (this.byProfile.get(profile)?.size ?? 0) > 0;
    }
}

// ─── Host-enforced bounds ───────────────────────────────────────

export interface CompatBound {
    default: number;
    maximum: number;
}

/** Design bounds table. Host config may lower a value; raising above `maximum` is refused. */
export const COPILOT_COMPAT_BOUNDS = {
    workspaceActiveDeadlineSeconds: { default: 86400, maximum: 86400 },
    executeTimeoutSeconds: { default: 60, maximum: 600 },
    executeStdoutBytes: { default: 1048576, maximum: 1048576 },
    executeStderrBytes: { default: 1048576, maximum: 1048576 },
    executeEnvKeys: { default: 0, maximum: 32 },
    executeEnvValueBytes: { default: 4096, maximum: 4096 },
    executeEnvTotalBytes: { default: 32768, maximum: 32768 },
    readMaxBytes: { default: 131072, maximum: 1048576 },
    readLines: { default: 2000, maximum: 2000 },
    editDecodedWriteBytes: { default: 8388608, maximum: 8388608 },
    searchTimeoutSeconds: { default: 30, maximum: 120 },
    searchMaxResults: { default: 100, maximum: 500 },
    searchLineBytes: { default: 4096, maximum: 4096 },
    searchTotalBytes: { default: 1048576, maximum: 1048576 },
    webTimeoutSeconds: { default: 20, maximum: 60 },
    webBodyBytes: { default: 1048576, maximum: 1048576 },
    webRedirects: { default: 3, maximum: 5 },
    agentWaitTimeoutSeconds: { default: 300, maximum: 900 },
    agentMessagesEntries: { default: 10, maximum: 10 },
    agentMessagesTotalBytes: { default: 16384, maximum: 16384 },
} as const satisfies Record<string, CompatBound>;

export type CompatBoundName = keyof typeof COPILOT_COMPAT_BOUNDS;

/**
 * Clamp a model-supplied value host-side. A non-finite or non-positive request falls
 * back to the default rather than to an unbounded value.
 */
export function clampCompatBound(boundName: CompatBoundName, requestedValue?: number): number {
    const bound: CompatBound = COPILOT_COMPAT_BOUNDS[boundName];
    if (requestedValue === undefined || !Number.isFinite(requestedValue) || requestedValue <= 0) {
        return Math.min(bound.default, bound.maximum);
    }
    return Math.min(Math.floor(requestedValue), bound.maximum);
}

// ─── Workspace binding helpers ──────────────────────────────────

export function createUncreatedWorkspaceBinding(args: {
    workspaceId: string;
    ownerSessionId: string;
    ownerAgentId?: string;
    namespace: string;
}): WorkspaceBinding {
    return {
        provider: "waldemort-work-pod",
        workspaceId: args.workspaceId,
        ownerSessionId: args.ownerSessionId,
        ...(args.ownerAgentId ? { ownerAgentId: args.ownerAgentId } : {}),
        rootPath: COMPAT_WORKSPACE_ROOT,
        namespace: args.namespace,
        generation: 0,
        status: "uncreated",
        activeDeadlineSeconds: COMPAT_WORKSPACE_ACTIVE_DEADLINE_SECONDS,
    };
}

export function isWorkspaceOwner(binding: WorkspaceBinding, sessionId: string): boolean {
    return binding.ownerSessionId === sessionId;
}

/** Diagnostic a non-owning child must return instead of recreating a parent-owned workspace. */
export function workspaceLostForNonOwnerDiagnostic(toolName: string, binding: WorkspaceBinding): CompatDiagnostic {
    return makeDiagnostic("FAIL", "workspace_lost",
        { tool: toolName, workspace: binding.workspaceId, owner: binding.ownerSessionId, action: "notify_owner" },
        "A child observed loss of a parent-owned workspace and did not recreate it.");
}

/**
 * Copies the list and each item one level down. Sufficient because every `TodoItem`
 * field is a primitive; a nested object field added later would still be shared.
 */
export function copyTodoStateItems(todoState: TodoState | undefined): TodoState | undefined {
    if (!todoState) return undefined;
    return {
        items: todoState.items.map((item) => ({ ...item })),
        ...(todoState.updatedAt ? { updatedAt: todoState.updatedAt } : {}),
    };
}

// ─── Child-config compatibility patch ───────────────────────────

/**
 * Interface the patch needs; kept structural so this module does not import the
 * orchestration types and create a cycle.
 */
export interface CompatBearingConfig {
    compatibilityProfile?: CompatibilityProfileName;
    workspaceBinding?: WorkspaceBinding;
    copilotCliTodoState?: TodoState;
    copilotCliDiagnostics?: CompatDiagnostic[];
    compatibilitySchemaVersion?: typeof COMPATIBILITY_SCHEMA_VERSION;
}

/**
 * MUST run after `{ ...parentConfig, ...overrides }`: the spread copies
 * `copilotCliTodoState` by reference, so parent and child would otherwise mutate one
 * list. `workspaceBinding` stays shared on purpose — the child is a non-owning user of
 * the parent's workspace.
 *
 * See d:/git/waldemort/myplans/copilot-cli-compat/copilot-cli-compat-design.md, "D6".
 */
export function applyCompatChildConfig<ChildConfig extends CompatBearingConfig>(childConfig: ChildConfig): ChildConfig {
    if (childConfig.compatibilityProfile === undefined) return childConfig;
    if (childConfig.copilotCliTodoState) {
        childConfig.copilotCliTodoState = copyTodoStateItems(childConfig.copilotCliTodoState);
    }
    // Load-time classification diagnostics describe the parent's own declared tools.
    if (childConfig.copilotCliDiagnostics) {
        delete childConfig.copilotCliDiagnostics;
    }
    return childConfig;
}

// ─── Serialization ──────────────────────────────────────────────

export interface CompatSessionState {
    profile?: CompatibilityProfileName;
    workspaceBinding?: WorkspaceBinding;
    todoState?: TodoState;
    diagnostics?: CompatDiagnostic[];
}

/**
 * Produce the compat config fragment. Disabled compatibility yields an empty object, so
 * spreading it adds no key at all — absence must mean absence, never `enabled: false`.
 */
export function buildCompatSessionConfigFragment(state: CompatSessionState | undefined): CompatBearingConfig {
    if (!state?.profile) return {};
    return {
        compatibilityProfile: state.profile,
        compatibilitySchemaVersion: COMPATIBILITY_SCHEMA_VERSION,
        ...(state.workspaceBinding ? { workspaceBinding: state.workspaceBinding } : {}),
        ...(state.todoState ? { copilotCliTodoState: state.todoState } : {}),
        ...(state.diagnostics?.length ? { copilotCliDiagnostics: state.diagnostics } : {}),
    };
}

/** Read compat state back out of a persisted config, tolerating absent and unknown fields. */
export function readCompatSessionState(config: CompatBearingConfig | undefined): CompatSessionState | undefined {
    if (!config?.compatibilityProfile) return undefined;
    return {
        profile: config.compatibilityProfile,
        workspaceBinding: config.workspaceBinding,
        todoState: config.copilotCliTodoState,
        diagnostics: config.copilotCliDiagnostics,
    };
}
