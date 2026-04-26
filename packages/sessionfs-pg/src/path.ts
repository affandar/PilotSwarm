/**
 * Path canonicalization for the Postgres SessionFs provider.
 *
 * Goals:
 *   - Always POSIX, root '/'.
 *   - Collapse '.' and repeated '/'.
 *   - Resolve '..' but reject if it escapes root.
 *   - Trim trailing '/' (except root).
 *
 * The TS layer canonicalizes; SQL trusts the result.
 */
export function canonicalizePath(input: string | undefined | null): string {
    // The SDK passes undefined/"" when it wants the root of the session-fs view
    // (its `sessionStatePath` namespace root). Treat both as the root directory.
    if (input === undefined || input === null || input === "") return "/";
    if (typeof input !== "string") {
        throw new Error("path must be a string");
    }

    const isAbsolute = input.startsWith("/");
    const segments = input.split("/").filter((s) => s.length > 0 && s !== ".");
    const stack: string[] = [];

    for (const seg of segments) {
        if (seg === "..") {
            if (stack.length === 0) {
                throw new Error(`path escapes root: ${input}`);
            }
            stack.pop();
        } else {
            if (seg.includes("\0")) {
                throw new Error(`path contains NUL byte: ${input}`);
            }
            stack.push(seg);
        }
    }

    if (stack.length === 0) return "/";
    const joined = stack.join("/");
    return isAbsolute ? `/${joined}` : `/${joined}`; // SessionFs paths are absolute by contract
}
