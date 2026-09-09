import React from "react";
import { NATIVE_TASK_LABELS } from "../../core/src/native-tasks.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MARKS = { starting: "◷", running: "◷", waiting: "Ⅱ", completed: "✓", failed: "!", cancelled: "■", interrupted: "↯" };
function duration(task, now) {
    const ms = task.durationMs ?? (task.startedAt ? (task.completedAt || now) - task.startedAt : null);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const seconds = Math.floor(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const NativeTaskCard = React.memo(function NativeTaskCard({ group, colors }) {
    const [showAll, setShowAll] = React.useState(false);
    const [now, setNow] = React.useState(Date.now);
    const active = group.tasks.some(task => !TERMINAL.has(task.status));
    React.useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    const counts = group.tasks.reduce((acc, task) => {
        const label = NATIVE_TASK_LABELS[task.status] || "Unknown";
        acc[label] = (acc[label] || 0) + 1;
        return acc;
    }, {});
    const countLabel = Object.entries(counts).map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ");
    const tasks = showAll ? group.tasks : group.tasks.slice(0, 3);
    return React.createElement("section", { className: "ps-native-tasks", "aria-label": "Native tasks", "data-task-group": group.id },
        React.createElement("header", { className: "ps-native-tasks-header" },
            React.createElement("span", { className: "ps-native-tasks-title" },
                React.createElement("span", { className: "ps-native-task-branch", "aria-hidden": true }, "⑂"), "Native tasks"),
            React.createElement("span", { className: "ps-native-tasks-count", "aria-live": "polite" }, countLabel)),
        tasks.map(task => {
            const color = colors[task.status] || colors.running;
            const preview = task.error || task.result || task.preview || (task.status === "completed" ? "Task completed." : "");
            const time = duration(task, now);
            return React.createElement("details", { key: task.id, className: "ps-native-task", "data-task-id": task.id, "data-status": task.status,
                style: { "--ps-native-task-accent": color } },
                React.createElement("summary", null,
                    React.createElement("span", { className: "ps-native-task-mark", "aria-hidden": true }, MARKS[task.status] || "?"),
                    React.createElement("span", { className: "ps-native-task-main" },
                        React.createElement("span", { className: "ps-native-task-title" }, task.title),
                        preview ? React.createElement("span", { className: "ps-native-task-preview" }, preview.replace(/\s+/g, " ").slice(0, 240)) : null),
                    React.createElement("span", { className: "ps-native-task-meta" },
                        React.createElement("span", { className: "ps-native-task-status" }, task.telemetryStale ? "Reconnecting" : NATIVE_TASK_LABELS[task.status] || task.status),
                        React.createElement("span", null, [time, `${task.toolCalls || 0} calls`].filter(Boolean).join(" · "))),
                    React.createElement("span", { className: "ps-native-task-chevron", "aria-hidden": true }, "›")),
                React.createElement("div", { className: "ps-native-task-detail" },
                    React.createElement("div", { className: "ps-native-task-scope" }, [task.profile, task.model, task.reasoningEffort, "Same worker"].filter(Boolean).join(" · ")),
                    task.result && !task.error ? React.createElement("div", { className: "ps-native-task-scope" }, "Result excerpt") : null,
                    React.createElement("p", { className: "ps-native-task-result" }, task.error || task.result || task.preview
                        || (task.status === "completed" ? "Task completed. A result excerpt is not available in this recording." : "No result available yet.")),
                    task.recentActivity?.length ? React.createElement("ul", { className: "ps-native-task-activity" },
                        task.recentActivity.map((activity, i) => React.createElement("li", { key: i }, activity.message))) : null));
        }),
        group.tasks.length > 3 ? React.createElement("button", { type: "button", className: "ps-native-tasks-more", "aria-expanded": showAll,
            onClick: () => setShowAll(value => !value) }, showAll ? "Show fewer tasks" : `Show ${group.tasks.length - 3} more tasks`) : null);
});
