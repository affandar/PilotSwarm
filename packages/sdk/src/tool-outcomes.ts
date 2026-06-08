/**
 * Phase 4: Structured tool outcome helpers.
 *
 * Two helpers worker tools call to emit structured outcomes distinct from
 * generic tool failure:
 *
 *   - interactionRequired({ reasonCode, message?, claims? }) — user must
 *     re-authenticate at the IdP before the tool can proceed.
 *
 *   - serviceUnavailable({ reasonCode, retryAfter?, message? }) — a
 *     transport-layer dependency (AKV unwrap, downstream IdP, etc.) is
 *     persistently unavailable.
 *
 * Both produce a tool result with a `__pilotswarmToolOutcome` marker that
 * ManagedSession's tool wrapper detects, strips, and converts into a
 * structured event `outcome` / `outcome_payload` on the
 * `tool.execution_complete` event row. The marker keeps the surface
 * machine-distinguishable (SC-005) without any string parsing.
 */

import type {
    InteractionRequiredPayload,
    ServiceUnavailablePayload,
    ToolOutcomeMarker,
    ToolOutcomePayload,
} from "./types.js";
import { PS_TOOL_OUTCOME_MARKER } from "./types.js";

/**
 * Result shape returned by `interactionRequired` / `serviceUnavailable`
 * helpers. Mirrors the failure-result shape used elsewhere in the
 * codebase (`textResultForLlm` / `resultType` / `toolTelemetry`) so the
 * Copilot SDK accepts it as a tool result and routes the text to the
 * LLM. The marker field is additive and detected on the PilotSwarm side.
 *
 * `claims` is intentionally NOT serialized into `textResultForLlm` for
 * `interaction_required`; the LLM only sees the developer message.
 */
export interface StructuredToolResult {
    textResultForLlm: string;
    resultType: "interaction_required" | "service_unavailable";
    /** Phase 4 marker — detected by ManagedSession's tool wrapper. */
    [PS_TOOL_OUTCOME_MARKER]: ToolOutcomeMarker;
    toolTelemetry: Record<string, unknown>;
}

function sanitizeString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function defaultMessageFor(kind: "interaction_required" | "service_unavailable", reasonCode: string): string {
    if (kind === "interaction_required") {
        return `Re-authentication is required (${reasonCode}). The user must sign in again before this tool can proceed.`;
    }
    return `A dependency is currently unavailable (${reasonCode}). The user has nothing to do; the request can be retried later.`;
}

/**
 * Emit a structured "interaction required" tool outcome.
 *
 * The portal observes the resulting `outcome: "interaction_required"`
 * event and renders a re-authentication affordance. After the user
 * re-authenticates, the next worker-bound RPC carries a freshly-acquired
 * downstream token (FR-011 / SC-006).
 *
 * - `reasonCode` (required, stable identifier): `"reauth_required"`,
 *   `"mfa_refresh"`, `"conditional_access"`, `"consent_required"`, or a
 *   plugin-specific value. Persisted in `outcome_payload.reasonCode`.
 * - `message` (optional, LLM-visible): a short developer-authored hint
 *   explaining why re-auth is needed. **Do not include token material.**
 * - `claims` (optional, NOT LLM-visible): the opaque IdP claims-challenge
 *   blob, forwarded by the portal to MSAL's `acquireToken({ claims })`.
 */
export function interactionRequired(input: InteractionRequiredPayload): StructuredToolResult {
    const reasonCode = sanitizeString(input?.reasonCode);
    if (!reasonCode) {
        throw new Error("interactionRequired: reasonCode is required and must be a non-empty string.");
    }
    const message = sanitizeString(input?.message);
    const claims = sanitizeString(input?.claims);
    const payload: InteractionRequiredPayload = {
        reasonCode,
        message,
        claims,
    };
    return {
        textResultForLlm: message ?? defaultMessageFor("interaction_required", reasonCode),
        resultType: "interaction_required",
        [PS_TOOL_OUTCOME_MARKER]: { kind: "interaction_required", payload },
        toolTelemetry: {},
    };
}

