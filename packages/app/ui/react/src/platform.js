import React from "react";

const UiPlatformContext = React.createContext(null);

export function UiPlatformProvider({ platform, children }) {
    return React.createElement(UiPlatformContext.Provider, { value: platform }, children);
}

export function useUiPlatform() {
    const platform = React.useContext(UiPlatformContext);
    if (!platform) {
        throw new Error("useUiPlatform must be used within a UiPlatformProvider");
    }
    return platform;
}
