import { defineConfig } from "vite";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

// Vite plugin: rewrite manifest.json's `?v=` cache-buster after every build.
// The dashboard host keys its <script> cache on the URL, so without this we
// have to bump the version by hand each time we want browsers to pick up a
// new bundle. The host already serves with ETag/Last-Modified, but its
// runtime loader caches by URL string — fingerprinting the URL is the
// reliable signal.
function bumpManifestVersion() {
  const manifestPath = path.resolve(import.meta.dirname, "manifest.json");
  return {
    name: "bump-manifest-version",
    closeBundle() {
      const stamp = `${new Date()
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "")}${Date.now().toString(36).slice(-4)}`;
      const text = readFileSync(manifestPath, "utf8");
      const next = text.replace(/(\.(?:js|css))\?v=[^"]+/g, `$1?v=${stamp}`);
      if (next !== text) writeFileSync(manifestPath, next);
    },
  };
}

// All `react` imports — ours and third-party — resolve to a shim that
// re-exports the host's React 19 instance from window.__HERMES_PLUGIN_SDK__.
// This is mandatory: two React copies would silently break hooks/context
// when assistant-ui primitives render inside the host's React tree.

const reactShim = path.resolve(import.meta.dirname, "src/shims/react.ts");
const jsxRuntimeShim = path.resolve(import.meta.dirname, "src/shims/react-jsx-runtime.ts");

export default defineConfig({
  plugins: [bumpManifestVersion()],
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
    lib: {
      entry: path.resolve(import.meta.dirname, "src/index.tsx"),
      name: "OpenChatSessionPlugin",
      formats: ["iife"],
      fileName: () => "index.js",
      cssFileName: "style",
    },
    rollupOptions: {
      // Radix/assistant-ui ship "use client" directives that rollup IIFE
      // bundling drops — harmless but ~30 warnings per build. Suppress.
      onwarn(warning, defaultHandler) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        defaultHandler(warning);
      },
      output: {},
    },
  },
});
