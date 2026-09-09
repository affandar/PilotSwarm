import { FeatureFlagCache } from "../../src/feature-flag-cache.js";
declare const cache: FeatureFlagCache;
cache.resolve("copilot.native_tasks", null, { fallback: false });
cache.resolve("copilot.native_tasks", null, { required: true });
// @ts-expect-error A missing key policy is mandatory.
cache.resolve("copilot.native_tasks", null);
// @ts-expect-error Fallback and required are mutually exclusive.
cache.resolve("copilot.native_tasks", null, { required: true, fallback: false });
// @ts-expect-error Code-owned keys reject typos at typed call sites.
cache.resolve("copilot.natve_tasks", null, { fallback: false });
// @ts-expect-error Required must be true, not an optional boolean switch.
cache.resolve("copilot.native_tasks", null, { required: false });
