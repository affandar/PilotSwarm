/**
 * Envelope crypto for the User OBO propagation feature.
 *
 * Token material in `UserEnvelope.accessToken` MUST NOT enter the durable
 * PG queue or Duroxide activity-input history in plaintext (FR-020 /
 * FR-023 / SC-004). This module produces and consumes the on-the-wire
 * ciphertext carried in `UserEnvelopeCarrier.accessTokenCipher`.
 *
 * Three backends:
 *   1. `AkvEnvelopeCrypto` — production. Lazy-imports the Azure SDKs so
 *      non-OBO consumers don't pull them at module load.
 *   2. `InMemoryEnvelopeCrypto` — tests + local dev (no plaintext mode).
 *      Uses an in-process RSA-2048 keypair.
 *   3. `PlaintextEnvelopeCrypto` — dev-only escape hatch. Refuses to start
 *      when `NODE_ENV === 'production'`. Emits a loud startup warning.
 *
 * Backend selection lives in `selectEnvelopeCrypto(env)`.
 *
 * @internal
 */

import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    generateKeyPairSync,
    publicEncrypt,
    privateDecrypt,
    constants as cryptoConstants,
    type KeyObject,
} from "node:crypto";
import type { EnvelopeCipher, UserEnvelope } from "./types.js";

const PLAINTEXT_MODE_KID = "plaintext-mode";
const IN_MEMORY_KID_PREFIX = "in-memory:";

/** Plaintext payload that gets AES-GCM encrypted. */
interface TokenPayload {
    accessToken: string;
    accessTokenExpiresAt: number | null;
}

function tokenPayload(envelope: UserEnvelope): TokenPayload | null {
    if (envelope.accessToken == null) return null;
    return {
        accessToken: envelope.accessToken,
        accessTokenExpiresAt: envelope.accessTokenExpiresAt ?? null,
    };
}

function aesGcmEncrypt(plaintext: Buffer, dek: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag };
}

function aesGcmDecrypt(cipher: { ciphertext: Buffer; iv: Buffer; tag: Buffer }, dek: Buffer): Buffer {
    const d = createDecipheriv("aes-256-gcm", dek, cipher.iv);
    d.setAuthTag(cipher.tag);
    return Buffer.concat([d.update(cipher.ciphertext), d.final()]);
}

function zeroize(buf: Buffer): void {
    buf.fill(0);
}

export interface EnvelopeCrypto {
    /** Encrypts the token portion of `envelope`. Returns null when the envelope carries no token. */
    encrypt(envelope: UserEnvelope): Promise<EnvelopeCipher | null>;
    /** Decrypts a cipher and returns the plaintext token payload. */
    decrypt(cipher: EnvelopeCipher): Promise<TokenPayload>;
    /** Backend identifier — used by selection rules and logging. */
    readonly backend: "akv" | "in-memory" | "plaintext";
    /** KEK identifier this backend will stamp on emitted ciphertext. */
    readonly kekKid: string;
}

// ─── In-memory backend ─────────────────────────────────────────────

export class InMemoryEnvelopeCrypto implements EnvelopeCrypto {
    public readonly backend = "in-memory" as const;
    public readonly kekKid: string;
    private readonly publicKey: KeyObject;
    private readonly privateKey: KeyObject;

    constructor(kid?: string) {
        const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        this.publicKey = publicKey;
        this.privateKey = privateKey;
        this.kekKid = kid ?? `${IN_MEMORY_KID_PREFIX}${randomBytes(8).toString("hex")}`;
    }

