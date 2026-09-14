export type TurnLifecycleStatus = "completed" | "cancelled" | "failed";

export interface TurnLifecycleContext<Config = unknown> {
    sessionId: string;
    turnIndex?: number;
    config: Config;
    trace: (message: string) => void;
}

export interface AfterTurnContext<Config = unknown, Result = unknown>
    extends TurnLifecycleContext<Config> {
    status: TurnLifecycleStatus;
    result?: Result;
    error?: unknown;
}

export type BeforeTurnHook<Config = unknown> = (
    context: TurnLifecycleContext<Config>,
) => void | Promise<void>;

export type AfterTurnHook<Config = unknown, Result = unknown> = (
    context: AfterTurnContext<Config, Result>,
) => void | Promise<void>;

export interface TurnLifecycleHooks<Config = unknown, Result = unknown> {
    beforeTurn?: BeforeTurnHook<Config>;
    afterTurn?: AfterTurnHook<Config, Result>;
}

export interface RunWithTurnLifecycleHooksOptions<Config, Result>
    extends TurnLifecycleHooks<Config, Result> {
    context: TurnLifecycleContext<Config>;
    run: () => Result | Promise<Result>;
    isCancelled?: (result: Result) => boolean;
}

/**
 * Run one turn attempt with process-local lifecycle hooks.
 *
 * `beforeTurn` runs once before the body. If it fails, neither the body nor
 * `afterTurn` runs. After a successful pre-hook, `afterTurn` runs once from a
 * `finally` path for completion, cancellation, and thrown turn failures.
 * An after-hook failure rejects the attempt. If both the turn and after-hook
 * fail, an AggregateError preserves both errors in turn-then-after order.
 *
 * Exactly-once applies to one activity invocation. Durable activity retries
 * are separate attempts and invoke the hooks again.
 */
export async function runWithTurnLifecycleHooks<Config, Result>(
    options: RunWithTurnLifecycleHooksOptions<Config, Result>,
): Promise<Result> {
    const {
        beforeTurn,
        afterTurn,
        context,
        run,
        isCancelled = () => false,
    } = options;

    await beforeTurn?.(context);

    let result: Result | undefined;
    let turnError: unknown;
    let turnFailed = false;
    try {
        result = await run();
        return result;
    } catch (error) {
        turnError = error;
        turnFailed = true;
        throw error;
    } finally {
        if (afterTurn) {
            const status: TurnLifecycleStatus = turnFailed
                ? "failed"
                : isCancelled(result as Result)
                    ? "cancelled"
                    : "completed";
            try {
                await afterTurn({
                    ...context,
                    status,
                    ...(turnFailed ? { error: turnError } : { result: result as Result }),
                });
            } catch (afterError) {
                if (turnFailed) {
                    throw new AggregateError(
                        [turnError, afterError],
                        "Turn and afterTurn hook both failed",
                    );
                }
                throw afterError;
            }
        }
    }
}