/**
 * Emit a structured "service unavailable" tool outcome.
 *
 * The portal observes the resulting `outcome: "service_unavailable"`
 * event and renders a transient-error notice (with optional retry-after
 * countdown). Distinct from `interaction_required` because the user
 * cannot resolve it themselves; the tool is signaling a transport-layer
 * dependency outage (AKV unwrap, downstream IdP, etc.).
 *
 * - `reasonCode` (required): `"akv_unwrap_failure"`,
 *   `"downstream_idp_unavailable"`, or plugin-specific.
 * - `retryAfter` (optional, seconds): used by the portal for countdown UX.
 * - `message` (optional, LLM-visible): developer hint.
 */
export function serviceUnavailable(input: ServiceUnavailablePayload): StructuredToolResult {
    const reasonCode = sanitizeString(input?.reasonCode);
    if (!reasonCode) {
        throw new Error("serviceUnavailable: reasonCode is required and must be a non-empty string.");
    }
    const message = sanitizeString(input?.message);
    const retryAfterRaw = input?.retryAfter;
    const retryAfter = Number.isFinite(retryAfterRaw as number) && (retryAfterRaw as number) >= 0
        ? Math.trunc(retryAfterRaw as number)
        : null;
    const payload: ServiceUnavailablePayload = {
        reasonCode,
        retryAfter,
        message,
    };
    return {
        textResultForLlm: message ?? defaultMessageFor("service_unavailable", reasonCode),
        resultType: "service_unavailable",
        [PS_TOOL_OUTCOME_MARKER]: { kind: "service_unavailable", payload },
        toolTelemetry: {},
    };
}

/**
 * Returns the structured outcome marker on a value if present, otherwise
 * null. Used by ManagedSession's tool wrapper and by session-proxy's
 * event-persistence path to detect the structured-outcome family.
 */
export function readToolOutcomeMarker(value: unknown): ToolOutcomeMarker | null {
    if (!value || typeof value !== "object") return null;
    const marker = (value as Record<string, unknown>)[PS_TOOL_OUTCOME_MARKER];
    if (!marker || typeof marker !== "object") return null;
    const kind = (marker as { kind?: unknown }).kind;
    const payload = (marker as { payload?: unknown }).payload;
    if (kind !== "interaction_required" && kind !== "service_unavailable") return null;
    if (!payload || typeof payload !== "object") return null;
    return { kind, payload: payload as ToolOutcomePayload };
}

/**
 * JWT/access-token-shape regex used to defensively assert no
 * token-shaped substring leaks into the LLM-visible text. We do NOT
 * redact at runtime — callers MUST NOT pass token material — but tests
 * use this to lock the regression closed.
 */
export const TOKEN_SHAPED_REGEX = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

/**
 * Sanitize an outcome payload for persistence into the CMS event row.
 * Per FR-020 / Phase 4 plan, this is an allow-list of fields per kind;
 * any extra fields are dropped. Token material is never present in
 * either payload type's allow-list, so this also defends against
 * accidental field copying.
 */
export function sanitizeOutcomePayloadForPersistence(marker: ToolOutcomeMarker): ToolOutcomePayload {
    if (marker.kind === "interaction_required") {
        const p = marker.payload as InteractionRequiredPayload;
        return {
            reasonCode: typeof p.reasonCode === "string" ? p.reasonCode : "",
            message: typeof p.message === "string" ? p.message : null,
            claims: typeof p.claims === "string" ? p.claims : null,
        };
    }
    const p = marker.payload as ServiceUnavailablePayload;
    return {
        reasonCode: typeof p.reasonCode === "string" ? p.reasonCode : "",
        retryAfter: Number.isFinite(p.retryAfter as number) ? (p.retryAfter as number) : null,
        message: typeof p.message === "string" ? p.message : null,
    };
}
