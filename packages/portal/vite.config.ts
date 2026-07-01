import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const workspacePackageAlias = {
  "pilotswarm-ui-core": fileURLToPath(new URL("../ui-core/src/index.js", import.meta.url)),
  "pilotswarm-ui-react": fileURLToPath(new URL("../ui-react/src/index.js", import.meta.url)),
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: workspacePackageAlias,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
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
          pilotswarm: ["pilotswarm-ui-core", "pilotswarm-ui-react"],
        },
      },
    },
  },
});
