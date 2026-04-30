import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeSdkTransport } from "../../../cli/src/node-sdk-transport.js";

const ORIGINAL_LOG_DIR = process.env.PILOTSWARM_LOG_DIR;
const ORIGINAL_POLL_INTERVAL = process.env.PILOTSWARM_LOG_POLL_INTERVAL_MS;
const ORIGINAL_AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const ORIGINAL_AZURE_STORAGE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3_000, pollMs = 25) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for condition");
        }
        await sleep(pollMs);
    }
}

afterEach(() => {
    if (ORIGINAL_LOG_DIR == null) delete process.env.PILOTSWARM_LOG_DIR;
    else process.env.PILOTSWARM_LOG_DIR = ORIGINAL_LOG_DIR;

    if (ORIGINAL_POLL_INTERVAL == null) delete process.env.PILOTSWARM_LOG_POLL_INTERVAL_MS;
    else process.env.PILOTSWARM_LOG_POLL_INTERVAL_MS = ORIGINAL_POLL_INTERVAL;

    if (ORIGINAL_AZURE_STORAGE_CONNECTION_STRING == null) delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    else process.env.AZURE_STORAGE_CONNECTION_STRING = ORIGINAL_AZURE_STORAGE_CONNECTION_STRING;

    if (ORIGINAL_AZURE_STORAGE_CONTAINER == null) delete process.env.AZURE_STORAGE_CONTAINER;
    else process.env.AZURE_STORAGE_CONTAINER = ORIGINAL_AZURE_STORAGE_CONTAINER;
});

describe("starter local log tailing", () => {
    it("tails rotated local worker log files for client-only portal and TUI runs", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-local-logs-"));
        const workerLog = path.join(tempDir, "worker-a.log");
        fs.writeFileSync(workerLog, "2026-04-10T12:00:00Z INFO starter booted\n", "utf8");

        process.env.PILOTSWARM_LOG_DIR = tempDir;
        process.env.PILOTSWARM_LOG_POLL_INTERVAL_MS = "50";
        delete process.env.AZURE_STORAGE_CONNECTION_STRING;
        delete process.env.AZURE_STORAGE_CONTAINER;

        const transport = new NodeSdkTransport({ store: "sqlite::memory:", mode: "local" });
        const entries = [];
        const unsubscribe = transport.startLogTail((batch) => {
            entries.push(...(Array.isArray(batch) ? batch : []));
        });

        try {
            await waitFor(() => entries.some((entry) => entry?.podName === "worker-a" && entry?.message?.includes("starter booted")));

            fs.appendFileSync(workerLog, "2026-04-10T12:00:01Z INFO worker ready\n", "utf8");
            await waitFor(() => entries.some((entry) => entry?.podName === "worker-a" && entry?.message?.includes("worker ready")));

            expect(entries.some((entry) => entry?.podName === "worker-a")).toBe(true);
            expect(entries.some((entry) => entry?.message?.includes("starter booted"))).toBe(true);
            expect(entries.some((entry) => entry?.message?.includes("worker ready"))).toBe(true);
        } finally {
            unsubscribe();
            await transport.stopLogTail();
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
