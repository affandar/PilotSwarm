import portalPackageJson from "../package.json";

export const PILOTSWARM_PORTAL_VERSION = String(portalPackageJson?.version || "0.0.0");
export const PILOTSWARM_PORTAL_VERSION_LABEL = `v${PILOTSWARM_PORTAL_VERSION}`;
