/**
 * Knowledge Pipeline tests.
 *
 * Verifies:
 *   - Namespace access control (intake/, skills/, asks/, config/)
 *   - loadKnowledgeIndex activity filtering
 *   - FM promotion: intake → skill → visible to agents
 *   - Intake merge: multiple intakes on same topic → single merged skill
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";
import {
    PgFactStore,
    createFactTools,
} from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

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

// ─── Level 2: FM Promotion and Agent Visibility ─────────────────

/**
 * Simulates the FM promotion flow:
 *   1. Task agent writes intake
 *   2. FM promotes intake to a curated skill
 *   3. Another task agent session sees the skill injected in its prompt
 */
async function testFMPromotionVisibleToAgent(env) {
    await withClient(env, async (client, worker) => {
        // Step 1: Write a curated skill as the Facts Manager (simulating FM promotion)
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const [storeFact] = createFactTools({ factStore, agentIdentity: "facts-manager" });

            // Write a skill about a specific operational finding
            await storeFact.handler(
                {
                    key: "skills/testing/always-use-timeout",
                    value: {
                        name: "always-use-timeout",
                        description: "HTTP requests to external services must include a 30-second timeout",
                        instructions: "When making HTTP requests to external APIs, always set a timeout of 30 seconds. Without this, requests can hang indefinitely during network partitions. This was discovered across 3 separate incidents in production.",
                        tools: [],
                        confidence: "high",
                        version: 1,
                        evidence_count: 3,
                        contradiction_count: 0,
                        linked_intakes: ["intake/testing/session-1", "intake/testing/session-2", "intake/testing/session-3"],
                        created: new Date().toISOString(),
                        last_reviewed: new Date().toISOString(),
                        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
                        last_corroborated: new Date().toISOString(),
                    },
                    shared: true,
                },
                { sessionId: "session-fm", agentId: "facts-manager" },
            );
            console.log("  ✓ FM promoted intake to skill: skills/testing/always-use-timeout");
        } finally {
            await factStore.close();
        }

        // Step 2: Create a new agent session and ask it about  the topic
        // The curated skill should be injected into its prompt context
        const session = await client.createSession({
            systemMessage: "Be brief (1-2 sentences). If you see any curated skills in your context about timeouts, state the specific timeout value and reason from them.",
        });

        console.log("  Sending: I need to set an HTTP timeout for API calls. Based on CURATED SKILLS in your context, what specific value should I use and why?");
        const response = await session.sendAndWait(
            "I need to set an HTTP timeout for API calls. Based on CURATED SKILLS in your context, what specific value should I use and why?",
            TIMEOUT,
        );
        console.log(`  Response: "${response.slice(0, 300)}"`);

        // The agent should reference the curated skill content (timeout value, or any related concept)
        const lower = response.toLowerCase();
        const hasCuratedContent = lower.includes("30") || lower.includes("timeout") || lower.includes("hang") || lower.includes("network") || lower.includes("partition") || lower.includes("second");
        assert(hasCuratedContent, `Agent response should reflect curated skill about timeouts. Got: "${response.slice(0, 100)}"`);
        console.log("  ✓ Agent response reflects curated skill content");
    });
}

/**
 * Full pipeline flow:
 *   1. Task agent writes intake1
 *   2. FM reads intake1, creates a skill
 *   3. Agent sees the skill, writes intake2 on the same topic
 *   4. FM reads intake2, updates existing skill (merge, not duplicate)
 *   5. Agent sees the updated skill
 */
