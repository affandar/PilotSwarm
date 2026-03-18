/**
 * DevOps Command Center — Worker Module for TUI
 *
 * This module is loaded by the TUI via --worker flag.
 * It exports the custom tools so the TUI workers can use them.
 *
 * Usage:
 *   npx pilotswarm-tui --plugin ./plugin --worker ./worker-module.js --env ../../.env
 */

import { devopsTools } from "./tools.js";

export default {
    tools: devopsTools,
};
