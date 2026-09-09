import React from "react";

function adoptionText(flag, workers) {
    const live = workers.filter(worker => Date.now() - new Date(worker.updatedAt).getTime() < 90_000);
    if (!live.length) return "No recent worker reports";
    const adopted = live.filter(worker => {
        const state = worker.state?.["feature-flags"];
        const revision = state?.appliedRevisions?.[flag.featureKey];
        return state?.supportedKeys?.includes(flag.featureKey) && /^[1-9]\d*$/.test(String(revision))
            && BigInt(revision) >= BigInt(flag.revision);
    }).length;
    const capable = live.filter(worker => worker.state?.["feature-flags"]?.nativeCapability === "sync").length;
    return `${adopted}/${live.length} workers applied this revision${flag.featureKey === "copilot.native_tasks" ? ` · ${capable}/${live.length} allow native execution` : ""}`;
}

function FeatureFlagRow({ flag, mode, busy, controller, workers, isAdmin }) {
    const [enabled, setEnabled] = React.useState(flag.cluster?.enabled ?? flag.defaultEnabled);
    const [override, setOverride] = React.useState(flag.cluster?.allowUserOverride ?? flag.defaultAllowUserOverride);
    const storedEnabled = flag.cluster?.enabled ?? flag.defaultEnabled;
    const storedOverride = flag.cluster?.allowUserOverride ?? flag.defaultAllowUserOverride;
    const dirty = enabled !== storedEnabled || override !== storedOverride;
    React.useEffect(() => {
        controller.setFeatureDraftDirty?.(flag.featureKey, mode === "cluster" && dirty);
        return () => controller.setFeatureDraftDirty?.(flag.featureKey, false);
    }, [controller, flag.featureKey, mode, dirty]);
    return React.createElement("section", { className: "ps-feature-flag", "data-feature-key": flag.featureKey },
        React.createElement("div", { className: "ps-feature-flag-heading" },
            React.createElement("h3", null, flag.displayName),
            React.createElement("span", { className: `ps-feature-value${flag.effective ? " is-on" : ""}` }, `Effective: ${flag.effective ? "On" : "Off"}`)),
        React.createElement("p", null, flag.description),
        React.createElement("small", null, `${flag.featureKey} · Revision ${flag.revision}`),
        mode !== "cluster" ? React.createElement("p", { className: "ps-feature-explanation" },
            `Cluster: ${storedEnabled ? "On" : "Off"} · User overrides: ${storedOverride ? "Allowed" : "Locked"}`) : null,
        !flag.supported ? React.createElement("p", { role: "status" }, "This server does not support changing this feature.") : null,
        mode === "cluster"
            ? React.createElement("div", { className: "ps-feature-controls" },
                React.createElement("label", null, React.createElement("input", { type: "checkbox", checked: enabled, disabled: busy || !flag.supported,
                    onChange: event => setEnabled(event.target.checked) }), " Cluster default enabled"),
                React.createElement("label", null, React.createElement("input", { type: "checkbox", checked: override, disabled: busy || !flag.supported,
                    onChange: event => setOverride(event.target.checked) }), " Allow user override"),
                React.createElement("button", { className: "ps-mini-button", disabled: busy || !flag.supported || !dirty,
                    onClick: () => controller.saveFeatureFlag(flag.featureKey, { enabled, allowUserOverride: override }) }, "Save cluster policy"),
                React.createElement("button", { className: "ps-mini-button", disabled: busy || !flag.supported || !flag.cluster,
                    onClick: () => controller.saveFeatureFlag(flag.featureKey, null) }, "Reset to code defaults"))
            : React.createElement("div", { className: "ps-feature-controls" },
                React.createElement("label", null, "Preference ", React.createElement("select", {
                    "aria-label": `${flag.displayName} preference`, value: flag.user ? String(flag.user.enabled) : "inherit", disabled: busy || !flag.supported,
                    onChange: event => controller.saveFeatureFlag(flag.featureKey, event.target.value === "inherit" ? null : { enabled: event.target.value === "true" }),
                }, React.createElement("option", { value: "inherit" }, "Inherit"), React.createElement("option", { value: "true" }, "On"), React.createElement("option", { value: "false" }, "Off")))),
        React.createElement("p", { className: "ps-feature-explanation" }, mode === "cluster"
            ? `${storedOverride ? "User preferences may override this default." : "This value is enforced for every user."}${dirty ? " You have unsaved changes." : ""}`
            : flag.userOverrideIgnored ? "Controlled by cluster. Your saved preference is inactive while overrides are disabled."
                : flag.source === "user" ? "Using the saved user preference." : "Inherited from cluster policy."),
        isAdmin ? React.createElement("details", { className: "ps-feature-adoption" },
            React.createElement("summary", null, adoptionText(flag, workers)),
            React.createElement("ul", null, workers.map(worker => {
                const state = worker.state?.["feature-flags"];
                const recent = Date.now() - new Date(worker.updatedAt).getTime() < 90_000;
                return React.createElement("li", { key: worker.workerNodeId }, `${worker.workerNodeId}: ${recent ? "recent report" : "stale report"}; revision ${state?.appliedRevisions?.[flag.featureKey] || "not loaded"}; ${state?.supportedKeys?.includes(flag.featureKey) ? "supported" : "unsupported"}${flag.featureKey === "copilot.native_tasks" ? `; native execution ${state?.nativeCapability || "unavailable"}` : ""}${state?.lastError ? `; refresh error: ${state.lastError}` : ""}`);
            }))) : null);
}

