import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const KEY = "copilot.native_tasks";
const targetUsers = [
    { userId: 901, subject: "target-owner", displayName: "Test Target", email: "target@test" },
    { userId: 902, subject: "other-owner", displayName: "Other Target", email: "other@test" },
];

// Real browser/controller/HTTP transport; mutable policy service and worker wire telemetry.
async function featurePage(page, { admin = true, themeId = "workspace-dark", cluster = { enabled: false, allowUserOverride: true }, user = null, workers = null } = {}) {
    const stub = await startStubServer(0, { sessionCount: 1, admin, themeId });
    const state = { revision: 1, cluster, preferences: { me: user, 901: user, 902: null }, defaults: { enabled: false, allowUserOverride: false },
        appliedRevision: "1", calls: [], reads: 0, nextError: null, holdMutation: null, workers };
    const view = (scope, userId) => {
        const enabled = state.cluster?.enabled ?? state.defaults.enabled;
        const override = state.cluster?.allowUserOverride ?? state.defaults.allowUserOverride;
        const preference = scope === "cluster" ? null : state.preferences[userId] ?? null;
        return { flags: [{ featureKey: KEY, displayName: "Native Copilot tasks", description: "Delegate local work on the same worker.",
            revision: String(state.revision), defaultEnabled: state.defaults.enabled, defaultAllowUserOverride: state.defaults.allowUserOverride,
            requiredCapability: KEY, cluster: state.cluster, user: preference, supported: true,
            effective: override && preference ? preference.enabled : enabled,
            source: override && preference ? "user" : "cluster", userOverrideIgnored: Boolean(preference && !override) }] };
    };
    await page.route("**/api/auth/me", route => route.fulfill({ json: { ok: true,
        principal: { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User" },
        authorization: { allowed: true, role: admin ? "admin" : "user" } } }));
    await page.route("**/api/v1/workers", route => route.fulfill({ json: { ok: true, result: state.workers ?? [{ workerNodeId: "local-test-worker",
        updatedAt: new Date().toISOString(), phase: "ready", state: { "feature-flags": { initialized: true, protocolVersion: 1,
            supportedKeys: [KEY], appliedRevisions: { [KEY]: state.appliedRevision }, nativeCapability: "sync" } } }] } }));
    await page.route("**/api/v1/management/**", async route => {
        const request = route.request(), url = new URL(request.url());
        if (!url.pathname.includes("/features")) return route.fallback();
        if (url.pathname.endsWith("/features/users")) {
            const query = (url.searchParams.get("query") || "").toLowerCase();
            return route.fulfill({ json: { ok: true, result: targetUsers.filter(user =>
                [user.displayName, user.email, user.subject].some(value => value.toLowerCase().includes(query))) } });
        }
        const scope = url.pathname.includes("/features/cluster") ? "cluster" : "user";
        const userId = url.pathname.match(/\/users\/([^/]+)\/features/)?.[1] || "me";
        if (request.method() === "GET") { state.reads++; return route.fulfill({ json: { ok: true, result: view(scope, userId) } }); }
        const input = request.method() === "DELETE" ? Object.fromEntries(url.searchParams) : request.postDataJSON();
        state.calls.push({ method: request.method(), path: url.pathname, input });
        if (state.holdMutation) await state.holdMutation;
        if (state.nextError) {
            const failure = state.nextError; state.nextError = null;
            return route.fulfill({ status: failure.status, json: { ok: false, error: { message: failure.message, code: failure.code || "SAVE_FAILED" } } });
        }
        if (input.expectedRevision !== String(state.revision)) return route.fulfill({ status: 409,
            json: { ok: false, error: { message: "Feature changed; review the latest settings before saving", code: "FEATURE_CONFLICT" } } });
        state.revision++;
        const setting = request.method() === "DELETE" ? null : { enabled: input.enabled,
            ...(scope === "cluster" ? { allowUserOverride: input.allowUserOverride } : {}) };
        if (scope === "cluster") state.cluster = setting;
        else state.preferences[userId] = setting;
        return route.fulfill({ json: { ok: true, result: { featureKey: KEY, revision: String(state.revision), setting } } });
    });
    await page.goto(`http://127.0.0.1:${stub.port}`);
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.getByRole("button", { name: admin ? "Admin console" : "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Feature flags", exact: true }).click();
    await page.locator(".ps-feature-flag").waitFor();
    return { state, stop: () => new Promise(resolve => stub.server.close(resolve)) };
}

const saved = page => page.locator(".ps-feature-value");
const preview = page => page.locator(".ps-feature-preview");
const scopeTab = (page, scope) => page.getByRole("tab", { name: new RegExp(`^${scope} settings`) });
const clusterChoice = (page, choice) => page.getByRole("group", { name: "Cluster setting", exact: true }).getByRole("radio", { name: choice, exact: true });
const personalChoice = (page, choice) => page.getByRole("group", { name: "Personal settings", exact: true }).getByRole("radio", { name: choice, exact: true });
const save = page => page.getByRole("button", { name: "Save changes", exact: true });
const discard = page => page.getByRole("button", { name: "Discard changes", exact: true });
const refresh = page => page.getByRole("button", { name: "Refresh settings", exact: true });
async function selectUser(page, userId) {
    await scopeTab(page, "User").click();
    await page.getByRole("combobox", { name: "Feature settings user" }).selectOption(String(userId));
    await expect(page.locator(".ps-feature-flag")).toBeVisible();
}

for (const clusterEnabled of [false, true]) for (const allowUserOverride of [false, true]) for (const preference of [null, false, true]) {
    test(`precedence: cluster ${clusterEnabled ? "On" : "Off"}, personal settings ${allowUserOverride ? "allowed" : "locked"}, preference ${preference === null ? "inherit" : preference ? "On" : "Off"}`, async ({ page }) => {
        const fixture = await featurePage(page, { cluster: { enabled: clusterEnabled, allowUserOverride }, user: preference === null ? null : { enabled: preference } });
        try {
            const effective = allowUserOverride && preference !== null ? preference : clusterEnabled;
            const value = effective ? "On" : "Off";
            await expect(saved(page)).toHaveText(`${value} for you`);
            await expect(page.locator(".ps-feature-saved")).toContainText("Saved setting");
            await expect(page.locator(".ps-feature-saved")).toContainText(!allowUserOverride ? "Required by the cluster" : preference === null ? "Following the cluster setting" : "Using your choice");
            await expect(page.getByRole("radio", { name: preference === null ? `Use cluster setting (currently ${clusterEnabled ? "On" : "Off"})` : preference ? "On for me" : "Off for me", exact: true })).toBeChecked();
            if (!allowUserOverride) await expect(page.getByRole("group", { name: "Preference for when personal settings are allowed", exact: true })).toBeVisible();
            await scopeTab(page, "Cluster").click();
            await expect(saved(page)).toHaveText(`${clusterEnabled ? "On" : "Off"} ${allowUserOverride ? "by default" : "for everyone"}`);
            await expect(clusterChoice(page, clusterEnabled ? "On" : "Off")).toBeChecked();
            await expect(personalChoice(page, allowUserOverride ? "Allowed" : "Not allowed")).toBeChecked();
            await selectUser(page, 901);
            await expect(saved(page)).toHaveText(`${value} for Test Target`);
            await expect(page.locator(".ps-feature-user")).toContainText("target@test");
            expect(fixture.state.calls).toHaveLength(0);
        } finally { await fixture.stop(); }
    });
}

test("personal and cluster edits require Save; a delayed save preserves the saved outcome", async ({ page }) => {
    const fixture = await featurePage(page); let release;
    try {
        await page.getByRole("radio", { name: "On for me", exact: true }).check();
        await expect(saved(page)).toHaveText("Off for you");
        await expect(preview(page)).toContainText("On for you");
        expect(fixture.state.calls).toHaveLength(0);
        fixture.state.holdMutation = new Promise(resolve => { release = resolve; });
        await save(page).click();
        await expect.poll(() => fixture.state.calls.length).toBe(1);
        await expect(saved(page)).toHaveText("Off for you");
        await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
        release(); fixture.state.holdMutation = null;
        await expect(saved(page)).toHaveText("On for you");
        await expect(preview(page)).toHaveCount(0);
        expect(fixture.state.calls[0]).toMatchObject({ path: `/api/v1/management/users/me/features/${KEY}`, input: { enabled: true, expectedRevision: "1" } });
        await scopeTab(page, "Cluster").click();
        await clusterChoice(page, "On").check();
        await personalChoice(page, "Not allowed").check();
        await expect(saved(page)).toHaveText("Off by default");
        await expect(preview(page)).toContainText("On for everyone");
        expect(fixture.state.calls).toHaveLength(1);
        await save(page).click();
        await expect(saved(page)).toHaveText("On for everyone");
        expect(fixture.state.calls[1].input).toMatchObject({ enabled: true, allowUserOverride: false, expectedRevision: "2" });
    } finally { release?.(); await fixture.stop(); }
});

test("failed saves retain drafts; conflicts require reviewing the latest revision before retry", async ({ page }) => {
    const fixture = await featurePage(page);
    try {
        await page.getByRole("radio", { name: "On for me", exact: true }).check();
        fixture.state.nextError = { status: 503, message: "Settings service temporarily unavailable" };
        await save(page).click();
        await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
        await expect(saved(page)).toHaveText("Off for you");
        await expect(preview(page)).toContainText("On for you");
        await expect(page.getByRole("radio", { name: "On for me", exact: true })).toBeChecked();
        await expect(save(page)).toBeEnabled();
        fixture.state.cluster = { enabled: true, allowUserOverride: false }; fixture.state.revision++;
        await save(page).click();
        await expect(page.getByRole("button", { name: "Review latest settings", exact: true })).toBeVisible();
        await expect(saved(page)).toHaveText("On for you");
        await expect(page.getByRole("radio", { name: "On for me", exact: true })).toBeChecked();
        await expect(page.getByRole("button", { name: "Save future preference", exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "Review latest settings", exact: true }).click();
        await page.getByRole("button", { name: "Save future preference", exact: true }).click();
        await expect(preview(page)).toHaveCount(0);
        expect(fixture.state.preferences.me).toEqual({ enabled: true });
        expect(fixture.state.calls.at(-1).input.expectedRevision).toBe("2");
    } finally { await fixture.stop(); }
});

test("future preferences stay inactive while locked, activate on unlock, and survive relocking", async ({ page }) => {
    const fixture = await featurePage(page, { admin: false, cluster: { enabled: false, allowUserOverride: false } });
    try {
        await expect(scopeTab(page, "Cluster")).toHaveCount(0);
        await expect(scopeTab(page, "User")).toHaveCount(0);
        await page.getByRole("radio", { name: "On for me", exact: true }).check();
        await expect(saved(page)).toHaveText("Off for you");
        await expect(preview(page)).toContainText(/future preference.*On/i);
        await expect(preview(page)).toContainText("Off still applies while the cluster requires it.");
        expect(fixture.state.calls).toHaveLength(0);
        await page.getByRole("button", { name: "Save future preference", exact: true }).click();
        await expect(preview(page)).toHaveCount(0);
        await expect(saved(page)).toHaveText("Off for you");
        fixture.state.cluster.allowUserOverride = true; fixture.state.revision++;
        await refresh(page).click();
        await expect(saved(page)).toHaveText("On for you");
        fixture.state.cluster.allowUserOverride = false; fixture.state.revision++;
        await refresh(page).click();
        await expect(saved(page)).toHaveText("Off for you");
        await expect(page.getByRole("radio", { name: "On for me", exact: true })).toBeChecked();
        expect(fixture.state.preferences.me).toEqual({ enabled: true });
        expect(fixture.state.calls).toHaveLength(1);
    } finally { await fixture.stop(); }
});

test("drafts survive polling and refresh, are isolated across scopes/users, and discard never writes", async ({ page }) => {
    const fixture = await featurePage(page);
    try {
        await page.clock.install();
        await page.getByRole("radio", { name: "On for me", exact: true }).check();
        await refresh(page).click();
        await page.clock.fastForward(24_000);
        await expect(page.getByRole("radio", { name: "On for me", exact: true })).toBeChecked();
        await expect(preview(page)).toContainText("On for you");
        await scopeTab(page, "Cluster").click();
        await clusterChoice(page, "On").check();
        await selectUser(page, 901);
        await page.getByRole("radio", { name: "On for this user", exact: true }).check();
        await expect(preview(page)).toContainText("On for Test Target");
        await page.getByRole("combobox", { name: "Feature settings user" }).selectOption("902");
        await expect(page.getByRole("radio", { name: "Use cluster setting (currently Off)", exact: true })).toBeChecked();
        await expect(preview(page)).toHaveCount(0);
        await page.getByRole("radio", { name: "Off for this user", exact: true }).check();
        await page.getByRole("combobox", { name: "Feature settings user" }).selectOption("901");
        await expect(page.getByRole("radio", { name: "On for this user", exact: true })).toBeChecked();
        await expect(preview(page)).toContainText("On for Test Target");
        await discard(page).click();
        await expect(preview(page)).toHaveCount(0);
        await page.getByRole("combobox", { name: "Feature settings user" }).selectOption("902");
        await expect(page.getByRole("radio", { name: "Off for this user", exact: true })).toBeChecked();
        await scopeTab(page, "Cluster").click();
        await expect(clusterChoice(page, "On")).toBeChecked();
        await scopeTab(page, "My").click();
        await expect(page.getByRole("radio", { name: "On for me", exact: true })).toBeChecked();
        await discard(page).click();
        await expect(page.getByRole("radio", { name: "Use cluster setting (currently Off)", exact: true })).toBeChecked();
        expect(fixture.state.calls).toHaveLength(0);
    } finally { await fixture.stop(); }
});

test("clearing a personal choice follows later cluster changes rather than saving an explicit value", async ({ page }) => {
    const fixture = await featurePage(page, { user: { enabled: true } });
    try {
        await page.getByRole("radio", { name: "Use cluster setting (currently Off)", exact: true }).check();
        expect(fixture.state.calls).toHaveLength(0);
        await expect(saved(page)).toHaveText("On for you");
        await save(page).click();
        await expect(saved(page)).toHaveText("Off for you");
        expect(fixture.state.calls[0]).toMatchObject({ method: "DELETE", input: { expectedRevision: "1" } });
        expect(fixture.state.preferences.me).toBeNull();
        fixture.state.cluster.enabled = true; fixture.state.revision++;
        await refresh(page).click();
        await expect(saved(page)).toHaveText("On for you");
        await expect(page.getByRole("radio", { name: "Use cluster setting (currently On)", exact: true })).toBeChecked();
    } finally { await fixture.stop(); }
});

test("filtered and empty directory searches retain the active user's identity, draft, and save target", async ({ page }) => {
    const fixture = await featurePage(page);
    try {
        await selectUser(page, 901);
        await page.getByRole("radio", { name: "On for this user", exact: true }).check();
        const picker = page.getByRole("combobox", { name: "Feature settings user" });
        const query = page.getByRole("searchbox", { name: "Find feature settings user" });
        const search = page.getByRole("button", { name: "Search", exact: true });
        await query.fill("Other Target"); await search.click();
        await expect(picker).toHaveValue("901");
        await expect(picker.locator('option[value="901"]')).toContainText("current selection");
        await expect(picker.locator('option[value="902"]')).toHaveCount(1);
        await expect(page.locator(".ps-feature-user-identity")).toContainText("target@test");
        await expect(saved(page)).toHaveText("Off for Test Target");
        await expect(preview(page)).toContainText("On for Test Target");
        await query.fill("does-not-exist"); await search.click();
        await expect(picker.locator("option")).toHaveCount(2); // Placeholder plus retained selection, not search hits.
        await expect(picker).toHaveValue("901");
        await expect(page.locator(".ps-feature-user-identity")).toContainText("target@test");
        await expect(page.getByRole("radio", { name: "On for this user", exact: true })).toBeChecked();
        await query.fill(""); await search.click();
        await expect(picker.locator('option[value="901"]')).not.toContainText("current selection");
        expect(fixture.state.calls).toHaveLength(0);
        await query.fill("Other Target"); await search.click();
        await expect(picker.locator('option[value="901"]')).toContainText("current selection");
        await save(page).click();
        await expect(saved(page)).toHaveText("On for Test Target");
        expect(fixture.state.calls[0].path).toBe(`/api/v1/management/users/901/features/${KEY}`);
        expect(fixture.state.preferences[901]).toEqual({ enabled: true });
        expect(fixture.state.preferences[902]).toBeNull();
        await picker.selectOption("902");
        await expect(saved(page)).toHaveText("Off for Other Target");
        await expect(preview(page)).toHaveCount(0);
        await expect(page.getByRole("radio", { name: "Use cluster setting (currently Off)", exact: true })).toBeChecked();
    } finally { await fixture.stop(); }
});

for (const equalDefaults of [false, true]) test(`default preview stages DELETE for an explicit policy ${equalDefaults ? "equal to" : "different from"} defaults`, async ({ page }) => {
    const fixture = await featurePage(page, { cluster: { enabled: !equalDefaults, allowUserOverride: !equalDefaults } });
    try {
        await scopeTab(page, "Cluster").click();
        await page.getByText("Technical details", { exact: true }).click();
        await page.getByRole("button", { name: "Preview default policy", exact: true }).click();
        await expect(preview(page)).toContainText("Off for everyone");
        await expect(save(page)).toBeEnabled();
        expect(fixture.state.calls).toHaveLength(0);
        await discard(page).click();
        await expect(preview(page)).toHaveCount(0);
        expect(fixture.state.calls).toHaveLength(0);
        await page.getByRole("button", { name: "Preview default policy", exact: true }).click();
        await save(page).click();
        await expect(preview(page)).toHaveCount(0);
        expect(fixture.state.cluster).toBeNull();
        expect(fixture.state.calls[0]).toMatchObject({ method: "DELETE", input: { expectedRevision: "1" } });
        // A real reset follows subsequent code defaults. PUT of equal values does not.
        fixture.state.defaults = { enabled: true, allowUserOverride: true }; fixture.state.revision++;
        await refresh(page).click();
        await expect(saved(page)).toHaveText("On by default");
    } finally { await fixture.stop(); }
});

test("settings delivery progresses independently of the saved On value", async ({ page }) => {
    const fixture = await featurePage(page);
    try {
        await page.clock.install();
        await page.getByRole("radio", { name: "On for me", exact: true }).check();
        await save(page).click();
        await expect(saved(page)).toHaveText("On for you");
        await expect(page.locator(".ps-feature-delivery")).toContainText("0 of 1");
        fixture.state.appliedRevision = "3"; // Newer than the saved revision is current.
        await page.clock.fastForward(24_000);
        await expect(page.locator(".ps-feature-delivery")).toContainText("1 of 1");
        await expect(saved(page)).toHaveText("On for you");
    } finally { await fixture.stop(); }
});

for (const telemetry of ["missing", "malformed", "stale"]) test(`${telemetry} telemetry is unknown rather than zero updated or Off`, async ({ page }) => {
    const worker = { workerNodeId: "restricted-worker", phase: "ready", updatedAt: new Date(Date.now() - (telemetry === "stale" ? 180_000 : 0)).toISOString(),
        state: telemetry === "missing" ? {} : { "feature-flags": { initialized: true, protocolVersion: 1, supportedKeys: [KEY],
            appliedRevisions: { [KEY]: telemetry === "malformed" ? "not-a-revision" : "1" }, nativeCapability: "sync" } } };
    const fixture = await featurePage(page, { user: { enabled: true }, workers: [worker] });
    try {
        await expect(saved(page)).toHaveText("On for you");
        await expect(page.locator(".ps-feature-delivery")).toContainText(/unavailable|unknown|no recent/i);
        await expect(page.locator(".ps-feature-delivery")).not.toContainText(/0 (of|\/) 1/);
        await expect(page.locator(".ps-feature-flags-panel")).not.toContainText("0/1 allow native execution");
    } finally { await fixture.stop(); }
});

test("partial telemetry identifies unknown workers and excludes draining workers from delivery", async ({ page }) => {
    const now = new Date().toISOString();
    const telemetry = { initialized: true, protocolVersion: 1, supportedKeys: [KEY], appliedRevisions: { [KEY]: "2" }, nativeCapability: "sync" };
    const fixture = await featurePage(page, { user: { enabled: true }, workers: [
        { workerNodeId: "current", phase: "ready", updatedAt: now, state: { "feature-flags": telemetry } },
        { workerNodeId: "redacted", phase: "ready", updatedAt: now, state: {} },
        { workerNodeId: "draining", phase: "draining", updatedAt: now, state: { "feature-flags": telemetry } },
    ] });
    try {
        await expect(page.locator(".ps-feature-delivery")).toContainText("1 of 2 reporting workers updated");
        await expect(page.locator(".ps-feature-delivery")).toContainText("Status unavailable for 1");
        await page.getByText("Technical details", { exact: true }).click();
        await expect(page.locator(".ps-feature-details")).toContainText("1 draining workers");
        await expect(saved(page)).toHaveText("On for you");
    } finally { await fixture.stop(); }
});

test("known native unavailability is visible beside saved On rather than hidden in diagnostics", async ({ page }) => {
    const fixture = await featurePage(page, { user: { enabled: true }, workers: [{ workerNodeId: "no-native", phase: "ready", updatedAt: new Date().toISOString(),
        state: { "feature-flags": { initialized: true, protocolVersion: 1, supportedKeys: [KEY], appliedRevisions: { [KEY]: "1" }, nativeCapability: "off" } } }] });
    try {
        await expect(saved(page)).toHaveText("On for you");
        await expect(page.locator(".ps-feature-delivery")).toContainText("1 of 1 reporting workers updated");
        await expect(page.locator(".ps-feature-blocker")).toBeVisible();
        await expect(page.locator(".ps-feature-blocker")).toContainText("Native tasks cannot run on those workers");
        expect(await page.locator(".ps-feature-details").getAttribute("open")).toBeNull();
    } finally { await fixture.stop(); }
});

for (const themeId of ["workspace-dark", "github-light"]) test(`keyboard radio controls and user identity fit narrow screens (${themeId})`, async ({ page }) => {
    const fixture = await featurePage(page, { themeId });
    try {
        await page.getByRole("radio", { name: "Use cluster setting (currently Off)", exact: true }).focus();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("radio", { name: "On for me", exact: true })).toBeChecked();
        expect(fixture.state.calls).toHaveLength(0);
        await discard(page).click();
        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            const panel = page.locator(".ps-feature-flags-panel");
            await expect(panel).toBeVisible();
            expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            await scopeTab(page, "Cluster").click();
            expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            await selectUser(page, 901);
            await expect(page.locator(".ps-feature-user")).toContainText("target@test");
            expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            await scopeTab(page, "My").click();
        }
    } finally { await fixture.stop(); }
});
