import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const manifestPath = new URL("../manifest.json", import.meta.url);
const bundlePath = new URL("../dist/index.js", import.meta.url);

const bundle = await readFile(bundlePath);
const hash = createHash("sha256").update(bundle).digest("hex").slice(0, 12);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const entry = `dist/index.js?v=${hash}`;

if (manifest.entry !== entry) {
  manifest.entry = entry;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`dashboard manifest entry -> ${entry}`);
}
