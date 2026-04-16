export function validateBearerToken(expectedToken: string | undefined) {
    return (req: { headers: Record<string, string | undefined> }): boolean => {
        if (!expectedToken) return true;
        const auth = req.headers["authorization"] ?? req.headers["Authorization"];
        return auth === `Bearer ${expectedToken}`;
    };
}
