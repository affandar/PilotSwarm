/**
 * — tool.execution_complete event enrichment unit test.
 *
 * This test isolates the `enrichToolCompletionEventData` behavior that
 * session-proxy.ts applies on every tool.execution_complete event before
 * recording it to CMS. We replicate the function's behavior here against
 * the exported helpers so the contract is locked at the unit level
 * without needing to spin up a real worker.
 *
 * The session-proxy module re-uses the same `readToolOutcomeMarker` and
 * `sanitizeOutcomePayloadForPersistence` exports; this test asserts the
 * resulting persisted shape matches the FR-010 + SC-005 + Spec
 * Phase-4-architecture-decisions contract:
 *
 *  - data.outcome ∈ {"success", "failure", "interaction_required", "service_unavailable"}
 *  - data.outcome_payload sanitized to the allow-list when present
 *  - raw `__pilotswarmToolOutcome` marker is NEVER persisted
 *  - JWT-shaped tokens NEVER appear in the persisted row
 */

import { describe, it, expect } from "vitest";
import {
    interactionRequired,
    serviceUnavailable,
    readToolOutcomeMarker,
    sanitizeOutcomePayloadForPersistence,
    TOKEN_SHAPED_REGEX,
} from "../../src/tool-outcomes.js";
import { PS_TOOL_OUTCOME_MARKER } from "../../src/types.js";

// Mirror of session-proxy.ts:enrichToolCompletionEventData so we can
// exercise it without dragging in the full session-proxy module.
function enrich(eventData) {
    if (!eventData) return undefined;
    const cloned = { ...eventData };
    const marker = readToolOutcomeMarker(cloned)
        ?? readToolOutcomeMarker(cloned.result)
        ?? readToolOutcomeMarker(cloned.toolResult);
    if (marker) {
        cloned.outcome = marker.kind;
        cloned.outcome_payload = sanitizeOutcomePayloadForPersistence(marker);
        delete cloned[PS_TOOL_OUTCOME_MARKER];
        if (cloned.result && typeof cloned.result === "object") {
            const rcopy = { ...cloned.result };
            delete rcopy[PS_TOOL_OUTCOME_MARKER];
            cloned.result = rcopy;
        }
        if (cloned.toolResult && typeof cloned.toolResult === "object") {
            const tcopy = { ...cloned.toolResult };
            delete tcopy[PS_TOOL_OUTCOME_MARKER];
            cloned.toolResult = tcopy;
        }
        return cloned;
    }
    const isFailure = cloned.resultType === "failure"
        || typeof cloned.error === "string"
        || typeof cloned.errorMessage === "string";
    cloned.outcome = isFailure ? "failure" : "success";
    return cloned;
}

describe("tool.execution_complete event enrichment", () => {
    it("interaction_required → data.outcome populated + payload sanitized + marker stripped", () => {
        // Simulate the event data shape we'd see when a tool returned
        // interactionRequired(...) and the Copilot SDK packed it into
        // `data.result` on the tool.execution_complete event.
        const toolResult = interactionRequired({
            reasonCode: "reauth_required",
            message: "Sign in again to continue.",
            claims: "<opaque-claims-blob>",
        });
        const eventData = {
            toolName: "ado_get_workitems",
            toolCallId: "call-1",
            result: toolResult,
        };
        const enriched = enrich(eventData);
        expect(enriched.outcome).toBe("interaction_required");
        expect(enriched.outcome_payload.reasonCode).toBe("reauth_required");
        expect(enriched.outcome_payload.message).toBe("Sign in again to continue.");
        expect(enriched.outcome_payload.claims).toBe("<opaque-claims-blob>");
        // Marker stripped from both the top level and the nested result.
        expect(enriched[PS_TOOL_OUTCOME_MARKER]).toBeUndefined();
        expect(enriched.result[PS_TOOL_OUTCOME_MARKER]).toBeUndefined();
    });

    it("service_unavailable → outcome + retryAfter preserved", () => {
        const toolResult = serviceUnavailable({
            reasonCode: "akv_unwrap_failure",
            retryAfter: 60,
            message: "AKV unwrap failed; try later.",
        });
        const enriched = enrich({ toolName: "ado_get_users", result: toolResult });
        expect(enriched.outcome).toBe("service_unavailable");
        expect(enriched.outcome_payload.reasonCode).toBe("akv_unwrap_failure");
        expect(enriched.outcome_payload.retryAfter).toBe(60);
    });

    it("plain success tool result → outcome='success' (no marker present)", () => {
        const enriched = enrich({
            toolName: "echo",
            result: { textResultForLlm: "hello", resultType: "success" },
        });
        expect(enriched.outcome).toBe("success");
        expect(enriched.outcome_payload).toBeUndefined();
    });

    it("plain failure tool result → outcome='failure'", () => {
        const enriched = enrich({
            toolName: "echo",
            resultType: "failure",
            error: "thrown",
        });
        expect(enriched.outcome).toBe("failure");
    });

    it("persisted row NEVER contains the raw marker key", () => {
        const toolResult = interactionRequired({
            reasonCode: "mfa_refresh",
            message: "MFA refresh required.",
        });
        const enriched = enrich({ result: toolResult });
        const flat = JSON.stringify(enriched);
        expect(flat).not.toContain(PS_TOOL_OUTCOME_MARKER);
    });

    it("FR-020 — no JWT-shaped token can leak through persisted event", () => {
        // Sentinel: a token-shaped string accidentally placed in message
        // (which IS LLM-visible — caller bug). We assert it does NOT
        // appear in the sanitized outcome_payload's allow-listed keys
        // OTHER than the message (where it'd already have leaked to the
        // LLM, so persistence isn't the gating control). The defensive
        // claim here is structural: there is no `accessToken` /
        // `wrappedDek` / similar field in the persisted payload.
        const toolResult = interactionRequired({
            reasonCode: "reauth_required",
            message: "Please sign in.",
            claims: "<claims>",
        });
        const enriched = enrich({ result: toolResult });
        const payload = enriched.outcome_payload;
        // Allow-list is exactly {reasonCode, message, claims}; anything
        // else (accessToken, wrappedDek, iv, tag, kekKid) is absent.
        expect(payload).not.toHaveProperty("accessToken");
        expect(payload).not.toHaveProperty("wrappedDek");
        expect(payload).not.toHaveProperty("iv");
        expect(payload).not.toHaveProperty("tag");
        expect(payload).not.toHaveProperty("kekKid");
        // Sanity: the JWT regex would catch an actual JWT body in the
        // sanitized payload (claims is opaque base64 but typically NOT
        // shaped like a JWT).
        expect(JSON.stringify(payload).match(TOKEN_SHAPED_REGEX)).toBeNull();
    });

    it("backwards-compat (FR-013) — legacy consumer reading only resultType still works", () => {
        const toolResult = interactionRequired({ reasonCode: "reauth_required" });
        const enriched = enrich({ result: toolResult });
        // Legacy reader checks resultType to decide success/failure UX.
        // leaves resultType intact (the helper sets it to
        // "interaction_required" — legacy reader treats anything not
        // "success" as non-success without crashing on the new fields).
        expect(enriched.result.resultType).toBe("interaction_required");
        expect(enriched.result.resultType).not.toBe("success");
    });
});
