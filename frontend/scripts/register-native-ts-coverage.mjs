import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));

function isInsideFrontend(candidate) {
    const relativePath = relative(frontendRoot, candidate);
    return (
        relativePath.length > 0 &&
        !relativePath.startsWith("..") &&
        !isAbsolute(relativePath)
    );
}

function unsupportedTsx(specifier) {
    const error = new Error(
        `Native targeted coverage only supports erasable .ts modules; .tsx is unsupported (${specifier})`,
    );
    error.code = "ERR_UNSUPPORTED_NATIVE_COVERAGE_MODULE";
    throw error;
}

function candidateBase(specifier, parentURL) {
    if (specifier.startsWith("@/")) {
        return join(frontendRoot, specifier.slice(2));
    }
    if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        parentURL?.startsWith("file:")
    ) {
        return fileURLToPath(new URL(specifier, parentURL));
    }
    return null;
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.endsWith(".tsx")) unsupportedTsx(specifier);

        const base = candidateBase(specifier, context.parentURL);
        if (!base || extname(base) || !isInsideFrontend(base)) {
            return nextResolve(specifier, context);
        }

        const tsCandidates = [`${base}.ts`, join(base, "index.ts")];
        const resolvedTs = tsCandidates.find((candidate) =>
            existsSync(candidate),
        );
        if (resolvedTs) {
            return { shortCircuit: true, url: pathToFileURL(resolvedTs).href };
        }

        const tsxCandidates = [`${base}.tsx`, join(base, "index.tsx")];
        if (tsxCandidates.some((candidate) => existsSync(candidate))) {
            unsupportedTsx(specifier);
        }

        return nextResolve(specifier, context);
    },
});
