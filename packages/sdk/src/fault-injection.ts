/**
 * Named fault points for crash-timing tests (session lifecycle protocol §4.4).
 *
 * A fault point is a no-op unless `PILOTSWARM_FAULT_INJECT` names it. The env
 * var is a comma-separated list of `<point>[:<action>[:<afterHits>]]` entries:
 *
 *   PILOTSWARM_FAULT_INJECT="turn.commit.after-cas"          → exit(137) on 1st hit
 *   PILOTSWARM_FAULT_INJECT="turn.commit.before-cas:throw"   → throw on 1st hit
 *   PILOTSWARM_FAULT_INJECT="turn.commit.after-cas:exit:2"   → exit(137) on 2nd hit
 *
 * `exit` (the default action) simulates a hard worker crash — the process
 * dies exactly at the protocol boundary, duroxide's activity retry takes it
 * from there. `throw` simulates a transient failure surfaced to the caller.
 * `afterHits` (1-based, default 1) fires the fault on the Nth time the point
 * is reached in this process — letting a scenario run N−1 healthy turns
 * before the crash.
 *
 * Points are deterministic code locations, never timers. In production the
 * env var is unset and every call is a cheap string check.
 *
 * @internal
 */
const hitCounts = new Map<string, number>();

export function faultPoint(name: string): void {
    const spec = process.env.PILOTSWARM_FAULT_INJECT;
    if (!spec) return;
    for (const entry of spec.split(",")) {
        const [point, action = "exit", afterHitsRaw] = entry.trim().split(":");
        if (point !== name) continue;
        const hits = (hitCounts.get(name) ?? 0) + 1;
        hitCounts.set(name, hits);
        const fireAt = Number.parseInt(afterHitsRaw ?? "1", 10) || 1;
        if (hits < fireAt) return;
        // eslint-disable-next-line no-console
        console.error(`[fault-injection] hit point=${name} action=${action} hit=${hits}/${fireAt}`);
        if (action === "throw") {
            throw new Error(`fault-injection: ${name}`);
        }
        process.exit(137);
    }
}
