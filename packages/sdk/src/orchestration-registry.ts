import { durableSessionOrchestration_1_0_47 } from "./orchestration_1_0_47.js";
import { durableSessionOrchestration_1_0_48 } from "./orchestration_1_0_48.js";
import { durableSessionOrchestration_1_0_49 } from "./orchestration_1_0_49.js";
import { durableSessionOrchestration_1_0_50 } from "./orchestration_1_0_50.js";
import { durableSessionOrchestration_1_0_51 } from "./orchestration_1_0_51.js";
import { durableSessionOrchestration_1_0_52 } from "./orchestration_1_0_52/index.js";
import { durableSessionOrchestration_1_0_53 } from "./orchestration_1_0_53/index.js";
import { durableSessionOrchestration_1_0_54 } from "./orchestration_1_0_54/index.js";
import { durableSessionOrchestration_1_0_55 } from "./orchestration_1_0_55/index.js";
import { durableSessionOrchestration_1_0_56 } from "./orchestration_1_0_56/index.js";
import { durableSessionOrchestration_1_0_57 } from "./orchestration_1_0_57/index.js";
import { durableSessionOrchestration_1_0_58 } from "./orchestration_1_0_58/index.js";
import { durableSessionOrchestration_1_0_59 } from "./orchestration_1_0_59/index.js";
import { durableSessionOrchestration_1_0_60 } from "./orchestration_1_0_60/index.js";
import { durableSessionOrchestration_1_0_61 } from "./orchestration_1_0_61/index.js";
import { durableSessionOrchestration_1_0_62 } from "./orchestration_1_0_62/index.js";
import { durableSessionOrchestration_1_0_63 } from "./orchestration_1_0_63/index.js";
import { durableSessionOrchestration_1_0_64 } from "./orchestration_1_0_64/index.js";
import { DURABLE_SESSION_LATEST_VERSION } from "./orchestration-version.js";
import { durableSessionOrchestration_1_0_65 } from "./orchestration/index.js";

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
    { version: "1.0.52", handler: durableSessionOrchestration_1_0_52 },
    { version: "1.0.53", handler: durableSessionOrchestration_1_0_53 },
    { version: "1.0.54", handler: durableSessionOrchestration_1_0_54 },
    { version: "1.0.55", handler: durableSessionOrchestration_1_0_55 },
    { version: "1.0.56", handler: durableSessionOrchestration_1_0_56 },
    { version: "1.0.57", handler: durableSessionOrchestration_1_0_57 },
    { version: "1.0.58", handler: durableSessionOrchestration_1_0_58 },
    { version: "1.0.59", handler: durableSessionOrchestration_1_0_59 },
    { version: "1.0.60", handler: durableSessionOrchestration_1_0_60 },
    { version: "1.0.61", handler: durableSessionOrchestration_1_0_61 },
    { version: "1.0.62", handler: durableSessionOrchestration_1_0_62 },
    { version: "1.0.63", handler: durableSessionOrchestration_1_0_63 },
    { version: "1.0.64", handler: durableSessionOrchestration_1_0_64 },
    { version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_65 },
];
