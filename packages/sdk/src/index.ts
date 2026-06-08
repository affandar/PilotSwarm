/**
 * pilotswarm — A durable execution runtime for GitHub Copilot SDK agents.
 *
 * @example
 * ```typescript
 * import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";
 *
 * const worker = new PilotSwarmWorker({ store, githubToken });
 * worker.registerTools([myTool]);
 * await worker.start();
 *
 * const client = new PilotSwarmClient({ store });
 * await client.start();
 *
 * const session = await client.createSession({ toolNames: ["myTool"] });
 * const response = await session.sendAndWait("Hello!");
 * ```
 */

export { PilotSwarmClient, PilotSwarmSession } from "./client.js";
export type { SessionEventHandler } from "./client.js";
export { PilotSwarmWorker } from "./worker.js";
export { PilotSwarmManagementClient } from "./management-client.js";
export type {
    PilotSwarmSessionView,
    SessionPageCursor,
    ListSessionsPageOptions,
    PilotSwarmSessionPage,
    ModelSummary,
    SessionStatusChange,
    SessionOrchestrationStats,
    ExecutionHistoryEvent,
    PilotSwarmManagementClientOptions,
    RestartSystemSessionOptions,
    RestartSystemSessionResult,
    SystemSessionRestartDisposition,
} from "./management-client.js";
export { SessionManager } from "./session-manager.js";
export { ManagedSession } from "./managed-session.js";
export { SessionBlobStore, createSessionBlobStore } from "./blob-store.js";
export { FilesystemSessionStore, FilesystemArtifactStore } from "./session-store.js";
export { PgFactStore, createFactStoreForUrl } from "./facts-store.js";
export { PgSessionCatalogProvider, computeCacheHitRatio } from "./cms.js";
export type { SessionCatalogProvider, SessionRow, SessionRowUpdates, SessionEvent, TopEventEmitterRow, InsertTurnMetricInput, TurnMetricRow, HourlyTokenBucketRow, SessionMetricSummary, SessionMetricSummaryUpsert, FleetStats, UserStats, UserStatsBucket, UserStatsModelBucket, UserStatsOwnerKind, SessionTreeStats, SkillKind, SkillUsageRow, SessionTreeSkillUsage, FleetSkillUsageRow, FleetSkillUsage, UserProfile, UserPrincipal } from "./cms.js";
export type {
    FactStore,
    FactRecord,
    StoreFactInput,
    ReadFactsQuery,
    DeleteFactInput,
    FactsStatsRow,
    FactsNamespace,
} from "./facts-store.js";
export type {
    SessionStateStore,
    SessionMetadata,
    ArtifactStore,
    ArtifactMetadata,
    ArtifactDownloadResult,
    ArtifactUploadOptions,
    ArtifactEncoding,
    ArtifactSource,
} from "./session-store.js";
export type {
    PilotSwarmClientOptions,
    PilotSwarmWorkerOptions,
    ManagedSessionConfig,
    PilotSwarmSessionStatus,
    PilotSwarmSessionInfo,
    SessionOwnerInfo,
    SessionContextUsage,
    SessionCompactionSnapshot,
    TurnAction,
    TurnResult,
    CapturedEvent,
    UserInputRequest,
    UserInputResponse,
    UserInputHandler,
    CommandMessage,
    CommandResponse,
    OrchestrationInput,
    SubAgentEntry,
    SessionPolicy,
} from "./types.js";

// Skills loader
export { loadSkills } from "./skills.js";
export { loadAgentFiles, systemAgentUUID, systemChildAgentUUID } from "./agent-loader.js";
export { loadMcpConfig } from "./mcp-loader.js";
export type { Skill } from "./skills.js";
// Local-mode user principal constant (Admin Console / per-user GitHub Copilot key)
export { LOCAL_DEFAULT_USER_PRINCIPAL } from "./session-owner-utils.js";
// Sweeper Agent tools
export { createSweeperTools } from "./sweeper-tools.js";
// Fact tools
export { createFactTools } from "./facts-tools.js";
// Inspect tools (read_agent_events, etc.)
export { createInspectTools } from "./inspect-tools.js";
// Resource Manager Agent tools
export { createResourceManagerTools } from "./resourcemgr-tools.js";
// Model providers
export { loadModelProviders, ModelProviderRegistry } from "./model-providers.js";
export type { ModelEntry, ModelDescriptor, ModelProviderConfig, ModelProvidersFile, ResolvedProvider, ReasoningEffort } from "./model-providers.js";
export { composeSystemPrompt, extractPromptContent, mergePromptSections } from "./prompt-layering.js";
export type { PromptLayeringKind } from "./prompt-layering.js";
export {
    buildSchemaIdentifier,
    renderPromptLayerManifest,
    buildPromptLayersEventPayload,
} from "./prompt-layers.js";
export type {
    PromptLayerDescriptor,
    PromptLayerKind,
    PromptLayerType,
    PromptLayersEventPayload,
} from "./prompt-layers.js";
export {
    normalizeWakeOn,
    readWakeOn,
    classifyChildUpdate,
    shouldWakeParentForChildUpdate,
    shouldWakeParentForChildDigest,
    isHeartbeatText,
    DEFAULT_CHILD_WAKE_POLICY,
} from "./child-notifications.js";
export type {
    ChildWakePolicy,
    ChildUpdateClassification,
    ChildUpdateSnapshot,
    ParentWakeDecisionInput,
    ParentWakeDecision,
} from "./child-notifications.js";
export {
    normalizeCronAtInput,
    computeCronAtNextFire,
    classifyRecurrence,
    isValidTimezone,
    describeCronAt,
} from "./cron-at.js";
export type {
    CronAtSchedule,
    CronAtInput,
    CronAtNextFire,
    CronAtNormalizeResult,
    CronAtRecurrence,
} from "./cron-at.js";

// Debug utilities
export { SessionDumper } from "./session-dumper.js";

// Re-export defineTool from Copilot SDK for convenience
export { defineTool } from "@github/copilot-sdk";

// Phase 2 (user-OBO): worker-side per-session user-context lookup.
// Synchronous, importable. Returns null for system sessions, unknown
// sessions, broken chains, and ambiguous multi-worker contexts.
export { getUserContextForSession } from "./worker-registry.js";
export type { UserContext, PrincipalClaims } from "./types.js";

// Phase 3 (user-OBO): envelope-crypto factory for portal-side encryption.
// Portals construct their own EnvelopeCrypto via selectEnvelopeCrypto(env)
// and use it to encrypt the per-RPC user access token before placing the
// envelope on the durable queue. The same env-driven selection logic is
// shared with workers so portal and worker agree on backend + KEK kid.
export { selectEnvelopeCrypto } from "./envelope-crypto.js";
export type { EnvelopeCrypto } from "./envelope-crypto.js";
export type {
    UserEnvelope,
    EnvelopeCipher,
    UserEnvelopeCarrier,
} from "./types.js";

// Phase 4 (user-OBO): structured tool outcome helpers — interaction_required
// and service_unavailable — for worker tools to signal IdP re-auth required
// or transport-layer dependency outage. Three-way distinguishability from
// generic tool failure is preserved via the persisted `outcome` event field.
export { interactionRequired, serviceUnavailable } from "./tool-outcomes.js";
export type { StructuredToolResult } from "./tool-outcomes.js";
export type {
    ToolOutcomeKind,
    InteractionRequiredPayload,
    ServiceUnavailablePayload,
    ToolOutcomePayload,
    ToolOutcomeMarker,
} from "./types.js";
