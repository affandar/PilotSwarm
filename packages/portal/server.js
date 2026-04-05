/**
 * Portal server — Hosts the PilotSwarm TUI in the browser.
 *
 * Architecture:
 *   Browser (xterm.js) ↔ WebSocket ↔ node-pty (pseudo-terminal) ↔ terminal UI
 *
 * Each browser tab gets its own PTY + TUI process. The TUI runs exactly
 * as it does in a real terminal — same keybindings, layout, colors.
 */

import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";

import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);

/** Resolve the directory of an npm package (handles workspace hoisting). */
function findPkgDir(pkg) {
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return path.dirname(pkgJson);
}

export function startServer(opts = {}) {
  const { port = 3001 } = opts;

  const app = express();
  const server = http.createServer(app);

  // Serve static files (index.html + xterm assets)
  app.use(express.static(path.join(__dirname, "public")));
  app.use("/ui-core", express.static(path.join(REPO_ROOT, "packages/ui-core/src")));

  // Serve xterm.js from node_modules (may be hoisted to repo root)
  const xtermBase = findPkgDir("@xterm/xterm");
  const fitBase = findPkgDir("@xterm/addon-fit");
  const webLinksBase = findPkgDir("@xterm/addon-web-links");
  app.use("/xterm", express.static(xtermBase));
  app.use("/xterm-addon-fit", express.static(fitBase));
  app.use("/xterm-addon-web-links", express.static(webLinksBase));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, activePtys: activePtys.size });
  });

  // Track active PTY processes
  const activePtys = new Map();

  // ── WebSocket server ──────────────────────────────────────────
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    console.log("[portal] Browser connected — spawning TUI...");

    // Determine the env file and TUI mode to use
    const envFile = process.env.PORTAL_ENV_FILE || ".env";
    const tuiMode = process.env.PORTAL_TUI_MODE || "local";

    // Spawn the TUI in a PTY
    const tuiCmd = path.join(REPO_ROOT, "packages/cli/bin/tui.js");
    const ptyProcess = pty.spawn(process.execPath, [tuiCmd, tuiMode], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "3",
      },
    });

    const ptyId = ptyProcess.pid;
    activePtys.set(ptyId, ptyProcess);
    console.log(`[portal] TUI spawned (PID ${ptyId})`);

    // PTY → Browser: forward terminal output
    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    // PTY exit → close WebSocket
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[portal] TUI exited (PID ${ptyId}, code ${exitCode})`);
      activePtys.delete(ptyId);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
    });

    // Browser → PTY: forward keyboard input + resize
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        switch (msg.type) {
          case "input":
            ptyProcess.write(msg.data);
            break;
          case "resize":
            if (msg.cols > 0 && msg.rows > 0) {
              ptyProcess.resize(msg.cols, msg.rows);
            }
            break;
          case "theme":
            if (msg.themeId && typeof msg.themeId === "string") {
              ptyProcess.write(`\x1b]777;theme;${msg.themeId}\x07`);
            }
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Browser disconnect → kill PTY
    ws.on("close", () => {
      console.log(`[portal] Browser disconnected — killing TUI (PID ${ptyId})`);
      activePtys.delete(ptyId);
      try { ptyProcess.kill(); } catch {}
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────
  function shutdown() {
    console.log("[portal] Shutting down...");
    for (const [pid, p] of activePtys) {
      try { p.kill(); } catch {}
    }
    activePtys.clear();
    server.close();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Start ─────────────────────────────────────────────────────
  server.listen(port, () => {
    console.log(`[portal] PilotSwarm Web at http://localhost:${port}`);
  });

  return server;
}

// Auto-start when run directly
if (process.argv[1]?.endsWith("server.js") ||
    import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
