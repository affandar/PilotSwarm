export interface WaitHandlingPlanInput {
    blobEnabled: boolean;
    seconds: number;
    dehydrateThreshold: number;
    preserveWorkerAffinity?: boolean;
}

export interface WaitHandlingPlan {
    shouldDehydrate: boolean;
    resetAffinityOnDehydrate: boolean;
    preserveAffinityOnHydrate: boolean;
}

export function planWaitHandling(input: WaitHandlingPlanInput): WaitHandlingPlan {
    const shouldDehydrate = input.blobEnabled && input.seconds > input.dehydrateThreshold;
    const preserveAffinityOnHydrate = shouldDehydrate && input.preserveWorkerAffinity === true;

    return {
        shouldDehydrate,
        resetAffinityOnDehydrate: shouldDehydrate ? !preserveAffinityOnHydrate : false,
        preserveAffinityOnHydrate,
    };
}

// ─── Session lifecycle protocol (orchestration 1.0.57+) ────────────────────
// planWaitHandling above is FROZEN — older orchestration versions import it
// live, so its semantics must never change. The new protocol replaces
// dehydrate-on-wait with checkpoint-hold: state is durable at every turn
// commit, so a wait only decides whether to keep the affinity GUID (hold)
// or rotate it (release). Waits within the hold window keep the worker
// warm by default — no LLM opt-in needed.

export interface HoldReleasePlanInput {
    blobEnabled: boolean;
    seconds: number;
    /** The affinity hold window in seconds (orchestration `idleTimeout`). */
    holdWindowSeconds: number;
}

export interface HoldReleasePlan {
    /** True → rotate the affinity GUID now; the wake-up hydrates anywhere. */
    shouldRelease: boolean;
}

export function planHoldRelease(input: HoldReleasePlanInput): HoldReleasePlan {
    const holdWindow = input.holdWindowSeconds > 0 ? input.holdWindowSeconds : 1_800;
    return {
        shouldRelease: input.blobEnabled && input.seconds > holdWindow,
    };
}
