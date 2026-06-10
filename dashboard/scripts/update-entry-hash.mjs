import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const manifestPath = new URL("../manifest.json", import.meta.url);

async function stamped(rel) {
  const bytes = await readFile(new URL(`../${rel}`, import.meta.url));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return `${rel}?v=${hash}`;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const next = {
  entry: await stamped("dist/index.js"),
  css: await stamped("dist/style.css"),
};

if (manifest.entry !== next.entry || manifest.css !== next.css) {
  manifest.entry = next.entry;
  manifest.css = next.css;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`dashboard manifest -> ${next.entry} | ${next.css}`);
}
