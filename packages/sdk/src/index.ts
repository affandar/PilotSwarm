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
    ModelSummary,
    SessionStatusChange,
    SessionOrchestrationStats,
    ExecutionHistoryEvent,
    SessionListPage,
    PilotSwarmManagementClientOptions,
    EnrichedFleetAgentRow,
    EnrichedFleetStats,
} from "./management-client.js";
export { SessionManager } from "./session-manager.js";
export { ManagedSession } from "./managed-session.js";
export { SessionBlobStore } from "./blob-store.js";
export { FilesystemSessionStore, FilesystemArtifactStore } from "./session-store.js";
export { PgFactStore, createFactStoreForUrl } from "./facts-store.js";
export { PgSessionCatalogProvider, computeCacheHitRatio, buildPgGuardrailConfig } from "./cms.js";
export type { SessionCatalogProvider, SessionRow, SessionPageCursor, SessionPage, SessionRowUpdates, SessionEvent, SessionMetricSummary, SessionMetricSummaryUpsert, FleetStats, SessionTreeStats, SkillKind, SkillUsageRow, SessionTreeSkillUsage, FleetSkillUsageRow, FleetSkillUsage, InsertTurnMetricInput, TurnMetricRow, FleetTurnAnalyticsRow, HourlyTokenBucketRow, DbCallMetricBucketInput, FleetDbCallMetricRow, TopEventEmitterRow, UserStats, UserStatsBucket, UserStatsModelBucket, UserStatsOwnerKind, UserProfile, UserPrincipal } from "./cms.js";
export { globalDbMetrics } from "./db-metrics.js";
export type { DbMetricsSnapshot } from "./db-metrics.js";
export { estimateCostUsd, MODEL_PRICING } from "./model-pricing.js";
export type { ModelPricing } from "./model-pricing.js";
export type {
    FactStore,
    FactRecord,
    StoreFactInput,
    ReadFactsQuery,
    DeleteFactInput,
    FactsStatsRow,
    FactsNamespace,
} from "./facts-store.js";
export type { SessionStateStore, SessionMetadata, ArtifactStore, ArtifactMetadata, ArtifactDownloadResult, ArtifactUploadOptions, ArtifactEncoding, ArtifactSource } from "./session-store.js";
export type {
    PilotSwarmClientOptions,
    PilotSwarmWorkerOptions,
    ManagedSessionConfig,
    PilotSwarmSessionStatus,
    PilotSwarmSessionInfo,
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
    PromptSource,
    PromptGuardrailAction,
    PromptGuardrailVerdict,
    PromptGuardrailDecision,
    PromptGuardrailConfig,
    SessionOwnerInfo,
} from "./types.js";

export {
    buildGuardedTurnPrompt,
    buildPromptGuardrailRefusal,
    containsUnsafeAuthorityClaim,
    evaluatePromptGuardrails,
    isHighRiskTurnResult,
    normalizePromptGuardrailConfig,
    shouldRunPromptGuardrailDetector,
    wrapToolOutputForModel,
    wrapUntrustedContentBlock,
} from "./prompt-guardrails.js";

// Skills loader
export { loadSkills } from "./skills.js";
export { loadAgentFiles, systemAgentUUID, systemChildAgentUUID } from "./agent-loader.js";
export { loadMcpConfig } from "./mcp-loader.js";
export type { Skill } from "./skills.js";
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

// Token Optimization — adaptive knowledge-index load policy
export {
    decideKnowledgeLoad,
    promptNeedsKnowledge,
    classifyContextPressure,
    DEFAULT_KNOWLEDGE_REFRESH_INTERVAL,
} from "./knowledge-load-policy.js";
export type {
    KnowledgeLoadDecision,
    KnowledgeLoadParams,
    KnowledgeLoadReason,
    ContextPressureLevel,
} from "./knowledge-load-policy.js";

// S3 artifact store
export { S3ArtifactStore } from "./s3-artifact-store.js";
export type { S3ArtifactStoreOptions } from "./s3-artifact-store.js";

// Tool & Network Controls (Phase 4)
export {
    smartTruncate,
    stringifyForModel,
    TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS,
    TOOL_TIMEOUT_MS_DEFAULT,
    TURN_MAX_CONCURRENT_TOOLS_DEFAULT,
} from "./turn-budget.js";

// Token Optimization — model routing policy
export {
    classifyTurnContext,
    buildCandidateChain,
    routeTurn,
    isModelFallbackEligibleError,
    MAX_CANDIDATES,
} from "./model-routing.js";
export type {
    TurnCategory,
    TurnContextParams,
    RoutingParams,
    RouteTurnParams,
    RouteDecision,
} from "./model-routing.js";

// Debug utilities
export { SessionDumper } from "./session-dumper.js";

// SLO Measurement & Policy (Phase 5)
export { DEFAULT_SLO_THRESHOLDS } from "./slo-config.js";
export type { SloThresholds } from "./slo-config.js";
export { evaluateSloHealth, decideSloAction } from "./slo-policy.js";
export type { SloStatus, SloViolation, SloHealthReport, SloAction } from "./slo-policy.js";
export { createSloTools } from "./slo-tools.js";

// Session ownership
export { LOCAL_DEFAULT_USER_PRINCIPAL } from "./session-owner-utils.js";

// Re-export defineTool from Copilot SDK for convenience
export { defineTool } from "@github/copilot-sdk";
