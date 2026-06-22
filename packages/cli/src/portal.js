export { NodeSdkTransport } from "./node-sdk-transport.js";
export {
    getPluginDirsFromEnv,
    readPluginMetadata,
    resolvePortalConfigBundleFromPluginDirs,
    resolvePortalConfigFromPluginDirs,
} from "./plugin-config.js";

// User OBO: re-export envelope-crypto factory so the portal can
// instantiate its own EnvelopeCrypto without taking a direct dependency on
// pilotswarm-sdk. Same env-driven selection rules as the worker.
export { selectEnvelopeCrypto } from "pilotswarm-sdk";
