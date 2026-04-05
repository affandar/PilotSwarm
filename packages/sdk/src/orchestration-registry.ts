import { durableSessionOrchestration_1_0_26 } from "./orchestration_1_0_26.js";
import { durableSessionOrchestration_1_0_27 } from "./orchestration_1_0_27.js";
import { durableSessionOrchestration_1_0_28 } from "./orchestration_1_0_28.js";
import { durableSessionOrchestration_1_0_29 } from "./orchestration_1_0_29.js";
import { durableSessionOrchestration_1_0_30 } from "./orchestration_1_0_30.js";
import { durableSessionOrchestration_1_0_31 } from "./orchestration_1_0_31.js";
import { durableSessionOrchestration_1_0_32 } from "./orchestration_1_0_32.js";
import { durableSessionOrchestration_1_0_33 } from "./orchestration_1_0_33.js";
import { durableSessionOrchestration_1_0_34 } from "./orchestration_1_0_34.js";
import { durableSessionOrchestration_1_0_35 } from "./orchestration_1_0_35.js";
import {
    CURRENT_ORCHESTRATION_VERSION,
    durableSessionOrchestration_1_0_36,
} from "./orchestration.js";

export const DURABLE_SESSION_ORCHESTRATION_NAME = "durable-session-v2";
export const DURABLE_SESSION_LATEST_VERSION = CURRENT_ORCHESTRATION_VERSION;

export const DURABLE_SESSION_ORCHESTRATION_REGISTRY: ReadonlyArray<{
    version: string;
    handler: any;
}> = [
    { version: "1.0.26", handler: durableSessionOrchestration_1_0_26 },
    { version: "1.0.27", handler: durableSessionOrchestration_1_0_27 },
    { version: "1.0.28", handler: durableSessionOrchestration_1_0_28 },
    { version: "1.0.29", handler: durableSessionOrchestration_1_0_29 },
    { version: "1.0.30", handler: durableSessionOrchestration_1_0_30 },
    { version: "1.0.31", handler: durableSessionOrchestration_1_0_31 },
    { version: "1.0.32", handler: durableSessionOrchestration_1_0_32 },
    { version: "1.0.33", handler: durableSessionOrchestration_1_0_33 },
    { version: "1.0.34", handler: durableSessionOrchestration_1_0_34 },
    { version: "1.0.35", handler: durableSessionOrchestration_1_0_35 },
    { version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_36 },
];
