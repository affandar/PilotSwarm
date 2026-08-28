#!/usr/bin/env node

import { runJobGenerator } from "./index.js";

runJobGenerator().catch((error) => {
    console.error("[job-generator] fatal", error);
    process.exitCode = 1;
});
