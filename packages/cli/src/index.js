import React from "react";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pilotswarm");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch {
        return {};
    }
}

function writeConfig(patch) {
    try {
        const existing = readConfig();
        const merged = { ...existing, ...patch };
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", "utf8");
    } catch {}
}

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
    const userConfig = readConfig();
    const store = createStore(appReducer, createInitialState({
        mode: config.mode,
        branding: config.branding,
        themeId: userConfig.themeId,
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

    // Listen for portal theme-change OSC sequences on stdin:
    //   \x1b]777;theme;<themeId>\x07
    let oscBuffer = "";
    const OSC_PREFIX = "\x1b]777;theme;";
    const OSC_SUFFIX = "\x07";
    const stdinThemeHandler = (data) => {
        const str = typeof data === "string" ? data : data.toString("utf8");
        oscBuffer += str;
        while (oscBuffer.includes(OSC_PREFIX) && oscBuffer.includes(OSC_SUFFIX)) {
            const start = oscBuffer.indexOf(OSC_PREFIX);
            const end = oscBuffer.indexOf(OSC_SUFFIX, start);
            if (end < 0) break;
            const themeId = oscBuffer.slice(start + OSC_PREFIX.length, end);
            oscBuffer = oscBuffer.slice(end + OSC_SUFFIX.length);
            if (themeId) {
                store.dispatch({ type: "ui/theme", themeId });
            }
        }
        // Prevent buffer from growing unbounded
        if (oscBuffer.length > 1024) oscBuffer = oscBuffer.slice(-256);
    };
    process.stdin.on("data", stdinThemeHandler);

    // Sync viewport on terminal resize (SIGWINCH)
    const syncViewport = () => {
        controller.setViewport({
            width: process.stdout.columns || 120,
            height: process.stdout.rows || 40,
        });
    };
    syncViewport();
    process.stdout.on("resize", syncViewport);

    // Persist theme changes to config file
    let lastPersistedThemeId = store.getState().ui.themeId;
    store.subscribe(() => {
        const currentThemeId = store.getState().ui.themeId;
        if (currentThemeId && currentThemeId !== lastPersistedThemeId) {
            lastPersistedThemeId = currentThemeId;
            writeConfig({ themeId: currentThemeId });
        }
    });

    try {
        await exitPromise;
    } finally {
        finalizeHost();
    }
}
