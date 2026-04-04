import React from "react";
import fs from "node:fs";
import { createRequire } from "node:module";
import { render } from "ink";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
} from "pilotswarm-ui-core";
import { PilotSwarmTuiApp } from "./app.js";
import { createTuiPlatform } from "./platform.js";
import { NodeSdkTransport } from "./node-sdk-transport.js";

const require = createRequire(import.meta.url);

function setupTuiHostRuntime() {
    const logFile = "/tmp/duroxide-tui.log";
    const originalConsole = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalEmitWarning = process.emitWarning.bind(process);

    try {
        fs.writeFileSync(logFile, "");
    } catch {}

    try {
        const { initTracing } = require("duroxide");
        initTracing({
            logFile,
            logLevel: process.env.LOG_LEVEL || "info",
            logFormat: "compact",
        });
    } catch {}

    const appendLog = (...parts) => {
        try {
            const text = parts
                .map((part) => {
                    if (typeof part === "string") return part;
                    if (part instanceof Error) return part.stack || part.message;
                    try { return JSON.stringify(part); } catch { return String(part); }
                })
                .join(" ");
            fs.appendFileSync(logFile, `${text}\n`);
        } catch {}
    };

    console.log = (...args) => appendLog(...args);
    console.warn = (...args) => appendLog(...args);
    console.error = (...args) => appendLog(...args);

    process.stderr.write = (chunk, encoding, cb) => {
        try {
            const text = typeof chunk === "string" ? chunk : chunk?.toString?.(encoding || "utf8");
            if (text) appendLog(text.trimEnd());
        } catch {}
        if (typeof cb === "function") cb();
        return true;
    };

    process.emitWarning = (warning, ...args) => {
        appendLog("[warning]", warning, ...args);
    };

    return () => {
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        process.stderr.write = originalStderrWrite;
        process.emitWarning = originalEmitWarning;
    };
}

function clearTerminalScreen() {
    if (!process.stdout?.isTTY) return;
    try {
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    } catch {}
}

export async function startTuiApp(config) {
    const restoreHostRuntime = setupTuiHostRuntime();
    const platform = createTuiPlatform();
    const transport = new NodeSdkTransport({
        store: config.store,
        mode: config.mode,
    });
    const store = createStore(appReducer, createInitialState({
        mode: config.mode,
        branding: config.branding,
    }));
    const controller = new PilotSwarmUiController({ store, transport });
    let tuiApp;
    let finalized = false;
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
        resolveExit = resolve;
    });

    const finalizeHost = () => {
        if (finalized) return;
        finalized = true;
        try {
            tuiApp?.cleanup?.();
        } catch {}
        restoreHostRuntime();
        clearTerminalScreen();
        resolveExit?.();
    };

    const requestExit = async () => {
        const forceExitTimer = setTimeout(() => {
            finalizeHost();
            process.exit(0);
        }, 5000);
        forceExitTimer.unref?.();

        try {
            await controller.stop();
        } catch {}
        finally {
            clearTimeout(forceExitTimer);
            try {
                tuiApp?.clear?.();
            } catch {}
            try {
                tuiApp?.unmount();
            } catch {}
            finalizeHost();
            process.exit(0);
        }
    };

    tuiApp = render(React.createElement(PilotSwarmTuiApp, {
        controller,
        platform,
        onRequestExit: requestExit,
    }), {
        exitOnCtrlC: false,
    });

    try {
        await exitPromise;
    } finally {
        finalizeHost();
    }
}
