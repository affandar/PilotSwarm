#!/usr/bin/env node

export * from "./providers.js";
export * from "./controller.js";

import { hostname } from "node:os";
import {
    MockJobExternalOperationProducer,
    PgSessionCatalog,
    PilotSwarmClient,
    PilotSwarmManagementClient,
    RemoteLifecycleStateReader,
} from "pilotswarm-sdk";
import { JobGeneratorController, PilotSwarmInitialSessionFactory } from "./controller.js";
import { createEvaluatorsFromEnv } from "./providers.js";

export async function runJobGenerator(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    const catalogUrl = process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL?.trim() || databaseUrl;
    const cmsSchema = process.env.PILOTSWARM_CMS_SCHEMA?.trim() || "copilot_sessions";
    const useManagedIdentity = ["1", "true", "yes", "on"].includes(
        (process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").trim().toLowerCase(),
    );
    const aadDbUser = process.env.PILOTSWARM_DB_AAD_USER?.trim()
        || process.env.PILOTSWARM_AAD_DB_USER?.trim();
    const induceSessions = !["0", "false", "no", "off"].includes(
        (process.env.JOBGEN_INDUCE_SESSIONS || "true").trim().toLowerCase(),
    );
    const runOnce = ["1", "true", "yes", "on"].includes(
        (process.env.JOBGEN_RUN_ONCE || "").trim().toLowerCase(),
    );
    const mockOperationsEnabled = ["1", "true", "yes", "on"].includes(
        (process.env.JOBGEN_MOCK_EXTERNAL_OPERATIONS || "").trim().toLowerCase(),
    );
    const workerId = process.env.JOBGEN_WORKER_ID || `${hostname()}-${process.pid}`;
    const pollIntervalMs = Number(process.env.JOBGEN_POLL_INTERVAL_MS || 15_000);
    const claimLimit = Number(process.env.JOBGEN_CLAIM_LIMIT || 10);
    const leaseSeconds = Number(process.env.JOBGEN_LEASE_SECONDS || 300);
    console.info("[job-generator] initializing PostgreSQL catalog");
    const catalog = await PgSessionCatalog.create(catalogUrl, cmsSchema, {
        useManagedIdentity,
        aadUser: aadDbUser,
    });
    await catalog.initialize();
    console.info(`[job-generator] catalog ready schema=${cmsSchema}`);
    let client: PilotSwarmClient | undefined;
    if (induceSessions) {
        client = new PilotSwarmClient({
            store: databaseUrl,
            cmsSchema,
            useManagedIdentity,
            cmsFactsDatabaseUrl: process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || undefined,
            aadDbUser: aadDbUser,
        });
        await client.start();
        console.info("[job-generator] session induction client ready");
    }
    let managementClient: PilotSwarmManagementClient | undefined;
    let mockOperationProducer: MockJobExternalOperationProducer | undefined;
    if (mockOperationsEnabled) {
        managementClient = new PilotSwarmManagementClient({
            store: databaseUrl,
            cmsSchema,
            useManagedIdentity,
            cmsFactsDatabaseUrl: process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || undefined,
            aadDbUser,
        });
        await managementClient.start();
        mockOperationProducer = new MockJobExternalOperationProducer({
            store: catalog,
            signalSender: managementClient,
            workerId: `${workerId}-mock-operations`,
            pollIntervalMs: Number(process.env.JOBGEN_MOCK_OPERATION_POLL_INTERVAL_MS || 500),
        });
        console.info("[job-generator] deterministic mock external-operation producer ready");
    }

    const evaluators = createEvaluatorsFromEnv();
    const providerTypes = [...evaluators.keys()];
    if (providerTypes.length === 0) {
        console.warn("[job-generator] no source evaluators are configured");
    }
    console.info(
        `[job-generator] starting mode=${runOnce ? "once" : "continuous"}`
        + ` worker=${workerId} pollMs=${pollIntervalMs} claimLimit=${claimLimit}`
        + ` leaseSeconds=${leaseSeconds} induceSessions=${induceSessions}`
        + ` mockExternalOperations=${mockOperationsEnabled}`
        + ` providers=${providerTypes.join(",") || "none"}`,
    );
    const controller = new JobGeneratorController({
        store: catalog,
        evaluators,
        sessionFactory: client
            ? new PilotSwarmInitialSessionFactory(client, {
                store: catalog,
                reader: new RemoteLifecycleStateReader({
                    githubToken: process.env.JOBGEN_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
                    adoToken: process.env.JOBGEN_ADO_TOKEN,
                    adoPat: process.env.JOBGEN_ADO_PAT || process.env.AZURE_DEVOPS_EXT_PAT,
                }),
            })
            : undefined,
        induceSessions,
        workerId,
        pollIntervalMs,
        claimLimit,
        leaseSeconds,
    });
    const abort = new AbortController();
    process.once("SIGTERM", () => abort.abort());
    process.once("SIGINT", () => abort.abort());
    let producerRun: Promise<void> | undefined;
    try {
        if (runOnce) {
            await controller.runOnce();
            await mockOperationProducer?.runOnce();
        } else {
            producerRun = mockOperationProducer?.run(abort.signal);
            await controller.run(abort.signal);
        }
    } finally {
        console.info("[job-generator] stopping");
        abort.abort();
        await producerRun;
        await managementClient?.stop();
        await client?.stop();
        await catalog.close();
        console.info("[job-generator] stopped");
    }
}
