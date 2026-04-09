export function canonicalSystemTitle(session, brandingTitle = "PilotSwarm") {
    const brandedRootTitle = brandingTitle || "PilotSwarm";
    const agentId = String(session?.agentId || "");
    if (agentId === "pilotswarm") return brandedRootTitle;
    if (agentId === "sweeper") return "Sweeper Agent";
    if (agentId === "resourcemgr") return "Resource Manager Agent";
    if (agentId === "facts-manager") return "Facts Manager";

    const rawTitle = String(session?.title || "").trim();
    if (/^pilotswarm(?: agent)?$/i.test(rawTitle)) return brandedRootTitle;
    if (/^sweeper agent$/i.test(rawTitle) || /^sweeper$/i.test(rawTitle)) return "Sweeper Agent";
    if (/^resource manager agent$/i.test(rawTitle) || /^resourcemgr$/i.test(rawTitle)) return "Resource Manager Agent";
    if (/^facts manager$/i.test(rawTitle) || /^facts-manager$/i.test(rawTitle)) return "Facts Manager";
    return rawTitle || "System Agent";
}

export function systemSessionSortOrder(session) {
    const title = canonicalSystemTitle(session, "PilotSwarm");
    if (title === "PilotSwarm") return 0;
    if (title === "Sweeper Agent") return 1;
    if (title === "Resource Manager Agent") return 2;
    if (title === "Facts Manager") return 3;
    return 10;
}
