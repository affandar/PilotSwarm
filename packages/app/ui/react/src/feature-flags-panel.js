import React from "react";

const h = React.createElement;
const onOff = enabled => enabled ? "On" : "Off";
const validRevision = value => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Missing diagnostics are unknown, including telemetry redacted by older servers. */
export function featureWorkerStatus(flag, workers = [], now = Date.now()) {
    const reports = workers.map(worker => {
        const age = now - new Date(worker.updatedAt).getTime();
        const state = worker.state?.["feature-flags"];
        const recent = Number.isFinite(age) && age >= -5_000 && age < 90_000;
        const eligible = worker.phase === "ready" && recent;
        const validState = isRecord(state) && state.protocolVersion === 1
            && typeof state.initialized === "boolean" && Array.isArray(state.supportedKeys)
            && state.supportedKeys.every(key => typeof key === "string") && isRecord(state.appliedRevisions);
        let delivery = "unknown";
        if (eligible && validState && validRevision(flag.revision)) {
            if (!state.supportedKeys.includes(flag.featureKey)) delivery = "unsupported";
            else if (!state.initialized) delivery = "loading";
            else if (validRevision(state.appliedRevisions[flag.featureKey])) {
                delivery = BigInt(state.appliedRevisions[flag.featureKey]) >= BigInt(flag.revision) ? "updated" : "pending";
            }
        }
        const capability = eligible && validState && ["sync", "off"].includes(state.nativeCapability)
            ? state.nativeCapability : "unknown";
        return { workerNodeId: worker.workerNodeId, phase: worker.phase, recent, eligible, delivery, capability,
            revision: validState && validRevision(state.appliedRevisions[flag.featureKey]) ? state.appliedRevisions[flag.featureKey] : null,
            refreshError: eligible && validState && (state.hasRefreshError === true || typeof state.lastError === "string" && state.lastError.length > 0) };
    });
    const eligible = reports.filter(report => report.eligible);
    return { reports, eligible: eligible.length,
        updated: eligible.filter(report => report.delivery === "updated").length,
        unknown: eligible.filter(report => report.delivery === "unknown").length,
        unsupported: eligible.filter(report => report.delivery === "unsupported").length,
        capable: eligible.filter(report => report.capability === "sync").length,
        incapable: eligible.filter(report => report.capability === "off").length,
        capabilityUnknown: eligible.filter(report => report.capability === "unknown").length,
        refreshErrors: eligible.filter(report => report.refreshError).length,
        stale: reports.filter(report => !report.recent && report.phase !== "draining").length,
        draining: reports.filter(report => report.phase === "draining").length,
        other: reports.filter(report => report.recent && !report.eligible && report.phase !== "draining").length };
}

function deliveryText(status, workersError) {
    if (workersError || !status.eligible || status.unknown === status.eligible) return "Settings delivery: status unavailable";
    return `Settings delivery: ${status.updated} of ${status.eligible} reporting workers updated.${status.unknown ? ` Status unavailable for ${status.unknown}.` : ""}${status.unsupported ? ` ${status.unsupported} do not support this feature.` : ""}${status.refreshErrors ? ` ${status.refreshErrors} reported a refresh problem.` : ""}`;
}

function clusterSummary(enabled, allowPersonal) {
    return `${onOff(enabled)} ${allowPersonal ? "by default. Users can choose On or Off." : "for everyone. Personal settings do not apply."}`;
}

function RadioChoices({ legend, name, value, options, disabled, onChange }) {
    return h("fieldset", { className: "ps-feature-choice-group", disabled },
        h("legend", null, legend),
        h("div", { className: "ps-feature-choices" }, options.map(option => h("label", {
            className: `ps-feature-choice${value === option.value ? " is-selected" : ""}`, key: option.value,
        }, h("input", { type: "radio", name, value: option.value, checked: value === option.value,
            onChange: () => onChange(option.value) }), h("span", null, option.label)))));
}

