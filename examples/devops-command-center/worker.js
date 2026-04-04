/**
 * DevOps Command Center — Legacy worker-module alias.
 *
 * Usage:
 *   npx pilotswarm local --env ../../.env --plugin ./plugin --worker ./worker.js
 */
import { createDevopsTools } from "./tools.js";

export default {
    createTools: ({ workerNodeId }) => createDevopsTools({ workerMarker: workerNodeId }),
};
