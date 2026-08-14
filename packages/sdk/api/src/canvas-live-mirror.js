/**
 * The client-side canvas mirror: turns canvas-plane pushes (patch pings and
 * pointers) into complete `session.canvas_data`-shaped events, so every
 * consumer downstream keeps its whole-state contract while patches ride the
 * wire.
 *
 * Rules (docs/proposals/canvas-data-plane.md):
 * - A patch applies ONLY on contiguous seq (seq === mirror.seq + 1); anything
 *   else — a gap, a pointer-only ping, an unknown slot — triggers ONE
 *   snapshot fetch for the whole session. Fetches self-coalesce: the row is
 *   the latest truth, so one fetch answers any number of missed pings.
 * - Merge semantics are RFC 7386, the same law the database applies
 *   (jsonb_merge_patch): objects deep-merge, null deletes, arrays and
 *   scalars replace. Two implementations of one small spec; the seq chain
 *   plus snapshot resync self-heal any drift.
 * - `kind: doc` pings reset the slot's mirror (a redraw resets the payload
 *   server-side too) and are NOT emitted as data — document changes reach
 *   consumers through the durable canvas_updated path they already ride.
 */

export function jsonMergePatch(target, patch) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        return patch;
    }
    const base = target && typeof target === "object" && !Array.isArray(target) ? target : {};
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete out[key];
        } else if (typeof value === "object" && !Array.isArray(value)) {
            out[key] = jsonMergePatch(base[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

/**
 * @param {object} opts
 * @param {(sessionId: string) => Promise<Array<{slot:number, seq:number, payload:object, updatedBy?:string}>>} opts.fetchSnapshot
 * @param {(sessionId: string, update: {slot:number, seq:number, payload:object, patch?:object}) => void} opts.emit
 */
export function createCanvasLiveMirror({ fetchSnapshot, emit }) {
    // sessionId -> Map(slot -> { seq, payload })
    const bySession = new Map();
    // sessionId -> in-flight snapshot fetch (coalesces gap storms)
    const inflight = new Map();

    const slots = (sessionId) => {
        let m = bySession.get(sessionId);
        if (!m) {
            m = new Map();
            bySession.set(sessionId, m);
        }
        return m;
    };

    const resync = (sessionId) => {
        if (inflight.has(sessionId)) return inflight.get(sessionId);
        const run = Promise.resolve()
            .then(() => fetchSnapshot(sessionId))
            .then((rows) => {
                const m = slots(sessionId);
                for (const row of rows || []) {
                    const slot = Number(row.slot);
                    const seq = Number(row.seq) || 0;
                    const prev = m.get(slot);
                    // A snapshot can race a ping that already advanced us —
                    // never move backwards.
                    if (prev && prev.seq >= seq) continue;
                    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
                    m.set(slot, { seq, payload });
                    emit(sessionId, { slot, seq, payload });
                }
            })
            .catch(() => { /* next ping retriggers; events remain the fallback */ })
            .finally(() => inflight.delete(sessionId));
        inflight.set(sessionId, run);
        return run;
    };

    return {
        /** A plane ping for this session: {slot, seq, kind, patch?}. */
        onPing(sessionId, ping) {
            if (ping?.kind === "unavailable") {
                // The plane went away (server error/rollback). Release the
                // takeover so durable events resume feeding this session.
                bySession.delete(sessionId);
                return;
            }
            const slot = Number(ping?.slot);
            const seq = Number(ping?.seq);
            if (!Number.isInteger(slot) || !Number.isFinite(seq)) return;
            const m = slots(sessionId);
            if (ping.kind === "doc") {
                // Redraw: server reset the payload; mirror follows. No data
                // emit — canvas_updated carries document changes.
                m.set(slot, { seq, payload: {} });
                return;
            }
            const prev = m.get(slot);
            if (prev && seq === prev.seq) return; // duplicate delivery
            if (prev && seq < prev.seq) {
                // The plane's seq went BACKWARDS: the UNLOGGED row was
                // truncated (PG failover) and rebuilt from 1. The row is the
                // truth — drop our high-water mark and resync to whatever it
                // says, or every ping until seq climbs past the old mark
                // would read as "stale" and the canvas would freeze.
                m.delete(slot);
                void resync(sessionId);
                return;
            }
            if (ping.patch && prev && seq === prev.seq + 1) {
                const payload = jsonMergePatch(prev.payload, ping.patch);
                m.set(slot, { seq, payload });
                emit(sessionId, { slot, seq, payload, patch: ping.patch });
                return;
            }
            void resync(sessionId);
        },
        /** Prime the mirror on subscribe — the LVC burst. */
        prime(sessionId) {
            return resync(sessionId);
        },
        /** True once this slot is plane-fed (used to suppress legacy dupes). */
        covers(sessionId, slot) {
            return Boolean(bySession.get(sessionId)?.has(Number(slot)));
        },
        forget(sessionId) {
            bySession.delete(sessionId);
        },
    };
}
