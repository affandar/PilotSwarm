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
