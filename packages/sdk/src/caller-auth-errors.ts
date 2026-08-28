export const CALLER_REAUTH_REQUIRED_CODE = "PILOTSWARM_CALLER_REAUTH_REQUIRED";
export const CALLER_AUTH_CONFIGURATION_CODE = "PILOTSWARM_CALLER_AUTH_CONFIGURATION";

export class CallerReauthRequiredError extends Error {
    readonly code = CALLER_REAUTH_REQUIRED_CODE;

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "CallerReauthRequiredError";
    }
}

export class CallerAuthConfigurationError extends Error {
    readonly code = CALLER_AUTH_CONFIGURATION_CODE;

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "CallerAuthConfigurationError";
    }
}

export function isCallerReauthRequiredError(
    error: unknown,
): error is CallerReauthRequiredError {
    return Boolean(
        error
        && typeof error === "object"
        && (error as { code?: unknown }).code === CALLER_REAUTH_REQUIRED_CODE,
    );
}

export function isCallerAuthConfigurationError(
    error: unknown,
): error is CallerAuthConfigurationError {
    return Boolean(
        error
        && typeof error === "object"
        && (error as { code?: unknown }).code === CALLER_AUTH_CONFIGURATION_CODE,
    );
}
