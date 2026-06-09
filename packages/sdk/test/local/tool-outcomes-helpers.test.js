/**
 * Phase 4 — tool-outcome helpers unit tests.
 *
 * Covers:
 *  - Both helpers produce the documented marker-field shape with correct kind.
 *  - The detector (readToolOutcomeMarker) correctly identifies both kinds.
 *  - The persistence enricher (enrichToolCompletionEventData equivalent —
 *    we test sanitizeOutcomePayloadForPersistence directly) preserves the
 *    documented field allow-list and drops everything else.
 *  - FR-010 stable identifier in payload is preserved.
 *  - LLM-visible string contains developer message but NEVER the opaque
 *    claims blob and NEVER token-shaped material.
 *  - Three-way distinguishability (SC-005): each helper routes to a
 *    distinct kind value.
 *  - Backwards-compat: a value with no marker returns null from the
 *    detector (legacy tools continue to flow through the success/failure
 *    path unchanged — FR-013).
 *  - Argument validation: reasonCode is required.
 *  - retryAfter normalization for service_unavailable.
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

describe("Phase 4 — tool-outcome helpers", () => {
    describe("interactionRequired()", () => {
        it("produces marker shape with kind='interaction_required'", () => {
            const result = interactionRequired({ reasonCode: "reauth_required" });
            expect(result.resultType).toBe("interaction_required");
            expect(result[PS_TOOL_OUTCOME_MARKER].kind).toBe("interaction_required");
            expect((result[PS_TOOL_OUTCOME_MARKER].payload).reasonCode).toBe("reauth_required");
        });

        it("preserves developer-authored message in LLM-visible text", () => {
            const result = interactionRequired({
                reasonCode: "mfa_refresh",
                message: "Multi-factor authentication needs to be re-confirmed.",
            });
            expect(result.textResultForLlm).toBe("Multi-factor authentication needs to be re-confirmed.");
        });

        it("generates a default LLM-visible message when none is provided", () => {
            const result = interactionRequired({ reasonCode: "consent_required" });
            expect(result.textResultForLlm.length).toBeGreaterThan(0);
            expect(result.textResultForLlm).toContain("consent_required");
        });

        it("NEVER includes the claims blob in the LLM-visible text", () => {
            const result = interactionRequired({
                reasonCode: "conditional_access",
                message: "Re-auth required.",
                claims: "eyJhY2Nlc3NfdG9rZW4iOnsiZXNzZW50aWFsIjp0cnVlLCJ2YWx1ZSI6ImNwMSJ9fQ==",
            });
            expect(result.textResultForLlm).not.toContain("eyJhY2Nlc3NfdG9rZW4");
            expect(result.textResultForLlm).toBe("Re-auth required.");
            // Claims is still in the marker payload so the portal can forward it.
            expect((result[PS_TOOL_OUTCOME_MARKER].payload).claims).toContain("eyJhY2Nlc3NfdG9rZW4");
        });

        it("LLM-visible text does NOT match token-shaped regex (defensive guard)", () => {
            const result = interactionRequired({
                reasonCode: "reauth_required",
                message: "Please sign in again.",
            });
            expect(result.textResultForLlm.match(TOKEN_SHAPED_REGEX)).toBeNull();
        });

        it("throws when reasonCode is missing/empty", () => {
            expect(() => interactionRequired({ reasonCode: "" })).toThrow(/reasonCode/);
            expect(() => interactionRequired({})).toThrow(/reasonCode/);
            expect(() => interactionRequired({ reasonCode: "   " })).toThrow(/reasonCode/);
        });

        it("rejects reason codes outside the pinned taxonomy (Phase 7 final-review Finding 4)", () => {
            // The portal keys behavior off reasonCode (not free-form text),
            // so unknown values must be rejected at helper-call time so
            // downstream consumers can't fragment the contract.
            expect(() => interactionRequired({ reasonCode: "made_up_code" }))
                .toThrow(/not in the pinned taxonomy/);
            expect(() => interactionRequired({ reasonCode: "Reauth_Required" }))
                .toThrow(/not in the pinned taxonomy/);
            // The four pinned values continue to work.
            for (const code of ["reauth_required", "mfa_refresh", "conditional_access", "consent_required"]) {
                expect(() => interactionRequired({ reasonCode: code })).not.toThrow();
            }
        });
    });

    describe("serviceUnavailable()", () => {
        it("produces marker shape with kind='service_unavailable'", () => {
            const result = serviceUnavailable({ reasonCode: "akv_unwrap_failure" });
            expect(result.resultType).toBe("service_unavailable");
            expect(result[PS_TOOL_OUTCOME_MARKER].kind).toBe("service_unavailable");
            expect((result[PS_TOOL_OUTCOME_MARKER].payload).reasonCode).toBe("akv_unwrap_failure");
        });

        it("normalizes retryAfter to a non-negative integer", () => {
            const r1 = serviceUnavailable({ reasonCode: "x", retryAfter: 12.7 });
            expect((r1[PS_TOOL_OUTCOME_MARKER].payload).retryAfter).toBe(12);
            const r2 = serviceUnavailable({ reasonCode: "x", retryAfter: 0 });
            expect((r2[PS_TOOL_OUTCOME_MARKER].payload).retryAfter).toBe(0);
            const r3 = serviceUnavailable({ reasonCode: "x", retryAfter: -5 });
            expect((r3[PS_TOOL_OUTCOME_MARKER].payload).retryAfter).toBeNull();
            const r4 = serviceUnavailable({ reasonCode: "x", retryAfter: NaN });
            expect((r4[PS_TOOL_OUTCOME_MARKER].payload).retryAfter).toBeNull();
        });

        it("preserves developer-authored message", () => {
            const result = serviceUnavailable({
                reasonCode: "downstream_idp_unavailable",
                message: "The downstream IdP is currently unreachable.",
            });
            expect(result.textResultForLlm).toBe("The downstream IdP is currently unreachable.");
        });

        it("throws when reasonCode is missing/empty", () => {
            expect(() => serviceUnavailable({ reasonCode: "" })).toThrow(/reasonCode/);
        });
    });

    describe("readToolOutcomeMarker()", () => {
        it("returns the marker for interaction_required helper output", () => {
            const result = interactionRequired({ reasonCode: "reauth_required" });
            const marker = readToolOutcomeMarker(result);
            expect(marker).not.toBeNull();
            expect(marker.kind).toBe("interaction_required");
        });

        it("returns the marker for service_unavailable helper output", () => {
            const result = serviceUnavailable({ reasonCode: "akv_unwrap_failure" });
            const marker = readToolOutcomeMarker(result);
            expect(marker).not.toBeNull();
            expect(marker.kind).toBe("service_unavailable");
        });

        it("returns null for plain tool results (FR-013 backwards-compat)", () => {
            expect(readToolOutcomeMarker(null)).toBeNull();
            expect(readToolOutcomeMarker(undefined)).toBeNull();
            expect(readToolOutcomeMarker("just a string")).toBeNull();
            expect(readToolOutcomeMarker(42)).toBeNull();
            expect(readToolOutcomeMarker({ ok: true })).toBeNull();
            expect(readToolOutcomeMarker({ textResultForLlm: "done", resultType: "success" })).toBeNull();
        });

        it("rejects malformed markers (wrong kind)", () => {
            expect(readToolOutcomeMarker({
                [PS_TOOL_OUTCOME_MARKER]: { kind: "totally_bogus", payload: {} },
            })).toBeNull();
        });

        it("rejects malformed markers (missing payload)", () => {
            expect(readToolOutcomeMarker({
                [PS_TOOL_OUTCOME_MARKER]: { kind: "interaction_required" },
            })).toBeNull();
        });
    });

    describe("sanitizeOutcomePayloadForPersistence()", () => {
        it("preserves the interaction_required allow-list", () => {
            const result = interactionRequired({
                reasonCode: "reauth_required",
                message: "Sign in again",
                claims: "<claims-blob>",
            });
            const marker = readToolOutcomeMarker(result);
            const sanitized = sanitizeOutcomePayloadForPersistence(marker);
            expect(sanitized.reasonCode).toBe("reauth_required");
            expect(sanitized.message).toBe("Sign in again");
            expect(sanitized.claims).toBe("<claims-blob>");
            expect(Object.keys(sanitized).sort()).toEqual(["claims", "message", "reasonCode"]);
        });

        it("preserves the service_unavailable allow-list", () => {
            const result = serviceUnavailable({
                reasonCode: "akv_unwrap_failure",
                retryAfter: 30,
                message: "Try again in a bit",
            });
            const marker = readToolOutcomeMarker(result);
            const sanitized = sanitizeOutcomePayloadForPersistence(marker);
            expect(sanitized.reasonCode).toBe("akv_unwrap_failure");
            expect(sanitized.retryAfter).toBe(30);
            expect(sanitized.message).toBe("Try again in a bit");
            expect(Object.keys(sanitized).sort()).toEqual(["message", "reasonCode", "retryAfter"]);
        });

        it("drops extraneous fields injected onto the payload (defense-in-depth)", () => {
            // Construct a marker with extra fields a future buggy caller
            // might attach. Allow-list should drop them.
            const marker = {
                kind: "interaction_required",
                payload: {
                    reasonCode: "reauth_required",
                    message: "Sign in",
                    claims: null,
                    accessToken: "secret-must-not-persist",
                    user_password: "12345",
                },
            };
            const sanitized = sanitizeOutcomePayloadForPersistence(marker);
            expect(sanitized.accessToken).toBeUndefined();
            expect(sanitized.user_password).toBeUndefined();
            const flat = JSON.stringify(sanitized);
            expect(flat).not.toContain("secret-must-not-persist");
            expect(flat).not.toContain("12345");
        });
    });

    describe("SC-005 — three-way distinguishability", () => {
        it("interaction_required, service_unavailable, and absent-marker route to distinct signals", () => {
            const ir = interactionRequired({ reasonCode: "reauth_required" });
            const su = serviceUnavailable({ reasonCode: "akv_unwrap_failure" });
            const plain = { textResultForLlm: "ok", resultType: "success" };

            const irMarker = readToolOutcomeMarker(ir);
            const suMarker = readToolOutcomeMarker(su);
            const plainMarker = readToolOutcomeMarker(plain);

            expect(irMarker?.kind).toBe("interaction_required");
            expect(suMarker?.kind).toBe("service_unavailable");
            expect(plainMarker).toBeNull();

            // Each routes to a distinct value — no string parsing required.
            const kinds = new Set([irMarker?.kind, suMarker?.kind, plainMarker?.kind ?? "success"]);
            expect(kinds.size).toBe(3);
        });
    });
});
