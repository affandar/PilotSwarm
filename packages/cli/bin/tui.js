#!/usr/bin/env node

import { parseCliIntoEnv } from "../src/bootstrap-env.js";
import { startTuiApp } from "../src/index.js";

const config = parseCliIntoEnv(process.argv.slice(2));
await startTuiApp(config);
