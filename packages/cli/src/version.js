import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cliPackageJson = require("../package.json");

export const PILOTSWARM_CLI_VERSION = String(cliPackageJson?.version || "0.0.0");
export const PILOTSWARM_CLI_VERSION_LABEL = `v${PILOTSWARM_CLI_VERSION}`;
