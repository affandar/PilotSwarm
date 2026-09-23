import express from "express";
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_GENERIC_BYTES } from "pilotswarm-sdk";

const HEADERS = new Set([
    "content-type", "content-encoding", "authorization", "x-hub-signature-256",
    "x-github-delivery", "x-github-event", "x-signature-256", "idempotency-key",
]);
const normalizePeer = value => String(value || "").replace(/^::ffff:/i, "");

export function webhookRequestContext(req, trustedProxyIps = []) {
    const peerAddress = normalizePeer(req.socket.remoteAddress);
    const headers = {};
    const forwarded = [];
    if (req.rawHeaders.length > 200) throw Object.assign(new Error("Too many request headers."), { status: 400, code: "WEBHOOK_INVALID" });
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index].toLowerCase();
        const value = req.rawHeaders[index + 1];
        if (name === "x-forwarded-proto") forwarded.push(value);
        if (!HEADERS.has(name)) continue;
        if (Object.hasOwn(headers, name) || typeof value !== "string" || value.length > 2048) {
            throw Object.assign(new Error("Invalid webhook headers."), { status: 400, code: "WEBHOOK_INVALID" });
        }
        headers[name] = value;
    }
    return {
        headers, peerAddress,
        secure: req.socket.encrypted === true
            || (trustedProxyIps.map(normalizePeer).includes(peerAddress) && forwarded.length === 1 && forwarded[0] === "https"),
    };
}

/** Own authentication, exact bytes, no decompression, and no capability-token logging. */
export function createWebhookRouter({ runtime, config, onError = code => console.error(`[webhooks] ingress: ${code}`) }) {
    const router = express.Router();
    const fail = (res, error) => {
        const status = error?.type === "entity.too.large" ? 413 : error?.type === "encoding.unsupported" ? 415
            : Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        const code = status === 413 ? "WEBHOOK_TOO_LARGE" : status === 415 ? "WEBHOOK_CONTENT_TYPE"
            : typeof error?.code === "string" && /^WEBHOOK[A-Z_]*$/.test(error.code) ? error.code : "WEBHOOK_UNAVAILABLE";
        if (status >= 500) onError(code);
        if (status === 429) res.set("Retry-After", "60");
        res.set("Cache-Control", "no-store");
        const message = status >= 500 ? "Webhook service is unavailable." : status === 404 ? "Webhook endpoint not found."
            : status === 413 ? "Webhook body is too large." : status === 415 ? "Only uncompressed JSON is supported."
                : status === 401 ? "Webhook authentication failed." : status === 429 ? "Webhook request limit exceeded."
                    : "Webhook request rejected.";
        res.status(status).json({ ok: false, error: { code, message } });
    };
    router.use((_req, res, next) => {
        res.set("Cache-Control", "no-store");
        if (!config.enabled) return res.status(404).json({ ok: false, error: { code: "WEBHOOKS_DISABLED", message: "Webhook ingress is disabled." } });
        next();
    });
    for (const kind of ["s", "c"]) {
        const raw = express.raw({ type: () => true, inflate: false,
            limit: kind === "s" ? WEBHOOK_MAX_GENERIC_BYTES : WEBHOOK_MAX_BODY_BYTES });
        router.post(`/${kind}/:key`, (req, res) => {
            let context;
            try { context = webhookRequestContext(req, config.trustedProxyIps); }
            catch (error) { fail(res, error); return; }
            raw(req, res, error => {
                if (error) { fail(res, error); return; }
                Promise.resolve().then(async () => {
                    const ingress = await runtime.getWebhookRuntime();
                    const input = { ...context, rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) };
                    const result = kind === "s" ? await ingress.acceptSignalEndpoint(req.params.key, input)
                        : await ingress.acceptConnector(req.params.key, input);
                    res.status(result.status).json(result.body);
                }).catch(error => fail(res, error));
            });
        });
    }
    router.use((_req, res) => res.status(404).json({ ok: false, error: { code: "WEBHOOK_NOT_FOUND", message: "Webhook endpoint not found." } }));
    router.use((error, _req, res, _next) => fail(res, error));
    return router;
}
