/**
 * DevOps Command Center — Worker Module for TUI
 *
 * This module is loaded by the TUI via --worker flag.
 * It exports the custom tools so the TUI workers can use them.
 *
 * Usage:
 *   npx pilotswarm --plugin ./plugin --worker ./worker-module.js --env ../../.env
 */

import { createDevopsTools } from "./tools.js";

export default {
    createTools: ({ workerNodeId }) => createDevopsTools({ workerMarker: workerNodeId }),
};