    async encrypt(envelope: UserEnvelope): Promise<EnvelopeCipher | null> {
        const payload = tokenPayload(envelope);
        if (!payload) return null;
        const dek = randomBytes(32);
        try {
            const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
            const { ciphertext, iv, tag } = aesGcmEncrypt(plaintext, dek);
            const wrappedDek = publicEncrypt(
                { key: this.publicKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
                dek,
            );
            return {
                ciphertext: ciphertext.toString("base64"),
                iv: iv.toString("base64"),
                tag: tag.toString("base64"),
                wrappedDek: wrappedDek.toString("base64"),
                kekKid: this.kekKid,
            };
        } finally {
            zeroize(dek);
        }
    }

    async decrypt(cipher: EnvelopeCipher): Promise<TokenPayload> {
        if (!cipher.kekKid.startsWith(IN_MEMORY_KID_PREFIX)) {
            throw new Error(
                `InMemoryEnvelopeCrypto refuses to decrypt cross-mode ciphertext (kekKid=${cipher.kekKid}).`,
            );
        }
        if (cipher.kekKid !== this.kekKid) {
            throw new Error(
                `InMemoryEnvelopeCrypto KEK mismatch: cipher kid=${cipher.kekKid} this kid=${this.kekKid}.`,
            );
        }
        const wrapped = Buffer.from(cipher.wrappedDek, "base64");
        const dek = privateDecrypt(
            { key: this.privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
            wrapped,
        );
        try {
            const plain = aesGcmDecrypt(
                {
                    ciphertext: Buffer.from(cipher.ciphertext, "base64"),
                    iv: Buffer.from(cipher.iv, "base64"),
                    tag: Buffer.from(cipher.tag, "base64"),
                },
                dek,
            );
            return JSON.parse(plain.toString("utf8")) as TokenPayload;
        } finally {
            zeroize(dek);
        }
    }
}

// ─── Plaintext backend (dev-only) ──────────────────────────────────

export class PlaintextEnvelopeCrypto implements EnvelopeCrypto {
    public readonly backend = "plaintext" as const;
    public readonly kekKid = PLAINTEXT_MODE_KID;

    constructor() {
        if (process.env.NODE_ENV === "production") {
            throw new Error(
                "PlaintextEnvelopeCrypto is not allowed in production (NODE_ENV=production).",
            );
        }
    }

    async encrypt(envelope: UserEnvelope): Promise<EnvelopeCipher | null> {
        const payload = tokenPayload(envelope);
        if (!payload) return null;
        const plain = Buffer.from(JSON.stringify(payload), "utf8");
        return {
            ciphertext: plain.toString("base64"),
            iv: "",
            tag: "",
            wrappedDek: "",
            kekKid: PLAINTEXT_MODE_KID,
        };
    }

    async decrypt(cipher: EnvelopeCipher): Promise<TokenPayload> {
        if (cipher.kekKid !== PLAINTEXT_MODE_KID) {
            throw new Error(
                `PlaintextEnvelopeCrypto refuses to decrypt non-plaintext-mode ciphertext (kekKid=${cipher.kekKid}).`,
            );
        }
        const plain = Buffer.from(cipher.ciphertext, "base64");
        return JSON.parse(plain.toString("utf8")) as TokenPayload;
    }
}

// ─── AKV backend (production) ──────────────────────────────────────

export class AkvEnvelopeCrypto implements EnvelopeCrypto {
    public readonly backend = "akv" as const;
    public readonly kekKid: string;
    private clientPromise: Promise<any> | null = null;

    constructor(kekKid: string) {
        if (!kekKid || !kekKid.startsWith("https://")) {
            throw new Error(
                `AkvEnvelopeCrypto requires OBO_KEK_KID to be a full AKV key URL with version, got: ${kekKid}`,
            );
        }
        this.kekKid = kekKid;
    }

    /**
     * Lazy-imports `@azure/keyvault-keys` and `@azure/identity` so that
     * non-OBO deployments and unit tests don't pull the Azure SDKs at
     * module load time. The first call resolves the import once and
     * caches the resulting `CryptographyClient`.
     */
    private async getClient(): Promise<any> {
        if (!this.clientPromise) {
            this.clientPromise = (async () => {
                // Lazy-load Azure SDKs so non-OBO consumers don't pull them.
                // Cast through `any` to avoid a hard dependency on the
                // type packages at compile time.
                const keyvault: any = await import("@azure/keyvault-keys" as any);
                const identity: any = await import("@azure/identity" as any);
                const credential = new identity.DefaultAzureCredential();
                return new keyvault.CryptographyClient(this.kekKid, credential);
            })();
        }
        return this.clientPromise;
    }

    async encrypt(envelope: UserEnvelope): Promise<EnvelopeCipher | null> {
        const payload = tokenPayload(envelope);
        if (!payload) return null;
        const dek = randomBytes(32);
        try {
            const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
            const { ciphertext, iv, tag } = aesGcmEncrypt(plaintext, dek);
            const client = await this.getClient();
            const wrapResult = await client.wrapKey("RSA-OAEP-256", dek);
            const wrappedDek: Buffer = Buffer.isBuffer(wrapResult.result)
                ? wrapResult.result
                : Buffer.from(wrapResult.result);
            // Pin the ciphertext to the specific KEK *version* that wrapped
            // the DEK (not the un-versioned `OBO_KEK_KID` env value). After
            // KEK rotation, this lets `decrypt()` request the prior version
            // and successfully unwrap. `wrapResult.keyID` is the fully
            // versioned key URL returned by AKV.
            const versionedKid: string =
                (wrapResult && typeof wrapResult.keyID === "string" && wrapResult.keyID.length > 0)
                    ? wrapResult.keyID
                    : this.kekKid;
            return {
                ciphertext: ciphertext.toString("base64"),
                iv: iv.toString("base64"),
                tag: tag.toString("base64"),
                wrappedDek: wrappedDek.toString("base64"),
                kekKid: versionedKid,
            };
        } finally {
            zeroize(dek);
        }
    }

    async decrypt(cipher: EnvelopeCipher): Promise<TokenPayload> {
        if (cipher.kekKid === PLAINTEXT_MODE_KID || cipher.kekKid.startsWith(IN_MEMORY_KID_PREFIX)) {
            throw new Error(
                `AkvEnvelopeCrypto refuses to decrypt cross-mode ciphertext (kekKid=${cipher.kekKid}).`,
            );
        }
        // Build a per-message client targeting the cipher's specific key
        // version so KEK rotation (older versions still readable) works.
        const keyvault: any = await import("@azure/keyvault-keys" as any);
        const identity: any = await import("@azure/identity" as any);
        const credential = new identity.DefaultAzureCredential();
        const client = new keyvault.CryptographyClient(cipher.kekKid, credential);
        const wrapped = Buffer.from(cipher.wrappedDek, "base64");
        const unwrap = await client.unwrapKey("RSA-OAEP-256", wrapped);
        const dek: Buffer = Buffer.isBuffer(unwrap.result) ? unwrap.result : Buffer.from(unwrap.result);
        try {
            const plain = aesGcmDecrypt(
                {
                    ciphertext: Buffer.from(cipher.ciphertext, "base64"),
                    iv: Buffer.from(cipher.iv, "base64"),
                    tag: Buffer.from(cipher.tag, "base64"),
                },
                dek,
            );
            return JSON.parse(plain.toString("utf8")) as TokenPayload;
        } finally {
            zeroize(dek);
        }
    }
}

// ─── Backend selection ─────────────────────────────────────────────

/**
 * Selects the envelope-crypto backend based on environment configuration.
 *
 * Selection rules:
 *   - No worker scope configured (`PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE` unset):
 *     returns `null`. Portal still attaches plaintext principal-only
 *     envelopes to worker-bound RPCs — token cipher field is `null`.
 *   - Worker scope configured AND `OBO_KEK_KID` set: `AkvEnvelopeCrypto`.
 *   - Worker scope configured AND `OBO_ENVELOPE_PLAINTEXT_MODE=1` AND not
 *     production: `PlaintextEnvelopeCrypto` (with loud startup warning).
 *   - Worker scope configured but neither KEK nor plaintext-mode: throws.
 */
export function selectEnvelopeCrypto(env: NodeJS.ProcessEnv): EnvelopeCrypto | null {
    const scope = (env.PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE || "").trim();
    if (!scope) return null;

    const kekKid = (env.OBO_KEK_KID || "").trim();
    const plaintextMode = env.OBO_ENVELOPE_PLAINTEXT_MODE === "1";

    if (kekKid) {
        return new AkvEnvelopeCrypto(kekKid);
    }
    if (plaintextMode) {
        if (env.NODE_ENV === "production") {
            throw new Error(
                "OBO_ENVELOPE_PLAINTEXT_MODE=1 is not allowed in production. " +
                "Configure OBO_KEK_KID with an AKV key URL instead.",
            );
        }
        // eslint-disable-next-line no-console
        console.warn(
            "[envelope-crypto] WARNING: OBO_ENVELOPE_PLAINTEXT_MODE=1 active. " +
            "User access tokens are NOT encrypted on the wire. Dev/test only.",
        );
        return new PlaintextEnvelopeCrypto();
    }
    throw new Error(
        "PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE is configured but neither OBO_KEK_KID " +
        "nor OBO_ENVELOPE_PLAINTEXT_MODE is set. Configure one of them, or unset " +
        "the downstream scope to disable OBO.",
    );
}

export const __test__ = { PLAINTEXT_MODE_KID, IN_MEMORY_KID_PREFIX };
