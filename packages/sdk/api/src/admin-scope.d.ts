export type AdminScope = "unrestricted" | "cluster";
export declare const ADMIN_SCOPE_POLICY_VERSION: number;
export declare const ADMIN_SCOPES: readonly AdminScope[];
export declare function loadAdminScope(env?: Record<string, string | undefined>): AdminScope;
export declare function validateAdminScope(env: Record<string, string | undefined>, options?: { authenticationEnabled?: boolean }): AdminScope;
export declare function adminCanAccessResource(isAdmin: boolean | undefined, adminScope?: AdminScope, isSystem?: boolean): boolean;
export declare function adminCapabilities(isAdmin: boolean, adminScope?: AdminScope): {
    clusterManagement: boolean;
    fleetAccounting: boolean;
    userResourceBypass: boolean;
    systemSessionAdmin: boolean;
};
