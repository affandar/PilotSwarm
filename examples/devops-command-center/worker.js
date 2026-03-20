/**
 * DevOps Command Center — Worker module for the PilotSwarm CLI.
 *
 * Usage:
 *   npx pilotswarm --plugin ./plugin --worker ./worker.js
 */
import { createDevopsTools } from "./tools.js";

export default {
    createTools: ({ workerNodeId }) => createDevopsTools({ workerMarker: workerNodeId }),
};
