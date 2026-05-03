import { durableSessionOrchestration_1_0_47 } from "./orchestration_1_0_47.js";
import { durableSessionOrchestration_1_0_48 } from "./orchestration_1_0_48.js";
import { durableSessionOrchestration_1_0_49 } from "./orchestration_1_0_49.js";
import { durableSessionOrchestration_1_0_50 } from "./orchestration_1_0_50.js";
import { durableSessionOrchestration_1_0_51 } from "./orchestration_1_0_51.js";
import { DURABLE_SESSION_LATEST_VERSION } from "./orchestration-version.js";
import { durableSessionOrchestration_1_0_52 } from "./orchestration/index.js";

export const DURABLE_SESSION_ORCHESTRATION_NAME = "durable-session-v2";
export { DURABLE_SESSION_LATEST_VERSION } from "./orchestration-version.js";

export const DURABLE_SESSION_ORCHESTRATION_REGISTRY: ReadonlyArray<{
    version: string;
    handler: any;
}> = [
    { version: "1.0.47", handler: durableSessionOrchestration_1_0_47 },
    { version: "1.0.48", handler: durableSessionOrchestration_1_0_48 },
    { version: "1.0.49", handler: durableSessionOrchestration_1_0_49 },
    { version: "1.0.50", handler: durableSessionOrchestration_1_0_50 },
    { version: "1.0.51", handler: durableSessionOrchestration_1_0_51 },
    { version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_52 },
];
