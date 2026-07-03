export function isRecoverableTransportErrorText(text) {
    const value = String(text || "");
    return /\bConnection is closed\b/i.test(value)
        || /\bLive Copilot connection lost\b/i.test(value);
}

export function shouldKeepRecoverableTransportWarning(previousSession, nextSession) {
    if (!isRecoverableTransportErrorText(previousSession?.error)) return false;
    if (nextSession?.error !== undefined) return false;
    const nextStatus = String(nextSession?.status || "");
    if (nextStatus !== "running") return false;
    if (["Completed", "Failed", "Terminated"].includes(String(nextSession?.orchestrationStatus || ""))) return false;
    return true;
}
