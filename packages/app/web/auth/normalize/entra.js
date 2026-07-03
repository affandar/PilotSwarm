function toStringArray(value) {
    return Array.isArray(value)
        ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [];
}

export function normalizeEntraPrincipal(payload = {}) {
    const subject = String(payload.oid || payload.sub || "").trim();
    if (!subject) return null;

    return {
        provider: "entra",
        subject,
        email: String(payload.preferred_username || payload.email || payload.upn || "").trim() || null,
        displayName: String(payload.name || "").trim() || null,
        groups: toStringArray(payload.groups),
        roles: toStringArray(payload.roles),
        tenantId: String(payload.tid || "").trim() || null,
        rawClaims: payload,
    };
}