function FeatureFlagRow({ flag, mode, busy, saving, controller, workers, workersError, isAdmin, userName }) {
    const id = React.useId();
    const draft = controller.getFeatureDraft?.(flag.featureKey);
    const dirty = draft !== undefined;
    const conflict = dirty && (draft.needsReview || draft.expectedRevision !== flag.revision);
    const conflictNeedsRefresh = conflict && draft.needsReview && draft.expectedRevision === flag.revision;
    const storedEnabled = flag.cluster?.enabled ?? flag.defaultEnabled;
    const storedOverride = flag.cluster?.allowUserOverride ?? flag.defaultAllowUserOverride;
    const locked = mode !== "cluster" && !storedOverride;
    const savedChoice = flag.user ? String(flag.user.enabled) : "inherit";
    const choice = dirty ? draft.values === null ? "inherit" : String(draft.values.enabled) : savedChoice;
    const clusterDraft = dirty ? draft.values ?? { enabled: flag.defaultEnabled, allowUserOverride: flag.defaultAllowUserOverride }
        : { enabled: storedEnabled, allowUserOverride: storedOverride };
    const target = mode === "mine" ? "you" : userName;
    const futureTarget = mode === "mine" ? "Your" : `${userName}’s`;
    const savedValue = mode === "cluster" ? `${onOff(storedEnabled)} ${storedOverride ? "by default" : "for everyone"}`
        : `${onOff(flag.effective)} for ${target}`;
    const reason = mode === "cluster" ? storedOverride ? "Users can choose On or Off." : "Personal settings do not apply."
        : locked ? "Required by the cluster." : flag.user ? mode === "mine" ? "Using your choice." : "Using the saved personal choice." : "Following the cluster setting.";
    const status = featureWorkerStatus(flag, workers);
    const isNative = flag.featureKey === "copilot.native_tasks";
    const savedOn = mode === "cluster" ? storedEnabled : flag.effective;
    const knownBlocked = isAdmin && isNative && savedOn && !workersError && status.eligible > 0 && status.incapable === status.eligible;
    const editDisabled = busy || !flag.supported;
    let preview = null;
    if (dirty) {
        if (mode === "cluster") preview = `${draft.values === null ? "Restore the default policy. " : ""}${clusterSummary(clusterDraft.enabled, clusterDraft.allowUserOverride)}${!storedOverride && clusterDraft.allowUserOverride ? " Previously saved personal choices will apply again." : ""}`;
        else if (locked) preview = `${futureTarget} future preference will ${choice === "inherit" ? "follow the cluster setting" : `be ${onOff(choice === "true")}`}. ${onOff(storedEnabled)} still applies while the cluster requires it.`;
        else preview = `${onOff(choice === "inherit" ? storedEnabled : choice === "true")} for ${target}. ${choice === "inherit" ? "Following the cluster setting." : "Using the personal choice."}`;
    }
    return h("section", { className: "ps-feature-flag", "data-feature-key": flag.featureKey, "aria-labelledby": `${id}-title` },
        h("div", { className: "ps-feature-flag-heading" }, h("h3", { id: `${id}-title` }, flag.displayName),
            dirty ? h("span", { className: "ps-feature-unsaved" }, "Unsaved changes") : null),
        h("p", { className: "ps-feature-description" }, isNative ? "Lets Copilot delegate short tasks in the same session workspace. On permits use; Copilot decides when to use native tasks." : flag.description),
        h("div", { className: "ps-feature-saved" },
            h("span", { className: "ps-feature-label" }, "Saved setting"),
            h("strong", { className: `ps-feature-value${(mode === "cluster" ? storedEnabled : flag.effective) ? " is-on" : ""}` }, savedValue),
            h("p", { className: "ps-feature-explanation" }, reason),
            mode !== "cluster" ? h("p", { className: "ps-feature-context" }, `Cluster setting: ${onOff(storedEnabled)}. Personal settings ${storedOverride ? "allowed" : "not allowed"}.`) : null,
            locked ? h("p", { className: "ps-feature-retained" }, `Saved future preference: ${savedChoice === "inherit" ? "Use cluster setting" : onOff(flag.user.enabled)}. This will apply if personal settings are allowed again.`) : null),
        !flag.supported ? h("p", { role: "status" }, "This server does not support changing this feature.") : null,
        flag.reason === "requires_native_tasks" ? h("p", { className: "ps-feature-blocker", role: "status" },
            "Base Agent V2 is currently Off because it requires Native Copilot tasks. The Base V2 preference is saved and will apply when native tasks are enabled for the same scope.") : null,
        knownBlocked ? h("p", { className: "ps-feature-blocker", role: "status" }, `The saved setting is On, but none of the ${status.eligible} reporting workers is configured for native tasks. Native tasks cannot run on those workers.`) : null,
        h("div", { className: "ps-feature-editor" }, mode === "cluster" ? [
            h(RadioChoices, { key: "enabled", legend: "Cluster setting", name: `${id}-cluster`, value: String(clusterDraft.enabled), disabled: editDisabled,
                options: [{ value: "false", label: "Off" }, { value: "true", label: "On" }],
                onChange: value => controller.setFeatureDraft(flag.featureKey, { ...clusterDraft, enabled: value === "true" }) }),
            h(RadioChoices, { key: "override", legend: "Personal settings", name: `${id}-override`, value: String(clusterDraft.allowUserOverride), disabled: editDisabled,
                options: [{ value: "true", label: "Allowed" }, { value: "false", label: "Not allowed" }],
                onChange: value => controller.setFeatureDraft(flag.featureKey, { ...clusterDraft, allowUserOverride: value === "true" }) }),
        ] : h(RadioChoices, { legend: locked ? "Preference for when personal settings are allowed" : mode === "mine" ? "Your choice" : `${userName}’s choice`,
            name: `${id}-user`, value: choice, disabled: editDisabled,
            options: [{ value: "inherit", label: `Use cluster setting (currently ${onOff(storedEnabled)})` },
                { value: "true", label: mode === "mine" ? "On for me" : "On for this user" },
                { value: "false", label: mode === "mine" ? "Off for me" : "Off for this user" }],
            onChange: value => controller.setFeatureDraft(flag.featureKey, value === "inherit" ? null : { enabled: value === "true" }) })),
        dirty ? h("div", { className: "ps-feature-preview", role: "status" }, h("strong", null, "After saving: "), preview) : null,
        conflict ? h("p", { className: "ps-feature-conflict", role: "status" }, conflictNeedsRefresh
            ? "Settings changed since this edit began. Refresh settings to load the latest saved value."
            : "Settings changed since this edit began. Review the saved setting and your proposed change before saving.") : null,
        h("div", { className: "ps-feature-actions" },
            h("button", { type: "button", className: "ps-mini-button ps-feature-save", disabled: editDisabled || !dirty || conflict,
                onClick: () => controller.saveFeatureDraft(flag.featureKey) }, saving && dirty ? "Saving…" : locked ? "Save future preference" : "Save changes"),
            h("button", { type: "button", className: "ps-mini-button", disabled: busy || !dirty,
                onClick: () => controller.discardFeatureDraft(flag.featureKey) }, "Discard changes"),
            conflict ? h("button", { type: "button", className: "ps-mini-button", disabled: busy || conflictNeedsRefresh,
                onClick: () => controller.reviewFeatureDraft(flag.featureKey) }, "Review latest settings") : null),
        isAdmin ? h("p", { className: "ps-feature-delivery", role: "status" }, deliveryText(status, workersError)) : null,
        h("details", { className: "ps-feature-details" }, h("summary", null, "Technical details"),
            h("p", null, h("code", null, flag.featureKey), ` · Saved revision ${flag.revision}`),
            h("p", null, "Workers normally check for settings changes within 20 seconds. Settings delivery does not confirm that each session has refreshed its tools."),
            isNative ? h("p", null, "After a worker receives On, native tasks become available on the next turn. After it receives Off, new native tasks are blocked. Tasks already running can finish.") : null,
            isAdmin && isNative ? h("p", null, workersError || !status.eligible || status.capabilityUnknown === status.eligible
                ? "Native task support: status unavailable."
                : `Native task support: ${status.capable} of ${status.eligible} reporting workers configured; ${status.incapable} configured Off; ${status.capabilityUnknown} unknown.`) : null,
            isAdmin && (status.stale || status.draining || status.other) ? h("p", null, `Excluded from current delivery counts: ${status.stale} stale or undated reports; ${status.draining} draining workers; ${status.other} other worker reports.`) : null,
            isAdmin ? h("ul", { className: "ps-feature-worker-list" }, status.reports.map(report => h("li", { key: report.workerNodeId },
                `${report.workerNodeId}: ${report.eligible ? ({ updated: "settings received", pending: "waiting for latest settings", loading: "loading settings", unsupported: "feature unsupported", unknown: "status unavailable" })[report.delivery] : report.phase === "draining" ? "draining; excluded" : !report.recent ? "stale or undated report; status unavailable" : "not reporting ready; excluded"}${report.eligible && report.revision ? `; revision ${report.revision}` : ""}${report.eligible && isNative ? `; native task configuration ${report.capability === "sync" ? "On" : report.capability === "off" ? "Off" : "unknown"}` : ""}${report.refreshError ? "; settings refresh problem" : ""}`))) : null,
            mode === "cluster" ? h("div", { className: "ps-feature-defaults" },
                h("p", null, `Default policy: ${clusterSummary(flag.defaultEnabled, flag.defaultAllowUserOverride)}`),
                h("button", { type: "button", className: "ps-mini-button", disabled: editDisabled || !flag.cluster,
                    onClick: () => controller.setFeatureDraft(flag.featureKey, null) }, "Preview default policy"),
                h("p", { className: "ps-feature-explanation" }, "Preview stages removal of the cluster override. Save changes to use the code-defined defaults; personal choices are kept.")) : null));
}

