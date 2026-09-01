#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const images = Object.freeze({
    backend: {
        id: "backend",
        job_name: "Build & Push Backend Image",
        image_name: "backend",
        context: "./backend",
        file: "./backend/Dockerfile",
        target: "api-runtime",
        build_contexts:
            "media-metadata-contract=./packages/media-metadata-contract",
        include_frontend_build_args: false,
        cache_scope: "backend",
        smoke_import: "",
        smoke_user: "",
    },
    "backend-worker": {
        id: "backend-worker",
        job_name: "Build & Push Backend Worker Image",
        image_name: "backend-worker",
        context: "./backend",
        file: "./backend/Dockerfile",
        target: "worker-runtime",
        build_contexts:
            "media-metadata-contract=./packages/media-metadata-contract",
        include_frontend_build_args: false,
        cache_scope: "backend-worker",
        smoke_import: "",
        smoke_user: "",
    },
    frontend: {
        id: "frontend",
        job_name: "Build & Push Frontend Image",
        image_name: "frontend",
        context: "./frontend",
        file: "./frontend/Dockerfile",
        target: "",
        build_contexts:
            "media-metadata-contract=./packages/media-metadata-contract",
        include_frontend_build_args: true,
        cache_scope: "frontend",
        smoke_import: "",
        smoke_user: "",
    },
    "audio-analyzer": {
        id: "audio-analyzer",
        job_name: "Build & Push Audio Analyzer Image",
        image_name: "audio-analyzer",
        context: ".",
        file: "./services/audio-analyzer/Dockerfile",
        target: "",
        build_contexts: "",
        include_frontend_build_args: false,
        cache_scope: "audio-analyzer",
        smoke_import: "import analyzer",
        smoke_user: "",
    },
    "vibe-provider-dclap": {
        id: "vibe-provider-dclap",
        job_name: "Build & Push DCLAP Provider Image",
        image_name: "vibe-provider-dclap",
        context: ".",
        file: "./services/vibe-provider-dclap/Dockerfile",
        target: "",
        build_contexts: "",
        include_frontend_build_args: false,
        cache_scope: "vibe-provider-dclap",
        smoke_import:
            "import importlib.util as u; s = u.spec_from_file_location('smoke_entry', '/app/__main__.py'); m = u.module_from_spec(s); s.loader.exec_module(m)",
        smoke_user: "",
    },
    "tidal-streamer": {
        id: "tidal-streamer",
        job_name: "Build & Push TIDAL Streamer Image",
        image_name: "tidal-streamer",
        alias_image_name: "tidal-downloader",
        context: ".",
        file: "./services/tidal-streamer/Dockerfile",
        target: "",
        build_contexts: "",
        include_frontend_build_args: false,
        cache_scope: "tidal-streamer",
        smoke_import: "import app",
        smoke_user: "",
    },
    "ytmusic-streamer": {
        id: "ytmusic-streamer",
        job_name: "Build & Push YTMusic Streamer Image",
        image_name: "ytmusic-streamer",
        context: ".",
        file: "./services/ytmusic-streamer/Dockerfile",
        target: "",
        build_contexts: "",
        include_frontend_build_args: false,
        cache_scope: "ytmusic-streamer",
        smoke_import: "import app",
        smoke_user: "ytmusic",
    },
});

const groups = Object.freeze({
    all: Object.keys(images),
    core: ["backend", "backend-worker", "frontend"],
    backend: ["backend", "backend-worker"],
    frontend: ["frontend"],
    analysis: ["audio-analyzer", "vibe-provider-dclap"],
    streaming: ["tidal-streamer", "ytmusic-streamer"],
});

const globalBuildInputs = new Set([
    ".github/workflows/image-builds.yml",
    "docker-bake.json",
    "scripts/ci/select-image-builds.mjs",
]);

function imageIdsForPath(path) {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (globalBuildInputs.has(normalized)) return groups.all;
    if (normalized.startsWith("packages/media-metadata-contract/")) {
        return groups.core;
    }
    if (normalized.startsWith("backend/")) return groups.backend;
    if (normalized.startsWith("frontend/")) return groups.frontend;
    if (normalized.startsWith("services/common/")) {
        return [...groups.analysis, ...groups.streaming];
    }
    for (const id of [...groups.analysis, ...groups.streaming]) {
        if (normalized.startsWith(`services/${id}/`)) return [id];
    }
    return [];
}

export function selectImageBuilds({ scope = "changed", changedPaths = [] }) {
    const selected = new Set();
    if (scope !== "changed") {
        const scopedIds = groups[scope];
        if (!scopedIds)
            throw new Error(`Unsupported image build scope: ${scope}`);
        scopedIds.forEach((id) => selected.add(id));
    } else if (changedPaths.length === 0) {
        groups.all.forEach((id) => selected.add(id));
    } else {
        changedPaths
            .flatMap((path) => imageIdsForPath(path))
            .forEach((id) => selected.add(id));
    }

    return {
        include: Object.keys(images)
            .filter((id) => selected.has(id))
            .map((id) => images[id]),
    };
}

function cliArgument(name) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    const scope = cliArgument("scope") ?? "changed";
    const pathsFile = cliArgument("paths-file");
    const changedPaths = (pathsFile ? fs.readFileSync(pathsFile, "utf8") : "")
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean);
    process.stdout.write(
        JSON.stringify(selectImageBuilds({ scope, changedPaths })),
    );
}
