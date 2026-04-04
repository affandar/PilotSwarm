/**
 * DevOps Command Center — Worker Module for the terminal UI
 *
 * This module is loaded by the TUI via --worker.
 * It exports the custom tools so the embedded workers can use them.
 *
 * Usage:
 *   npx pilotswarm local --env ../../.env --plugin ./plugin --worker ./worker-module.js
 */

import { createDevopsTools } from "./tools.js";

export default {
    createTools: ({ workerNodeId }) => createDevopsTools({ workerMarker: workerNodeId }),
};
