import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// `--mode demo` swaps the GenLayer access layer for a simulated in-browser chain
// (src/demo/mock-chain.js) so the interface can be explored without a node.
// The normal build never includes it. base "./" lets the build run from any path
// (GitHub Pages project sites included).
export default defineConfig(({ mode }) => ({
  base: "./",
  resolve: {
    alias: mode === "demo" ? { "./chain.js": fileURLToPath(new URL("./src/demo/mock-chain.js", import.meta.url)) } : {},
  },
  build: { chunkSizeWarningLimit: 900 },
}));
