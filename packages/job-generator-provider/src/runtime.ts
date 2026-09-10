import type { Server } from "node:http";

import type { SourceProvider } from "./contracts.js";
import { beginProviderHostShutdown } from "./server.js";

function remaining(deadline: number): number {
    return Math.max(1, deadline - Date.now());
}

async function withDeadline<T>(
    operation: Promise<T>,
    deadline: number,
    label: string,
): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`${label} timed out`)),
                    remaining(deadline),
                );
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export async function closeProviders(
    providers: Iterable<SourceProvider>,
    deadline: number,
): Promise<void> {
    const results = await withDeadline(
        Promise.allSettled(
            [...providers].map(async (provider) => await provider.close?.()),
        ),
        deadline,
        "provider shutdown",
    );
    const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
    if (failures.length > 0) {
        throw new AggregateError(failures, "provider shutdown failed");
    }
}

export async function shutdownProviderHost(
    server: Server,
    providers: Iterable<SourceProvider>,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const failures: unknown[] = [];
    const requestDeadline = Date.now() + Math.max(1, Math.floor(timeoutMs * 2 / 3));
    let requestsDrained = false;
    const requestsSettled = beginProviderHostShutdown(server).then(() => {
        requestsDrained = true;
    });
    const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    server.closeIdleConnections();
    try {
        await withDeadline(
            Promise.all([requestsSettled, serverClosed]).then(() => undefined),
            requestDeadline,
            "provider request shutdown",
        );
    } catch (error) {
        server.closeAllConnections();
        try {
            await withDeadline(
                Promise.all([requestsSettled, serverClosed]).then(() => undefined),
                deadline,
                "forced provider request shutdown",
            );
        } catch (closeError) {
            failures.push(error, closeError);
        }
    }
    if (requestsDrained) {
        try {
            await closeProviders(providers, deadline);
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, "provider host shutdown failed");
    }
}
