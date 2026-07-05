/**
 * Named fault points for crash-timing tests (session lifecycle protocol §4.4).
 *
 * A fault point is a no-op unless `PILOTSWARM_FAULT_INJECT` names it. The env
 * var is a comma-separated list of `<point>` or `<point>:<action>` entries:
 *
 *   PILOTSWARM_FAULT_INJECT="turn.commit.after-cas"            → exit(137)
 *   PILOTSWARM_FAULT_INJECT="turn.commit.before-cas:throw"     → throw
 *
 * `exit` (the default action) simulates a hard worker crash — the process
 * dies exactly at the protocol boundary, duroxide's activity retry takes it
 * from there. `throw` simulates a transient failure surfaced to the caller.
 *
 * Points are deterministic code locations, never timers. In production the
 * env var is unset and every call is a cheap string check.
 *
 * @internal
 */
export function faultPoint(name: string): void {
    const spec = process.env.PILOTSWARM_FAULT_INJECT;
    if (!spec) return;
    for (const entry of spec.split(",")) {
        const [point, action = "exit"] = entry.trim().split(":");
        if (point !== name) continue;
        // eslint-disable-next-line no-console
        console.error(`[fault-injection] hit point=${name} action=${action}`);
        if (action === "throw") {
            throw new Error(`fault-injection: ${name}`);
        }
        process.exit(137);
    }
}
