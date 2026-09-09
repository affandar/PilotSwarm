import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const KEY = "copilot.native_tasks";
async function featurePage(page, { admin = true, themeId = "workspace-dark" } = {}) {
    const stub = await startStubServer(0, { sessionCount: 1, admin, themeId });
    const state = { revision: 1, cluster: null, user: null, appliedRevision: "1", calls: [], reads: 0 };
    const view = scope => {
        const enabled = state.cluster?.enabled ?? false;
        const override = state.cluster?.allowUserOverride ?? false;
        const user = scope === "cluster" ? null : state.user;
        return { flags: [{ featureKey: KEY, displayName: "Native Copilot tasks", description: "Delegate local work on the same worker.",
            revision: String(state.revision), defaultEnabled: false, defaultAllowUserOverride: false, requiredCapability: KEY,
            cluster: state.cluster, user, supported: true, effective: override && user ? user.enabled : enabled,
            source: override && user ? "user" : "cluster", userOverrideIgnored: Boolean(user && !override) }] };
    };
    await page.route("**/api/auth/me", route => route.fulfill({ json: { ok: true,
        principal: { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User" },
        authorization: { allowed: true, role: admin ? "admin" : "user" } } }));
    await page.route("**/api/v1/workers", route => route.fulfill({ json: { ok: true, result: [{ workerNodeId: "local-test-worker", updatedAt: new Date().toISOString(), state: {
        "feature-flags": { supportedKeys: [KEY], appliedRevisions: { [KEY]: state.appliedRevision }, nativeCapability: "sync" },
    } }] } }));
    await page.route("**/api/v1/management/**", async route => {
        const request = route.request(), url = new URL(request.url());
        if (!url.pathname.includes("/features")) return route.fallback();
        if (url.pathname.endsWith("/features/users")) return route.fulfill({ json: { ok: true, result: [
            { userId: 901, subject: "target-owner", displayName: "Test Target", email: "target@test" },
        ] } });
        const scope = url.pathname.includes("/features/cluster") ? "cluster" : "user";
        if (request.method() === "GET") { state.reads++; return route.fulfill({ json: { ok: true, result: view(scope) } }); }
        const input = request.method() === "DELETE" ? Object.fromEntries(url.searchParams) : request.postDataJSON();
        state.calls.push({ method: request.method(), path: url.pathname, input });
        if (input.expectedRevision !== String(state.revision)) return route.fulfill({ status: 409, json: { ok: false, error: { message: "Feature changed; reload before saving", code: "FEATURE_CONFLICT" } } });
        state.revision++;
        state[scope] = request.method() === "DELETE" ? null : { enabled: input.enabled, ...(scope === "cluster" ? { allowUserOverride: input.allowUserOverride } : {}) };
        return route.fulfill({ json: { ok: true, result: { featureKey: KEY, revision: String(state.revision), setting: state[scope] } } });
    });
    await page.goto(`http://127.0.0.1:${stub.port}`);
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.getByRole("button", { name: admin ? "Admin console" : "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Feature flags", exact: true }).click();
    await page.locator(".ps-feature-flag").waitFor();
    return { state, stop: () => new Promise(resolve => stub.server.close(resolve)) };
}

test("admin can save cluster/user policy, observe worker adoption and preserve unsaved changes across polling", async ({ page }) => {
    const fixture = await featurePage(page);
    try {
        await page.getByRole("tab", { name: "Cluster", exact: true }).click();
        await page.getByRole("checkbox", { name: "Cluster default enabled" }).check();
        await page.getByRole("checkbox", { name: "Allow user override" }).check();
        // A real click wires draft protection into the controller, unlike SSR.
        await page.clock.install();
        const reads = fixture.state.reads;
        await page.clock.fastForward(24_000);
        await expect(page.getByRole("checkbox", { name: "Cluster default enabled" })).toBeChecked();
        expect(fixture.state.reads).toBe(reads);
        await page.getByRole("button", { name: "Save cluster policy" }).click();
        await expect(page.locator(".ps-feature-value")).toHaveText("Effective: On");
        expect(fixture.state.calls[0].input).toMatchObject({ enabled: true, allowUserOverride: true, expectedRevision: "1" });
        await expect(page.locator(".ps-feature-adoption summary")).toContainText("0/1 workers applied this revision");
        fixture.state.appliedRevision = "2";
        await page.clock.fastForward(24_000);
        await expect(page.locator(".ps-feature-adoption summary")).toContainText("1/1 workers applied this revision");
        await page.getByRole("tab", { name: "Users", exact: true }).click();
        await page.getByRole("searchbox", { name: "Find feature settings user" }).fill("target");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("combobox", { name: "Feature settings user" }).selectOption("901");
        await page.getByRole("combobox", { name: "Native Copilot tasks preference" }).selectOption("false");
        await expect(page.locator(".ps-feature-value")).toHaveText("Effective: Off");
        expect(fixture.state.calls.at(-1).path).toBe(`/api/v1/management/users/901/features/${KEY}`);
        await page.getByRole("combobox", { name: "Native Copilot tasks preference" }).selectOption("inherit");
        await expect(page.locator(".ps-feature-value")).toHaveText("Effective: On");
        expect(fixture.state.calls.at(-1)).toMatchObject({ method: "DELETE", input: { expectedRevision: "3" } });
    } finally { await fixture.stop(); }
});

test("non-admin preferences remain visible when cluster overrides are locked", async ({ page }) => {
    const fixture = await featurePage(page, { admin: false });
    try {
        await expect(page.getByRole("tab", { name: "Cluster", exact: true })).toHaveCount(0);
        await expect(page.getByRole("tab", { name: "Users", exact: true })).toHaveCount(0);
        await page.getByRole("combobox", { name: "Native Copilot tasks preference" }).selectOption("true");
        await expect(page.locator(".ps-feature-value")).toHaveText("Effective: Off");
        await expect(page.locator(".ps-feature-flag")).toContainText("saved preference is inactive");
        expect(fixture.state.calls[0].path).toBe(`/api/v1/management/users/me/features/${KEY}`);
        await expect(page.getByRole("combobox", { name: "Native Copilot tasks preference" })).toHaveValue("true");
    } finally { await fixture.stop(); }
});

for (const themeId of ["workspace-dark", "github-light"]) {
    test(`feature controls use theme tokens and fit a narrow viewport (${themeId})`, async ({ page }) => {
        const fixture = await featurePage(page, { themeId });
        try {
            const select = page.getByRole("combobox", { name: "Native Copilot tasks preference" });
            expect(await select.evaluate(node => {
                const probe = document.createElement("span"); probe.style.color = "var(--ps-foreground)"; document.body.append(probe);
                const equal = getComputedStyle(probe).color === getComputedStyle(node).color; probe.remove(); return equal;
            })).toBe(true);
            await page.setViewportSize({ width: 390, height: 844 });
            const panel = page.locator(".ps-feature-flags-panel");
            await expect(panel).toBeVisible();
            expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            await page.getByRole("tab", { name: "Users", exact: true }).click();
            expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        } finally { await fixture.stop(); }
    });
}
