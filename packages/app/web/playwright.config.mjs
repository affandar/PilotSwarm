import { defineConfig, devices } from "@playwright/test";

// Layout and cascade tests. These assert PROPERTIES — computed styles and
// geometry — not screenshots: a pixel baseline fails on font rendering and
// platform differences, and states nothing about the rule being enforced.
export default defineConfig({
    testDir: "./test/e2e",
    testMatch: /.*\.spec\.mjs/,
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    reporter: [["list"]],
    use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
    },
});
