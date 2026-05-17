import { defineConfig } from "vite";
import path from "node:path";

// All `react` imports — ours and third-party — resolve to a shim that
// re-exports the host's React 19 instance from window.__HERMES_PLUGIN_SDK__.
// This is mandatory: two React copies would silently break hooks/context
// when assistant-ui primitives render inside the host's React tree.

const reactShim = path.resolve(import.meta.dirname, "src/shims/react.ts");
const jsxRuntimeShim = path.resolve(import.meta.dirname, "src/shims/react-jsx-runtime.ts");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: reactShim },
      { find: /^react\/jsx-runtime$/, replacement: jsxRuntimeShim },
      { find: /^react\/jsx-dev-runtime$/, replacement: jsxRuntimeShim },
      { find: "@", replacement: path.resolve(import.meta.dirname, "src") },
    ],
  },
  esbuild: {
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  },
  define: {
    // assistant-ui + radix code has plenty of `process.env.NODE_ENV`
    // guards that don't survive in a browser IIFE without inlining.
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(import.meta.dirname, "src/index.tsx"),
      name: "OpenChatSessionPlugin",
      formats: ["iife"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      // Radix/assistant-ui ship "use client" directives that rollup IIFE
      // bundling drops — harmless but ~30 warnings per build. Suppress.
      onwarn(warning, defaultHandler) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        defaultHandler(warning);
      },
      output: {
        assetFileNames: (info) =>
          info.names && info.names.includes("style.css") ? "style.css" : "[name][extname]",
      },
    },
  },
});
