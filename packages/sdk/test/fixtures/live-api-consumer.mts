import { ApiClient, HttpApiTransport, type LiveUpdate, type LiveStateRow } from "pilotswarm-sdk/api";

const api = new ApiClient({ apiUrl: "https://portal.example.test" });
const off: () => void = api.subscribeLive("session", "turn", (update: LiveUpdate) => {
    if (update.kind === "snapshot" || update.kind === "patch") {
        const seq: number = update.seq;
        const data: Record<string, unknown> = update.data;
        void [seq, data];
    }
});
const transport = new HttpApiTransport({ apiUrl: "https://portal.example.test" });
const rows: Promise<LiveStateRow[]> = transport.getLive("session", ["turn"]);
void [off, rows];
