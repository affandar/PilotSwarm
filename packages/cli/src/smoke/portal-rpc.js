// FR-027: minimal HTTP JSON-RPC client mirroring the
// portal's browser transport (`packages/portal/src/browser-transport.js`
// — `rpc()` shape, ~lines 130-151).
//
// Drives the deployed portal's `/api/rpc` endpoint with both:
//   - the admission bearer in `Authorization` (stamps `req.auth.principal`)
//   - the downstream user access token in the JSON body's `auth` envelope
//     (encrypted at the portal via EnvelopeCrypto.encrypt before being
//     enqueued — exercises the full FR-020 path).
//
// We do NOT use packages/cli/src/node-sdk-transport.js because that's
// a direct-to-store SDK transport that bypasses portal auth/runtime
// entirely; we want to exercise the real /api/rpc path the browser
// uses.

export function createPortalRpcClient({
    portalBaseUrl,
    admissionToken,
    downstreamToken,
    downstreamExpiresAt,
    httpFetch,
}) {
    const fetchImpl = httpFetch ?? fetch;
    const baseUrl = portalBaseUrl.replace(/\/+$/, "");

    async function rpc(method, params = {}) {
        const auth = downstreamToken
            ? {
                accessToken: downstreamToken,
                accessTokenExpiresAt: Number.isFinite(downstreamExpiresAt) ? downstreamExpiresAt : null,
            }
            : undefined;
        const body = auth ? { method, params, auth } : { method, params };
        const response = await fetchImpl(`${baseUrl}/api/rpc`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${admissionToken}`,
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            const err = new Error(`portal /api/rpc ${method} ${response.status}: ${text.slice(0, 200)}`);
            err.status = response.status;
            throw err;
        }
        const payload = await response.json();
        if (payload && payload.ok === false) {
            const err = new Error(payload.error || `portal ${method} returned ok=false`);
            err.payload = payload;
            throw err;
        }
        return payload?.result !== undefined ? payload.result : payload;
    }

    async function health() {
        const response = await fetchImpl(`${baseUrl}/api/health`, {
            method: "GET",
            headers: { Accept: "application/json" },
        });
        if (!response.ok) {
            throw new Error(`portal /api/health ${response.status}`);
        }
        return response.json();
    }

    return { rpc, health, baseUrl };
}
