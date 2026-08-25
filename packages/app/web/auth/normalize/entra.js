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
        // Access tokens often carry no `name` claim (it is an ID-token claim).
        // Fall back to the sign-in name so the user row gets SOME display
        // name and stays findable in share and editor pickers — the
        // directory hides rows with neither a name nor an email.
        displayName: String(payload.name || payload.preferred_username || "").trim() || null,
        groups: toStringArray(payload.groups),
        roles: toStringArray(payload.roles),
        tenantId: String(payload.tid || "").trim() || null,
        rawClaims: payload,
    };
}