export function FeatureFlagsPanel({ controller, features = {}, isAdmin, workers = [], workersError = null }) {
    const mode = features.mode || "mine";
    const [userQuery, setUserQuery] = React.useState(features.userQuery || "");
    const user = features.users?.find(entry => entry.userId === features.userId);
    const userName = user?.displayName || user?.email || user?.subject || (features.userId ? `user ${features.userId}` : "this user");
    const busy = features.saving || features.loading;
    return h("section", { className: "ps-feature-flags-panel", "aria-label": "Feature flags" },
        h("header", { className: "ps-feature-flag-heading" }, h("h2", null, "Feature flags"),
            h("button", { type: "button", className: "ps-mini-button", disabled: busy, onClick: () => controller.refreshFeatureFlags() }, "Refresh settings")),
        h("div", { role: "tablist", "aria-label": "Feature settings scope", className: "ps-feature-tabs" },
            [{ mode: "mine", label: "My settings" }, ...(isAdmin ? [{ mode: "cluster", label: "Cluster settings" }, { mode: "users", label: "User settings" }] : [])].map(tab => {
                const count = controller.getFeatureDraftCount?.(tab.mode) || 0;
                return h("button", { type: "button", key: tab.mode, role: "tab", "aria-selected": mode === tab.mode, disabled: features.saving,
                    className: "ps-mini-button", onClick: () => controller.selectFeatureScope(tab.mode) }, tab.label,
                count ? h("span", { className: "ps-feature-unsaved" }, `${count} unsaved`) : null);
            })),
        mode === "users" && isAdmin ? h("div", { className: "ps-feature-user" },
            h("form", { onSubmit: event => { event.preventDefault(); void controller.searchFeatureUsers(userQuery); } },
                h("label", null, "Find user ", h("input", { type: "search", value: userQuery,
                    "aria-label": "Find feature settings user", placeholder: "Name, email or identity", onChange: event => setUserQuery(event.target.value) })),
                h("button", { className: "ps-mini-button", disabled: features.usersLoading || features.saving }, "Search")),
            h("label", null, "User ", h("select", { "aria-label": "Feature settings user", value: features.userId ?? "", disabled: features.saving,
                onChange: event => controller.selectFeatureScope("users", event.target.value ? Number(event.target.value) : null) },
            h("option", { value: "" }, "Select a user"),
            (features.users || []).map(entry => h("option", { key: entry.userId, value: entry.userId }, `${entry.displayName || entry.email || entry.subject}${entry.displayName && entry.email ? ` — ${entry.email}` : ""}${features.selectedUserOutsideResults && entry.userId === features.userId ? " (current selection)" : ""}`)))),
            features.selectedUserOutsideResults ? h("p", { className: "ps-feature-explanation" }, "Current selection kept while you search.") : null,
            user ? h("p", { className: "ps-feature-user-identity" }, h("strong", null, userName), user.email ? h("span", null, user.email) : null)
                : features.userId ? h("p", null, `Selected user ID: ${features.userId}`) : null,
            features.users?.length >= 500 ? h("p", null, "Showing the first 500 users. Refine your search to find another user.") : null) : null,
        features.error ? h("p", { role: "alert" }, features.error) : null,
        features.metadataError ? h("p", { role: "status" }, features.metadataError) : null,
        isAdmin && workersError ? h("p", { role: "status" }, "Worker reports could not be refreshed. Settings delivery status is unavailable.") : null,
        features.notice ? h("p", { role: "status" }, features.notice) : null,
        features.loading ? h("p", { role: "status" }, "Loading feature settings…") : null,
        (mode === "mine" || isAdmin ? features.data?.flags || [] : []).map(flag => h(FeatureFlagRow, { key: `${mode}:${features.userId}:${flag.featureKey}`,
            flag, mode, busy, saving: features.saving, controller, workers, workersError, isAdmin, userName })),
        !features.loading && features.data?.flags?.length === 0 ? h("p", null, "No feature definitions are published.") : null);
}