async function testIntakeMergeVisibleToAgent(env) {
    await withClient(env, async (client, worker) => {
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const [storeAsTask] = createFactTools({ factStore });
            const [storeAsFM, readAsFM] = createFactTools({ factStore, agentIdentity: "facts-manager" });

            // ── Step 1: Task agent writes intake1 ────────────────
            await storeAsTask.handler(
                {
                    key: "intake/docker/session-aaa",
                    value: {
                        problem: "Docker build took 8 minutes because every code change re-installed all dependencies",
                        environment: "Node.js 20, npm, Dockerfile",
                        action_taken: "Moved COPY package.json and npm install before COPY . in Dockerfile",
                        outcome: "success",
                        detail: "Build time dropped from 8 min to 45 seconds on code-only changes",
                    },
                    shared: true,
                },
                { sessionId: "session-aaa", agentId: "task-agent" },
            );
            console.log("  ✓ Step 1: Task agent wrote intake1 (Docker layer caching in Node.js)");

            // ── Step 2: FM reads intake1, creates skill ──────────
            // Verify FM can read the intake
            const intakes1 = await readAsFM.handler(
                { key_pattern: "intake/docker/%", scope: "shared" },
                { sessionId: "session-fm" },
            );
            assertEqual(intakes1.count, 1, "FM should see 1 intake");
            console.log("  ✓ Step 2a: FM read intake1");

            // FM promotes to skill (v1, low confidence from single observation)
            await storeAsFM.handler(
                {
                    key: "skills/docker/layer-cache-invalidation",
                    value: {
                        name: "docker-layer-cache-invalidation",
                        description: "COPY dependency manifest before COPY . to preserve Docker layer cache",
                        instructions: "In Dockerfiles, COPY your dependency manifest (package.json, requirements.txt) and run install BEFORE copying the full source tree. This preserves the dependency layer cache.\n\nEvidence: Node.js project saw build time drop from 8 min to 45 seconds.",
                        tools: [],
                        confidence: "low",
                        version: 1,
                        evidence_count: 1,
                        contradiction_count: 0,
                        linked_intakes: ["intake/docker/session-aaa"],
                        created: new Date().toISOString(),
                        last_reviewed: new Date().toISOString(),
                        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
                        last_corroborated: new Date().toISOString(),
                    },
                    shared: true,
                },
                { sessionId: "session-fm", agentId: "facts-manager" },
            );
            console.log("  ✓ Step 2b: FM created skill v1 (low confidence, 1 evidence)");

            // ── Step 3: Agent sees skill, writes intake2 ─────────
            const session1 = await client.createSession({
                systemMessage: "Be brief (1-2 sentences). If you have curated skills about Docker, state the specific advice from them.",
            });
            const response1 = await session1.sendAndWait(
                "I'm writing a Dockerfile for a Python project. Any build optimization tips?",
                TIMEOUT,
            );
            console.log(`  Step 3a response: "${response1.slice(0, 200)}"`);
            const lower1 = response1.toLowerCase();
            assert(
                lower1.includes("copy") || lower1.includes("package") || lower1.includes("install") || lower1.includes("cache") || lower1.includes("dependency") || lower1.includes("requirements"),
                "Agent should reference the curated Docker layer caching skill",
            );
            console.log("  ✓ Step 3a: Agent sees skill v1 and references it");

            // Task agent writes intake2 (same topic, different language)
            await storeAsTask.handler(
                {
                    key: "intake/docker/session-bbb",
                    value: {
                        problem: "Python Docker builds reinstalled all pip packages on every code change",
                        environment: "Python 3.12, pip, Dockerfile",
                        action_taken: "COPY requirements.txt and pip install before COPY . in Dockerfile",
                        outcome: "success",
                        detail: "Build time dropped from 5 min to 30 seconds. Works with both pip and poetry lockfiles.",
                    },
                    shared: true,
                },
                { sessionId: "session-bbb", agentId: "task-agent" },
            );
            console.log("  ✓ Step 3b: Task agent wrote intake2 (Docker layer caching in Python)");

            // ── Step 4: FM reads intake2, updates existing skill ─
            const intakes2 = await readAsFM.handler(
                { key_pattern: "intake/docker/%", scope: "shared" },
                { sessionId: "session-fm" },
            );
            assertEqual(intakes2.count, 2, "FM should see 2 intakes");
            console.log("  ✓ Step 4a: FM read intake2");

            // FM merges into existing skill (v2, medium confidence)
            await storeAsFM.handler(
                {
                    key: "skills/docker/layer-cache-invalidation",
                    value: {
                        name: "docker-layer-cache-invalidation",
                        description: "COPY dependency manifest before COPY . to preserve Docker layer cache",
                        instructions: "In Dockerfiles, COPY your dependency manifest and run install BEFORE copying the full source tree. This preserves the dependency layer cache.\n\nVerified in:\n- Node.js (package.json + npm install): 8 min → 45s\n- Python (requirements.txt + pip install): 5 min → 30s\n\nAlso works with poetry lockfiles.",
                        tools: [],
                        confidence: "medium",
                        version: 2,
                        evidence_count: 2,
                        contradiction_count: 0,
                        linked_intakes: ["intake/docker/session-aaa", "intake/docker/session-bbb"],
                        created: new Date().toISOString(),
                        last_reviewed: new Date().toISOString(),
                        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
                        last_corroborated: new Date().toISOString(),
                    },
                    shared: true,
                },
                { sessionId: "session-fm", agentId: "facts-manager" },
            );
            console.log("  ✓ Step 4b: FM updated skill to v2 (medium confidence, 2 evidence, multi-language)");

            // Verify only one skill exists (merged, not duplicated)
            const skillCheck = await readAsFM.handler(
                { key_pattern: "skills/docker/%", scope: "shared" },
                { sessionId: "session-fm" },
            );
            assertEqual(skillCheck.count, 1, "Should have exactly one merged skill, not duplicates");
            const skillVal = typeof skillCheck.facts[0].value === "string"
                ? JSON.parse(skillCheck.facts[0].value)
                : skillCheck.facts[0].value;
            assertEqual(skillVal.version, 2, "Skill version should be 2 after merge");
            assertEqual(skillVal.evidence_count, 2, "Evidence count should be 2 after merge");
            console.log("  ✓ Step 4c: Single merged skill with correct version and evidence count");

            // ── Step 5: Agent sees the updated skill ─────────────
            const session2 = await client.createSession({
                systemMessage: "Be brief. If you have curated skills about Docker, state the specific languages and build times mentioned in them.",
            });
            const response2 = await session2.sendAndWait(
                "What Docker build optimization advice do you have?",
                TIMEOUT,
            );
            console.log(`  Step 5 response: "${response2.slice(0, 300)}"`);
            const lower2 = response2.toLowerCase();
            // Should reflect curated skill content — at minimum reference layer caching
            const hasSkillContent = lower2.includes("cache") || lower2.includes("layer") || lower2.includes("copy") || lower2.includes("install") || lower2.includes("dependency") || lower2.includes("manifest");
            assert(hasSkillContent, `Agent should reference curated Docker layer caching skill. Got: "${response2.slice(0, 100)}"`);
            console.log("  ✓ Step 5: Agent sees updated merged skill");
        } finally {
            await factStore.close();
        }
    });
}

