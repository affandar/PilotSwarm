import { describe, expect, it } from "vitest";
import { startDurableWorkflow } from "../dist/src/horizon-store.js";

describe("pg_durable workflow start collisions", () => {
    it("retries only random df.nodes primary-key collisions", async () => {
        let calls = 0;
        const exec = {
            async query() {
                calls += 1;
                if (calls < 3) {
                    throw Object.assign(new Error('duplicate key value violates unique constraint "nodes_pkey"'), {
                        code: "23505",
                        constraint: "nodes_pkey",
                    });
                }
                return { rows: [{ iid: "deadbeef" }] };
            },
        };

        await expect(startDurableWorkflow(exec, "SELECT df.start($1)", ["workflow"]))
            .resolves.toBe("deadbeef");
        expect(calls).toBe(3);
    });

    it("does not swallow unrelated unique violations", async () => {
        const error = Object.assign(new Error("duplicate provider"), {
            code: "23505",
            constraint: "provider_name_key",
        });

        await expect(startDurableWorkflow({ query: async () => { throw error; } }, "SELECT 1", []))
            .rejects.toBe(error);
    });
});
