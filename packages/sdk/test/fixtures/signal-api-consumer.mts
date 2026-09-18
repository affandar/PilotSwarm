import {
    PilotSwarmSession,
    PilotSwarmManagementClient,
    WebPilotSwarmSession,
    WebPilotSwarmManagementClient,
    type RaiseSignalOptions,
    type RaiseSignalResult,
    type SessionSignalState,
} from "pilotswarm-sdk";
import {
    HttpApiTransport,
    type RaiseSignalOptions as ApiRaiseSignalOptions,
    type RaiseSignalResult as ApiRaiseSignalResult,
    type SessionSignalState as ApiSessionSignalState,
} from "pilotswarm-sdk/api";

type Equivalent<A, B> = [A] extends [B] ? [B] extends [A] ? true : never : never;
const optionsMatch: Equivalent<RaiseSignalOptions, ApiRaiseSignalOptions> = true;
const receiptMatches: Equivalent<RaiseSignalResult, ApiRaiseSignalResult> = true;
const stateMatches: Equivalent<SessionSignalState, ApiSessionSignalState> = true;
void [optionsMatch, receiptMatches, stateMatches];

declare const session: PilotSwarmSession;
declare const webSession: WebPilotSwarmSession;
declare const management: PilotSwarmManagementClient;
declare const webManagement: WebPilotSwarmManagementClient;
declare const transport: HttpApiTransport;
const options: RaiseSignalOptions = { data: [null, true, { build: 7 }], payloadRef: "artifact:log", signalId: "r1", wake: false };
const results: Promise<RaiseSignalResult>[] = [
    session.raiseSignal("build_ready", options),
    webSession.raiseSignal("build_ready", options),
    management.raiseSignal("session", "build_ready", options),
    webManagement.raiseSignal("session", "build_ready", options),
    transport.raiseSignal("session", "build_ready", options),
];
const states: Promise<SessionSignalState>[] = [
    management.getSessionSignalState("session"),
    webManagement.getSessionSignalState("session"),
    transport.getSessionSignalState("session"),
];
void [results, states];

// @ts-expect-error A function is not JSON signal data.
session.raiseSignal("build_ready", { data: () => "not JSON" });
// @ts-expect-error Caller-controlled options cannot stamp source identity.
management.raiseSignal("session", "build_ready", { source: { kind: "system" } });
// @ts-expect-error HTTP signal data is typed JSON too.
transport.raiseSignal("session", "build_ready", { data: new Date() });
// @ts-expect-error A read exposes metadata, not inline signal data.
states[0].then(state => state.buffered[0].data);
