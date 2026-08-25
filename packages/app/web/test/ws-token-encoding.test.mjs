/**
 * The WebSocket token rides the Sec-WebSocket-Protocol header as
 * ["access_token", <token>]. A subprotocol value must be an RFC 6455 token —
 * no ":" — so the client percent-encodes and the server decodes. A dev
 * token is `dev:<persona>`; before this the browser's WebSocket constructor
 * threw and no live path (events, canvas ticks, KV changes) ever opened
 * under the dev auth provider.
 *
 * Run: node --test web/test/ws-token-encoding.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractToken } from "../auth/index.js";

test("a percent-encoded dev token decodes back to dev:<persona>", () => {
    assert.equal(extractToken({ headers: { "sec-websocket-protocol": "access_token, dev%3Aalice" } }), "dev:alice");
});

test("a JWT is byte-identical (base64url has nothing to escape)", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.abc-_DEF";
    assert.equal(extractToken({ headers: { "sec-websocket-protocol": `access_token, ${jwt}` } }), jwt);
    assert.equal(encodeURIComponent(jwt), jwt, "what the client sends is what the server sees");
});

test("a malformed escape falls back to the raw value instead of throwing", () => {
    assert.equal(extractToken({ headers: { "sec-websocket-protocol": "access_token, 100%legit" } }), "100%legit");
});

test("the Authorization header still wins over the subprotocol", () => {
    assert.equal(extractToken({ headers: { authorization: "Bearer dev:bob", "sec-websocket-protocol": "access_token, dev%3Aalice" } }), "dev:bob");
});
