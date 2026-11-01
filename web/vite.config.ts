import { defineConfig } from "vite";

declare const process: { env: Record<string, string | undefined> };

// The Rust server embeds dist/: index.html is served at "/", everything else
// under "/static/". In development Vite proxies the API to a running server.
const backend = process.env.BACKEND ?? "http://127.0.0.1:8790";

export default defineConfig({
  base: "/static/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // Keep everything as files: the CSP allows no inline scripts or styles.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    proxy: Object.fromEntries(
      ["/local", "/auth", "/account", "/api", "/img", "/impressum", "/datenschutz"].map((p) => [p, backend]),
    ),
  },
});
