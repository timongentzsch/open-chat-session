// Build gate: every Tailwind utility class used in plugin source must exist in
// the host dashboard's compiled CSS. The plugin cannot run its own Tailwind
// build (a plugin @theme would clobber the host's --color-* tokens), so any
// class the host didn't emit silently no-ops — this turns that into a build
// error. One-off values belong in inline style={{...}} or src/styles.css.

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const WEB_DIST_ASSETS =
  process.env.HERMES_WEB_DIST_ASSETS ||
  path.join(homedir(), ".hermes/hermes-agent/hermes_cli/web_dist/assets");

// Non-utility tokens that legitimately appear in className strings.
const IGNORE_PREFIXES = ["ocs-", "data-", "aui-"];
// Non-class string literals that slip through the className/ui.ts scan.
const IGNORE_TOKENS = new Set(["permission-denied", "needs-pwa-install"]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

function providedClasses() {
  const classes = new Set();
  const harvest = (css) => {
    for (const m of css.matchAll(/\.((?:[A-Za-z0-9_-]|\\.)+)/g)) {
      classes.add(m[1].replace(/\\(.)/g, "$1"));
    }
  };
  for (const f of readdirSync(WEB_DIST_ASSETS)) {
    if (f.endsWith(".css")) harvest(readFileSync(path.join(WEB_DIST_ASSETS, f), "utf8"));
  }
  // The plugin's own stylesheet fills host gaps (see "Host-gap utilities").
  harvest(readFileSync(path.join(SRC, "styles.css"), "utf8"));
  return classes;
}

// Class candidates: string literals inside className= attributes/expressions
// and every string literal in ui.ts (the central class-string module).
function candidateTokens() {
  const tokens = new Map(); // token -> first "file:line"
  const addLiterals = (text, file, offsetIndex) => {
    for (const m of text.matchAll(/"([^"\\]*)"|'([^'\\]*)'|`([^`]*)`/g)) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
      for (const tok of raw.split(/\s+/)) {
        if (!tok || !/^[A-Za-z0-9:_/\[\]().%#!.-]+$/.test(tok)) continue;
        if (!/[a-z]/.test(tok)) continue;
        // Utilities all carry a separator; bare words ("error", labels) are
        // not worth flagging and are mostly non-class literals.
        if (!/[-:/[]/.test(tok)) continue;
        if (IGNORE_PREFIXES.some((p) => tok.startsWith(p))) continue;
        if (IGNORE_TOKENS.has(tok)) continue;
        if (!tokens.has(tok)) {
          const line = offsetIndex(m.index);
          tokens.set(tok, `${file}:${line}`);
        }
      }
    }
  };
  for (const f of walk(SRC)) {
    const text = readFileSync(f, "utf8");
    const rel = path.relative(SRC, f);
    const lineOf = (i) => text.slice(0, i).split("\n").length;
    if (rel === "ui.ts") {
      addLiterals(text, rel, lineOf);
      continue;
    }
    for (const m of text.matchAll(/className=\{([\s\S]*?)\}|className="([^"]*)"/g)) {
      const body = m[1] ?? `"${m[2]}"`;
      addLiterals(body, rel, () => lineOf(m.index));
    }
  }
  return tokens;
}

const provided = providedClasses();
const missing = [...candidateTokens()].filter(([tok]) => !provided.has(tok));
if (missing.length) {
  console.error("Classes missing from host CSS (would silently no-op):");
  for (const [tok, loc] of missing) console.error(`  ${tok}  (${loc})`);
  process.exit(1);
}
console.log("check-host-classes: all utility classes exist in host CSS");
