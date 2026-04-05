import { describe, it } from "vitest";
import { createFactTools } from "../../src/facts-tools.ts";
import { assertEqual } from "../helpers/assertions.js";

function createSpyFactStore() {
    const readCalls = [];
    return {
        readCalls,
        factStore: {
            async initialize() {},
            async storeFact() {
                return { key: "ignored", shared: false, stored: true };
            },
            async readFacts(query, access) {
                readCalls.push({ query, access });
                return { count: 0, facts: [] };
            },
            async deleteFact() {
                return { key: "ignored", shared: false, deleted: true };
            },
            async deleteSessionFactsForSession() {
                return 0;
            },
            async close() {},
        },
    };
}

describe("facts lineage contracts", () => {
    it("treats accessible scope as the full ancestor/descendant family tree", async () => {
        const { factStore, readCalls } = createSpyFactStore();
        const [, readFacts] = createFactTools({
            factStore,
            getLineageSessionIds: async (sessionId) => (
                sessionId === "middle-session"
                    ? ["root-session", "child-session"]
                    : []
            ),
        });

        await readFacts.handler(
            { scope: "accessible" },
            { sessionId: "middle-session" },
        );

        assertEqual(readCalls.length, 1, "readFacts should be called once");
        assertEqual(readCalls[0].query.scope, "accessible", "accessible scope should remain accessible");
        assertEqual(
            JSON.stringify(readCalls[0].access.grantedSessionIds),
            JSON.stringify(["root-session", "child-session"]),
            "accessible scope should include both ancestors and descendants",
        );
    });

    it("grants targeted reads to ancestor sessions in the same lineage", async () => {
        const { factStore, readCalls } = createSpyFactStore();
        const [, readFacts] = createFactTools({
            factStore,
            getLineageSessionIds: async (sessionId) => (
                sessionId === "child-session"
                    ? ["parent-session", "grandparent-session"]
                    : []
            ),
        });

        await readFacts.handler(
            { session_id: "parent-session" },
            { sessionId: "child-session" },
        );

        assertEqual(readCalls.length, 1, "targeted ancestor read should call the fact store once");
        assertEqual(readCalls[0].query.sessionId, "parent-session", "targeted ancestor should be passed through");
        assertEqual(
            JSON.stringify(readCalls[0].access.grantedSessionIds),
            JSON.stringify(["parent-session"]),
            "targeted ancestor reads should grant that ancestor session",
        );
    });

    it("does not grant unrelated targeted session reads", async () => {
        const { factStore, readCalls } = createSpyFactStore();
        const [, readFacts] = createFactTools({
            factStore,
            getLineageSessionIds: async () => ["parent-session", "child-session"],
        });

        await readFacts.handler(
            { session_id: "unrelated-session" },
            { sessionId: "middle-session" },
        );

        assertEqual(readCalls.length, 1, "unrelated targeted read should still call the fact store once");
        assertEqual(
            JSON.stringify(readCalls[0].access.grantedSessionIds),
            JSON.stringify([]),
            "unrelated targeted reads should not gain private session access",
        );
    });
});
