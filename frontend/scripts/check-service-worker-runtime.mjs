#!/usr/bin/env node
/** Evaluate the shipped worker and its local imports before building a release. */
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const publicDirectory = resolve(
    process.argv[2] ?? fileURLToPath(new URL("../public", import.meta.url)),
);
const events = new Set();
const origin = "https://soundspan.test";
const self = {
    location: { origin },
    addEventListener: (type) => events.add(type),
};
const context = vm.createContext({
    self,
    URL,
    Request,
    Response,
    Headers,
    Blob,
    ReadableStream,
    setTimeout,
    clearTimeout,
});
context.importScripts = (...paths) => {
    for (const path of paths) {
        const url = new URL(path, `${origin}/sw.js`);
        const local = resolve(publicDirectory, `.${url.pathname}`);
        if (
            url.origin !== origin ||
            !local.startsWith(`${publicDirectory}${sep}`)
        ) {
            throw new Error("Worker imports must be local public assets");
        }
        vm.runInContext(readFileSync(local, "utf8"), context, {
            filename: local,
            timeout: 1000,
        });
    }
};

try {
    const worker = resolve(publicDirectory, "sw.js");
    vm.runInContext(readFileSync(worker, "utf8"), context, {
        filename: worker,
        timeout: 1000,
    });
    for (const type of ["install", "activate", "fetch"]) {
        if (!events.has(type))
            throw new Error(`Worker missing ${type} handler`);
    }
    console.log(
        "Service worker runtime verified (local imports and handler registration)",
    );
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
