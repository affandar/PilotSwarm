import { describe, expect, it } from "vitest";
import { decodeClaims, isInteractive } from "../src/proxy/jwt.js";
import { APP_TOKEN, AMBIGUOUS_TOKEN, USER_TOKEN } from "./tokens.js";

describe("decodeClaims", () => {
    it("decodes a well-formed JWT payload without verifying the signature", () => {
        expect(decodeClaims(USER_TOKEN)).toMatchObject({ idtyp: "user", upn: "alice@contoso.com" });
    });

    it("returns {} for a non-JWT string", () => {
        expect(decodeClaims("not-a-jwt")).toEqual({});
    });

    it("returns {} for an empty string", () => {
        expect(decodeClaims("")).toEqual({});
    });

    it("returns {} when the payload is not valid base64url JSON", () => {
        expect(decodeClaims("aaa.!!!not-base64!!!.bbb")).toEqual({});
    });
});

describe("isInteractive", () => {
    it("treats an explicit user idtyp as interactive", () => {
        expect(isInteractive(decodeClaims(USER_TOKEN))).toBe(true);
    });

    it("treats an explicit app idtyp as non-interactive", () => {
        expect(isInteractive(decodeClaims(APP_TOKEN))).toBe(false);
    });

    it("treats a token with no interactive markers (only oid) as non-interactive", () => {
        expect(isInteractive(decodeClaims(AMBIGUOUS_TOKEN))).toBe(false);
    });

    it("treats a token carrying scp (no idtyp) as interactive", () => {
        expect(isInteractive({ scp: "user_impersonation" })).toBe(true);
    });

    it("treats a token carrying a user principal (no idtyp) as interactive", () => {
        expect(isInteractive({ preferred_username: "bob@contoso.com" })).toBe(true);
    });

    it("prefers idtyp=app even when a user principal is present", () => {
        expect(isInteractive({ idtyp: "app", upn: "svc@contoso.com" })).toBe(false);
    });
});
