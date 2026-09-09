function canonicalErrorText(value) {
    // ManagedSession adds this wrapper when promoting an SDK session.error
    // to a failed turn. The SDK event itself retains the original message.
    return String(value || "").trim().replace(/^Execution failed:\s*/, "");
}

export function matchesSessionError(recorded, current) {
    const error = canonicalErrorText(recorded);
    const statusError = canonicalErrorText(current);
    // Orchestration status can append retry details to the recorded failure.
    // Match only the whole message or its detail suffix, never an arbitrary
    // substring shared by different errors.
    return Boolean(error) && (statusError === error || statusError.startsWith(`${error} (`));
}
