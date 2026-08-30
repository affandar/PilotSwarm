/**
 * The per-turn system note, carried INSIDE the user turn.
 *
 * A wake-up (timer end, cron fire, child update) hands the model a short
 * `[SYSTEM: …]` note saying why the session woke. Orchestration ≤1.0.70
 * parked that note in `config.turnSystemPrompt`, and session-manager rendered
 * it into the `last_instructions` section of the SYSTEM message. The note
 * differs on every wake-up, so the first bytes of every request differed,
 * and the provider threw away the prefix cache behind them. Measured on
 * waldemort chk (2026-08-30): 12% cache hit on the first call after a
 * wake-up when the system message changed, 93% (GHCP) / 99% (Anthropic)
 * when it did not.
 *
 * From 1.0.71 the note rides at the TAIL of the user turn, wrapped in the
 * block below. The system message stays byte-stable across wake-ups; the
 * note costs its own ~200 tokens instead of a 500K-token re-prefill.
 *
 * Two readers share this file so there is one shape, not two:
 *   - orchestration/turn.ts appends the block before yielding runTurn
 *   - session-proxy.ts splits it off again before persisting the
 *     `user.message` event, and records the note as `system.message`
 *     exactly as it did when the note lived in `turnSystemPrompt`
 *
 * @internal
 */

export const SYSTEM_CONTEXT_OPEN = "<system_context>";
export const SYSTEM_CONTEXT_CLOSE = "</system_context>";

/** Append `note` to `prompt` as a trailing system-context block. */
export function appendSystemContextBlock(prompt: string, note: string | undefined): string {
    const body = (note ?? "").trim();
    if (!body) return prompt;
    const head = prompt.trimEnd();
    const block = `${SYSTEM_CONTEXT_OPEN}\n${body}\n${SYSTEM_CONTEXT_CLOSE}`;
    return head ? `${head}\n\n${block}` : block;
}

/**
 * Split a trailing system-context block off `prompt`.
 *
 * Only a block that CLOSES the prompt counts — the model may quote the tag
 * mid-text, and a collaborator may type it (utils.ts neutralises that for
 * non-owners). Returns the prompt unchanged when there is no such block.
 */
export function splitSystemContextBlock(prompt: string | undefined): { prompt: string; note?: string } {
    const text = prompt ?? "";
    const trimmed = text.trimEnd();
    if (!trimmed.endsWith(SYSTEM_CONTEXT_CLOSE)) return { prompt: text };
    const open = trimmed.lastIndexOf(SYSTEM_CONTEXT_OPEN);
    if (open < 0) return { prompt: text };
    const note = trimmed.slice(open + SYSTEM_CONTEXT_OPEN.length, trimmed.length - SYSTEM_CONTEXT_CLOSE.length).trim();
    const head = trimmed.slice(0, open).trimEnd();
    return { prompt: head, ...(note ? { note } : {}) };
}
