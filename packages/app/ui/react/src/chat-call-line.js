import React from "react";

export function ChatCallLine({ line }) {
    const [open, setOpen] = React.useState(false);
    return React.createElement("details", {
        className: "ps-system-notice ps-chat-call",
        "data-call-id": line.callKey,
        onToggle: event => setOpen(event.currentTarget.open),
    },
    React.createElement("summary", { className: "ps-system-notice-summary ps-chat-call-summary" },
        React.createElement("span", { className: "ps-chat-call-tag" }, line.category || "Tool"),
        React.createElement("span", { className: "ps-system-notice-summary-text" }, line.text),
        line.status ? React.createElement("span", { className: `ps-chat-call-status${line.status === "Failed" ? " is-failed" : ""}` }, line.status) : null),
    open ? React.createElement("div", { className: "ps-system-notice-body" },
        line.time ? React.createElement("div", { className: "ps-chat-call-time" }, line.time) : null,
        React.createElement("pre", { className: "ps-chat-call-payload" }, line.body)) : null);
}

