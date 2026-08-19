import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        pool: "forks",
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
