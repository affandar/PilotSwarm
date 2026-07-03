import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const workspacePackageAlias = {
  "pilotswarm/ui-core": fileURLToPath(new URL("../ui/core/src/index.js", import.meta.url)),
  "pilotswarm/ui-react": fileURLToPath(new URL("../ui/react/src/index.js", import.meta.url)),
  "pilotswarm-sdk/api": fileURLToPath(new URL("../../sdk/api/index.js", import.meta.url)),
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: workspacePackageAlias,
  },
  server: {
    port: 5173,
    proxy: {
      // ws:true forwards the /api/v1/ws WebSocket upgrade to the portal
      // server; it is harmless for the plain HTTP /api/v1 routes. Without it,
      // live session events and the log tail are dead in `npm run dev`.
      "/api": {
        target: "http://localhost:3001",
        ws: true,
      },
      "/portal-ws": {
        target: "http://localhost:3001",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          msal: ["@azure/msal-browser"],
          pilotswarm: ["pilotswarm/ui-core", "pilotswarm/ui-react"],
        },
      },
    },
  },
});
