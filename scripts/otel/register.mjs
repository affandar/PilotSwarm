import { diag, DiagConsoleLogger, DiagLogLevel, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
    getNodeAutoInstrumentations,
    getResourceDetectors,
} from "@opentelemetry/auto-instrumentations-node";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS;
const serviceName = process.env.OTEL_SERVICE_NAME || "pilotswarm-service";
const logLevel = (process.env.OTEL_LOG_LEVEL || "").trim().toLowerCase();

function parseHeaderString(headerString) {
    return Object.fromEntries(
        headerString
            .split(",")
            .map(entry => entry.trim())
            .filter(Boolean)
            .map(entry => {
                const [key, ...rest] = entry.split("=");
                return [key.trim(), rest.join("=").trim()];
            }),
    );
}

function withOtlpPath(baseUrl, path) {
    return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

if (logLevel === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

if (!endpoint || !headers) {
    console.warn(
        "[otel] Skipping OpenTelemetry bootstrap: OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_HEADERS is missing.",
    );
} else {
    const traceExporter = new OTLPTraceExporter({
        url: withOtlpPath(endpoint, "/v1/traces"),
        headers: parseHeaderString(headers),
    });

    const sdk = new NodeSDK({
        instrumentations: getNodeAutoInstrumentations(),
        resourceDetectors: getResourceDetectors(),
        traceExporter,
        serviceName,
    });

    try {
        sdk.start();
        console.log(
            `[otel] OpenTelemetry started for ${serviceName} -> ${withOtlpPath(endpoint, "/v1/traces")}`,
        );
        const tracer = trace.getTracer("pilotswarm-bootstrap");
        const span = tracer.startSpan("worker.bootstrap");
        span.setAttribute("service.name", serviceName);
        span.setAttribute("telemetry.bootstrap", true);
        span.end();
    } catch (error) {
        console.error("[otel] Failed to start OpenTelemetry SDK", error);
    }

    async function shutdown() {
        try {
            await sdk.shutdown();
        } catch (error) {
            console.error("[otel] Failed to shut down OpenTelemetry SDK", error);
        }
    }

    process.on("SIGTERM", shutdown);
    process.once("beforeExit", shutdown);
}
