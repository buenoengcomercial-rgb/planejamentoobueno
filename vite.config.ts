import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { vendorChunkName } from "./build/vendorChunks";

function buildRevision() {
  if (process.env.VITE_APP_REVISION) return process.env.VITE_APP_REVISION;
  try { return execFileSync('git', ['describe', '--always', '--dirty'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); }
  catch {
    // Lovable/CI may provide a source archive without Git metadata.
    const hash = createHash('sha256');
    for (const file of ['src/pages/Index.tsx','src/lib/projectSync.ts','src/hooks/useAuth.tsx','src/hooks/useOrganization.tsx','src/workers/weeklyRoutine.worker.ts']) hash.update(readFileSync(path.resolve(__dirname,file)));
    return `source-${hash.digest('hex').slice(0,12)}`;
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __APP_BUILD__: JSON.stringify({ revision: buildRevision(), builtAt: new Date().toISOString() }),
  },
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: vendorChunkName,
      },
    },
  },
});