export function FeatureFlagsPanel({ controller, features = {}, isAdmin, workers = [], workersError = null }) {
    const mode = features.mode || "mine";
    const [userQuery, setUserQuery] = React.useState(features.userQuery || "");
    const user = features.users?.find(entry => entry.userId === features.userId);
    const busy = features.saving || features.loading;
    return React.createElement("section", { className: "ps-feature-flags-panel", "aria-label": "Feature flags" },
        React.createElement("header", { className: "ps-feature-flag-heading" },
            React.createElement("h2", null, "Feature flags"),
            React.createElement("button", { className: "ps-mini-button", disabled: busy, onClick: () => controller.refreshFeatureFlags() }, "Refresh flags")),
        React.createElement("div", { role: "tablist", "aria-label": "Feature settings scope", className: "ps-feature-tabs" },
            [{ mode: "mine", label: "My preferences" }, ...(isAdmin ? [{ mode: "cluster", label: "Cluster" }, { mode: "users", label: "Users" }] : [])].map(tab =>
                React.createElement("button", { key: tab.mode, role: "tab", "aria-selected": mode === tab.mode, disabled: features.saving,
                    className: "ps-mini-button", onClick: () => controller.selectFeatureScope(tab.mode) }, tab.label))),
        mode === "users" && isAdmin ? React.createElement("div", { className: "ps-feature-user" },
            React.createElement("form", { onSubmit: event => { event.preventDefault(); void controller.searchFeatureUsers(userQuery); } },
                React.createElement("label", null, "Find user ", React.createElement("input", { type: "search", value: userQuery,
                    "aria-label": "Find feature settings user", placeholder: "Name, email or identity", onChange: event => setUserQuery(event.target.value) })),
                React.createElement("button", { className: "ps-mini-button", disabled: features.usersLoading || features.saving }, "Search")),
            React.createElement("label", null, "User ", React.createElement("select", { "aria-label": "Feature settings user", value: features.userId ?? "", disabled: features.saving,
                onChange: event => controller.selectFeatureScope("users", event.target.value ? Number(event.target.value) : null) },
                React.createElement("option", { value: "" }, "Select a user"),
                (features.users || []).map(entry => React.createElement("option", { key: entry.userId, value: entry.userId }, entry.displayName || entry.email || entry.subject)))),
            user ? React.createElement("p", null, `${user.displayName || user.subject}${user.email ? ` <${user.email}>` : ""}`)
                : features.userId ? React.createElement("p", null, `Selected user ID: ${features.userId}`) : null,
            features.users?.length >= 500 ? React.createElement("p", null, "Showing the first 500 users. Refine your search to find another user.") : null) : null,
        features.error ? React.createElement("p", { role: "alert" }, features.error) : null,
        features.metadataError ? React.createElement("p", { role: "status" }, features.metadataError) : null,
        isAdmin && workersError ? React.createElement("p", { role: "status" }, `Worker reports could not be refreshed: ${workersError}`) : null,
        features.notice ? React.createElement("p", { role: "status" }, features.notice) : null,
        features.loading ? React.createElement("p", { role: "status" }, "Loading feature settings…") : null,
        (mode === "mine" || isAdmin ? features.data?.flags || [] : []).map(flag => React.createElement(FeatureFlagRow, { key: `${mode}:${features.userId}:${flag.featureKey}:${flag.revision}`,
            flag, mode, busy, controller, workers, isAdmin })),
        !features.loading && features.data?.flags?.length === 0 ? React.createElement("p", null, "No feature definitions are published.") : null,
        React.createElement("p", { className: "ps-feature-explanation" }, "Saved policy and worker adoption are separate. Workers normally refresh within 20 seconds. Native tasks enabled during a turn become available on the next turn."));
}
