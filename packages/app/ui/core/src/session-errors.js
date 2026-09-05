export function shouldKeepSessionWarning(previousSession, nextSession) {
    if (!String(previousSession?.error || "").trim()) return false;
    if (nextSession?.error !== undefined) return false;
    if (["Completed", "Failed", "Terminated"].includes(String(nextSession?.orchestrationStatus || ""))) return false;
    if (["completed", "failed", "cancelled", "terminated"].includes(previousSession?.status)) return false;
    const nextStatus = String(nextSession?.status || "");
    if (["running", "error"].includes(nextStatus)) return true;
    if (!["idle", "waiting", "unknown", "pending", ""].includes(nextStatus)) return false;
    // Catalog/detail snapshots can lag a retry. A genuinely newer idle detail
    // (or a new durable wait) clears it; a same-age snapshot is not evidence
    // of recovery. Do not infer retry semantics from provider error wording.
    const previousVersion = Number(previousSession?.statusVersion);
    const nextVersion = Number(nextSession?.statusVersion);
    if (previousVersion > 0 && nextVersion > 0) return nextVersion <= previousVersion;
    const time = (value) => typeof value === "number" ? value : Date.parse(value || "");
    const previousAt = time(previousSession?.updatedAt);
    const nextAt = time(nextSession?.updatedAt);
    return previousAt > 0 && nextAt > 0 && nextAt <= previousAt;
}
