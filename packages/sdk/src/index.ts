/**
 * pilotswarm — A durable execution runtime for GitHub Copilot SDK agents.
 *
 * Client access goes through a deployment's Web API (web mode — the
 * supported mode; no database or storage credentials in the caller):
 *
 * @example
 * ```typescript
 * import { PilotSwarmClient } from "pilotswarm-sdk";
 *
 * const client = new PilotSwarmClient({ apiUrl: "https://portal.example.com" });
 * await client.start();
 *
 * const session = await client.createSession();
 * const response = await session.sendAndWait("Hello!");
 * ```
 *
 * Workers always run backend-side against the datastore directly:
 *
 * @example
 * ```typescript
 * import { PilotSwarmWorker, defineTool } from "pilotswarm-sdk";
 *
 * const worker = new PilotSwarmWorker({ store, githubToken });
 * worker.registerTools([myTool]);
 * await worker.start();
 * ```
 *
 * Direct client construction (`new PilotSwarmClient({ store })`) remains for
 * trusted server-side embedding and internal testing.
 */

export { PilotSwarmClient, PilotSwarmSession } from "./client.js";
export type { SessionEventHandler } from "./client.js";
export { PilotSwarmWorker } from "./worker.js";
export { PilotSwarmManagementClient } from "./management-client.js";
export type { PilotSwarmWebOptions } from "./web/api-connection.js";
export { WebPilotSwarmClient, WebPilotSwarmSession } from "./web/web-client.js";
export { WebPilotSwarmManagementClient } from "./web/web-management-client.js";
export { WebFactStore, WebEnhancedFactStore, createWebFactStore } from "./web/web-fact-store.js";
export { WebGraphStore, createWebGraphStore } from "./web/web-graph-store.js";
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
export { PgFactStore, createFactStoreForUrl, createGraphStoreForUrl, resolveFactsTarget, isEnhancedFactStore, EnhancedFactsUnsupportedError } from "./facts-store.js";
// Convenience: map HORIZON_* env vars to worker enhanced-facts/graph config.
export { horizonConfigFromEnv } from "./horizon-env.js";
export type { HorizonEnvConfig } from "./horizon-env.js";
export { resolveStorageConfig, DEFAULT_DUROXIDE_SCHEMA, DEFAULT_RUNTIME_STORAGE_PROVIDER, DEFAULT_DUROXIDE_STORAGE_PROVIDER } from "./storage-config.js";
export type { StorageConfig, RuntimeStorageConfig, DuroxideStorageConfig, StorageConfigLegacyOptions } from "./storage-config.js";
export { runtimeStorageProviders, duroxideStorageProviders, getRuntimeStorageProvider, getDuroxideStorageProvider } from "./storage-providers.js";
export type { RuntimeStorageProvider, DuroxideStorageProvider } from "./storage-providers.js";
export { migrateLegacyDuroxideSchema } from "./duroxide-schema-migration.js";
export type { DuroxideSchemaMigrationOptions, DuroxideSchemaMigrationResult } from "./duroxide-schema-migration.js";
export { PgSessionCatalog, PgSessionCatalogProvider, computeCacheHitRatio } from "./cms.js";
export type { SessionCatalog, SessionCatalogProvider, SessionRow, SessionRowUpdates, SessionEvent, TopEventEmitterRow, InsertTurnMetricInput, CompleteTurnWritebackInput, TurnMetricRow, HourlyTokenBucketRow, TokensByModelRow, SessionMetricSummary, SessionMetricSummaryUpsert, FleetStats, UserStats, UserStatsBucket, UserStatsModelBucket, UserStatsOwnerKind, SessionTreeStats, SkillKind, SkillUsageRow, SessionTreeSkillUsage, FleetSkillUsageRow, FleetSkillUsage, RetrievalSurface, RetrievalOperation, RetrievalUsageRow, SessionTreeRetrievalUsage, FleetRetrievalUsageRow, FleetRetrievalUsage, GraphNodeUsageKind, GraphNodeUsageRow, FleetGraphNodeUsageRow, FleetGraphNodeUsage, GraphEdgeSearchUsageRow, UserProfile, UserPrincipal } from "./cms.js";
export type {
    FactStore,
    FactRecord,
    StoreFactInput,
    StoredFactResult,
    ReadFactsQuery,
    DeleteFactInput,
    DeletedFactResult,
    DeletedFactsResult,
    FactsStatsRow,
    FactsTombstoneStats,
    ForcePurgeFactsInput,
    FactsNamespace,
    AccessContext,
    SetFactsCrawledInput,
    SetFactsCrawledScopeKey,
    EnhancedFactStore,
    FactsCapabilities,
    SearchMode,
    SearchWeights,
    SearchOpts,
    SimilarOpts,
    ScoredFact,
    SearchResult,
    EmbedderStatus,
    EmbedderLoopStatus,
    EmbeddingEndpointConfig,
} from "./facts-store.js";
// Graph store contract (optional, separately injected — enhancedfactstore 07 D2)
export { isGraphStore, scopeKeyAccessible, DEFAULT_GRAPH_NAMESPACE } from "./graph-store.js";
export type {
    GraphStore,
    GraphNodeInput,
    GraphEdgeInput,
    GraphNodeQuery,
    GraphEdgeQuery,
    GraphNamespaceQuery,
    GraphNodeRef,
    GraphNodeHit,
    GraphEdgeRef,
    GraphEdgeHit,
    GraphEvidenceRemovalResult,
    SubGraph,
    GraphNamespaceFrontmatter,
    GraphNamespaceInfo,
    GraphNamespaceInput,
    GraphNamespaceListQuery,
    GraphNamespaceDeleteResult,
} from "./graph-store.js";
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
export { loadSkills, loadSkillsSync, composeDeclaredSkillsPrompt } from "./skills.js";
export { loadAgentFiles, systemAgentUUID, systemChildAgentUUID } from "./agent-loader.js";
export { loadMcpConfig } from "./mcp-loader.js";
export type { Skill } from "./skills.js";
// Local-mode user principal constant (Admin Console / per-user GitHub Copilot key)
export { LOCAL_DEFAULT_USER_PRINCIPAL } from "./session-owner-utils.js";
// Sweeper Agent tools
export { createSweeperTools } from "./sweeper-tools.js";
// Fact tools
export { createFactTools } from "./facts-tools.js";
export { createGraphTools } from "./graph-tools.js";
// Inspect tools (read_agent_events, etc.)
export { createInspectTools } from "./inspect-tools.js";
// Resource Manager Agent tools
export { createResourceManagerTools } from "./resourcemgr-tools.js";
// Model providers
export { loadModelProviders, ModelProviderRegistry } from "./model-providers.js";
export type { ModelEntry, ModelDescriptor, ModelProviderConfig, ModelProvidersFile, ResolvedProvider, ReasoningEffort, ContextTier } from "./model-providers.js";
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
