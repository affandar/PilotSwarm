import { durableSessionOrchestration_1_0_0 } from "./orchestration_1_0_0.js";
import { durableSessionOrchestration_1_0_1 } from "./orchestration_1_0_1.js";
import { durableSessionOrchestration_1_0_2 } from "./orchestration_1_0_2.js";
import { durableSessionOrchestration_1_0_3 } from "./orchestration_1_0_3.js";
import { durableSessionOrchestration_1_0_4 } from "./orchestration_1_0_4.js";
import { durableSessionOrchestration_1_0_5 } from "./orchestration_1_0_5.js";
import { durableSessionOrchestration_1_0_6 } from "./orchestration_1_0_6.js";
import { durableSessionOrchestration_1_0_7 } from "./orchestration_1_0_7.js";
import { durableSessionOrchestration_1_0_8 } from "./orchestration_1_0_8.js";
import { durableSessionOrchestration_1_0_9 } from "./orchestration_1_0_9.js";
import { durableSessionOrchestration_1_0_10 } from "./orchestration_1_0_10.js";
import { durableSessionOrchestration_1_0_11 } from "./orchestration_1_0_11.js";
import { durableSessionOrchestration_1_0_12 } from "./orchestration_1_0_12.js";
import { durableSessionOrchestration_1_0_13 } from "./orchestration_1_0_13.js";
import { durableSessionOrchestration_1_0_14 } from "./orchestration_1_0_14.js";
import { durableSessionOrchestration_1_0_15 } from "./orchestration_1_0_15.js";
import { durableSessionOrchestration_1_0_16 } from "./orchestration_1_0_16.js";
import { durableSessionOrchestration_1_0_17 } from "./orchestration_1_0_17.js";
import { durableSessionOrchestration_1_0_18 } from "./orchestration_1_0_18.js";
import { durableSessionOrchestration_1_0_19 } from "./orchestration_1_0_19.js";
import { durableSessionOrchestration_1_0_20 } from "./orchestration_1_0_20.js";
import { durableSessionOrchestration_1_0_21 } from "./orchestration_1_0_21.js";
import { durableSessionOrchestration_1_0_22 } from "./orchestration_1_0_22.js";
import {
    CURRENT_ORCHESTRATION_VERSION,
    durableSessionOrchestration_1_0_23,
} from "./orchestration.js";

export const DURABLE_SESSION_ORCHESTRATION_NAME = "durable-session-v2";
export const DURABLE_SESSION_LATEST_VERSION = CURRENT_ORCHESTRATION_VERSION;

export const DURABLE_SESSION_ORCHESTRATION_REGISTRY: ReadonlyArray<{
    version: string;
    handler: any;
}> = [
    { version: "1.0.0", handler: durableSessionOrchestration_1_0_0 },
    { version: "1.0.1", handler: durableSessionOrchestration_1_0_1 },
    { version: "1.0.2", handler: durableSessionOrchestration_1_0_2 },
    { version: "1.0.3", handler: durableSessionOrchestration_1_0_3 },
    { version: "1.0.4", handler: durableSessionOrchestration_1_0_4 },
    { version: "1.0.5", handler: durableSessionOrchestration_1_0_5 },
    { version: "1.0.6", handler: durableSessionOrchestration_1_0_6 },
    { version: "1.0.7", handler: durableSessionOrchestration_1_0_7 },
    { version: "1.0.8", handler: durableSessionOrchestration_1_0_8 },
    { version: "1.0.9", handler: durableSessionOrchestration_1_0_9 },
    { version: "1.0.10", handler: durableSessionOrchestration_1_0_10 },
    { version: "1.0.11", handler: durableSessionOrchestration_1_0_11 },
    { version: "1.0.12", handler: durableSessionOrchestration_1_0_12 },
    { version: "1.0.13", handler: durableSessionOrchestration_1_0_13 },
    { version: "1.0.14", handler: durableSessionOrchestration_1_0_14 },
    { version: "1.0.15", handler: durableSessionOrchestration_1_0_15 },
    { version: "1.0.16", handler: durableSessionOrchestration_1_0_16 },
    { version: "1.0.17", handler: durableSessionOrchestration_1_0_17 },
    { version: "1.0.18", handler: durableSessionOrchestration_1_0_18 },
    { version: "1.0.19", handler: durableSessionOrchestration_1_0_19 },
    { version: "1.0.20", handler: durableSessionOrchestration_1_0_20 },
    { version: "1.0.21", handler: durableSessionOrchestration_1_0_21 },
    { version: "1.0.22", handler: durableSessionOrchestration_1_0_22 },
    { version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_23 },
];
