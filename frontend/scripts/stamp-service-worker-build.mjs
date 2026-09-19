import { readFile, writeFile } from "node:fs/promises";

// A frontend-only release must also trigger the worker's atomic shell precache.
// Keep the cache namespace and activation policy: downloaded audio is untouched,
// and an update must not force-reload a page that is currently playing music.
const buildId = (await readFile(".next/BUILD_ID", "utf8")).trim();
if (!buildId || /[\r\n\u2028\u2029]/.test(buildId)) {
    throw new Error("Invalid frontend BUILD_ID");
}
const path = "public/sw.js";
const source = (await readFile(path, "utf8"))
    .replace(/\n\/\/ Soundspan app build: [^\r\n]*\s*$/, "")
    .trimEnd();
await writeFile(
    path,
    `${source}\n// Soundspan app build: ${JSON.stringify(buildId)}\n`,
);
