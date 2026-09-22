import {
    createManagementOps,
    normalizeRuntimeModels,
    type RuntimeModel,
    WebPilotSwarmManagementClient,
} from "pilotswarm-sdk";

const normalized: RuntimeModel[] = normalizeRuntimeModels([{
    qualifiedName: "provider:model",
    modelName: "model",
    providerId: "provider",
    providerType: "provider-type",
    supportedReasoningEfforts: ["vendor-effort"],
    supportedContextTiers: ["vendor-context"],
}]);

const ops = createManagementOps(async () => normalized);
const wireResult: Promise<RuntimeModel[]> = ops.listModels();

declare const webClient: WebPilotSwarmManagementClient;
const ergonomicResult: Promise<RuntimeModel[]> = webClient.listModels();
const runtimeResult: Promise<RuntimeModel[]> = webClient.listRuntimeModels();

void wireResult;
void ergonomicResult;
void runtimeResult;
