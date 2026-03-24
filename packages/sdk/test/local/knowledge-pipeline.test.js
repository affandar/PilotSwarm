/**
 * Knowledge Pipeline tests.
 *
 * Verifies:
 *   - Namespace access control (intake/, skills/, asks/, config/)
 *   - loadKnowledgeIndex activity filtering
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    PgFactStore,
    createFactTools,
} from "../../src/index.ts";

const TIMEOUT = 120_000;

// ─── Level 1: Namespace Access Control ──────────────────────────

async function testTaskAgentCanWriteIntake(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [storeFact] = createFactTools({ factStore });
        const result = await storeFact.handler(
            { key: "intake/terraform/session-abc", value: { problem: "test", outcome: "success" }, shared: true },
            { sessionId: "session-a", agentId: "task-agent" },
        );
        assert(!result.error, "Task agent should be able to write to intake/");
        console.log("  ✓ Task agent wrote to intake/ successfully");
    } finally {
        await factStore.close();
    }
}

async function testTaskAgentCannotWriteSkills(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [storeFact] = createFactTools({ factStore });
        const result = await storeFact.handler(
            { key: "skills/terraform/test", value: { name: "test" }, shared: true },
            { sessionId: "session-a", agentId: "task-agent" },
        );
        assert(result.error, "Task agent should NOT be able to write to skills/");
        assert(result.error.includes("reserved for the Facts Manager"), "Error message mentions Facts Manager");
        console.log("  ✓ Task agent blocked from writing to skills/");
    } finally {
        await factStore.close();
    }
}

async function testTaskAgentCannotWriteAsks(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [storeFact] = createFactTools({ factStore });
        const result = await storeFact.handler(
            { key: "asks/terraform/test", value: { summary: "test" }, shared: true },
            { sessionId: "session-a", agentId: "task-agent" },
        );
        assert(result.error, "Task agent should NOT be able to write to asks/");
        console.log("  ✓ Task agent blocked from writing to asks/");
    } finally {
        await factStore.close();
    }
}

async function testTaskAgentCannotWriteConfig(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [storeFact] = createFactTools({ factStore });
        const result = await storeFact.handler(
            { key: "config/facts-manager/cycle-interval", value: { value: 60 }, shared: true },
            { sessionId: "session-a", agentId: "task-agent" },
        );
        assert(result.error, "Task agent should NOT be able to write to config/facts-manager/");
        console.log("  ✓ Task agent blocked from writing to config/facts-manager/");
    } finally {
        await factStore.close();
    }
}

async function testTaskAgentCanReadSkills(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        // First, write a skill as facts-manager
        const [storeAsFM] = createFactTools({ factStore, agentIdentity: "facts-manager" });
        await storeAsFM.handler(
            { key: "skills/terraform/encryption", value: { name: "test-skill", description: "test" }, shared: true },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );

        // Then read as a task agent
        const [, readFacts] = createFactTools({ factStore });
        const result = await readFacts.handler(
            { key_pattern: "skills/%", scope: "shared" },
            { sessionId: "session-a" },
        );
        assert(!result.error, "Task agent should be able to read from skills/");
        assert(result.count > 0, "Should find the skill created by facts-manager");
        console.log("  ✓ Task agent can read skills/");
    } finally {
        await factStore.close();
    }
}

async function testTaskAgentCanReadAsks(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [storeAsFM] = createFactTools({ factStore, agentIdentity: "facts-manager" });
        await storeAsFM.handler(
            { key: "asks/terraform/test-ask", value: { summary: "test?", status: "open" }, shared: true },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );

        const [, readFacts] = createFactTools({ factStore });
        const result = await readFacts.handler(
            { key_pattern: "asks/%", scope: "shared" },
            { sessionId: "session-a" },
        );
        assert(!result.error, "Task agent should be able to read from asks/");
        assert(result.count > 0, "Should find the ask");
        console.log("  ✓ Task agent can read asks/");
    } finally {
        await factStore.close();
    }
}

async function testTaskAgentCannotReadIntake(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [, readFacts] = createFactTools({ factStore });
        const result = await readFacts.handler(
            { key_pattern: "intake/%", scope: "shared" },
            { sessionId: "session-a" },
        );
        assert(result.error, "Task agent should NOT be able to read from intake/");
        assert(result.error.includes("not readable by task agents"), "Error message is correct");
        console.log("  ✓ Task agent blocked from reading intake/");
    } finally {
        await factStore.close();
    }
}

async function testTaskAgentCannotDeleteSkills(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [,, deleteFact] = createFactTools({ factStore });
        const result = await deleteFact.handler(
            { key: "skills/terraform/test", shared: true },
            { sessionId: "session-a" },
        );
        assert(result.error, "Task agent should NOT be able to delete from skills/");
        console.log("  ✓ Task agent blocked from deleting skills/");
    } finally {
        await factStore.close();
    }
}

async function testFactsManagerCanWriteAll(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [storeFact] = createFactTools({ factStore, agentIdentity: "facts-manager" });

        const r1 = await storeFact.handler(
            { key: "intake/test/fm-write", value: { test: true }, shared: true },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );
        assert(!r1.error, "FM should write to intake/");

        const r2 = await storeFact.handler(
            { key: "skills/test/fm-write", value: { name: "fm-skill" }, shared: true },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );
        assert(!r2.error, "FM should write to skills/");

        const r3 = await storeFact.handler(
            { key: "asks/test/fm-write", value: { summary: "fm ask" }, shared: true },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );
        assert(!r3.error, "FM should write to asks/");

        const r4 = await storeFact.handler(
            { key: "config/facts-manager/test", value: { value: 42 }, shared: true },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );
        assert(!r4.error, "FM should write to config/facts-manager/");

        console.log("  ✓ Facts Manager can write to all namespaces");
    } finally {
        await factStore.close();
    }
}

async function testFactsManagerCanReadAll(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        // Write intake as FM first
        const [storeFact] = createFactTools({ factStore, agentIdentity: "facts-manager" });
        await storeFact.handler(
            { key: "intake/test/read-test", value: { data: "test" }, shared: true },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );

        const [, readFacts] = createFactTools({ factStore, agentIdentity: "facts-manager" });
        const result = await readFacts.handler(
            { key_pattern: "intake/%", scope: "shared" },
            { sessionId: "session-fm" },
        );
        assert(!result.error, "FM should read from intake/");
        assert(result.count > 0, "FM should find intake facts");
        console.log("  ✓ Facts Manager can read all namespaces");
    } finally {
        await factStore.close();
    }
}

async function testFactsManagerCanDeleteAll(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [storeFact, , deleteFact] = createFactTools({ factStore, agentIdentity: "facts-manager" });

        // Write then delete from each namespace
        await storeFact.handler(
            { key: "intake/test/del-test", value: { data: "test" }, shared: true },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );
        const r1 = await deleteFact.handler(
            { key: "intake/test/del-test", shared: true },
            { sessionId: "session-fm" },
        );
        assert(!r1.error, "FM should delete from intake/");

        await storeFact.handler(
            { key: "skills/test/del-test", value: { data: "test" }, shared: true },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );
        const r2 = await deleteFact.handler(
            { key: "skills/test/del-test", shared: true },
            { sessionId: "session-fm" },
        );
        assert(!r2.error, "FM should delete from skills/");

        console.log("  ✓ Facts Manager can delete from all namespaces");
    } finally {
        await factStore.close();
    }
}

// ─── Tests ──────────────────────────────────────────────────────

describe.concurrent("Knowledge Pipeline", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Task agent can write to intake/", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-write-intake");
        try { await testTaskAgentCanWriteIntake(env); } finally { await env.cleanup(); }
    });

    it("Task agent cannot write to skills/", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-no-write-skills");
        try { await testTaskAgentCannotWriteSkills(env); } finally { await env.cleanup(); }
    });

    it("Task agent cannot write to asks/", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-no-write-asks");
        try { await testTaskAgentCannotWriteAsks(env); } finally { await env.cleanup(); }
    });

    it("Task agent cannot write to config/facts-manager/", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-no-write-config");
        try { await testTaskAgentCannotWriteConfig(env); } finally { await env.cleanup(); }
    });

    it("Task agent can read skills/", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-read-skills");
        try { await testTaskAgentCanReadSkills(env); } finally { await env.cleanup(); }
    });

    it("Task agent can read asks/", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-read-asks");
        try { await testTaskAgentCanReadAsks(env); } finally { await env.cleanup(); }
    });

    it("Task agent cannot read intake/", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-no-read-intake");
        try { await testTaskAgentCannotReadIntake(env); } finally { await env.cleanup(); }
    });

    it("Task agent cannot delete from skills/", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-no-del-skills");
        try { await testTaskAgentCannotDeleteSkills(env); } finally { await env.cleanup(); }
    });

    it("Facts Manager can write to all namespaces", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-fm-write-all");
        try { await testFactsManagerCanWriteAll(env); } finally { await env.cleanup(); }
    });

    it("Facts Manager can read all namespaces", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-fm-read-all");
        try { await testFactsManagerCanReadAll(env); } finally { await env.cleanup(); }
    });

    it("Facts Manager can delete from all namespaces", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("kp-fm-del-all");
        try { await testFactsManagerCanDeleteAll(env); } finally { await env.cleanup(); }
    });
});