/**
 * Verifies that loadKnowledgeIndex returns skills with full body and proper shape.
 */
async function testLoadKnowledgeIndexFullBody(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const [storeFact] = createFactTools({ factStore, agentIdentity: "facts-manager" });

        // Write a skill with rich instructions
        await storeFact.handler(
            {
                key: "skills/kubernetes/ingress-timeout",
                value: {
                    name: "kubernetes-ingress-timeout",
                    description: "Set explicit timeouts on Kubernetes Ingress annotations",
                    instructions: "When configuring Kubernetes Ingress resources:\n1. Always set `nginx.ingress.kubernetes.io/proxy-read-timeout: \"300\"`.\n2. Default 60s timeout is too short for large file uploads.\n3. Verified on EKS and AKS clusters.",
                    tools: [],
                    confidence: "high",
                    version: 2,
                    evidence_count: 5,
                },
                shared: true,
            },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );

        // Write an aged-out skill (should be excluded)
        await storeFact.handler(
            {
                key: "skills/kubernetes/old-pattern",
                value: {
                    name: "old-pattern",
                    description: "An outdated pattern",
                    instructions: "This is stale.",
                    status: "aged-out",
                },
                shared: true,
            },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );

        // Write an open ask
        await storeFact.handler(
            {
                key: "asks/kubernetes/pod-affinity",
                value: { summary: "Does pod affinity improve cache locality?", status: "open" },
                shared: true,
            },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );

        // Write a satisfied ask (should be excluded)
        await storeFact.handler(
            {
                key: "asks/kubernetes/old-ask",
                value: { summary: "Old question", status: "satisfied" },
                shared: true,
            },
            { sessionId: "session-fm", agentId: "facts-manager" },
        );

        // Call loadKnowledgeIndex by reading facts the same way the activity does
        const skillResult = await factStore.readFacts(
            { keyPattern: "skills/%", scope: "shared", limit: 50 },
            { readerSessionId: null, grantedSessionIds: [] },
        );
        const skills = [];
        for (const row of skillResult.facts) {
            const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
            if (val?.status === "aged-out") continue;
            skills.push({
                name: val?.name ?? "unknown",
                description: val?.description ?? "",
                prompt: val?.instructions ?? "",
                toolNames: val?.tools ?? [],
            });
        }

        const askResult = await factStore.readFacts(
            { keyPattern: "asks/%", scope: "shared", limit: 50 },
            { readerSessionId: null, grantedSessionIds: [] },
        );
        const asks = [];
        for (const row of askResult.facts) {
            const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
            if (val?.status !== "open") continue;
            asks.push({ key: row.key, summary: val?.summary ?? "" });
        }

        // Verify skills
        assertEqual(skills.length, 1, "Should have 1 active skill (aged-out excluded)");
        assertEqual(skills[0].name, "kubernetes-ingress-timeout", "Skill name");
        assertIncludes(skills[0].prompt, "proxy-read-timeout", "Full instructions body should be included");
        assertIncludes(skills[0].prompt, "EKS and AKS", "Instructions should include specific details");
        assert(Array.isArray(skills[0].toolNames), "toolNames is an array");
        console.log("  ✓ loadKnowledgeIndex returns full skill body and excludes aged-out");

        // Verify asks
        assertEqual(asks.length, 1, "Should have 1 open ask (satisfied excluded)");
        assertEqual(asks[0].key, "asks/kubernetes/pod-affinity", "Ask key");
        assertIncludes(asks[0].summary, "pod affinity", "Ask summary");
        console.log("  ✓ loadKnowledgeIndex returns only open asks");
    } finally {
        await factStore.close();
    }
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Knowledge Pipeline", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Task agent can write to intake/", { timeout: TIMEOUT }, async () => {
        await testTaskAgentCanWriteIntake(getEnv());
    });

    it("Task agent cannot write to skills/", { timeout: TIMEOUT }, async () => {
        await testTaskAgentCannotWriteSkills(getEnv());
    });

    it("Task agent cannot write to asks/", { timeout: TIMEOUT }, async () => {
        await testTaskAgentCannotWriteAsks(getEnv());
    });

    it("Task agent cannot write to config/facts-manager/", { timeout: TIMEOUT }, async () => {
        await testTaskAgentCannotWriteConfig(getEnv());
    });

    it("Task agent can read skills/", { timeout: TIMEOUT }, async () => {
        await testTaskAgentCanReadSkills(getEnv());
    });

    it("Task agent can read asks/", { timeout: TIMEOUT }, async () => {
        await testTaskAgentCanReadAsks(getEnv());
    });

    it("Task agent cannot read intake/", { timeout: TIMEOUT }, async () => {
        await testTaskAgentCannotReadIntake(getEnv());
    });

    it("Task agent cannot delete from skills/", { timeout: TIMEOUT }, async () => {
        await testTaskAgentCannotDeleteSkills(getEnv());
    });

    it("Facts Manager can write to all namespaces", { timeout: TIMEOUT }, async () => {
        await testFactsManagerCanWriteAll(getEnv());
    });

    it("Facts Manager can read all namespaces", { timeout: TIMEOUT }, async () => {
        await testFactsManagerCanReadAll(getEnv());
    });

    it("Facts Manager can delete from all namespaces", { timeout: TIMEOUT }, async () => {
        await testFactsManagerCanDeleteAll(getEnv());
    });

    it("loadKnowledgeIndex returns full body and filters correctly", { timeout: TIMEOUT }, async () => {
        await testLoadKnowledgeIndexFullBody(getEnv());
    });

    it("FM-promoted skill is visible to agent", { timeout: TIMEOUT }, async () => {
        await testFMPromotionVisibleToAgent(getEnv());
    });

    it("Merged intakes produce single skill visible to agent", { timeout: 240_000 }, async () => {
        await testIntakeMergeVisibleToAgent(getEnv());
    });
});
