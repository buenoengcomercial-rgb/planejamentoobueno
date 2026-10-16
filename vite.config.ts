import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { vendorChunkName } from "./build/vendorChunks";

function buildRevision() {
  if (process.env.VITE_APP_REVISION) return process.env.VITE_APP_REVISION;
  try { return execFileSync('git', ['describe', '--always', '--dirty'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); }
  catch {
    // Lovable/CI may provide a source archive without Git metadata.
    const hash = createHash('sha256');
    const walk = (directory: string): string[] => readdirSync(path.resolve(__dirname, directory), { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .flatMap(entry => entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
    const files = [...walk('src'), ...walk('build'), ...walk('supabase').filter(file => /\.(ts|sql|toml)$/.test(file)), 'vite.config.ts', 'package.json', 'package-lock.json'];
    for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(path.resolve(__dirname,file))).update('\0');
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
