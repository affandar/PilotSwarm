// Side-effecting plugin: registers the test-only fake driver so CLI subprocess
// runs can exercise the engine without infra. Loaded via `--require=<path>`.
import { registerDriver } from "../../src/index.js";
import { fakeDriverFactory } from "./fake-driver.js";

registerDriver("fake", { factory: fakeDriverFactory });
