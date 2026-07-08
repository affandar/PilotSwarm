import { z } from "zod";

/**
 * PilotSwarm session ids are UUID-SHAPED but not always RFC4122: system
 * sessions use deterministic ids whose version/variant nibbles are free
 * (e.g. `22013ffb-08cb-a1a4-de5b-3039b4fb7826` — third group starts with
 * `a`). `z.string().uuid()` enforces RFC4122 and rejects them, which locked
 * system sessions out of every session_id-taking tool. Validate shape only:
 * 8-4-4-4-12 hex.
 */
export const SESSION_ID_SHAPE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Zod schema for a session_id parameter (chain `.describe(...)` at use sites). */
export function sessionIdShape() {
    return z.string().regex(SESSION_ID_SHAPE, { message: "session_id must be a UUID-shaped id" });
}
