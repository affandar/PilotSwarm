// The admin console, in a real browser. It had no coverage at all, and the
// Workers pane had drifted off the theme: it referenced a token nothing
// defines (--ps-muted-foreground) so its muted text fell back to a hardcoded
// GitHub grey, and its status pills were three literal hexes. Both ignore the
// palette in every theme, which is invisible until you put two panes side by
// side. These assertions compare against the LIVE token values, so they hold
// for any theme rather than pinning one theme's hexes.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { startProviderBudgetStub } from "./providers-budget-stub.mjs";

const token = (page, name) => page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
);
const styleOf = (locator, prop) => locator.evaluate(
    (node, p) => getComputedStyle(node).getPropertyValue(p),
    prop,
);

async function openWorkers(page, base) {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.locator('button[aria-label="Admin console"]').click();
    await page.getByText("Workers", { exact: true }).first().click();
    await page.locator(".ps-admin-workers__table").waitFor();
}

for (const themeId of ["workspace-dark", "github-light"]) {
    test.describe(`[${themeId}] admin → workers`, () => {
        let stub;
        let base;
        test.beforeAll(async () => {
            stub = await startStubServer(0, { sessionCount: 4, admin: true, themeId });
            base = `http://127.0.0.1:${stub.port}`;
        });
        test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

        test("the fleet table is on the theme's font and type scale", async ({ page }) => {
            await openWorkers(page, base);
            const table = page.locator(".ps-admin-workers__table");
            const body = await styleOf(page.locator("body"), "font-family");
            // Same face as the rest of the app, not a UA default.
            expect(await styleOf(table, "font-family")).toBe(body);
            // Same step of the scale as the console around it.
            expect(await styleOf(table, "font-size")).toBe(await token(page, "--ps-font-size-base"));
        });

        test("status pills and muted text read from the palette", async ({ page }) => {
            await openWorkers(page, base);
            const ready = page.locator(".ps-worker-phase.is-ready").first();
            const starting = page.locator(".ps-worker-phase.is-starting").first();
            // getComputedStyle returns rgb(); compare rendered against rendered
            // by painting the token onto a probe element.
            const asRendered = async (name) => page.evaluate((n) => {
                const probe = document.createElement("span");
                probe.style.color = `var(${n})`;
                document.body.appendChild(probe);
                const value = getComputedStyle(probe).color;
                probe.remove();
                return value;
            }, name);
            expect(await styleOf(ready, "color")).toBe(await asRendered("--ps-success"));
            expect(await styleOf(starting, "color")).toBe(await asRendered("--ps-warning"));
            expect(await styleOf(page.locator(".ps-admin-workers__summary"), "color"))
                .toBe(await asRendered("--ps-muted"));
        });
    });
}

test("Model Providers owns provider onboarding and all default routing controls", async ({ page }) => {
    const stub = await startProviderBudgetStub({ admin: true });
    try {
        await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
        await page.locator(".ps-session-list-button").first().waitFor();
        await page.locator('button[aria-label="Admin console"]').click();

        await expect(page.locator(".ps-admin-model-providers h3").first()).toHaveText("Model Providers");
        await expect(page.getByText("GitHub Keys", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Refresh model providers" })).toBeVisible();
        await expect(page.getByRole("combobox", { name: "My Session Default" }))
            .toHaveValue("my-sandbox:gpt-5.4");
        await expect(page.getByRole("checkbox", { name: "Allow system sessions" })).toBeChecked();
        await expect(page.getByRole("combobox", { name: "Cluster Session Default" })).toHaveCount(0);

        const add = page.getByRole("button", { name: "Add personal provider" });
        await add.click();
        await expect(page.locator(".ps-budget-sheet-title")).toHaveText("Add GitHub Copilot provider");
        await expect(page.getByRole("textbox", { name: "Provider display name" })).toHaveCount(0);
        const secret = page.locator('.ps-budget-sheet input[type="password"]');
        await expect(secret).toHaveAttribute("placeholder", "Paste token");
        await secret.fill("not-a-real-secret");
        await page.getByRole("button", { name: "Cancel" }).click();
        await add.click();
        await expect(page.locator('.ps-budget-sheet input[type="password"]')).toHaveValue("");
        await page.getByRole("button", { name: "Cancel" }).click();

        await page.getByRole("button", { name: "Shared Providers" }).click();
        await expect(page.getByRole("combobox", { name: "My Session Default" })).toHaveCount(0);
        const cluster = page.getByRole("combobox", { name: "Cluster Session Default" });
        await expect(cluster).toHaveValue("copilot-shared:claude-sonnet-5");
        await expect(cluster.locator('option[value="my-sandbox:gpt-5.4"]')).toHaveCount(0);

        const system = page.getByRole("combobox", { name: "Model", exact: true });
        await expect(system.locator('option[value="my-sandbox:gpt-5.4"]')).toHaveCount(1);
        await expect(page.locator('.ps-budget-seg[aria-label="Existing system sessions"] button'))
            .toHaveText(["Future only", "Complete & restart", "Terminate & restart", "Hard delete & restart"]);
        await expect(page.getByRole("combobox", { name: "Model override for sweeper" }))
            .toHaveValue("copilot-shared:claude-sonnet-5");
    } finally {
        await stub.close();
    }
});
